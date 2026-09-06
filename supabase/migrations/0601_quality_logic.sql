-- =============================================================================
-- 0601 — Kalite iş kuralları
-- =============================================================================

-- -----------------------------------------------------------------------------
-- Plan seçimi
-- -----------------------------------------------------------------------------
-- Ürüne özel plan > kategori planı > genel plan. Özelden genele inen bu sıra,
-- "bir ürün için özel kural yazdım ama kategori planı devrede kaldı" hatasını
-- imkânsız kılar.
create or replace function quality.resolve_plan(
  p_product_id uuid, p_stage text default 'incoming', p_tenant_id uuid default null
)
returns uuid
language sql
stable
security definer
set search_path = quality, core, pg_temp
as $$
  select pl.id
  from quality.plans pl
  left join core.products pr on pr.id = p_product_id
  where pl.tenant_id = coalesce(p_tenant_id, core.current_tenant_id())
    and pl.is_active
    and pl.stage = p_stage
    and (pl.product_id = p_product_id
         or (pl.product_id is null and pl.category_id = pr.category_id)
         or (pl.product_id is null and pl.category_id is null))
  order by (pl.product_id is not null) desc,
           (pl.category_id is not null) desc,
           pl.code
  limit 1;
$$;

-- -----------------------------------------------------------------------------
-- Ölçüm değerlendirme
-- -----------------------------------------------------------------------------
-- Her ölçüm satırı, KENDİ üzerindeki ölçüte göre değerlendirilir (0600 karar 1).
-- Plana bakmıyoruz: plan değişse bile bu satır aynı sonucu vermeye devam eder.
create or replace function quality.fn_evaluate_result()
returns trigger
language plpgsql
as $$
begin
  new.passed := case new.kind
    when 'numeric' then
      case when new.numeric_value is null then null
           else (new.min_value is null or new.numeric_value >= new.min_value)
            and (new.max_value is null or new.numeric_value <= new.max_value)
      end
    when 'boolean' then
      case when new.bool_value is null then null
           else new.bool_value is not distinct from coalesce(new.expected_bool, true)
      end
    when 'choice' then
      case when new.text_value is null then null
           else new.text_value = new.expected_choice
      end
    -- Serbest metin ölçütü bir DEĞERLENDİRME değil, KAYITTIR (ör. "koku notu").
    -- Doldurulmuşsa geçmiş sayılır; geçti/kaldı kararına ağırlık vermez.
    when 'text' then
      case when new.text_value is null or new.text_value = '' then null else true end
  end;
  return new;
end;
$$;

drop trigger if exists trg_quality_results_evaluate on quality.results;
create trigger trg_quality_results_evaluate
  before insert or update of numeric_value, bool_value, text_value on quality.results
  for each row execute function quality.fn_evaluate_result();

-- -----------------------------------------------------------------------------
-- Muayene açma
-- -----------------------------------------------------------------------------
-- Plandaki ölçütleri ANLIK GÖRÜNTÜ olarak kopyalar. Ölçüm alanları boş doğar:
-- muayeneyi bir insan doldurur (0600 karar 3).
create or replace function quality.open_inspection(
  p_tenant_id uuid, p_branch_id uuid, p_product_id uuid, p_quantity numeric,
  p_partner_id uuid default null, p_lot_id uuid default null,
  p_stage text default 'incoming',
  p_source_module text default null, p_source_table text default null,
  p_source_id uuid default null
)
returns uuid
language plpgsql
security definer
set search_path = quality, core, pg_temp
as $$
declare
  v_plan uuid := quality.resolve_plan(p_product_id, p_stage, p_tenant_id);
  v_id   uuid;
  v_pct  numeric;
