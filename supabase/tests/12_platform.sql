-- =============================================================================
-- Platform yönetim konsolu testleri
-- =============================================================================
-- En kritik iddia şudur: konsol fonksiyonları `security definer` olduğu için
-- RLS'i atlar. Yetkiyi tek tutan şey fonksiyonun ilk satırındaki
-- platform_guard'dır. Bu yüzden HER fonksiyon ayrı ayrı sınanır: birinde
-- unutulmuş bir kontrol, tüm kiracıların verisini açar.
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

select id as ornek from core.tenants where slug = 'ornek-ticaret' \gset
select id as rakip    from core.tenants where slug = 'rakip-ticaret' \gset

\echo ''
\echo '=== 1. YETKİ: her uç ayrı ayrı korunmalı ==='
set role sezra_app;

-- Kiracı yöneticisi (platform yöneticisi DEĞİL)
select set_config('app.user_id', '22222222-2222-2222-2222-222222222222', false);

select public.t_assert(
  public.t_raises('select * from core.platform_overview()') = '42501',
  'platform_overview kiracı yöneticisine kapalı');
select public.t_assert(
  public.t_raises('select * from core.platform_tenants()') = '42501',
  'platform_tenants kiracı yöneticisine kapalı');
select public.t_assert(
  public.t_raises(format('select * from core.platform_tenant_modules(%L)', :'rakip')) = '42501',
  'platform_tenant_modules kiracı yöneticisine kapalı');
select public.t_assert(
  public.t_raises('select * from core.platform_module_adoption()') = '42501',
  'platform_module_adoption kiracı yöneticisine kapalı');
select public.t_assert(
  public.t_raises('select * from core.platform_health()') = '42501',
  'platform_health kiracı yöneticisine kapalı');
select public.t_assert(
  public.t_raises(format('select core.platform_set_module(%L, ''hr'', true)', :'rakip')) = '42501',
  'platform_set_module kiracı yöneticisine kapalı');
select public.t_assert(
  public.t_raises(format('select core.platform_set_plan(%L, ''kurumsal'')', :'rakip')) = '42501',
  'platform_set_plan kiracı yöneticisine kapalı');
select public.t_assert(
  public.t_raises(format('select core.platform_set_status(%L, ''suspended'')', :'rakip')) = '42501',
  'platform_set_status kiracı yöneticisine kapalı');

-- Platform yöneticisi DESTEK MODU OLMADAN da konsolu görebilmeli:
-- konsol müşteri verisi değil, işletme verisidir.
select set_config('app.user_id', '11111111-1111-1111-1111-111111111111', false);
select set_config('app.support_mode', 'off', false);
select public.t_assert(
  (select tenant_count from core.platform_overview()) = 2,
  'Platform yöneticisi destek modu OLMADAN konsolu görür',
  (select tenant_count::text from core.platform_overview()));

\echo ''
\echo '=== 2. KİRACI LİSTESİ ==='
select public.t_assert(
  (select count(*) from core.platform_tenants()) = 2,
  'Liste tüm kiracıları döndürür (RLS''e rağmen, çünkü işletme verisi)');

select public.t_assert(
  (select count(*) from core.platform_tenants('rakip')) = 1,
  'Arama süzgeci çalışır');

select public.t_assert(
  (select user_count from core.platform_tenants('ornek')) = 3,
  'Kullanıcı sayısı doğru',
  (select user_count::text from core.platform_tenants('ornek')));

\echo ''
\echo '=== 3. MODÜL AÇMA: kurulum kancası da çalışmalı ==='
-- Rakip Ticaret'de İK kapalı. Açtığımızda yalnızca bayrak değil, modülün
-- varsayılan verisi de gelmeli; aksi hâlde müşteri boş bir modül görür.
--
-- DİKKAT: Rakip Ticaret'nin satırları RLS ile gizlidir (platform yöneticisinin
-- aktif kiracısı o değil ve destek modu kapalı). Kurulum kancasının gerçekten
-- çalıştığını görmek için sayım owner rolüyle, RLS dışında yapılır. Bu, testin
-- kaçamağı değil: RLS'in doğru çalıştığının da ayrıca kanıtı.
reset role;
select count(*) as lt_baslangic from hr.leave_types where tenant_id = :'rakip' \gset
set role sezra_app;
select set_config('app.user_id', '11111111-1111-1111-1111-111111111111', false);

