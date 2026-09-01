-- =============================================================================
-- RLS izolasyon testleri (Bölüm 10, madde 4c)
-- Owner rolüyle başlatılır, her senaryoda `set role sezra_app` ile RLS'e TABİ
-- role düşülür. sezra_app tabloların sahibi değildir ve BYPASSRLS taşımaz —
-- yani bu testler üretimdeki API rolünün gördüğünü aynen görür.
-- =============================================================================
\set ON_ERROR_STOP on
set client_min_messages = notice;

create or replace function public.t_assert(p_ok boolean, p_label text, p_detail text default null)
returns void language plpgsql as $$
begin
  if p_ok then
    raise notice 'PASS  %', p_label;
  else
    raise exception 'FAIL  % %', p_label, coalesce('(' || p_detail || ')', '');
  end if;
end $$;

-- Kısayol: belirli bir kullanıcı gibi davran
create or replace function public.t_login(p_user uuid, p_tenant uuid default null)
returns void language plpgsql as $$
begin
  perform set_config('app.user_id', p_user::text, false);
  perform set_config('app.tenant_id', coalesce(p_tenant::text, ''), false);
  perform set_config('app.support_mode', 'off', false);
end $$;

-- Kiracı id'lerini OWNER iken yakala: aşağıda sezra_app rolündeyken bu id'leri
-- sorgulayamayız (RLS zaten gizler), oysa "başka kiracının id'sini bilse bile
-- geçemez" senaryosunu sınamak için gerçek id lazım.
select id as colombia_id from core.tenants where slug = 'colombia-coffee' \gset
select id as rakip_id    from core.tenants where slug = 'rakip-kafe' \gset

\echo ''
\echo '=== 1. KİRACI İZOLASYONU ==='
set role sezra_app;
select public.t_login('55555555-5555-5555-5555-555555555555');   -- Rakip Kafe yöneticisi

select public.t_assert(
  (select count(*) from crm.leads) = 0,
  'Rakip Kafe yöneticisi Colombia fırsatlarını GÖREMEZ',
  (select count(*)::text from crm.leads));

select public.t_assert(
  (select count(*) from core.partners) = 0,
  'Rakip Kafe yöneticisi Colombia carilerini GÖREMEZ',
  (select count(*)::text from core.partners));

select public.t_assert(
  (select count(*) from core.tenants) = 1,
  'Kullanıcı yalnızca kendi kiracısını görür');

-- Başka kiracının id'sini GUC'a zorlamak işe yaramaz: current_tenant_id()
-- id'yi üyelik tablosuna karşı doğrular, doğrulayamazsa NULL döner.
select public.t_login('55555555-5555-5555-5555-555555555555', :'colombia_id'::uuid);
select public.t_assert(
  core.current_tenant_id() is null,
  'app.tenant_id ile başka kiracıya geçilemez (üyelik doğrulanır)',
  coalesce(core.current_tenant_id()::text, 'null'));

select public.t_assert(
  (select count(*) from crm.leads) = 0,
  'Kiracı zorlaması sonrası hiçbir satır görünmez (fail-closed)');

\echo ''
\echo '=== 2. ŞUBE İZOLASYONU ==='
select public.t_login('44444444-4444-4444-4444-444444444444');   -- Deniz, Zonguldak müdürü

select public.t_assert(
  (select count(*) from crm.leads) = 2,
  'Zonguldak müdürü yalnızca Zonguldak fırsatlarını görür',
  (select count(*)::text from crm.leads));

select public.t_assert(
  (select count(*) from core.branches) = 1,
  'Zonguldak müdürü Düzce şubesini göremez');

select public.t_assert(
  not exists (select 1 from crm.leads where name = 'Kampüs toplu kahve tedariki'),
  'Düzce fırsatı Zonguldak müdürüne görünmez');

\echo ''
\echo '=== 3. KAYIT KURALI (own vs all) ==='
select public.t_login('33333333-3333-3333-3333-333333333333');   -- Ali, satış temsilcisi

select public.t_assert(
  (select count(*) from crm.leads) = 3,
  'Satış temsilcisi yalnızca KENDİ fırsatlarını görür',
  (select count(*)::text from crm.leads));

select public.t_assert(
  (select bool_and(owner_id = '33333333-3333-3333-3333-333333333333') from crm.leads),
  'Görünen tüm fırsatların sahibi kullanıcının kendisi');

