-- =============================================================================
-- 0015 — Platform yönetim konsolu (Sezra tarafı)
-- =============================================================================
-- İKİ AYRI ERİŞİM YÜZEYİ VARDIR, KARIŞTIRILMAMALIDIR:
--
--   1. DESTEK MODU (core.is_support_session) — bir kiracının İŞ VERİSİNE bakmak.
--      Açıkça `set app.support_mode = 'on'` gerektirir, RLS politikalarından
--      geçer ve her okuma/yazma denetim izine `support_session = true` olarak
--      düşer. Müşteri verisine bakmak istisnai bir eylemdir ve iz bırakır.
--
--   2. PLATFORM KONSOLU (bu dosya) — platformu İŞLETMEK için. Kiracı sayısı,
--      abonelik durumu, modül yaygınlığı, kuyruk sağlığı. Burada müşterinin iş
--      verisi YOKTUR: fırsat, fatura, bordro, stok hiçbir fonksiyondan dönmez.
--
-- Bu ayrım olmasaydı, "kaç kiracımız var" sorusunu yanıtlamak için müşteri
-- verisine erişim açmak gerekirdi. Ayrım, en sık yapılan işi en az yetkiyle
-- yapılabilir kılıyor.
--
-- NEDEN VIEW DEĞİL FONKSİYON: proje kuralı gereği her view `security_invoker`
-- ile çalışır, yani RLS'e tabidir ve kiracılar arası okuyamaz. Konsol
-- fonksiyonları `security definer` olup yetkiyi ilk satırda AÇIKÇA kontrol eder.
-- =============================================================================

create or replace function core.platform_guard()
returns void
language plpgsql
stable
security definer
set search_path = core, pg_temp
as $$
begin
  if not core.is_platform_admin() then
    raise exception 'Bu işlem yalnızca platform yöneticisine açıktır'
      using errcode = '42501';
  end if;
end;
$$;

-- -----------------------------------------------------------------------------
-- Genel bakış
-- -----------------------------------------------------------------------------
create or replace function core.platform_overview()
returns table (
  tenant_count        integer,
  active_count        integer,
  trial_count         integer,
  past_due_count      integer,
  suspended_count     integer,
  user_count          integer,
  branch_count        integer,
  mrr                 numeric,
  trials_expiring_7d  integer,
  failed_deliveries   integer
)
language plpgsql
stable
security definer
set search_path = core, pg_temp
as $$
begin
  perform core.platform_guard();
  return query
  select
    (select count(*)::integer from core.tenants where deleted_at is null),
    (select count(*)::integer from core.subscriptions where status = 'active'),
    (select count(*)::integer from core.subscriptions where status = 'trial'),
    (select count(*)::integer from core.subscriptions where status = 'past_due'),
    (select count(*)::integer from core.subscriptions where status = 'suspended'),
    (select count(*)::integer from core.memberships where is_active),
    (select count(*)::integer from core.branches where is_active),
    -- Aylık yinelenen gelir: yalnızca parası akan abonelikler sayılır.
    -- Deneme süresi geliri DEĞİLDİR; saymak MRR'ı şişirir.
    (select coalesce(sum(p.monthly_price), 0)
       from core.subscriptions s
       join core.plans p on p.code = s.plan_code
      where s.status in ('active', 'past_due')),
    (select count(*)::integer from core.subscriptions
      where status = 'trial' and trial_ends_at between now() and now() + interval '7 days'),
    (select count(*)::integer from core.event_deliveries where status in ('failed', 'dead'));
end;
$$;

-- -----------------------------------------------------------------------------
-- Kiracı listesi
-- -----------------------------------------------------------------------------
create or replace function core.platform_tenants(
  p_search text default null,
  p_status text default null,
  p_limit  integer default 50,
  p_offset integer default 0
)
returns table (
  id             uuid,
  slug           text,
  name           text,
  sector         text,
  plan_code      text,
  plan_name      text,
  monthly_price  numeric,
  status         text,
  seats          integer,
  user_count     integer,
  branch_count   integer,
  module_count   integer,
  trial_ends_at  timestamptz,
  created_at     timestamptz,
  last_seen_at   timestamptz,
  total_count    bigint
)
language plpgsql
stable
security definer
set search_path = core, pg_temp
as $$
begin
  perform core.platform_guard();
  return query
  select
    t.id, t.slug, t.name, t.sector,
    s.plan_code, p.name, p.monthly_price,
    s.status::text, s.seats,
    (select count(*)::integer from core.memberships m where m.tenant_id = t.id and m.is_active),
    (select count(*)::integer from core.branches b where b.tenant_id = t.id and b.is_active),
    (select count(*)::integer from core.tenant_modules tm where tm.tenant_id = t.id and tm.enabled),
    s.trial_ends_at, t.created_at,
    -- Canlılık göstergesi: kiracıdaki en son kullanıcı etkinliği.
    -- Terk edilmiş hesapları görmenin en ucuz yolu.
    (select max(u.last_seen_at) from core.memberships m
       join core.users u on u.id = m.user_id
      where m.tenant_id = t.id),
    count(*) over()
  from core.tenants t
  left join core.subscriptions s on s.tenant_id = t.id
       and s.status in ('trial', 'active', 'past_due')
  left join core.plans p on p.code = s.plan_code
  where t.deleted_at is null
    and (p_search is null or p_search = ''
         or t.name ilike '%' || p_search || '%'
         or t.slug ilike '%' || p_search || '%')
    and (p_status is null or p_status = '' or s.status::text = p_status)
  order by t.created_at desc
  limit greatest(p_limit, 1) offset greatest(p_offset, 0);
