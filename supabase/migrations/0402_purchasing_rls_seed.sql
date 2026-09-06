-- =============================================================================
-- 0402 — Satın Alma: RLS, izinler, kiracı kurulumu
-- =============================================================================
-- YETKİ TASARIMINDA DİKKAT (İK modülünde öğrenilen ders):
-- İş akışı fonksiyonları satırı `select ... for update` ile kilitler ve
-- PostgreSQL bunun için SELECT'e EK OLARAK UPDATE politikasının da geçmesini
-- ister. Bu yüzden bir eylem izni (approve/confirm) TEK BAŞINA yetmez; ilgili
-- varlıkta write izni de gerekir. Aşağıdaki dağıtımlar buna göre yapıldı:
--   * requisition.approve  -> requisition.write.all şart
--   * order.confirm        -> order.write.all şart
--   * receipt.confirm      -> receipt.write.all VE order.write.all şart
--     (kabul, sipariş satırlarının received_quantity'sini ilerletir)
-- =============================================================================

select core.register_tenant_table('purchasing', 'supplier_prices', 'purchasing.supplier_price', false, false);
select core.register_tenant_table('purchasing', 'requisitions',    'purchasing.requisition',    true,  true);
select core.register_tenant_table('purchasing', 'orders',          'purchasing.order',          true,  true);
select core.register_tenant_table('purchasing', 'receipts',        'purchasing.receipt',        true,  true);

-- Satır tabloları yetkiyi başlıktan devralır
do $$
declare v record;
begin
  for v in select * from (values
      ('requisition_lines', 'requisitions', 'requisition_id'),
      ('order_lines',       'orders',       'order_id'),
      ('receipt_lines',     'receipts',     'receipt_id')
    ) as t(child, parent, fk)
  loop
    execute format('alter table purchasing.%I enable row level security', v.child);
    execute format('alter table purchasing.%I force row level security', v.child);
    execute format('drop policy if exists p_%s_all on purchasing.%I', v.child, v.child);
    execute format($p$create policy p_%1$s_all on purchasing.%1$I for all
        using (exists (select 1 from purchasing.%2$I h where h.id = %3$I))
        with check (exists (select 1 from purchasing.%2$I h where h.id = %3$I))$p$,
      v.child, v.parent, v.fk);
    execute format('create index if not exists ix_%1$s_tenant on purchasing.%1$I (tenant_id)', v.child);
    perform core.attach_updated_at('purchasing', v.child);
    perform core.attach_row_defaults('purchasing', v.child);
    perform core.attach_audit('purchasing', v.child);
  end loop;
end $$;

-- -----------------------------------------------------------------------------
-- İzinler
-- -----------------------------------------------------------------------------
select core.declare_entity_permissions('purchasing', 'supplier_price', 'Tedarikçi fiyatı', false);
select core.declare_entity_permissions('purchasing', 'requisition',    'Satın alma talebi');
select core.declare_entity_permissions('purchasing', 'order',          'Satın alma siparişi');
select core.declare_entity_permissions('purchasing', 'receipt',        'Mal kabul');

select core.declare_permission('purchasing.requisition.approve', 'purchasing',
       'purchasing.requisition', 'approve', 'Satın alma talebi onayla/reddet');
select core.declare_permission('purchasing.requisition.self_approve', 'purchasing',
       'purchasing.requisition', 'approve', 'Kendi talebini onaylayabilir');
select core.declare_permission('purchasing.order.confirm', 'purchasing',
       'purchasing.order', 'approve', 'Satın alma siparişini onayla');
select core.declare_permission('purchasing.receipt.confirm', 'purchasing',
       'purchasing.receipt', 'approve', 'Mal kabulü onayla');
select core.declare_permission('purchasing.report.read', 'purchasing',
       'purchasing.report', 'read', 'Satın alma ve tedarikçi performans raporları');

-- -----------------------------------------------------------------------------
-- Rollere dağıtım
-- -----------------------------------------------------------------------------
select core.grant_module_to_role('tenant_admin', 'purchasing');

-- self_approve varsayılanda kimsede olmaz (İK'daki aynı gerekçe: görevler ayrılığı)
delete from core.role_permissions rp
using core.roles r
where rp.role_id = r.id and r.tenant_id is null and r.code = 'tenant_admin'
  and rp.permission_code = 'purchasing.requisition.self_approve';

-- Depo / Satın Alma: modülün ana kullanıcısı
select core.grant_to_role('warehouse', array[
  'purchasing.supplier_price.read.all','purchasing.supplier_price.write.all','purchasing.supplier_price.create',
  'purchasing.requisition.read.all','purchasing.requisition.write.all','purchasing.requisition.create',
  'purchasing.requisition.approve',
  'purchasing.order.read.all','purchasing.order.write.all','purchasing.order.create','purchasing.order.confirm',
  'purchasing.receipt.read.all','purchasing.receipt.write.all','purchasing.receipt.create','purchasing.receipt.confirm',
  'purchasing.report.read'
]);

-- Şube müdürü: kendi şubesinin talebini açar ve onaylar, malı teslim alır.
-- Sipariş ONAYI yok: tedarikçiye taahhüt merkezî bir karardır.
-- order.write.all yine de gerekli — mal kabul, sipariş satırlarını günceller.
select core.grant_to_role('branch_manager', array[
  'purchasing.supplier_price.read.all',
  'purchasing.requisition.read.all','purchasing.requisition.write.all',
  'purchasing.requisition.create','purchasing.requisition.approve',
  'purchasing.order.read.all','purchasing.order.write.all',
  'purchasing.receipt.read.all','purchasing.receipt.write.all',
  'purchasing.receipt.create','purchasing.receipt.confirm',
  'purchasing.report.read'
]);

-- Muhasebe: fatura mutabakatı için siparişi ve kabulü GÖRÜR, değiştirmez.
select core.grant_to_role('accounting', array[
  'purchasing.order.read.all','purchasing.receipt.read.all',
  'purchasing.supplier_price.read.all','purchasing.report.read'
]);

select core.grant_to_role('readonly', array[
  'purchasing.order.read.all','purchasing.receipt.read.all','purchasing.requisition.read.all'
]);

-- Çalışan öz servisi: kendi talebini açar, kendi talebini izler. Onaylayamaz.
select core.grant_to_role('employee', array[
  'purchasing.requisition.read.own','purchasing.requisition.write.own',
  'purchasing.requisition.create'
]);

-- -----------------------------------------------------------------------------
-- Kurulum kancası
-- -----------------------------------------------------------------------------
create or replace function purchasing.provision_purchasing(p_tenant_id uuid)
returns void
language plpgsql
security definer
set search_path = purchasing, core, pg_temp
as $$
begin
  insert into core.sequences (tenant_id, code, prefix, padding, period) values
    (p_tenant_id, 'purchase_requisition', 'STL-', 6, 'year'),
    (p_tenant_id, 'purchase_order',       'SAS-', 6, 'year'),
    (p_tenant_id, 'purchase_receipt',     'MKB-', 6, 'year')
  on conflict do nothing;
end;
$$;

select core.register_provisioner('purchasing', 'purchasing.provision_purchasing', 50::smallint);
