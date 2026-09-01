-- =============================================================================
-- 0201 — Muhasebe iş mantığı
-- =============================================================================

-- -----------------------------------------------------------------------------
-- Hesap eşlemeleri
-- -----------------------------------------------------------------------------
-- Otomatik kayıtların hangi hesabı kullanacağı koda gömülmez: kiracı kendi
-- hesap planını özelleştirebilmelidir (Bölüm 4.2). Kod yalnızca ANLAMI bilir
-- ('receivable'), hesabı kiracı belirler.
create table if not exists finance.account_mappings (
  tenant_id   uuid not null references core.tenants(id) on delete cascade,
  key         text not null,
  account_id  uuid not null references finance.accounts(id),
  updated_at  timestamptz not null default now(),
  primary key (tenant_id, key)
);

create or replace function finance.mapped_account(p_key text, p_tenant uuid default null)
returns uuid
language plpgsql
stable
security definer
set search_path = finance, core, pg_temp
as $$
declare v_id uuid;
begin
  select account_id into v_id
  from finance.account_mappings
  where tenant_id = coalesce(p_tenant, core.current_tenant_id()) and key = p_key;
  if v_id is null then
    raise exception 'Hesap eşlemesi tanımsız: "%". Muhasebe ayarlarından hesabı seçin.', p_key
      using errcode = '22023';
  end if;
  return v_id;
end;
$$;

-- -----------------------------------------------------------------------------
-- Mali dönem çözümleme
-- -----------------------------------------------------------------------------
create or replace function finance.period_for(p_date date, p_tenant uuid default null)
returns finance.fiscal_periods
language plpgsql
security definer
set search_path = finance, core, pg_temp
as $$
declare
  v_tenant uuid := coalesce(p_tenant, core.current_tenant_id());
  v_period finance.fiscal_periods;
  v_year   finance.fiscal_years;
begin
  select * into v_period from finance.fiscal_periods
   where tenant_id = v_tenant and p_date between date_from and date_to;
  if found then return v_period; end if;

  -- Dönem yoksa yılı ve ayı yerinde oluştur: kullanıcı her yıl başında elle
  -- dönem açmak zorunda kalmasın, ama kapalı dönem kontrolü yine işlesin.
  select * into v_year from finance.fiscal_years
   where tenant_id = v_tenant and p_date between date_from and date_to;
  if not found then
    insert into finance.fiscal_years (tenant_id, name, date_from, date_to)
    values (v_tenant, to_char(p_date, 'YYYY'),
            date_trunc('year', p_date)::date,
            (date_trunc('year', p_date) + interval '1 year - 1 day')::date)
    returning * into v_year;
  end if;

  insert into finance.fiscal_periods (tenant_id, fiscal_year_id, name, date_from, date_to)
  values (v_tenant, v_year.id, to_char(p_date, 'YYYY-MM'),
          date_trunc('month', p_date)::date,
          (date_trunc('month', p_date) + interval '1 month - 1 day')::date)
  returning * into v_period;

  return v_period;
end;
$$;

-- -----------------------------------------------------------------------------
-- Yevmiye başlığı toplamları
-- -----------------------------------------------------------------------------
create or replace function finance.fn_recalc_entry_totals()
returns trigger
language plpgsql
as $$
declare v_entry uuid;
begin
  v_entry := coalesce(new.entry_id, old.entry_id);
  update finance.journal_entries e
     set total_debit  = coalesce(s.d, 0),
         total_credit = coalesce(s.c, 0),
         updated_at   = now()
    from (select sum(debit) d, sum(credit) c
          from finance.journal_entry_lines where entry_id = v_entry) s
   where e.id = v_entry;
  return null;
end;
$$;

drop trigger if exists trg_jel_totals on finance.journal_entry_lines;
create trigger trg_jel_totals after insert or update or delete on finance.journal_entry_lines
  for each row execute function finance.fn_recalc_entry_totals();

-- -----------------------------------------------------------------------------
-- Muhasebeleşmiş kayıt değiştirilemez
-- -----------------------------------------------------------------------------
create or replace function finance.fn_lock_posted_entry()
returns trigger
language plpgsql
as $$
declare
  v_status finance.entry_status;
  v_id     uuid;
