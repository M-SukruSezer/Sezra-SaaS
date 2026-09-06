-- =============================================================================
-- 0304 — İK: RLS, izinler, kiracı kurulumu
-- =============================================================================

-- -----------------------------------------------------------------------------
-- RLS — kiracıya ait tablolar
-- -----------------------------------------------------------------------------
select core.register_tenant_table('hr', 'departments',        'hr.department', true,  false);
select core.register_tenant_table('hr', 'positions',          'hr.position',   false, false);
select core.register_tenant_table('hr', 'employees',          'hr.employee',   true,  true);
select core.register_tenant_table('hr', 'employee_contracts', 'hr.contract',   true,  false);
select core.register_tenant_table('hr', 'leave_types',        'hr.leave_type', false, false);
select core.register_tenant_table('hr', 'leave_balances',     'hr.balance',    false, false);
select core.register_tenant_table('hr', 'leave_requests',     'hr.leave',      true,  true);
select core.register_tenant_table('hr', 'shifts',             'hr.shift',      true,  false);
select core.register_tenant_table('hr', 'attendance',         'hr.attendance', true,  false);
select core.register_tenant_table('hr', 'holidays',           'hr.holiday',    true,  false);
select core.register_tenant_table('hr', 'payroll_runs',       'hr.payroll',    true,  true);

