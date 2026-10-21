-- =============================================================================
-- Olay otobüsü: modül aktifliği ve yeniden deneme sayacı
-- =============================================================================
-- Üç iddia. Hepsi PROB (probe) handler ile ölçülür: handler çağrıldığında
-- public.t_probe'a satır yazar, böylece "çağrıldı mı" doğrudan gözlenir.
--
-- Not: `attempts` üzerinden ölçmek YANILTICIDIR. PL/pgSQL'de
-- `begin ... exception` bloğu örtük savepoint kurar; handler hata verdiğinde
-- blok içindeki `attempts = attempts + 1` GERİ ALINIR. Yani handler çağrılsa
-- da çağrılmasa da attempts aynı kalabilir. İlk yazımda bu testi attempts
-- üzerine kurmuştum ve test yanlış sebeple geçiyordu.
--
--   1. FAN-OUT: kapalı modülün aboneliği hiç kuyruğa girmez. (Zaten doğru.)
--   2. DAĞITIM (TOCTOU): kuyruğa girmiş teslimat, modül SONRADAN kapanırsa
--      işlenmemeli. `core.dispatch_events` seçim sorgusu ne tenant_modules'a
--      ne de is_active'e bakmıyor.
--   3. SAYAÇ: handler sürekli hata verirse `attempts` artmalı ve teslimat
--      `max_attempts`e ulaşınca 'dead' olmalı. Şu an attempts hiç artmıyor,
--      bu yüzden teslimat sonsuza kadar yeniden deneniyor.
-- =============================================================================
\set ON_ERROR_STOP on
set client_min_messages = notice;

create or replace function public.t_assert(p_ok boolean, p_label text, p_detail text default null)
returns void language plpgsql as $$
begin
  if p_ok then raise notice 'PASS  %', p_label;
  else raise exception 'FAIL  % %', p_label, coalesce('(' || p_detail || ')', ''); end if;
end $$;

-- ---------------------------------------------------------------------------
-- Prob altyapısı
-- ---------------------------------------------------------------------------
drop table if exists public.t_probe;
create table public.t_probe (id bigserial primary key, topic text, at timestamptz default now());

create or replace function public.t_probe_handler(p_event jsonb)
returns void language plpgsql as $$
begin insert into public.t_probe (topic) values (p_event->>'topic'); end $$;

create or replace function public.t_fail_handler(p_event jsonb)
returns void language plpgsql as $$
begin raise exception 'kasten hata (test)' using errcode = 'P0001'; end $$;

select id as ornek from core.tenants where slug = 'ornek-ticaret' \gset
reset role;

-- Test olay tipleri ve abonelikleri: ikisi de `finance` modülüne ait.
select core.declare_event('test.probe', 'finance', 'Test probu');
select core.declare_event('test.hep_hata', 'finance', 'Hep hata veren test handler');
select core.subscribe('test.probe', 'finance', 'public.t_probe_handler');
select core.subscribe('test.hep_hata', 'finance', 'public.t_fail_handler', 3::smallint);

select set_config('app.tenant_id', :'ornek', false);
select set_config('app.user_id', '22222222-2222-2222-2222-222222222222', false);

create or replace function public.t_ac(p_tenant uuid, p_modul text, p_acik boolean)
returns void language sql as $$
  insert into core.tenant_modules (tenant_id, module_code, enabled)
  values (p_tenant, p_modul, p_acik)
  on conflict (tenant_id, module_code) do update set enabled = excluded.enabled;
$$;

\echo ''
\echo '=== 0. ÖN KOŞUL ==='

select public.t_assert(
  (select 'finance' = any(depends_on) from core.modules where code = 'purchasing'),
  'core.modules: purchasing, finance bağımlılığını beyan ediyor');

\echo ''
\echo '=== 1. FAN-OUT: kapalı modülün aboneliği kuyruğa girmez ==='

select public.t_ac(:'ornek'::uuid, 'finance', false);
truncate public.t_probe;

select core.emit_event('test.probe', '{}'::jsonb, null, null, :'ornek'::uuid) as e1 \gset

select public.t_assert(
  (select count(*) = 0 from core.event_deliveries where event_id = :'e1'::uuid),
  'finance KAPALI iken teslimat üretilmez');

select public.t_assert(
  (select count(*) = 1 from core.events where id = :'e1'::uuid),
  'Olayın kendisi yine kaydedilir (iz kaybolmaz)');

\echo ''
\echo '=== 2. TOCTOU: kuyruğa girmiş teslimat, modül kapanınca İŞLENMEMELİ ==='

select public.t_ac(:'ornek'::uuid, 'finance', true);
truncate public.t_probe;

