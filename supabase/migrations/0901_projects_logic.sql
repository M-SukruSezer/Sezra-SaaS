-- =============================================================================
-- 0901 — Proje iş kuralları
-- =============================================================================

-- -----------------------------------------------------------------------------
-- Çalışanın saatlik maliyeti
-- -----------------------------------------------------------------------------
-- İK modülü AÇIKSA sözleşmeden hesaplanır, kapalıysa sıfır döner ve kârlılık
-- raporu yalnızca geliri gösterir. Proje modülü İK'ya bağımlı OLMAMALIDIR:
-- danışmanlık yapan bir kiracı Proje alıp İK almayabilir.
--
-- to_regclass kontrolü şart: İK şeması hiç kurulmamış olabilir ve o durumda
-- tabloya yapılan doğrudan referans fonksiyonu derlenemez hâle getirirdi.
create or replace function projects.hourly_cost_for(
  p_tenant_id uuid, p_user_id uuid, p_date date
)
returns numeric
language plpgsql
stable
security definer
set search_path = projects, core, pg_temp
as $$
declare v_cost numeric := 0;
begin
  if to_regclass('hr.employee_contracts') is null then
    return 0;
  end if;
  if not exists (select 1 from core.tenant_modules
                  where tenant_id = p_tenant_id and module_code = 'hr' and enabled) then
    return 0;
  end if;

  -- Aylık brüt / (haftalık saat × 52 / 12). İşveren yükleri dahil edilmedi:
  -- bordro motoru onu kendi hesaplar ve burada tekrar üretmek iki ayrı doğruluk
  -- kaynağı yaratırdı. Maliyet "brüt saatlik ücret" olarak okunmalıdır.
  execute $q$
    select round(c.wage_amount / nullif(coalesce(c.weekly_hours, 45) * 52 / 12, 0), 4)
    from hr.employee_contracts c
    join hr.employees e on e.id = c.employee_id
    where e.tenant_id = $1 and e.user_id = $2
      and c.valid_from <= $3 and (c.valid_to is null or c.valid_to >= $3)
    order by c.valid_from desc
    limit 1
  $q$ into v_cost using p_tenant_id, p_user_id, p_date;

  return coalesce(v_cost, 0);
end;
$$;

-- -----------------------------------------------------------------------------
-- Zaman kaydı: oran ve maliyet dondurma
-- -----------------------------------------------------------------------------
create or replace function projects.fn_calc_timesheet()
returns trigger
language plpgsql
as $$
declare v_proj projects.projects;
begin
  select * into v_proj from projects.projects where id = new.project_id;

  -- Faturalanabilirlik proje tipinden gelir; iç projede saat müşteriye yansımaz.
  if tg_op = 'INSERT' then
    if v_proj.billing_type = 'internal' then
      new.is_billable := false;
    end if;
    -- Oran ve maliyet YALNIZCA ilk kayıtta dondurulur (0900, karar 2).
    if coalesce(new.hourly_rate, 0) = 0 then
      new.hourly_rate := coalesce(v_proj.hourly_rate, 0);
    end if;
    if coalesce(new.hourly_cost, 0) = 0 then
      new.hourly_cost := projects.hourly_cost_for(new.tenant_id, new.user_id, new.work_date);
    end if;
    new.branch_id := coalesce(new.branch_id, v_proj.branch_id);

    -- ZAMAN KAYDININ SAHİBİ, ONU GİREN DEĞİL ÇALIŞAN KİŞİDİR.
    -- Çekirdek varsayılanı owner_id'yi "kaydı oluşturan" yapar; burada bilerek
    -- eziyoruz. Yönetici bir ekip üyesi adına saat girdiğinde kaydın sahibi
    -- yine o üyedir — aksi hâlde `.own` kapsamı yanlış kişiyi gösterir ve
    -- çalışan kendi saatini göremez.
    new.owner_id := new.user_id;
  end if;

  new.billable_amount := case when new.is_billable
                              then round(new.hours * new.hourly_rate, 2) else 0 end;
  new.cost_amount := round(new.hours * new.hourly_cost, 2);
  return new;
