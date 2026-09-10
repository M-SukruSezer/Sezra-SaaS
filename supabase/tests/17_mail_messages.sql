-- =============================================================================
-- Mail mesaj saklama + senkron durumu testleri (T-029 -- adim 1)
-- =============================================================================
-- Iddialar:
--   1. RLS: bir kullanici YALNIZCA kendi mesajlarini gorur/okur. Ayni
--      kiracidaki tenant_admin, platform admini ve DESTEK MODU baskasinin
--      mesajina/govdesine ERISEMEZ.
--   2. Liste (mail_message_list) govde DONDURMEZ -- yalnizca ust veri + snippet.
--   3. (account_id, uid) essiz: ayni mesaj iki kez yazilmaz (ingest idempotent).
--   4. Giden mesaj kaydi: send_status zorunlu, basarisiz gonderim de kaydedilir.
--   5. Senkron durumu upsert: last_uid monoton artar; hata dali last_error''a
--      gecer, last_synced_at''e dokunmaz.
--   6. KVKK trim: hesap basina mail_message_keep() ustu gelen mesaj silinir,
--      giden mesaja dokunulmaz.
--   7. Oturum yoksa yazma reddedilir (42501).
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

-- 33333333 = Ali (ornek uyesi)          -- SAHIP
-- 22222222 = Merve (ornek tenant_admin) -- baskasi
-- 44444444 = Deniz (ornek uyesi)        -- baskasi
-- 66666666 = Sukru (platform admin)     -- baskasi

\echo ''
\echo '=== HAZIRLIK: Ali bir IMAP hesabi baglar ==='
set role sezra_app;
select public.t_login('33333333-3333-3333-3333-333333333333', :'ornek');
select core.mail_account_save(
  null, 'imap', 'Is e-postam', 'ali@ornek.test',
  '{"host":"imap.ornek.test","port":993,"security":"ssl"}'::jsonb,
  'v1:FAKE_IV:FAKE_TAG:FAKE_CT') as acc_id \gset

\echo ''
\echo '=== 1. INGEST: gelen mesaj yazilir, listelenir, govde okunur ==='
select core.mail_message_ingest(
  p_account_id => :'acc_id', p_uid => '101', p_uid_validity => '42',
  p_folder => 'INBOX', p_message_id => '<a@x>', p_in_reply_to => null,
  p_subject => 'Teklif hk.', p_from_addr => 'mus@firma.test', p_from_name => 'Musteri',
  p_to_addrs => array['ali@ornek.test'], p_cc_addrs => '{}'::text[],
  p_sent_at => now() - interval '2 hours', p_received_at => now() - interval '1 hour',
  p_snippet => 'Merhaba, teklifiniz hakkinda...', p_body_text => 'Merhaba, teklifiniz hakkinda gorusmek istiyoruz.',
  p_body_html => '<p>Merhaba <script>alert(1)</script></p>', p_has_attachments => true, p_size_bytes => 2048) as m1 \gset

select core.mail_message_ingest(
  p_account_id => :'acc_id', p_uid => '102', p_uid_validity => '42',
  p_folder => 'INBOX', p_message_id => '<b@x>', p_in_reply_to => null,
  p_subject => 'Fatura', p_from_addr => 'muh@firma.test', p_from_name => 'Muhasebe',
  p_to_addrs => array['ali@ornek.test'], p_cc_addrs => '{}'::text[],
  p_sent_at => now() - interval '30 min', p_received_at => now() - interval '20 min',
  p_snippet => 'Eki inceleyin', p_body_text => 'Fatura ektedir.',
  p_body_html => null, p_has_attachments => false, p_size_bytes => 900);

select public.t_assert(
  (select total_count from core.mail_message_list(:'acc_id') limit 1) = 2,
  'Ali iki gelen mesajini listeler');
select public.t_assert(
  (select subject from core.mail_message_list(:'acc_id') limit 1) = 'Fatura',
  'Liste received_at azalan sirali (en yeni once)');
