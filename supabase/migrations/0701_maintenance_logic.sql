-- =============================================================================
-- 0701 — Bakım iş kuralları
-- =============================================================================

-- -----------------------------------------------------------------------------
-- Maliyet toplama
-- -----------------------------------------------------------------------------
create or replace function maintenance.fn_calc_part_cost()
returns trigger
language plpgsql
as $$
begin
  new.total_cost := round(new.quantity * new.unit_cost, 2);
  return new;
end;
$$;

drop trigger if exists trg_wo_parts_calc on maintenance.work_order_parts;
create trigger trg_wo_parts_calc before insert or update on maintenance.work_order_parts
  for each row execute function maintenance.fn_calc_part_cost();

-- Başlık toplamı satırlardan türetilir; elle yazılmaz (0011'deki belge
-- matematiğiyle aynı ilke).
create or replace function maintenance.fn_recalc_wo_cost()
returns trigger
language plpgsql
as $$
declare v_id uuid := coalesce(new.work_order_id, old.work_order_id);
begin
  update maintenance.work_orders w
     set parts_cost = coalesce(s.parts, 0),
         total_cost = w.labor_cost + coalesce(s.parts, 0) + w.service_cost
  from (select coalesce(sum(total_cost), 0) as parts
          from maintenance.work_order_parts where work_order_id = v_id) s
  where w.id = v_id;
  return null;
end;
$$;

drop trigger if exists trg_wo_parts_rollup on maintenance.work_order_parts;
create trigger trg_wo_parts_rollup after insert or update or delete on maintenance.work_order_parts
  for each row execute function maintenance.fn_recalc_wo_cost();

-- İşçilik/servis maliyeti değiştiğinde de toplam tazelenmeli
create or replace function maintenance.fn_recalc_wo_total()
returns trigger
language plpgsql
as $$
begin
  new.total_cost := coalesce(new.labor_cost, 0) + coalesce(new.parts_cost, 0)
                  + coalesce(new.service_cost, 0);
  return new;
end;
$$;

drop trigger if exists trg_wo_total on maintenance.work_orders;
create trigger trg_wo_total before insert or update of labor_cost, parts_cost, service_cost
  on maintenance.work_orders
  for each row execute function maintenance.fn_recalc_wo_total();

-- -----------------------------------------------------------------------------
-- Vade hesabı
-- -----------------------------------------------------------------------------
-- Bir planın bir ekipman için en son ne zaman / hangi sayaçta yapıldığı.
-- Hiç yapılmadıysa ekipmanın alım tarihi başlangıç kabul edilir: yeni makine
-- ilk bakımına alım tarihinden itibaren sayar.
create or replace function maintenance.last_service(p_equipment_id uuid, p_plan_id uuid)
returns table (last_date date, last_usage numeric)
language sql
stable
security definer
set search_path = maintenance, pg_temp
as $$
  with done as (
    select w.completed_at, w.usage_at_service
    from maintenance.work_orders w
    where w.equipment_id = p_equipment_id and w.plan_id = p_plan_id and w.status = 'done'
    order by w.completed_at desc
    limit 1
  )
  select
    coalesce(
      (select completed_at::date from done),
      (select e.purchase_date from maintenance.equipment e where e.id = p_equipment_id),
      (select e.created_at::date from maintenance.equipment e where e.id = p_equipment_id)
    ),
    -- Hiç bakım yapılmadıysa referans SIFIRDIR: makinenin ilk günden beri
    -- yaptığı tüm çekimler ilk bakımın vadesine sayılır.
    coalesce((select usage_at_service from done), 0);
$$;

-- Vadesi gelen plan-ekipman çiftleri
create or replace view maintenance.v_due_plans
with (security_invoker = on) as
select
  p.tenant_id,
  p.id            as plan_id,
  p.code          as plan_code,
  p.name          as plan_name,
  p.lead_days,
  p.estimated_minutes,
  e.id            as equipment_id,
  e.code          as equipment_code,
  e.name          as equipment_name,
  e.branch_id,
  e.is_critical,
  ls.last_date,
  case when p.interval_days is not null
       then ls.last_date + p.interval_days else null end as due_date,
  case when p.interval_days is not null
       then (ls.last_date + p.interval_days) - current_date else null end as days_left,
  -- Kullanım sayacı bazlı vade: son bakımdan bu yana kaç birim çalıştı
  case when p.interval_usage is not null
       then e.usage_counter - ls.last_usage
       else null end as usage_since_service,
  p.interval_usage
from maintenance.plans p
join maintenance.equipment e
  on e.tenant_id = p.tenant_id
 and e.status <> 'retired'
 and (p.equipment_id = e.id or (p.equipment_id is null and p.category = e.category))
cross join lateral maintenance.last_service(e.id, p.id) ls
where p.is_active;

