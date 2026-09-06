-- =============================================================================
-- 0700 — Bakım & Ekipman: şema  (Faz 2)
-- =============================================================================
-- TASARIM KARARLARI
--
-- 1. EKİPMAN ŞUBEYE AİTTİR.
--    Düzce'deki üretim hattı ile Zonguldak'taki ayrı varlıklardır; şube
--    müdürü yalnızca kendi şubesinin makinelerini görür. Ekipmanı kiracı geneli
--    yapmak, "hangi makine bozuldu" sorusunu her seferinde şube seçmeye çevirirdi.
--
-- 2. PERİYODİK BAKIM PLANI, İŞ EMRİ ÜRETİR — KENDİSİ İŞ EMRİ DEĞİLDİR.
--    Plan "her 90 günde bir periyodik bakım" der; iş emri ise "12 Mart'ta
--    Düzce'deki makineye yapılan bakım"dır. Aynı plandan yüzlerce iş emri doğar ve
--    her biri kendi maliyetini, süresini ve kullanılan parçasını taşır.
--
-- 3. AÇIK İŞ EMRİ VARKEN AYNI PLAN İKİNCİSİNİ ÜRETMEZ.
--    Aksi hâlde cron her çalıştığında aynı bakım için yeni kayıt açar ve
--    listede yüzlerce kopya birikir (0701'deki kısmi benzersizlik indeksi).
--
-- 4. PARÇA TÜKETİMİ ENVANTERE OLAYLA GİDER.
--    Bakım, Envanter'siz de çalışabilmelidir (kiracı Bakım alıp Envanter
--    almayabilir). Bu yüzden parça satırı core.products'a bağlanır ama stok
--    düşümü doğrudan çağrıyla değil, olayla yapılır.
-- =============================================================================

create schema if not exists maintenance;

select core.register_module('maintenance', 'Bakım & Ekipman', 2::smallint, '{core}', false,
       'Ekipman kartları, periyodik bakım planları, iş emirleri, duruş takibi');

insert into core.plan_modules (plan_code, module_code) values
  ('kurumsal', 'maintenance')
on conflict do nothing;

do $$ begin
  create type maintenance.equipment_status as enum
    ('operational', 'maintenance', 'down', 'retired');
exception when duplicate_object then null; end $$;

do $$ begin
  create type maintenance.work_order_kind as enum ('preventive', 'corrective', 'inspection');
exception when duplicate_object then null; end $$;

do $$ begin
  create type maintenance.work_order_status as enum
    ('draft', 'scheduled', 'in_progress', 'done', 'cancelled');
exception when duplicate_object then null; end $$;

-- -----------------------------------------------------------------------------
-- Ekipman kartları
-- -----------------------------------------------------------------------------
create table if not exists maintenance.equipment (
  id              uuid primary key default gen_random_uuid(),
  tenant_id       uuid not null references core.tenants(id) on delete cascade,
  branch_id       uuid references core.branches(id) on delete set null,
  code            text not null,
  name            text not null,
  category        text,                                -- 'üretim hattı', 'yardımcı ekipman'
  manufacturer    text,
  model           text,
  serial_no       text,
  -- Tedarikçi/servis firması: arıza anında kime telefon açılacağı burada
  partner_id      uuid references core.partners(id),
  purchase_date   date,
  warranty_until  date,
  purchase_cost   numeric(18,2),
  location_note   text,                                -- 'bar arkası, sol'
  status          maintenance.equipment_status not null default 'operational',
  -- Kritik ekipman durunca dükkân durur; raporlar bunu ayırır.
  is_critical     boolean not null default false,
  -- Kullanım sayacı (çekim sayısı, çalışma saati) — plan buna göre de tetiklenir
  usage_counter   numeric(18,2) not null default 0,
  usage_unit      text,                                -- 'çekim', 'saat'
  notes           text,
  owner_id        uuid references core.users(id),
  created_by      uuid references core.users(id),
  updated_by      uuid references core.users(id),
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);
create unique index if not exists ux_equipment_code on maintenance.equipment (tenant_id, code);
create index if not exists ix_equipment_branch
  on maintenance.equipment (tenant_id, branch_id) where status <> 'retired';
create index if not exists ix_equipment_down
  on maintenance.equipment (tenant_id, status) where status = 'down';

-- -----------------------------------------------------------------------------
-- Periyodik bakım planları
-- -----------------------------------------------------------------------------
create table if not exists maintenance.plans (
  id             uuid primary key default gen_random_uuid(),
  tenant_id      uuid not null references core.tenants(id) on delete cascade,
  code           text not null,
  name           text not null,
  -- Plan tek bir ekipmana ya da bir kategoriye bağlanır
  equipment_id   uuid references maintenance.equipment(id) on delete cascade,
  category       text,
  -- Takvim ya da kullanım sayacı bazlı tetikleme. İkisi de doluysa hangisi
  -- önce gelirse o tetikler (sayaçlı bir makinede ikisi de anlamlıdır).
  interval_days  integer check (interval_days is null or interval_days > 0),
  interval_usage numeric(18,2) check (interval_usage is null or interval_usage > 0),
  -- İş emri, vadeden kaç gün önce açılsın
  lead_days      smallint not null default 3,
  estimated_minutes integer,
  instructions   text,
  is_active      boolean not null default true,
  created_by     uuid references core.users(id),
  updated_by     uuid references core.users(id),
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now(),
  constraint ck_plans_has_trigger
    check (interval_days is not null or interval_usage is not null),
  constraint ck_plans_has_target
    check (equipment_id is not null or category is not null)
);
create unique index if not exists ux_maint_plans_code on maintenance.plans (tenant_id, code);