begin
  if tg_table_name = 'journal_entries' then
    if tg_op = 'DELETE' then
      if old.status <> 'draft' then
        raise exception 'Muhasebeleşmiş yevmiye kaydı silinemez; ters kayıt kullanın'
          using errcode = '23514';
      end if;
      return old;
    end if;
    -- posted -> reversed ve draft -> posted geçişleri serbest; içerik değişimi değil
    if old.status = 'posted' and new.status = 'posted'
       and (new.entry_date, new.journal_id, new.branch_id, new.description, new.reference)
        is distinct from (old.entry_date, old.journal_id, old.branch_id, old.description, old.reference) then
      raise exception 'Muhasebeleşmiş yevmiye kaydının içeriği değiştirilemez'
        using errcode = '23514';
    end if;
    if old.status = 'reversed' and new.status <> 'reversed' then
      raise exception 'Ters kaydı alınmış fiş yeniden açılamaz' using errcode = '23514';
    end if;
    return new;
  end if;

  -- journal_entry_lines
  v_id := coalesce(new.entry_id, old.entry_id);
  select status into v_status from finance.journal_entries where id = v_id;
  if v_status is distinct from 'draft' then
    raise exception 'Muhasebeleşmiş yevmiye kaydının satırları değiştirilemez'
      using errcode = '23514';
  end if;
  return case when tg_op = 'DELETE' then old else new end;
end;
$$;

drop trigger if exists trg_je_lock on finance.journal_entries;
create trigger trg_je_lock before update or delete on finance.journal_entries
  for each row execute function finance.fn_lock_posted_entry();

drop trigger if exists trg_jel_lock on finance.journal_entry_lines;
create trigger trg_jel_lock before insert or update or delete on finance.journal_entry_lines
  for each row execute function finance.fn_lock_posted_entry();

-- -----------------------------------------------------------------------------
-- Bakiye tablosunun bakımı
-- -----------------------------------------------------------------------------
create or replace function finance.apply_entry_to_balances(p_entry_id uuid, p_sign smallint)
returns void
language plpgsql
security definer
set search_path = finance, core, pg_temp
as $$
begin
  insert into finance.account_balances as b
    (tenant_id, branch_id, account_id, period_start, debit_total, credit_total)
  select e.tenant_id, e.branch_id, l.account_id,
         date_trunc('month', e.entry_date)::date,
         p_sign * sum(l.debit), p_sign * sum(l.credit)
  from finance.journal_entry_lines l
  join finance.journal_entries e on e.id = l.entry_id
  where l.entry_id = p_entry_id
  group by e.tenant_id, e.branch_id, l.account_id, date_trunc('month', e.entry_date)
  on conflict (tenant_id, account_id, period_start,
               coalesce(branch_id, '00000000-0000-0000-0000-000000000000'::uuid))
  do update set debit_total  = b.debit_total  + excluded.debit_total,
                credit_total = b.credit_total + excluded.credit_total,
                updated_at   = now();
end;
$$;

-- -----------------------------------------------------------------------------
-- Muhasebeleştirme
-- -----------------------------------------------------------------------------
create or replace function finance.post_entry(p_id uuid)
returns finance.journal_entries
language plpgsql
security invoker
as $$
declare
  v_entry  finance.journal_entries;
  v_period finance.fiscal_periods;
  v_bad    text;
