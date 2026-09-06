-- =============================================================================
-- 0303 — İK iş kuralları: izin akışı, puantaj, bordro orkestrasyonu
-- =============================================================================

-- -----------------------------------------------------------------------------
-- Resmî tatiller — izin gün hesabı bunlara bakar
-- -----------------------------------------------------------------------------
-- Kiracı bazlı: dinî bayram tarihleri her yıl kayar ve idari izin günleri
-- işletmeden işletmeye değişir. Kurulumda sabit tarihli tatiller yüklenir.
create table if not exists hr.holidays (
  id          uuid primary key default gen_random_uuid(),
  tenant_id   uuid not null references core.tenants(id) on delete cascade,
  branch_id   uuid references core.branches(id) on delete cascade,
  holiday_date date not null,
  name        text not null,
  is_half_day boolean not null default false,
  created_by  uuid references core.users(id),
  updated_by  uuid references core.users(id),
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);
create unique index if not exists ux_hr_holidays_date
  on hr.holidays (tenant_id, coalesce(branch_id, '00000000-0000-0000-0000-000000000000'::uuid), holiday_date);

-- -----------------------------------------------------------------------------
-- İş günü sayımı
-- -----------------------------------------------------------------------------
-- 4857 sayılı kanun: yıllık izinde hafta tatili ve resmî tatiller izin
-- süresinden sayılmaz. Pazar tek hafta tatili varsayımıyla çalışıyoruz;
-- cumartesi de tatil olan işletmeler için `weekly_off_days` parametresi var.
create or replace function hr.working_days(
  p_tenant_id uuid, p_from date, p_to date, p_branch_id uuid default null
)
returns numeric
language sql
stable
security definer
set search_path = hr, core, pg_temp
as $$
  select coalesce(sum(
    case
      when extract(isodow from d.day) = 7 then 0                       -- Pazar
      when h.holiday_date is not null and not h.is_half_day then 0
      when h.holiday_date is not null and h.is_half_day then 0.5
      else 1
    end
  ), 0)::numeric
  from generate_series(p_from, p_to, interval '1 day') as d(day)
  left join hr.holidays h
    on h.tenant_id = p_tenant_id
   and h.holiday_date = d.day::date
   and (h.branch_id is null or h.branch_id = p_branch_id);
$$;

-- İzin gün sayısı elle girilmez: tarih aralığından türetilir.
create or replace function hr.fn_calc_leave_days()
returns trigger
language plpgsql
as $$
declare v_consumes boolean;
begin
  select consumes_balance into v_consumes from hr.leave_types where id = new.leave_type_id;
  if coalesce(v_consumes, true) then
    new.days := hr.working_days(new.tenant_id, new.date_from, new.date_to, new.branch_id);
  else
    -- Rapor/mazeret izni takvim günü üzerinden takip edilir
    new.days := (new.date_to - new.date_from) + 1;
  end if;
  return new;
end;
$$;

drop trigger if exists trg_hr_leave_days on hr.leave_requests;
create trigger trg_hr_leave_days before insert or update of date_from, date_to, leave_type_id
  on hr.leave_requests for each row execute function hr.fn_calc_leave_days();

-- -----------------------------------------------------------------------------
-- Yıllık izin hak edişi (4857/53)
-- -----------------------------------------------------------------------------
create or replace function hr.annual_leave_entitlement(p_employee_id uuid, p_year smallint)
returns numeric
language plpgsql
stable
security definer
set search_path = hr, pg_temp
as $$
declare
  v_emp     hr.employees;
  v_con     hr.employee_contracts;
  v_years   numeric;
  v_age     integer;
  v_days    numeric;
begin
  select * into v_emp from hr.employees where id = p_employee_id;
  if not found then return 0; end if;

  -- Sözleşmede elle belirlenmişse (toplu sözleşme, özel anlaşma) o geçerli
  select * into v_con from hr.employee_contracts c
   where c.employee_id = p_employee_id
   order by c.valid_from desc limit 1;
  if v_con.annual_leave_entitlement_days is not null then
    return v_con.annual_leave_entitlement_days;
  end if;

  v_years := extract(year from age(make_date(p_year, 12, 31), v_emp.hire_date));
  v_days := case
    when v_years < 1  then 0      -- 1 yılı doldurmayan hak etmez
    when v_years < 5  then 14
    when v_years < 15 then 20
    else 26
  end;

  -- 18 yaşından küçük ve 50 yaşından büyükler için taban 20 gün
  v_age := extract(year from age(make_date(p_year, 12, 31), coalesce(v_emp.birth_date, make_date(p_year - 30, 1, 1))));
  if (v_age < 18 or v_age > 50) and v_days > 0 then
    v_days := greatest(v_days, 20);
  end if;

  return v_days;
