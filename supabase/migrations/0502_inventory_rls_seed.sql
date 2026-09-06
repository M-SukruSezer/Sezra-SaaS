-- =============================================================================
-- 0502 — Envanter: RLS, izinler, kiracı kurulumu
-- =============================================================================

select core.register_tenant_table('inventory', 'warehouses',    'inventory.warehouse', true,  false);
select core.register_tenant_table('inventory', 'locations',     'inventory.location',  false, false);
select core.register_tenant_table('inventory', 'lots',          'inventory.lot',       false, false);
select core.register_tenant_table('inventory', 'moves',         'inventory.move',      true,  true);
select core.register_tenant_table('inventory', 'reorder_rules', 'inventory.reorder',   true,  false);
select core.register_tenant_table('inventory', 'counts',        'inventory.count',     true,  true);

-- Sayım satırları yetkiyi başlıktan devralır
alter table inventory.count_lines enable row level security;
alter table inventory.count_lines force row level security;
drop policy if exists p_count_lines_all on inventory.count_lines;
create policy p_count_lines_all on inventory.count_lines for all
  using (exists (select 1 from inventory.counts h where h.id = count_id))
  with check (exists (select 1 from inventory.counts h where h.id = count_id));
create index if not exists ix_count_lines_tenant on inventory.count_lines (tenant_id);
select core.attach_updated_at('inventory', 'count_lines');
select core.attach_row_defaults('inventory', 'count_lines');
select core.attach_audit('inventory', 'count_lines');

-- -----------------------------------------------------------------------------
-- Türetilmiş tablolar: yalnızca OKUMA politikası
-- -----------------------------------------------------------------------------
-- Yazma yetkisi zaten tablo düzeyinde kapalı (0013). Burada okumayı kiracıya
-- ve şube kapsamına bağlıyoruz.
alter table inventory.quants enable row level security;
alter table inventory.quants force row level security;
drop policy if exists p_quants_select on inventory.quants;
create policy p_quants_select on inventory.quants for select
  using (tenant_id = (select core.support_tenant_id())
         or (tenant_id = (select core.current_tenant_id())
             and (select core.has_perm('inventory.stock.read'))
             and (select inventory.accessible_location_ids()) @> array[location_id]));
create index if not exists ix_quants_tenant on inventory.quants (tenant_id);

alter table inventory.product_costs enable row level security;
alter table inventory.product_costs force row level security;
drop policy if exists p_product_costs_select on inventory.product_costs;
-- Maliyet AYRI bir izin ister: satış temsilcisi stok adedini görmeli ama
-- alış maliyetini görmemelidir (marj bilgisi ticari sırdır).
create policy p_product_costs_select on inventory.product_costs for select
  using (tenant_id = (select core.support_tenant_id())
         or (tenant_id = (select core.current_tenant_id())
             and (select core.has_perm('inventory.cost.read'))));

-- -----------------------------------------------------------------------------
-- İzinler
-- -----------------------------------------------------------------------------
select core.declare_entity_permissions('inventory', 'warehouse', 'Depo', false);
select core.declare_entity_permissions('inventory', 'location',  'Stok konumu', false);
select core.declare_entity_permissions('inventory', 'lot',       'Lot / parti', false);
select core.declare_entity_permissions('inventory', 'move',      'Stok hareketi');
select core.declare_entity_permissions('inventory', 'reorder',   'Yeniden sipariş kuralı', false);
select core.declare_entity_permissions('inventory', 'count',     'Sayım');

select core.declare_permission('inventory.stock.read',  'inventory', 'inventory.stock',
       'read', 'Stok bakiyelerini görüntüle');
select core.declare_permission('inventory.cost.read',   'inventory', 'inventory.cost',
       'read', 'Stok maliyet ve değerini görüntüle');
select core.declare_permission('inventory.move.post',   'inventory', 'inventory.move',
       'approve', 'Stok hareketini işle');
select core.declare_permission('inventory.count.apply', 'inventory', 'inventory.count',
       'approve', 'Sayım farklarını stoka uygula');
select core.declare_permission('inventory.report.read', 'inventory', 'inventory.report',
       'read', 'Envanter raporları');

select core.grant_module_to_role('tenant_admin', 'inventory');

-- Depo sorumlusu: modülün ana kullanıcısı
select core.grant_to_role('warehouse', array[
  'inventory.warehouse.read.all','inventory.warehouse.write.all','inventory.warehouse.create',
  'inventory.location.read.all','inventory.location.write.all','inventory.location.create',
  'inventory.lot.read.all','inventory.lot.write.all','inventory.lot.create',
  'inventory.move.read.all','inventory.move.write.all','inventory.move.create','inventory.move.post',
  'inventory.reorder.read.all','inventory.reorder.write.all','inventory.reorder.create',
  'inventory.count.read.all','inventory.count.write.all','inventory.count.create','inventory.count.apply',
  'inventory.stock.read','inventory.cost.read','inventory.report.read'
]);

