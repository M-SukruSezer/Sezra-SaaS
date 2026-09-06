-- =============================================================================
-- 0302 — Bordro: belgeler ve hesaplama motoru
-- =============================================================================
-- Bordro, bu üründeki en yüksek riskli hesaplamadır: yanlışsa hem çalışan hem
-- işveren zarar görür ve hata aylar sonra fark edilir. Bu yüzden:
--
--   * Bordro pusulası TÜM ARA DEĞERLERİ saklar (SGK matrahı, kümülatif vergi
--     matrahı, uygulanan istisna). Sonradan "bu rakam nereden geldi" sorusu
--     yeniden hesaplamayla değil, kayda bakarak yanıtlanır.
--   * Her satır hr.payslip_lines'a ayrıca dökülür — bordro dökümü ve muhasebe
--     kaydı aynı kaynaktan üretilir.
--   * Hesaplama saf fonksiyondur: aynı girdi + aynı parametre seti = aynı çıktı.
--     Yeniden hesaplama, geçmişi sessizce değiştirmez; taslak bordroyu yeniler.
-- =============================================================================

create table if not exists hr.payroll_runs (
  id                uuid primary key default gen_random_uuid(),
  tenant_id         uuid not null references core.tenants(id) on delete cascade,
  branch_id         uuid references core.branches(id) on delete set null,
  number            text,
  period_year       smallint not null,
  period_month      smallint not null check (period_month between 1 and 12),
  date_from         date not null,
  date_to           date not null,
  payment_date      date,
  status            hr.payroll_status not null default 'draft',
  parameter_set_id  uuid references hr.payroll_parameter_sets(id),
  employee_count    integer not null default 0,
  total_gross       numeric(18,2) not null default 0,
  total_net         numeric(18,2) not null default 0,
  total_employer_cost numeric(18,2) not null default 0,
  approved_at       timestamptz,
  approved_by       uuid references core.users(id),
  posted_at         timestamptz,
  notes             text,
  owner_id          uuid references core.users(id),
  created_by        uuid references core.users(id),
  updated_by        uuid references core.users(id),
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now()
);

create unique index if not exists ux_hr_payroll_runs_period
  on hr.payroll_runs (tenant_id, coalesce(branch_id, '00000000-0000-0000-0000-000000000000'::uuid),
                      period_year, period_month)
  where status <> 'cancelled';

create table if not exists hr.payslips (
  id                    uuid primary key default gen_random_uuid(),
  tenant_id             uuid not null references core.tenants(id) on delete cascade,
  branch_id             uuid references core.branches(id) on delete set null,
  run_id                uuid not null references hr.payroll_runs(id) on delete cascade,
  employee_id           uuid not null references hr.employees(id),
  contract_id           uuid references hr.employee_contracts(id),
  -- Gün bilgisi
  sgk_days              numeric(6,2) not null default 30,
  missing_days          numeric(6,2) not null default 0,
  worked_hours          numeric(8,2),
  overtime_hours        numeric(8,2) not null default 0,
  -- Kazançlar
  base_gross            numeric(18,2) not null default 0,
  overtime_amount       numeric(18,2) not null default 0,
  bonus_amount          numeric(18,2) not null default 0,
  gross                 numeric(18,2) not null default 0,
  -- SGK
  sgk_base              numeric(18,2) not null default 0,
  sgk_employee          numeric(18,2) not null default 0,
  unemployment_employee numeric(18,2) not null default 0,
  -- Gelir vergisi
  income_tax_base       numeric(18,2) not null default 0,
  cumulative_base_before numeric(18,2) not null default 0,
  income_tax_gross      numeric(18,2) not null default 0,   -- istisna öncesi
  income_tax_exemption  numeric(18,2) not null default 0,   -- asgari ücret istisnası
  income_tax            numeric(18,2) not null default 0,   -- ödenecek
  -- İstisnanın kendi kümülatif takibi: bir sonraki ayın istisnası, bu ayın
  -- istisna matrahının üstüne biner. Ayrı kolon olmadan üst dilime geçen
  -- çalışanda istisna olduğundan büyük hesaplanırdı.
  exempt_base_snapshot  numeric(18,2) not null default 0,
  -- Damga vergisi
  stamp_tax_gross       numeric(18,2) not null default 0,
  stamp_tax_exemption   numeric(18,2) not null default 0,
  stamp_tax             numeric(18,2) not null default 0,
  other_deductions      numeric(18,2) not null default 0,
  net                   numeric(18,2) not null default 0,
  -- İşveren maliyeti
  sgk_employer          numeric(18,2) not null default 0,
  unemployment_employer numeric(18,2) not null default 0,
  employer_cost         numeric(18,2) not null default 0,
  created_by            uuid references core.users(id),
  updated_by            uuid references core.users(id),
  created_at            timestamptz not null default now(),
  updated_at            timestamptz not null default now()
);

