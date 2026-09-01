-- =============================================================================
-- 0007 — Olay veri yolu (event bus)  — Bölüm 3.5 / Bölüm 10 madde 5
-- =============================================================================
-- Modüller birbirine tablo JOIN'i ile değil, olaylarla bağlanır. Transactional
-- outbox deseni: olay, onu doğuran iş kaydıyla AYNI transaction'da yazılır —
-- "sipariş kaydedildi ama olay kaybedildi" durumu imkânsızdır.
--
-- Akış:
--   crm.sale_order onaylanır
--     -> core.emit_event('sales.order.confirmed', {...})
--        -> core.events'e 1 satır  + her abone için core.event_deliveries satırı
--        -> pg_notify ile Node worker uyandırılır (düşük gecikme)
--        -> pg_cron her dakika core.dispatch_events() ile artıkları toplar (dayanıklılık)
-- =============================================================================

create table if not exists core.event_types (
  topic        text primary key,               -- 'sales.order.confirmed'
  module_code  text not null references core.modules(code) on delete cascade,
  description  text,
  payload_doc  jsonb,                          -- beklenen alanların dokümantasyonu
  created_at   timestamptz not null default now()
);

create table if not exists core.events (
  id             uuid primary key default gen_random_uuid(),
  tenant_id      uuid not null references core.tenants(id) on delete cascade,
  branch_id      uuid references core.branches(id) on delete set null,
  topic          text not null,
  payload        jsonb not null default '{}'::jsonb,
  actor_id       uuid,
  correlation_id uuid,                          -- aynı iş akışındaki olayları bağlar
  causation_id   uuid references core.events(id) on delete set null,
  occurred_at    timestamptz not null default now()
);

create index if not exists ix_events_tenant_topic on core.events (tenant_id, topic, occurred_at desc);
create index if not exists ix_events_correlation on core.events (correlation_id) where correlation_id is not null;

-- Aboneler: bir modül, başka bir modülün olayına kaydolur.
create table if not exists core.event_subscriptions (
  id            uuid primary key default gen_random_uuid(),
  topic         text not null,
  module_code   text not null references core.modules(code) on delete cascade,
  handler_fn    text not null,                  -- 'finance.on_sales_order_confirmed'
  is_active     boolean not null default true,
  max_attempts  smallint not null default 5,
  created_at    timestamptz not null default now()
);

create unique index if not exists ux_event_subscriptions
  on core.event_subscriptions (topic, handler_fn);
create index if not exists ix_event_subscriptions_topic
  on core.event_subscriptions (topic) where is_active;

-- Abone başına teslimat kaydı (outbox satırı)
create table if not exists core.event_deliveries (
  id              uuid primary key default gen_random_uuid(),
  event_id        uuid not null references core.events(id) on delete cascade,
  subscription_id uuid not null references core.event_subscriptions(id) on delete cascade,
  tenant_id       uuid not null,
  status          core.event_status not null default 'pending',
  attempts        smallint not null default 0,
  next_attempt_at timestamptz not null default now(),
  last_error      text,
  processed_at    timestamptz,
  created_at      timestamptz not null default now()
);

create unique index if not exists ux_event_deliveries on core.event_deliveries (event_id, subscription_id);
create index if not exists ix_event_deliveries_queue
  on core.event_deliveries (status, next_attempt_at)
  where status in ('pending', 'failed');

-- -----------------------------------------------------------------------------
-- Olay yayınlama
-- -----------------------------------------------------------------------------
create or replace function core.emit_event(
  p_topic          text,
  p_payload        jsonb default '{}'::jsonb,
  p_branch_id      uuid default null,
  p_correlation_id uuid default null,
  p_tenant_id      uuid default null
)
returns uuid
language plpgsql
security definer
set search_path = core, pg_temp
as $$
declare
  v_tenant   uuid := coalesce(p_tenant_id, core.current_tenant_id());
  v_event_id uuid;
  v_subs     integer;
begin
  if v_tenant is null then
    raise exception 'core.emit_event: kiracı bağlamı yok (topic=%)', p_topic using errcode = '42501';
  end if;

  if not exists (select 1 from core.event_types where topic = p_topic) then
    raise exception 'core.emit_event: tanımsız olay tipi "%". Önce core.event_types''a kaydedin.', p_topic
      using errcode = '22023';
  end if;

  insert into core.events (tenant_id, branch_id, topic, payload, actor_id, correlation_id)
  values (v_tenant, p_branch_id, p_topic, coalesce(p_payload, '{}'::jsonb),
          core.current_user_id(), coalesce(p_correlation_id, gen_random_uuid()))
  returning id into v_event_id;

  -- Fan-out: yalnızca bu kiracıda AÇIK olan modüllerin abonelikleri
  insert into core.event_deliveries (event_id, subscription_id, tenant_id)
  select v_event_id, s.id, v_tenant
  from core.event_subscriptions s
  join core.tenant_modules tm
    on tm.module_code = s.module_code and tm.tenant_id = v_tenant and tm.enabled
  where s.topic = p_topic and s.is_active;

  get diagnostics v_subs = row_count;

  if v_subs > 0 then
    perform pg_notify('core_events', json_build_object(
      'event_id', v_event_id, 'tenant_id', v_tenant, 'topic', p_topic
    )::text);
  end if;

  return v_event_id;