end;
$$;

-- -----------------------------------------------------------------------------
-- Kiracı detayı: hangi modüller açık, plan neyi kapsıyor
-- -----------------------------------------------------------------------------
create or replace function core.platform_tenant_modules(p_tenant_id uuid)
returns table (
  module_code   text,
  module_name   text,
  phase         smallint,
  is_core       boolean,
  enabled       boolean,
  in_plan       boolean,
  enabled_at    timestamptz
)
language plpgsql
stable
security definer
set search_path = core, pg_temp
as $$
begin
  perform core.platform_guard();
  return query
  select
    m.code, m.name, m.phase, m.is_core,
    coalesce(tm.enabled, false),
    -- Planın kapsadığı ama kapalı olan modül = satış fırsatı.
    -- Plan dışı olup açık olan = faturalanmayan kullanım.
    exists (select 1 from core.plan_modules pm
             join core.subscriptions s on s.plan_code = pm.plan_code
            where pm.module_code = m.code and s.tenant_id = p_tenant_id
              and s.status in ('trial', 'active', 'past_due')),
    tm.enabled_at
  from core.modules m
  left join core.tenant_modules tm on tm.module_code = m.code and tm.tenant_id = p_tenant_id
  order by m.phase, m.code;
end;
$$;

-- -----------------------------------------------------------------------------
-- Modül yaygınlığı
-- -----------------------------------------------------------------------------
create or replace function core.platform_module_adoption()
returns table (
  module_code     text,
  module_name     text,
  phase           smallint,
  enabled_tenants integer,
  total_tenants   integer,
  adoption_pct    numeric
)
language plpgsql
stable
security definer
set search_path = core, pg_temp
as $$
declare v_total integer;
begin
  perform core.platform_guard();
  select count(*)::integer into v_total from core.tenants where deleted_at is null;
  return query
  select
    m.code, m.name, m.phase,
    (select count(*)::integer from core.tenant_modules tm
       join core.tenants t on t.id = tm.tenant_id and t.deleted_at is null
      where tm.module_code = m.code and tm.enabled),
    v_total,
    case when v_total = 0 then 0 else round(
      (select count(*) from core.tenant_modules tm
         join core.tenants t on t.id = tm.tenant_id and t.deleted_at is null
        where tm.module_code = m.code and tm.enabled)::numeric / v_total * 100, 1) end
  from core.modules m
  where not m.is_core
  order by 4 desc, m.phase;
end;
$$;

-- -----------------------------------------------------------------------------
-- Kuyruk sağlığı
-- -----------------------------------------------------------------------------
-- Olay teslimatı bu mimaride modüller arası TEK bağ. Bir handler sessizce
-- düşerse fatura kesilmez, stok girmez, bordro muhasebeleşmez ve kimse fark
-- etmez. Platform konsolunun en operasyonel ekranı budur.
create or replace function core.platform_health()
returns table (
  tenant_id     uuid,
  tenant_name   text,
  topic         text,
  module_code   text,
  status        text,
  delivery_count integer,
  attempts      integer,
  last_error    text,
  last_attempt  timestamptz
)
language plpgsql
stable
security definer
set search_path = core, pg_temp
as $$
begin
  perform core.platform_guard();
  return query
  select
    e.tenant_id, t.name, e.topic, s.module_code, d.status::text,
    count(*)::integer, max(d.attempts), max(d.last_error), max(d.next_attempt_at)
  from core.event_deliveries d
  join core.events e on e.id = d.event_id
  join core.event_subscriptions s on s.id = d.subscription_id
  left join core.tenants t on t.id = e.tenant_id
  where d.status in ('failed', 'dead')
  group by e.tenant_id, t.name, e.topic, s.module_code, d.status
  order by (d.status = 'dead') desc, count(*) desc;
end;
$$;

-- =============================================================================
-- Eylemler — hepsi denetim izine yazılır
-- =============================================================================
-- Platform yöneticisinin bir kiracıya dokunan her eylemi iz bırakır. Kiracı
-- kendi denetim izinde bunu görebilir: "modülümü kim kapattı" sorusunun yanıtı
-- müşteride olmalıdır.
create or replace function core.platform_log(
  p_tenant_id uuid, p_action core.audit_action, p_table text,
  p_entity_id uuid, p_old jsonb, p_new jsonb
)
returns void
language sql
security definer
set search_path = core, pg_temp
as $$
  insert into core.audit_log (tenant_id, actor_id, action, entity_schema, entity_table,
                              entity_id, old_data, new_data, support_session)
  values (p_tenant_id, core.current_user_id(), p_action, 'core', p_table,
          p_entity_id, p_old, p_new, true);