begin
  if not core.has_perm('finance.entry.post') then
    raise exception 'Muhasebeleştirme yetkiniz yok' using errcode = '42501';
  end if;

  select * into v_entry from finance.journal_entries where id = p_id for update;
  if not found then raise exception 'Yevmiye kaydı bulunamadı' using errcode = 'P0002'; end if;
  if v_entry.status <> 'draft' then
    raise exception 'Yalnızca taslak kayıtlar muhasebeleştirilebilir (mevcut: %)', v_entry.status;
  end if;
  if not exists (select 1 from finance.journal_entry_lines where entry_id = p_id) then
    raise exception 'Satırı olmayan kayıt muhasebeleştirilemez';
  end if;
  if v_entry.total_debit <> v_entry.total_credit then
    raise exception 'Borç (%) ve alacak (%) eşit değil — kayıt dengeli olmalı',
      v_entry.total_debit, v_entry.total_credit using errcode = '23514';
  end if;
  if v_entry.total_debit = 0 then
    raise exception 'Sıfır tutarlı kayıt muhasebeleştirilemez';
  end if;

  -- Yalnızca yaprak ve aktif hesaplara kayıt atılabilir
  select string_agg(a.code, ', ') into v_bad
  from finance.journal_entry_lines l
  join finance.accounts a on a.id = l.account_id
  where l.entry_id = p_id and (not a.is_leaf or not a.is_active);
  if v_bad is not null then
    raise exception 'Kayıt atılamayan hesap(lar): % (grup ya da pasif hesap)', v_bad
      using errcode = '23514';
  end if;

  -- Cari zorunlu hesaplarda partner boş olamaz
  select string_agg(a.code, ', ') into v_bad
  from finance.journal_entry_lines l
  join finance.accounts a on a.id = l.account_id
  where l.entry_id = p_id and a.requires_partner and l.partner_id is null;
  if v_bad is not null then
    raise exception '% hesabı cari bilgisi olmadan kullanılamaz', v_bad using errcode = '23514';
  end if;

  v_period := finance.period_for(v_entry.entry_date, v_entry.tenant_id);
  if v_period.is_closed then
    raise exception 'Kapalı döneme (%) kayıt atılamaz', v_period.name using errcode = '23514';
  end if;

  update finance.journal_entries
     set status = 'posted', posted_at = now(), posted_by = core.current_user_id(),
         period_id = v_period.id,
         number = coalesce(number, core.next_sequence('finance_journal', branch_id))
   where id = p_id
   returning * into v_entry;

  perform finance.apply_entry_to_balances(p_id, 1::smallint);

  perform core.emit_event('finance.entry.posted', jsonb_build_object(
    'entry_id', v_entry.id, 'number', v_entry.number, 'entry_date', v_entry.entry_date,
    'total', v_entry.total_debit, 'source_module', v_entry.source_module,
    'source_id', v_entry.source_id
  ), v_entry.branch_id);

  return v_entry;
end;
$$;

-- Ters kayıt — düzeltmenin TEK yolu
create or replace function finance.reverse_entry(
  p_id uuid, p_date date default null, p_reason text default null
)
returns finance.journal_entries
language plpgsql
security invoker
as $$
declare
  v_orig    finance.journal_entries;
  v_new_id  uuid;
  v_result  finance.journal_entries;
begin
  if not core.has_perm('finance.entry.post') then
    raise exception 'Ters kayıt yetkiniz yok' using errcode = '42501';
  end if;

  select * into v_orig from finance.journal_entries where id = p_id for update;
  if not found then raise exception 'Yevmiye kaydı bulunamadı' using errcode = 'P0002'; end if;
  if v_orig.status <> 'posted' then
    raise exception 'Yalnızca muhasebeleşmiş kayıtların tersi alınabilir';
  end if;

  insert into finance.journal_entries (
    tenant_id, branch_id, journal_id, entry_date, reference, description,
    currency, exchange_rate, source_module, source_table, source_id, reversal_of_id, owner_id
  ) values (
    v_orig.tenant_id, v_orig.branch_id, v_orig.journal_id,
    coalesce(p_date, current_date),
    v_orig.number,
    'TERS KAYIT: ' || coalesce(v_orig.description, '') ||
      case when p_reason is null then '' else ' — ' || p_reason end,
    v_orig.currency, v_orig.exchange_rate,
    v_orig.source_module, v_orig.source_table, v_orig.source_id, v_orig.id, v_orig.owner_id
  ) returning id into v_new_id;

  -- Borç/alacak yer değiştirir
  insert into finance.journal_entry_lines
    (tenant_id, entry_id, sequence, account_id, partner_id, description, debit, credit, tax_id, tax_base)
  select l.tenant_id, v_new_id, l.sequence, l.account_id, l.partner_id, l.description,
         l.credit, l.debit, l.tax_id, -l.tax_base
  from finance.journal_entry_lines l where l.entry_id = p_id;

  v_result := finance.post_entry(v_new_id);

  -- Orijinal kaydın bakiye etkisi SİLİNMEZ; ters kayıt onu nötrler. Defterden
  -- satır düşürmek mali mevzuata aykırı olurdu.
  update finance.journal_entries set status = 'reversed' where id = p_id;

  return v_result;
end;
$$;

