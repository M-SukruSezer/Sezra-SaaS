-- =============================================================================
-- 0100 — CRM & Satış Yönetimi (Faz 1 / Bölüm 4.1)
-- =============================================================================
-- Akış:  Aday (lead) -> Teklif -> Sipariş -> [olay] -> Muhasebe fatura taslağı
-- Muhasebe modülüne DOĞRUDAN referans yok; entegrasyon yalnızca olaylarla.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- Satış hunisi tanımı
-- -----------------------------------------------------------------------------
create table if not exists crm.pipelines (
  id          uuid primary key default gen_random_uuid(),
  tenant_id   uuid not null references core.tenants(id) on delete cascade,
  name        text not null,
  is_default  boolean not null default false,
  is_active   boolean not null default true,
  created_by  uuid references core.users(id),
  updated_by  uuid references core.users(id),
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);
create unique index if not exists ux_pipelines_default on crm.pipelines (tenant_id) where is_default;

create table if not exists crm.stages (
  id           uuid primary key default gen_random_uuid(),
  tenant_id    uuid not null references core.tenants(id) on delete cascade,
  pipeline_id  uuid not null references crm.pipelines(id) on delete cascade,
  name         text not null,
  sequence     smallint not null default 10,
  probability  smallint not null default 0 check (probability between 0 and 100),
  is_won       boolean not null default false,
  is_lost      boolean not null default false,
  created_by   uuid references core.users(id),
  updated_by   uuid references core.users(id),
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now(),
  constraint ck_stages_won_lost check (not (is_won and is_lost))
);
create index if not exists ix_stages_pipeline on crm.stages (tenant_id, pipeline_id, sequence);

