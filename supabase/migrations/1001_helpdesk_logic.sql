-- =============================================================================
-- 1001 — Destek Masası iş kuralları
-- =============================================================================

-- -----------------------------------------------------------------------------
-- SLA politikası seçimi
-- -----------------------------------------------------------------------------
-- Ekibe özel politika > genel politika. Öncelik her zaman eşleşmelidir.
create or replace function helpdesk.resolve_sla(
  p_tenant_id uuid, p_priority helpdesk.ticket_priority, p_team_id uuid default null
)
returns helpdesk.sla_policies
language sql
stable
security definer
set search_path = helpdesk, pg_temp
as $$
  select *
  from helpdesk.sla_policies s
  where s.tenant_id = p_tenant_id
    and s.is_active
    and s.priority = p_priority
    and (s.team_id = p_team_id or s.team_id is null)
  order by (s.team_id is not null) desc, s.code
  limit 1;
$$;

-- -----------------------------------------------------------------------------
-- Bilet açılışı: hedefleri dondur
-- -----------------------------------------------------------------------------
create or replace function helpdesk.fn_ticket_defaults()
returns trigger
language plpgsql
as $$
declare v_sla helpdesk.sla_policies;
begin
  if tg_op = 'INSERT' then
    -- Kiracı, çekirdek tetikleyicisi (trg_00_) tarafından çoktan dolduruldu.
    v_sla := helpdesk.resolve_sla(new.tenant_id, new.priority, new.team_id);

    if v_sla.id is not null then
      new.sla_policy_id := v_sla.id;
      new.first_response_target_minutes := v_sla.first_response_minutes;
      new.resolution_target_minutes := v_sla.resolution_minutes;
      new.first_response_due :=
        coalesce(new.created_at, now()) + (v_sla.first_response_minutes || ' minutes')::interval;
      new.resolution_due :=
        coalesce(new.created_at, now()) + (v_sla.resolution_minutes || ' minutes')::interval;
    end if;

    if new.number is null then
      new.number := core.next_sequence('helpdesk_ticket', new.branch_id, new.tenant_id);
    end if;
  end if;
  return new;
end;
$$;

drop trigger if exists trg_hd_ticket_defaults on helpdesk.tickets;
create trigger trg_hd_ticket_defaults before insert on helpdesk.tickets
  for each row execute function helpdesk.fn_ticket_defaults();

-- Bilet açılınca olay yayınla (bildirim, otomasyon buna abone olabilir)
create or replace function helpdesk.fn_ticket_created()
returns trigger
language plpgsql
as $$
begin
  perform core.emit_event('helpdesk.ticket.created', jsonb_build_object(
    'ticket_id', new.id, 'number', new.number, 'subject', new.subject,
    'priority', new.priority, 'partner_id', new.partner_id,
    'team_id', new.team_id, 'resolution_due', new.resolution_due
  ), new.branch_id, null, new.tenant_id);
  return null;
end;
$$;

drop trigger if exists trg_hd_ticket_created on helpdesk.tickets;
create trigger trg_hd_ticket_created after insert on helpdesk.tickets
  for each row execute function helpdesk.fn_ticket_created();

