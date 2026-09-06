-- =============================================================================
-- 0602 — Kalite: RLS, izinler, kiracı kurulumu
-- =============================================================================
-- Yetki dağıtımında 0402'deki kural geçerli: `select ... for update` yapan bir
-- eylem, ilgili varlıkta write izni de ister.
--   * inspection.complete  -> quality.inspection.write.all şart
--   * nonconformity.decide -> quality.nonconformity.write.all şart

select core.register_tenant_table('quality', 'plans',           'quality.plan',           false, false);
select core.register_tenant_table('quality', 'inspections',     'quality.inspection',     true,  true);
select core.register_tenant_table('quality', 'nonconformities', 'quality.nonconformity',  true,  true);

-- Alt tablolar yetkiyi başlıktan devralır
do $$
declare v record;
begin
  for v in select * from (values
      ('check_points', 'plans',       'plan_id'),
      ('results',      'inspections', 'inspection_id')
    ) as t(child, parent, fk)
  loop
    execute format('alter table quality.%I enable row level security', v.child);
    execute format('alter table quality.%I force row level security', v.child);
    execute format('drop policy if exists p_%s_all on quality.%I', v.child, v.child);
    execute format($p$create policy p_%1$s_all on quality.%1$I for all
        using (exists (select 1 from quality.%2$I h where h.id = %3$I))
        with check (exists (select 1 from quality.%2$I h where h.id = %3$I))$p$,
      v.child, v.parent, v.fk);
    execute format('create index if not exists ix_%1$s_tenant on quality.%1$I (tenant_id)', v.child);
    perform core.attach_updated_at('quality', v.child);
    perform core.attach_row_defaults('quality', v.child);
    perform core.attach_audit('quality', v.child);
  end loop;
end $$;

-- -----------------------------------------------------------------------------
-- İzinler
-- -----------------------------------------------------------------------------
select core.declare_entity_permissions('quality', 'plan',          'Muayene planı', false);
select core.declare_entity_permissions('quality', 'inspection',    'Muayene');
select core.declare_entity_permissions('quality', 'nonconformity', 'Uygunsuzluk');

select core.declare_permission('quality.inspection.complete', 'quality', 'quality.inspection',
       'approve', 'Muayeneyi tamamla (geçti/kaldı kararını üret)');
select core.declare_permission('quality.nonconformity.decide', 'quality', 'quality.nonconformity',
       'approve', 'Uygunsuzluk için tasarruf kararı ver');
select core.declare_permission('quality.report.read', 'quality', 'quality.report',
       'read', 'Kalite raporları');

select core.grant_module_to_role('tenant_admin', 'quality');

-- Depo: malı muayene eden taraf. Tasarruf kararı VERMEZ — "kaldı ama alalım"
-- demek, malı teslim alanın tek başına vereceği bir karar değildir.
select core.grant_to_role('warehouse', array[
  'quality.plan.read.all',
  'quality.inspection.read.all','quality.inspection.write.all',
  'quality.inspection.create','quality.inspection.complete',
  'quality.nonconformity.read.all','quality.nonconformity.create',
  'quality.report.read'
]);

select core.grant_to_role('branch_manager', array[
  'quality.plan.read.all',
  'quality.inspection.read.all','quality.inspection.write.all',
  'quality.inspection.create','quality.inspection.complete',
  'quality.nonconformity.read.all','quality.nonconformity.write.all',
  'quality.nonconformity.create','quality.nonconformity.decide',
  'quality.report.read'
]);

-- Muhasebe: tedarikçiye iade/indirim talebi bu kayıtlara dayanır.
select core.grant_to_role('accounting', array[
  'quality.inspection.read.all','quality.nonconformity.read.all','quality.report.read'
]);

select core.grant_to_role('readonly', array[
  'quality.inspection.read.all','quality.nonconformity.read.all'
]);

-- -----------------------------------------------------------------------------
-- Kurulum kancası
-- -----------------------------------------------------------------------------
create or replace function quality.provision_quality(p_tenant_id uuid)
returns void
language plpgsql
security definer
set search_path = quality, core, pg_temp
as $$
begin
  insert into core.sequences (tenant_id, code, prefix, padding, period) values
    (p_tenant_id, 'quality_inspection',    'KKR-', 6, 'year'),
    (p_tenant_id, 'quality_nonconformity', 'UYG-', 6, 'year')
  on conflict do nothing;
end;
$$;

select core.register_provisioner('quality', 'quality.provision_quality', 55::smallint);
