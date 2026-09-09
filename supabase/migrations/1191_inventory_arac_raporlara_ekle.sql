-- =============================================================================
-- 1191 — Envanter: araç lokasyonunu stok raporuna dahil et
--
-- 1190'da eklenen 'vehicle' enum değerini v_stock_on_hand görünümüne alır.
-- Araç üzerindeki stok, ürün-depo kırılımında görünür hale gelir.
-- Ayrı migration: ALTER TYPE ... ADD VALUE sonrası aynı transaction'da
-- yeni değer kullanılamaz.
-- =============================================================================
create or replace view inventory.v_stock_on_hand
with (security_invoker = on) as
select
  q.tenant_id,
  q.product_id,
  p.sku, p.name as product_name, p.kind,
  u.code as uom_code,
  w.id as warehouse_id, w.name as warehouse_name, w.branch_id,
  b.name as branch_name,
  sum(q.quantity)              as quantity,
  sum(q.reserved)              as reserved,
  sum(q.quantity - q.reserved) as available,
  pc.average_cost,
  round(sum(q.quantity) * pc.average_cost, 2) as stock_value
from inventory.quants q
join core.products p on p.id = q.product_id
join inventory.locations l on l.id = q.location_id
join inventory.warehouses w on w.id = l.warehouse_id
left join core.branches b on b.id = w.branch_id
left join core.uoms u on u.id = p.uom_id
left join inventory.product_costs pc
  on pc.tenant_id = q.tenant_id and pc.product_id = q.product_id
where l.kind in ('stock', 'vehicle')
group by q.tenant_id, q.product_id, p.sku, p.name, p.kind, u.code,
         w.id, w.name, w.branch_id, b.name, pc.average_cost;