select public.t_assert(
  :lt_baslangic = 0,
  'Başlangıçta Rakip Ticaret''de izin tipi yok', :'lt_baslangic');

select core.platform_set_module(:'rakip', 'hr', true) as opened \gset

select public.t_assert(
  (select enabled from core.tenant_modules
    where tenant_id = :'rakip' and module_code = 'hr'),
  'Modül açıldı');

reset role;
select count(*) as lt_sonra from hr.leave_types where tenant_id = :'rakip' \gset
set role sezra_app;
select set_config('app.user_id', '11111111-1111-1111-1111-111111111111', false);

select public.t_assert(
  :lt_sonra > 0,
  'Modül ilk kez açılınca kurulum kancası çalıştı (izin tipleri geldi)', :'lt_sonra');

-- Platform yöneticisi kiracının VERİSİNİ göremez: modülü açabilir ama
-- içindekine bakmak için destek modu gerekir. İki yüzeyin ayrımı budur.
select public.t_assert(
  (select count(*) from hr.leave_types where tenant_id = :'rakip') = 0,
  'Platform yöneticisi, açtığı modülün İÇİNDEKİ veriyi destek modu olmadan göremez');

-- Aynı modülü tekrar açmak kancayı YENİDEN çalıştırmamalı
select core.platform_set_module(:'rakip', 'hr', true) as reopened \gset
reset role;
select count(*) as lt_tekrar from hr.leave_types where tenant_id = :'rakip' \gset
set role sezra_app;
select set_config('app.user_id', '11111111-1111-1111-1111-111111111111', false);

select public.t_assert(
  :lt_tekrar = :lt_sonra,
  'Zaten açık modülü tekrar açmak veriyi çoğaltmaz');

\echo ''
\echo '=== 4. KORUMALAR ==='
select public.t_assert(
  public.t_raises(format('select core.platform_set_module(%L, ''core'', false)', :'rakip')) = '23514',
  'Çekirdek modül kapatılamaz');

select public.t_assert(
  public.t_raises(format('select core.platform_set_module(%L, ''yokboyle'', true)', :'rakip')) = '22023',
  'Tanımsız modül reddedilir');

select public.t_assert(
  public.t_raises(format('select core.platform_set_plan(%L, ''yokboyle'')', :'rakip')) = '22023',
  'Tanımsız plan reddedilir');

\echo ''
\echo '=== 5. DENETİM İZİ ==='
-- Kiracı "modülümü kim kapattı" sorusunu KENDİ denetim izinden yanıtlayabilmeli.
-- Kayıt kiracıya aittir, o yüzden RLS dışında (owner) doğruluyoruz; kiracının
-- kendi oturumundan görebildiği aşağıda ayrıca sınanıyor.
reset role;
select count(*) as audit_n from core.audit_log
 where tenant_id = :'rakip' and entity_table = 'tenant_modules'
   and actor_id = '11111111-1111-1111-1111-111111111111' \gset
select support_session as audit_support from core.audit_log
 where tenant_id = :'rakip' and entity_table = 'tenant_modules'
 order by occurred_at desc limit 1 \gset

select public.t_assert(:audit_n > 0,
  'Modül değişikliği kiracının denetim izine yazıldı', :'audit_n');

select public.t_assert(:'audit_support' = 't',
  'Platform müdahalesi denetim izinde işaretli (support_session)');