select public.t_assert(
  not core.has_perm('crm.lead.read.all') and core.has_perm('crm.lead.read.own'),
  'Satış rolünde read.all yok, read.own var');

select public.t_assert(
  not core.has_perm('crm.order.confirm'),
  'Satış temsilcisinde sipariş onaylama yetkisi yok');

\echo ''
\echo '=== 4. TENANT ADMIN TAM ERİŞİM ==='
select public.t_login('22222222-2222-2222-2222-222222222222');   -- Merve

select public.t_assert(
  (select count(*) from crm.leads) = 5,
  'Şirket yöneticisi tüm şubelerin fırsatlarını görür',
  (select count(*)::text from crm.leads));

select public.t_assert(
  (select count(*) from core.branches) = 2,
  'Şirket yöneticisi iki şubeyi de görür');

select public.t_assert(
  (select count(*) from core.partners) = 5,
  'Şirket yöneticisi tüm carileri görür',
  (select count(*)::text from core.partners));

\echo ''
\echo '=== 5. YAZMA KISITI ==='
select public.t_login('33333333-3333-3333-3333-333333333333');   -- Ali
do $$
declare v_other uuid;
begin
  select id into v_other from crm.leads limit 1;   -- Ali sadece kendi kayıtlarını görebiliyor
  -- Başkasının fırsatını güncellemeye çalış: RLS onu hiç göremediği için 0 satır etkilenir
  update crm.leads set notes = 'sızıntı denemesi'
   where owner_id = '44444444-4444-4444-4444-444444444444';
  if found then
    raise exception 'FAIL  Satış temsilcisi başkasının fırsatını güncelleyebildi';
  end if;
  raise notice 'PASS  Satış temsilcisi başkasının fırsatını güncelleyemez';
end $$;

-- Kiracı sınırını aşan INSERT denemesi
do $$
declare v_rakip uuid;
begin
  begin
    insert into crm.leads (tenant_id, pipeline_id, stage_id, name)
    values ('00000000-0000-0000-0000-0000000000ff',
            (select id from crm.pipelines limit 1),
            (select id from crm.stages limit 1), 'sahte');
    raise exception 'FAIL  Başka tenant_id ile kayıt eklenebildi';
  exception
    when insufficient_privilege or foreign_key_violation or check_violation then
      raise notice 'PASS  Başka tenant_id ile kayıt eklenemez';
    when others then
      if sqlstate = '42501' or sqlerrm like '%row-level security%' then
        raise notice 'PASS  Başka tenant_id ile kayıt eklenemez (RLS)';
      else raise; end if;
  end;
end $$;

\echo ''
\echo '=== 6. MODÜL AKTİVASYONU YETKİYİ KAPATIR ==='
reset role;
update core.tenant_modules set enabled = false
 where module_code = 'crm'
   and tenant_id = (select id from core.tenants where slug = 'colombia-coffee');
set role sezra_app;
select public.t_login('22222222-2222-2222-2222-222222222222');

select public.t_assert(
  (select count(*) from crm.leads) = 0,
  'CRM modülü kapatılınca şirket yöneticisi bile fırsat göremez',
  (select count(*)::text from crm.leads));

reset role;
update core.tenant_modules set enabled = true
 where module_code = 'crm'
   and tenant_id = (select id from core.tenants where slug = 'colombia-coffee');
set role sezra_app;
select public.t_login('22222222-2222-2222-2222-222222222222');
select public.t_assert((select count(*) from crm.leads) = 5, 'Modül tekrar açılınca erişim geri gelir');

\echo ''
\echo '=== 7. DESTEK OTURUMU (platform admin) ==='
select public.t_login('11111111-1111-1111-1111-111111111111');   -- Sezra
select public.t_assert(
  (select count(*) from crm.leads) = 0,
  'Platform admini destek modu KAPALIYKEN kiracı verisi göremez',
  (select count(*)::text from crm.leads));

select set_config('app.support_mode', 'on', false);
select public.t_assert(
  (select count(*) from crm.leads) = 5,
  'Destek modu açıkken platform admini tüm kiracıları görür',
  (select count(*)::text from crm.leads));

reset role;
drop function if exists public.t_assert(boolean, text, text);
drop function if exists public.t_login(uuid, uuid);
\echo ''
\echo '=== RLS TESTLERİ TAMAMLANDI ==='