end;
$$;

-- Bakiye satırını yoksa oluşturur, hak edişi tazeler.
create or replace function hr.ensure_leave_balance(
  p_employee_id uuid, p_leave_type_id uuid, p_year smallint
)
returns hr.leave_balances
language plpgsql
security definer
set search_path = hr, core, pg_temp
as $$
declare
  v_bal    hr.leave_balances;
  v_type   hr.leave_types;
  v_tenant uuid;
begin
  select tenant_id into v_tenant from hr.employees where id = p_employee_id;
  select * into v_type from hr.leave_types where id = p_leave_type_id;

  insert into hr.leave_balances (tenant_id, employee_id, leave_type_id, year, entitled_days)
  values (v_tenant, p_employee_id, p_leave_type_id, p_year,
          case when v_type.code = 'YILLIK'
               then hr.annual_leave_entitlement(p_employee_id, p_year)
               else coalesce(v_type.max_days_per_year, 0) end)
  on conflict (tenant_id, employee_id, leave_type_id, year) do update
    set entitled_days = excluded.entitled_days
  returning * into v_bal;

  return v_bal;
end;
$$;

-- -----------------------------------------------------------------------------
-- İzin onay akışı
-- -----------------------------------------------------------------------------
create or replace function hr.submit_leave_request(p_id uuid)
returns hr.leave_requests
language plpgsql
security invoker
as $$
declare v_req hr.leave_requests;
begin
  select * into v_req from hr.leave_requests where id = p_id for update;
  if not found then raise exception 'İzin talebi bulunamadı' using errcode = 'P0002'; end if;
  if v_req.status <> 'draft' then
    raise exception 'Yalnızca taslak talep gönderilebilir (mevcut: %)', v_req.status;
  end if;
  if v_req.days <= 0 then
    raise exception 'İzin süresi sıfır gün — seçilen aralıkta iş günü yok';
  end if;

  update hr.leave_requests set status = 'pending' where id = p_id returning * into v_req;

  perform core.emit_event('hr.leave.requested', jsonb_build_object(
    'request_id', v_req.id, 'employee_id', v_req.employee_id,
    'leave_type_id', v_req.leave_type_id, 'date_from', v_req.date_from,
    'date_to', v_req.date_to, 'days', v_req.days
  ), v_req.branch_id);

  return v_req;
end;
$$;

create or replace function hr.approve_leave_request(p_id uuid)
returns hr.leave_requests
language plpgsql
security invoker
as $$
declare
  v_req  hr.leave_requests;
  v_type hr.leave_types;
  v_bal  hr.leave_balances;
  v_year smallint;
begin
  if not core.has_perm('hr.leave.approve') then
    raise exception 'İzin onaylama yetkiniz yok' using errcode = '42501';
  end if;

  select * into v_req from hr.leave_requests where id = p_id for update;
  if not found then raise exception 'İzin talebi bulunamadı' using errcode = 'P0002'; end if;
  if v_req.status <> 'pending' then
    raise exception 'Yalnızca onay bekleyen talep onaylanabilir (mevcut: %)', v_req.status;
  end if;

  -- Kendi talebini onaylayamaz. Şirket yöneticisi bile: onay bir kontroldür,
  -- kontrolü kişinin kendisine bırakmak onu kontrol olmaktan çıkarır.
  if exists (select 1 from hr.employees e
             where e.id = v_req.employee_id and e.user_id = core.current_user_id())
     and not core.has_perm('hr.leave.self_approve') then
    raise exception 'Kendi izin talebinizi onaylayamazsınız' using errcode = '42501';
  end if;

  select * into v_type from hr.leave_types where id = v_req.leave_type_id;
  v_year := extract(year from v_req.date_from)::smallint;

  if v_type.consumes_balance then
    v_bal := hr.ensure_leave_balance(v_req.employee_id, v_req.leave_type_id, v_year);
    if v_bal.entitled_days + v_bal.carried_days - v_bal.used_days < v_req.days
       and not core.has_perm('hr.leave.override') then
      raise exception 'Yetersiz izin bakiyesi: kalan % gün, talep % gün',
        v_bal.entitled_days + v_bal.carried_days - v_bal.used_days, v_req.days
        using errcode = '23514';
    end if;
    update hr.leave_balances set used_days = used_days + v_req.days where id = v_bal.id;
  end if;

  update hr.leave_requests
     set status = 'approved', approver_id = core.current_user_id(), approved_at = now()
   where id = p_id returning * into v_req;

  perform core.emit_event('hr.leave.approved', jsonb_build_object(
    'request_id', v_req.id, 'employee_id', v_req.employee_id,
    'date_from', v_req.date_from, 'date_to', v_req.date_to, 'days', v_req.days,
    'reduces_sgk_days', v_type.reduces_sgk_days
  ), v_req.branch_id);

  return v_req;