-- Asıl mesele: KİRACI bunu kendi oturumunda görebiliyor mu?
set role sezra_app;
select set_config('app.user_id', '55555555-5555-5555-5555-555555555555', false);
select public.t_assert(
  (select count(*) from core.audit_log where entity_table = 'tenant_modules') > 0,
  'Kiracı, platformun kendi modülüne müdahalesini denetim izinde GÖREBİLİR',
  (select count(*)::text from core.audit_log where entity_table = 'tenant_modules'));

select set_config('app.user_id', '11111111-1111-1111-1111-111111111111', false);

\echo ''
\echo '=== 6. PLAN DEĞİŞİKLİĞİ ==='
select seats as seats_before from core.subscriptions
 where tenant_id = :'rakip' and status in ('trial','active','past_due') \gset

select core.platform_set_plan(:'rakip', 'kurumsal') is not null as changed \gset

select public.t_assert(
  (select plan_code from core.subscriptions
    where tenant_id = :'rakip' and status in ('trial','active','past_due')) = 'kurumsal',
  'Plan değişti');

select public.t_assert(
  (select seats from core.subscriptions
    where tenant_id = :'rakip' and status in ('trial','active','past_due')) = 30,
  'Koltuk sayısı yeni plandan tazelendi',
  (select seats::text from core.subscriptions
    where tenant_id = :'rakip' and status in ('trial','active','past_due')));

select public.t_assert(
  (select enabled from core.tenant_modules
    where tenant_id = :'rakip' and module_code = 'purchasing'),
  'Yeni planın kapsadığı modüller açıldı');

-- Plan dışı kalan modül SESSİZCE KAPATILMAZ: müşterinin kullandığı bir modülü
-- plan değişikliğiyle elinden almak, veri kaybı gibi hissettiren bir sürprizdir.
select public.t_assert(
  (select enabled from core.tenant_modules
    where tenant_id = :'rakip' and module_code = 'hr'),
  'Plan değişikliği, plan dışında kalan açık modülü kapatmaz');

\echo ''
\echo '=== 7. ABONELİK DURUMU ==='
select core.platform_set_status(:'rakip', 'suspended') is not null as suspended \gset
select public.t_assert(
  (select status::text from core.subscriptions where tenant_id = :'rakip') = 'suspended',
  'Abonelik askıya alındı');

select public.t_assert(
  (select suspended_count from core.platform_overview()) = 1,
  'Genel bakış askıya alınan aboneliği sayar');

select core.platform_set_status(:'rakip', 'active') is not null as reactivated \gset
select public.t_assert(
  (select mrr from core.platform_overview()) > 0,
  'Etkin aboneliği olan kiracı MRR''a girer',
  (select mrr::text from core.platform_overview()));

-- Deneme geliri MRR'a girmemeli
select public.t_assert(
  (select mrr from core.platform_overview())
   = (select p.monthly_price from core.subscriptions s
        join core.plans p on p.code = s.plan_code
       where s.tenant_id = :'rakip' and s.status = 'active'),
  'MRR yalnızca ödeyen abonelikleri sayar, denemeyi saymaz');

\echo ''
\echo '=== 8. KONSOL MÜŞTERİ İŞ VERİSİ DÖNDÜRMEZ ==='
-- Konsolun döndürdüğü kolonlar işletme verisidir. İş verisi (fırsat, fatura,
-- bordro) için destek modu gerekir ve o ayrı bir yüzeydir.
select public.t_assert(
  not exists (
    select 1 from information_schema.parameters
    where specific_schema = 'core'
      and specific_name like 'platform\_%'
      and parameter_name in ('expected_revenue', 'net', 'total', 'gross')),
  'Konsol fonksiyonlarının çıktısında müşteri iş verisi kolonu yok');

\echo ''
\echo '=== 9. MARKA: logoyu yalnızca platform yöneticisi değiştirebilir ==='
set role sezra_app;

-- Kiracı yöneticisi (platform yöneticisi DEĞİL)
select set_config('app.user_id', '22222222-2222-2222-2222-222222222222', false);