begin
  -- Planı olmayan ürün muayeneye girmez. Boş muayene açmak, kalite kontrolü
  -- doldurulmayan formlar yığınına çevirirdi.
  if v_plan is null then
    return null;
  end if;

  select sample_pct into v_pct from quality.plans where id = v_plan;

  insert into quality.inspections (
    tenant_id, branch_id, plan_id, product_id, lot_id, partner_id,
    quantity, sampled_quantity, stage, source_module, source_table, source_id)
  values (
    p_tenant_id, p_branch_id, v_plan, p_product_id, p_lot_id, p_partner_id,
    p_quantity, round(p_quantity * coalesce(v_pct, 100) / 100, 4), p_stage,
    p_source_module, p_source_table, p_source_id)
  returning id into v_id;

  insert into quality.results (
    tenant_id, inspection_id, check_point_id, sequence,
    code, name, kind, unit, min_value, max_value,
    expected_bool, expected_choice, is_critical)
  select p_tenant_id, v_id, cp.id, cp.sequence,
         cp.code, cp.name, cp.kind, cp.unit, cp.min_value, cp.max_value,
         cp.expected_bool, cp.expected_choice, cp.is_critical
  from quality.check_points cp
  where cp.plan_id = v_plan
  order by cp.sequence;

  return v_id;
end;
$$;

-- -----------------------------------------------------------------------------
-- Muayeneyi tamamlama
-- -----------------------------------------------------------------------------
create or replace function quality.complete_inspection(p_id uuid)
returns quality.inspections
language plpgsql
security invoker
as $$
declare
  v_insp    quality.inspections;
  v_missing text;
  v_failed  integer;
  v_crit    integer;
  v_nc      uuid;
begin
  if not core.has_perm('quality.inspection.complete') then
    raise exception 'Muayene tamamlama yetkiniz yok' using errcode = '42501';
  end if;

  select * into v_insp from quality.inspections where id = p_id for update;
  if not found then raise exception 'Muayene bulunamadı' using errcode = 'P0002'; end if;
  if v_insp.status <> 'draft' then
    raise exception 'Yalnızca taslak muayene tamamlanabilir (mevcut: %)', v_insp.status
      using errcode = '23514';
  end if;

  -- ÖLÇÜLMEMİŞ ÖLÇÜT KALAMAZ. Yarım muayeneyi "geçti" saymak, kontrolü
  -- yapılmamış bir partiyi onaylamak demektir.
  select string_agg(r.name, ', ') into v_missing
  from quality.results r
  where r.inspection_id = p_id and r.passed is null;
  if v_missing is not null then
    raise exception 'Ölçülmemiş ölçüt var: %', v_missing using errcode = '23514';
  end if;

  select count(*) filter (where not passed),
         count(*) filter (where not passed and is_critical)
    into v_failed, v_crit
  from quality.results where inspection_id = p_id;

  update quality.inspections
     set status = (case when v_failed > 0 then 'failed' else 'passed' end)::quality.inspection_status,
         inspector_id = core.current_user_id(),
         inspected_at = now(),
         number = coalesce(number, core.next_sequence('quality_inspection', branch_id, tenant_id))
   where id = p_id returning * into v_insp;

  -- Kalan muayene otomatik uygunsuzluk açar: kararın kaydı olmadan kapanmasın.
  if v_failed > 0 then
    insert into quality.nonconformities (
      tenant_id, branch_id, inspection_id, product_id, partner_id, quantity,
      severity, description,
      number)
    values (
      v_insp.tenant_id, v_insp.branch_id, v_insp.id, v_insp.product_id,
      v_insp.partner_id, v_insp.quantity,
      case when v_crit > 0 then 'critical' else 'major' end,
      format('%s ölçütten %s kaldı%s', 
             (select count(*) from quality.results where inspection_id = p_id),
             v_failed,
             case when v_crit > 0 then format(' (%s kritik)', v_crit) else '' end),
      core.next_sequence('quality_nonconformity', v_insp.branch_id, v_insp.tenant_id))
    returning id into v_nc;

    perform core.emit_event('quality.inspection.failed', jsonb_build_object(
      'inspection_id', v_insp.id, 'number', v_insp.number,
      'product_id', v_insp.product_id, 'partner_id', v_insp.partner_id,
      'quantity', v_insp.quantity, 'failed_count', v_failed, 'critical_count', v_crit,
      'nonconformity_id', v_nc,
      'source_module', v_insp.source_module, 'source_id', v_insp.source_id
    ), v_insp.branch_id, null, v_insp.tenant_id);
  end if;

  perform core.emit_event('quality.inspection.completed', jsonb_build_object(
    'inspection_id', v_insp.id, 'number', v_insp.number, 'status', v_insp.status,
    'product_id', v_insp.product_id, 'partner_id', v_insp.partner_id
  ), v_insp.branch_id, null, v_insp.tenant_id);

  return v_insp;