end;
$$;

create or replace function hr.reject_leave_request(p_id uuid, p_reason text default null)
returns hr.leave_requests
language plpgsql
security invoker
as $$
declare v_req hr.leave_requests;
begin
  if not core.has_perm('hr.leave.approve') then
    raise exception 'İzin onaylama yetkiniz yok' using errcode = '42501';
  end if;
  update hr.leave_requests
     set status = 'rejected', approver_id = core.current_user_id(),
         approved_at = now(), rejection_reason = p_reason
   where id = p_id and status = 'pending'
   returning * into v_req;
  if not found then
    raise exception 'Onay bekleyen talep bulunamadı' using errcode = 'P0002';
  end if;
  return v_req;
end;
$$;

-- İptal, onaylanmış izinde bakiyeyi geri verir.
create or replace function hr.cancel_leave_request(p_id uuid)
returns hr.leave_requests
language plpgsql
security invoker
as $$
declare
  v_req  hr.leave_requests;
  v_type hr.leave_types;
begin
  select * into v_req from hr.leave_requests where id = p_id for update;
  if not found then raise exception 'İzin talebi bulunamadı' using errcode = 'P0002'; end if;
  if v_req.status = 'cancelled' then return v_req; end if;

  if v_req.status = 'approved' then
    select * into v_type from hr.leave_types where id = v_req.leave_type_id;
    if v_type.consumes_balance then
      update hr.leave_balances
         set used_days = greatest(used_days - v_req.days, 0)
       where employee_id = v_req.employee_id
         and leave_type_id = v_req.leave_type_id
         and year = extract(year from v_req.date_from)::smallint;
    end if;
  end if;

  update hr.leave_requests set status = 'cancelled' where id = p_id returning * into v_req;
  return v_req;
end;
$$;

-- -----------------------------------------------------------------------------
-- Puantaj
-- -----------------------------------------------------------------------------
create or replace function hr.fn_calc_attendance()
returns trigger
language plpgsql
as $$
declare
  v_shift    hr.shifts;
  v_minutes  integer;
  v_expected integer;
begin
  if new.check_in is not null and new.check_out is not null then
    v_minutes := floor(extract(epoch from (new.check_out - new.check_in)) / 60)::integer;
    if new.shift_id is not null then
      select * into v_shift from hr.shifts where id = new.shift_id;
      v_minutes := v_minutes - coalesce(v_shift.break_minutes, 0);
      -- Gece vardiyası ertesi güne taşar: beklenen süre gün aşımıyla hesaplanır
      v_expected := case
        when v_shift.crosses_midnight
          then extract(epoch from (time '24:00' - v_shift.start_time) + (v_shift.end_time - time '00:00'))::integer / 60
        else extract(epoch from (v_shift.end_time - v_shift.start_time))::integer / 60
      end - coalesce(v_shift.break_minutes, 0);
      new.overtime_minutes := greatest(v_minutes - v_expected, 0);
    end if;
    new.worked_minutes := greatest(v_minutes, 0);
  end if;
  return new;
end;
$$;

drop trigger if exists trg_hr_attendance_calc on hr.attendance;
create trigger trg_hr_attendance_calc before insert or update of check_in, check_out, shift_id
  on hr.attendance for each row execute function hr.fn_calc_attendance();