select public.t_assert(
  (select body_text from core.mail_message_get(:'m1')) = 'Merhaba, teklifiniz hakkinda gorusmek istiyoruz.',
  'mail_message_get govdeyi dondurur (sahibe)');
select public.t_assert(
  (select body_html from core.mail_message_get(:'m1')) like '%<script>%',
  'body_html HAM saklanir (temizleme render katmaninda)');

-- YAPISAL KANIT: liste satirinda govde alani YOK.
select public.t_assert(
  not exists (
    select 1 from core.mail_message_list(:'acc_id') x
    where to_jsonb(x) ?| array['body_text', 'body_html']
  ),
  'mail_message_list() satirinda body_text/body_html YOK');

\echo ''
\echo '=== 2. INGEST IDEMPOTENT: ayni (account, uid) iki kez yazilmaz ==='
select public.t_assert(
  core.mail_message_ingest(
    p_account_id => :'acc_id', p_uid => '101', p_uid_validity => '42',
    p_folder => 'INBOX', p_message_id => '<a@x>', p_in_reply_to => null,
    p_subject => 'Teklif hk. (kopya)', p_from_addr => 'mus@firma.test', p_from_name => 'Musteri',
    p_to_addrs => array['ali@ornek.test'], p_cc_addrs => '{}'::text[],
    p_sent_at => now(), p_received_at => now(),
    p_snippet => 'x', p_body_text => 'x', p_body_html => null,
    p_has_attachments => false, p_size_bytes => 1) is null,
  'Ayni uid tekrar ingest -> NULL (hicbir sey yapilmadi)');
select public.t_assert(
  (select total_count from core.mail_message_list(:'acc_id') limit 1) = 2,
  'Mesaj sayisi hala 2');
select public.t_assert(
  (select subject from core.mail_message_get(:'m1')) = 'Teklif hk.',
  'Ilk mesajin konusu degismedi');

\echo ''
\echo '=== 3. RLS: baskasi (tenant_admin / platform admin / destek modu) goremez ==='
select public.t_login('22222222-2222-2222-2222-222222222222', :'ornek');
select public.t_assert(
  (select count(*) from core.mail_message_list(:'acc_id')) = 0,
  'tenant_admin baskasinin mesajlarini LISTELEYEMEZ');
select public.t_assert(
  (select count(*) from core.mail_message_get(:'m1')) = 0,
  'tenant_admin id bilse bile mesaji OKUYAMAZ');
select public.t_assert(
  (select count(*) from core.mail_messages) = 0,
  'tenant_admin dogrudan SELECT ile de goremez (RLS)');
select public.t_assert(
  public.t_raises(format('select core.mail_message_mark_seen(%L, true)', :'m1')) = 'P0002',
  'tenant_admin baskasinin mesajini isaretleyemez (P0002)');

select set_config('app.support_mode', 'on', false);
select public.t_assert(
  (select count(*) from core.mail_message_list(:'acc_id')) = 0,
  'Destek modu bile baskasinin postasini acmaz');
select set_config('app.support_mode', 'off', false);

select set_config('app.accountant_mode', 'on', false);
select public.t_assert(
  (select count(*) from core.mail_message_list(:'acc_id')) = 0,
  'Mali musavir modu bile baskasinin postasini acmaz');
select set_config('app.accountant_mode', 'off', false);

-- YAPISAL KANIT: politika metninde destek/musavir OR dali YOK -- kisisel posta
-- hicbir cross-tenant okuma moduna acilmaz (1160 mail_accounts ile ayni).
reset role;
select public.t_assert(
  not exists (
    select 1 from pg_policies
    where schemaname = 'core' and tablename in ('mail_messages', 'mail_sync_state')
      and (coalesce(qual, '') || coalesce(with_check, '')) ~* 'support|accountant|musavir'
  ),
  'mail_messages/mail_sync_state politikalari support/accountant terimi ICERMEZ');
