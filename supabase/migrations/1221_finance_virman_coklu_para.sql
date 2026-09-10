-- =============================================================================
-- 1221 — Çok para birimli virman — T-036 / FAZ 5 adım 2
--
-- Şartname madde 22: "Farklı para birimli hesaplar arası virman. Kur işlem
-- anında sabitlenir; kaynak tutar ve hedef tutar ayrı kolonlarda tutulur.
-- Kur alanı zorunludur."
--
-- 1220 tabloyu (source_amount / dest_amount / exchange_rate ayrı kolonlar) ve
-- tek para birimli akışı kurdu. Bu dosya YALNIZCA fonksiyonları değiştirir;
-- tablo şeması dokunulmaz (ALTER yok).
--
-- KUR TANIMI: exchange_rate = 1 birim KAYNAK para biriminin kaç birim HEDEF
-- para birimi ettiği (1 USD = 40 TRY ise, USD->TRY virmanında exchange_rate = 40).
-- İşlem anında sabitlenir ve belgede saklanır; sonradan kur değişse de bu
-- belgenin kaydı değişmez (muhasebe kaydı değiştirilemez ilkesi).
--
-- TUTAR TUTARLILIĞI: round(source_amount * exchange_rate, 2) = dest_amount
-- olmak zorunda. Böylece virman anında kambiyo kâr/zararı doğmaz (frozen rate
-- iki tutarı denk tanımlar); banka masrafı gibi farklar ayrı bir gider
-- kaydıyla işlenir, virmanın içine gömülmez.
--
-- YEVMİYE KAYDI: bir bacak ana para birimi (core.tenants.currency) olmak
-- zorundadır — kayıt o bacağın tutarıyla, ana para biriminde, dengeli atılır.
-- İki bacak da yabancı para ise reddedilir (kullanıcı ana para birimi hesabı
-- üzerinden iki virman yapar); bu, harici kur kaynağına bağımlılığı önler.
-- =============================================================================
set client_min_messages = warning;

-- -----------------------------------------------------------------------------
-- Muhasebeleştirme — tek VE çok para birimli
-- -----------------------------------------------------------------------------
create or replace function finance.post_transfer(p_id uuid)
returns finance.transfers
language plpgsql
security invoker
as $$
declare
  v_tr        finance.transfers;
  v_entry_id  uuid;
  v_journal   uuid;
  v_jkind     text;
  v_src_bank  boolean;
  v_dst_bank  boolean;
  v_desc      text;
  v_base      char(3);
  v_multi     boolean;
  v_entry_ccy char(3);
  v_amount    numeric(18,2);   -- yevmiye kaydına yazılan tutar
begin
  if not core.has_perm('finance.transfer.post') then
    raise exception 'Virman muhasebeleştirme yetkiniz yok' using errcode = '42501';
  end if;

  select * into v_tr from finance.transfers where id = p_id for update;
  if not found then raise exception 'Virman bulunamadı' using errcode = 'P0002'; end if;
  if v_tr.status <> 'draft' then
    raise exception 'Bu virman zaten işlenmiş (durum: %)', v_tr.status;
  end if;

  v_multi := v_tr.source_currency <> v_tr.dest_currency;

  if not v_multi then
    if v_tr.source_amount <> v_tr.dest_amount then
      raise exception 'Tek para birimli virmanda kaynak ve hedef tutar eşit olmalı'
        using errcode = '23514';
    end if;
    v_entry_ccy := v_tr.source_currency;
    v_amount    := v_tr.source_amount;
  else
    if v_tr.exchange_rate is null or v_tr.exchange_rate <= 0 then
      raise exception 'Çok para birimli virmanda kur zorunludur' using errcode = '23514';
    end if;
    if abs(round(v_tr.source_amount * v_tr.exchange_rate, 2) - v_tr.dest_amount) > 0.01 then
      raise exception 'Hedef tutar kur ile tutarlı değil: % x % = %, girilen %',
        v_tr.source_amount, v_tr.exchange_rate,
        round(v_tr.source_amount * v_tr.exchange_rate, 2), v_tr.dest_amount
        using errcode = '23514';
    end if;

    select currency into v_base from core.tenants where id = v_tr.tenant_id;
    if v_tr.source_currency = v_base then
      v_entry_ccy := v_base;  v_amount := v_tr.source_amount;
    elsif v_tr.dest_currency = v_base then
      v_entry_ccy := v_base;  v_amount := v_tr.dest_amount;
    else
      raise exception 'Her iki bacak da yabancı para birimli (% / %); virmanı ana para birimi (%) hesabı üzerinden yapın',
        v_tr.source_currency, v_tr.dest_currency, v_base using errcode = '23514';
    end if;
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
       || case when v_multi
               then ' (' || v_tr.source_amount || ' ' || v_tr.source_currency
                    || ' -> ' || v_tr.dest_amount || ' ' || v_tr.dest_currency
                    || ', kur ' || v_tr.exchange_rate || ')'
               else '' end
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
    v_entry_ccy, coalesce(v_tr.exchange_rate, 1),
    'finance', 'transfers', v_tr.id, v_tr.owner_id
  ) returning id into v_entry_id;

  insert into finance.journal_entry_lines
    (tenant_id, entry_id, sequence, account_id, description, debit)
  values (v_tr.tenant_id, v_entry_id, 10, v_tr.dest_account_id, 'Virman girişi', v_amount);

  insert into finance.journal_entry_lines
    (tenant_id, entry_id, sequence, account_id, description, credit)
  values (v_tr.tenant_id, v_entry_id, 20, v_tr.source_account_id, 'Virman çıkışı', v_amount);

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
    'exchange_rate', v_tr.exchange_rate, 'multi_currency', v_multi,
    'journal_entry_id', v_entry_id
  ), v_tr.branch_id);

  return v_tr;
