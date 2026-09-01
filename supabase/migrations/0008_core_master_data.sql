-- =============================================================================
-- 0008 — Ortak ana veriler: cari hesaplar, ürünler, birimler, vergiler
-- =============================================================================
-- Bölüm 7 kuralı: hiçbir modül kendi "müşteri" veya "ürün" tablosunu yeniden
-- icat etmez; hepsi buraya partner_id / product_id ile bağlanır.
--
-- KARAR: Vergi tanımları (KDV/tevkifat) core'da tutuluyor, finance'ta değil.
-- Gerekçe: satış teklifi, satın alma siparişi ve fatura üçü de vergi oranına
-- ihtiyaç duyar; finance'a koymak CRM'i Muhasebe modülüne bağımlı kılardı ve
-- "sadece CRM alan kiracı" senaryosunu bozardı. Vergi HESAPLAMA motoru yine de
-- finance modülünde kalır — burada sadece tanımlar var.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- Ölçü birimleri
-- -----------------------------------------------------------------------------
create table if not exists core.uoms (
  id          uuid primary key default gen_random_uuid(),
  tenant_id   uuid not null references core.tenants(id) on delete cascade,
  code        text not null,                     -- 'ADET', 'KG', 'LT', 'PAKET'
  name        text not null,
  category    text not null default 'unit',      -- unit | weight | volume | time
  ratio       numeric(18,6) not null default 1,  -- kategori referans birimine oran
  is_active   boolean not null default true,
  created_by  uuid references core.users(id),
  updated_by  uuid references core.users(id),
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);
create unique index if not exists ux_uoms_tenant_code on core.uoms (tenant_id, code);

-- -----------------------------------------------------------------------------
-- Vergiler (KDV, tevkifat) — Bölüm 6
-- -----------------------------------------------------------------------------
create table if not exists core.taxes (
  id                uuid primary key default gen_random_uuid(),
  tenant_id         uuid not null references core.tenants(id) on delete cascade,
  code              text not null,                     -- 'KDV20', 'KDV10', 'KDV1', 'KDV0'
  name              text not null,
  rate              numeric(6,3) not null default 0,   -- yüzde: 20.000
  kind              text not null default 'vat' check (kind in ('vat', 'withholding', 'exempt')),
  -- Kısmi tevkifat: 5/10, 9/10 gibi oranlar. numerator/denominator olarak
  -- saklanır ki 7/10 gibi değerler ondalık yuvarlama hatası üretmesin.
  withholding_num   smallint,
  withholding_den   smallint,
  exemption_code    text,                              -- GİB istisna kodu (e-Fatura için)
  is_default_sale   boolean not null default false,
  is_default_purchase boolean not null default false,
  is_active         boolean not null default true,
  created_by        uuid references core.users(id),
  updated_by        uuid references core.users(id),
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now(),
  constraint ck_taxes_withholding check (
    (kind <> 'withholding') or (withholding_num is not null and withholding_den is not null)
  )
);
create unique index if not exists ux_taxes_tenant_code on core.taxes (tenant_id, code);

-- -----------------------------------------------------------------------------
-- Ürün kategorileri
-- -----------------------------------------------------------------------------
create table if not exists core.product_categories (
  id          uuid primary key default gen_random_uuid(),
  tenant_id   uuid not null references core.tenants(id) on delete cascade,
  parent_id   uuid references core.product_categories(id) on delete set null,
  code        text,
  name        text not null,
  path        text,                              -- 'İçecek / Sıcak / Espresso Bazlı'
  created_by  uuid references core.users(id),
  updated_by  uuid references core.users(id),
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);
create index if not exists ix_product_categories_parent on core.product_categories (tenant_id, parent_id);

