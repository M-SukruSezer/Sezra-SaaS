-- =============================================================================
-- 0403 — Satın Alma raporları ve liste görünümleri
-- =============================================================================
-- Tüm görünümler security_invoker = on (koruma testi bunu ayrıca doğruluyor).

create or replace view purchasing.v_requisition_list
with (security_invoker = on) as
select
  r.id, r.tenant_id, r.branch_id, r.number,
  r.request_date, r.needed_by, r.status, r.currency,
  r.subtotal, r.discount_total, r.tax_total, r.withholding_total, r.total,
  r.suggested_partner_id, p.name as suggested_partner_name,
  r.justification, r.approver_id, u.full_name as approver_name,
  r.approved_at, r.rejection_reason,
  b.name as branch_name, o.full_name as owner_name, r.owner_id,
  (select count(*) from purchasing.requisition_lines l where l.requisition_id = r.id) as line_count,
  r.created_at, r.updated_at
from purchasing.requisitions r
left join core.partners p on p.id = r.suggested_partner_id
left join core.users u on u.id = r.approver_id
left join core.users o on o.id = r.owner_id
left join core.branches b on b.id = r.branch_id;

create or replace view purchasing.v_order_list
with (security_invoker = on) as
select
  o.id, o.tenant_id, o.branch_id, o.number,
  o.partner_id, p.name as partner_name, p.tax_no,
  o.requisition_id, rq.number as requisition_number,
  o.order_date, o.promised_date, o.status, o.currency,
  o.subtotal, o.discount_total, o.tax_total, o.withholding_total, o.total,
  o.payment_term_days, o.supplier_ref,
  b.name as branch_name, u.full_name as owner_name, o.owner_id,
  (select count(*) from purchasing.order_lines l where l.order_id = o.id) as line_count,
  -- Kabul ilerlemesi: kısmi teslimatta "ne kadarı geldi" tek bakışta görünsün
  coalesce((select round(sum(l.received_quantity) / nullif(sum(l.quantity), 0) * 100, 1)
              from purchasing.order_lines l where l.order_id = o.id), 0) as received_pct,
  o.confirmed_at, o.cancelled_at, o.created_at, o.updated_at
from purchasing.orders o
join core.partners p on p.id = o.partner_id
left join purchasing.requisitions rq on rq.id = o.requisition_id
left join core.users u on u.id = o.owner_id
left join core.branches b on b.id = o.branch_id;

create or replace view purchasing.v_receipt_list
with (security_invoker = on) as
select
  r.id, r.tenant_id, r.branch_id, r.number,
  r.order_id, o.number as order_number, o.promised_date,
  r.partner_id, p.name as partner_name,
  r.receipt_date, r.status, r.waybill_no,
  b.name as branch_name, r.owner_id,
  (select count(*) from purchasing.receipt_lines l where l.receipt_id = r.id) as line_count,
  coalesce((select sum(l.quantity) from purchasing.receipt_lines l where l.receipt_id = r.id), 0) as total_quantity,
  coalesce((select sum(l.rejected_quantity) from purchasing.receipt_lines l where l.receipt_id = r.id), 0) as rejected_quantity,
  -- Gecikme: söz verilen tarihe göre kaç gün. Negatif = erken geldi.
  case when o.promised_date is not null then r.receipt_date - o.promised_date end as delay_days,
  r.confirmed_at, r.created_at
from purchasing.receipts r
join purchasing.orders o on o.id = r.order_id
join core.partners p on p.id = r.partner_id
left join core.branches b on b.id = r.branch_id;