-- -----------------------------------------------------------------------------
-- Bordro orkestrasyonu
-- -----------------------------------------------------------------------------
-- Bir çalışanın ilgili aydaki SGK eksik gün sayısı: ücretsiz izin gibi
-- SGK gününü düşüren onaylı izinlerin o aya düşen kısmı.
create or replace function hr.missing_days_for(p_employee_id uuid, p_year smallint, p_month smallint)
returns numeric
language sql
stable
security definer
set search_path = hr, pg_temp
as $$
  select coalesce(sum(
    (least(r.date_to, (make_date(p_year, p_month, 1) + interval '1 month - 1 day')::date)
     - greatest(r.date_from, make_date(p_year, p_month, 1))) + 1
  ), 0)::numeric
  from hr.leave_requests r
  join hr.leave_types t on t.id = r.leave_type_id
  where r.employee_id = p_employee_id
    and r.status = 'approved'
    and t.reduces_sgk_days
    and r.date_from <= (make_date(p_year, p_month, 1) + interval '1 month - 1 day')::date
    and r.date_to   >= make_date(p_year, p_month, 1);
$$;

-- Dönemden türeyen alanları veritabanı doldurur.
-- Bordro hem hr.create_payroll_run() ile hem de düz INSERT ile (API kaynak ucu,
-- içe aktarma betiği) oluşturulabildiği için, parametre setinin çözülmesi
-- fonksiyonda değil TETİKLEYİCİDE olmalı — yoksa INSERT yolundan gelen bordro
-- parametre seti olmadan doğar ve onay aşamasında anlamsız bir hatayla düşer.
create or replace function hr.fn_payroll_run_defaults()
returns trigger
language plpgsql
as $$
begin
  if new.date_from is null then
    new.date_from := make_date(new.period_year, new.period_month, 1);
  end if;
  if new.date_to is null then
    new.date_to := (make_date(new.period_year, new.period_month, 1)
                    + interval '1 month - 1 day')::date;
  end if;
  if new.parameter_set_id is null then
    new.parameter_set_id := hr.resolve_parameter_set(new.date_to, new.tenant_id);
  end if;
  return new;
end;
$$;

drop trigger if exists trg_hr_payroll_defaults on hr.payroll_runs;
create trigger trg_hr_payroll_defaults before insert on hr.payroll_runs
  for each row execute function hr.fn_payroll_run_defaults();

create or replace function hr.create_payroll_run(
  p_year smallint, p_month smallint, p_branch_id uuid default null
)
returns hr.payroll_runs
language plpgsql
security invoker
as $$
declare
  v_run hr.payroll_runs;
begin
  if not core.has_perm('hr.payroll.create') then
    raise exception 'Bordro oluşturma yetkiniz yok' using errcode = '42501';
  end if;

  -- Tarihler ve parametre seti trg_hr_payroll_defaults tarafından doldurulur.
  insert into hr.payroll_runs (branch_id, period_year, period_month)
  values (p_branch_id, p_year, p_month)
  returning * into v_run;

  return v_run;
end;
$$;

-- Hesaplama: taslak bordroyu SIFIRDAN üretir. Yeniden çalıştırmak güvenlidir —
-- bu yüzden "önce sil, sonra yaz". Onaylanmış bordro yeniden hesaplanmaz.
create or replace function hr.calculate_payroll_run(p_run_id uuid)
returns hr.payroll_runs
language plpgsql
security invoker
as $$
declare
  v_run  hr.payroll_runs;
  v_emp  record;
  v_slip hr.payslips;
  v_id   uuid;
  v_n    integer := 0;
