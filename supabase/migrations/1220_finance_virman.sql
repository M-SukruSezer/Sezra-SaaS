-- =============================================================================
-- 1220 — Virman (hesaplar arası transfer) — T-036 / FAZ 5 adım 1
--
-- Şartname madde 18, 20, 21. T-032 boşluk analizinde "gerçekten YOK" listesinde:
--   "finance ve pos şemalarında hesaplar arası (kasa->banka, banka->banka)
--    tek-belge iç transfer kavramı yok."
--
-- YAKLAŞIM:
--   * Yeni tablo finance.transfers — bir virman TEK belgedir: kaynak hesaptan
--     çıkış + hedef hesaba giriş aynı transaction'da, çift taraflı yevmiye kaydı.
--   * Silme YOK. Bir virman iptal edilecekse ters yevmiye kaydı alınır
--     (finance.reverse_entry) ve belge 'cancelled' işaretlenir; satır düşmez,
--     tarihçe korunur (insan kuralı: aktif/pasif ya da iptal, silme değil).
--   * Numara core.next_sequence('finance_transfer', ...) ile — mevcut desenin
--     aynısı (fatura/tahsilat gibi).
--
-- BU ADIM: tek para birimli virman (kaynak ve hedef aynı para birimi).
-- Çok para birimli virman (kur işlem anında sabitlenir, ayrı tutar kolonları)
-- adım 2'de (1221) fonksiyonların yerine geçerek eklenir; tablo kolonları
-- (source_amount / dest_amount / exchange_rate) baştan burada tanımlıdır ki
-- ikinci adım ALTER TABLE gerektirmesin.
--
-- MEVCUT AKIŞLARA DOKUNULMADI: finance.payments / register_payment / post_payment
-- olduğu gibi. Virman ayrı bir belge türü olarak yanlarına eklendi.
-- =============================================================================
set client_min_messages = warning;