-- -----------------------------------------------------------------------------
-- Plandan iş emri üretimi (pg_cron ile günlük)
-- -----------------------------------------------------------------------------
-- Vadesi lead_days içine girmiş her plan için PLANLANMIŞ iş emri açar.
-- Kopya üretmez: açık iş emri varsa kısmi benzersizlik indeksi (0700, karar 3)
-- ikinciyi reddeder ve döngü onu sessizce atlar.
create or replace function maintenance.generate_work_orders()
returns integer
language plpgsql
security definer
set search_path = maintenance, core, pg_temp
as $$
declare
  r    record;
  v_id uuid;
  v_n  integer := 0;
begin
  for r in
    select d.*, p.instructions
    from maintenance.v_due_plans d
    join maintenance.plans p on p.id = d.plan_id
    where (d.days_left is not null and d.days_left <= d.lead_days)
       or (d.interval_usage is not null and d.usage_since_service >= d.interval_usage * 0.9)
  loop
    begin
      insert into maintenance.work_orders (
        tenant_id, branch_id, equipment_id, plan_id, kind, status, priority,
        title, description, scheduled_date)
      values (
        r.tenant_id, r.branch_id, r.equipment_id, r.plan_id, 'preventive', 'scheduled',
        case when r.is_critical then 2 else 3 end,
        format('%s — %s', r.equipment_name, r.plan_name),
        r.instructions,
        coalesce(r.due_date, current_date))
      returning id into v_id;
    exception when unique_violation then
      -- Bu plan için zaten açık iş emri var; yenisini açmıyoruz.
      continue;
    end;

    -- Plan görevlerini iş emrine kopyala (kalite modülündeki ölçüt anlık
    -- görüntüsüyle aynı gerekçe: plan değişse de açık iş emri kendini anlatsın)
    insert into maintenance.work_order_tasks (tenant_id, work_order_id, sequence, name, instructions)
    select r.tenant_id, v_id, t.sequence, t.name, t.instructions
    from maintenance.plan_tasks t where t.plan_id = r.plan_id order by t.sequence;

    perform core.emit_event('maintenance.workorder.created', jsonb_build_object(
      'work_order_id', v_id, 'equipment_id', r.equipment_id, 'plan_id', r.plan_id,
      'kind', 'preventive', 'due_date', r.due_date, 'is_critical', r.is_critical
    ), r.branch_id, null, r.tenant_id);

    v_n := v_n + 1;
  end loop;

  return v_n;
end;
$$;

-- -----------------------------------------------------------------------------
-- Arıza bildirimi
-- -----------------------------------------------------------------------------
-- Kritik ekipman arızası, iş emri açmakla kalmaz: ekipmanı DURDU'ya çeker.
-- Durum ekipman kartında görünmezse, "makine çalışıyor mu" sorusu her seferinde
-- birine telefon açmayı gerektirir.
create or replace function maintenance.report_breakdown(
  p_equipment_id uuid, p_title text, p_description text default null,
  p_priority smallint default 1
)
returns maintenance.work_orders
language plpgsql
security invoker
as $$
declare
  v_eq maintenance.equipment;
  v_wo maintenance.work_orders;
begin
  select * into v_eq from maintenance.equipment where id = p_equipment_id for update;
  if not found then raise exception 'Ekipman bulunamadı' using errcode = 'P0002'; end if;

  insert into maintenance.work_orders (
    branch_id, equipment_id, kind, status, priority, title, description)
  values (v_eq.branch_id, p_equipment_id, 'corrective', 'scheduled',
          coalesce(p_priority, 1), p_title, p_description)
  returning * into v_wo;

  update maintenance.equipment set status = 'down' where id = p_equipment_id;

  perform core.emit_event('maintenance.equipment.down', jsonb_build_object(
    'equipment_id', v_eq.id, 'code', v_eq.code, 'name', v_eq.name,
    'is_critical', v_eq.is_critical, 'work_order_id', v_wo.id, 'title', p_title
  ), v_eq.branch_id, null, v_eq.tenant_id);

  return v_wo;
end;
$$;

-- -----------------------------------------------------------------------------
-- İş emri akışı
-- -----------------------------------------------------------------------------
create or replace function maintenance.start_work_order(p_id uuid)
returns maintenance.work_orders
language plpgsql
security invoker
as $$
declare v_wo maintenance.work_orders;
begin
  select * into v_wo from maintenance.work_orders where id = p_id for update;
  if not found then raise exception 'İş emri bulunamadı' using errcode = 'P0002'; end if;
  if v_wo.status not in ('draft', 'scheduled') then
    raise exception 'Yalnızca planlanmış iş emri başlatılabilir (mevcut: %)', v_wo.status
      using errcode = '23514';
  end if;

  update maintenance.work_orders
     set status = 'in_progress', started_at = coalesce(started_at, now()),
         assignee_id = coalesce(assignee_id, core.current_user_id())
   where id = p_id returning * into v_wo;

  -- Bakıma alınan ekipman "arızalı" değil "bakımda"dır; ikisi farklı şeydir.
  update maintenance.equipment set status = 'maintenance'
   where id = v_wo.equipment_id and status = 'operational';

  return v_wo;
