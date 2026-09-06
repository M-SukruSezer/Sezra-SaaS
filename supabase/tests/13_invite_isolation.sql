-- =============================================================================
-- Davet izolasyonu testleri (T-010)
-- =============================================================================
-- En kritik iddia: bir kiraci yoneticisi, BASKA bir kiracida hesabi olan birini
-- kendi kiracisina SESSIZCE aktif uye yapamaz. `core.invite_user` boyle bir
-- kullanici icin uyeligi BEKLEMEDE (is_active = false, accepted_at = null)
-- olusturur; yalnizca davetlinin kendisi `core.accept_invite` ile etkinlestirir.
--
-- Ikinci iddia: `p_branch_ids` cagiran kiraciya ait olmali; baska kiracinin
-- sube id'si orphan `core.membership_branches` satiri yaratmamali.
-- =============================================================================
\set ON_ERROR_STOP on
set client_min_messages = notice;

create or replace function public.t_assert(p_ok boolean, p_label text, p_detail text default null)
returns void language plpgsql as $$
begin
  if p_ok then raise notice 'PASS  %', p_label;
  else raise exception 'FAIL  % %', p_label, coalesce('(' || p_detail || ')', ''); end if;
end $$;

create or replace function public.t_raises(p_sql text)
returns text language plpgsql as $$
begin execute p_sql; return 'NO_ERROR';
exception when others then return sqlstate; end $$;

create or replace function public.t_login(p_user uuid, p_tenant uuid default null)
returns void language plpgsql as $$
begin
  perform set_config('app.user_id', p_user::text, false);
  perform set_config('app.tenant_id', coalesce(p_tenant::text, ''), false);
  perform set_config('app.support_mode', 'off', false);
end $$;

-- id'leri OWNER iken yakala.
select id as ornek from core.tenants where slug = 'ornek-ticaret' \gset
select id as rakip from core.tenants where slug = 'rakip-ticaret' \gset
select id as rakip_sube from core.branches
  where tenant_id = (select id from core.tenants where slug = 'rakip-ticaret') limit 1 \gset

-- admin@rakipticaret.test => 55555555 (yalnizca rakip-ticaret uyesi)
-- admin@ornek.test        => 22222222 (ornek-ticaret yoneticisi)

\echo ''
\echo '=== 1. CROSS-TENANT DAVET SESSIZCE AKTIF UYE YAPMAZ ==='
set role sezra_app;
select public.t_login('22222222-2222-2222-2222-222222222222', :'ornek');

select public.t_assert(
  core.invite_user('admin@rakipticaret.test', 'Rakip Yonetici', 'sales') =
    '55555555-5555-5555-5555-555555555555',
  'Var olan kullanici e-postayla eslesir');

reset role;
select public.t_assert(
  (select not is_active from core.memberships
    where user_id = '55555555-5555-5555-5555-555555555555' and tenant_id = :'ornek'),
  'Cross-tenant davet uyeligi BEKLEMEDE olusturur (is_active = false)');
select public.t_assert(
  (select accepted_at is null from core.memberships
    where user_id = '55555555-5555-5555-5555-555555555555' and tenant_id = :'ornek'),
  'Beklemedeki uyeligin accepted_at degeri NULL');

\echo ''
\echo '=== 2. KURBAN BEKLEYEN KIRACIYI GOREMEZ ==='
set role sezra_app;

-- Istemci app.tenant_id ile ornek-ticaret'i zorlasa bile gecemez.
select public.t_login('55555555-5555-5555-5555-555555555555', :'ornek');
select public.t_assert(
  core.current_tenant_id() is null,
  'Beklemedeki kiraci zorlansa bile current_tenant_id NULL doner');
select public.t_assert(
  coalesce(array_length(core.permission_codes(), 1), 0) = 0,
  'Beklemedeki kiracida hicbir izin kodu donmez');

-- app.tenant_id bos: kullanici hala yalnizca kendi kiracisindadir.
select public.t_login('55555555-5555-5555-5555-555555555555');
select public.t_assert(
  core.current_tenant_id() = :'rakip',
  'Aktif kiraci hala rakip-ticaret');
select public.t_assert(
  core.current_tenant_id() is distinct from :'ornek',
  'Aktif kiraci ornek-ticaret DEGIL');

reset role;
select public.t_assert(
  (select count(*) from core.memberships
    where user_id = '55555555-5555-5555-5555-555555555555' and is_active) = 1,
  'Kullanicinin tek aktif uyeligi var (rakip-ticaret)');

\echo ''
\echo '=== 3. SUBE ID CAGIRAN KIRACIYA AIT OLMALI ==='
set role sezra_app;
select public.t_login('22222222-2222-2222-2222-222222222222', :'ornek');
select public.t_assert(
  public.t_raises(format(
    'select core.invite_user(%L, %L, %L, array[%L]::uuid[])',
    'yeni.calisan@ornek.test', 'Yeni Calisan', 'sales', :'rakip_sube')) = '42501',
  'Baska kiracinin sube id''si reddedilir (42501)');

reset role;
select public.t_assert(
  (select count(*)
     from core.membership_branches mb
     join core.memberships m  on m.id = mb.membership_id
     join core.branches b     on b.id = mb.branch_id
    where b.tenant_id <> m.tenant_id) = 0,
  'Kiraci disi (orphan) membership_branches satiri yok');
select public.t_assert(
  not exists (select 1 from core.users where lower(email) = 'yeni.calisan@ornek.test'),
  'Reddedilen davet kullanici satirini da geri alir (atomik)');

\echo ''
\echo '=== 4. DAVETLI KENDI DAVETINI KABUL EDINCE ETKINLESIR ==='
set role sezra_app;
select public.t_login('55555555-5555-5555-5555-555555555555');
select public.t_assert(
  core.accept_invite(:'ornek') is not null,
  'accept_invite bekleyen daveti kabul eder');

reset role;
select public.t_assert(
  (select is_active and accepted_at is not null from core.memberships
    where user_id = '55555555-5555-5555-5555-555555555555' and tenant_id = :'ornek'),
  'Kabulden sonra uyelik aktif ve accepted_at dolu');

set role sezra_app;
select public.t_login('55555555-5555-5555-5555-555555555555', :'ornek');
select public.t_assert(
  core.current_tenant_id() = :'ornek',
  'Kabulden sonra kullanici ornek-ticaret''e gecebilir');

\echo ''
\echo '=== 5. BASKASI ADINA KABUL EDILEMEZ ==='
set role sezra_app;
select public.t_login('22222222-2222-2222-2222-222222222222', :'ornek');
select public.t_assert(
  public.t_raises(format('select core.accept_invite(%L)', :'rakip')) = 'P0002',
  'Bekleyen daveti olmayan kullanici kabul edemez (P0002)');

reset role;
\echo ''
\echo 'DAVET IZOLASYONU TESTLERI GECTI'