create unique index if not exists ux_hr_payslips_run_employee
  on hr.payslips (run_id, employee_id);
create index if not exists ix_hr_payslips_employee
  on hr.payslips (tenant_id, employee_id);

create table if not exists hr.payslip_lines (
  id          uuid primary key default gen_random_uuid(),
  tenant_id   uuid not null references core.tenants(id) on delete cascade,
  payslip_id  uuid not null references hr.payslips(id) on delete cascade,
  seq         smallint not null default 0,
  code        text not null,
  name        text not null,
  kind        hr.payslip_line_kind not null,
  base        numeric(18,2),
  rate        numeric(9,6),
  amount      numeric(18,2) not null default 0,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);
create index if not exists ix_hr_payslip_lines_payslip on hr.payslip_lines (payslip_id, seq);

-- =============================================================================
-- Hesaplama yardımcıları
-- =============================================================================

-- Artan oranlı gelir vergisi: kümülatif matrahın neresinden başlanacağı önemli.
-- Dilim geçişi ay ortasında olabildiği için vergi, [cum_before, cum_before+base]
-- aralığının dilimlere düşen parçaları üzerinden ayrı ayrı hesaplanır.
create or replace function hr.income_tax(p_set_id uuid, p_cum_before numeric, p_base numeric)
returns numeric
language plpgsql
stable
security definer
set search_path = hr, pg_temp
as $$
declare
  r          record;
  v_lower    numeric := 0;
  v_from     numeric := p_cum_before;
  v_to       numeric := p_cum_before + p_base;
  v_tax      numeric := 0;
  v_seg_lo   numeric;
  v_seg_hi   numeric;
begin
  if p_base is null or p_base <= 0 then
    return 0;
  end if;

  for r in
    select seq, upper_limit, rate
    from hr.income_tax_brackets
    where set_id = p_set_id
    order by seq
  loop
    -- Bu dilimin [v_lower, upper_limit) aralığı ile hesap aralığının kesişimi
    v_seg_lo := greatest(v_from, v_lower);
    v_seg_hi := least(v_to, coalesce(r.upper_limit, v_to));
    if v_seg_hi > v_seg_lo then
      v_tax := v_tax + (v_seg_hi - v_seg_lo) * r.rate;
    end if;
    if r.upper_limit is null or r.upper_limit >= v_to then
      exit;
    end if;
    v_lower := r.upper_limit;
  end loop;

  return round(v_tax, 2);
end;
$$;

comment on function hr.income_tax(uuid, numeric, numeric) is
  'Kümülatif matrah pozisyonuna göre artan oranlı gelir vergisi. Dilim geçişini ay içinde doğru böler.';

-- Bir çalışanın yıl içindeki önceki bordrolarından gelen kümülatif matrah.
create or replace function hr.cumulative_tax_base(
  p_employee_id uuid, p_year smallint, p_month smallint, p_column text default 'income_tax_base'
)
returns numeric
language plpgsql
stable
security definer
set search_path = hr, pg_temp
as $$
declare v numeric;
begin
  execute format($q$
    select coalesce(sum(p.%I), 0)
    from hr.payslips p
    join hr.payroll_runs r on r.id = p.run_id
    where p.employee_id = $1
      and r.period_year = $2
      and r.period_month < $3
      and r.status <> 'cancelled'
  $q$, p_column)
  into v using p_employee_id, p_year, p_month;
  return coalesce(v, 0);
end;
$$;

