-- =============================================================================
-- 0702 — Bakım: RLS, izinler, kiracı kurulumu
-- =============================================================================
select core.register_tenant_table('maintenance', 'equipment',   'maintenance.equipment', true,  true);
select core.register_tenant_table('maintenance', 'plans',        'maintenance.plan',      false, false);
select core.register_tenant_table('maintenance', 'work_orders',  'maintenance.workorder', true,  true);

do $$
declare v record;
begin
  for v in select * from (values
      ('plan_tasks',       'plans',       'plan_id'),
      ('work_order_tasks', 'work_orders', 'work_order_id'),
      ('work_order_parts', 'work_orders', 'work_order_id')
    ) as t(child, parent, fk)
  loop
    execute format('alter table maintenance.%I enable row level security', v.child);
    execute format('alter table maintenance.%I force row level security', v.child);
    execute format('drop policy if exists p_%s_all on maintenance.%I', v.child, v.child);
    execute format($p$create policy p_%1$s_all on maintenance.%1$I for all
        using (exists (select 1 from maintenance.%2$I h where h.id = %3$I))
        with check (exists (select 1 from maintenance.%2$I h where h.id = %3$I))$p$,
      v.child, v.parent, v.fk);
    execute format('create index if not exists ix_%1$s_tenant on maintenance.%1$I (tenant_id)', v.child);
    perform core.attach_updated_at('maintenance', v.child);
    perform core.attach_row_defaults('maintenance', v.child);
    perform core.attach_audit('maintenance', v.child);
  end loop;
end $$;

-- -----------------------------------------------------------------------------
-- İzinler
-- -----------------------------------------------------------------------------
select core.declare_entity_permissions('maintenance', 'equipment', 'Ekipman');
select core.declare_entity_permissions('maintenance', 'plan',      'Bakım planı', false);
select core.declare_entity_permissions('maintenance', 'workorder', 'İş emri');

select core.declare_permission('maintenance.workorder.complete', 'maintenance',
       'maintenance.workorder', 'approve', 'İş emrini tamamla');
select core.declare_permission('maintenance.report.read', 'maintenance',
       'maintenance.report', 'read', 'Bakım ve duruş raporları');

select core.grant_module_to_role('tenant_admin', 'maintenance');

-- Şube müdürü: kendi şubesinin makinelerinden sorumlu. Arıza bildirir,
-- iş emrini yürütür ve kapatır.
select core.grant_to_role('branch_manager', array[
  'maintenance.equipment.read.all','maintenance.equipment.write.all','maintenance.equipment.create',
  'maintenance.plan.read.all',
  'maintenance.workorder.read.all','maintenance.workorder.write.all',
  'maintenance.workorder.create','maintenance.workorder.complete',
  'maintenance.report.read'
]);

select core.grant_to_role('warehouse', array[
  'maintenance.equipment.read.all',
  'maintenance.workorder.read.all','maintenance.workorder.write.all',
  'maintenance.workorder.create','maintenance.workorder.complete',
  'maintenance.plan.read.all','maintenance.report.read'
]);

-- Muhasebe: bakım maliyeti gider kalemidir.
select core.grant_to_role('accounting', array[
  'maintenance.equipment.read.all','maintenance.workorder.read.all','maintenance.report.read'
]);

-- Çalışan öz servisi: arıza bildirebilir (operatör makinenin bozulduğunu görür),
-- ama iş emrini kapatamaz.
select core.grant_to_role('employee', array[
  'maintenance.equipment.read.all',
  'maintenance.workorder.read.all','maintenance.workorder.create'
]);

select core.grant_to_role('readonly', array[
  'maintenance.equipment.read.all','maintenance.workorder.read.all'
]);

-- -----------------------------------------------------------------------------
-- Kurulum kancası
-- -----------------------------------------------------------------------------
create or replace function maintenance.provision_maintenance(p_tenant_id uuid)
returns void
language plpgsql
security definer
set search_path = maintenance, core, pg_temp
as $$
begin
  insert into core.sequences (tenant_id, code, prefix, padding, period)
  values (p_tenant_id, 'maintenance_work_order', 'BKM-', 6, 'year')
  on conflict do nothing;
end;
$$;

select core.register_provisioner('maintenance', 'maintenance.provision_maintenance', 60::smallint);
