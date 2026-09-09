-- =============================================================================
-- Mali musavir erisimi testleri (T-024)
-- =============================================================================
-- En kritik iki iddia:
--   1. SALT OKUNURLUK RLS SEVIYESINDE: musavir oturumu (app.accountant_mode=on)
--      kiracinin faturalarini/hesaplarini OKUR ama bir satiri YAZAMAZ —
--      insert 42501 ile reddedilir, update/delete 0 satir etkiler. Bu, RLS
--      politika ureticisinin musavir terimini yalnizca for-select'e koymasinin
--      dogrudan sonucudur.
--   2. TENANT BASINA EN FAZLA 1: kiracida canli bir musavir varken ikinci
--      davet 23505 (kismi essiz indeks) ile reddedilir.
--
-- Ayrica: davet kabul edilene kadar erisim yok; iptalden sonra erisim biter;
-- musavir kendi kiracisini gormeye devam eder ama davet edilen kiracinin
-- YALNIZCA o kiracisini gorur (cross-tenant sizinti yok).
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

create or replace function public.t_rowcount(p_sql text)
returns integer language plpgsql as $$
declare n integer;
begin execute p_sql; get diagnostics n = row_count; return n; end $$;

create or replace function public.t_sess(p_user uuid, p_tenant uuid default null, p_acct boolean default false)
returns void language plpgsql as $$
begin
  perform set_config('app.user_id', p_user::text, false);
  perform set_config('app.tenant_id', coalesce(p_tenant::text, ''), false);
  perform set_config('app.support_mode', 'off', false);
  perform set_config('app.accountant_mode', case when p_acct then 'on' else 'off' end, false);
end $$;

select id as ornek from core.tenants where slug = 'ornek-ticaret' \gset
select id as rakip from core.tenants where slug = 'rakip-ticaret' \gset

-- admin@ornek.test        => 22222222 (ornek-ticaret yoneticisi)
-- admin@rakipticaret.test => 55555555 (yalnizca rakip-ticaret uyesi) — MUSAVIR

\echo ''
\echo '=== 1. DAVET: kiraci yoneticisi musaviri e-postayla cagirir ==='
set role sezra_app;
select public.t_sess('22222222-2222-2222-2222-222222222222', :'ornek');

select (core.invite_accountant('admin@rakipticaret.test', 'Mali Musavir')).invite_token as tok \gset

select public.t_assert(:'tok' is not null and length(:'tok') > 20,
  'invite_accountant bir davet belirteci dondurur');

reset role;
select public.t_assert(
  (select count(*) = 1 from core.accountant_grants
    where tenant_id = :'ornek' and revoked_at is null and accepted_at is null),
  'Kiracida bekleyen tek bir musavir kaydi var');

\echo ''
\echo '=== 2. TENANT BASINA EN FAZLA 1 (veritabani kisiti) ==='
set role sezra_app;
select public.t_sess('22222222-2222-2222-2222-222222222222', :'ornek');
select public.t_assert(
  public.t_raises('select core.invite_accountant(''baska@buro.test'')') = '23505',
  'Ikinci musavir daveti 23505 ile reddedilir (ux_accountant_grants_one_per_tenant)');

\echo ''
\echo '=== 3. KABUL EDILMEDEN ERISIM YOK ==='
select public.t_sess('55555555-5555-5555-5555-555555555555', :'ornek', true);
select public.t_assert(
  core.accountant_tenant_id() is null,
  'Kabul oncesi accountant_tenant_id NULL');
select public.t_assert(
  (select count(*) from finance.accounts where tenant_id = :'ornek') = 0,
  'Kabul oncesi musavir ornek-ticaret hesaplarini goremez');

\echo ''
\echo '=== 4. KABUL: yalnizca davetli, e-posta eslesmeli ==='
select public.t_assert(
  (core.accept_accountant_invite(:'tok')).accepted_at is not null,
  'accept_accountant_invite daveti kabul eder');
select public.t_assert(
  public.t_raises(format('select core.accept_accountant_invite(%L)', :'tok')) = 'P0002',
  'Ayni belirtecle ikinci kabul denemesi P0002');

