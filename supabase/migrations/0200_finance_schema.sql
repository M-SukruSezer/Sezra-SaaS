-- =============================================================================
-- 0200 — Muhasebe & Finans (Faz 1 / Bölüm 4.2)
-- =============================================================================
-- Kapsam: Tekdüzen Hesap Planı, yevmiye/defter-i kebir/mizan, alış-satış
-- faturaları, KDV ve tevkifat, tahsilat-ödeme, banka mutabakatı, P&L.
--
-- TEMEL KARAR — muhasebe kaydı değiştirilemez:
-- Muhasebeleşmiş (posted) bir yevmiye kaydı ne güncellenebilir ne silinebilir.
-- Düzeltme yalnızca ters kayıtla yapılır. Bu, mali mevzuatın gereği olduğu
-- kadar denetim izinin de temelidir: "kayıt sonradan düzeltilmiş mi?" sorusu
-- veri modelinde cevaplanamaz hâle getirilmemelidir.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- Hesap planı
-- -----------------------------------------------------------------------------
do $$ begin
  create type finance.account_type as enum
    ('asset', 'liability', 'equity', 'income', 'expense', 'cost', 'offbalance');
exception when duplicate_object then null; end $$;

do $$ begin
  create type finance.entry_status as enum ('draft', 'posted', 'reversed');
exception when duplicate_object then null; end $$;

do $$ begin
  create type finance.invoice_kind as enum ('sale', 'purchase');
exception when duplicate_object then null; end $$;

do $$ begin
  create type finance.invoice_status as enum
    ('draft', 'approved', 'posted', 'partially_paid', 'paid', 'cancelled');
exception when duplicate_object then null; end $$;

create table if not exists finance.accounts (
  id           uuid primary key default gen_random_uuid(),
  tenant_id    uuid not null references core.tenants(id) on delete cascade,
  code         text not null,                      -- '120.01'
  name         text not null,
  parent_id    uuid references finance.accounts(id) on delete restrict,
  type         finance.account_type not null,
  -- Bilanço/gelir tablosu ayrımı raporlamada sürekli gerektiği için türetilmiş
  -- değil, açık kolon: `type in ('income','expense','cost')` sorgusu her rapora
  -- serpiştirilmesin.
  is_pl        boolean not null default false,
  is_leaf      boolean not null default true,      -- yalnızca yaprak hesaplara kayıt atılır
  currency     char(3),                            -- null = kiracı para birimi
  requires_partner boolean not null default false, -- 120/320: cari zorunlu
  is_active    boolean not null default true,
  created_by   uuid references core.users(id),
  updated_by   uuid references core.users(id),
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);

create unique index if not exists ux_accounts_tenant_code on finance.accounts (tenant_id, code);
create index if not exists ix_accounts_parent on finance.accounts (tenant_id, parent_id);
create index if not exists ix_accounts_type on finance.accounts (tenant_id, type) where is_active;

-- -----------------------------------------------------------------------------
-- Mali dönemler — kapanan dönem kilitlenir
-- -----------------------------------------------------------------------------
create table if not exists finance.fiscal_years (
  id          uuid primary key default gen_random_uuid(),
  tenant_id   uuid not null references core.tenants(id) on delete cascade,
  name        text not null,                       -- '2026'
  date_from   date not null,
  date_to     date not null,
  is_closed   boolean not null default false,
  closed_at   timestamptz,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  constraint ck_fiscal_years_range check (date_to > date_from)
);
create unique index if not exists ux_fiscal_years on finance.fiscal_years (tenant_id, name);

create table if not exists finance.fiscal_periods (
  id             uuid primary key default gen_random_uuid(),
  tenant_id      uuid not null references core.tenants(id) on delete cascade,
  fiscal_year_id uuid not null references finance.fiscal_years(id) on delete cascade,
  name           text not null,                    -- '2026-09'
  date_from      date not null,
  date_to        date not null,
  is_closed      boolean not null default false,
  closed_at      timestamptz,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now()
);
create unique index if not exists ux_fiscal_periods on finance.fiscal_periods (tenant_id, name);
create index if not exists ix_fiscal_periods_range on finance.fiscal_periods (tenant_id, date_from, date_to);

-- -----------------------------------------------------------------------------
-- Yevmiye defteri
-- -----------------------------------------------------------------------------
create table if not exists finance.journals (
  id          uuid primary key default gen_random_uuid(),
  tenant_id   uuid not null references core.tenants(id) on delete cascade,
  code        text not null,                       -- 'SATIS', 'ALIS', 'KASA', 'BANKA', 'GENEL'
  name        text not null,
  kind        text not null default 'general'
                check (kind in ('sale', 'purchase', 'cash', 'bank', 'general')),
  default_account_id uuid references finance.accounts(id),
  sequence_code text,                              -- core.sequences kodu
  is_active   boolean not null default true,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);