-- =============================================================================
-- Tek çalışan için bordro hesabı
-- =============================================================================
-- Saf fonksiyon: hiçbir şey yazmaz, hesaplanmış pusulayı kayıt olarak döndürür.
-- Böylece hem bordro çalıştırması hem de "maaş simülasyonu" ekranı aynı motoru
-- kullanır ve ikisinin sonucu ayrışamaz.
create or replace function hr.compute_payslip(
  p_employee_id uuid,
  p_year        smallint,
  p_month       smallint,
  p_missing_days numeric default 0,
  p_overtime_hours numeric default 0,
  p_bonus       numeric default 0,
  p_set_id      uuid default null
)
returns hr.payslips
language plpgsql
stable
security definer
set search_path = hr, core, pg_temp
as $$
declare
  s            hr.payslips;
  v_emp        hr.employees;
  v_con        hr.employee_contracts;
  v_set        uuid;
  v_period_end date := (make_date(p_year, p_month, 1) + interval '1 month - 1 day')::date;
  v_days_month numeric;
  v_min_wage   numeric;
  v_min_wage_prorated numeric;
  v_ceiling    numeric;
  v_floor      numeric;
  v_sgk_emp_rate numeric;
  v_unemp_emp_rate numeric;
  v_hourly     numeric;
  v_exempt_base numeric;
  v_exempt_cum  numeric;
  v_disability  numeric;