\echo ''
\echo '=== 5. KABULDEN SONRA: SALT OKUMA ==='
select public.t_sess('55555555-5555-5555-5555-555555555555', :'ornek', true);
select public.t_assert(
  core.accountant_tenant_id() = :'ornek',
  'accountant_tenant_id kabul edilen kiraciyi doner');
select public.t_assert(
  (select count(*) from finance.accounts where tenant_id = :'ornek') = 63,
  'Musavir ornek-ticaret hesap planini OKUYABILIR (63 satir)',
  (select count(*)::text from finance.accounts where tenant_id = :'ornek'));
select public.t_assert(
  (select count(distinct tenant_id) from finance.accounts) = 1
  and (select distinct tenant_id from finance.accounts) = :'ornek',
  'Musavir YALNIZCA davet edilen kiracinin verisini gorur (rakip sizmaz)');

\echo ''
\echo '=== 6. SALT OKUNURLUK RLS SEVIYESINDE — YAZMA REDDEDILIR ==='
select public.t_assert(
  public.t_raises(format(
    'insert into finance.accounts (tenant_id, code, name, type) values (%L, ''999.HACK'', ''sahte'', ''asset'')',
    :'ornek')) = '42501',
  'INSERT RLS WITH CHECK ile reddedilir (42501)');

select public.t_assert(
  public.t_rowcount(format(
    'update finance.accounts set name = ''DEGISTIRILDI'' where tenant_id = %L', :'ornek')) = 0,
  'UPDATE 0 satir etkiler (RLS USING musavir satirlarini gizler)');

select public.t_assert(
  public.t_rowcount(format(
    'delete from finance.accounts where tenant_id = %L', :'ornek')) = 0,
  'DELETE 0 satir etkiler');

reset role;
select public.t_assert(
  (select count(*) from finance.accounts where tenant_id = :'ornek') = 63
  and not exists (select 1 from finance.accounts where name = 'DEGISTIRILDI'),
  'Yazma denemelerinden sonra ornek-ticaret hesap plani el degmemis (63 satir)');

\echo ''
\echo '=== 7. MOD KAPALIYKEN ERISIM YOK; KENDI KIRACISI ETKILENMEZ ==='
set role sezra_app;
select public.t_sess('55555555-5555-5555-5555-555555555555', :'ornek', false);
select public.t_assert(
  (select count(*) from finance.accounts) = 0,
  'accountant_mode kapaliyken musavir ornek-ticaret verisini goremez');

select public.t_sess('55555555-5555-5555-5555-555555555555');
select public.t_assert(
  core.current_tenant_id() = :'rakip',
  'Musavir kendi kiracisinda (rakip-ticaret) hala normal uye');
select public.t_assert(
  (select count(*) from finance.accounts where tenant_id = :'rakip') = 63,
  'Musavir kendi kiracisinin verisini normal sekilde gorur');

\echo ''
\echo '=== 8. PANEL YUZEYI ==='
select public.t_sess('55555555-5555-5555-5555-555555555555');
select public.t_assert(
  (select count(*) from core.accountant_tenants() where tenant_id = :'ornek') = 1,
  'accountant_tenants() musavirin erisimli kiracilarini listeler');

\echo ''
\echo '=== 9. IPTAL: erisim biter ==='
select public.t_sess('22222222-2222-2222-2222-222222222222', :'ornek');
select id as gid from core.accountant_grants where tenant_id = :'ornek' and revoked_at is null \gset
select core.revoke_accountant(:'gid');

select public.t_sess('55555555-5555-5555-5555-555555555555', :'ornek', true);
select public.t_assert(
  core.accountant_tenant_id() is null,
  'Iptalden sonra accountant_tenant_id NULL');
select public.t_assert(
  (select count(*) from finance.accounts where tenant_id = :'ornek') = 0,
  'Iptalden sonra musavir hesaplari goremez');

select public.t_sess('22222222-2222-2222-2222-222222222222', :'ornek');
select public.t_assert(
  public.t_raises('select core.invite_accountant(''yeni@buro.test'')') = 'NO_ERROR',
  'Iptalden sonra yeni bir musavir davet edilebilir (kismi indeks serbest)');

reset role;
\echo ''
\echo 'MUSAVIR ERISIMI TESTLERI GECTI'
