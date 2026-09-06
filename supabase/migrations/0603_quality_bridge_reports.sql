-- =============================================================================
-- 0603 — Kalite köprüsü ve raporları
-- =============================================================================
-- Mal kabul onaylandığında, planı olan her ürün için TASLAK muayene açılır.
-- Muayene otomatik geçmez (0600 karar 3): amaç kontrolü hatırlatmak, yerine
-- geçmek değil. Planı olmayan ürün için hiç kayıt açılmaz — doldurulmayan boş
-- formlar, kalite kontrolün en hızlı öldüğü yerdir.
create or replace function quality.on_purchase_receipt_confirmed(p_event jsonb)
returns void
language plpgsql
security definer
set search_path = quality, core, pg_temp
as $$
declare
  v_tenant  uuid  := (p_event ->> 'tenant_id')::uuid;
  v_branch  uuid  := nullif(p_event ->> 'branch_id', '')::uuid;
  v_payload jsonb := p_event -> 'payload';
  v_receipt uuid  := (v_payload ->> 'receipt_id')::uuid;
  v_partner uuid  := nullif(v_payload ->> 'partner_id', '')::uuid;
  v_line    jsonb;
  v_prod    uuid;
begin
  -- İdempotanlık: aynı mal kabul için ikinci kez muayene açılmaz.
  if exists (
    select 1 from quality.inspections
    where tenant_id = v_tenant and source_module = 'purchasing'
      and source_table = 'receipts' and source_id = v_receipt
  ) then
    return;
  end if;

  for v_line in select * from jsonb_array_elements(v_payload -> 'lines')
  loop
    v_prod := nullif(v_line ->> 'product_id', '')::uuid;
    if v_prod is null then continue; end if;

    perform quality.open_inspection(
      v_tenant, v_branch, v_prod,
      coalesce((v_line ->> 'quantity')::numeric, 0),
      v_partner, null, 'incoming',
      'purchasing', 'receipts', v_receipt);
  end loop;
end;
$$;

select core.subscribe('purchasing.receipt.confirmed', 'quality',
                      'quality.on_purchase_receipt_confirmed');

-- -----------------------------------------------------------------------------
-- Raporlar
-- -----------------------------------------------------------------------------
create or replace view quality.v_inspection_list
with (security_invoker = on) as
select
  i.id, i.tenant_id, i.branch_id, i.number, i.stage, i.status,
  i.product_id, p.sku, p.name as product_name,
  i.partner_id, pa.name as partner_name,
  i.quantity, i.sampled_quantity,
  i.plan_id, pl.code as plan_code, pl.name as plan_name,
  i.inspector_id, u.full_name as inspector_name, i.inspected_at,
  i.source_module, i.source_table, i.source_id,
  b.name as branch_name, i.owner_id, i.created_at,
  (select count(*) from quality.results r where r.inspection_id = i.id) as check_count,
  (select count(*) from quality.results r where r.inspection_id = i.id and r.passed is false) as failed_count,
  (select count(*) from quality.results r where r.inspection_id = i.id and r.passed is null) as pending_count
from quality.inspections i
join core.products p on p.id = i.product_id
left join core.partners pa on pa.id = i.partner_id
left join quality.plans pl on pl.id = i.plan_id
left join core.users u on u.id = i.inspector_id
left join core.branches b on b.id = i.branch_id;

create or replace view quality.v_nonconformity_list
with (security_invoker = on) as
select
  n.id, n.tenant_id, n.branch_id, n.number,
  n.inspection_id, i.number as inspection_number,
  n.product_id, p.sku, p.name as product_name,
  n.partner_id, pa.name as partner_name,
  n.quantity, n.severity, n.description,
  n.disposition, n.disposition_note, n.corrective_action,
  n.decided_by, u.full_name as decided_by_name, n.decided_at, n.closed_at,
  (n.closed_at is null) as is_open,
  b.name as branch_name, n.owner_id, n.created_at
from quality.nonconformities n
join core.products p on p.id = n.product_id
left join core.partners pa on pa.id = n.partner_id
left join quality.inspections i on i.id = n.inspection_id
left join core.users u on u.id = n.decided_by
left join core.branches b on b.id = n.branch_id;

-- Tedarikçi kalite karnesi. Satın almadaki teslimat performansının yanına
-- KALİTE boyutunu koyar: zamanında gelen ama sürekli kalan mal, iyi tedarikçi
-- değildir.
create or replace view quality.v_supplier_quality
with (security_invoker = on) as
select
  i.tenant_id, i.partner_id, pa.name as partner_name,
  count(*)                                             as inspection_count,
  count(*) filter (where i.status = 'passed')          as passed_count,
  count(*) filter (where i.status = 'failed')          as failed_count,
  round(count(*) filter (where i.status = 'passed')::numeric
        / nullif(count(*) filter (where i.status in ('passed','failed')), 0) * 100, 1)
                                                       as pass_rate_pct,
  count(distinct n.id) filter (where n.severity = 'critical') as critical_nc_count,
  count(distinct n.id) filter (where n.closed_at is null)     as open_nc_count,
  max(i.inspected_at)                                  as last_inspected_at
from quality.inspections i
join core.partners pa on pa.id = i.partner_id
left join quality.nonconformities n on n.inspection_id = i.id
where i.partner_id is not null
group by i.tenant_id, i.partner_id, pa.name;

-- Kalan ölçütlerin dağılımı: hangi ölçüt sürekli sorun çıkarıyor?
create or replace view quality.v_failed_checks
with (security_invoker = on) as
select
  r.tenant_id, r.code, r.name, r.unit, r.is_critical,
  i.product_id, p.sku, p.name as product_name,
  count(*)                                     as fail_count,
  round(avg(r.numeric_value), 4)               as avg_measured,
  min(r.min_value)                             as spec_min,
  max(r.max_value)                             as spec_max
from quality.results r
join quality.inspections i on i.id = r.inspection_id
join core.products p on p.id = i.product_id
where r.passed is false
group by r.tenant_id, r.code, r.name, r.unit, r.is_critical,
         i.product_id, p.sku, p.name;
