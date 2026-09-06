-- =============================================================================
-- 0305 — Bordro → Muhasebe köprüsü
-- =============================================================================
-- DİKKAT: Bu dosyadaki fonksiyonlar FINANCE modülüne aittir, İK'ya değil.
-- Burada bulunmalarının tek sebebi migration sırasıdır: hr.payroll_runs
-- tablosuna referans verdikleri için 0300'lerden sonra çalışmaları gerekir.
-- Bağımlılık yönü doğru: Muhasebe, İK'yı bilir; İK, Muhasebe'yi bilmez.
-- İK modülü tek başına (Muhasebe kapalıyken) sorunsuz çalışır — abonelik
-- fan-out'u kiracıda kapalı modüle teslimat üretmez (core.emit_event).
-- =============================================================================

-- Bordro hesap eşlemeleri. Yalnızca İK açık olan kiracıda kurulur; bu yüzden
-- provisioner'ı 'hr' modülüne bağlı.
create or replace function finance.provision_payroll_accounts(p_tenant_id uuid)
returns void
language plpgsql
security definer
set search_path = finance, core, pg_temp
as $$
begin
  insert into finance.account_mappings (tenant_id, key, account_id)
  select p_tenant_id, m.key, a.id
  from (values
    -- Varsayılan: personel gideri genel yönetim giderine yazılır.
    -- Üretim işletmesi bunu 720'ye çevirebilir.
    ('payroll_expense',  '770'),
    ('payroll_payable',  '335'),
    ('payroll_tax_payable', '360'),
    ('payroll_sgk_payable', '361')
  ) as m(key, code)
  join finance.accounts a on a.tenant_id = p_tenant_id and a.code = m.code
  on conflict (tenant_id, key) do nothing;
end;
$$;

select core.register_provisioner('hr', 'finance.provision_payroll_accounts', 45::smallint);

-- Mevcut kiracılar için de eşlemeleri kur (migration idempotent olmalı).
do $$
declare t uuid;
begin
  for t in select id from core.tenants loop
    perform finance.provision_payroll_accounts(t);
  end loop;
end $$;

-- -----------------------------------------------------------------------------
-- Tahakkuk kaydı
-- -----------------------------------------------------------------------------
create or replace function finance.on_payroll_approved(p_event jsonb)
returns void
language plpgsql
security definer
set search_path = finance, core, hr, pg_temp
as $$
declare
  v_tenant   uuid  := (p_event ->> 'tenant_id')::uuid;
  v_branch   uuid  := nullif(p_event ->> 'branch_id', '')::uuid;
  v_payload  jsonb := p_event -> 'payload';
  v_run_id   uuid  := (v_payload ->> 'run_id')::uuid;
  v_run      hr.payroll_runs;
  v_entry_id uuid;
  v_journal  uuid;
  v_t        record;
begin
  -- İdempotanlık: yeniden teslimat ikinci kaydı üretmez.
  if exists (
    select 1 from finance.journal_entries
    where tenant_id = v_tenant and source_module = 'hr'
      and source_table = 'payroll_runs' and source_id = v_run_id
  ) then
    return;
  end if;

  select * into v_run from hr.payroll_runs where id = v_run_id;
  if not found then return; end if;

  select id into v_journal from finance.journals
   where tenant_id = v_tenant and kind = 'general' limit 1;
  if v_journal is null then
    raise exception 'Genel yevmiye tanımsız (kiracı %)', v_tenant;
  end if;

  -- Pusulalardan toplamlar
  select
    coalesce(sum(p.gross), 0)                  as gross,
    coalesce(sum(p.net), 0)                    as net,
    coalesce(sum(p.income_tax + p.stamp_tax), 0) as taxes,
    coalesce(sum(p.sgk_employee + p.unemployment_employee), 0) as sgk_employee,
    coalesce(sum(p.sgk_employer + p.unemployment_employer), 0) as sgk_employer
  into v_t
  from hr.payslips p where p.run_id = v_run_id;

  if v_t.gross = 0 then return; end if;

  insert into finance.journal_entries (
    tenant_id, branch_id, journal_id, entry_date, reference, description,
    status, source_module, source_table, source_id
  ) values (
    v_tenant, v_branch, v_journal, v_run.date_to,
    v_run.number,
    format('%s/%s bordro tahakkuku (%s personel)',
           v_run.period_month, v_run.period_year, v_run.employee_count),
    'draft', 'hr', 'payroll_runs', v_run_id
  ) returning id into v_entry_id;

  -- Gider: brüt ücret + işveren payları
  insert into finance.journal_entry_lines (tenant_id, entry_id, sequence, account_id, description, debit)
  values (v_tenant, v_entry_id, 10, finance.mapped_account('payroll_expense', v_tenant),
          'Personel ücret gideri', v_t.gross + v_t.sgk_employer);

  -- Borçlar
  insert into finance.journal_entry_lines (tenant_id, entry_id, sequence, account_id, description, credit)
  values
    (v_tenant, v_entry_id, 20, finance.mapped_account('payroll_payable', v_tenant),
     'Personele borçlar (net ücret)', v_t.net),
    (v_tenant, v_entry_id, 30, finance.mapped_account('payroll_tax_payable', v_tenant),
     'Ödenecek gelir ve damga vergisi', v_t.taxes),
    (v_tenant, v_entry_id, 40, finance.mapped_account('payroll_sgk_payable', v_tenant),
     'Ödenecek SGK kesintileri', v_t.sgk_employee + v_t.sgk_employer);

  perform core.emit_event('finance.entry.drafted', jsonb_build_object(
    'entry_id', v_entry_id, 'source_module', 'hr', 'source_id', v_run_id,
    'total', v_t.gross + v_t.sgk_employer
  ), v_branch, null, v_tenant);
end;
$$;

select core.declare_event('finance.entry.drafted', 'finance', 'Yevmiye kaydı taslağı oluşturuldu');
select core.subscribe('hr.payroll.approved', 'finance', 'finance.on_payroll_approved');