create table if not exists maintenance.plan_tasks (
  id          uuid primary key default gen_random_uuid(),
  tenant_id   uuid not null references core.tenants(id) on delete cascade,
  plan_id     uuid not null references maintenance.plans(id) on delete cascade,
  sequence    smallint not null default 10,
  name        text not null,
  instructions text,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);
create index if not exists ix_plan_tasks_plan on maintenance.plan_tasks (tenant_id, plan_id, sequence);

-- -----------------------------------------------------------------------------
-- İş emirleri
-- -----------------------------------------------------------------------------
create table if not exists maintenance.work_orders (
  id              uuid primary key default gen_random_uuid(),
  tenant_id       uuid not null references core.tenants(id) on delete cascade,
  branch_id       uuid references core.branches(id) on delete set null,
  number          text,
  equipment_id    uuid not null references maintenance.equipment(id) on delete cascade,
  plan_id         uuid references maintenance.plans(id) on delete set null,
  kind            maintenance.work_order_kind not null default 'corrective',
  status          maintenance.work_order_status not null default 'draft',
  priority        smallint not null default 3 check (priority between 1 and 5),
  title           text not null,
  description     text,
  reported_at     timestamptz not null default now(),
  scheduled_date  date,
  started_at      timestamptz,
  completed_at    timestamptz,
  assignee_id     uuid references core.users(id),
  -- Dış servis çağrıldıysa
  partner_id      uuid references core.partners(id),
  -- Ekipmanın durduğu süre: kritik makinede bu doğrudan ciro kaybıdır
  downtime_minutes integer not null default 0,
  labor_minutes   integer not null default 0,
  labor_cost      numeric(18,2) not null default 0,
  parts_cost      numeric(18,2) not null default 0,
  service_cost    numeric(18,2) not null default 0,
  total_cost      numeric(18,2) not null default 0,
  resolution      text,
  -- Bakım YAPILDIĞI ANDAKİ sayaç değeri. Bir sonraki vadeyi hesaplamak için
  -- şart: "son bakımdan bu yana kaç çekim yapıldı" sorusu, ancak o anın sayacı
  -- kaydedilmişse yanıtlanabilir.
  usage_at_service numeric(18,2),
  owner_id        uuid references core.users(id),
  created_by      uuid references core.users(id),
  updated_by      uuid references core.users(id),
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  constraint ck_wo_times check (completed_at is null or started_at is null or completed_at >= started_at)
);
create unique index if not exists ux_work_orders_number
  on maintenance.work_orders (tenant_id, number) where number is not null;
create index if not exists ix_work_orders_equipment
  on maintenance.work_orders (tenant_id, equipment_id, reported_at desc);
create index if not exists ix_work_orders_open
  on maintenance.work_orders (tenant_id, status)
  where status in ('draft', 'scheduled', 'in_progress');

-- KARAR 3: Aynı plandan aynı ekipmana AÇIK ikinci iş emri olamaz.
-- Cron'un her çalıştığında kopya üretmesini veritabanı engeller.
create unique index if not exists ux_work_orders_open_plan
  on maintenance.work_orders (equipment_id, plan_id)
  where plan_id is not null and status in ('draft', 'scheduled', 'in_progress');

create table if not exists maintenance.work_order_tasks (
  id             uuid primary key default gen_random_uuid(),
  tenant_id      uuid not null references core.tenants(id) on delete cascade,
  work_order_id  uuid not null references maintenance.work_orders(id) on delete cascade,
  sequence       smallint not null default 10,
  name           text not null,
  instructions   text,
  is_done        boolean not null default false,
  done_at        timestamptz,
  note           text,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now()
);
create index if not exists ix_wo_tasks on maintenance.work_order_tasks (tenant_id, work_order_id, sequence);

-- Kullanılan yedek parçalar. core.products'a bağlanır (Bölüm 7 kuralı: parça da
-- üründür, ayrı bir "parça" kataloğu icat edilmez).
create table if not exists maintenance.work_order_parts (
  id             uuid primary key default gen_random_uuid(),
  tenant_id      uuid not null references core.tenants(id) on delete cascade,
  work_order_id  uuid not null references maintenance.work_orders(id) on delete cascade,
  product_id     uuid not null references core.products(id),
  quantity       numeric(18,4) not null check (quantity > 0),
  unit_cost      numeric(18,4) not null default 0,
  total_cost     numeric(18,2) not null default 0,
  -- Stoktan düşüldü mü? Envanter modülü kapalıysa false kalır.
  stock_issued   boolean not null default false,
  note           text,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now()
);
create index if not exists ix_wo_parts on maintenance.work_order_parts (tenant_id, work_order_id);
