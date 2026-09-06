-- =============================================================================
-- 0504 — Envanter raporları
-- =============================================================================

-- Ürün bazlı stok durumu. Maliyet kolonları AYRI izne tabidir: product_costs'un
-- RLS'i maliyeti göremeyen kullanıcıda satırı hiç döndürmez, o yüzden LEFT JOIN
-- kullanılıyor — satış temsilcisi adedi görür, maliyeti NULL gelir.
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
where l.kind = 'stock'
group by q.tenant_id, q.product_id, p.sku, p.name, p.kind, u.code,
         w.id, w.name, w.branch_id, b.name, pc.average_cost;

-- Stok defteri: her hareketin öncesi/sonrası okunabilsin
create or replace view inventory.v_stock_ledger
with (security_invoker = on) as
select
  m.id, m.tenant_id, m.branch_id, m.number, m.move_date, m.state,
  m.product_id, p.sku, p.name as product_name,
  m.lot_id, lt.code as lot_code, lt.expiry_date,
  m.from_location_id, fl.code as from_code,
  m.to_location_id,   tl.code as to_code,
  case
    when m.from_location_id is null then 'giriş'
    when m.to_location_id is null then 'çıkış'
    else 'transfer'
  end as direction,
  -- Transferde işaret yoktur (toplam stok değişmez) ama MİKTAR gösterilmelidir:
  -- 0 yazmak, sayım düzeltmesi gibi gerçek bir hareketi "hiçbir şey olmadı"
  -- diye okutur. Yönü `direction` kolonu zaten söylüyor.
  case when m.from_location_id is null then m.quantity
       when m.to_location_id is null then -m.quantity
       else m.quantity end as signed_quantity,
  m.quantity, m.unit_cost, m.total_cost,
  m.source_module, m.source_table, m.source_id, m.reference,
  b.name as branch_name
from inventory.moves m
join core.products p on p.id = m.product_id
left join inventory.lots lt on lt.id = m.lot_id
left join inventory.locations fl on fl.id = m.from_location_id
left join inventory.locations tl on tl.id = m.to_location_id
left join core.branches b on b.id = m.branch_id;

-- Son kullanma tarihi yaklaşan / geçmiş stok — raf ömrü olan stokta en kritik rapor
create or replace view inventory.v_expiring_stock
with (security_invoker = on) as
select
  q.tenant_id, q.product_id, p.sku, p.name as product_name,
  l.id as lot_id, l.code as lot_code, l.production_date, l.expiry_date,
  w.branch_id, b.name as branch_name, w.name as warehouse_name,
  sum(q.quantity) as quantity,
  (l.expiry_date - current_date) as days_left,
  case
    when l.expiry_date < current_date then 'geçmiş'
    when l.expiry_date <= current_date + 7 then 'kritik'
    when l.expiry_date <= current_date + 30 then 'yaklaşıyor'
    else 'normal'
  end as urgency
from inventory.quants q
join inventory.lots l on l.id = q.lot_id
join core.products p on p.id = q.product_id
join inventory.locations loc on loc.id = q.location_id
join inventory.warehouses w on w.id = loc.warehouse_id
left join core.branches b on b.id = w.branch_id
where l.expiry_date is not null and q.quantity > 0
group by q.tenant_id, q.product_id, p.sku, p.name, l.id, l.code,
         l.production_date, l.expiry_date, w.branch_id, b.name, w.name;

-- Minimum seviyenin altındaki ürünler — satın alma talebinin girdisi
create or replace view inventory.v_reorder_alerts
with (security_invoker = on) as
select
  rr.tenant_id, rr.branch_id, rr.product_id,
  p.sku, p.name as product_name,
  rr.min_quantity, rr.max_quantity,
  coalesce(pc.quantity_on_hand, 0) as on_hand,
  greatest(coalesce(rr.max_quantity, rr.min_quantity) - coalesce(pc.quantity_on_hand, 0), 0)
    as suggested_quantity,
  rr.last_alert_at,
  b.name as branch_name
from inventory.reorder_rules rr
join core.products p on p.id = rr.product_id
left join inventory.product_costs pc
  on pc.tenant_id = rr.tenant_id and pc.product_id = rr.product_id
left join core.branches b on b.id = rr.branch_id
where rr.is_active
  and coalesce(pc.quantity_on_hand, 0) < rr.min_quantity;

-- Stok değerleme özeti — bilançodaki 153 TİCARİ MALLAR ile karşılaştırılır
create or replace view inventory.v_stock_valuation
with (security_invoker = on) as
select
  pc.tenant_id,
  count(*) filter (where pc.quantity_on_hand > 0) as product_count,
  sum(pc.quantity_on_hand)                        as total_quantity,
  sum(pc.total_value)                             as total_value
from inventory.product_costs pc
group by pc.tenant_id;