begin
  select * into v_run from hr.payroll_runs where id = p_run_id for update;
  if not found then raise exception 'Bordro bulunamadı' using errcode = 'P0002'; end if;
  if v_run.status not in ('draft', 'calculated') then
    raise exception 'Onaylanmış bordro yeniden hesaplanamaz (mevcut: %)', v_run.status
      using errcode = '23514';
  end if;

  delete from hr.payslips where run_id = p_run_id;

  for v_emp in
    select e.id, e.branch_id
    from hr.employees e
    where e.tenant_id = v_run.tenant_id
      and (v_run.branch_id is null or e.branch_id = v_run.branch_id)
      and e.hire_date <= v_run.date_to
      and (e.termination_date is null or e.termination_date >= v_run.date_from)
      and exists (select 1 from hr.employee_contracts c
                   where c.employee_id = e.id
                     and c.valid_from <= v_run.date_to
                     and (c.valid_to is null or c.valid_to >= v_run.date_from))
    order by e.employee_no
  loop
    v_slip := hr.compute_payslip(
      v_emp.id, v_run.period_year, v_run.period_month,
      hr.missing_days_for(v_emp.id, v_run.period_year, v_run.period_month),
      0, 0, v_run.parameter_set_id);

    insert into hr.payslips (
      tenant_id, branch_id, run_id, employee_id, contract_id, sgk_days, missing_days,
      overtime_hours, base_gross, overtime_amount, bonus_amount, gross,
      sgk_base, sgk_employee, unemployment_employee,
      income_tax_base, cumulative_base_before, income_tax_gross, income_tax_exemption,
      income_tax, exempt_base_snapshot, stamp_tax_gross, stamp_tax_exemption, stamp_tax,
      other_deductions, net, sgk_employer, unemployment_employer, employer_cost)
    values (
      v_run.tenant_id, coalesce(v_slip.branch_id, v_emp.branch_id), p_run_id, v_emp.id,
      v_slip.contract_id, v_slip.sgk_days, v_slip.missing_days,
      v_slip.overtime_hours, v_slip.base_gross, v_slip.overtime_amount, v_slip.bonus_amount,
      v_slip.gross, v_slip.sgk_base, v_slip.sgk_employee, v_slip.unemployment_employee,
      v_slip.income_tax_base, v_slip.cumulative_base_before, v_slip.income_tax_gross,
      v_slip.income_tax_exemption, v_slip.income_tax, v_slip.exempt_base_snapshot,
      v_slip.stamp_tax_gross, v_slip.stamp_tax_exemption, v_slip.stamp_tax,
      coalesce(v_slip.other_deductions, 0), v_slip.net,
      v_slip.sgk_employer, v_slip.unemployment_employer, v_slip.employer_cost)
    returning id into v_id;

    -- Pusula dökümü: bordro ekranı ve muhasebe kaydı aynı satırlardan üretilir
    insert into hr.payslip_lines (tenant_id, payslip_id, seq, code, name, kind, base, rate, amount)
    values
      (v_run.tenant_id, v_id, 10, 'BRUT',      'Brüt ücret',            'earning',       null, null, v_slip.base_gross),
      (v_run.tenant_id, v_id, 20, 'MESAI',     'Fazla mesai',           'earning',       null, null, v_slip.overtime_amount),
      (v_run.tenant_id, v_id, 30, 'PRIM',      'Prim / ikramiye',       'earning',       null, null, v_slip.bonus_amount),
      (v_run.tenant_id, v_id, 40, 'SGK_ISCI',  'SGK işçi payı',         'deduction',     v_slip.sgk_base, null, v_slip.sgk_employee),
      (v_run.tenant_id, v_id, 50, 'ISSIZ_ISCI','İşsizlik işçi payı',    'deduction',     v_slip.sgk_base, null, v_slip.unemployment_employee),
      (v_run.tenant_id, v_id, 60, 'GV',        'Gelir vergisi',         'deduction',     v_slip.income_tax_base, null, v_slip.income_tax),
      (v_run.tenant_id, v_id, 70, 'DV',        'Damga vergisi',         'deduction',     v_slip.gross, null, v_slip.stamp_tax),
      (v_run.tenant_id, v_id, 80, 'SGK_ISVEREN','SGK işveren payı',     'employer_cost', v_slip.sgk_base, null, v_slip.sgk_employer),
      (v_run.tenant_id, v_id, 90, 'ISSIZ_ISVEREN','İşsizlik işveren payı','employer_cost', v_slip.sgk_base, null, v_slip.unemployment_employer),
      (v_run.tenant_id, v_id, 95, 'ISTISNA',   'Asgari ücret vergi istisnası', 'info',   null, null, v_slip.income_tax_exemption);

    v_n := v_n + 1;
  end loop;

  update hr.payroll_runs r
     set status = 'calculated',
         employee_count = v_n,
         total_gross = coalesce((select sum(p.gross) from hr.payslips p where p.run_id = p_run_id), 0),
         total_net = coalesce((select sum(p.net) from hr.payslips p where p.run_id = p_run_id), 0),
         total_employer_cost = coalesce((select sum(p.employer_cost) from hr.payslips p where p.run_id = p_run_id), 0)
   where r.id = p_run_id
   returning * into v_run;

  return v_run;
end;
$$;

create or replace function hr.approve_payroll_run(p_run_id uuid)
returns hr.payroll_runs
language plpgsql
security invoker
as $$
declare
  v_run hr.payroll_runs;
  v_set hr.payroll_parameter_sets;
