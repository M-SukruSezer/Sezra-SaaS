-- =============================================================================
-- 0306 — İK raporları ve liste görünümleri
-- =============================================================================
-- Tüm görünümler security_invoker = on: RLS, görünümü SORGULAYAN kullanıcıya
-- göre çalışır. Bu olmadan bir görünüm, sahibinin yetkisiyle veri sızdırırdı.
--
-- Ücret içeren görünümler hr.employee_contracts'a join yapar. Sözleşme okuma
-- yetkisi olmayan kullanıcı satırı yine görür ama ücret alanları NULL gelir —
-- yetki kontrolü ayrı bir if bloğunda değil, RLS'in kendisinde.
-- =============================================================================

create or replace view hr.v_employee_list
with (security_invoker = on) as
select
  e.id, e.tenant_id, e.branch_id, e.employee_no,
  e.first_name, e.last_name,
  e.first_name || ' ' || e.last_name as full_name,
  e.email, e.phone, e.hire_date, e.termination_date, e.is_active,
  e.department_id, d.name as department_name,
  e.position_id,   p.name as position_name,
  e.manager_id,
  m.first_name || ' ' || m.last_name as manager_name,
  b.name as branch_name,
  e.user_id, e.owner_id,
  -- Kıdem (yıl) — izin hak edişi ve kıdem tazminatı için
  round(extract(epoch from age(coalesce(e.termination_date, current_date), e.hire_date))
        / (365.25 * 86400), 2) as tenure_years,
  e.created_at, e.updated_at
from hr.employees e
left join hr.departments d on d.id = e.department_id
left join hr.positions   p on p.id = e.position_id
left join hr.employees   m on m.id = e.manager_id
left join core.branches  b on b.id = e.branch_id;

-- Yürürlükteki sözleşme + ücret. Ayrı görünüm: menüde ayrı yetkiyle açılır.
create or replace view hr.v_employee_contract_current
with (security_invoker = on) as
select distinct on (c.employee_id)
  c.id, c.tenant_id, c.branch_id, c.employee_id,
  e.employee_no, e.first_name || ' ' || e.last_name as full_name,
  c.valid_from, c.valid_to, c.employment_type,
  c.wage_basis, c.wage_amount, c.wage_period, c.currency, c.weekly_hours,
  c.sgk_discount_5510, c.disability_degree, c.is_pensioner,
  c.annual_leave_entitlement_days
from hr.employee_contracts c
join hr.employees e on e.id = c.employee_id
where c.valid_from <= current_date and (c.valid_to is null or c.valid_to >= current_date)
order by c.employee_id, c.valid_from desc;

create or replace view hr.v_leave_request_list
with (security_invoker = on) as
select
  r.id, r.tenant_id, r.branch_id, r.employee_id,
  e.employee_no, e.first_name || ' ' || e.last_name as employee_name,
  r.leave_type_id, t.code as leave_type_code, t.name as leave_type_name,
  t.is_paid, t.consumes_balance,
  r.date_from, r.date_to, r.days, r.reason, r.status,
  r.approver_id, u.full_name as approver_name, r.approved_at, r.rejection_reason,
  b.name as branch_name, r.owner_id, r.created_at
from hr.leave_requests r
join hr.employees e on e.id = r.employee_id
join hr.leave_types t on t.id = r.leave_type_id
left join core.users u on u.id = r.approver_id
left join core.branches b on b.id = r.branch_id;

create or replace view hr.v_leave_balance_summary
with (security_invoker = on) as
select
  b.id, b.tenant_id, b.employee_id,
  e.employee_no, e.first_name || ' ' || e.last_name as employee_name,
  e.branch_id, b.leave_type_id, t.code as leave_type_code, t.name as leave_type_name,
  b.year, b.entitled_days, b.carried_days, b.used_days,
  b.entitled_days + b.carried_days - b.used_days as remaining_days,
  -- Onay bekleyen talepler bakiyeyi henüz düşürmez ama planlamada görünmeli
  coalesce((select sum(r.days) from hr.leave_requests r
            where r.employee_id = b.employee_id
              and r.leave_type_id = b.leave_type_id
              and r.status = 'pending'
              and extract(year from r.date_from) = b.year), 0) as pending_days
from hr.leave_balances b
join hr.employees e on e.id = b.employee_id
join hr.leave_types t on t.id = b.leave_type_id;