-- =============================================================================
-- Faturalar
-- =============================================================================
select core.attach_document_line_math('finance', 'invoice_lines', 'finance.invoices', 'invoice_id');

-- Fatura satırı değişince başlık toplamı yeniden hesaplanır (core yardımcısı),
-- ancak fatura muhasebeleştikten sonra satır değişemez.
create or replace function finance.fn_lock_posted_invoice()
returns trigger
language plpgsql
as $$
declare v_status finance.invoice_status;
begin
  select status into v_status from finance.invoices
   where id = coalesce(new.invoice_id, old.invoice_id);
  if v_status not in ('draft', 'approved') then
    raise exception 'Muhasebeleşmiş faturanın satırları değiştirilemez (durum: %)', v_status
      using errcode = '23514';
  end if;
  return case when tg_op = 'DELETE' then old else new end;
end;
$$;

drop trigger if exists trg_invoice_lines_lock on finance.invoice_lines;
create trigger trg_invoice_lines_lock before insert or update or delete on finance.invoice_lines
  for each row execute function finance.fn_lock_posted_invoice();

/*
 * Faturayı muhasebeleştir.
 *
 * SATIŞ FATURASI                         Borç        Alacak
 *   120 ALICILAR                 tutar+KDV−tevkifat
 *   600 YURTİÇİ SATIŞLAR                             matrah
 *   391 HESAPLANAN KDV                               KDV−tevkifat
 *
 * ALIŞ FATURASI                          Borç        Alacak
 *   153/770/… (satır hesabı)          matrah
 *   191 İNDİRİLECEK KDV                  KDV
 *   320 SATICILAR                                    tutar+KDV−tevkifat
 *   360 ÖDENECEK VERGİ VE FONLAR                     tevkifat
 *
 * Tevkifatta satıcı KDV'nin tevkif edilen kısmını tahsil etmez; alıcı o kısmı
 * doğrudan vergi dairesine öder. Kayıt bu ekonomik gerçeği yansıtır.
 */
create or replace function finance.post_invoice(p_id uuid)
returns finance.invoices
language plpgsql
security invoker
as $$
declare
  v_inv      finance.invoices;
  v_entry_id uuid;
  v_journal  uuid;
  v_seq      smallint := 10;
  r          record;