select public.t_assert(
  public.t_raises($q$select core.platform_set_logo(
    'data:image/png;base64,iVBORw0KGgo=', 'image/png', 10)$q$) = '42501',
  'Kiracı yöneticisi logo yükleyemez');

select public.t_assert(
  public.t_raises('select core.platform_clear_logo()') = '42501',
  'Kiracı yöneticisi logoyu kaldıramaz');

-- Tabloya doğrudan yazma da kapalı: yazma politikası hiç yoktur, dolayısıyla
-- SECURITY DEFINER fonksiyonlarını atlayan bir yol kalmaz.
-- UPDATE politikası olmadığı için satır sessizce ETKİLENMEZ (hata da vermez);
-- kanıt, değerin değişmemiş olmasıdır.
update core.platform_settings set logo_data_uri = 'kacak' where id;
select public.t_assert(
  (select logo_data_uri from core.platform_branding()) is distinct from 'kacak',
  'Kiracı yöneticisi tabloya doğrudan yazamaz');

-- Okuma HERKESE açıktır: logo giriş ekranında, kimlik doğrulamadan önce
-- gerekir. Kimliksiz bağlamda da okunabilmeli.
select set_config('app.user_id', '', false);
select public.t_assert(
  (select count(*) from core.platform_branding()) = 1,
  'Marka kimlik olmadan okunabilir');

-- Platform yöneticisi yazabilir ve okunan değer yazılanla aynıdır.
select set_config('app.user_id', '11111111-1111-1111-1111-111111111111', false);
select core.platform_set_logo('data:image/png;base64,iVBORw0KGgo=', 'image/png', 10) is null as _ \gset

select public.t_assert(
  (select logo_mime from core.platform_branding()) = 'image/png',
  'Platform yöneticisi logo yükleyebilir');

-- VARYANT YALITIMI: koyu logo yazmak açık olanı ETKİLEMEZ. İkisi tek satırda
-- durduğu için bir güncellemenin diğerini sıfırlaması kolay bir hatadır;
-- test onu yakalar.
select core.platform_set_logo(
  'data:image/svg+xml;base64,PHN2Zz48L3N2Zz4=', 'image/svg+xml', 13, 'dark') is null as _ \gset

select public.t_assert(
  (select logo_mime from core.platform_branding()) = 'image/png'
    and (select logo_dark_mime from core.platform_branding()) = 'image/svg+xml',
  'Koyu varyant yazmak açık varyantı bozmaz');

select core.platform_clear_logo('dark') is null as _ \gset
select public.t_assert(
  (select logo_dark_data_uri from core.platform_branding()) is null
    and (select logo_data_uri from core.platform_branding()) is not null,
  'Koyu varyantı silmek açık varyantı silmez');

select public.t_assert(
  public.t_raises($q$select core.platform_set_logo(
    'data:image/png;base64,iVBORw0KGgo=', 'image/png', 10, 'mavi')$q$) = '22023',
  'Geçersiz varyant adı reddedilir');

-- Sunucu doğrulaması veritabanında da durur: API katmanı atlansa bile
-- desteklenmeyen tür ve aşırı boyut reddedilir.
select public.t_assert(
  public.t_raises($q$select core.platform_set_logo(
    'data:application/pdf;base64,JVBERi0=', 'application/pdf', 10)$q$) = '22023',
  'Desteklenmeyen tür veritabanı katmanında da reddedilir');

select public.t_assert(
  public.t_raises($q$select core.platform_set_logo(
    'data:image/png;base64,iVBORw0KGgo=', 'image/png', 600000)$q$) = '22023',
  'Boyut sınırı veritabanı katmanında da uygulanır');

-- Bildirilen tür ile içerik uyuşmazlığı: 'image/png' denip SVG gönderilemez.
select public.t_assert(
  public.t_raises($q$select core.platform_set_logo(
    'data:image/svg+xml;base64,PHN2Zz48L3N2Zz4=', 'image/png', 10)$q$) = '22023',
  'İçerik bildirilen türle uyuşmazsa reddedilir');

