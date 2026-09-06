-- =============================================================================
-- 0400 — Satın Alma & Tedarikçi Yönetimi: şema  (Bölüm 4.4)
-- =============================================================================
-- AKIŞ:  talep → onay → sipariş → mal kabul
--
-- TASARIM KARARLARI
--
-- 1. TEDARİKÇİ AYRI BİR TABLO DEĞİL. Bölüm 7 kuralı gereği tedarikçi de
--    core.partners'ta yaşar (is_supplier bayrağı). Aynı firma hem müşteri hem
--    tedarikçi olabildiği için ayrı tablo, aynı firmayı iki kez yaratmak
--    demekti. Satın almaya özgü alanlar (fiyat listesi, teslim süresi) burada,
--    ilişkili tablolarda tutulur.
--
-- 2. TALEP ile SİPARİŞ ayrı belgelerdir. Talep İÇ bir belgedir: "şu ürüne
--    ihtiyacım var" der, tedarikçisi henüz belli olmayabilir. Sipariş ise
--    tedarikçiye giden TAAHHÜTTÜR. İkisini tek tabloda birleştirmek, onay
--    akışını ("kim istedi, kim onayladı") sipariş durumuna gömerdi.
--
-- 3. MAL KABUL kısmi olabilir. Sipariş satırı 100 adet derken 60 gelebilir;
--    kalan 40 için ikinci bir kabul açılır. Bu yüzden kabul, siparişin bir
--    durumu değil, AYRI bir belgedir ve sipariş satırına miktar bazında bağlanır.
-- =============================================================================

do $$ begin
  create type purchasing.requisition_status as enum
    ('draft', 'pending', 'approved', 'rejected', 'ordered', 'cancelled');
exception when duplicate_object then null; end $$;

do $$ begin
  create type purchasing.order_status as enum
    ('draft', 'confirmed', 'partially_received', 'received', 'cancelled');
exception when duplicate_object then null; end $$;

do $$ begin
  create type purchasing.receipt_status as enum ('draft', 'confirmed', 'cancelled');
exception when duplicate_object then null; end $$;

-- -----------------------------------------------------------------------------
-- Tedarikçi fiyat listeleri
-- -----------------------------------------------------------------------------
-- Aynı ürün için birden fazla tedarikçi ve miktar kademesi olabilir.
-- `min_quantity` kademeli fiyat içindir: 100 adetten sonra farklı birim fiyat.
create table if not exists purchasing.supplier_prices (
  id             uuid primary key default gen_random_uuid(),
  tenant_id      uuid not null references core.tenants(id) on delete cascade,
  partner_id     uuid not null references core.partners(id) on delete cascade,
  product_id     uuid not null references core.products(id) on delete cascade,
  supplier_sku   text,                                  -- tedarikçinin kendi kodu
  unit_price     numeric(18,4) not null default 0,
  currency       char(3) not null default 'TRY',
  uom_id         uuid references core.uoms(id),
  min_quantity   numeric(18,4) not null default 0,
  lead_time_days smallint not null default 0,           -- taahhüt edilen teslim süresi
  valid_from     date not null default current_date,
  valid_to       date,
  is_active      boolean not null default true,
  created_by     uuid references core.users(id),
  updated_by     uuid references core.users(id),
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now(),
  constraint ck_supplier_prices_dates check (valid_to is null or valid_to >= valid_from)
);

create index if not exists ix_supplier_prices_lookup
  on purchasing.supplier_prices (tenant_id, product_id, partner_id, min_quantity desc)
  where is_active;

-- -----------------------------------------------------------------------------
-- Satın alma talebi (iç belge)
-- -----------------------------------------------------------------------------
create table if not exists purchasing.requisitions (
  id                uuid primary key default gen_random_uuid(),
  tenant_id         uuid not null references core.tenants(id) on delete cascade,
  branch_id         uuid references core.branches(id) on delete set null,
  number            text,
  -- Talebi açan departman/kişi; tedarikçi bu aşamada opsiyonel bir ÖNERİDİR
  suggested_partner_id uuid references core.partners(id),
  request_date      date not null default current_date,
  needed_by         date,
  status            purchasing.requisition_status not null default 'draft',
  currency          char(3) not null default 'TRY',
  subtotal          numeric(18,2) not null default 0,
  discount_total    numeric(18,2) not null default 0,
  tax_total         numeric(18,2) not null default 0,
  withholding_total numeric(18,2) not null default 0,
  total             numeric(18,2) not null default 0,
  justification     text,                                -- neden gerekiyor
  approver_id       uuid references core.users(id),
  approved_at       timestamptz,
  rejection_reason  text,
  notes             text,
  owner_id          uuid references core.users(id),
  created_by        uuid references core.users(id),
  updated_by        uuid references core.users(id),
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now()
);
create unique index if not exists ux_requisitions_number
  on purchasing.requisitions (tenant_id, number) where number is not null;
create index if not exists ix_requisitions_status
  on purchasing.requisitions (tenant_id, status) where status = 'pending';