$$;

create or replace function core.platform_set_module(
  p_tenant_id uuid, p_module_code text, p_enabled boolean
)
returns boolean
language plpgsql
security definer
set search_path = core, pg_temp
as $$
declare v_old boolean;
begin
  perform core.platform_guard();

  if not exists (select 1 from core.modules where code = p_module_code) then
    raise exception 'Tanımsız modül: %', p_module_code using errcode = '22023';
  end if;
  if exists (select 1 from core.modules where code = p_module_code and is_core) and not p_enabled then
    raise exception 'Çekirdek modül kapatılamaz: %', p_module_code using errcode = '23514';
  end if;

  select enabled into v_old from core.tenant_modules
   where tenant_id = p_tenant_id and module_code = p_module_code;

  insert into core.tenant_modules (tenant_id, module_code, enabled)
  values (p_tenant_id, p_module_code, p_enabled)
  on conflict (tenant_id, module_code) do update set enabled = excluded.enabled;

  -- Modül İLK KEZ açılıyorsa kurulum kancaları çalışmalı; aksi hâlde kiracı
  -- boş bir modülle karşılaşır (depo yok, hesap planı yok, izin tipi yok).
  if p_enabled and coalesce(v_old, false) = false then
    declare v_prov record;
    begin
      for v_prov in
        select fn_name from core.tenant_provisioners
         where module_code = p_module_code order by sequence
      loop
        execute format('select %s($1)', v_prov.fn_name) using p_tenant_id;
      end loop;
    end;
  end if;

  perform core.platform_log(p_tenant_id, 'update', 'tenant_modules', null,
    jsonb_build_object('module_code', p_module_code, 'enabled', v_old),
    jsonb_build_object('module_code', p_module_code, 'enabled', p_enabled));

  return p_enabled;
end;
$$;

create or replace function core.platform_set_plan(p_tenant_id uuid, p_plan_code text)
returns core.subscriptions
language plpgsql
security definer
set search_path = core, pg_temp
as $$
declare
  v_sub core.subscriptions;
  v_old text;
  r     record;
begin
  perform core.platform_guard();
  if not exists (select 1 from core.plans where code = p_plan_code) then
    raise exception 'Tanımsız plan: %', p_plan_code using errcode = '22023';
  end if;

  select plan_code into v_old from core.subscriptions
   where tenant_id = p_tenant_id and status in ('trial', 'active', 'past_due');

  update core.subscriptions s
     set plan_code = p_plan_code,
         seats = p.included_users,
         branch_quota = p.included_branches
  from core.plans p
  where p.code = p_plan_code
    and s.tenant_id = p_tenant_id
    and s.status in ('trial', 'active', 'past_due')
  returning s.* into v_sub;

  if v_sub.id is null then
    raise exception 'Kiracının etkin aboneliği yok' using errcode = 'P0002';
  end if;

  -- Yeni planın kapsadığı modüller açılır. Plan DIŞINDA kalanlar otomatik
  -- KAPATILMAZ: bir müşterinin kullandığı modülü plan değişikliğiyle sessizce
  -- elinden almak, veri kaybı gibi hissettiren bir sürprizdir. Kapatma ayrı ve
  -- bilinçli bir eylemdir.
  for r in select pm.module_code from core.plan_modules pm where pm.plan_code = p_plan_code
  loop
    perform core.platform_set_module(p_tenant_id, r.module_code, true);
  end loop;

  perform core.platform_log(p_tenant_id, 'update', 'subscriptions', v_sub.id,
    jsonb_build_object('plan_code', v_old), jsonb_build_object('plan_code', p_plan_code));

  return v_sub;
end;
$$;

create or replace function core.platform_set_status(p_tenant_id uuid, p_status text)
returns core.subscriptions
language plpgsql
security definer
set search_path = core, pg_temp
as $$
declare
  v_sub core.subscriptions;
  v_old text;
begin
  perform core.platform_guard();

  select status::text into v_old from core.subscriptions
   where tenant_id = p_tenant_id and status in ('trial', 'active', 'past_due', 'suspended');

  update core.subscriptions
     set status = p_status::core.subscription_status,
         cancelled_at = case when p_status = 'cancelled' then now() else cancelled_at end
   where tenant_id = p_tenant_id
     and status in ('trial', 'active', 'past_due', 'suspended')
   returning * into v_sub;

  if v_sub.id is null then
    raise exception 'Kiracının değiştirilebilir aboneliği yok' using errcode = 'P0002';
  end if;

  perform core.platform_log(p_tenant_id, 'update', 'subscriptions', v_sub.id,
    jsonb_build_object('status', v_old), jsonb_build_object('status', p_status));

  return v_sub;
end;
$$;

-- -----------------------------------------------------------------------------
-- Yetki
-- -----------------------------------------------------------------------------
-- Fonksiyonlar definer olduğu için uygulama rolüne EXECUTE verilir; yetki
-- kontrolü fonksiyonun ilk satırındaki platform_guard'dadır.
select core.apply_grants();