begin
  if not core.has_perm('finance.invoice.post') then
    raise exception 'Fatura muhasebeleştirme yetkiniz yok' using errcode = '42501';
  end if;

  select * into v_inv from finance.invoices where id = p_id for update;
  if not found then raise exception 'Fatura bulunamadı' using errcode = 'P0002'; end if;
  if v_inv.status not in ('draft', 'approved') then
    raise exception 'Bu fatura zaten muhasebeleşmiş (durum: %)', v_inv.status;
  end if;
  if not exists (select 1 from finance.invoice_lines where invoice_id = p_id) then
    raise exception 'Satırı olmayan fatura muhasebeleştirilemez';
  end if;

  select id into v_journal from finance.journals
   where tenant_id = v_inv.tenant_id
     and kind = case when v_inv.kind = 'sale' then 'sale' else 'purchase' end
   limit 1;
  if v_journal is null then
    raise exception 'Fatura yevmiyesi tanımlı değil' using errcode = '22023';
  end if;

  insert into finance.journal_entries (
    tenant_id, branch_id, journal_id, entry_date, reference, description,
    currency, exchange_rate, source_module, source_table, source_id, owner_id
  ) values (
    v_inv.tenant_id, v_inv.branch_id, v_journal, v_inv.issue_date,
    v_inv.number,
    case when v_inv.kind = 'sale' then 'Satış faturası' else 'Alış faturası' end
      || coalesce(' ' || v_inv.number, ''),
    v_inv.currency, v_inv.exchange_rate, 'finance', 'invoices', v_inv.id, v_inv.owner_id
  ) returning id into v_entry_id;

  if v_inv.kind = 'sale' then
    -- 120 ALICILAR (borç)
    insert into finance.journal_entry_lines
      (tenant_id, entry_id, sequence, account_id, partner_id, description, debit)
    values (v_inv.tenant_id, v_entry_id, v_seq,
            finance.mapped_account('receivable', v_inv.tenant_id), v_inv.partner_id,
            'Fatura tahsilatı', v_inv.total);
    v_seq := v_seq + 10;

    -- 600 gelir hesapları (alacak) — satır bazında, hesap satırdan ya da eşlemeden
    for r in
      select coalesce(l.account_id, finance.mapped_account('sales_income', v_inv.tenant_id)) as account_id,
             sum(l.line_subtotal) as amount
      from finance.invoice_lines l where l.invoice_id = p_id
      group by 1
    loop
      insert into finance.journal_entry_lines
        (tenant_id, entry_id, sequence, account_id, description, credit)
      values (v_inv.tenant_id, v_entry_id, v_seq, r.account_id, 'Satış geliri', r.amount);
      v_seq := v_seq + 10;
    end loop;

    -- 391 HESAPLANAN KDV (alacak) — tevkif edilen kısım hariç
    if v_inv.tax_total - v_inv.withholding_total > 0 then
      insert into finance.journal_entry_lines
        (tenant_id, entry_id, sequence, account_id, description, credit, tax_base)
      values (v_inv.tenant_id, v_entry_id, v_seq,
              finance.mapped_account('vat_output', v_inv.tenant_id),
              'Hesaplanan KDV', v_inv.tax_total - v_inv.withholding_total, v_inv.subtotal);
    end if;

  else
    -- Gider/stok hesapları (borç)
    for r in
      select coalesce(l.account_id, finance.mapped_account('purchase_expense', v_inv.tenant_id)) as account_id,
             sum(l.line_subtotal) as amount
      from finance.invoice_lines l where l.invoice_id = p_id
      group by 1
    loop
      insert into finance.journal_entry_lines
        (tenant_id, entry_id, sequence, account_id, description, debit)
      values (v_inv.tenant_id, v_entry_id, v_seq, r.account_id, 'Alış', r.amount);
      v_seq := v_seq + 10;
    end loop;

    -- 191 İNDİRİLECEK KDV (borç) — tevkifatlı kısım dâhil tamamı indirilir
    if v_inv.tax_total > 0 then
      insert into finance.journal_entry_lines
        (tenant_id, entry_id, sequence, account_id, description, debit, tax_base)
      values (v_inv.tenant_id, v_entry_id, v_seq,
              finance.mapped_account('vat_input', v_inv.tenant_id),
              'İndirilecek KDV', v_inv.tax_total, v_inv.subtotal);
      v_seq := v_seq + 10;
    end if;

    -- 320 SATICILAR (alacak)
    insert into finance.journal_entry_lines
      (tenant_id, entry_id, sequence, account_id, partner_id, description, credit)
    values (v_inv.tenant_id, v_entry_id, v_seq,
            finance.mapped_account('payable', v_inv.tenant_id), v_inv.partner_id,
            'Satıcı borcu', v_inv.total);
    v_seq := v_seq + 10;

    -- 360 ÖDENECEK VERGİ VE FONLAR (alacak) — tevkif edilen KDV
    if v_inv.withholding_total > 0 then
      insert into finance.journal_entry_lines
        (tenant_id, entry_id, sequence, account_id, description, credit)
      values (v_inv.tenant_id, v_entry_id, v_seq,
              finance.mapped_account('vat_withholding_payable', v_inv.tenant_id),
              'KDV tevkifatı', v_inv.withholding_total);
    end if;
  end if;

  perform finance.post_entry(v_entry_id);

  update finance.invoices
     set status = 'posted',
         journal_entry_id = v_entry_id,
         number = coalesce(number, core.next_sequence(
                    case when kind = 'sale' then 'finance_sale_invoice'
                         else 'finance_purchase_invoice' end, branch_id)),
         due_date = coalesce(due_date, issue_date + payment_term_days)
   where id = p_id
   returning * into v_inv;

  perform core.emit_event('finance.invoice.posted', jsonb_build_object(
    'invoice_id', v_inv.id, 'kind', v_inv.kind, 'number', v_inv.number,
    'partner_id', v_inv.partner_id, 'total', v_inv.total,
    'tax_total', v_inv.tax_total, 'due_date', v_inv.due_date,
    'journal_entry_id', v_entry_id
  ), v_inv.branch_id);

  return v_inv;
end;
$$;