-- İletişim bilgileri de aynı sınırın arkasında: numarayı değiştirebilen
-- bir kiracı, kendi müşterisine Sezra'nın destek numarası diye başka bir
-- numara gösterebilirdi.
select set_config('app.user_id', '22222222-2222-2222-2222-222222222222', false);
select public.t_assert(
  public.t_raises($q$select core.platform_set_contact(
    'not', '0216 000 00 00', 'sabit', null, null, null)$q$) = '42501',
  'Kiracı yöneticisi iletişim bilgisini değiştiremez');

select set_config('app.user_id', '11111111-1111-1111-1111-111111111111', false);
select core.platform_set_contact(
  'Kurulumda ara', '0216 000 00 00', 'sabit', '0530 000 00 00', 'cep', '0530 000 00 00'
) is null as _ \gset

select public.t_assert(
  (select contact_phone1 from core.platform_branding()) = '0216 000 00 00'
    and (select contact_phone2_label from core.platform_branding()) = 'cep',
  'Platform yöneticisi iletişim bilgisini yazabilir');

-- Boş string NULL'a çevrilir: arayüzden temizlenen alan "boş metin" değil
-- "yok" anlamına gelmeli, yoksa okuma tarafı boş bir satır çizer.
select core.platform_set_contact(null, '   ', '', null, null, null) is null as _ \gset
select public.t_assert(
  (select contact_phone1 from core.platform_branding()) is null,
  'Boşluktan ibaret numara NULL olarak saklanır');

select core.platform_clear_logo() is null as _ \gset
select public.t_assert(
  (select logo_data_uri from core.platform_branding()) is null,
  'Platform yöneticisi logoyu kaldırabilir');

-- Marka değişikliği denetim izine düşer.
--
-- SAHİP ROLÜYLE OKUNUR: platform kayıtları `tenant_id = null` taşır ve
-- audit_log politikaları kiracıya kapsanmıştır, dolayısıyla bu satırlar RLS
-- altında hiçbir kiracı oturumunda görünmez. Testin doğruladığı şey yazmanın
-- GERÇEKLEŞTİĞİdir; okunabilirliği ayrı bir konudur (platform konsolunda
-- şimdilik bir görüntüleme yüzeyi yok).
\echo ''
\echo '=== 10. KONSOL SAĞLIK KARTI: başarısız teslimat VARKEN de çalışmalı ==='
--
-- `platform_health()` dönüş tipini ancak SATIR DÖNDÜĞÜNDE denetler. Kuyruk
-- temizken hiç satır dönmez, dolayısıyla bir tip uyuşmazlığı görünmez ve
-- fonksiyon "çalışıyor" sanılır. Tam da sorun çıktığı anda -- bir teslimat
-- düştüğünde -- patlar. Bu yüzden test bir teslimatı bilerek düşürür.
reset role;
select id as teslimat from core.event_deliveries limit 1 \gset
update core.event_deliveries set status = 'failed', attempts = 3 where id = :'teslimat';

set role sezra_app;
select set_config('app.user_id', '11111111-1111-1111-1111-111111111111', false);
select public.t_assert(
  (select count(*) from core.platform_health()) >= 1,
  'Başarısız teslimat varken sağlık kartı satır döndürür');

select public.t_assert(
  (select attempts from core.platform_health() limit 1) = 3,
  'Deneme sayısı doğru tipte ve değerde döner');

reset role;
update core.event_deliveries set status = 'done', attempts = 1 where id = :'teslimat';

reset role;
select public.t_assert(
  (select count(*) from core.audit_log where entity_table = 'platform_settings') >= 2,
  'Logo değişiklikleri denetim izine yazılır',
  (select count(*)::text from core.audit_log where entity_table = 'platform_settings'));
