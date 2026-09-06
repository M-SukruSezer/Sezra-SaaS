-- =============================================================================
-- 0600 — Kalite Kontrol: şema  (Faz 2)
-- =============================================================================
-- TASARIM KARARLARI
--
-- 1. SONUÇ, KENDİ ÖLÇÜTÜNÜ YANINDA TAŞIR.
--    quality.results satırı, ölçümü yaparken geçerli olan limitleri (min/max,
--    beklenen değer, kritik mi) KOPYALAYARAK saklar. Plan sonradan
--    değiştiğinde geçmiş muayeneler yeniden yorumlanmaz: "bu parti neden
--    geçti?" sorusu, o günün ölçütüyle yanıtlanır. Plana FK ile bakmak,
--    limitler güncellendiğinde geçmişi sessizce yeniden yazardı.
--
-- 2. GEÇTİ/KALDI ELLE SEÇİLMEZ, TÜRETİLİR.
--    Muayenenin sonucu ölçüm satırlarından hesaplanır (0601): ölçütlerden biri
--    bile kaldıysa muayene kalır. `is_critical` sonucu değil, doğan
--    UYGUNSUZLUĞUN AĞIRLIĞINI belirler. Denetçinin "yine de kabul edelim"
--    demesi ayrı bir karardır — muayene sonucunu değiştirerek değil, gerekçeli
--    bir tasarrufla (quality.nonconformities.disposition) kayda geçer.
--
-- 3. MUAYENE TASLAK DOĞAR.
--    Mal kabul olayı muayeneyi AÇAR ama otomatik geçirmez. Ölçümü bir insan
--    girer. Aksi hâlde kalite kontrol, kâğıt üzerinde var olan ama hiç
--    yapılmayan bir adıma dönüşür.
-- =============================================================================

create schema if not exists quality;

select core.register_module('quality', 'Kalite Kontrol', 2::smallint, '{core}', false,
       'Muayene planları, giriş kalite kontrolü, uygunsuzluk ve tasarruf kayıtları');

insert into core.plan_modules (plan_code, module_code) values
  ('kurumsal', 'quality')
on conflict do nothing;

do $$ begin
  create type quality.check_kind as enum ('numeric', 'boolean', 'choice', 'text');
exception when duplicate_object then null; end $$;

do $$ begin
  create type quality.inspection_status as enum ('draft', 'passed', 'failed', 'cancelled');
exception when duplicate_object then null; end $$;

do $$ begin
  create type quality.disposition as enum
    ('pending', 'accept', 'accept_with_deviation', 'rework', 'reject', 'return_to_supplier');
exception when duplicate_object then null; end $$;

-- -----------------------------------------------------------------------------
-- Muayene planları
-- -----------------------------------------------------------------------------
create table if not exists quality.plans (
  id           uuid primary key default gen_random_uuid(),
  tenant_id    uuid not null references core.tenants(id) on delete cascade,
  code         text not null,
  name         text not null,
  -- Plan ya belirli bir ürüne ya da bir ürün kategorisine bağlanır; ikisi de
  -- boşsa "genel plan"dır ve eşleşme bulunamayan ürünlerde kullanılır.
  product_id   uuid references core.products(id) on delete cascade,
  category_id  uuid references core.product_categories(id) on delete cascade,
  -- Hangi aşamada uygulanır: mal kabul girişi, üretim, sevkiyat öncesi
  stage        text not null default 'incoming'
                 check (stage in ('incoming', 'in_process', 'outgoing')),
  -- Her partide mi, örneklemeyle mi? Örnekleme yüzdesi kayıt amaçlı.
  sample_pct   numeric(6,2) not null default 100 check (sample_pct > 0 and sample_pct <= 100),
  is_active    boolean not null default true,
  created_by   uuid references core.users(id),
  updated_by   uuid references core.users(id),
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);
create unique index if not exists ux_quality_plans_code on quality.plans (tenant_id, code);
create index if not exists ix_quality_plans_product
  on quality.plans (tenant_id, product_id, stage) where is_active;
create index if not exists ix_quality_plans_category
  on quality.plans (tenant_id, category_id, stage) where is_active;

create table if not exists quality.check_points (
  id             uuid primary key default gen_random_uuid(),
  tenant_id      uuid not null references core.tenants(id) on delete cascade,
  plan_id        uuid not null references quality.plans(id) on delete cascade,
  sequence       smallint not null default 10,
  code           text not null,
  name           text not null,
  kind           quality.check_kind not null default 'numeric',
  unit           text,                                  -- '%', 'ppm', 'kg'
  min_value      numeric(18,4),
  max_value      numeric(18,4),
  expected_bool  boolean,
  choices        text[],
  expected_choice text,
  -- Kritik ölçüt kalırsa muayenenin tamamı kalır (0601).
  is_critical    boolean not null default false,
  instructions   text,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now(),
  constraint ck_check_points_numeric_range
    check (kind <> 'numeric' or min_value is not null or max_value is not null)
);
create unique index if not exists ux_check_points_code
  on quality.check_points (plan_id, code);
