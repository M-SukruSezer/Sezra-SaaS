-- =============================================================================
-- Uye rol/sube kapsami dogrulamasi testleri (T-016)
-- =============================================================================
-- Iddia: core.set_member_roles, p_branch_ids icinde cagiranin kiracisina AIT
-- OLMAYAN bir sube id'si varsa cagriyi 42501 ile reddeder ve HICBIR sey
-- degistirmez (atomik). Bu, core.invite_user icin T-010'da kapatilan kusurun
-- birebir aynisiydi; iki fonksiyon artik core.assert_branches_in_tenant
-- yardimcisini paylasir.
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
select id as ornek_duzce from core.branches
  where tenant_id = (select id from core.tenants where slug = 'ornek-ticaret')
    and code = 'MERKEZ' \gset
select id as rakip_sube from core.branches
  where tenant_id = (select id from core.tenants where slug = 'rakip-ticaret') limit 1 \gset

-- admin@ornek.test => 22222222 (ornek-ticaret yoneticisi)
-- duzce.satis@ornek.test => 33333333 (ornek-ticaret uyesi, sales, Duzce'ye kilitli)

\echo ''
\echo '=== 1. YARDIMCI: core.assert_branches_in_tenant ==='
set role sezra_app;
select public.t_assert(
  public.t_raises(format('select core.assert_branches_in_tenant(null::uuid[], %L)', :'ornek')) = 'NO_ERROR',
  'NULL dizi ("tum subeler") dogrulanmaz');
select public.t_assert(
  public.t_raises(format('select core.assert_branches_in_tenant(array[]::uuid[], %L)', :'ornek')) = 'NO_ERROR',
  'Bos dizi ("hicbir sube") gecerlidir');
select public.t_assert(
  public.t_raises(format('select core.assert_branches_in_tenant(array[%L]::uuid[], %L)', :'ornek_duzce', :'ornek')) = 'NO_ERROR',
  'Kiraciya ait sube id kabul edilir');
select public.t_assert(
  public.t_raises(format('select core.assert_branches_in_tenant(array[%L]::uuid[], %L)', :'rakip_sube', :'ornek')) = '42501',
  'Kiraci disi sube id 42501 firlatir');

\echo ''
\echo '=== 2. set_member_roles: kiraci disi sube id reddedilir ==='
set role sezra_app;
select public.t_login('22222222-2222-2222-2222-222222222222', :'ornek');

-- Once mevcut durumu OWNER iken yakala.
reset role;
select array_agg(r.code order by r.code) as ali_roller
  from core.memberships m
  join core.membership_roles mr on mr.membership_id = m.id
  join core.roles r on r.id = mr.role_id
 where m.user_id = '33333333-3333-3333-3333-333333333333' and m.tenant_id = :'ornek' \gset
select count(*) as ali_sube_sayisi
  from core.membership_branches mb
  join core.memberships m on m.id = mb.membership_id
 where m.user_id = '33333333-3333-3333-3333-333333333333' and m.tenant_id = :'ornek' \gset

set role sezra_app;
select public.t_login('22222222-2222-2222-2222-222222222222', :'ornek');
select public.t_assert(
  public.t_raises(format(
    'select core.set_member_roles(%L, array[%L], array[%L]::uuid[])',
    '33333333-3333-3333-3333-333333333333', 'accounting', :'rakip_sube')) = '42501',
  'Baska kiracinin sube id''si reddedilir (42501)');

reset role;
select public.t_assert(
  (select array_agg(r.code order by r.code)
     from core.memberships m
     join core.membership_roles mr on mr.membership_id = m.id
     join core.roles r on r.id = mr.role_id
    where m.user_id = '33333333-3333-3333-3333-333333333333' and m.tenant_id = :'ornek')
    = :'ali_roller'::text[],
  'Reddedilen cagri rolleri DEGISTIRMEDI (atomik)');
select public.t_assert(
  (select count(*) from core.membership_branches mb
     join core.memberships m on m.id = mb.membership_id
    where m.user_id = '33333333-3333-3333-3333-333333333333' and m.tenant_id = :'ornek')
    = :'ali_sube_sayisi',
  'Reddedilen cagri sube kapsamini DEGISTIRMEDI');
select public.t_assert(
  (select count(*)
     from core.membership_branches mb
     join core.memberships m on m.id = mb.membership_id
     join core.branches b on b.id = mb.branch_id
    where b.tenant_id <> m.tenant_id) = 0,
  'Kiraci disi (orphan) membership_branches satiri yok');

\echo ''
\echo '=== 3. set_member_roles: kiraciya ait sube id kabul edilir ==='
set role sezra_app;
select public.t_login('22222222-2222-2222-2222-222222222222', :'ornek');
select public.t_assert(
  public.t_raises(format(
    'select core.set_member_roles(%L, array[%L], array[%L]::uuid[])',
    '33333333-3333-3333-3333-333333333333', 'sales', :'ornek_duzce')) = 'NO_ERROR',
  'Gecerli sube id ile cagri basarili');

reset role;
select public.t_assert(
  exists (select 1 from core.membership_branches mb
    join core.memberships m on m.id = mb.membership_id
   where m.user_id = '33333333-3333-3333-3333-333333333333' and m.tenant_id = :'ornek'
     and mb.branch_id = :'ornek_duzce'),
  'Gecerli sube kapsami yazildi');

\echo ''
\echo 'UYE ROL/SUBE KAPSAMI TESTLERI GECTI'
