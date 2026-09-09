-- =============================================================================
-- Cari sicil alanlari testleri (T-028 adim 1)
-- =============================================================================
-- Iddialar:
--   1. core.partners'a mersis_no / tax_office_code / tax_liability_type
--      NULLABLE olarak eklendi; mevcut kayitlar ve normal cari acma etkilenmedi.
--   2. CHECK kisitlari yalnizca DOLU degeri sinar (NULL her zaman gecer),
--      gecersiz format reddedilir.
--   3. v_partner_list yeni kolonlari tasir; registerResource okuma/yazma yolu
--      (RLS altinda, kiraci kullanicisi) bu alanlari doldurabilir.
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
  perform set_config('app.user_id', coalesce(p_user::text, ''), false);
  perform set_config('app.tenant_id', coalesce(p_tenant::text, ''), false);
  perform set_config('app.support_mode', 'off', false);
  perform set_config('app.accountant_mode', 'off', false);
end $$;

select id as ornek from core.tenants where slug = 'ornek-ticaret' \gset

\echo ''
\echo '=== 1. KOLONLAR VAR VE NULLABLE ==='
select public.t_assert(
  (select count(*) from information_schema.columns
   where table_schema = 'core' and table_name = 'partners'
     and column_name in ('mersis_no', 'tax_office_code', 'tax_liability_type')
     and is_nullable = 'YES') = 3,
  'Uc yeni kolon eklendi ve hepsi NULLABLE');

\echo ''
\echo '=== 2. MEVCUT CARILER ETKILENMEDI ==='
reset role;
select public.t_assert(
  (select count(*) from core.partners) > 0,
  'Seed carileri hala yerinde');
select public.t_assert(
  (select bool_and(mersis_no is null and tax_office_code is null and tax_liability_type is null)
   from core.partners),
  'Eski kayitlarda yeni alanlar NULL');

\echo ''
\echo '=== 3. FORMAT KISITLARI ==='
set role sezra_app;
select public.t_login('22222222-2222-2222-2222-222222222222', :'ornek');

-- Gecerli 16 haneli MERSIS + gecerli VD kodu.
select public.t_assert(
  public.t_raises($q$
    insert into core.partners (name, is_customer, mersis_no, tax_office_code, tax_liability_type)
    values ('Sicilli Firma A', true, '0000012345678901', '034261', 'tuzel')
  $q$) = 'NO_ERROR',
  'Gecerli MERSIS(16) + VD kodu kabul edilir');

-- 15 hane MERSIS -> reddedilir.
select public.t_assert(
  public.t_raises($q$
    insert into core.partners (name, is_customer, mersis_no)
    values ('Sicilli Firma B', true, '000001234567890')
  $q$) = '23514',
  '15 haneli MERSIS reddedilir (23514)');

-- Harf iceren MERSIS -> reddedilir.
select public.t_assert(
  public.t_raises($q$
    insert into core.partners (name, is_customer, mersis_no)
    values ('Sicilli Firma C', true, '000001234567890X')
  $q$) = '23514',
  'Harf iceren MERSIS reddedilir (23514)');

-- NULL -> her zaman gecer (mukellefiyet turu de dahil).
select public.t_assert(
  public.t_raises($q$
    insert into core.partners (name, is_customer, mersis_no, tax_office_code, tax_liability_type)
    values ('Sadece Unvan', true, null, null, null)
  $q$) = 'NO_ERROR',
  'NULL sicil alanlariyla cari acilir');

-- 60 karakteri asan mukellefiyet turu -> reddedilir.
select public.t_assert(
  public.t_raises(format($q$
    insert into core.partners (name, is_customer, tax_liability_type) values ('Uzun', true, %L)
  $q$, repeat('x', 61))) = '23514',
  'Cok uzun mukellefiyet turu reddedilir (23514)');

\echo ''
\echo '=== 4. v_partner_list YENI KOLONLARI TASIR ==='
select public.t_assert(
  (select count(*) from information_schema.columns
   where table_schema = 'core' and table_name = 'v_partner_list'
     and column_name in ('mersis_no', 'tax_office_code', 'tax_liability_type')) = 3,
  'v_partner_list mersis_no / tax_office_code / tax_liability_type kolonlarini gosterir');

select public.t_assert(
  (select mersis_no from core.v_partner_list where name = 'Sicilli Firma A') = '0000012345678901',
  'Yeni alan v_partner_list uzerinden okunabiliyor');

\echo ''
\echo '=== 5. GUNCELLEME (RLS altinda) ==='
select public.t_login('22222222-2222-2222-2222-222222222222', :'ornek');
update core.partners set tax_office_code = '099999', tax_liability_type = 'gercek'
  where name = 'Sadece Unvan';
select public.t_assert(
  (select tax_office_code from core.partners where name = 'Sadece Unvan') = '099999',
  'Kiraci kullanicisi sicil alanini sonradan elle guncelleyebilir');

\echo ''
\echo 'CARI SICIL ALANLARI TESTLERI GECTI'