create index if not exists ix_check_points_plan
  on quality.check_points (tenant_id, plan_id, sequence);

-- -----------------------------------------------------------------------------
-- Muayeneler
-- -----------------------------------------------------------------------------
create table if not exists quality.inspections (
  id                uuid primary key default gen_random_uuid(),
  tenant_id         uuid not null references core.tenants(id) on delete cascade,
  branch_id         uuid references core.branches(id) on delete set null,
  number            text,
  plan_id           uuid references quality.plans(id) on delete set null,
  product_id        uuid not null references core.products(id),
  lot_id            uuid,                                -- inventory.lots; FK YOK (bkz. not)
  partner_id        uuid references core.partners(id),   -- tedarikçi
  quantity          numeric(18,4) not null default 0,
  sampled_quantity  numeric(18,4) not null default 0,
  stage             text not null default 'incoming',
  status            quality.inspection_status not null default 'draft',
  -- Muayeneyi doğuran belge (mal kabul, üretim emri...)
  source_module     text,
  source_table      text,
  source_id         uuid,
  inspector_id      uuid references core.users(id),
  inspected_at      timestamptz,
  notes             text,
  owner_id          uuid references core.users(id),
  created_by        uuid references core.users(id),
  updated_by        uuid references core.users(id),
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now()
);

-- NOT: lot_id'ye FK YOK. Kalite modülü Envanter'siz de çalışabilmelidir
-- (kiracı Kalite alıp Envanter almayabilir). Modüller arası bağ, çekirdeğe
-- ait olmayan tablolarda FK ile değil id taşıyarak kurulur — aynı gerekçeyle
-- Muhasebe de CRM'e FK vermiyor.

create unique index if not exists ux_inspections_number
  on quality.inspections (tenant_id, number) where number is not null;
create index if not exists ix_inspections_source
  on quality.inspections (tenant_id, source_module, source_table, source_id);
create index if not exists ix_inspections_status
  on quality.inspections (tenant_id, status) where status = 'draft';
create index if not exists ix_inspections_partner
  on quality.inspections (tenant_id, partner_id, inspected_at desc);

create table if not exists quality.results (
  id              uuid primary key default gen_random_uuid(),
  tenant_id       uuid not null references core.tenants(id) on delete cascade,
  inspection_id   uuid not null references quality.inspections(id) on delete cascade,
  check_point_id  uuid references quality.check_points(id) on delete set null,
  sequence        smallint not null default 10,
  -- ÖLÇÜT ANLIK GÖRÜNTÜSÜ (karar 1): plan değişse de bu satır kendi kendini anlatır
  code            text not null,
  name            text not null,
  kind            quality.check_kind not null,
  unit            text,
  min_value       numeric(18,4),
  max_value       numeric(18,4),
  expected_bool   boolean,
  expected_choice text,
  is_critical     boolean not null default false,
  -- ÖLÇÜM
  numeric_value   numeric(18,4),
  bool_value      boolean,
  text_value      text,
  passed          boolean,
  note            text,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);
create index if not exists ix_quality_results_inspection
  on quality.results (tenant_id, inspection_id, sequence);

-- -----------------------------------------------------------------------------
-- Uygunsuzluk kayıtları
-- -----------------------------------------------------------------------------
-- Muayene kaldığında ne yapıldığı burada kayıtlıdır. "Yine de kabul edildi"
-- meşru bir karardır ama İZ BIRAKMALIDIR — muayene sonucunu değiştirerek değil,
-- gerekçeli bir tasarrufla.
create table if not exists quality.nonconformities (
  id               uuid primary key default gen_random_uuid(),
  tenant_id        uuid not null references core.tenants(id) on delete cascade,
  branch_id        uuid references core.branches(id) on delete set null,
  number           text,
  inspection_id    uuid references quality.inspections(id) on delete set null,
  product_id       uuid not null references core.products(id),
  partner_id       uuid references core.partners(id),
  quantity         numeric(18,4) not null default 0,
  severity         text not null default 'minor'
                     check (severity in ('minor', 'major', 'critical')),
  description      text not null,
  disposition      quality.disposition not null default 'pending',
  disposition_note text,
  decided_by       uuid references core.users(id),
  decided_at       timestamptz,
  corrective_action text,
  closed_at        timestamptz,
  owner_id         uuid references core.users(id),
  created_by       uuid references core.users(id),
  updated_by       uuid references core.users(id),
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now()
);
create unique index if not exists ux_nonconformities_number
  on quality.nonconformities (tenant_id, number) where number is not null;
create index if not exists ix_nonconformities_partner
  on quality.nonconformities (tenant_id, partner_id, created_at desc);
create index if not exists ix_nonconformities_open
  on quality.nonconformities (tenant_id, disposition) where closed_at is null;