-- Aylık puantaj özeti — bordro girdisi ve şube verimlilik takibi
create or replace view hr.v_attendance_monthly
with (security_invoker = on) as
select
  a.tenant_id, a.branch_id, a.employee_id,
  e.employee_no, e.first_name || ' ' || e.last_name as employee_name,
  date_trunc('month', a.work_date)::date as period,
  count(*) filter (where a.worked_minutes > 0)      as worked_days,
  round(sum(a.worked_minutes) / 60.0, 2)            as worked_hours,
  round(sum(a.overtime_minutes) / 60.0, 2)          as overtime_hours,
  count(*) filter (where a.leave_request_id is not null) as leave_days,
  count(*) filter (where a.worked_minutes = 0 and a.leave_request_id is null
                     and a.absence_code is not null) as absent_days
from hr.attendance a
join hr.employees e on e.id = a.employee_id
group by a.tenant_id, a.branch_id, a.employee_id, e.employee_no, e.first_name, e.last_name,
         date_trunc('month', a.work_date);

create or replace view hr.v_payroll_run_list
with (security_invoker = on) as
select
  r.id, r.tenant_id, r.branch_id, r.number,
  r.period_year, r.period_month,
  to_char(make_date(r.period_year, r.period_month, 1), 'YYYY-MM') as period,
  r.date_from, r.date_to, r.payment_date, r.status,
  r.employee_count, r.total_gross, r.total_net, r.total_employer_cost,
  b.name as branch_name,
  ps.code as parameter_set_code, ps.is_verified as parameters_verified,
  r.approved_at, r.posted_at, r.owner_id, r.created_at
from hr.payroll_runs r
left join core.branches b on b.id = r.branch_id
left join hr.payroll_parameter_sets ps on ps.id = r.parameter_set_id;

create or replace view hr.v_payslip_list
with (security_invoker = on) as
select
  p.id, p.tenant_id, p.branch_id, p.run_id, p.employee_id,
  e.employee_no, e.first_name || ' ' || e.last_name as employee_name,
  r.period_year, r.period_month,
  to_char(make_date(r.period_year, r.period_month, 1), 'YYYY-MM') as period,
  r.status as run_status,
  p.sgk_days, p.missing_days, p.gross, p.sgk_base,
  p.sgk_employee, p.unemployment_employee,
  p.income_tax_base, p.income_tax_gross, p.income_tax_exemption, p.income_tax,
  p.stamp_tax, p.net,
  p.sgk_employer, p.unemployment_employer, p.employer_cost,
  d.name as department_name, b.name as branch_name
from hr.payslips p
join hr.payroll_runs r on r.id = p.run_id
join hr.employees e on e.id = p.employee_id
left join hr.departments d on d.id = e.department_id
left join core.branches b on b.id = p.branch_id;

-- Departman bazlı kadro — organizasyon şeması ekranının veri kaynağı
create or replace view hr.v_headcount_by_department
with (security_invoker = on) as
select
  e.tenant_id, e.branch_id, b.name as branch_name,
  e.department_id, coalesce(d.name, 'Atanmamış') as department_name,
  count(*) filter (where e.is_active and e.termination_date is null) as active_headcount,
  count(*) filter (where e.termination_date is not null
                     and e.termination_date >= date_trunc('year', current_date)) as left_this_year,
  count(*) filter (where e.hire_date >= date_trunc('year', current_date))        as hired_this_year
from hr.employees e
left join hr.departments d on d.id = e.department_id
left join core.branches b on b.id = e.branch_id
group by e.tenant_id, e.branch_id, b.name, e.department_id, d.name;

-- Şube bazlı bordro maliyeti — P&L ile karşılaştırma için (Bölüm 4.2 bağlantısı)
create or replace view hr.v_payroll_cost_by_branch
with (security_invoker = on) as
select
  r.tenant_id, r.branch_id, b.name as branch_name,
  r.period_year, r.period_month,
  to_char(make_date(r.period_year, r.period_month, 1), 'YYYY-MM') as period,
  count(distinct p.employee_id) as employee_count,
  sum(p.gross)          as total_gross,
  sum(p.net)            as total_net,
  sum(p.sgk_employee + p.unemployment_employee) as total_employee_premiums,
  sum(p.income_tax + p.stamp_tax)               as total_taxes,
  sum(p.sgk_employer + p.unemployment_employer) as total_employer_premiums,
  sum(p.employer_cost)  as total_employer_cost
from hr.payroll_runs r
join hr.payslips p on p.run_id = r.id
left join core.branches b on b.id = r.branch_id
where r.status <> 'cancelled'
group by r.tenant_id, r.branch_id, b.name, r.period_year, r.period_month;