create table if not exists crm.lost_reasons (
  id          uuid primary key default gen_random_uuid(),
  tenant_id   uuid not null references core.tenants(id) on delete cascade,
  name        text not null,
  is_active   boolean not null default true,
  created_by  uuid references core.users(id),
  updated_by  uuid references core.users(id),
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

-- -----------------------------------------------------------------------------
-- Adaylar / fırsatlar
-- -----------------------------------------------------------------------------
create table if not exists crm.leads (
  id                 uuid primary key default gen_random_uuid(),
  tenant_id          uuid not null references core.tenants(id) on delete cascade,
  branch_id          uuid references core.branches(id) on delete set null,
  pipeline_id        uuid not null references crm.pipelines(id),
  stage_id           uuid not null references crm.stages(id),
  name               text not null,                       -- fırsat başlığı
  partner_id         uuid references core.partners(id) on delete set null,
  contact_name       text,
  email              text,
  phone              text,
  source             text,                                -- 'referans','instagram','walk-in'...
  expected_revenue   numeric(18,2) not null default 0,
  currency           char(3) not null default 'TRY',
  probability        smallint not null default 0 check (probability between 0 and 100),
  priority           smallint not null default 0 check (priority between 0 and 3),
  status             text not null default 'open' check (status in ('open', 'won', 'lost')),
  lost_reason_id     uuid references crm.lost_reasons(id),
  lost_note          text,
  expected_close_date date,
  closed_at          timestamptz,
  tags               text[] not null default '{}',
  notes              text,
  owner_id           uuid references core.users(id),      -- sorumlu satış temsilcisi
  created_by         uuid references core.users(id),
  updated_by         uuid references core.users(id),
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now(),
  constraint ck_leads_lost_reason check (status <> 'lost' or lost_reason_id is not null)
);

create index if not exists ix_leads_stage on crm.leads (tenant_id, stage_id) where status = 'open';
create index if not exists ix_leads_partner on crm.leads (tenant_id, partner_id);
create index if not exists ix_leads_close_date on crm.leads (tenant_id, expected_close_date) where status = 'open';
create index if not exists ix_leads_name_trgm on crm.leads using gin (name gin_trgm_ops);

-- -----------------------------------------------------------------------------
-- Aktiviteler (arama, toplantı, e-posta, görev)
-- -----------------------------------------------------------------------------
create table if not exists crm.activities (
  id            uuid primary key default gen_random_uuid(),
  tenant_id     uuid not null references core.tenants(id) on delete cascade,
  branch_id     uuid references core.branches(id) on delete set null,
  lead_id       uuid references crm.leads(id) on delete cascade,
  partner_id    uuid references core.partners(id) on delete cascade,
  kind          text not null default 'task'
                  check (kind in ('call', 'meeting', 'email', 'task', 'note')),
  subject       text not null,
  notes         text,
  due_at        timestamptz,
  done_at       timestamptz,
  outcome       text,
  assigned_to   uuid references core.users(id),
  owner_id      uuid references core.users(id),
  created_by    uuid references core.users(id),
  updated_by    uuid references core.users(id),
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  constraint ck_activities_target check (lead_id is not null or partner_id is not null)
);

create index if not exists ix_activities_lead on crm.activities (tenant_id, lead_id);
create index if not exists ix_activities_due
  on crm.activities (tenant_id, assigned_to, due_at) where done_at is null;

-- -----------------------------------------------------------------------------
-- Teklifler
-- -----------------------------------------------------------------------------
create table if not exists crm.quotations (
  id                uuid primary key default gen_random_uuid(),
  tenant_id         uuid not null references core.tenants(id) on delete cascade,
  branch_id         uuid references core.branches(id) on delete set null,
  number            text,
  partner_id        uuid not null references core.partners(id),
  lead_id           uuid references crm.leads(id) on delete set null,
  issue_date        date not null default current_date,
  valid_until       date,
  status            text not null default 'draft'
                      check (status in ('draft', 'sent', 'accepted', 'rejected', 'expired', 'cancelled')),
  currency          char(3) not null default 'TRY',
  subtotal          numeric(18,2) not null default 0,
  discount_total    numeric(18,2) not null default 0,
  tax_total         numeric(18,2) not null default 0,
  withholding_total numeric(18,2) not null default 0,
  total             numeric(18,2) not null default 0,
  payment_term_days smallint not null default 0,
  notes             text,
  accepted_at       timestamptz,
  rejected_at       timestamptz,
  owner_id          uuid references core.users(id),
  created_by        uuid references core.users(id),
  updated_by        uuid references core.users(id),
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now()
);
create unique index if not exists ux_quotations_number on crm.quotations (tenant_id, number) where number is not null;
create index if not exists ix_quotations_partner on crm.quotations (tenant_id, partner_id, issue_date desc);

create table if not exists crm.quotation_lines (
  id             uuid primary key default gen_random_uuid(),
  tenant_id      uuid not null references core.tenants(id) on delete cascade,
  quotation_id   uuid not null references crm.quotations(id) on delete cascade,
  sequence       smallint not null default 10,
  product_id     uuid references core.products(id),
  description    text not null,
  quantity       numeric(18,4) not null default 1 check (quantity > 0),
  uom_id         uuid references core.uoms(id),
  unit_price     numeric(18,4) not null default 0,
  discount_pct   numeric(6,3) not null default 0 check (discount_pct between 0 and 100),
  tax_id         uuid references core.taxes(id),
  line_subtotal  numeric(18,2) not null default 0,
  line_tax       numeric(18,2) not null default 0,
  line_withholding numeric(18,2) not null default 0,
  line_total     numeric(18,2) not null default 0,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now()
);
create index if not exists ix_quotation_lines_doc on crm.quotation_lines (tenant_id, quotation_id, sequence);

-- -----------------------------------------------------------------------------
-- Satış siparişleri
-- -----------------------------------------------------------------------------
create table if not exists crm.sale_orders (
  id                uuid primary key default gen_random_uuid(),
  tenant_id         uuid not null references core.tenants(id) on delete cascade,
  branch_id         uuid references core.branches(id) on delete set null,
  number            text,
  partner_id        uuid not null references core.partners(id),
  quotation_id      uuid references crm.quotations(id) on delete set null,
  order_date        date not null default current_date,
  delivery_date     date,
  status            text not null default 'draft'
                      check (status in ('draft', 'confirmed', 'delivered', 'invoiced', 'cancelled')),
  currency          char(3) not null default 'TRY',
  subtotal          numeric(18,2) not null default 0,
  discount_total    numeric(18,2) not null default 0,
  tax_total         numeric(18,2) not null default 0,
  withholding_total numeric(18,2) not null default 0,
  total             numeric(18,2) not null default 0,
  payment_term_days smallint not null default 0,
  notes             text,
  confirmed_at      timestamptz,
  cancelled_at      timestamptz,
  owner_id          uuid references core.users(id),
  created_by        uuid references core.users(id),
  updated_by        uuid references core.users(id),
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now()
);
create unique index if not exists ux_sale_orders_number on crm.sale_orders (tenant_id, number) where number is not null;
create index if not exists ix_sale_orders_partner on crm.sale_orders (tenant_id, partner_id, order_date desc);
create index if not exists ix_sale_orders_status on crm.sale_orders (tenant_id, status, order_date desc);

create table if not exists crm.sale_order_lines (
  id             uuid primary key default gen_random_uuid(),
  tenant_id      uuid not null references core.tenants(id) on delete cascade,
  sale_order_id  uuid not null references crm.sale_orders(id) on delete cascade,
  sequence       smallint not null default 10,
  product_id     uuid references core.products(id),
  description    text not null,
  quantity       numeric(18,4) not null default 1 check (quantity > 0),
  uom_id         uuid references core.uoms(id),
  unit_price     numeric(18,4) not null default 0,
  discount_pct   numeric(6,3) not null default 0 check (discount_pct between 0 and 100),
  tax_id         uuid references core.taxes(id),
  line_subtotal  numeric(18,2) not null default 0,
  line_tax       numeric(18,2) not null default 0,
  line_withholding numeric(18,2) not null default 0,
  line_total     numeric(18,2) not null default 0,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now()
);
create index if not exists ix_sale_order_lines_doc on crm.sale_order_lines (tenant_id, sale_order_id, sequence);
