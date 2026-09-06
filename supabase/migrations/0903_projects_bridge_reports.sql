-- =============================================================================
-- 0903 — Proje köprüleri ve raporları
-- =============================================================================

-- -----------------------------------------------------------------------------
-- CRM: kazanılan fırsattan proje
-- -----------------------------------------------------------------------------
-- Handler PROJE modülüne aittir; CRM onun varlığını bilmez. Faz 1'de yayınlanan
-- crm.lead.won olayı, Faz 4'te yeni bir abone kazandı — CRM'de tek satır
-- değişmeden (Envanter'in Faz 2'de yaptığının aynısı).
--
-- Proje TASLAK doğar: her kazanılan fırsat proje gerektirmez ve otomatik aktif
-- proje açmak, listeyi hiç başlamayacak kayıtlarla doldururdu.
create or replace function projects.on_lead_won(p_event jsonb)
returns void
language plpgsql
security definer
set search_path = projects, core, pg_temp
as $$
declare
  v_tenant  uuid  := (p_event ->> 'tenant_id')::uuid;
  v_branch  uuid  := nullif(p_event ->> 'branch_id', '')::uuid;
  v_payload jsonb := p_event -> 'payload';
  v_lead    uuid  := (v_payload ->> 'lead_id')::uuid;
begin
  if exists (
    select 1 from projects.projects
    where tenant_id = v_tenant and source_module = 'crm' and source_id = v_lead
  ) then
    return;
  end if;

  insert into projects.projects (
    tenant_id, branch_id, code, name, partner_id, status, billing_type,
    contract_amount, currency, source_module, source_id, owner_id)
  values (
    v_tenant, v_branch,
    core.next_sequence('project_code', v_branch, v_tenant),
    coalesce(v_payload ->> 'name', 'Yeni proje'),
    nullif(v_payload ->> 'partner_id', '')::uuid,
    'draft', 'time_material',
    nullif(v_payload ->> 'expected_revenue', '')::numeric,
    coalesce(v_payload ->> 'currency', 'TRY'),
    'crm', v_lead,
    nullif(v_payload ->> 'owner_id', '')::uuid);
end;
$$;

select core.subscribe('crm.lead.won', 'projects', 'projects.on_lead_won');

-- -----------------------------------------------------------------------------
-- Muhasebe: hakedişten satış faturası taslağı
-- -----------------------------------------------------------------------------
create or replace function finance.on_project_billing_requested(p_event jsonb)
returns void
language plpgsql
security definer
set search_path = finance, core, pg_temp
as $$
declare
  v_tenant  uuid  := (p_event ->> 'tenant_id')::uuid;
  v_branch  uuid  := nullif(p_event ->> 'branch_id', '')::uuid;
  v_payload jsonb := p_event -> 'payload';
  v_batch   uuid  := (v_payload ->> 'batch_id')::uuid;
  v_invoice uuid;
  v_income  uuid;
  v_line    jsonb;
  v_seq     smallint := 10;
begin
  if exists (
    select 1 from finance.invoices
    where tenant_id = v_tenant and source_module = 'projects'
      and source_table = 'timesheets' and source_id = v_batch
  ) then
    return;
  end if;

  select account_id into v_income
  from finance.account_mappings where tenant_id = v_tenant and key = 'sales_income';
  if v_income is null then
    raise exception 'sales_income hesap eşlemesi tanımsız (kiracı %)', v_tenant;
  end if;

  insert into finance.invoices (
    tenant_id, branch_id, kind, partner_id, issue_date, status, currency,
    source_module, source_table, source_id, notes)
  values (
    v_tenant, v_branch, 'sale', (v_payload ->> 'partner_id')::uuid,
    current_date, 'draft', coalesce(v_payload ->> 'currency', 'TRY'),
    'projects', 'timesheets', v_batch,
    format('%s projesi hakedişi (%s saat)',
           coalesce(v_payload ->> 'name', ''), coalesce(v_payload ->> 'total_hours', '0')))
  returning id into v_invoice;

  for v_line in select * from jsonb_array_elements(v_payload -> 'lines')
  loop
    insert into finance.invoice_lines (
      tenant_id, invoice_id, sequence, account_id, description,
      quantity, unit_price)
    values (
      v_tenant, v_invoice, v_seq, v_income,
      v_line ->> 'description',
      coalesce((v_line ->> 'quantity')::numeric, 1),
      coalesce((v_line ->> 'unit_price')::numeric, 0));
    v_seq := v_seq + 10;
  end loop;

  perform core.emit_event('finance.invoice.drafted', jsonb_build_object(
    'invoice_id', v_invoice, 'source_module', 'projects', 'source_id', v_batch
  ), v_branch, null, v_tenant);
end;
$$;

select core.subscribe('projects.billing.requested', 'finance',
                      'finance.on_project_billing_requested');

