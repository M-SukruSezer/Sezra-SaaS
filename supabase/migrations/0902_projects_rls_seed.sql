-- =============================================================================
-- 0902 — Proje: RLS, izinler, kiracı kurulumu
-- =============================================================================
select core.register_tenant_table('projects', 'projects',   'projects.project',   true, true);
select core.register_tenant_table('projects', 'tasks',      'projects.task',      true, true);
select core.register_tenant_table('projects', 'timesheets', 'projects.timesheet', true, true);

select core.declare_entity_permissions('projects', 'project',   'Proje');
select core.declare_entity_permissions('projects', 'task',      'Görev');
select core.declare_entity_permissions('projects', 'timesheet', 'Zaman kaydı');

select core.declare_permission('projects.project.complete', 'projects', 'projects.project',
       'approve', 'Projeyi kapat');
select core.declare_permission('projects.project.bill', 'projects', 'projects.project',
       'approve', 'Hakedişi faturala');
select core.declare_permission('projects.report.read', 'projects', 'projects.report',
       'read', 'Proje raporları');
-- Kârlılık AYRI izin: proje ekibi ilerlemeyi görmeli ama ekip arkadaşının
-- saatlik maliyetini (dolayısıyla maaşını) görmemelidir.
select core.declare_permission('projects.report.profitability', 'projects', 'projects.report',
       'read', 'Proje kârlılığı ve maliyet raporu');

select core.grant_module_to_role('tenant_admin', 'projects');

select core.grant_to_role('branch_manager', array[
  'projects.project.read.all','projects.project.write.all','projects.project.create',
  'projects.project.complete','projects.project.bill',
  'projects.task.read.all','projects.task.write.all','projects.task.create',
  'projects.timesheet.read.all','projects.timesheet.write.all','projects.timesheet.create',
  'projects.report.read','projects.report.profitability'
]);

-- Çalışan: projeyi ve görevlerini görür, KENDİ saatini girer.
-- Başkasının zaman kaydını göremez (.own kapsamı).
select core.grant_to_role('employee', array[
  'projects.project.read.all',
  'projects.task.read.all','projects.task.write.all',
  'projects.timesheet.read.own','projects.timesheet.write.own','projects.timesheet.create'
]);

-- Satış temsilcisi de projede çalışır ve saatini girer; kendi kaydını
-- görebilmelidir. Bunu atlamak, saatini giren ama listede göremeyen bir
-- kullanıcı üretirdi.
select core.grant_to_role('sales', array[
  'projects.project.read.all','projects.project.create','projects.project.write.own',
  'projects.task.read.all','projects.report.read',
  'projects.timesheet.read.own','projects.timesheet.write.own','projects.timesheet.create'
]);

select core.grant_to_role('accounting', array[
  'projects.project.read.all','projects.timesheet.read.all',
  'projects.report.read','projects.report.profitability'
]);

select core.grant_to_role('readonly', array[
  'projects.project.read.all','projects.task.read.all'
]);

create or replace function projects.provision_projects(p_tenant_id uuid)
returns void
language plpgsql
security definer
set search_path = projects, core, pg_temp
as $$
begin
  insert into core.sequences (tenant_id, code, prefix, padding, period)
  values (p_tenant_id, 'project_code', 'PRJ-', 4, 'year')
  on conflict do nothing;
end;
$$;

select core.register_provisioner('projects', 'projects.provision_projects', 70::smallint);