create unique index if not exists ux_journals_tenant_code on finance.journals (tenant_id, code);

create table if not exists finance.journal_entries (
  id             uuid primary key default gen_random_uuid(),
  tenant_id      uuid not null references core.tenants(id) on delete cascade,
  branch_id      uuid references core.branches(id) on delete set null,
  journal_id     uuid not null references finance.journals(id),
  period_id      uuid references finance.fiscal_periods(id),
  number         text,
  entry_date     date not null default current_date,
  reference      text,                             -- fatura no, dekont no
  description    text,
  status         finance.entry_status not null default 'draft',
  currency       char(3) not null default 'TRY',
  exchange_rate  numeric(18,6) not null default 1,
  total_debit    numeric(18,2) not null default 0,
  total_credit   numeric(18,2) not null default 0,
  -- Kaydı doğuran belge: fatura, tahsilat, bordro… Modüller arası bağ
  -- doğrudan FK ile değil, (modül, tablo, id) üçlüsüyle kurulur ki Muhasebe
  -- CRM'e ya da İK'ya derleme zamanı bağımlılık taşımasın.
  source_module  text,
  source_table   text,
  source_id      uuid,
  reversal_of_id uuid references finance.journal_entries(id),
  posted_at      timestamptz,
  posted_by      uuid references core.users(id),
  owner_id       uuid references core.users(id),
  created_by     uuid references core.users(id),
  updated_by     uuid references core.users(id),
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now()
);

create unique index if not exists ux_journal_entries_number
  on finance.journal_entries (tenant_id, number) where number is not null;
create index if not exists ix_journal_entries_date
  on finance.journal_entries (tenant_id, entry_date desc);
create index if not exists ix_journal_entries_source
  on finance.journal_entries (tenant_id, source_module, source_table, source_id);
create index if not exists ix_journal_entries_posted
  on finance.journal_entries (tenant_id, status, entry_date) where status = 'posted';

create table if not exists finance.journal_entry_lines (
  id           uuid primary key default gen_random_uuid(),
  tenant_id    uuid not null references core.tenants(id) on delete cascade,
  entry_id     uuid not null references finance.journal_entries(id) on delete cascade,
  sequence     smallint not null default 10,
  account_id   uuid not null references finance.accounts(id),
  partner_id   uuid references core.partners(id),
  description  text,
  debit        numeric(18,2) not null default 0 check (debit >= 0),
  credit       numeric(18,2) not null default 0 check (credit >= 0),
  tax_id       uuid references core.taxes(id),
  tax_base     numeric(18,2),                      -- KDV beyanı için matrah
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now(),
  -- Bir satır ya borç ya alacaktır; ikisi birden ya da ikisi de sıfır olamaz.
  constraint ck_jel_one_side check (
    (debit > 0 and credit = 0) or (credit > 0 and debit = 0)
  )
);
create index if not exists ix_jel_entry on finance.journal_entry_lines (tenant_id, entry_id, sequence);
create index if not exists ix_jel_account on finance.journal_entry_lines (tenant_id, account_id);
create index if not exists ix_jel_partner on finance.journal_entry_lines (tenant_id, partner_id)
  where partner_id is not null;

-- -----------------------------------------------------------------------------
-- Hesap bakiyeleri — tetikleyicilerle bakımı yapılan özet tablo
-- -----------------------------------------------------------------------------
-- Mizan ve P&L her sorgulandığında tüm yevmiye satırlarını taramak, veri
-- büyüdükçe kabul edilemez hâle gelir. Muhasebeleşme anında bakiyeleri
-- artırımlı güncelliyoruz (mevcut P&L sisteminizdeki trigger yaklaşımının
-- genelleştirilmiş hâli); raporlar bu tablodan okur.
create table if not exists finance.account_balances (
  tenant_id    uuid not null references core.tenants(id) on delete cascade,
  branch_id    uuid,
  account_id   uuid not null references finance.accounts(id) on delete cascade,
  period_start date not null,                      -- ayın ilk günü
  debit_total  numeric(18,2) not null default 0,
  credit_total numeric(18,2) not null default 0,
  updated_at   timestamptz not null default now()
);

-- branch_id null olabildiği için birincil anahtar ifade üzerinde kurulamaz;
-- benzersizliği kısmi olmayan bir ifade indeksiyle sağlıyoruz.
create unique index if not exists ux_account_balances
  on finance.account_balances (
    tenant_id, account_id, period_start,
    coalesce(branch_id, '00000000-0000-0000-0000-000000000000'::uuid)
  );