-- =============================================================================
-- Tahsilat / ödeme
-- =============================================================================
-- Tahsilat mahsup edildikçe faturanın ödenen tutarı ve durumu güncellenir.
create or replace function finance.fn_sync_invoice_payment()
returns trigger
language plpgsql
security definer
set search_path = finance, core, pg_temp
as $$
declare
  v_invoice uuid := coalesce(new.invoice_id, old.invoice_id);
  v_payment uuid := coalesce(new.payment_id, old.payment_id);
begin
  update finance.invoices i
     set paid_total = coalesce(s.paid, 0),
         status = case
           when i.status in ('draft', 'approved', 'cancelled') then i.status
           when coalesce(s.paid, 0) >= i.total then 'paid'::finance.invoice_status
           when coalesce(s.paid, 0) > 0 then 'partially_paid'::finance.invoice_status
           else 'posted'::finance.invoice_status
         end,
         updated_at = now()
    from (select sum(a.amount) paid
          from finance.payment_allocations a
          join finance.payments p on p.id = a.payment_id and p.status = 'posted'
          where a.invoice_id = v_invoice) s
   where i.id = v_invoice;

  update finance.payments p
     set allocated_total = coalesce(
           (select sum(amount) from finance.payment_allocations where payment_id = v_payment), 0),
         updated_at = now()
   where p.id = v_payment;

  return null;
end;
$$;

drop trigger if exists trg_payment_alloc_sync on finance.payment_allocations;
create trigger trg_payment_alloc_sync
  after insert or update or delete on finance.payment_allocations
  for each row execute function finance.fn_sync_invoice_payment();

/*
 * Tahsilat/ödemeyi muhasebeleştir.
 *   Tahsilat (in):  100/102 (borç)   /  120 ALICILAR (alacak)
 *   Ödeme   (out):  320 SATICILAR (borç) / 100/102 (alacak)
 */
create or replace function finance.post_payment(p_id uuid)
returns finance.payments
language plpgsql
security invoker
as $$
declare
  v_pay      finance.payments;
  v_entry_id uuid;
  v_journal  uuid;
  v_money    uuid;
  v_counter  uuid;
begin
  if not core.has_perm('finance.payment.post') then
    raise exception 'Tahsilat muhasebeleştirme yetkiniz yok' using errcode = '42501';
  end if;

  select * into v_pay from finance.payments where id = p_id for update;
  if not found then raise exception 'Tahsilat bulunamadı' using errcode = 'P0002'; end if;
  if v_pay.status <> 'draft' then
    raise exception 'Bu kayıt zaten muhasebeleşmiş (durum: %)', v_pay.status;
  end if;

  -- Para hesabı: banka hesabı seçilmişse onun GL hesabı, yoksa eşleme
  if v_pay.bank_account_id is not null then
    select coalesce(ba.account_id, finance.mapped_account('bank', v_pay.tenant_id))
      into v_money from finance.bank_accounts ba where ba.id = v_pay.bank_account_id;
  else
    v_money := finance.mapped_account(
      case when v_pay.method = 'cash' then 'cash' else 'bank' end, v_pay.tenant_id);
  end if;

  v_counter := finance.mapped_account(
    case when v_pay.direction = 'in' then 'receivable' else 'payable' end, v_pay.tenant_id);

  select id into v_journal from finance.journals
   where tenant_id = v_pay.tenant_id
     and kind = case when v_pay.method = 'cash' then 'cash' else 'bank' end
   limit 1;
  if v_journal is null then
    select id into v_journal from finance.journals
     where tenant_id = v_pay.tenant_id and kind = 'general' limit 1;
  end if;

  insert into finance.journal_entries (
    tenant_id, branch_id, journal_id, entry_date, reference, description,
    currency, exchange_rate, source_module, source_table, source_id, owner_id
  ) values (
    v_pay.tenant_id, v_pay.branch_id, v_journal, v_pay.payment_date, v_pay.reference,
    case when v_pay.direction = 'in' then 'Tahsilat' else 'Ödeme' end,
    v_pay.currency, v_pay.exchange_rate, 'finance', 'payments', v_pay.id, v_pay.owner_id
  ) returning id into v_entry_id;

  if v_pay.direction = 'in' then
    insert into finance.journal_entry_lines
      (tenant_id, entry_id, sequence, account_id, description, debit)
    values (v_pay.tenant_id, v_entry_id, 10, v_money, 'Tahsilat', v_pay.amount);
    insert into finance.journal_entry_lines
      (tenant_id, entry_id, sequence, account_id, partner_id, description, credit)
    values (v_pay.tenant_id, v_entry_id, 20, v_counter, v_pay.partner_id, 'Cari kapama', v_pay.amount);
  else
    insert into finance.journal_entry_lines
      (tenant_id, entry_id, sequence, account_id, partner_id, description, debit)
    values (v_pay.tenant_id, v_entry_id, 10, v_counter, v_pay.partner_id, 'Cari kapama', v_pay.amount);
    insert into finance.journal_entry_lines
      (tenant_id, entry_id, sequence, account_id, description, credit)
    values (v_pay.tenant_id, v_entry_id, 20, v_money, 'Ödeme', v_pay.amount);
  end if;

  perform finance.post_entry(v_entry_id);

  update finance.payments
     set status = 'posted', journal_entry_id = v_entry_id,
         number = coalesce(number, core.next_sequence('finance_payment', branch_id))
   where id = p_id returning * into v_pay;

  -- Mahsup edilmiş faturaların durumunu tazele
  update finance.payment_allocations set updated_at = now() where payment_id = p_id;

  perform core.emit_event(
    case when v_pay.direction = 'in' then 'finance.payment.received' else 'finance.payment.sent' end,
    jsonb_build_object('payment_id', v_pay.id, 'number', v_pay.number,
                       'partner_id', v_pay.partner_id, 'amount', v_pay.amount,
                       'method', v_pay.method),
    v_pay.branch_id);

  return v_pay;