-- -----------------------------------------------------------------------------
-- Raporlar
-- -----------------------------------------------------------------------------
create or replace view projects.v_project_list
with (security_invoker = on) as
select
  p.id, p.tenant_id, p.branch_id, p.code, p.name, p.status, p.billing_type,
  p.partner_id, pa.name as partner_name,
  p.manager_id, u.full_name as manager_name,
  p.start_date, p.due_date, p.completed_at,
  p.contract_amount, p.hourly_rate, p.currency, p.planned_hours,
  b.name as branch_name, p.owner_id, p.created_at,
  (select count(*) from projects.tasks t where t.project_id = p.id)                as task_count,
  (select count(*) from projects.tasks t
    where t.project_id = p.id and t.status = 'done')                               as done_task_count,
  coalesce((select sum(ts.hours) from projects.timesheets ts
             where ts.project_id = p.id), 0)                                       as actual_hours,
  -- Plan sapması: bütçelenen saatin yüzde kaçı harcandı
  case when p.planned_hours > 0
       then round(coalesce((select sum(ts.hours) from projects.timesheets ts
                             where ts.project_id = p.id), 0) / p.planned_hours * 100, 1)
  end                                                                              as hours_used_pct,
  coalesce((select sum(ts.billable_amount) from projects.timesheets ts
             where ts.project_id = p.id and ts.is_billable), 0)                    as billable_amount,
  coalesce((select sum(ts.billable_amount) from projects.timesheets ts
             where ts.project_id = p.id and ts.is_billable and ts.invoiced_at is null), 0)
                                                                                   as unbilled_amount,
  -- Gecikme
  case when p.due_date is not null and p.status in ('active','on_hold')
            and p.due_date < current_date
       then current_date - p.due_date end                                          as overdue_days
from projects.projects p
left join core.partners pa on pa.id = p.partner_id
left join core.users u on u.id = p.manager_id
left join core.branches b on b.id = p.branch_id;

create or replace view projects.v_task_list
with (security_invoker = on) as
select
  t.id, t.tenant_id, t.branch_id, t.project_id, p.code as project_code, p.name as project_name,
  t.parent_id, pt.name as parent_name,
  t.code, t.name, t.description, t.status, t.priority, t.sequence,
  t.assignee_id, u.full_name as assignee_name,
  t.planned_hours, t.start_date, t.due_date, t.done_at,
  coalesce((select sum(ts.hours) from projects.timesheets ts where ts.task_id = t.id), 0)
    as actual_hours,
  (select count(*) from projects.tasks c where c.parent_id = t.id) as subtask_count,
  case when t.due_date is not null and t.status not in ('done','cancelled')
            and t.due_date < current_date
       then current_date - t.due_date end as overdue_days,
  b.name as branch_name, t.owner_id, t.created_at
from projects.tasks t
join projects.projects p on p.id = t.project_id
left join projects.tasks pt on pt.id = t.parent_id
left join core.users u on u.id = t.assignee_id
left join core.branches b on b.id = t.branch_id;

create or replace view projects.v_timesheet_list
with (security_invoker = on) as
select
  ts.id, ts.tenant_id, ts.branch_id, ts.project_id, p.code as project_code,
  p.name as project_name, ts.task_id, t.name as task_name,
  ts.user_id, u.full_name as user_name,
  ts.work_date, ts.hours, ts.description, ts.is_billable,
  ts.hourly_rate, ts.billable_amount,
  ts.invoiced_at, ts.invoice_id,
  (ts.invoiced_at is not null) as is_invoiced,
  b.name as branch_name, ts.created_at
from projects.timesheets ts
join projects.projects p on p.id = ts.project_id
left join projects.tasks t on t.id = ts.task_id
join core.users u on u.id = ts.user_id
left join core.branches b on b.id = ts.branch_id;

-- KÂRLILIK: maliyet kolonları taşıdığı için ayrı görünüm.
-- v_timesheet_list herkese açıkken bu görünüm yalnızca
-- projects.report.profitability izni olanlara anlamlı veri döndürür —
-- maliyet, ekip arkadaşının maaşını ele verir.
create or replace view projects.v_project_profitability
with (security_invoker = on) as
select
  p.tenant_id, p.id as project_id, p.code, p.name, p.status, p.billing_type,
  p.partner_id, pa.name as partner_name, p.currency,
  p.contract_amount, p.planned_hours,
  coalesce(sum(ts.hours), 0)                                    as actual_hours,
  coalesce(sum(ts.hours) filter (where ts.is_billable), 0)      as billable_hours,
  coalesce(sum(ts.billable_amount), 0)                          as revenue,
  coalesce(sum(ts.cost_amount), 0)                              as cost,
  coalesce(sum(ts.billable_amount), 0) - coalesce(sum(ts.cost_amount), 0) as margin,
  case when coalesce(sum(ts.billable_amount), 0) > 0
       then round((coalesce(sum(ts.billable_amount), 0) - coalesce(sum(ts.cost_amount), 0))
                  / sum(ts.billable_amount) * 100, 1) end       as margin_pct,
  -- Faturalanabilirlik oranı: harcanan saatin ne kadarı müşteriye yansıyor
  case when coalesce(sum(ts.hours), 0) > 0
       then round(coalesce(sum(ts.hours) filter (where ts.is_billable), 0)
                  / sum(ts.hours) * 100, 1) end                 as billable_pct,
  b.name as branch_name
from projects.projects p
left join projects.timesheets ts on ts.project_id = p.id
left join core.partners pa on pa.id = p.partner_id
left join core.branches b on b.id = p.branch_id
group by p.tenant_id, p.id, p.code, p.name, p.status, p.billing_type,
         p.partner_id, pa.name, p.currency, p.contract_amount, p.planned_hours, b.name;

-- Kişi bazlı zaman dağılımı — kapasite planlaması ve faturalanabilirlik takibi
create or replace view projects.v_user_utilization
with (security_invoker = on) as
select
  ts.tenant_id, ts.user_id, u.full_name as user_name,
  date_trunc('month', ts.work_date)::date as period,
  sum(ts.hours)                                        as total_hours,
  sum(ts.hours) filter (where ts.is_billable)          as billable_hours,
  round(sum(ts.hours) filter (where ts.is_billable) / nullif(sum(ts.hours), 0) * 100, 1)
                                                       as billable_pct,
  count(distinct ts.project_id)                        as project_count
from projects.timesheets ts
join core.users u on u.id = ts.user_id
group by ts.tenant_id, ts.user_id, u.full_name, date_trunc('month', ts.work_date);