-- -----------------------------------------------------------------------------
-- Mesaj: ilk yanıt damgası
-- -----------------------------------------------------------------------------
-- İlk yanıt, MÜŞTERİYE GİDEN ilk mesajdır. İç not ilk yanıt sayılmaz — ekip
-- kendi arasında konuşurken müşteri hâlâ bekliyordur.
create or replace function helpdesk.fn_message_effects()
returns trigger
language plpgsql
as $$
declare v_ticket helpdesk.tickets;
begin
  select * into v_ticket from helpdesk.tickets where id = new.ticket_id for update;

  if new.is_from_customer then
    -- Müşteri yanıt verdi: bekleme durduysa saat yeniden işlemeye başlar.
    if v_ticket.status = 'pending_customer' then
      update helpdesk.tickets
         set status = 'open',
             paused_minutes = paused_minutes
               + greatest(floor(extract(epoch from (now() - coalesce(paused_at, now()))) / 60), 0)::integer,
             paused_at = null,
             -- Duraklama süresi kadar hedefler ötelenir (0800/karar 2)
             first_response_due = case when first_response_at is null
               then first_response_due + (now() - coalesce(paused_at, now())) end,
             resolution_due = resolution_due + (now() - coalesce(paused_at, now()))
       where id = new.ticket_id;
    end if;
  elsif not new.is_internal then
    -- Müşteriye giden ilk mesaj: ilk yanıt damgası
    if v_ticket.first_response_at is null then
      update helpdesk.tickets
         set first_response_at = now(),
             status = case when status = 'new' then 'open'::helpdesk.ticket_status else status end,
             first_response_breached =
               (v_ticket.first_response_due is not null and now() > v_ticket.first_response_due)
       where id = new.ticket_id;
    end if;
  end if;

  return null;
end;
$$;

drop trigger if exists trg_hd_message_effects on helpdesk.messages;
create trigger trg_hd_message_effects after insert on helpdesk.messages
  for each row execute function helpdesk.fn_message_effects();

-- -----------------------------------------------------------------------------
-- Bilet akışı
-- -----------------------------------------------------------------------------
create or replace function helpdesk.wait_for_customer(p_id uuid, p_note text default null)
returns helpdesk.tickets
language plpgsql
security invoker
as $$
declare v_t helpdesk.tickets;
begin
  select * into v_t from helpdesk.tickets where id = p_id for update;
  if not found then raise exception 'Bilet bulunamadı' using errcode = 'P0002'; end if;
  if v_t.status not in ('new', 'open') then
    raise exception 'Bu bilet beklemeye alınamaz (mevcut: %)', v_t.status using errcode = '23514';
  end if;

  update helpdesk.tickets
     set status = 'pending_customer', paused_at = now()
   where id = p_id returning * into v_t;

  if p_note is not null then
    insert into helpdesk.messages (ticket_id, author_id, body, is_internal)
    values (p_id, core.current_user_id(), p_note, true);
  end if;

  return v_t;
end;
$$;

create or replace function helpdesk.resolve_ticket(p_id uuid, p_resolution text default null)
returns helpdesk.tickets
language plpgsql
security invoker
as $$
declare
  v_t        helpdesk.tickets;
  v_elapsed  integer;
begin
  if not core.has_perm('helpdesk.ticket.resolve') then
    raise exception 'Bilet çözme yetkiniz yok' using errcode = '42501';
  end if;

  select * into v_t from helpdesk.tickets where id = p_id for update;
  if not found then raise exception 'Bilet bulunamadı' using errcode = 'P0002'; end if;
  if v_t.status in ('resolved', 'closed') then return v_t; end if;

  -- Müşteriye hiç dönülmeden bilet çözülemez: "çözdüm ama söylemedim"
  -- destek masasının en sık şikâyet konusudur.
  if v_t.first_response_at is null then
    raise exception 'Müşteriye henüz yanıt verilmedi — önce dönüş yapın'
      using errcode = '23514';
  end if;

  -- Bekleme süresi hedeften düşülür (karar 2)
  v_elapsed := floor(extract(epoch from (now() - v_t.created_at)) / 60)::integer
               - v_t.paused_minutes;

  update helpdesk.tickets
     set status = 'resolved',
         resolved_at = now(),
         resolution = coalesce(p_resolution, resolution),
         paused_at = null,
         resolution_breached =
           (v_t.resolution_target_minutes is not null
            and v_elapsed > v_t.resolution_target_minutes)
   where id = p_id returning * into v_t;

  perform core.emit_event('helpdesk.ticket.resolved', jsonb_build_object(
    'ticket_id', v_t.id, 'number', v_t.number, 'partner_id', v_t.partner_id,
    'elapsed_minutes', v_elapsed, 'target_minutes', v_t.resolution_target_minutes,
    'breached', v_t.resolution_breached
  ), v_t.branch_id, null, v_t.tenant_id);

  return v_t;