end;
$$;

-- Faturayı tek çağrıyla tahsil et (kısmi tahsilat destekli)
create or replace function finance.register_payment(
  p_invoice_id uuid,
  p_amount     numeric default null,
  p_date       date default null,
  p_method     text default 'bank',
  p_bank_account_id uuid default null,
  p_reference  text default null
)
returns finance.payments
language plpgsql
security invoker
as $$
declare
  v_inv finance.invoices;
  v_pay finance.payments;
  v_amt numeric;
begin
  select * into v_inv from finance.invoices where id = p_invoice_id for update;
  if not found then raise exception 'Fatura bulunamadı' using errcode = 'P0002'; end if;
  if v_inv.status not in ('posted', 'partially_paid') then
    raise exception 'Yalnızca muhasebeleşmiş faturalar tahsil edilebilir (durum: %)', v_inv.status;
  end if;

  v_amt := coalesce(p_amount, v_inv.total - v_inv.paid_total);
  if v_amt <= 0 then raise exception 'Tahsilat tutarı sıfırdan büyük olmalı'; end if;
  if v_amt > v_inv.total - v_inv.paid_total + 0.005 then
    raise exception 'Tahsilat tutarı kalan bakiyeyi (%) aşamaz', v_inv.total - v_inv.paid_total;
  end if;

  insert into finance.payments (
    tenant_id, branch_id, direction, partner_id, payment_date, method,
    bank_account_id, amount, currency, reference
  ) values (
    v_inv.tenant_id, v_inv.branch_id,
    case when v_inv.kind = 'sale' then 'in' else 'out' end,
    v_inv.partner_id, coalesce(p_date, current_date), p_method,
    p_bank_account_id, v_amt, v_inv.currency, p_reference
  ) returning * into v_pay;

  insert into finance.payment_allocations (tenant_id, payment_id, invoice_id, amount)
  values (v_inv.tenant_id, v_pay.id, v_inv.id, v_amt);

  return finance.post_payment(v_pay.id);
end;
$$;

-- =============================================================================
-- Olay entegrasyonu — CRM'den gelen sipariş faturaya dönüşür
-- =============================================================================
/*
 * Bu fonksiyon Muhasebe modülünün CRM'e bakan TEK yüzeyidir. CRM tablolarına
 * hiç dokunmaz; yalnızca olay yükünü okur. CRM kaldırılsa ya da yerine başka
 * bir satış kaynağı gelse (POS, e-ticaret), aynı olayı yayınladığı sürece bu
 * kod değişmez.
 *
 * İdempotent: aynı sipariş için ikinci kez çağrılırsa yeni fatura üretmez.
 * Olay teslimatı yeniden denenebildiği için bu şart.
 */