end;
$$;

drop trigger if exists trg_timesheet_calc on projects.timesheets;
create trigger trg_timesheet_calc before insert or update on projects.timesheets
  for each row execute function projects.fn_calc_timesheet();

-- KARAR 3: faturalanmış zaman kaydı dokunulmazdır.
create or replace function projects.fn_lock_invoiced_timesheet()
returns trigger
language plpgsql
as $$
begin
  if tg_op = 'DELETE' then
    if old.invoiced_at is not null then
      raise exception 'Faturalanmış zaman kaydı silinemez' using errcode = '23514';
    end if;
    return old;
  end if;
  if old.invoiced_at is not null
     and (new.hours, new.hourly_rate, new.is_billable, new.project_id)
         is distinct from (old.hours, old.hourly_rate, old.is_billable, old.project_id) then
    raise exception 'Faturalanmış zaman kaydı değiştirilemez — düzeltme fatura üzerinden yapılır'
      using errcode = '23514';
  end if;
  return new;
end;
$$;

drop trigger if exists trg_timesheet_lock on projects.timesheets;
create trigger trg_timesheet_lock before update or delete on projects.timesheets
  for each row execute function projects.fn_lock_invoiced_timesheet();

-- -----------------------------------------------------------------------------
-- Görev akışı
-- -----------------------------------------------------------------------------
create or replace function projects.complete_task(p_id uuid)
returns projects.tasks
language plpgsql
security invoker
as $$
declare
  v_task projects.tasks;
  v_open text;
begin
  select * into v_task from projects.tasks where id = p_id for update;
  if not found then raise exception 'Görev bulunamadı' using errcode = 'P0002'; end if;
  if v_task.status = 'done' then return v_task; end if;

  -- Alt görevleri açıkken üst görev kapanamaz: kapanmış görünen ama işi biten
  -- bir üst görev, planlamayı sessizce yanıltır.
  select string_agg(t.name, ', ') into v_open
  from projects.tasks t
  where t.parent_id = p_id and t.status not in ('done', 'cancelled');
  if v_open is not null then
    raise exception 'Tamamlanmamış alt görev var: %', v_open using errcode = '23514';
  end if;

  update projects.tasks
     set status = 'done', done_at = now()
   where id = p_id returning * into v_task;

  perform core.emit_event('projects.task.completed', jsonb_build_object(
    'task_id', v_task.id, 'project_id', v_task.project_id, 'name', v_task.name,
    'assignee_id', v_task.assignee_id
  ), v_task.branch_id, null, v_task.tenant_id);

  return v_task;
end;
$$;

create or replace function projects.complete_project(p_id uuid)
returns projects.projects
language plpgsql
security invoker
as $$
declare
  v_proj projects.projects;
  v_open integer;
  v_unbilled numeric;
begin
  if not core.has_perm('projects.project.complete') then
    raise exception 'Proje kapatma yetkiniz yok' using errcode = '42501';
  end if;

  select * into v_proj from projects.projects where id = p_id for update;
  if not found then raise exception 'Proje bulunamadı' using errcode = 'P0002'; end if;
  if v_proj.status = 'completed' then return v_proj; end if;

  select count(*) into v_open from projects.tasks
   where project_id = p_id and status not in ('done', 'cancelled');
  if v_open > 0 then
    raise exception '% açık görev var — önce tamamlayın ya da iptal edin', v_open
      using errcode = '23514';
  end if;

  -- Faturalanmamış hakediş varken proje kapatmak, gelirin unutulmasının en
  -- yaygın yoludur. Uyarı değil, ENGEL.
  select coalesce(sum(billable_amount), 0) into v_unbilled
  from projects.timesheets
  where project_id = p_id and is_billable and invoiced_at is null;
  if v_unbilled > 0 then
    raise exception 'Faturalanmamış % tutarında hakediş var — önce faturalayın', v_unbilled
      using errcode = '23514';
  end if;

  update projects.projects
     set status = 'completed', completed_at = now()
   where id = p_id returning * into v_proj;

  perform core.emit_event('projects.project.completed', jsonb_build_object(
    'project_id', v_proj.id, 'code', v_proj.code, 'name', v_proj.name,
    'partner_id', v_proj.partner_id
  ), v_proj.branch_id, null, v_proj.tenant_id);

  return v_proj;
