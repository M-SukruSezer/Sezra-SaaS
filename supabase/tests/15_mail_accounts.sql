-- =============================================================================
-- Bagli mail hesabi testleri (T-025 -- adim 1)
-- =============================================================================
-- Iddialar:
--   1. RLS: bir kullanici YALNIZCA kendi mail hesaplarini gorur. Ayni
--      kiracidaki tenant_admin bile baskasinin satirina/kimlik bilgisine
--      ERISEMEZ. Destek modu da baypas etmez.
--   2. secret_cipher hicbir okuma yolundan donmez: mail_account_list() onu
--      SELECT etmez (yalnizca has_secret).
--   3. Denetim izi SCRUB'LU: audit_log'da eylem + saglayici + e-posta var,
--      cipher / parola YOK.
--   4. mail_account_save p_secret_cipher: NULL=koru, ''=sil.
--   5. Oturum yoksa yazma reddedilir.
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
end $$;

select id as ornek from core.tenants where slug = 'ornek-ticaret' \gset

-- 33333333 = Ali (ornek uyesi, sales)   -- SAHIP
-- 22222222 = Merve (ornek tenant_admin) -- baskasi, hatta yonetici
-- 66666666 = Sukru (platform admin + ornek tenant_admin)

\echo ''
\echo '=== 1. SAHIP KENDI HESABINI EKLER VE GORUR ==='
set role sezra_app;
select public.t_login('33333333-3333-3333-3333-333333333333', :'ornek');

select core.mail_account_save(
  null, 'imap', 'Is e-postam', 'ali@ornek.test',
  '{"host":"imap.ornek.test","port":993,"security":"ssl","username":"ali@ornek.test"}'::jsonb,
  'v1:FAKE_IV:FAKE_TAG:FAKE_CIPHERTEXT_ali') as acc_id \gset

select public.t_assert(
  (select count(*) from core.mail_account_list()) = 1,
  'Sahip kendi hesabini listeler');
select public.t_assert(
  (select has_secret from core.mail_account_list() where id = :'acc_id') is true,
  'has_secret = true (kimlik bilgisi tanimli)');
select public.t_assert(
  (select status from core.mail_account_list() where id = :'acc_id') = 'pending',
  'Yeni hesap pending durumda');

-- YAPISAL KANIT: mail_account_list() satirinda gizli alan yok. Donen satiri
-- jsonb'ye cevirip anahtarlarina bakiyoruz -- fonksiyon degisip yanlislikla
-- cipher eklerse bu test kirilir.
select public.t_assert(
  not exists (
    select 1 from core.mail_account_list() x
    where to_jsonb(x) ?| array['secret_cipher', 'password', 'access_token', 'refresh_token', 'secret']
  ),
  'mail_account_list() satirinda gizli alan (cipher/password/token) YOK');

\echo ''
\echo '=== 2. BASKASI (tenant_admin bile) GOREMEZ / DOKUNAMAZ ==='
select public.t_login('22222222-2222-2222-2222-222222222222', :'ornek');
select public.t_assert(
  (select count(*) from core.mail_account_list()) = 0,
  'tenant_admin baskasinin mail hesabini LISTELEYEMEZ');
select public.t_assert(
  (select count(*) from core.mail_accounts) = 0,
  'tenant_admin dogrudan SELECT ile de goremez (RLS)');
select public.t_assert(
  (select count(*) from core.mail_accounts where id = :'acc_id') = 0,
  'Id bilinse bile satir gorunmez');

select public.t_assert(
  public.t_raises(format(
    'select core.mail_account_save(%L, ''imap'', ''Calinti'', ''x@y.test'', ''{}''::jsonb, ''HACK'')',
    :'acc_id')) = 'P0002',
  'tenant_admin baskasinin hesabini GUNCELLEYEMEZ (P0002)');
select public.t_assert(
  public.t_raises(format('select core.mail_account_delete(%L)', :'acc_id')) = 'P0002',
  'tenant_admin baskasinin hesabini SILEMEZ (P0002)');

-- Destek modu da baypas etmez.
select set_config('app.support_mode', 'on', false);
select public.t_assert(
  (select count(*) from core.mail_account_list()) = 0,
  'Destek modu bile baskasinin mail hesabini acmaz');
select set_config('app.support_mode', 'off', false);