set role sezra_app;
select public.t_login('22222222-2222-2222-2222-222222222222', :'ornek');

select public.t_login('66666666-6666-6666-6666-666666666666', :'ornek');
select public.t_assert(
  (select count(*) from core.mail_message_get(:'m1')) = 0,
  'Platform admini bile baskasinin mesajini okuyamaz');

\echo ''
\echo '=== 4. Okundu isareti (sahip) ==='
select public.t_login('33333333-3333-3333-3333-333333333333', :'ornek');
select public.t_assert(
  (select seen from core.mail_message_get(:'m1')) is false, 'Baslangicta okunmamis');
select core.mail_message_mark_seen(:'m1', true);
select public.t_assert(
  (select seen from core.mail_message_get(:'m1')) is true, 'mark_seen sonrasi okunmus');

\echo ''
\echo '=== 5. GIDEN MESAJ KAYDI ==='
select core.mail_message_record_sent(
  p_account_id => :'acc_id', p_to_addrs => array['mus@firma.test'], p_cc_addrs => '{}'::text[],
  p_subject => 'RE: Teklif hk.', p_body_text => 'Teklifimiz ektedir.',
  p_in_reply_to => '<a@x>', p_status => 'sent', p_error => null) as out1 \gset
select public.t_assert(
  (select send_status from core.mail_message_get(:'out1')) = 'sent'
  and (select direction from core.mail_message_get(:'out1')) = 'outgoing',
  'Giden mesaj outgoing + send_status=sent');
select public.t_assert(
  (select from_addr from core.mail_message_get(:'out1')) = 'ali@ornek.test',
  'Giden mesajin from_addr hesabin adresi');
select core.mail_message_record_sent(
  p_account_id => :'acc_id', p_to_addrs => array['x@y.test'], p_cc_addrs => '{}'::text[],
  p_subject => 'Deneme', p_body_text => 'x', p_in_reply_to => null,
  p_status => 'failed', p_error => 'SMTP 550') as out2 \gset
select public.t_assert(
  (select send_status from core.mail_message_get(:'out2')) = 'failed'
  and (select send_error from core.mail_message_get(:'out2')) = 'SMTP 550',
  'Basarisiz gonderim de kaydedilir (send_status=failed, send_error dolu)');
select public.t_assert(
  public.t_raises(format(
    'select core.mail_message_record_sent(%L, ''{}''::text[], ''{}''::text[], ''s'', ''b'', null, ''queued'', null)',
    :'acc_id')) = '23514',
  'Gecersiz gonderim durumu reddedilir (23514)');
-- Giden mesaj gelen listesinde cikmaz.
select public.t_assert(
  (select total_count from core.mail_message_list(:'acc_id', 'incoming') limit 1) = 2,
  'incoming listesi giden mesajlari icermez');
select public.t_assert(
  (select total_count from core.mail_message_list(:'acc_id', 'outgoing') limit 1) = 2,
  'outgoing listesi 2 giden mesaj');

\echo ''
\echo '=== 6. SENKRON DURUMU upsert ==='
select core.mail_sync_state_set(:'acc_id', '42', 102::bigint, null);
select public.t_assert(
  (select last_uid from core.mail_sync_state_get(:'acc_id')) = 102
  and (select last_synced_at from core.mail_sync_state_get(:'acc_id')) is not null
  and (select last_error from core.mail_sync_state_get(:'acc_id')) is null,
  'Basarili senkron: last_uid=102, last_synced_at dolu, last_error bos');
-- Daha kucuk last_uid geriletmez.
select core.mail_sync_state_set(:'acc_id', '42', 50::bigint, null);
select public.t_assert(
  (select last_uid from core.mail_sync_state_get(:'acc_id')) = 102,
  'last_uid monoton: kucuk deger geriletmez');