begin
  select * into v_emp from hr.employees where id = p_employee_id;
  if not found then
    raise exception 'Personel bulunamadı: %', p_employee_id using errcode = 'no_data_found';
  end if;

  v_set := coalesce(p_set_id, hr.resolve_parameter_set(v_period_end, v_emp.tenant_id));
  if v_set is null then
    raise exception 'ise % dönemi için bordro parametre seti tanımlı değil',
      to_char(v_period_end, 'YYYY-MM')
      using errcode = '22023',
            hint = 'hr.payroll_parameter_sets tablosuna ilgili yılın setini ekleyin.';
  end if;

  -- Dönem sonunda yürürlükteki sözleşme. Zam geçmişi bozmasın diye tarih
  -- bazlı seçiliyor (bkz. 0300 tasarım kararı 3).
  select * into v_con
  from hr.employee_contracts c
  where c.employee_id = p_employee_id
    and c.valid_from <= v_period_end
    and (c.valid_to is null or c.valid_to >= make_date(p_year, p_month, 1))
  order by c.valid_from desc
  limit 1;
  if not found then
    raise exception 'Personelin % dönemi için yürürlükte sözleşmesi yok (%)',
      to_char(v_period_end, 'YYYY-MM'), v_emp.employee_no using errcode = '22023';
  end if;

  v_days_month := hr.param(v_set, 'payroll_days_per_month');
  v_min_wage   := hr.param(v_set, 'minimum_wage_gross_monthly');

  s.tenant_id    := v_emp.tenant_id;
  s.branch_id    := coalesce(v_con.branch_id, v_emp.branch_id);
  s.employee_id  := p_employee_id;
  s.contract_id  := v_con.id;
  s.missing_days := greatest(coalesce(p_missing_days, 0), 0);
  s.sgk_days     := greatest(v_days_month - s.missing_days, 0);

  -- Emekli çalışanda SGDP oranları geçerli
  if v_con.is_pensioner then
    v_sgk_emp_rate   := hr.param(v_set, 'sgdp_employee_rate');
    v_unemp_emp_rate := 0;   -- emekliden işsizlik primi kesilmez
  else
    v_sgk_emp_rate   := hr.param(v_set, 'sgk_employee_rate');
    v_unemp_emp_rate := hr.param(v_set, 'unemployment_employee_rate');
  end if;

  -- --- Brüt kazanç ---------------------------------------------------------
  if v_con.wage_basis = 'net' then
    -- Net anlaşmada brüt, motorun tersinden çözülür (aşağıdaki gross_from_net).
    s.base_gross := round(hr.gross_from_net(v_con.wage_amount, p_employee_id, p_year, p_month,
                                            s.missing_days, v_set), 2);
  else
    s.base_gross := case v_con.wage_period
      when 'month' then round(v_con.wage_amount * s.sgk_days / v_days_month, 2)
      when 'day'   then round(v_con.wage_amount * s.sgk_days, 2)
      when 'hour'  then round(v_con.wage_amount * coalesce(v_con.weekly_hours, 45) * 52 / 12
                              * s.sgk_days / v_days_month, 2)
    end;
  end if;

  -- Fazla mesai: saatlik ücretin %50 zamlısı (4857/41). Zam oranı da
  -- parametreleştirildi ki toplu sözleşmeyle değişebilsin.
  v_hourly := case
    when v_con.wage_period = 'hour' then v_con.wage_amount
    else v_con.wage_amount / (coalesce(nullif(v_con.weekly_hours, 0), 45) * 52 / 12)
  end;
  s.overtime_hours  := coalesce(p_overtime_hours, 0);
  s.overtime_amount := round(v_hourly * s.overtime_hours
                             * hr.param_or(v_set, 'overtime_multiplier', 1.5), 2);
  s.bonus_amount    := coalesce(p_bonus, 0);
  s.gross           := s.base_gross + s.overtime_amount + s.bonus_amount;

  -- --- SGK -----------------------------------------------------------------
  v_min_wage_prorated := round(v_min_wage * s.sgk_days / v_days_month, 2);
  v_floor   := v_min_wage_prorated;
  v_ceiling := round(v_min_wage * hr.param(v_set, 'sgk_base_ceiling_multiplier')
                     * s.sgk_days / v_days_month, 2);

  s.sgk_base := least(greatest(s.gross, v_floor), v_ceiling);
  s.sgk_employee          := round(s.sgk_base * v_sgk_emp_rate, 2);
  s.unemployment_employee := round(s.sgk_base * v_unemp_emp_rate, 2);

  -- --- Gelir vergisi -------------------------------------------------------
  -- Engellilik indirimi matrahtan düşer (derece bazlı tutar parametreden).
  v_disability := case coalesce(v_con.disability_degree, 0)
    when 1 then hr.param_or(v_set, 'disability_discount_degree_1', 0)
    when 2 then hr.param_or(v_set, 'disability_discount_degree_2', 0)
    when 3 then hr.param_or(v_set, 'disability_discount_degree_3', 0)
    else 0
  end;

  s.income_tax_base := greatest(
    s.gross - s.sgk_employee - s.unemployment_employee - v_disability, 0);
  s.cumulative_base_before := hr.cumulative_tax_base(p_employee_id, p_year, p_month);
  s.income_tax_gross := hr.income_tax(v_set, s.cumulative_base_before, s.income_tax_base);

  -- Asgari ücret istisnası: asgari ücretli bir çalışanın ödeyeceği vergi kadarı
  -- istisna edilir. İstisnanın KENDİ kümülatif takibi vardır — aksi halde üst
  -- dilime geçen bir çalışanda istisna olduğundan büyük hesaplanırdı.
  if hr.param_or(v_set, 'minimum_wage_exemption_enabled', 0) = 1 then
    v_exempt_base := least(
      s.income_tax_base,
      round(v_min_wage_prorated * (1 - v_sgk_emp_rate - v_unemp_emp_rate), 2));
    v_exempt_cum := hr.cumulative_tax_base(p_employee_id, p_year, p_month, 'exempt_base_snapshot');
    s.income_tax_exemption := least(
      hr.income_tax(v_set, v_exempt_cum, v_exempt_base),
      s.income_tax_gross);
    s.exempt_base_snapshot := v_exempt_base;
  else
    s.income_tax_exemption := 0;
    s.exempt_base_snapshot := 0;
  end if;

  s.income_tax := greatest(s.income_tax_gross - s.income_tax_exemption, 0);

  -- --- Damga vergisi -------------------------------------------------------
  if v_con.is_exempt_from_stamp_tax then
    s.stamp_tax_gross := 0;
    s.stamp_tax_exemption := 0;
  else
    s.stamp_tax_gross := round(s.gross * hr.param(v_set, 'stamp_tax_rate'), 2);
    s.stamp_tax_exemption := case
      when hr.param_or(v_set, 'minimum_wage_exemption_enabled', 0) = 1
      then least(round(v_min_wage_prorated * hr.param(v_set, 'stamp_tax_rate'), 2), s.stamp_tax_gross)
      else 0 end;
  end if;
  s.stamp_tax := greatest(s.stamp_tax_gross - s.stamp_tax_exemption, 0);

  -- --- Net ve işveren maliyeti --------------------------------------------
  s.net := s.gross - s.sgk_employee - s.unemployment_employee
           - s.income_tax - s.stamp_tax - coalesce(s.other_deductions, 0);

  if v_con.is_pensioner then
    s.sgk_employer := round(s.sgk_base * hr.param(v_set, 'sgdp_employer_rate'), 2);
    s.unemployment_employer := 0;
  else
    s.sgk_employer := round(s.sgk_base * (
      hr.param(v_set, 'sgk_employer_rate')
      - case when v_con.sgk_discount_5510 then hr.param(v_set, 'sgk_employer_discount_rate') else 0 end
    ), 2);
    s.unemployment_employer := round(s.sgk_base * hr.param(v_set, 'unemployment_employer_rate'), 2);
  end if;

  s.employer_cost := s.gross + s.sgk_employer + s.unemployment_employer;
  return s;
end;
$$;