select core.grant_to_role('branch_manager', array[
  'inventory.warehouse.read.all','inventory.location.read.all','inventory.lot.read.all',
  'inventory.move.read.all','inventory.move.write.all','inventory.move.create','inventory.move.post',
  'inventory.count.read.all','inventory.count.write.all','inventory.count.create','inventory.count.apply',
  'inventory.reorder.read.all',
  'inventory.stock.read','inventory.report.read'
]);

-- Satış: stok ADEDİNİ görür (müşteriye söz verebilmek için), MALİYETİ görmez.
select core.grant_to_role('sales', array[
  'inventory.stock.read','inventory.lot.read.all','inventory.warehouse.read.all'
]);

-- Muhasebe: stok değerlemesi bilanço kalemidir, maliyeti görmesi gerekir.
select core.grant_to_role('accounting', array[
  'inventory.stock.read','inventory.cost.read','inventory.move.read.all','inventory.report.read'
]);

select core.grant_to_role('readonly', array[
  'inventory.stock.read','inventory.warehouse.read.all','inventory.move.read.all'
]);

-- -----------------------------------------------------------------------------
-- Kurulum kancası
-- -----------------------------------------------------------------------------
create or replace function inventory.provision_inventory(p_tenant_id uuid)
returns void
language plpgsql
security definer
set search_path = inventory, core, pg_temp
as $$
declare
  r    record;
  v_wh uuid;
begin
  -- Her şube için bir depo; şubesiz kiracıda tek merkez depo.
  for r in select id, code, name from core.branches where tenant_id = p_tenant_id and is_active
  loop
    insert into inventory.warehouses (tenant_id, branch_id, code, name, is_default)
    values (p_tenant_id, r.id, 'DEPO-' || r.code, r.name || ' Deposu', true)
    on conflict (tenant_id, code) do nothing
    returning id into v_wh;

    if v_wh is null then
      select id into v_wh from inventory.warehouses
       where tenant_id = p_tenant_id and code = 'DEPO-' || r.code;
    end if;

    insert into inventory.locations (tenant_id, warehouse_id, code, name, kind) values
      (p_tenant_id, v_wh, 'STOK-' || r.code,  r.name || ' Stok',      'stock'),
      (p_tenant_id, v_wh, 'FIRE-' || r.code,  r.name || ' Fire/Zayi', 'scrap')
    on conflict (tenant_id, code) do nothing;
  end loop;

  insert into core.sequences (tenant_id, code, prefix, padding, period) values
    (p_tenant_id, 'inventory_move',  'STH-', 6, 'year'),
    (p_tenant_id, 'inventory_count', 'SAY-', 6, 'year')
  on conflict do nothing;
end;
$$;

select core.register_provisioner('inventory', 'inventory.provision_inventory', 25::smallint);

-- Kurulum kancası yalnızca KİRACI açılırken çalışır. Sonradan açılan şubenin de
-- deposu olmalı — aksi hâlde o şubede mal kabul "tanımlı stok konumu yok" ile
-- düşer ve hata, şubeyi açan kişiden aylar sonra ortaya çıkar.
--
-- Tetikleyici ENVANTER modülüne aittir ve core.branches üzerine kurulur;
-- bağımlılık yönü doğru (Envanter core'u bilir, core Envanter'i bilmez) ve
-- yalnızca modül o kiracıda AÇIKSA iş yapar.
create or replace function inventory.fn_provision_branch()
returns trigger
language plpgsql
security definer
set search_path = inventory, core, pg_temp
as $$
declare v_wh uuid;
begin
  if not exists (
    select 1 from core.tenant_modules
    where tenant_id = new.tenant_id and module_code = 'inventory' and enabled
  ) then
    return new;
  end if;

  insert into inventory.warehouses (tenant_id, branch_id, code, name, is_default)
  values (new.tenant_id, new.id, 'DEPO-' || new.code, new.name || ' Deposu', true)
  on conflict (tenant_id, code) do nothing
  returning id into v_wh;

  if v_wh is not null then
    insert into inventory.locations (tenant_id, warehouse_id, code, name, kind) values
      (new.tenant_id, v_wh, 'STOK-' || new.code, new.name || ' Stok',      'stock'),
      (new.tenant_id, v_wh, 'FIRE-' || new.code, new.name || ' Fire/Zayi', 'scrap')
    on conflict (tenant_id, code) do nothing;
  end if;

  return new;
end;
$$;

drop trigger if exists trg_branch_provision_inventory on core.branches;
create trigger trg_branch_provision_inventory after insert on core.branches
  for each row execute function inventory.fn_provision_branch();