end;
$$;

-- Tamamlanmış muayenenin ölçümleri değiştirilemez.
create or replace function quality.fn_lock_completed_inspection()
returns trigger
language plpgsql
as $$
declare v_status quality.inspection_status;
begin
  select status into v_status from quality.inspections
   where id = coalesce(new.inspection_id, old.inspection_id);
  if v_status in ('passed', 'failed') then
    raise exception 'Tamamlanmış muayenenin ölçümleri değiştirilemez'
      using errcode = '23514',
            hint = 'Yeniden muayene için yeni bir kayıt açın; geçmiş ölçüm silinmez.';
  end if;
  return coalesce(new, old);
end;
$$;

drop trigger if exists trg_quality_results_lock on quality.results;
create trigger trg_quality_results_lock
  before insert or update or delete on quality.results
  for each row execute function quality.fn_lock_completed_inspection();

-- -----------------------------------------------------------------------------
-- Uygunsuzluk tasarrufu
-- -----------------------------------------------------------------------------
create or replace function quality.decide_nonconformity(
  p_id uuid, p_disposition quality.disposition, p_note text default null,
  p_corrective_action text default null
)
returns quality.nonconformities
language plpgsql
security invoker
as $$
declare v_nc quality.nonconformities;
begin
  if not core.has_perm('quality.nonconformity.decide') then
    raise exception 'Uygunsuzluk kararı verme yetkiniz yok' using errcode = '42501';
  end if;
  if p_disposition = 'pending' then
    raise exception 'Tasarruf "beklemede" olarak kapatılamaz' using errcode = '23514';
  end if;

  -- Sapmayla kabul, gerekçesiz verilemez: bu karar denetimde ilk sorulacak şeydir.
  if p_disposition = 'accept_with_deviation'
     and coalesce(trim(p_note), '') = '' then
    raise exception 'Sapmayla kabul için gerekçe zorunludur' using errcode = '23514';
  end if;

  update quality.nonconformities
     set disposition = p_disposition,
         disposition_note = p_note,
         corrective_action = coalesce(p_corrective_action, corrective_action),
         decided_by = core.current_user_id(),
         decided_at = now(),
         closed_at = now()
   where id = p_id and closed_at is null
   returning * into v_nc;

  if not found then
    raise exception 'Açık uygunsuzluk kaydı bulunamadı' using errcode = 'P0002';
  end if;

  perform core.emit_event('quality.nonconformity.decided', jsonb_build_object(
    'nonconformity_id', v_nc.id, 'number', v_nc.number,
    'disposition', v_nc.disposition, 'severity', v_nc.severity,
    'product_id', v_nc.product_id, 'partner_id', v_nc.partner_id,
    'quantity', v_nc.quantity
  ), v_nc.branch_id, null, v_nc.tenant_id);

  return v_nc;
end;
$$;

select core.declare_event('quality.inspection.completed', 'quality', 'Muayene tamamlandı');
select core.declare_event('quality.inspection.failed', 'quality',
       'Muayene kaldı — uygunsuzluk kaydı açıldı');
select core.declare_event('quality.nonconformity.decided', 'quality',
       'Uygunsuzluk için tasarruf kararı verildi');