-- Net anlaşmalı sözleşmede brütü bulur.
-- Analitik çözüm yok: vergi dilimi geçişi ve istisna tavanı fonksiyonu parçalı
-- yapıyor. İkili arama, 0,01 TL hassasiyete ~30 adımda ulaşır ve dilim
-- geçişlerinde de doğru sonucu verir.
create or replace function hr.gross_from_net(
  p_net numeric, p_employee_id uuid, p_year smallint, p_month smallint,
  p_missing_days numeric default 0, p_set_id uuid default null
)
returns numeric
language plpgsql
stable
security definer
set search_path = hr, pg_temp
as $$
declare
  v_lo    numeric := p_net;
  v_hi    numeric := p_net * 3;
  v_mid   numeric;
  v_net   numeric;
  i       integer := 0;
begin
  while i < 40 and (v_hi - v_lo) > 0.005 loop
    v_mid := (v_lo + v_hi) / 2;
    v_net := hr.net_from_gross(v_mid, p_employee_id, p_year, p_month, p_missing_days, p_set_id);
    if v_net < p_net then v_lo := v_mid; else v_hi := v_mid; end if;
    i := i + 1;
  end loop;
  return round((v_lo + v_hi) / 2, 2);
end;
$$;

-- Verilen brüt için net. compute_payslip ile aynı kuralları uygular ama
-- sözleşmeyi okumaz (sonsuz döngü olurdu) — yalnızca ikili aramanın içi.
create or replace function hr.net_from_gross(
  p_gross numeric, p_employee_id uuid, p_year smallint, p_month smallint,
  p_missing_days numeric default 0, p_set_id uuid default null
)
returns numeric
language plpgsql
stable
security definer
set search_path = hr, core, pg_temp
as $$
declare
  v_set        uuid;
  v_tenant     uuid;
  v_period_end date := (make_date(p_year, p_month, 1) + interval '1 month - 1 day')::date;
  v_days       numeric;
  v_min_wage   numeric;
  v_min_pro    numeric;
  v_sgk_days   numeric;
  v_sgk_base   numeric;
  v_sgk_e      numeric;
  v_un_e       numeric;
  v_base       numeric;
  v_cum        numeric;
  v_tax        numeric;
  v_exempt     numeric;
  v_stamp      numeric;
begin
  select tenant_id into v_tenant from hr.employees where id = p_employee_id;
  v_set      := coalesce(p_set_id, hr.resolve_parameter_set(v_period_end, v_tenant));
  v_days     := hr.param(v_set, 'payroll_days_per_month');
  v_min_wage := hr.param(v_set, 'minimum_wage_gross_monthly');
  v_sgk_days := greatest(v_days - coalesce(p_missing_days, 0), 0);
  v_min_pro  := round(v_min_wage * v_sgk_days / v_days, 2);

  v_sgk_base := least(greatest(p_gross, v_min_pro),
                      round(v_min_wage * hr.param(v_set, 'sgk_base_ceiling_multiplier')
                            * v_sgk_days / v_days, 2));
  v_sgk_e := round(v_sgk_base * hr.param(v_set, 'sgk_employee_rate'), 2);
  v_un_e  := round(v_sgk_base * hr.param(v_set, 'unemployment_employee_rate'), 2);

  v_base := greatest(p_gross - v_sgk_e - v_un_e, 0);
  v_cum  := hr.cumulative_tax_base(p_employee_id, p_year, p_month);
  v_tax  := hr.income_tax(v_set, v_cum, v_base);

  if hr.param_or(v_set, 'minimum_wage_exemption_enabled', 0) = 1 then
    v_exempt := least(
      hr.income_tax(v_set,
        hr.cumulative_tax_base(p_employee_id, p_year, p_month, 'exempt_base_snapshot'),
        least(v_base, round(v_min_pro * (1 - hr.param(v_set, 'sgk_employee_rate')
                                           - hr.param(v_set, 'unemployment_employee_rate')), 2))),
      v_tax);
  else
    v_exempt := 0;
  end if;

  v_stamp := greatest(
    round(p_gross * hr.param(v_set, 'stamp_tax_rate'), 2)
    - case when hr.param_or(v_set, 'minimum_wage_exemption_enabled', 0) = 1
           then round(v_min_pro * hr.param(v_set, 'stamp_tax_rate'), 2) else 0 end, 0);

  return p_gross - v_sgk_e - v_un_e - greatest(v_tax - v_exempt, 0) - v_stamp;
end;
$$;
