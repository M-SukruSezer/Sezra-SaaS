-- =============================================================================
-- 0703 — Bakım köprüsü ve raporları
-- =============================================================================
-- Bu handler ENVANTER modülüne aittir (0305/0503'teki aynı kural): Bakım,
-- Envanter'in varlığını bilmez. Envanter kapalı bir kiracıda olay hiç teslim
-- edilmez ve parça satırı yalnızca maliyet kaydı olarak kalır.
create or replace function inventory.on_maintenance_parts_consumed(p_event jsonb)
returns void
language plpgsql
security definer
set search_path = inventory, core, maintenance, pg_temp
as $$
declare
  v_tenant  uuid  := (p_event ->> 'tenant_id')::uuid;
  v_branch  uuid  := nullif(p_event ->> 'branch_id', '')::uuid;
  v_payload jsonb := p_event -> 'payload';
  v_wo      uuid  := (v_payload ->> 'work_order_id')::uuid;
  v_line    jsonb;
  v_part    uuid;
begin
  for v_line in select * from jsonb_array_elements(v_payload -> 'lines')
  loop
    v_part := (v_line ->> 'part_id')::uuid;

    -- İdempotanlık: bu parça satırı zaten stoktan düşülmüşse atla.
    if exists (select 1 from maintenance.work_order_parts
                where id = v_part and stock_issued) then
      continue;
    end if;

    if not exists (
      select 1 from core.products p
      where p.id = (v_line ->> 'product_id')::uuid and p.kind = 'stockable'
    ) then
      continue;
    end if;

    perform inventory.deliver_stock(
      v_tenant, v_branch,
      (v_line ->> 'product_id')::uuid,
      coalesce((v_line ->> 'quantity')::numeric, 0),
      'maintenance', 'work_orders', v_wo,
      coalesce(v_payload ->> 'number', ''));

    update maintenance.work_order_parts set stock_issued = true where id = v_part;
  end loop;
end;
$$;

select core.subscribe('maintenance.parts.consumed', 'inventory',
                      'inventory.on_maintenance_parts_consumed');

-- -----------------------------------------------------------------------------
-- Raporlar
-- -----------------------------------------------------------------------------
create or replace view maintenance.v_equipment_list
with (security_invoker = on) as
select
  e.id, e.tenant_id, e.branch_id, e.code, e.name, e.category,
  e.manufacturer, e.model, e.serial_no, e.status, e.is_critical,
  e.purchase_date, e.warranty_until,
  (e.warranty_until is not null and e.warranty_until >= current_date) as under_warranty,
  e.usage_counter, e.usage_unit, e.location_note,
  e.partner_id, pa.name as service_partner_name,
  b.name as branch_name, e.owner_id,
  (select count(*) from maintenance.work_orders w
    where w.equipment_id = e.id
      and w.status in ('draft','scheduled','in_progress'))       as open_work_orders,
  (select max(w.completed_at) from maintenance.work_orders w
    where w.equipment_id = e.id and w.status = 'done')           as last_service_at,
  (select coalesce(sum(w.total_cost), 0) from maintenance.work_orders w
    where w.equipment_id = e.id and w.status = 'done')           as lifetime_cost,
  (select coalesce(sum(w.downtime_minutes), 0) from maintenance.work_orders w
    where w.equipment_id = e.id and w.status = 'done')           as lifetime_downtime_minutes
from maintenance.equipment e
left join core.partners pa on pa.id = e.partner_id
left join core.branches b on b.id = e.branch_id;

create or replace view maintenance.v_work_order_list
with (security_invoker = on) as
select
  w.id, w.tenant_id, w.branch_id, w.number, w.kind, w.status, w.priority,
  w.title, w.description, w.resolution,
  w.equipment_id, e.code as equipment_code, e.name as equipment_name,
  e.is_critical, e.category as equipment_category,
  w.plan_id, p.name as plan_name,
  w.reported_at, w.scheduled_date, w.started_at, w.completed_at,
  w.assignee_id, u.full_name as assignee_name,
  w.partner_id, pa.name as service_partner_name,
  w.downtime_minutes, w.labor_minutes,
  w.labor_cost, w.parts_cost, w.service_cost, w.total_cost,
  b.name as branch_name, w.owner_id, w.created_at,
  (select count(*) from maintenance.work_order_tasks t where t.work_order_id = w.id) as task_count,
  (select count(*) from maintenance.work_order_tasks t
    where t.work_order_id = w.id and not t.is_done)                                  as pending_task_count,
  -- Gecikme: planlanan tarihi geçmiş ve hâlâ açık
  case when w.scheduled_date is not null and w.status in ('draft','scheduled','in_progress')
            and w.scheduled_date < current_date
       then current_date - w.scheduled_date end as overdue_days
from maintenance.work_orders w
join maintenance.equipment e on e.id = w.equipment_id
left join maintenance.plans p on p.id = w.plan_id
left join core.users u on u.id = w.assignee_id
left join core.partners pa on pa.id = w.partner_id
left join core.branches b on b.id = w.branch_id;

-- Ekipman güvenilirliği: hangi makine sürekli bozuluyor, hangisine ne kadar
-- para gidiyor. Yenileme kararı bu tabloyla verilir.
create or replace view maintenance.v_equipment_reliability
with (security_invoker = on) as
select
  e.tenant_id, e.id as equipment_id, e.code, e.name, e.category,
  e.branch_id, b.name as branch_name, e.is_critical,
  e.purchase_cost,
  count(*) filter (where w.status = 'done')                        as service_count,
  count(*) filter (where w.status = 'done' and w.kind = 'corrective') as breakdown_count,
  coalesce(sum(w.total_cost) filter (where w.status = 'done'), 0)  as total_cost,
  coalesce(sum(w.downtime_minutes) filter (where w.status = 'done'), 0) as total_downtime_minutes,
  -- Arızalar arası ortalama gün (MTBF'in basit hâli)
  case when count(*) filter (where w.status = 'done' and w.kind = 'corrective') > 1
       then round(
         (max(w.completed_at) filter (where w.kind = 'corrective')::date
          - min(w.completed_at) filter (where w.kind = 'corrective')::date)::numeric
         / nullif(count(*) filter (where w.status = 'done' and w.kind = 'corrective') - 1, 0), 1)
  end as mean_days_between_failures,
  -- Bakım maliyeti alım bedelinin yüzde kaçına ulaştı: yenileme eşiği
  case when e.purchase_cost > 0
       then round(coalesce(sum(w.total_cost) filter (where w.status = 'done'), 0)
                  / e.purchase_cost * 100, 1) end as cost_vs_purchase_pct
from maintenance.equipment e
left join maintenance.work_orders w on w.equipment_id = e.id
left join core.branches b on b.id = e.branch_id
group by e.tenant_id, e.id, e.code, e.name, e.category, e.branch_id, b.name,
         e.is_critical, e.purchase_cost;