select core.emit_event('test.probe', '{}'::jsonb, null, null, :'ornek'::uuid) as e2 \gset

select public.t_assert(
  (select count(*) = 1 from core.event_deliveries where event_id = :'e2'::uuid),
  'finance AÇIK iken teslimat kuyruğa girer');

-- Kiracı bu arada finance'i kapatsın (gerçek hayatta: handler bir kez hata
-- alıp geri çekilmede beklerken yönetici modülü kapatır).
select public.t_ac(:'ornek'::uuid, 'finance', false);
select core.dispatch_events(50) as d2 \gset

select public.t_assert(
  (select count(*) = 0 from public.t_probe),
  'Modül KAPANDIKTAN sonra handler ÇAĞRILMAZ',
  format('prob satırı = %s', (select count(*) from public.t_probe)));

select public.t_assert(
  (select status in ('pending','failed') from core.event_deliveries where event_id = :'e2'::uuid),
  'Teslimat kuyrukta bekler (modül yeniden açılırsa devam eder)',
  (select status::text from core.event_deliveries where event_id = :'e2'::uuid));

\echo ''
\echo '=== 2b. Modül yeniden açılırsa teslimat devam eder ==='

select public.t_ac(:'ornek'::uuid, 'finance', true);
update core.event_deliveries set next_attempt_at = now() - interval '1 second'
 where event_id = :'e2'::uuid;
select core.dispatch_events(50) as d2b \gset

select public.t_assert(
  (select count(*) = 1 from public.t_probe),
  'Modül yeniden açıldığında bekleyen teslimat işlenir');

\echo ''
\echo '=== 3. is_active = false olan abonelik İŞLENMEMELİ ==='

truncate public.t_probe;
select core.emit_event('test.probe', '{}'::jsonb, null, null, :'ornek'::uuid) as e3 \gset
update core.event_subscriptions set is_active = false
 where topic = 'test.probe' and handler_fn = 'public.t_probe_handler';
select core.dispatch_events(50) as d3 \gset

select public.t_assert(
  (select count(*) = 0 from public.t_probe),
  'Pasifleştirilmiş abonelik için handler ÇAĞRILMAZ',
  format('prob satırı = %s', (select count(*) from public.t_probe)));

update core.event_subscriptions set is_active = true
 where topic = 'test.probe' and handler_fn = 'public.t_probe_handler';

\echo ''
\echo '=== 4. YENİDEN DENEME SAYACI: hep hata veren handler ölmeli ==='

select core.emit_event('test.hep_hata', '{}'::jsonb, null, null, :'ornek'::uuid) as e4 \gset

-- max_attempts = 3. Dört tur dene; her turda geri çekilmeyi geçersiz kıl.
select core.dispatch_events(50);
update core.event_deliveries set next_attempt_at = now() - interval '1s' where event_id = :'e4'::uuid;
select core.dispatch_events(50);
update core.event_deliveries set next_attempt_at = now() - interval '1s' where event_id = :'e4'::uuid;
select core.dispatch_events(50);
update core.event_deliveries set next_attempt_at = now() - interval '1s' where event_id = :'e4'::uuid;
select core.dispatch_events(50);

select attempts as son_deneme, status::text as son_durum
  from core.event_deliveries where event_id = :'e4'::uuid \gset

select public.t_assert(
  :'son_deneme'::int >= 3,
  'Başarısız handler''da attempts ARTAR',
  format('attempts = %s (beklenen >= 3)', :'son_deneme'));

select public.t_assert(
  :'son_durum' = 'dead',
  'max_attempts dolduğunda teslimat ''dead'' olur (sonsuz yeniden deneme yok)',
  format('durum = %s, attempts = %s', :'son_durum', :'son_deneme'));

select public.t_assert(
  (select last_error like 'P0001%' from core.event_deliveries where event_id = :'e4'::uuid),
  'Hata sebebi teslimatta kayıtlı');

-- ---------------------------------------------------------------------------
-- Temizlik: test abonelikleri ve olayları kalmasın, sonraki testler etkilenmesin.
-- ---------------------------------------------------------------------------
delete from core.events where id in (:'e1'::uuid, :'e2'::uuid, :'e3'::uuid, :'e4'::uuid);
delete from core.event_subscriptions where topic in ('test.probe', 'test.hep_hata');
delete from core.event_types where topic in ('test.probe', 'test.hep_hata');
select public.t_ac(:'ornek'::uuid, 'finance', true);
drop table if exists public.t_probe;
drop function if exists public.t_probe_handler(jsonb);
drop function if exists public.t_fail_handler(jsonb);
drop function if exists public.t_ac(uuid, text, boolean);

\echo ''
\echo '=== OLAY OTOBÜSÜ TESTLERİ TAMAM ==='