end;
$$;

-- -----------------------------------------------------------------------------
-- Hakediş faturalaması
-- -----------------------------------------------------------------------------
-- Faturalanmamış faturalanabilir saatleri toplar, olayı yayınlar ve kayıtları
-- faturalanmış işaretler. Faturayı KENDİ OLUŞTURMAZ: fatura Muhasebe'nin işidir
-- ve Proje modülü Muhasebe'siz de çalışmalıdır.
create or replace function projects.bill_project(
  p_project_id uuid, p_up_to date default null
)
returns jsonb
language plpgsql
security invoker
as $$
declare
  v_proj  projects.projects;
  v_lines jsonb;
  v_total numeric;
  v_hours numeric;
  v_batch uuid := gen_random_uuid();
begin
  if not core.has_perm('projects.project.bill') then
    raise exception 'Hakediş faturalama yetkiniz yok' using errcode = '42501';
  end if;

  select * into v_proj from projects.projects where id = p_project_id for update;
  if not found then raise exception 'Proje bulunamadı' using errcode = 'P0002'; end if;
  if v_proj.partner_id is null then
    raise exception 'Projede müşteri tanımlı değil — fatura kesilemez' using errcode = '23514';
  end if;

  -- Kişi bazında toplanır: fatura satırı "Ali Kaya — 12 saat" olur, 40 ayrı
  -- satır değil. Ayrıntı zaman çizelgesinde zaten duruyor.
  select jsonb_agg(x.line order by x.user_name),
         sum(x.amount), sum(x.hours)
    into v_lines, v_total, v_hours
  from (
    select u.full_name as user_name,
           sum(t.hours) as hours,
           sum(t.billable_amount) as amount,
           jsonb_build_object(
             'description', format('%s — %s saat', u.full_name, sum(t.hours)),
             'quantity', sum(t.hours),
             'unit_price', max(t.hourly_rate),
             'amount', sum(t.billable_amount)) as line
    from projects.timesheets t
    join core.users u on u.id = t.user_id
    where t.project_id = p_project_id
      and t.is_billable and t.invoiced_at is null
      and (p_up_to is null or t.work_date <= p_up_to)
    group by u.full_name
  ) x;

  if v_lines is null then
    raise exception 'Faturalanacak hakediş yok' using errcode = 'P0002';
  end if;

  update projects.timesheets
     set invoiced_at = now(), invoice_id = v_batch
   where project_id = p_project_id
     and is_billable and invoiced_at is null
     and (p_up_to is null or work_date <= p_up_to);

  perform core.emit_event('projects.billing.requested', jsonb_build_object(
    'project_id', v_proj.id, 'batch_id', v_batch,
    'code', v_proj.code, 'name', v_proj.name,
    'partner_id', v_proj.partner_id, 'currency', v_proj.currency,
    'total_hours', v_hours, 'total_amount', v_total,
    'lines', v_lines
  ), v_proj.branch_id, null, v_proj.tenant_id);

  return jsonb_build_object('batch_id', v_batch, 'hours', v_hours, 'amount', v_total);
end;
$$;

select core.declare_event('projects.task.completed', 'projects', 'Görev tamamlandı');
select core.declare_event('projects.project.completed', 'projects', 'Proje tamamlandı');
select core.declare_event('projects.billing.requested', 'projects',
       'Hakediş faturalanmak üzere hazırlandı — Muhasebe fatura taslağı üretir');