-- Ayni sey Sukru (platform admin) icin de gecerli.
select public.t_login('66666666-6666-6666-6666-666666666666', :'ornek');
select public.t_assert(
  (select count(*) from core.mail_account_list()) = 0,
  'Platform admini bile baskasinin mail hesabini goremez');

\echo ''
\echo '=== 3. DENETIM IZI SCRUBLU: cipher / parola YOK ==='
reset role;
select public.t_assert(
  exists (select 1 from core.audit_log
          where entity_table = 'mail_accounts' and entity_id = :'acc_id'
            and action = 'insert'),
  'Ekleme denetim izine yazildi');
select public.t_assert(
  (select bool_and(
     not (coalesce(old_data::text, '') || coalesce(new_data::text, '')) like '%FAKE_CIPHERTEXT%'
     and not (coalesce(old_data::text, '') || coalesce(new_data::text, '')) like '%FAKE_TAG%')
   from core.audit_log where entity_table = 'mail_accounts'),
  'audit_log HICBIR satirinda cipher govdesi yok');
select public.t_assert(
  (select new_data ? 'email_address' and not new_data ? 'secret_cipher'
   from core.audit_log
   where entity_table = 'mail_accounts' and entity_id = :'acc_id' and action = 'insert'
   limit 1),
  'audit new_data: email_address VAR, secret_cipher YOK');

\echo ''
\echo '=== 4. GIZLI KORUMA / SILME MANTIGI ==='
set role sezra_app;
select public.t_login('33333333-3333-3333-3333-333333333333', :'ornek');

-- NULL cipher: mevcut korunur, sadece etiket degisir.
select core.mail_account_save(
  :'acc_id', 'imap', 'Yeni etiket', 'ali@ornek.test',
  '{"host":"imap.ornek.test","port":993,"security":"ssl"}'::jsonb,
  null);
reset role;
select public.t_assert(
  (select secret_cipher from core.mail_accounts where id = :'acc_id')
    = 'v1:FAKE_IV:FAKE_TAG:FAKE_CIPHERTEXT_ali',
  'p_secret_cipher NULL: mevcut sifreli demet KORUNDU');
select public.t_assert(
  (select display_name from core.mail_accounts where id = :'acc_id') = 'Yeni etiket',
  'Etiket guncellendi');

-- Durum yaz.
set role sezra_app;
select public.t_login('33333333-3333-3333-3333-333333333333', :'ornek');
select core.mail_account_set_status(:'acc_id', 'verified', 'Baglanti tamam');
select public.t_assert(
  (select status from core.mail_account_list() where id = :'acc_id') = 'verified'
  and (select last_verified_at from core.mail_account_list() where id = :'acc_id') is not null,
  'mail_account_set_status: durum verified + last_verified_at dolu');

-- Bos string cipher: sil, durum pending'e don.
select core.mail_account_save(
  :'acc_id', 'imap', 'Yeni etiket', 'ali@ornek.test', '{}'::jsonb, '');
select public.t_assert(
  (select has_secret from core.mail_account_list() where id = :'acc_id') is false
  and (select status from core.mail_account_list() where id = :'acc_id') = 'pending',
  'p_secret_cipher '''': sifreli demet silindi, durum pending');

\echo ''
\echo '=== 5. OTURUM YOKSA YAZMA REDDEDILIR ==='
select public.t_login(null, null);
select public.t_assert(
  public.t_raises(
    'select core.mail_account_save(null, ''imap'', ''X'', ''x@y.test'', ''{}''::jsonb, ''C'')') = '42501',
  'Oturum yoksa mail_account_save 42501');
select public.t_assert(
  (select count(*) from core.mail_account_list()) = 0,
  'Oturum yoksa mail_account_list bos');

\echo ''
\echo '=== 6. SAHIP SILER ==='
select public.t_login('33333333-3333-3333-3333-333333333333', :'ornek');
select core.mail_account_delete(:'acc_id');
select public.t_assert(
  (select count(*) from core.mail_account_list()) = 0,
  'Silindikten sonra liste bos');
reset role;
select public.t_assert(
  exists (select 1 from core.audit_log
          where entity_table = 'mail_accounts' and entity_id = :'acc_id' and action = 'delete'),
  'Silme de denetim izine yazildi');

\echo ''
\echo 'BAGLI MAIL HESABI TESTLERI GECTI'