create index if not exists ix_account_balances_period
  on finance.account_balances (tenant_id, period_start, account_id);

-- -----------------------------------------------------------------------------
-- Faturalar
-- -----------------------------------------------------------------------------
create table if not exists finance.invoices (
  id                uuid primary key default gen_random_uuid(),
  tenant_id         uuid not null references core.tenants(id) on delete cascade,
  branch_id         uuid references core.branches(id) on delete set null,
  kind              finance.invoice_kind not null,
  number            text,
  partner_id        uuid not null references core.partners(id),
  issue_date        date not null default current_date,
  due_date          date,
  status            finance.invoice_status not null default 'draft',
  currency          char(3) not null default 'TRY',
  exchange_rate     numeric(18,6) not null default 1,
  subtotal          numeric(18,2) not null default 0,
  discount_total    numeric(18,2) not null default 0,
  tax_total         numeric(18,2) not null default 0,
  withholding_total numeric(18,2) not null default 0,
  total             numeric(18,2) not null default 0,
  paid_total        numeric(18,2) not null default 0,
  payment_term_days smallint not null default 0,
  notes             text,
  journal_entry_id  uuid references finance.journal_entries(id),
  -- Kaynak belge (satış siparişi, satın alma siparişi…)
  source_module     text,
  source_table      text,
  source_id         uuid,
  owner_id          uuid references core.users(id),
  created_by        uuid references core.users(id),
  updated_by        uuid references core.users(id),
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now()
);

create unique index if not exists ux_invoices_number
  on finance.invoices (tenant_id, kind, number) where number is not null;
create index if not exists ix_invoices_partner
  on finance.invoices (tenant_id, partner_id, issue_date desc);
create index if not exists ix_invoices_status
  on finance.invoices (tenant_id, kind, status, issue_date desc);
create index if not exists ix_invoices_open
  on finance.invoices (tenant_id, due_date)
  where status in ('posted', 'partially_paid');
create index if not exists ix_invoices_source
  on finance.invoices (tenant_id, source_module, source_table, source_id);

