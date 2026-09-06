-- =============================================================================
-- 0900 — Proje & Zaman Çizelgesi: şema  (Faz 4)
-- =============================================================================
-- TASARIM KARARLARI
--
-- 1. ZAMAN KAYDI TEK, KULLANIMI İKİ.
--    Aynı satır hem FATURAYA (müşteriye kaç saat yansıtılacak) hem MALİYETE
--    (bu saatin işletmeye maliyeti ne) kaynaklık eder. İki ayrı tablo tutmak,
--    "faturalanan saat 40 ama maliyette 38 görünüyor" sınıfı bir tutarsızlığı
--    kaçınılmaz kılardı.
--
-- 2. SAATİN MALİYETİ İŞLENDİĞİ ANDA DONDURULUR.
--    Çalışanın maaşı zam görünce geçmiş projelerin kârlılığı değişmemelidir.
--    Bu yüzden zaman kaydı, o günkü saatlik maliyeti KOPYALAYARAK saklar
--    (bordroda, kalitede ve stok maliyetinde uyguladığımız aynı ilke).
--
-- 3. FATURALANMIŞ ZAMAN KAYDI DEĞİŞTİRİLEMEZ.
--    Müşteriye gönderilmiş faturanın dayanağı sonradan düzenlenemez; düzeltme
--    ters kayıtla ya da yeni faturayla yapılır.
--
-- 4. GÖREV AĞACI, SAAT TOPLAMI YUKARI AKAR.
--    Alt görevlere girilen saat üst görevde ve projede görünür; kullanıcı aynı
--    saati iki kez girmek zorunda kalmaz.
-- =============================================================================

create schema if not exists projects;

select core.register_module('projects', 'Proje & Zaman Çizelgesi', 4::smallint, '{core}', false,
       'Proje/görev yönetimi, zaman çizelgesi, hakediş faturalaması, kârlılık');

insert into core.plan_modules (plan_code, module_code) values
  ('buyume', 'projects'), ('kurumsal', 'projects')
on conflict do nothing;

do $$ begin
  create type projects.project_status as enum
    ('draft', 'active', 'on_hold', 'completed', 'cancelled');
exception when duplicate_object then null; end $$;

do $$ begin
  create type projects.billing_type as enum ('fixed_price', 'time_material', 'internal');
exception when duplicate_object then null; end $$;

do $$ begin
  create type projects.task_status as enum ('todo', 'in_progress', 'blocked', 'done', 'cancelled');
exception when duplicate_object then null; end $$;

-- -----------------------------------------------------------------------------
-- Projeler
-- -----------------------------------------------------------------------------
create table if not exists projects.projects (
  id              uuid primary key default gen_random_uuid(),
  tenant_id       uuid not null references core.tenants(id) on delete cascade,
  branch_id       uuid references core.branches(id) on delete set null,
  code            text not null,
  name            text not null,
  description     text,
  partner_id      uuid references core.partners(id),      -- müşteri
  manager_id      uuid references core.users(id),
  status          projects.project_status not null default 'draft',
  billing_type    projects.billing_type not null default 'time_material',
  -- Sabit fiyatta sözleşme bedeli; zaman&malzemede saat ücreti kullanılır
  contract_amount numeric(18,2),
  hourly_rate     numeric(18,4),
  currency        char(3) not null default 'TRY',
  start_date      date,
  due_date        date,
  completed_at    timestamptz,
  -- Planlanan bütçe saati: sapma raporunun referansı
  planned_hours   numeric(18,2),
  -- CRM'den geldiyse hangi fırsattan (FK YOK: CRM kapalı olabilir)
  source_module   text,
  source_id       uuid,
  owner_id        uuid references core.users(id),
  created_by      uuid references core.users(id),
  updated_by      uuid references core.users(id),
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  constraint ck_projects_dates check (due_date is null or start_date is null or due_date >= start_date)
);
create unique index if not exists ux_projects_code on projects.projects (tenant_id, code);
create index if not exists ix_projects_partner on projects.projects (tenant_id, partner_id);
create index if not exists ix_projects_active
  on projects.projects (tenant_id, status) where status in ('active', 'on_hold');

-- -----------------------------------------------------------------------------
-- Görevler
-- -----------------------------------------------------------------------------
create table if not exists projects.tasks (
  id             uuid primary key default gen_random_uuid(),
  tenant_id      uuid not null references core.tenants(id) on delete cascade,
  branch_id      uuid references core.branches(id) on delete set null,
  project_id     uuid not null references projects.projects(id) on delete cascade,
  parent_id      uuid references projects.tasks(id) on delete cascade,
  code           text,
  name           text not null,
  description    text,
  status         projects.task_status not null default 'todo',
  priority       smallint not null default 3 check (priority between 1 and 5),
  assignee_id    uuid references core.users(id),
  planned_hours  numeric(18,2),
  start_date     date,
  due_date       date,
  done_at        timestamptz,
  sequence       integer not null default 100,
  owner_id       uuid references core.users(id),
  created_by     uuid references core.users(id),
  updated_by     uuid references core.users(id),
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now()
);
create index if not exists ix_tasks_project on projects.tasks (tenant_id, project_id, sequence);
create index if not exists ix_tasks_assignee
  on projects.tasks (tenant_id, assignee_id) where status <> 'done';
create index if not exists ix_tasks_parent on projects.tasks (tenant_id, parent_id);

-- -----------------------------------------------------------------------------
-- Zaman çizelgesi
-- -----------------------------------------------------------------------------
create table if not exists projects.timesheets (
  id             uuid primary key default gen_random_uuid(),
  tenant_id      uuid not null references core.tenants(id) on delete cascade,
  branch_id      uuid references core.branches(id) on delete set null,
  project_id     uuid not null references projects.projects(id) on delete cascade,
  task_id        uuid references projects.tasks(id) on delete set null,
  user_id        uuid not null references core.users(id),
  -- İK modülü açıksa çalışan kartına da bağlanır (FK YOK: İK kapalı olabilir)
  employee_id    uuid,
  work_date      date not null default current_date,
  hours          numeric(8,2) not null check (hours > 0 and hours <= 24),
  description    text,
  -- Müşteriye yansıtılacak mı? Proje tipinden gelir, elle değiştirilebilir.
  is_billable    boolean not null default true,
  -- KARAR 2: o günkü değerler dondurulur
  hourly_rate    numeric(18,4) not null default 0,      -- müşteriye yansıtılan
  hourly_cost    numeric(18,4) not null default 0,      -- işletmeye maliyeti
  billable_amount numeric(18,2) not null default 0,
  cost_amount    numeric(18,2) not null default 0,
  -- Faturalandı mı? Fatura id'si finance'a FK ile bağlanmaz (modül bağımsızlığı)
  invoiced_at    timestamptz,
  invoice_id     uuid,
  owner_id       uuid references core.users(id),
  created_by     uuid references core.users(id),
  updated_by     uuid references core.users(id),
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now()
);
create index if not exists ix_timesheets_project
  on projects.timesheets (tenant_id, project_id, work_date);
create index if not exists ix_timesheets_user
  on projects.timesheets (tenant_id, user_id, work_date desc);
-- Faturalanmamış hakediş sorgusu en sık çalışan sorgudur
create index if not exists ix_timesheets_unbilled
  on projects.timesheets (tenant_id, project_id)
  where invoiced_at is null and is_billable;