create table if not exists purchasing.requisition_lines (
  id               uuid primary key default gen_random_uuid(),
  tenant_id        uuid not null references core.tenants(id) on delete cascade,
  requisition_id   uuid not null references purchasing.requisitions(id) on delete cascade,
  sequence         smallint not null default 10,
  product_id       uuid references core.products(id),
  description      text not null,
  quantity         numeric(18,4) not null default 1 check (quantity > 0),
  uom_id           uuid references core.uoms(id),
  unit_price       numeric(18,4) not null default 0,
  discount_pct     numeric(6,3) not null default 0 check (discount_pct between 0 and 100),
  tax_id           uuid references core.taxes(id),
  line_subtotal    numeric(18,2) not null default 0,
  line_tax         numeric(18,2) not null default 0,
  line_withholding numeric(18,2) not null default 0,
  line_total       numeric(18,2) not null default 0,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now()
);
create index if not exists ix_requisition_lines_doc
  on purchasing.requisition_lines (tenant_id, requisition_id, sequence);

-- -----------------------------------------------------------------------------
-- Satın alma siparişi (tedarikçiye taahhüt)
-- -----------------------------------------------------------------------------
create table if not exists purchasing.orders (
  id                uuid primary key default gen_random_uuid(),
  tenant_id         uuid not null references core.tenants(id) on delete cascade,
  branch_id         uuid references core.branches(id) on delete set null,
  number            text,
  partner_id        uuid not null references core.partners(id),
  requisition_id    uuid references purchasing.requisitions(id) on delete set null,
  order_date        date not null default current_date,
  -- Tedarikçinin söz verdiği tarih. Performans takibi bunu gerçekleşenle karşılaştırır.
  promised_date     date,
  status            purchasing.order_status not null default 'draft',
  currency          char(3) not null default 'TRY',
  subtotal          numeric(18,2) not null default 0,
  discount_total    numeric(18,2) not null default 0,
  tax_total         numeric(18,2) not null default 0,
  withholding_total numeric(18,2) not null default 0,
  total             numeric(18,2) not null default 0,
  payment_term_days smallint not null default 0,
  supplier_ref      text,                                -- tedarikçinin sipariş no'su
  notes             text,
  confirmed_at      timestamptz,
  cancelled_at      timestamptz,
  cancel_reason     text,
  owner_id          uuid references core.users(id),
  created_by        uuid references core.users(id),
  updated_by        uuid references core.users(id),
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now()
);
create unique index if not exists ux_purchase_orders_number
  on purchasing.orders (tenant_id, number) where number is not null;
create index if not exists ix_purchase_orders_partner
  on purchasing.orders (tenant_id, partner_id, order_date desc);

create table if not exists purchasing.order_lines (
  id               uuid primary key default gen_random_uuid(),
  tenant_id        uuid not null references core.tenants(id) on delete cascade,
  order_id         uuid not null references purchasing.orders(id) on delete cascade,
  requisition_line_id uuid references purchasing.requisition_lines(id) on delete set null,
  sequence         smallint not null default 10,
  product_id       uuid references core.products(id),
  description      text not null,
  quantity         numeric(18,4) not null default 1 check (quantity > 0),
  uom_id           uuid references core.uoms(id),
  unit_price       numeric(18,4) not null default 0,
  discount_pct     numeric(6,3) not null default 0 check (discount_pct between 0 and 100),
  tax_id           uuid references core.taxes(id),
  line_subtotal    numeric(18,2) not null default 0,
  line_tax         numeric(18,2) not null default 0,
  line_withholding numeric(18,2) not null default 0,
  line_total       numeric(18,2) not null default 0,
  -- Kısmi kabul takibi: onaylı kabul satırlarından türetilir, elle yazılmaz.
  received_quantity numeric(18,4) not null default 0,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now()
);
create index if not exists ix_purchase_order_lines_doc
  on purchasing.order_lines (tenant_id, order_id, sequence);

-- -----------------------------------------------------------------------------
-- Mal kabul
-- -----------------------------------------------------------------------------
create table if not exists purchasing.receipts (
  id             uuid primary key default gen_random_uuid(),
  tenant_id      uuid not null references core.tenants(id) on delete cascade,
  branch_id      uuid references core.branches(id) on delete set null,
  number         text,
  order_id       uuid not null references purchasing.orders(id) on delete cascade,
  partner_id     uuid not null references core.partners(id),
  receipt_date   date not null default current_date,
  status         purchasing.receipt_status not null default 'draft',
  waybill_no     text,                                  -- irsaliye numarası
  notes          text,
  confirmed_at   timestamptz,
  owner_id       uuid references core.users(id),
  created_by     uuid references core.users(id),
  updated_by     uuid references core.users(id),
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now()
);
create unique index if not exists ux_receipts_number
  on purchasing.receipts (tenant_id, number) where number is not null;
create index if not exists ix_receipts_order on purchasing.receipts (tenant_id, order_id);

create table if not exists purchasing.receipt_lines (
  id             uuid primary key default gen_random_uuid(),
  tenant_id      uuid not null references core.tenants(id) on delete cascade,
  receipt_id     uuid not null references purchasing.receipts(id) on delete cascade,
  order_line_id  uuid not null references purchasing.order_lines(id) on delete cascade,
  sequence       smallint not null default 10,
  quantity       numeric(18,4) not null check (quantity > 0),
  -- Reddedilen miktar (hasarlı/uygunsuz). Stok girişine SAYILMAZ.
  rejected_quantity numeric(18,4) not null default 0 check (rejected_quantity >= 0),
  reject_reason  text,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now()
);
create index if not exists ix_receipt_lines_doc
  on purchasing.receipt_lines (tenant_id, receipt_id, sequence);
create index if not exists ix_receipt_lines_order_line
  on purchasing.receipt_lines (order_line_id);