create table if not exists finance.invoice_lines (
  id             uuid primary key default gen_random_uuid(),
  tenant_id      uuid not null references core.tenants(id) on delete cascade,
  invoice_id     uuid not null references finance.invoices(id) on delete cascade,
  sequence       smallint not null default 10,
  product_id     uuid references core.products(id),
  account_id     uuid references finance.accounts(id),   -- gelir/gider hesabı
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
create index if not exists ix_invoice_lines_doc
  on finance.invoice_lines (tenant_id, invoice_id, sequence);

-- -----------------------------------------------------------------------------
-- Tahsilat / ödeme
-- -----------------------------------------------------------------------------
create table if not exists finance.bank_accounts (
  id           uuid primary key default gen_random_uuid(),
  tenant_id    uuid not null references core.tenants(id) on delete cascade,
  branch_id    uuid references core.branches(id) on delete set null,
  name         text not null,
  bank_name    text,
  iban         text,
  currency     char(3) not null default 'TRY',
  account_id   uuid references finance.accounts(id),   -- 102 BANKALAR alt hesabı
  is_active    boolean not null default true,
  created_by   uuid references core.users(id),
  updated_by   uuid references core.users(id),
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);
create unique index if not exists ux_bank_accounts_iban
  on finance.bank_accounts (tenant_id, iban) where iban is not null;

create table if not exists finance.payments (
  id              uuid primary key default gen_random_uuid(),
  tenant_id       uuid not null references core.tenants(id) on delete cascade,
  branch_id       uuid references core.branches(id) on delete set null,
  direction       text not null check (direction in ('in', 'out')),
  number          text,
  partner_id      uuid references core.partners(id),
  payment_date    date not null default current_date,
  method          text not null default 'bank'
                    check (method in ('cash', 'bank', 'card', 'check', 'offset')),
  bank_account_id uuid references finance.bank_accounts(id),
  amount          numeric(18,2) not null check (amount > 0),
  currency        char(3) not null default 'TRY',
  exchange_rate   numeric(18,6) not null default 1,
  allocated_total numeric(18,2) not null default 0,
  status          text not null default 'draft'
                    check (status in ('draft', 'posted', 'cancelled')),
  reference       text,
  notes           text,
  journal_entry_id uuid references finance.journal_entries(id),
  owner_id        uuid references core.users(id),
  created_by      uuid references core.users(id),
  updated_by      uuid references core.users(id),
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);
create index if not exists ix_payments_partner
  on finance.payments (tenant_id, partner_id, payment_date desc);
create unique index if not exists ux_payments_number
  on finance.payments (tenant_id, number) where number is not null;

-- Tahsilatın hangi faturaya mahsup edildiği
create table if not exists finance.payment_allocations (
  id          uuid primary key default gen_random_uuid(),
  tenant_id   uuid not null references core.tenants(id) on delete cascade,
  payment_id  uuid not null references finance.payments(id) on delete cascade,
  invoice_id  uuid not null references finance.invoices(id) on delete cascade,
  amount      numeric(18,2) not null check (amount > 0),
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);
create unique index if not exists ux_payment_allocations
  on finance.payment_allocations (payment_id, invoice_id);
create index if not exists ix_payment_allocations_invoice
  on finance.payment_allocations (tenant_id, invoice_id);

-- -----------------------------------------------------------------------------
-- Banka mutabakatı
-- -----------------------------------------------------------------------------
-- İlk etapta CSV/MT940 içe aktarma (Bölüm 8); açık bankacılık API'si sonradan
-- aynı tablolara yazacak şekilde eklenir.
create table if not exists finance.bank_statements (
  id              uuid primary key default gen_random_uuid(),
  tenant_id       uuid not null references core.tenants(id) on delete cascade,
  bank_account_id uuid not null references finance.bank_accounts(id) on delete cascade,
  name            text,
  date_from       date not null,
  date_to         date not null,
  opening_balance numeric(18,2) not null default 0,
  closing_balance numeric(18,2) not null default 0,
  source          text not null default 'csv' check (source in ('csv', 'mt940', 'api', 'manual')),
  imported_at     timestamptz not null default now(),
  created_by      uuid references core.users(id),
  updated_by      uuid references core.users(id),
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);

create table if not exists finance.bank_statement_lines (
  id            uuid primary key default gen_random_uuid(),
  tenant_id     uuid not null references core.tenants(id) on delete cascade,
  statement_id  uuid not null references finance.bank_statements(id) on delete cascade,
  value_date    date not null,
  description   text,
  counterparty  text,
  reference     text,
  amount        numeric(18,2) not null,            -- işaretli: + giriş, − çıkış
  balance_after numeric(18,2),
  status        text not null default 'unmatched'
                  check (status in ('unmatched', 'matched', 'ignored')),
  payment_id    uuid references finance.payments(id) on delete set null,
  matched_at    timestamptz,
  matched_by    uuid references core.users(id),
  -- Aynı ekstrenin iki kez yüklenmesini engelleyen parmak izi
  fingerprint   text,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);
create index if not exists ix_bsl_statement
  on finance.bank_statement_lines (tenant_id, statement_id, value_date);
create index if not exists ix_bsl_unmatched
  on finance.bank_statement_lines (tenant_id, status) where status = 'unmatched';
create unique index if not exists ux_bsl_fingerprint
  on finance.bank_statement_lines (tenant_id, fingerprint) where fingerprint is not null;

-- -----------------------------------------------------------------------------
-- e-Fatura / e-Arşiv soyutlaması (Bölüm 6)
-- -----------------------------------------------------------------------------
-- Sağlayıcı seçimi ertelenmiştir (Bölüm 11 açık sorusu). Bu tablo, hangi
-- entegratör seçilirse seçilsin değişmeyen ortak durumu tutar; sağlayıcıya
-- özgü alanlar `provider_payload` içinde yaşar. Böylece sağlayıcı değiştirmek
-- şema göçü değil, adapter değiştirmek olur.
create table if not exists finance.einvoice_documents (
  id               uuid primary key default gen_random_uuid(),
  tenant_id        uuid not null references core.tenants(id) on delete cascade,
  invoice_id       uuid not null references finance.invoices(id) on delete cascade,
  provider         text not null default 'stub',
  profile          text not null default 'TEMELFATURA'
                     check (profile in ('TEMELFATURA', 'TICARIFATURA', 'EARSIVFATURA',
                                        'IHRACAT', 'YOLCUBERABERFATURA')),
  ettn             uuid,                              -- GİB evrensel tekil numara
  gib_number       text,                              -- GİB'in atadığı fatura no
  direction        text not null default 'outbound' check (direction in ('outbound', 'inbound')),
  status           text not null default 'queued'
                     check (status in ('queued', 'sent', 'delivered', 'accepted',
                                       'rejected', 'error', 'cancelled')),
  attempts         smallint not null default 0,
  last_error       text,
  provider_payload jsonb not null default '{}'::jsonb,
  provider_response jsonb,
  sent_at          timestamptz,
  responded_at     timestamptz,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now()
);
create index if not exists ix_einvoice_invoice on finance.einvoice_documents (tenant_id, invoice_id);
create index if not exists ix_einvoice_queue
  on finance.einvoice_documents (tenant_id, status) where status in ('queued', 'error');
create unique index if not exists ux_einvoice_ettn
  on finance.einvoice_documents (ettn) where ettn is not null;