end;
$$;

create or replace function helpdesk.close_ticket(
  p_id uuid, p_satisfaction smallint default null, p_note text default null
)
returns helpdesk.tickets
language plpgsql
security invoker
as $$
declare v_t helpdesk.tickets;
begin
  select * into v_t from helpdesk.tickets where id = p_id for update;
  if not found then raise exception 'Bilet bulunamadı' using errcode = 'P0002'; end if;
  if v_t.status <> 'resolved' then
    raise exception 'Yalnızca çözülmüş bilet kapatılabilir (mevcut: %)', v_t.status
      using errcode = '23514';
  end if;

  update helpdesk.tickets
     set status = 'closed', closed_at = now(),
         satisfaction = coalesce(p_satisfaction, satisfaction),
         satisfaction_note = coalesce(p_note, satisfaction_note)
   where id = p_id returning * into v_t;

  return v_t;
end;
$$;

-- Kapanmış bilet değiştirilemez: destek geçmişi bir kayıttır.
create or replace function helpdesk.fn_lock_closed_ticket()
returns trigger
language plpgsql
as $$
begin
  if old.status = 'closed' and new.status = 'closed'
     and (new.subject, new.resolution, new.priority, new.partner_id)
         is distinct from (old.subject, old.resolution, old.priority, old.partner_id) then
    raise exception 'Kapanmış bilet değiştirilemez (%) — gerekirse yeni bilet açın', old.number
      using errcode = '23514';
  end if;
  return new;
end;
$$;

drop trigger if exists trg_hd_ticket_lock on helpdesk.tickets;
create trigger trg_hd_ticket_lock before update on helpdesk.tickets
  for each row execute function helpdesk.fn_lock_closed_ticket();

-- -----------------------------------------------------------------------------
-- SLA ihlal taraması (pg_cron ile dakikada bir)
-- -----------------------------------------------------------------------------
-- İhlali BİLET ÇÖZÜLÜRKEN değil, VADESİ GEÇTİĞİNDE işaretler. Sadece çözümde
-- bakmak, hiç çözülmeyen biletlerin raporda hiç görünmemesi demekti — oysa en
-- kötü ihlal tam olarak odur.
create or replace function helpdesk.check_sla_breaches()
returns integer
language plpgsql
security definer
set search_path = helpdesk, core, pg_temp
as $$
declare
  r   record;
  v_n integer := 0;
begin
  for r in
    select t.id, t.tenant_id, t.branch_id, t.number, t.subject, t.partner_id,
           t.assignee_id, t.resolution_due, t.first_response_due,
           (t.first_response_at is null and t.first_response_due < now()
            and not t.first_response_breached) as fr_breach,
           (t.resolution_due < now() and not t.resolution_breached)     as res_breach
    from helpdesk.tickets t
    where t.status in ('new', 'open')
      and ((t.first_response_at is null and t.first_response_due < now()
            and not t.first_response_breached)
        or (t.resolution_due < now() and not t.resolution_breached))
  loop
    update helpdesk.tickets
       set first_response_breached = first_response_breached or r.fr_breach,
           resolution_breached = resolution_breached or r.res_breach
     where id = r.id;

    perform core.emit_event('helpdesk.ticket.sla_breached', jsonb_build_object(
      'ticket_id', r.id, 'number', r.number, 'subject', r.subject,
      'partner_id', r.partner_id, 'assignee_id', r.assignee_id,
      'first_response_breached', r.fr_breach, 'resolution_breached', r.res_breach
    ), r.branch_id, null, r.tenant_id);

    v_n := v_n + 1;
  end loop;

  return v_n;
end;
$$;

select core.declare_event('helpdesk.ticket.created', 'helpdesk', 'Destek bileti açıldı');
select core.declare_event('helpdesk.ticket.resolved', 'helpdesk', 'Destek bileti çözüldü');
select core.declare_event('helpdesk.ticket.sla_breached', 'helpdesk',
       'SLA hedefi aşıldı — bilet gecikmede');