end;
$$;

-- -----------------------------------------------------------------------------
-- Teslimat işleyici (dispatcher)
-- -----------------------------------------------------------------------------
-- Her handler imzası:  fn(p_event jsonb) returns void
-- p_event = { id, tenant_id, branch_id, topic, payload, actor_id, occurred_at }
create or replace function core.dispatch_events(p_limit integer default 100)
returns integer
language plpgsql
security definer
set search_path = core, pg_temp
as $$
declare
  r          record;
  v_event    jsonb;
  v_done     integer := 0;
begin
  for r in
    select d.id as delivery_id, d.attempts, s.handler_fn, s.max_attempts,
           e.id as event_id, e.tenant_id, e.branch_id, e.topic, e.payload,
           e.actor_id, e.occurred_at
    from core.event_deliveries d
    join core.event_subscriptions s on s.id = d.subscription_id
    join core.events e on e.id = d.event_id
    where d.status in ('pending', 'failed')
      and d.next_attempt_at <= now()
    order by d.next_attempt_at
    limit p_limit
    for update of d skip locked
  loop
    v_event := jsonb_build_object(
      'id', r.event_id, 'tenant_id', r.tenant_id, 'branch_id', r.branch_id,
      'topic', r.topic, 'payload', r.payload, 'actor_id', r.actor_id,
      'occurred_at', r.occurred_at
    );

    begin
      update core.event_deliveries
         set status = 'processing', attempts = attempts + 1
       where id = r.delivery_id;

      execute format('select %s($1)', r.handler_fn) using v_event;

      update core.event_deliveries
         set status = 'done', processed_at = now(), last_error = null
       where id = r.delivery_id;
      v_done := v_done + 1;

    exception when others then
      -- Handler hatası tüm partiyi düşürmemeli: üstel geri çekilme ile yeniden dene
      update core.event_deliveries
         set status = case when attempts + 1 >= r.max_attempts then 'dead' else 'failed' end,
             last_error = left(sqlstate || ' ' || sqlerrm, 2000),
             next_attempt_at = now() + (power(3, least(attempts, 5)) || ' seconds')::interval
       where id = r.delivery_id;
    end;
  end loop;

  return v_done;
end;
$$;

comment on function core.dispatch_events(integer) is
  'Bekleyen olay teslimatlarını işler. pg_cron ile dakikada bir, ayrıca LISTEN core_events ile anlık tetiklenir.';

-- Modüllerin abonelik kaydını kolaylaştıran yardımcı
create or replace function core.subscribe(p_topic text, p_module text, p_handler text, p_max_attempts smallint default 5)
returns void
language sql
as $$
  insert into core.event_subscriptions (topic, module_code, handler_fn, max_attempts)
  values (p_topic, p_module, p_handler, p_max_attempts)
  on conflict (topic, handler_fn) do update
    set is_active = true, module_code = excluded.module_code, max_attempts = excluded.max_attempts;
$$;

create or replace function core.declare_event(p_topic text, p_module text, p_description text default null, p_payload_doc jsonb default null)
returns void
language sql
as $$
  insert into core.event_types (topic, module_code, description, payload_doc)
  values (p_topic, p_module, p_description, p_payload_doc)
  on conflict (topic) do update
    set description = excluded.description, payload_doc = excluded.payload_doc;
$$;

-- Olay tabloları: kiracı okuyabilir (denetim/izleme), yazamaz.
alter table core.events enable row level security;
alter table core.events force row level security;
drop policy if exists p_events_select on core.events;
create policy p_events_select on core.events for select
  using ((select core.is_support_session())
         or (tenant_id = (select core.current_tenant_id())
             and (select core.has_perm('core.event.read.all'))));

alter table core.event_deliveries enable row level security;
alter table core.event_deliveries force row level security;
drop policy if exists p_event_deliveries_select on core.event_deliveries;
create policy p_event_deliveries_select on core.event_deliveries for select
  using ((select core.is_support_session())
         or (tenant_id = (select core.current_tenant_id())
             and (select core.has_perm('core.event.read.all'))));