-- Pusula ve satırları yetkiyi bordrodan devralır (0202'deki kalıp).
do $$
declare v record;
begin
  for v in select * from (values
      ('payslips',      'payroll_runs', 'run_id'),
      ('payslip_lines', 'payslips',     'payslip_id')
    ) as t(child, parent, fk)
  loop
    execute format('alter table hr.%I enable row level security', v.child);
    execute format('alter table hr.%I force row level security', v.child);
    execute format('drop policy if exists p_%s_all on hr.%I', v.child, v.child);
    execute format($p$create policy p_%1$s_all on hr.%1$I for all
        using (exists (select 1 from hr.%2$I h where h.id = %3$I))
        with check (exists (select 1 from hr.%2$I h where h.id = %3$I))$p$,
      v.child, v.parent, v.fk);
    execute format('create index if not exists ix_%1$s_tenant on hr.%1$I (tenant_id)', v.child);
    perform core.attach_updated_at('hr', v.child);
    perform core.attach_row_defaults('hr', v.child);
    perform core.attach_audit('hr', v.child);
  end loop;
end $$;

-- -----------------------------------------------------------------------------
-- RLS — mevzuat parametreleri
-- -----------------------------------------------------------------------------
-- Bu tablolar iki tür satır taşır: platform geneli (tenant_id null) ve kiracıya
-- özel. Platform genelini HERKES okuyabilir (mevzuat gizli değil), yalnızca
-- platform yöneticisi yazabilir. Kiracıya özel satırlarda normal izolasyon.
alter table hr.payroll_parameter_sets enable row level security;
alter table hr.payroll_parameter_sets force row level security;

drop policy if exists p_param_sets_select on hr.payroll_parameter_sets;
create policy p_param_sets_select on hr.payroll_parameter_sets for select
  using (tenant_id is null or tenant_id = (select core.current_tenant_id()));

drop policy if exists p_param_sets_write on hr.payroll_parameter_sets;
create policy p_param_sets_write on hr.payroll_parameter_sets for all
  using (
    (tenant_id is null and (select core.is_platform_admin()))
    or (tenant_id = (select core.current_tenant_id()) and (select core.has_perm('hr.payroll_param.write.all')))
  )
  with check (
    (tenant_id is null and (select core.is_platform_admin()))
    or (tenant_id = (select core.current_tenant_id()) and (select core.has_perm('hr.payroll_param.write.all')))
  );

-- Parametre ve dilim satırları görünürlüğü setten devralır.
do $$
declare v text;
begin
  foreach v in array array['payroll_parameters', 'income_tax_brackets'] loop
    execute format('alter table hr.%I enable row level security', v);
    execute format('alter table hr.%I force row level security', v);
    execute format('drop policy if exists p_%s_select on hr.%I', v, v);
    execute format($p$create policy p_%1$s_select on hr.%1$I for select
        using (exists (select 1 from hr.payroll_parameter_sets s where s.id = set_id))$p$, v);
    execute format('drop policy if exists p_%s_write on hr.%I', v, v);
    execute format($p$create policy p_%1$s_write on hr.%1$I for all
        using (exists (select 1 from hr.payroll_parameter_sets s
                       where s.id = set_id
                         and (case when s.tenant_id is null then (select core.is_platform_admin())
                                   else (select core.has_perm('hr.payroll_param.write.all')) end)))
        with check (exists (select 1 from hr.payroll_parameter_sets s
                       where s.id = set_id
                         and (case when s.tenant_id is null then (select core.is_platform_admin())
                                   else (select core.has_perm('hr.payroll_param.write.all')) end)))$p$, v);
  end loop;
end $$;

-- -----------------------------------------------------------------------------
-- İzinler
-- -----------------------------------------------------------------------------
select core.declare_entity_permissions('hr', 'department', 'Departman', false);
select core.declare_entity_permissions('hr', 'position',   'Pozisyon',  false);
select core.declare_entity_permissions('hr', 'employee',   'Personel');
-- Sözleşme = ÜCRET. Ayrı izin olmasının sebebi 0300'deki 2 numaralı karar.
select core.declare_entity_permissions('hr', 'contract',   'Sözleşme ve ücret', false);
select core.declare_entity_permissions('hr', 'leave_type', 'İzin tipi', false);
select core.declare_entity_permissions('hr', 'balance',    'İzin bakiyesi', false);
select core.declare_entity_permissions('hr', 'leave',      'İzin talebi');
select core.declare_entity_permissions('hr', 'shift',      'Vardiya', false);
select core.declare_entity_permissions('hr', 'attendance', 'Puantaj', false);
select core.declare_entity_permissions('hr', 'holiday',    'Resmî tatil', false);
select core.declare_entity_permissions('hr', 'payroll',    'Bordro');
select core.declare_entity_permissions('hr', 'payroll_param', 'Bordro parametreleri', false);

select core.declare_permission('hr.leave.approve',       'hr', 'hr.leave',   'approve', 'İzin talebi onayla/reddet');
select core.declare_permission('hr.leave.override',      'hr', 'hr.leave',   'approve', 'Bakiye yetersizken de izin onayla');
select core.declare_permission('hr.leave.self_approve',  'hr', 'hr.leave',   'approve', 'Kendi izin talebini onaylayabilir');
select core.declare_permission('hr.payroll.approve',     'hr', 'hr.payroll', 'approve', 'Bordro onayla (tahakkuk)');
select core.declare_permission('hr.report.read',         'hr', 'hr.report',  'read',    'İK raporları');
select core.declare_permission('hr.report.payroll_cost', 'hr', 'hr.report',  'read',    'Bordro maliyet raporu (ücret görünür)');

-- -----------------------------------------------------------------------------
-- Rollere dağıtım
-- -----------------------------------------------------------------------------
select core.grant_module_to_role('tenant_admin', 'hr');

-- grant_module_to_role modülün TÜM izinlerini verir; self_approve'u geri alıyoruz.
-- Görevler ayrılığı: kendi izin talebini onaylamak bir kontrolü ortadan kaldırır
-- ve varsayılan olarak kimsede olmamalıdır — şirket yöneticisinde bile. İzin
-- kodu duruyor: tek kişilik işletmede kiracı bunu kendi rolüne ekleyebilir.
delete from core.role_permissions rp
using core.roles r
where rp.role_id = r.id and r.tenant_id is null and r.code = 'tenant_admin'
  and rp.permission_code = 'hr.leave.self_approve';

select core.grant_to_role('hr_officer', array[
  'hr.department.read.all','hr.department.write.all','hr.department.create',
  'hr.position.read.all','hr.position.write.all','hr.position.create',
  'hr.employee.read.all','hr.employee.write.all','hr.employee.create',
  'hr.contract.read.all','hr.contract.write.all','hr.contract.create',
  'hr.leave_type.read.all','hr.leave_type.write.all','hr.leave_type.create',
  'hr.balance.read.all','hr.balance.write.all','hr.balance.create',
  'hr.leave.read.all','hr.leave.write.all','hr.leave.create','hr.leave.approve','hr.leave.override',
  'hr.shift.read.all','hr.shift.write.all','hr.shift.create',
  'hr.attendance.read.all','hr.attendance.write.all','hr.attendance.create',
  'hr.holiday.read.all','hr.holiday.write.all','hr.holiday.create',
  'hr.payroll.read.all','hr.payroll.write.all','hr.payroll.create','hr.payroll.approve',
  'hr.report.read','hr.report.payroll_cost'
]);

-- Şube müdürü ekibini yönetir ama ÜCRET GÖRMEZ: hr.contract.* ve
-- hr.report.payroll_cost listede yok. Bordro maliyetini toplu görmesi gereken
-- şube müdürüne bu izin tek tek verilebilir.
select core.grant_to_role('branch_manager', array[
  'hr.department.read.all','hr.position.read.all',
  'hr.employee.read.all',
  'hr.leave_type.read.all','hr.balance.read.all',
  -- write.all ŞART: onay/ret/iptal satırı günceller ve `select ... for update`
  -- PostgreSQL'de SELECT politikasına EK OLARAK UPDATE politikasının da
  -- geçmesini ister. Yalnızca approve verilseydi şube müdürü hiçbir talebi
  -- onaylayamaz, "izin talebi bulunamadı" hatası alırdı.
  'hr.leave.read.all','hr.leave.write.all','hr.leave.create','hr.leave.approve',
  'hr.shift.read.all','hr.shift.write.all','hr.shift.create',
  'hr.attendance.read.all','hr.attendance.write.all','hr.attendance.create',
  'hr.holiday.read.all',
  'hr.report.read'
]);

select core.grant_to_role('readonly', array[
  'hr.department.read.all','hr.position.read.all','hr.employee.read.all',
  'hr.leave_type.read.all','hr.holiday.read.all'
]);

-- Öz-servis rolü: çalışan kendi izin talebini açar, kendi puantajını görür.
-- Bölüm 3.4'teki hiyerarşide "Departman Kullanıcısı"nın İK karşılığı budur.
select core.declare_system_role('employee', 'Çalışan (öz servis)', 60::smallint,
  'Kendi izin talebi, kendi bordro pusulası ve kendi puantajı');
select core.grant_to_role('employee', array[
  'hr.employee.read.own',
  'hr.leave.read.own','hr.leave.write.own','hr.leave.create',
  'hr.leave_type.read.all','hr.holiday.read.all','hr.balance.read.all'
]);

-- -----------------------------------------------------------------------------
-- Kurulum kancası
-- -----------------------------------------------------------------------------
create or replace function hr.provision_hr(p_tenant_id uuid)
returns void
language plpgsql
security definer
set search_path = hr, core, pg_temp
as $$
declare
  v_year integer := extract(year from current_date)::integer;
  r      record;
begin
  -- İzin tipleri
  insert into hr.leave_types (tenant_id, code, name, is_paid, consumes_balance,
                              requires_approval, reduces_sgk_days, max_days_per_year)
  values
    (p_tenant_id, 'YILLIK',   'Yıllık ücretli izin', true,  true,  true,  false, null),
    (p_tenant_id, 'MAZERET',  'Mazeret izni',        true,  false, true,  false, 5),
    (p_tenant_id, 'RAPOR',    'İstirahat raporu',    true,  false, false, false, null),
    (p_tenant_id, 'UCRETSIZ', 'Ücretsiz izin',       false, false, true,  true,  null),
    (p_tenant_id, 'DOGUM',    'Doğum izni',          true,  false, true,  false, null),
    (p_tenant_id, 'EVLILIK',  'Evlilik izni',        true,  false, true,  false, 3)
  on conflict (tenant_id, code) do nothing;

  -- Vardiyalar: vardiyalı çalışma varsayılanı (örnek kiracı senaryosu)
  insert into hr.shifts (tenant_id, code, name, start_time, end_time, break_minutes)
  values
    (p_tenant_id, 'SABAH', 'Sabah vardiyası', time '07:00', time '15:00', 45),
    (p_tenant_id, 'AKSAM', 'Akşam vardiyası', time '15:00', time '23:00', 45),
    (p_tenant_id, 'TAMGUN','Tam gün',         time '09:00', time '18:00', 60)
  on conflict (tenant_id, code) do nothing;

  -- Sabit tarihli resmî tatiller. DİNÎ BAYRAMLAR her yıl kaydığı için burada
  -- yok — kiracı ilgili yılın tarihlerini İK ekranından ekler.
  for r in
    select * from (values
      ('01-01', 'Yılbaşı'),
      ('04-23', 'Ulusal Egemenlik ve Çocuk Bayramı'),
      ('05-01', 'Emek ve Dayanışma Günü'),
      ('05-19', 'Atatürk''ü Anma, Gençlik ve Spor Bayramı'),
      ('07-15', 'Demokrasi ve Millî Birlik Günü'),
      ('08-30', 'Zafer Bayramı'),
      ('10-29', 'Cumhuriyet Bayramı')
    ) as x(md, name)
  loop
    insert into hr.holidays (tenant_id, holiday_date, name)
    values (p_tenant_id, to_date(v_year || '-' || r.md, 'YYYY-MM-DD'), r.name)
    on conflict do nothing;
  end loop;

  -- Belge numarası
  insert into core.sequences (tenant_id, code, prefix, padding, period)
  values (p_tenant_id, 'hr_payroll', 'BOR-', 6, 'year')
  on conflict do nothing;
end;
$$;

select core.register_provisioner('hr', 'hr.provision_hr', 40::smallint);