-- -----------------------------------------------------------------------------
-- Tablo
-- -----------------------------------------------------------------------------
create table if not exists finance.transfers (
  id                     uuid primary key default gen_random_uuid(),
  tenant_id              uuid not null references core.tenants(id) on delete cascade,
  branch_id              uuid references core.branches(id) on delete set null,
  number                 text,
  transfer_date          date not null default current_date,

  -- Kaynak / hedef muhasebe hesabı (100 KASA, 102 BANKALAR alt hesapları…).
  -- Banka bacağı ayrıca finance.bank_accounts satırına bağlanır; kasa bacağı
  -- yalnızca GL hesabıdır (çoklu kasa hesabı adım 3'te gelir).
  source_account_id      uuid not null references finance.accounts(id),
  source_bank_account_id uuid references finance.bank_accounts(id),
  dest_account_id        uuid not null references finance.accounts(id),
  dest_bank_account_id   uuid references finance.bank_accounts(id),

  -- Kaynak ve hedef tutar AYRI kolonlarda: tek para birimli virmanda ikisi
  -- eşittir; çok para birimli virmanda (adım 2) farklıdır ve exchange_rate
  -- işlem anında sabitlenir.
  source_currency        char(3) not null default 'TRY',
  dest_currency          char(3) not null default 'TRY',
  source_amount          numeric(18,2) not null check (source_amount > 0),
  dest_amount            numeric(18,2) not null check (dest_amount > 0),
  exchange_rate          numeric(18,6) not null default 1 check (exchange_rate > 0),

  status                 text not null default 'draft'
                           check (status in ('draft', 'posted', 'cancelled')),
  reference              text,
  description            text,
  notes                  text,

  journal_entry_id       uuid references finance.journal_entries(id),
  cancelled_at           timestamptz,
  cancel_reason          text,

  owner_id               uuid references core.users(id),
  created_by             uuid references core.users(id),
  updated_by             uuid references core.users(id),
  created_at             timestamptz not null default now(),
  updated_at             timestamptz not null default now(),

  -- Bir virman iki FARKLI hesap arasında olur.
  constraint ck_transfers_distinct check (
    source_account_id <> dest_account_id
    or source_bank_account_id is distinct from dest_bank_account_id
  )
);

create unique index if not exists ux_transfers_number
  on finance.transfers (tenant_id, number) where number is not null;
create index if not exists ix_transfers_date
  on finance.transfers (tenant_id, transfer_date desc);
create index if not exists ix_transfers_source
  on finance.transfers (tenant_id, source_account_id);
create index if not exists ix_transfers_dest
  on finance.transfers (tenant_id, dest_account_id);
create index if not exists ix_transfers_status
  on finance.transfers (tenant_id, status, transfer_date desc);

comment on table finance.transfers is
  'Virman: hesaplar arası iç transfer (kasa<->kasa, kasa<->banka, banka<->banka). '
  'Tek belge, çift taraflı yevmiye kaydı. Silinmez; iptal = ters kayıt + cancelled.';

-- -----------------------------------------------------------------------------
-- Muhasebeleşmiş virman değiştirilemez / silinemez
-- -----------------------------------------------------------------------------
create or replace function finance.fn_lock_posted_transfer()
returns trigger
language plpgsql
as $$
begin
  if tg_op = 'DELETE' then
    raise exception 'Virman belgesi silinemez; iptal için ters kayıt kullanın (finance.cancel_transfer)'
      using errcode = '23514';
  end if;
  -- draft -> posted -> cancelled dışında içerik değişimi yasak
  if old.status in ('posted', 'cancelled')
     and (new.source_account_id, new.dest_account_id, new.source_amount, new.dest_amount,
          new.source_currency, new.dest_currency, new.exchange_rate, new.transfer_date)
      is distinct from
         (old.source_account_id, old.dest_account_id, old.source_amount, old.dest_amount,
          old.source_currency, old.dest_currency, old.exchange_rate, old.transfer_date) then
    raise exception 'Muhasebeleşmiş virmanın içeriği değiştirilemez' using errcode = '23514';
  end if;
  if old.status = 'cancelled' and new.status <> 'cancelled' then
    raise exception 'İptal edilmiş virman yeniden açılamaz' using errcode = '23514';
  end if;
  return new;
end;
$$;

drop trigger if exists trg_transfer_lock on finance.transfers;
create trigger trg_transfer_lock before update or delete on finance.transfers
  for each row execute function finance.fn_lock_posted_transfer();

-- -----------------------------------------------------------------------------
-- RLS + izinler
-- -----------------------------------------------------------------------------
select core.register_tenant_table('finance', 'transfers', 'finance.transfer', true, true);

select core.declare_entity_permissions('finance', 'transfer', 'Virman');
select core.declare_permission('finance.transfer.post', 'finance', 'finance.transfer', 'approve',
  'Virmanı muhasebeleştir / iptal et (ters kayıt)');

select core.grant_to_role('accounting', array[
  'finance.transfer.read.all','finance.transfer.write.all','finance.transfer.create',
  'finance.transfer.post'
]);
select core.grant_to_role('branch_manager', array['finance.transfer.read.all']);
select core.grant_to_role('readonly', array['finance.transfer.read.all']);
select core.grant_module_to_role('tenant_admin', 'finance');

-- -----------------------------------------------------------------------------
-- Belge numarası serisi — mevcut ve yeni kiracılar için
-- -----------------------------------------------------------------------------
-- core.next_sequence eksik seriyi kendi üretir ('FIN-' ön ekiyle), ama
-- finance_cek/finance_senet gibi burada da açık ön ek ('VIR-') tanımlıyoruz.
do $$
declare t uuid;
begin
  for t in select id from core.tenants loop
    insert into core.sequences (tenant_id, code, prefix, padding, period)
    values (t, 'finance_transfer', 'VIR-', 6, 'year')
    on conflict do nothing;
  end loop;
end $$;

-- Yeni kiracı kurulumuna da ekle
create or replace function finance.provision_transfer_sequence(p_tenant_id uuid)
returns void
language plpgsql
security definer
set search_path = finance, core, pg_temp
as $$
begin
  insert into core.sequences (tenant_id, code, prefix, padding, period)
  values (p_tenant_id, 'finance_transfer', 'VIR-', 6, 'year')
  on conflict do nothing;
end;
$$;
select core.register_provisioner('finance', 'finance.provision_transfer_sequence', 31::smallint);

-- -----------------------------------------------------------------------------
-- Liste görünümü
-- -----------------------------------------------------------------------------
create or replace view finance.v_transfer_list
with (security_invoker = on) as
select tr.*,
       sa.code  as source_account_code,
       sa.name  as source_account_name,
       da.code  as dest_account_code,
       da.name  as dest_account_name,
       sba.name as source_bank_account_name,
       dba.name as dest_bank_account_name,
       u.full_name as owner_name,
       b.name   as branch_name,
       (tr.source_currency <> tr.dest_currency) as is_multi_currency
from finance.transfers tr
left join finance.accounts sa on sa.id = tr.source_account_id
left join finance.accounts da on da.id = tr.dest_account_id
left join finance.bank_accounts sba on sba.id = tr.source_bank_account_id
left join finance.bank_accounts dba on dba.id = tr.dest_bank_account_id
left join core.users u on u.id = tr.owner_id
left join core.branches b on b.id = tr.branch_id;

-- -----------------------------------------------------------------------------
-- Muhasebeleştirme
-- -----------------------------------------------------------------------------
-- Virman yevmiye kaydı (tek para birimli):
--   Borç  hedef hesap    (para girişi)   tutar
--   Alacak kaynak hesap   (para çıkışı)   tutar
create or replace function finance.post_transfer(p_id uuid)
returns finance.transfers
language plpgsql
security invoker
as $$
declare
  v_tr       finance.transfers;
  v_entry_id uuid;
  v_journal  uuid;
  v_jkind    text;
  v_src_bank boolean;
  v_dst_bank boolean;
  v_desc     text;
begin
  if not core.has_perm('finance.transfer.post') then
    raise exception 'Virman muhasebeleştirme yetkiniz yok' using errcode = '42501';
  end if;

  select * into v_tr from finance.transfers where id = p_id for update;
  if not found then raise exception 'Virman bulunamadı' using errcode = 'P0002'; end if;
  if v_tr.status <> 'draft' then
    raise exception 'Bu virman zaten işlenmiş (durum: %)', v_tr.status;
  end if;

  if v_tr.source_currency <> v_tr.dest_currency then
    raise exception 'Çok para birimli virman bu sürümde desteklenmiyor (kaynak %, hedef %)',
      v_tr.source_currency, v_tr.dest_currency using errcode = '23514';
  end if;
  if v_tr.source_amount <> v_tr.dest_amount then
    raise exception 'Tek para birimli virmanda kaynak ve hedef tutar eşit olmalı'
      using errcode = '23514';
  end if;

  v_src_bank := v_tr.source_bank_account_id is not null;
  v_dst_bank := v_tr.dest_bank_account_id is not null;
  v_jkind := case
    when not v_src_bank and not v_dst_bank then 'cash'
    when v_src_bank and v_dst_bank then 'bank'
    else 'general'
  end;

  select id into v_journal from finance.journals
   where tenant_id = v_tr.tenant_id and kind = v_jkind and is_active limit 1;
  if v_journal is null then
    select id into v_journal from finance.journals
     where tenant_id = v_tr.tenant_id and kind = 'general' limit 1;
  end if;
  if v_journal is null then
    raise exception 'Virman için yevmiye tanımlı değil' using errcode = '22023';
  end if;

  select 'Virman: ' || coalesce(sa.name, '?') || ' -> ' || coalesce(da.name, '?')
    into v_desc
  from finance.accounts sa, finance.accounts da
  where sa.id = v_tr.source_account_id and da.id = v_tr.dest_account_id;

  insert into finance.journal_entries (
    tenant_id, branch_id, journal_id, entry_date, reference, description,
    currency, exchange_rate, source_module, source_table, source_id, owner_id
  ) values (
    v_tr.tenant_id, v_tr.branch_id, v_journal, v_tr.transfer_date,
    coalesce(v_tr.reference, v_tr.number),
    coalesce(v_tr.description, v_desc),
    v_tr.source_currency, v_tr.exchange_rate,
    'finance', 'transfers', v_tr.id, v_tr.owner_id
  ) returning id into v_entry_id;

  insert into finance.journal_entry_lines
    (tenant_id, entry_id, sequence, account_id, description, debit)
  values (v_tr.tenant_id, v_entry_id, 10, v_tr.dest_account_id, 'Virman girişi', v_tr.dest_amount);

  insert into finance.journal_entry_lines
    (tenant_id, entry_id, sequence, account_id, description, credit)
  values (v_tr.tenant_id, v_entry_id, 20, v_tr.source_account_id, 'Virman çıkışı', v_tr.source_amount);

  perform finance.post_entry(v_entry_id);

  update finance.transfers
     set status = 'posted',
         journal_entry_id = v_entry_id,
         number = coalesce(number, core.next_sequence('finance_transfer', branch_id))
   where id = p_id
   returning * into v_tr;

  perform core.emit_event('finance.transfer.posted', jsonb_build_object(
    'transfer_id', v_tr.id, 'number', v_tr.number,
    'source_account_id', v_tr.source_account_id, 'dest_account_id', v_tr.dest_account_id,
    'source_amount', v_tr.source_amount, 'dest_amount', v_tr.dest_amount,
    'source_currency', v_tr.source_currency, 'dest_currency', v_tr.dest_currency,
    'journal_entry_id', v_entry_id
  ), v_tr.branch_id);

  return v_tr;
end;
$$;

-- -----------------------------------------------------------------------------
-- Tek çağrıyla virman oluştur + muhasebeleştir (register_payment deseni)
-- -----------------------------------------------------------------------------
-- Banka bacağı verilirse ilgili GL hesabı ve para birimi banka hesabından
-- türetilir; kasa bacağında GL hesabı doğrudan verilir.
create or replace function finance.create_transfer(
  p_source_account_id      uuid,
  p_dest_account_id        uuid,
  p_amount                 numeric,
  p_date                   date default null,
  p_source_bank_account_id uuid default null,
  p_dest_bank_account_id   uuid default null,
  p_reference              text default null,
  p_description            text default null,
  p_notes                  text default null,
  p_branch_id              uuid default null
)
returns finance.transfers
language plpgsql
security invoker
as $$
declare
  v_tenant   uuid := core.current_tenant_id();
  v_base     char(3);
  v_src_acct uuid := p_source_account_id;
  v_dst_acct uuid := p_dest_account_id;
  v_src_ccy  char(3);
  v_dst_ccy  char(3);
  v_tr       finance.transfers;
  r          record;
begin
  if not core.has_perm('finance.transfer.create') then
    raise exception 'Virman oluşturma yetkiniz yok' using errcode = '42501';
  end if;
  if v_tenant is null then
    raise exception 'Aktif kiracı bulunamadı' using errcode = '42501';
  end if;
  if p_amount is null or p_amount <= 0 then
    raise exception 'Virman tutarı sıfırdan büyük olmalı' using errcode = '23514';
  end if;

  select currency into v_base from core.tenants where id = v_tenant;

  -- Kaynak bacağı
  if p_source_bank_account_id is not null then
    select account_id, currency into v_src_acct, v_src_ccy
    from finance.bank_accounts
    where id = p_source_bank_account_id and tenant_id = v_tenant and is_active;
    if not found then
      raise exception 'Kaynak banka hesabı bulunamadı ya da pasif' using errcode = '23514';
    end if;
    if v_src_acct is null then
      raise exception 'Kaynak banka hesabının muhasebe hesabı tanımlı değil' using errcode = '22023';
    end if;
  else
    if v_src_acct is null then
      raise exception 'Kaynak hesap zorunlu' using errcode = '23514';
    end if;
    select coalesce(currency, v_base) into v_src_ccy from finance.accounts where id = v_src_acct;
  end if;

  -- Hedef bacağı
  if p_dest_bank_account_id is not null then
    select account_id, currency into v_dst_acct, v_dst_ccy
    from finance.bank_accounts
    where id = p_dest_bank_account_id and tenant_id = v_tenant and is_active;
    if not found then
      raise exception 'Hedef banka hesabı bulunamadı ya da pasif' using errcode = '23514';
    end if;
    if v_dst_acct is null then
      raise exception 'Hedef banka hesabının muhasebe hesabı tanımlı değil' using errcode = '22023';
    end if;
  else
    if v_dst_acct is null then
      raise exception 'Hedef hesap zorunlu' using errcode = '23514';
    end if;
    select coalesce(currency, v_base) into v_dst_ccy from finance.accounts where id = v_dst_acct;
  end if;

  if v_src_acct = v_dst_acct
     and coalesce(p_source_bank_account_id, '00000000-0000-0000-0000-000000000000'::uuid)
       = coalesce(p_dest_bank_account_id, '00000000-0000-0000-0000-000000000000'::uuid) then
    raise exception 'Kaynak ve hedef hesap aynı olamaz' using errcode = '23514';
  end if;

  if v_src_ccy <> v_dst_ccy then
    raise exception 'Farklı para birimli virman için kur ve hedef tutar gerekir (kaynak %, hedef %); çok para birimli virman ayrı bir adımda desteklenir',
      v_src_ccy, v_dst_ccy using errcode = '23514';
  end if;

  -- Yaprak ve aktif hesap kontrolü (post_entry de kontrol eder; erken ve
  -- anlaşılır hata için burada da bakıyoruz)
  for r in
    select a.code, a.is_leaf, a.is_active
    from finance.accounts a
    where a.id in (v_src_acct, v_dst_acct)
  loop
    if not r.is_leaf or not r.is_active then
      raise exception '% hesabına kayıt atılamaz (grup ya da pasif hesap)', r.code
        using errcode = '23514';
    end if;
  end loop;

  insert into finance.transfers (
    tenant_id, branch_id, transfer_date,
    source_account_id, source_bank_account_id, dest_account_id, dest_bank_account_id,
    source_currency, dest_currency, source_amount, dest_amount, exchange_rate,
    reference, description, notes
  ) values (
    v_tenant, p_branch_id, coalesce(p_date, current_date),
    v_src_acct, p_source_bank_account_id, v_dst_acct, p_dest_bank_account_id,
    v_src_ccy, v_dst_ccy, round(p_amount, 2), round(p_amount, 2), 1,
    p_reference, p_description, p_notes
  ) returning * into v_tr;

  return finance.post_transfer(v_tr.id);
end;
$$;

-- -----------------------------------------------------------------------------
-- İptal — ters yevmiye kaydı, belge silinmez
-- -----------------------------------------------------------------------------
create or replace function finance.cancel_transfer(p_id uuid, p_reason text default null)
returns finance.transfers
language plpgsql
security invoker
as $$
declare
  v_tr finance.transfers;
begin
  if not core.has_perm('finance.transfer.post') then
    raise exception 'Virman iptal yetkiniz yok' using errcode = '42501';
  end if;

  select * into v_tr from finance.transfers where id = p_id for update;
  if not found then raise exception 'Virman bulunamadı' using errcode = 'P0002'; end if;
  if v_tr.status <> 'posted' then
    raise exception 'Yalnızca muhasebeleşmiş virman iptal edilebilir (durum: %)', v_tr.status
      using errcode = '23514';
  end if;

  -- Yevmiye kaydının tersini al: bakiye etkisi nötrlenir, satır düşmez.
  if v_tr.journal_entry_id is not null then
    perform finance.reverse_entry(v_tr.journal_entry_id, current_date,
      coalesce(p_reason, 'Virman iptali'));
  end if;

  update finance.transfers
     set status = 'cancelled', cancelled_at = now(),
         cancel_reason = coalesce(p_reason, 'Virman iptali')
   where id = p_id
   returning * into v_tr;

  perform core.emit_event('finance.transfer.cancelled', jsonb_build_object(
    'transfer_id', v_tr.id, 'number', v_tr.number, 'reason', v_tr.cancel_reason
  ), v_tr.branch_id);

  return v_tr;
end;
$$;

select core.declare_event('finance.transfer.posted',    'finance', 'Virman muhasebeleşti');
select core.declare_event('finance.transfer.cancelled', 'finance', 'Virman iptal edildi');

select core.apply_grants();
