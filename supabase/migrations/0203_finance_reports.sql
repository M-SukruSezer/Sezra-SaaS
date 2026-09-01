-- =============================================================================
-- 0203 — Finans raporları
-- =============================================================================
-- Hepsi security_invoker = on: şube müdürü yalnızca kendi şubesinin rakamlarını
-- görür, muhasebeci hepsini. Rapor katmanına ayrıca yetki kontrolü yazmıyoruz —
-- RLS zaten doğru satırları veriyor.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- Mizan (dönem bazlı)
-- -----------------------------------------------------------------------------
create or replace view finance.v_trial_balance
with (security_invoker = on) as
select
  b.tenant_id,
  b.branch_id,
  b.period_start,
  a.id            as account_id,
  a.code,
  a.name,
  a.type,
  a.is_pl,
  b.debit_total,
  b.credit_total,
  b.debit_total - b.credit_total                        as balance,
  greatest(b.debit_total - b.credit_total, 0)           as debit_balance,
  greatest(b.credit_total - b.debit_total, 0)           as credit_balance
from finance.account_balances b
join finance.accounts a on a.id = b.account_id;

-- -----------------------------------------------------------------------------
-- Defter-i kebir (hesap hareketleri, yürüyen bakiyeli)
-- -----------------------------------------------------------------------------
create or replace view finance.v_general_ledger
with (security_invoker = on) as
select
  e.tenant_id,
  e.branch_id,
  l.account_id,
  a.code          as account_code,
  a.name          as account_name,
  e.id            as entry_id,
  e.number        as entry_number,
  e.entry_date,
  e.description   as entry_description,
  j.code          as journal_code,
  l.id            as line_id,
  l.description   as line_description,
  l.partner_id,
  p.name          as partner_name,
  l.debit,
  l.credit,
  sum(l.debit - l.credit) over (
    partition by e.tenant_id, e.branch_id, l.account_id
    order by e.entry_date, e.number, l.sequence
    rows between unbounded preceding and current row
  ) as running_balance
from finance.journal_entry_lines l
join finance.journal_entries e on e.id = l.entry_id
join finance.accounts a on a.id = l.account_id
join finance.journals j on j.id = e.journal_id
left join core.partners p on p.id = l.partner_id
where e.status = 'posted';

-- -----------------------------------------------------------------------------
-- Kâr / Zarar (P&L)
-- -----------------------------------------------------------------------------
-- Gelir hesapları alacak bakiyeli, gider/maliyet hesapları borç bakiyelidir.
-- İşareti burada normalleştiriyoruz ki rapor tüketicisi hesap tipine göre
-- dallanmak zorunda kalmasın.
create or replace view finance.v_profit_loss
with (security_invoker = on) as
select
  b.tenant_id,
  b.branch_id,
  b.period_start,
  a.id   as account_id,
  a.code,
  a.name,
  a.type,
  left(a.code, 2) as group_code,
  case a.type
    when 'income' then b.credit_total - b.debit_total
    else b.debit_total - b.credit_total
  end as amount
from finance.account_balances b
join finance.accounts a on a.id = b.account_id
where a.is_pl and a.is_leaf;

-- Özet gelir tablosu — yönetim raporlaması için tek satır
--
-- coalesce ZORUNLU: `sum(...) filter (...)` eşleşen satır yoksa 0 değil NULL
-- döner. Henüz gideri olmayan bir işletmede bu, net kârın NULL çıkmasına ve
-- raporun "kâr yok" gibi görünmesine yol açar. Her filtreli toplam sıfırlanır.
create or replace view finance.v_profit_loss_summary
with (security_invoker = on) as
select
  tenant_id,
  branch_id,
  period_start,
  coalesce(sum(amount) filter (where group_code = '60'), 0)                as gross_revenue,
  coalesce(sum(amount) filter (where group_code = '61'), 0)                as sales_deductions,
  coalesce(sum(amount) filter (where group_code = '60'), 0)
    - coalesce(sum(amount) filter (where group_code = '61'), 0)            as net_revenue,
  coalesce(sum(amount) filter (where group_code = '62'), 0)                as cogs,
  coalesce(sum(amount) filter (where group_code = '60'), 0)
    - coalesce(sum(amount) filter (where group_code = '61'), 0)
    - coalesce(sum(amount) filter (where group_code = '62'), 0)            as gross_profit,
  coalesce(sum(amount) filter (where group_code in ('63', '76', '77')), 0) as operating_expenses,
  coalesce(sum(amount) filter (where group_code = '64'), 0)                as other_income,
  coalesce(sum(amount) filter (where group_code in ('66', '78')), 0)       as financial_expenses,
  coalesce(sum(amount) filter (where type = 'income'), 0)
    - coalesce(sum(amount) filter (where type in ('expense', 'cost')), 0)  as net_profit
from finance.v_profit_loss
group by tenant_id, branch_id, period_start;