begin
  if not core.has_perm('hr.payroll.approve') then
    raise exception 'Bordro onaylama yetkiniz yok' using errcode = '42501';
  end if;

  select * into v_run from hr.payroll_runs where id = p_run_id for update;
  if not found then raise exception 'Bordro bulunamadı' using errcode = 'P0002'; end if;
  if v_run.status <> 'calculated' then
    raise exception 'Yalnızca hesaplanmış bordro onaylanabilir (mevcut: %)', v_run.status
      using errcode = '23514';
  end if;
  if v_run.employee_count = 0 then
    raise exception 'Personeli olmayan bordro onaylanamaz' using errcode = '23514';
  end if;

  -- Teyit edilmemiş mevzuat parametresiyle bordro ONAYLANAMAZ. Hesaplanabilir
  -- (deneme/simülasyon için), ama resmî sonuç üretemez. Bordronun sessizce
  -- yanlış çıkmasının önündeki tek yapısal engel budur.
  select * into v_set from hr.payroll_parameter_sets where id = v_run.parameter_set_id;
  if v_set.id is null or not v_set.is_verified then
    raise exception 'Bordro parametre seti (%) teyit edilmemiş — onaylanamaz',
      coalesce(v_set.code, 'tanımsız')
      using errcode = '23514',
            hint = 'Resmî Gazete ile karşılaştırıp hr.payroll_parameter_sets.is_verified = true yapın.';
  end if;

  update hr.payroll_runs
     set status = 'approved', approved_at = now(), approved_by = core.current_user_id(),
         number = coalesce(number, core.next_sequence('hr_payroll', branch_id))
   where id = p_run_id returning * into v_run;

  -- Muhasebe modülü bu olayı dinler. İK, finance şemasını bilmez.
  perform core.emit_event('hr.payroll.approved', jsonb_build_object(
    'run_id', v_run.id, 'number', v_run.number,
    'period_year', v_run.period_year, 'period_month', v_run.period_month,
    'date_to', v_run.date_to,
    'total_gross', v_run.total_gross, 'total_net', v_run.total_net,
    'total_employer_cost', v_run.total_employer_cost,
    'employee_count', v_run.employee_count
  ), v_run.branch_id);

  return v_run;
end;
$$;

-- -----------------------------------------------------------------------------
-- Onaylanmış bordro değiştirilemez
-- -----------------------------------------------------------------------------
create or replace function hr.fn_lock_approved_payroll()
returns trigger
language plpgsql
as $$
begin
  if tg_op = 'DELETE' then
    if old.status in ('approved', 'posted') then
      raise exception 'Onaylanmış bordro silinemez (%)', old.number using errcode = '23514';
    end if;
    return old;
  end if;
  if old.status in ('approved', 'posted')
     and new.status = old.status
     and (new.total_gross, new.total_net, new.period_year, new.period_month)
         is distinct from (old.total_gross, old.total_net, old.period_year, old.period_month) then
    raise exception 'Onaylanmış bordronun tutarları değiştirilemez (%)', old.number
      using errcode = '23514';
  end if;
  return new;
end;
$$;

drop trigger if exists trg_hr_payroll_lock on hr.payroll_runs;
create trigger trg_hr_payroll_lock before update or delete on hr.payroll_runs
  for each row execute function hr.fn_lock_approved_payroll();

-- Onaylanmış bordronun pusulaları da dokunulmazdır
create or replace function hr.fn_lock_approved_payslip()
returns trigger
language plpgsql
as $$
declare v_status hr.payroll_status;
begin
  select status into v_status from hr.payroll_runs
   where id = coalesce(new.run_id, old.run_id);
  if v_status in ('approved', 'posted') then
    raise exception 'Onaylanmış bordronun pusulaları değiştirilemez' using errcode = '23514';
  end if;
  return coalesce(new, old);
end;
$$;

drop trigger if exists trg_hr_payslip_lock on hr.payslips;
create trigger trg_hr_payslip_lock before insert or update or delete on hr.payslips
  for each row execute function hr.fn_lock_approved_payslip();

-- -----------------------------------------------------------------------------
-- Olaylar
-- -----------------------------------------------------------------------------
select core.declare_event('hr.leave.requested',  'hr', 'İzin talebi onaya gönderildi');
select core.declare_event('hr.leave.approved',   'hr', 'İzin talebi onaylandı');
select core.declare_event('hr.payroll.approved', 'hr',
  'Bordro onaylandı — muhasebe tahakkuk kaydını bu olayla oluşturur',
  '{"run_id":"uuid","period_year":"int","period_month":"int","total_gross":"numeric","total_net":"numeric"}'::jsonb);