end;
$$;

create or replace function maintenance.complete_work_order(
  p_id uuid, p_resolution text default null, p_downtime_minutes integer default null
)
returns maintenance.work_orders
language plpgsql
security invoker
as $$
declare
  v_wo      maintenance.work_orders;
  v_pending text;
  v_parts   jsonb;
begin
  if not core.has_perm('maintenance.workorder.complete') then
    raise exception 'İş emri tamamlama yetkiniz yok' using errcode = '42501';
  end if;

  select * into v_wo from maintenance.work_orders where id = p_id for update;
  if not found then raise exception 'İş emri bulunamadı' using errcode = 'P0002'; end if;
  if v_wo.status not in ('scheduled', 'in_progress') then
    raise exception 'Bu iş emri tamamlanamaz (mevcut: %)', v_wo.status using errcode = '23514';
  end if;

  -- Yapılmamış görev varken "bitti" demek, bakımı kâğıt üzerinde yapmaktır.
  select string_agg(t.name, ', ') into v_pending
  from maintenance.work_order_tasks t
  where t.work_order_id = p_id and not t.is_done;
  if v_pending is not null then
    raise exception 'Tamamlanmamış görev var: %', v_pending using errcode = '23514';
  end if;

  update maintenance.work_orders
     set status = 'done',
         completed_at = now(),
         started_at = coalesce(started_at, now()),
         resolution = coalesce(p_resolution, resolution),
         downtime_minutes = coalesce(p_downtime_minutes, downtime_minutes),
         labor_minutes = coalesce(
           nullif(labor_minutes, 0),
           (extract(epoch from (now() - coalesce(started_at, now()))) / 60)::integer),
         -- Vade hesabının dayanağı: bakım anındaki sayaç dondurulur
         usage_at_service = coalesce(
           usage_at_service,
           (select e.usage_counter from maintenance.equipment e where e.id = work_orders.equipment_id)),
         number = coalesce(number, core.next_sequence('maintenance_work_order', branch_id, tenant_id))
   where id = p_id returning * into v_wo;

  -- Bakım bitince ekipman çalışır duruma döner (hurdaya ayrılmadıysa).
  update maintenance.equipment set status = 'operational'
   where id = v_wo.equipment_id and status in ('maintenance', 'down');

  -- Kullanılan parçalar: Envanter modülü açıksa stoktan düşülür (0703).
  select jsonb_agg(jsonb_build_object(
           'product_id', pt.product_id, 'quantity', pt.quantity,
           'unit_cost', pt.unit_cost, 'part_id', pt.id))
    into v_parts
  from maintenance.work_order_parts pt
  where pt.work_order_id = p_id and not pt.stock_issued;

  if v_parts is not null then
    perform core.emit_event('maintenance.parts.consumed', jsonb_build_object(
      'work_order_id', v_wo.id, 'number', v_wo.number,
      'equipment_id', v_wo.equipment_id, 'lines', v_parts
    ), v_wo.branch_id, null, v_wo.tenant_id);
  end if;

  perform core.emit_event('maintenance.workorder.completed', jsonb_build_object(
    'work_order_id', v_wo.id, 'number', v_wo.number, 'equipment_id', v_wo.equipment_id,
    'kind', v_wo.kind, 'downtime_minutes', v_wo.downtime_minutes,
    'total_cost', v_wo.total_cost
  ), v_wo.branch_id, null, v_wo.tenant_id);

  return v_wo;
end;
$$;

-- Tamamlanmış iş emri değiştirilemez: bakım geçmişi bir kayıttır.
create or replace function maintenance.fn_lock_done_wo()
returns trigger
language plpgsql
as $$
begin
  if tg_op = 'DELETE' then
    if old.status = 'done' then
      raise exception 'Tamamlanmış iş emri silinemez (%)', old.number using errcode = '23514';
    end if;
    return old;
  end if;
  if old.status = 'done' and new.status = 'done'
     and (new.equipment_id, new.downtime_minutes, new.total_cost, new.completed_at)
         is distinct from (old.equipment_id, old.downtime_minutes, old.total_cost, old.completed_at)
  then
    raise exception 'Tamamlanmış iş emri değiştirilemez (%)', old.number using errcode = '23514';
  end if;
  return new;
end;
$$;

drop trigger if exists trg_wo_lock on maintenance.work_orders;
create trigger trg_wo_lock before update or delete on maintenance.work_orders
  for each row execute function maintenance.fn_lock_done_wo();

select core.declare_event('maintenance.workorder.created', 'maintenance',
       'Periyodik bakım iş emri açıldı');
select core.declare_event('maintenance.workorder.completed', 'maintenance',
       'Bakım iş emri tamamlandı');
select core.declare_event('maintenance.equipment.down', 'maintenance',
       'Ekipman arızalandı ve durdu');
select core.declare_event('maintenance.parts.consumed', 'maintenance',
       'Bakımda yedek parça kullanıldı — Envanter stoktan düşer');