-- -----------------------------------------------------------------------------
-- Tedarikçi performansı (Bölüm 4.4)
-- -----------------------------------------------------------------------------
-- Üç soruyu yanıtlar: zamanında mı teslim ediyor, malı sağlam mı geliyor,
-- ne kadar iş veriyoruz. Tedarikçi görüşmesine bu tabloyla girilir.
create or replace view purchasing.v_supplier_performance
with (security_invoker = on) as
select
  o.tenant_id,
  o.partner_id,
  p.name as partner_name,
  count(distinct o.id)                                   as order_count,
  sum(o.total)                                           as total_spend,
  o.currency,
  count(distinct rc.id)                                  as receipt_count,
  -- Ortalama teslim süresi: sipariş tarihinden fiili kabule
  round(avg(rc.receipt_date - o.order_date)::numeric, 1) as avg_lead_days,
  -- Zamanında teslim oranı (söz verilen tarihi olan kabuller üzerinden)
  round(
    count(*) filter (where o.promised_date is not null and rc.receipt_date <= o.promised_date)::numeric
    / nullif(count(*) filter (where o.promised_date is not null), 0) * 100, 1
  )                                                      as on_time_pct,
  -- Ret oranı: gelen maldan ne kadarı hasarlı/uygunsuz çıktı
  round(
    coalesce(sum(rl.rejected_quantity), 0)
    / nullif(sum(rl.quantity), 0) * 100, 2
  )                                                      as rejection_pct,
  max(rc.receipt_date)                                   as last_receipt_date
from purchasing.orders o
join core.partners p on p.id = o.partner_id
left join purchasing.receipts rc on rc.order_id = o.id and rc.status = 'confirmed'
left join purchasing.receipt_lines rl on rl.receipt_id = rc.id
where o.status <> 'cancelled'
group by o.tenant_id, o.partner_id, p.name, o.currency;

-- -----------------------------------------------------------------------------
-- Fiyat değişim geçmişi
-- -----------------------------------------------------------------------------
-- Onaylanmış siparişlerdeki fiili birim fiyatlar. Fiyat listesi "ne olmalı"yı,
-- bu görünüm "ne ödedik"i gösterir — pazarlıkta kullanılan asıl veri budur.
create or replace view purchasing.v_price_history
with (security_invoker = on) as
select
  o.tenant_id,
  ol.product_id,
  pr.sku, pr.name as product_name,
  o.partner_id, p.name as partner_name,
  o.order_date, o.number as order_number,
  ol.quantity, ol.unit_price, o.currency,
  -- Aynı ürün+tedarikçi için bir önceki fiyat ve değişim yüzdesi
  lag(ol.unit_price) over (
    partition by o.tenant_id, ol.product_id, o.partner_id order by o.order_date, o.number
  ) as previous_price,
  round((ol.unit_price - lag(ol.unit_price) over (
    partition by o.tenant_id, ol.product_id, o.partner_id order by o.order_date, o.number
  )) / nullif(lag(ol.unit_price) over (
    partition by o.tenant_id, ol.product_id, o.partner_id order by o.order_date, o.number
  ), 0) * 100, 2) as change_pct
from purchasing.order_lines ol
join purchasing.orders o on o.id = ol.order_id
left join core.products pr on pr.id = ol.product_id
join core.partners p on p.id = o.partner_id
where o.status <> 'cancelled' and o.confirmed_at is not null;

-- Bekleyen teslimatlar — satın alma sorumlusunun günlük çalışma listesi
create or replace view purchasing.v_open_orders
with (security_invoker = on) as
select
  o.id, o.tenant_id, o.branch_id, o.number, o.partner_id, p.name as partner_name,
  o.order_date, o.promised_date, o.currency, o.total,
  sum(ol.quantity - ol.received_quantity) as pending_quantity,
  case when o.promised_date is not null and o.promised_date < current_date
       then current_date - o.promised_date end as overdue_days,
  b.name as branch_name
from purchasing.orders o
join purchasing.order_lines ol on ol.order_id = o.id
join core.partners p on p.id = o.partner_id
left join core.branches b on b.id = o.branch_id
where o.status in ('confirmed', 'partially_received')
group by o.id, o.tenant_id, o.branch_id, o.number, o.partner_id, p.name,
         o.order_date, o.promised_date, o.currency, o.total, b.name
having sum(ol.quantity - ol.received_quantity) > 0;