-- Hata dali.
select core.mail_sync_state_set(:'acc_id', '42', 102::bigint, 'Kimlik dogrulama basarisiz');
select public.t_assert(
  (select last_error from core.mail_sync_state_get(:'acc_id')) = 'Kimlik dogrulama basarisiz'
  and (select last_error_at from core.mail_sync_state_get(:'acc_id')) is not null,
  'Hata dali: last_error + last_error_at yazildi');
select public.t_assert(
  (select count(*) from core.mail_sync_state s
   join core.mail_sync_state_get(:'acc_id') g on g.account_id = s.account_id) = 1,
  'Hesap basina tek senkron satiri (upsert, insert degil)');

\echo ''
\echo '=== 7. KVKK TRIM: hesap basina mail_message_keep() gelen mesaj ustu silinir ==='
-- Ali''nin adina toplu ekleme (BYPASSRLS owner rolu ile ucuz).
reset role;
insert into core.mail_messages (account_id, owner_id, direction, folder, uid, received_at, subject)
select :'acc_id', '33333333-3333-3333-3333-333333333333', 'incoming', 'INBOX',
       'bulk-' || g, now() - (g || ' minutes')::interval, 'toplu ' || g
from generate_series(1, 505) g;
set role sezra_app;
select public.t_login('33333333-3333-3333-3333-333333333333', :'ornek');
select public.t_assert(
  (select count(*) from core.mail_messages where account_id = :'acc_id' and direction = 'incoming') = 507,
  'Trim oncesi 507 gelen mesaj (2 + 505)');
select public.t_assert(
  core.mail_messages_trim(:'acc_id') = 7,
  'mail_messages_trim 7 mesaj sildi (507 - 500)');
select public.t_assert(
  (select count(*) from core.mail_messages where account_id = :'acc_id' and direction = 'incoming') = 500,
  'Trim sonrasi tam mail_message_keep() (500) gelen mesaj');
select public.t_assert(
  (select count(*) from core.mail_messages where account_id = :'acc_id' and direction = 'outgoing') = 2,
  'Trim giden mesaja DOKUNMADI (2 giden mesaj duruyor)');
select public.t_assert(
  exists (select 1 from core.mail_message_get(:'m1')) is false
  or (select received_at from core.mail_message_get(:'m1')) is not null,
  'En yeni mesajlar (m1 dahil son 500) korundu');
select public.t_assert(
  core.mail_messages_trim(:'acc_id') = 0,
  'Sinir altinda tekrar trim 0 siler');

\echo ''
\echo '=== 8. OTURUM YOKSA YAZMA REDDEDILIR ==='
select public.t_login(null, null);
select public.t_assert(
  public.t_raises(format(
    'select core.mail_message_ingest(p_account_id => %L, p_uid => ''9'', p_uid_validity => null, '
    'p_folder => null, p_message_id => null, p_in_reply_to => null, p_subject => null, '
    'p_from_addr => null, p_from_name => null, p_to_addrs => null, p_cc_addrs => null, '
    'p_sent_at => null, p_received_at => null, p_snippet => null, p_body_text => null, '
    'p_body_html => null, p_has_attachments => null, p_size_bytes => null)', :'acc_id')) = '42501',
  'Oturum yoksa mail_message_ingest 42501');
select public.t_assert(
  public.t_raises(format('select core.mail_sync_state_set(%L, null, 0, null)', :'acc_id')) = '42501',
  'Oturum yoksa mail_sync_state_set 42501');

\echo ''
\echo '=== TEMIZLIK ==='
reset role;
delete from core.mail_accounts where owner_id = '33333333-3333-3333-3333-333333333333';
select public.t_assert(
  (select count(*) from core.mail_messages where account_id = :'acc_id') = 0,
  'Hesap silinince mesajlar da gitti (on delete cascade)');
select public.t_assert(
  (select count(*) from core.mail_sync_state where account_id = :'acc_id') = 0,
  'Hesap silinince senkron durumu da gitti');

\echo ''
\echo 'MAIL MESAJ SAKLAMA TESTLERI GECTI'