-- -----------------------------------------------------------------------------
-- Ürünler / hizmetler
-- -----------------------------------------------------------------------------
create table if not exists core.products (
  id                 uuid primary key default gen_random_uuid(),
  tenant_id          uuid not null references core.tenants(id) on delete cascade,
  sku                text not null,
  barcode            text,
  name               text not null,
  description        text,
  kind               text not null default 'stockable'
                       check (kind in ('stockable', 'consumable', 'service')),
  category_id        uuid references core.product_categories(id) on delete set null,
  uom_id             uuid references core.uoms(id),
  purchase_uom_id    uuid references core.uoms(id),
  sale_price         numeric(18,4) not null default 0,
  purchase_price     numeric(18,4) not null default 0,
  currency           char(3) not null default 'TRY',
  sale_tax_id        uuid references core.taxes(id),
  purchase_tax_id    uuid references core.taxes(id),
  is_sellable        boolean not null default true,
  is_purchasable     boolean not null default true,
  is_active          boolean not null default true,
  attributes         jsonb not null default '{}'::jsonb,
  created_by         uuid references core.users(id),
  updated_by         uuid references core.users(id),
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now()
);

create unique index if not exists ux_products_tenant_sku on core.products (tenant_id, sku);
create index if not exists ix_products_barcode on core.products (tenant_id, barcode) where barcode is not null;
create index if not exists ix_products_name_trgm on core.products using gin (name gin_trgm_ops);

-- -----------------------------------------------------------------------------
-- Cari hesaplar (müşteri / tedarikçi / çalışan)
-- -----------------------------------------------------------------------------
-- Odoo'daki res.partner gibi TEK tablo: aynı firma hem müşteri hem tedarikçi
-- olabildiği için type yerine bayraklar kullanıyoruz.
create table if not exists core.partners (
  id             uuid primary key default gen_random_uuid(),
  tenant_id      uuid not null references core.tenants(id) on delete cascade,
  branch_id      uuid references core.branches(id) on delete set null,
  code           text,
  name           text not null,
  is_company     boolean not null default true,
  is_customer    boolean not null default false,
  is_supplier    boolean not null default false,
  is_employee    boolean not null default false,
  tax_office     text,
  tax_no         text,                            -- VKN (10) / TCKN (11)
  email          text,
  phone          text,
  website        text,
  address        text,
  district       text,
  city           text,
  postal_code    text,
  country_code   char(2) not null default 'TR',
  iban           text,
  payment_term_days smallint not null default 0,
  credit_limit   numeric(18,2),
  notes          text,
  tags           text[] not null default '{}',
  owner_id       uuid references core.users(id),  -- sorumlu satış temsilcisi
  is_active      boolean not null default true,
  created_by     uuid references core.users(id),
  updated_by     uuid references core.users(id),
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now(),
  constraint ck_partners_tax_no check (tax_no is null or tax_no ~ '^[0-9]{10,11}$')
);

create unique index if not exists ux_partners_tenant_code on core.partners (tenant_id, code) where code is not null;
create index if not exists ix_partners_tax_no on core.partners (tenant_id, tax_no) where tax_no is not null;
create index if not exists ix_partners_name_trgm on core.partners using gin (name gin_trgm_ops);
create index if not exists ix_partners_customer on core.partners (tenant_id) where is_customer and is_active;
create index if not exists ix_partners_supplier on core.partners (tenant_id) where is_supplier and is_active;

-- Cari altındaki kişiler (çok şubeli müşterinin satın alma sorumlusu vb.)
create table if not exists core.partner_contacts (
  id          uuid primary key default gen_random_uuid(),
  tenant_id   uuid not null references core.tenants(id) on delete cascade,
  partner_id  uuid not null references core.partners(id) on delete cascade,
  name        text not null,
  title       text,
  email       text,
  phone       text,
  is_primary  boolean not null default false,
  created_by  uuid references core.users(id),
  updated_by  uuid references core.users(id),
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);
create index if not exists ix_partner_contacts_partner on core.partner_contacts (tenant_id, partner_id);

-- -----------------------------------------------------------------------------
-- RLS + tetikleyiciler
-- -----------------------------------------------------------------------------
select core.register_tenant_table('core', 'uoms',               'core.uom',        false, false);
select core.register_tenant_table('core', 'taxes',              'core.tax',        false, false);
select core.register_tenant_table('core', 'product_categories', 'core.product',    false, false);
select core.register_tenant_table('core', 'products',           'core.product',    false, false);
select core.register_tenant_table('core', 'partners',           'core.partner',    true,  true);
select core.register_tenant_table('core', 'partner_contacts',   'core.partner',    false, false);
select core.register_tenant_table('core', 'documents',          'core.document',   true,  true);