create or replace function finance.on_sales_order_confirmed(p_event jsonb)
returns void
language plpgsql
security definer
set search_path = finance, core, pg_temp
as $$
declare
  v_tenant     uuid := (p_event ->> 'tenant_id')::uuid;
  v_branch     uuid := nullif(p_event ->> 'branch_id', '')::uuid;
  v_payload    jsonb := p_event -> 'payload';
  v_order_id   uuid := (v_payload ->> 'sale_order_id')::uuid;
  v_invoice_id uuid;
  v_line       jsonb;
  v_seq        smallint := 10;
  v_income     uuid;
begin
  if exists (
    select 1 from finance.invoices
    where tenant_id = v_tenant and source_module = 'crm'
      and source_table = 'sale_orders' and source_id = v_order_id
  ) then
    return;   -- zaten faturalanmış
  end if;

  select account_id into v_income
  from finance.account_mappings where tenant_id = v_tenant and key = 'sales_income';
  if v_income is null then
    raise exception 'sales_income hesap eşlemesi tanımsız (kiracı %)', v_tenant;
  end if;

  insert into finance.invoices (
    tenant_id, branch_id, kind, partner_id, issue_date, status, currency,
    payment_term_days, source_module, source_table, source_id, notes
  ) values (
    v_tenant, v_branch, 'sale', (v_payload ->> 'partner_id')::uuid,
    coalesce((v_payload ->> 'order_date')::date, current_date), 'draft',
    coalesce(v_payload ->> 'currency', 'TRY'),
    coalesce((v_payload ->> 'payment_term_days')::smallint, 0),
    'crm', 'sale_orders', v_order_id,
    'Sipariş ' || coalesce(v_payload ->> 'number', '') || ' üzerinden otomatik oluşturuldu'
  ) returning id into v_invoice_id;

  for v_line in select * from jsonb_array_elements(v_payload -> 'lines')
  loop
    insert into finance.invoice_lines (
      tenant_id, invoice_id, sequence, product_id, account_id, description,
      quantity, uom_id, unit_price, discount_pct, tax_id
    ) values (
      v_tenant, v_invoice_id, v_seq,
      nullif(v_line ->> 'product_id', '')::uuid, v_income,
      coalesce(v_line ->> 'description', 'Satış'),
      coalesce((v_line ->> 'quantity')::numeric, 1),
      nullif(v_line ->> 'uom_id', '')::uuid,
      coalesce((v_line ->> 'unit_price')::numeric, 0),
      coalesce((v_line ->> 'discount_pct')::numeric, 0),
      nullif(v_line ->> 'tax_id', '')::uuid
    );
    v_seq := v_seq + 10;
  end loop;

  perform core.emit_event('finance.invoice.drafted', jsonb_build_object(
    'invoice_id', v_invoice_id, 'source_module', 'crm', 'source_id', v_order_id
  ), v_branch, null, v_tenant);
end;
$$;

-- Sipariş iptal edilirse, henüz muhasebeleşmemiş taslak fatura da iptal edilir.
create or replace function finance.on_sales_order_cancelled(p_event jsonb)
returns void
language plpgsql
security definer
set search_path = finance, core, pg_temp
as $$
begin
  update finance.invoices
     set status = 'cancelled', updated_at = now()
   where tenant_id = (p_event ->> 'tenant_id')::uuid
     and source_module = 'crm' and source_table = 'sale_orders'
     and source_id = (p_event -> 'payload' ->> 'sale_order_id')::uuid
     and status in ('draft', 'approved');
end;
$$;

select core.declare_event('finance.invoice.drafted', 'finance', 'Fatura taslağı oluşturuldu');
select core.declare_event('finance.invoice.posted',  'finance', 'Fatura muhasebeleşti');
select core.declare_event('finance.entry.posted',    'finance', 'Yevmiye kaydı muhasebeleşti');
select core.declare_event('finance.payment.received','finance', 'Tahsilat yapıldı');
select core.declare_event('finance.payment.sent',    'finance', 'Ödeme yapıldı');

select core.subscribe('sales.order.confirmed', 'finance', 'finance.on_sales_order_confirmed');
select core.subscribe('sales.order.cancelled', 'finance', 'finance.on_sales_order_cancelled');