-- -----------------------------------------------------------------------------
-- KDV özeti (beyanname hazırlığı)
-- -----------------------------------------------------------------------------
create or replace view finance.v_vat_summary
with (security_invoker = on) as
select
  i.tenant_id,
  i.branch_id,
  date_trunc('month', i.issue_date)::date as period_start,
  i.kind,
  t.code                                   as tax_code,
  t.rate                                   as tax_rate,
  sum(l.line_subtotal)                     as tax_base,
  sum(l.line_tax)                          as tax_amount,
  sum(l.line_withholding)                  as withholding_amount,
  count(distinct i.id)                     as invoice_count
from finance.invoices i
join finance.invoice_lines l on l.invoice_id = i.id
left join core.taxes t on t.id = l.tax_id
where i.status in ('posted', 'partially_paid', 'paid')
group by i.tenant_id, i.branch_id, date_trunc('month', i.issue_date), i.kind, t.code, t.rate;

-- -----------------------------------------------------------------------------
-- Cari yaşlandırma
-- -----------------------------------------------------------------------------
create or replace view finance.v_partner_aging
with (security_invoker = on) as
select
  i.tenant_id,
  i.branch_id,
  i.kind,
  i.partner_id,
  p.name                                   as partner_name,
  sum(i.total - i.paid_total)              as open_amount,
  coalesce(sum(i.total - i.paid_total) filter (
    where coalesce(i.due_date, i.issue_date) >= current_date), 0)  as not_due,
  coalesce(sum(i.total - i.paid_total) filter (
    where coalesce(i.due_date, i.issue_date) < current_date
      and coalesce(i.due_date, i.issue_date) >= current_date - 30), 0)  as overdue_0_30,
  coalesce(sum(i.total - i.paid_total) filter (
    where coalesce(i.due_date, i.issue_date) < current_date - 30
      and coalesce(i.due_date, i.issue_date) >= current_date - 60), 0)  as overdue_31_60,
  coalesce(sum(i.total - i.paid_total) filter (
    where coalesce(i.due_date, i.issue_date) < current_date - 60
      and coalesce(i.due_date, i.issue_date) >= current_date - 90), 0)  as overdue_61_90,
  coalesce(sum(i.total - i.paid_total) filter (
    where coalesce(i.due_date, i.issue_date) < current_date - 90), 0)   as overdue_90_plus,
  count(*)                                 as invoice_count,
  min(i.due_date)                          as earliest_due
from finance.invoices i
join core.partners p on p.id = i.partner_id
where i.status in ('posted', 'partially_paid')
  and i.total > i.paid_total
group by i.tenant_id, i.branch_id, i.kind, i.partner_id, p.name;

-- -----------------------------------------------------------------------------
-- Açık faturalar (tahsilat ekranı)
-- -----------------------------------------------------------------------------
create or replace view finance.v_open_invoices
with (security_invoker = on) as
select
  i.*,
  p.name                       as partner_name,
  p.tax_no,
  i.total - i.paid_total       as balance_due,
  (current_date - coalesce(i.due_date, i.issue_date)) as days_overdue
from finance.invoices i
join core.partners p on p.id = i.partner_id
where i.status in ('posted', 'partially_paid');

-- -----------------------------------------------------------------------------
-- Liste görünümleri (API'nin readFrom'u için)
-- -----------------------------------------------------------------------------
create or replace view finance.v_invoice_list
with (security_invoker = on) as
select i.*,
       p.name      as partner_name,
       p.tax_no,
       u.full_name as owner_name,
       b.name      as branch_name,
       i.total - i.paid_total as balance_due,
       (select count(*) from finance.invoice_lines il where il.invoice_id = i.id) as line_count,
       (select ed.status from finance.einvoice_documents ed
         where ed.invoice_id = i.id order by ed.created_at desc limit 1) as einvoice_status
from finance.invoices i
left join core.partners p on p.id = i.partner_id
left join core.users u on u.id = i.owner_id
left join core.branches b on b.id = i.branch_id;

create or replace view finance.v_journal_entry_list
with (security_invoker = on) as
select e.*,
       j.code      as journal_code,
       j.name      as journal_name,
       u.full_name as owner_name,
       b.name      as branch_name,
       fp.name     as period_name,
       (select count(*) from finance.journal_entry_lines l where l.entry_id = e.id) as line_count
from finance.journal_entries e
join finance.journals j on j.id = e.journal_id
left join core.users u on u.id = e.owner_id
left join core.branches b on b.id = e.branch_id
left join finance.fiscal_periods fp on fp.id = e.period_id;

create or replace view finance.v_payment_list
with (security_invoker = on) as
select pay.*,
       p.name      as partner_name,
       ba.name     as bank_account_name,
       u.full_name as owner_name,
       b.name      as branch_name
from finance.payments pay
left join core.partners p on p.id = pay.partner_id
left join finance.bank_accounts ba on ba.id = pay.bank_account_id
left join core.users u on u.id = pay.owner_id
left join core.branches b on b.id = pay.branch_id;

create or replace view finance.v_account_list
with (security_invoker = on) as
select a.*,
       pa.code as parent_code,
       pa.name as parent_name
from finance.accounts a
left join finance.accounts pa on pa.id = a.parent_id;

select core.apply_grants();