end;
$$;

-- -----------------------------------------------------------------------------
-- Tek çağrıyla virman oluştur + muhasebeleştir (çok para birimi destekli)
-- -----------------------------------------------------------------------------
create or replace function finance.create_transfer(
  p_source_account_id      uuid,
  p_dest_account_id        uuid,
  p_amount                 numeric,           -- kaynak tutar (kaynak para biriminde)
  p_date                   date default null,
  p_source_bank_account_id uuid default null,
  p_dest_bank_account_id   uuid default null,
  p_reference              text default null,
  p_description            text default null,
  p_notes                  text default null,
  p_branch_id              uuid default null,
  p_dest_amount            numeric default null,   -- hedef tutar (hedef para biriminde)
  p_exchange_rate          numeric default null    -- 1 kaynak birimi = ? hedef birimi
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
  v_multi    boolean;
  v_dest_amt numeric(18,2);
  v_rate     numeric(18,6);
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

  v_multi := v_src_ccy <> v_dst_ccy;

  if not v_multi then
    -- Tek para birimli: kur 1, tutarlar eşit. p_dest_amount / p_exchange_rate
    -- verilmişse ve çelişiyorsa uyar.
    if p_exchange_rate is not null and p_exchange_rate <> 1 then
      raise exception 'Tek para birimli virmanda kur 1 olmalıdır' using errcode = '23514';
    end if;
    if p_dest_amount is not null and round(p_dest_amount, 2) <> round(p_amount, 2) then
      raise exception 'Tek para birimli virmanda kaynak ve hedef tutar eşit olmalı'
        using errcode = '23514';
    end if;
    v_rate     := 1;
    v_dest_amt := round(p_amount, 2);
  else
    if p_exchange_rate is null or p_exchange_rate <= 0 then
      raise exception 'Farklı para birimli virmanda kur zorunludur (1 % = ? %)',
        v_src_ccy, v_dst_ccy using errcode = '23514';
    end if;
    if v_src_ccy <> v_base and v_dst_ccy <> v_base then
      raise exception 'Her iki bacak da yabancı para birimli (% / %); virmanı ana para birimi (%) hesabı üzerinden yapın',
        v_src_ccy, v_dst_ccy, v_base using errcode = '23514';
    end if;
    v_rate     := round(p_exchange_rate, 6);
    v_dest_amt := coalesce(round(p_dest_amount, 2), round(p_amount * v_rate, 2));
    if abs(round(p_amount * v_rate, 2) - v_dest_amt) > 0.01 then
      raise exception 'Hedef tutar kur ile tutarlı değil: % x % = %, girilen %',
        round(p_amount, 2), v_rate, round(p_amount * v_rate, 2), v_dest_amt
        using errcode = '23514';
    end if;
  end if;

  -- Yaprak ve aktif hesap kontrolü
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
    v_src_ccy, v_dst_ccy, round(p_amount, 2), v_dest_amt, v_rate,
    p_reference, p_description, p_notes
  ) returning * into v_tr;

  return finance.post_transfer(v_tr.id);
end;
$$;
