-- =============================================================================
-- 0103 — Liste görünümleri
-- =============================================================================
-- Liste ekranları ilişkili adları (cari, sorumlu, aşama) ister. Bunları her
-- seferinde uygulama katmanında join etmek yerine görünüm olarak tanımlıyoruz:
-- API'nin genel CRUD üreteci `readFrom` ile bu görünümü okur, yazma yine
-- tabloya gider.
--
-- security_invoker = on ZORUNLU: aksi hâlde görünüm sahibinin haklarıyla
-- çalışır ve RLS'i atlar.
-- =============================================================================

create or replace view crm.v_lead_list
with (security_invoker = on) as
select l.*,
       p.name        as partner_name,
       u.full_name   as owner_name,
       s.name        as stage_name,
       b.name        as branch_name,
       lr.name       as lost_reason_name
from crm.leads l
left join core.partners p on p.id = l.partner_id
left join core.users u on u.id = l.owner_id
left join crm.stages s on s.id = l.stage_id
left join core.branches b on b.id = l.branch_id
left join crm.lost_reasons lr on lr.id = l.lost_reason_id;

create or replace view crm.v_quotation_list
with (security_invoker = on) as
select q.*,
       p.name      as partner_name,
       p.tax_no,
       u.full_name as owner_name,
       b.name      as branch_name,
       (select count(*) from crm.quotation_lines ql where ql.quotation_id = q.id) as line_count
from crm.quotations q
left join core.partners p on p.id = q.partner_id
left join core.users u on u.id = q.owner_id
left join core.branches b on b.id = q.branch_id;

create or replace view crm.v_sale_order_list
with (security_invoker = on) as
select so.*,
       p.name      as partner_name,
       p.tax_no,
       u.full_name as owner_name,
       b.name      as branch_name,
       (select count(*) from crm.sale_order_lines sl where sl.sale_order_id = so.id) as line_count
from crm.sale_orders so
left join core.partners p on p.id = so.partner_id
left join core.users u on u.id = so.owner_id
left join core.branches b on b.id = so.branch_id;

create or replace view core.v_partner_list
with (security_invoker = on) as
select pa.*,
       u.full_name as owner_name,
       b.name      as branch_name,
       -- Vergi numarası geçerliliği LİSTEDE de görünür: kartı açmadan hangi
       -- carilerin numarası bozuk, süzerek görülebilsin.
       core.tax_no_valid(pa.tax_no) as tax_no_valid
from core.partners pa
left join core.users u on u.id = pa.owner_id
left join core.branches b on b.id = pa.branch_id;

select core.apply_grants();
