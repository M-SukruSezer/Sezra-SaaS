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
select id as ornek_id from core.tenants where slug = 'ornek-ticaret' \gset
select id as rakip_id    from core.tenants where slug = 'rakip-ticaret' \gset

\echo ''
\echo '=== 1. KİRACI İZOLASYONU ==='
set role sezra_app;
select public.t_login('55555555-5555-5555-5555-555555555555');   -- Rakip Ticaret yöneticisi

select public.t_assert(
  (select count(*) from crm.leads) = 0,
  'Rakip Ticaret yöneticisi Örnek Ticaret fırsatlarını GÖREMEZ',
  (select count(*)::text from crm.leads));

select public.t_assert(
  (select count(*) from core.partners) = 0,
  'Rakip Ticaret yöneticisi Örnek Ticaret carilerini GÖREMEZ',
  (select count(*)::text from core.partners));

select public.t_assert(
  (select count(*) from core.tenants) = 1,
  'Kullanıcı yalnızca kendi kiracısını görür');

-- Başka kiracının id'sini GUC'a zorlamak işe yaramaz: current_tenant_id()
-- id'yi üyelik tablosuna karşı doğrular, doğrulayamazsa NULL döner.
select public.t_login('55555555-5555-5555-5555-555555555555', :'ornek_id'::uuid);
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
  not exists (select 1 from crm.leads where name = 'Yıllık toplu tedarik sözleşmesi'),
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
   and tenant_id = (select id from core.tenants where slug = 'ornek-ticaret');
set role sezra_app;
select public.t_login('22222222-2222-2222-2222-222222222222');

select public.t_assert(
  (select count(*) from crm.leads) = 0,
  'CRM modülü kapatılınca şirket yöneticisi bile fırsat göremez',
  (select count(*)::text from crm.leads));

reset role;
update core.tenant_modules set enabled = true
 where module_code = 'crm'
   and tenant_id = (select id from core.tenants where slug = 'ornek-ticaret');
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

-- Destek modu açık AMA kiracı seçilmemiş: hiçbir şey görünmemeli.
-- Güvenli varsayılan budur; destek erişimi bilinçli bir seçim gerektirir.
select set_config('app.support_mode', 'on', false);
select set_config('app.tenant_id', '', false);
select public.t_assert(
  (select count(*) from finance.accounts) = 0,
  'Destek modu açık ama kiracı seçilmemişse hiçbir veri görünmez',
  (select count(*)::text from finance.accounts));

-- Kiracı seçili AMA bu yöneticiye o kiracı için CANLI bir destek izni yok:
-- tek faktörlü erişim kapatıldı (1100), kayıt yoksa hiçbir şey görünmez.
-- Her iki kiracıda da 63 hesap var; koşulsuz baypas olsaydı 126 dönerdi.
select set_config('app.tenant_id', :'ornek_id', false);
select public.t_assert(
  (select count(*) from finance.accounts) = 0,
  'Destek modu + kiracı seçili ama CANLI İZİN yoksa erişim REDDEDİLİR',
  (select count(*)::text from finance.accounts));
select public.t_assert(
  core.is_support_session() is false,
  'İzin yokken is_support_session() de false döner');

-- Bir platform yöneticisi (burada Sezra) Örnek Ticaret için süreli izin verir.
select (core.grant_support_access(
  '11111111-1111-1111-1111-111111111111'::uuid, :'ornek_id'::uuid,
  'DESTEK-1001 izolasyon testi', interval '1 hour')).id is not null as granted \gset
select public.t_assert(
  (select count(*) from finance.accounts) = 63,
  'Canlı destek izniyle YALNIZCA seçilen kiracının verisi görünür',
  (select count(*)::text from finance.accounts));

select public.t_assert(
  (select count(distinct tenant_id) from finance.accounts) = 1,
  'Destek oturumu kiracılar arası veri sızdırmaz',
  (select count(distinct tenant_id)::text from finance.accounts));

-- İzin bir kiracıya özeldir: izinsiz kiracıya geçince erişim kapanır.
select set_config('app.tenant_id', :'rakip_id', false);
select public.t_assert(
  (select count(*) from finance.accounts) = 0,
  'Başka kiracıya (izinsiz) geçilince erişim kapanır',
  (select count(*)::text from finance.accounts));

-- Rakip Ticaret için de izin verilince onun kendi verisi görünür.
select (core.grant_support_access(
  '11111111-1111-1111-1111-111111111111'::uuid, :'rakip_id'::uuid,
  'DESTEK-1002 izolasyon testi', interval '1 hour')).id is not null as granted2 \gset
select public.t_assert(
  (select count(*) from finance.accounts) = 63,
  'İkinci kiracıya izin verilince onun kendi verisi görünür',
  (select count(*)::text from finance.accounts));

-- SÜRESİ DOLMUŞ izin erişim vermez (owner ile geriye tarihliyoruz).
reset role;
update core.support_grants
   set granted_at = now() - interval '2 minutes',
       expires_at = now() - interval '1 minute'
 where admin_user_id = '11111111-1111-1111-1111-111111111111'
   and tenant_id = :'rakip_id';
set role sezra_app;
select public.t_login('11111111-1111-1111-1111-111111111111');
select set_config('app.support_mode', 'on', false);
select set_config('app.tenant_id', :'rakip_id', false);
select public.t_assert(
  (select count(*) from finance.accounts) = 0,
  'Süresi dolmuş destek izni erişim vermez',
  (select count(*)::text from finance.accounts));

-- İPTAL EDİLEN izin erişim vermez.
select set_config('app.tenant_id', :'ornek_id', false);
select public.t_assert(
  (select count(*) from finance.accounts) = 63,
  'Örnek Ticaret izni hâlâ canlı',
  (select count(*)::text from finance.accounts));
select core.revoke_support_access((
  select id from core.support_grants
   where admin_user_id = '11111111-1111-1111-1111-111111111111'
     and tenant_id = :'ornek_id' and revoked_at is null
   limit 1));
select public.t_assert(
  (select count(*) from finance.accounts) = 0,
  'İptal edilen destek izni erişim vermez',
  (select count(*)::text from finance.accounts));

select set_config('app.support_mode', 'off', false);

\echo ''
\echo '=== 11. VERGİ NUMARASI SAĞLAMA TOPLAMI ==='
-- Aynı kontrol arayüzde, içe aktarmada ve e-Faturada ayrı ayrı yazılsaydı
-- üçü de zamanla ayrışırdı. Tek yerde durduğu için burada sınanıyor.
select public.t_assert(core.tax_no_valid('4540536920') is true,
  'Geçerli VKN kabul edilir');
select public.t_assert(core.tax_no_valid('0987654321') is false,
  'Sağlama toplamı tutmayan VKN reddedilir');
select public.t_assert(core.tax_no_valid('10000000146') is true,
  'Geçerli TCKN kabul edilir');
select public.t_assert(core.tax_no_valid('10000000140') is false,
  'Son hanesi bozuk TCKN reddedilir');
select public.t_assert(core.tax_no_valid('00000000146') is false,
  'İlk hanesi sıfır olan TCKN reddedilir');
select public.t_assert(core.tax_no_valid('123') is false,
  'On/on bir hane dışındaki uzunluk reddedilir');
select public.t_assert(core.tax_no_valid('12345abcde') is false,
  'Harf içeren numara reddedilir');
-- NULL "numara yok", false "numara yanlış": ikisi farklı şeydir ve arayüz
-- ikisini aynı kırmızı rozetle gösterirse yanlış bilgi verir.
select public.t_assert(core.tax_no_valid(null) is null,
  'Numara yoksa NULL döner, false değil');
select public.t_assert(core.tax_no_valid('') is null,
  'Boş numara NULL döner');

-- Buradan sonrası RLS senaryosu DEĞİL, hesap doğruluğu sınaması: sahibi
-- rolüne dönülür. `sezra_app` altında kalsaydı test fatura yazamaz ve
-- ölçmek istediği matematiğe hiç ulaşamazdı.
reset role;

\echo ''
\echo '=== 12. CARİ ÖZETİ: BAKİYE VE AĞIRLIKLI VADE ==='
-- REGRESYON: bakiye ile vade tek koşulda toplanınca, vadesi girilmemiş bir
-- fatura BAKİYEDEN de düşüyordu. İkisi ayrı süzgeç olmalı.
do $$
declare
  v_p record;
  v_bakiye numeric;
  v_vade   date;
begin
  select id, tenant_id, branch_id into v_p from core.partners where name like 'Alfa%' limit 1;

  insert into finance.invoices (tenant_id, branch_id, kind, partner_id, issue_date, due_date,
                                status, currency, subtotal, tax_total, total, paid_total)
  values (v_p.tenant_id, v_p.branch_id, 'sale', v_p.id, current_date,
          current_date + 30, 'posted', 'TRY', 1000, 0, 1000, 0),
         (v_p.tenant_id, v_p.branch_id, 'sale', v_p.id, current_date,
          current_date + 100, 'posted', 'TRY', 9000, 0, 9000, 0),
         -- Vadesiz fatura: bakiyeye GİRMELİ, ortalama vadeye girmemeli.
         (v_p.tenant_id, v_p.branch_id, 'sale', v_p.id, current_date,
          null, 'posted', 'TRY', 500, 0, 500, 0);

  select acik_bakiye, ortalama_vade into v_bakiye, v_vade
  from core.v_partner_summary where partner_id = v_p.id;

  perform public.t_assert(v_bakiye = 10500,
    'Vadesi olmayan fatura da bakiyeye girer', v_bakiye::text);
  -- (1000*30 + 9000*100) / 10000 = 93. gün. Basit ortalama 65 olurdu.
  perform public.t_assert(v_vade - current_date = 93,
    'Ortalama vade TUTARLA ağırlıklıdır', (v_vade - current_date)::text);

  raise exception 'test-geri-al';
exception when others then
  if sqlerrm <> 'test-geri-al' then raise; end if;
end $$;

-- UYGULAMA ROLÜ ŞART: bir önceki bölüm `reset role` ile tablo sahibine
-- dönüyor ve sahip RLS'i ATLAR -- politikalar sınanmadan her satır görünür.
-- Kiracı da yok, çünkü o bölüm platform yöneticisiyle bitiyor.
set role sezra_app;
select public.t_login('22222222-2222-2222-2222-222222222222');

-- =============================================================================
-- ÇEK / SENET: durum makinesi
--
-- Geçiş kuralı ARAYÜZDE DE var (Notes.tsx) ama sınır burasıdır. Aşağıdaki
-- testler geçersiz geçişin veritabanı tarafından reddedildiğini kanıtlar;
-- arayüzdeki kopya yalnızca kullanıcıya erken geri bildirim içindir.
-- =============================================================================
do $$
declare
  v_p     core.partners;
  v_cek   finance.notes;
  v_snt   finance.notes;
  v_baska uuid;
begin
  select * into v_p from core.partners where name like 'Alfa%';

  -- Bankasız çek reddedilir; bankasız senet kabul edilir: çekin muhatabı
  -- bir bankadır, senedin değildir.
  begin
    insert into finance.notes (tenant_id, branch_id, direction, kind, partner_id,
                               issue_date, due_date, amount, currency)
    values (v_p.tenant_id, v_p.branch_id, 'in', 'cek', v_p.id,
            current_date, current_date + 30, 1000, 'TRY');
    raise exception 'BEKLENEN HATA GELMEDI';
  exception when check_violation then
    perform public.t_assert(true, 'Bankasiz cek reddedilir');
  end;

  insert into finance.notes (tenant_id, branch_id, direction, kind, partner_id,
                             issue_date, due_date, amount, currency)
  values (v_p.tenant_id, v_p.branch_id, 'in', 'senet', v_p.id,
          current_date, current_date + 30, 1000, 'TRY')
  returning * into v_snt;
  perform public.t_assert(v_snt.status = 'portfoy', 'Senet portfoyde acilir',
                          v_snt.status::text);

  -- Vade keşide tarihinden önce olamaz.
  begin
    insert into finance.notes (tenant_id, branch_id, direction, kind, partner_id,
                               issue_date, due_date, amount, currency)
    values (v_p.tenant_id, v_p.branch_id, 'in', 'senet', v_p.id,
            current_date, current_date - 1, 1000, 'TRY');
    raise exception 'BEKLENEN HATA GELMEDI';
  exception when check_violation then
    perform public.t_assert(true, 'Vade kesideden once olamaz');
  end;

  insert into finance.notes (tenant_id, branch_id, direction, kind, partner_id,
                             issue_date, due_date, amount, currency, bank_name)
  values (v_p.tenant_id, v_p.branch_id, 'in', 'cek', v_p.id,
          current_date, current_date + 45, 9500, 'TRY', 'Ziraat Bankası')
  returning * into v_cek;

  -- portföy -> tahsil edildi: geçerli.
  perform finance.note_set_status(v_cek.id, 'tahsil_edildi');
  select * into v_cek from finance.notes where id = v_cek.id;
  perform public.t_assert(v_cek.status = 'tahsil_edildi',
    'Portfoyden tahsile gecilir', v_cek.status::text);

  -- tahsil edildi -> ciro edildi: GEÇERSİZ. Tahsil edilmiş bir çek artık
  -- portföyde değildir; ciro edilemez.
  begin
    perform finance.note_set_status(v_cek.id, 'ciro_edildi');
    raise exception 'BEKLENEN HATA GELMEDI';
  exception when check_violation then
    perform public.t_assert(true, 'Tahsil edilmis cek ciro edilemez');
  end;

  -- Kendine ciro edilemez: çek bize o cariden geldi, ona geri ciro etmek
  -- kayıtta anlamsız bir döngü olurdu.
  insert into finance.notes (tenant_id, branch_id, direction, kind, partner_id,
                             issue_date, due_date, amount, currency, bank_name)
  values (v_p.tenant_id, v_p.branch_id, 'in', 'cek', v_p.id,
          current_date, current_date + 60, 2500, 'TRY', 'Ziraat Bankası')
  returning * into v_cek;
  begin
    perform finance.note_set_status(v_cek.id, 'ciro_edildi',
                                    p_endorsed_to_id => v_p.id);
    raise exception 'BEKLENEN HATA GELMEDI';
  exception when check_violation then
    perform public.t_assert(true, 'Cek geldigi cariye ciro edilemez');
  end;

  -- Verilen (out) senet ciro edilemez: bizim borcumuzdur, elimizde değildir.
  select id into v_baska from core.partners
   where id <> v_p.id and tenant_id = v_p.tenant_id limit 1;

  -- Tahsile verirken banka hesabı zorunlu: hangi bankaya verildiği
  -- yazılmazsa karşılıksız çıktığında evrakın nerede olduğu bilinmez.
  begin
    perform finance.note_set_status(v_cek.id, 'tahsile_verildi');
    raise exception 'BEKLENEN HATA GELMEDI';
  exception when not_null_violation then
    perform public.t_assert(true, 'Tahsile verirken banka hesabi zorunlu');
  end;

  insert into finance.notes (tenant_id, branch_id, direction, kind, partner_id,
                             issue_date, due_date, amount, currency)
  values (v_p.tenant_id, v_p.branch_id, 'out', 'senet', v_p.id,
          current_date, current_date + 30, 4000, 'TRY')
  returning * into v_snt;
  begin
    perform finance.note_set_status(v_snt.id, 'ciro_edildi',
                                    p_endorsed_to_id => v_baska);
    raise exception 'BEKLENEN HATA GELMEDI';
  exception when check_violation then
    perform public.t_assert(true, 'Verilen senet ciro edilemez');
  end;

  raise exception 'test-geri-al';
exception when others then
  if sqlerrm <> 'test-geri-al' then raise; end if;
end $$;

-- UYGULAMA ROLÜ ŞART: bir önceki bölüm `reset role` ile tablo sahibine
-- dönüyor ve sahip RLS'i ATLAR -- politikalar sınanmadan her satır görünür.
-- Kiracı da yok, çünkü o bölüm platform yöneticisiyle bitiyor.
set role sezra_app;
select public.t_login('22222222-2222-2222-2222-222222222222');

-- =============================================================================
-- SMS: İYS izni
--
-- Kontrol veritabanındadır çünkü 6563 sayılı kanunun ispat yükü göndericide
-- ve API'yi doğrudan çağıran bir entegrasyon arayüzü atlar.
-- =============================================================================
do $$
declare
  v_p    core.partners;
  v_msg  core.sms_messages;
begin
  select * into v_p from core.partners where name like 'Alfa%';

  perform public.t_assert(
    core.normalize_msisdn('0532 123 45 67') = '+905321234567',
    'Numara E.164 bicimine cevrilir',
    coalesce(core.normalize_msisdn('0532 123 45 67'), 'NULL'));
  perform public.t_assert(core.normalize_msisdn('0212 555 00 00') is null,
    'Sabit hat cep sayilmaz');

  -- Numarasız: engellenir ama KAYDEDİLİR.
  update core.partners set phone = null, consent_sms = false where id = v_p.id;
  select * into v_msg from core.sms_enqueue(v_p.id, null, 'deneme');
  perform public.t_assert(v_msg.status = 'blocked', 'Numarasiz mesaj engellenir',
                          v_msg.status);
  perform public.t_assert(v_msg.id is not null,
    'Engellenen mesaj yine de kaydedilir');

  -- Numara var, izin yok, TİCARİ ileti: engellenir.
  update core.partners set phone = '05321234567' where id = v_p.id;
  select * into v_msg from core.sms_enqueue(v_p.id, null, 'kampanya', true);
  perform public.t_assert(v_msg.status = 'blocked',
    'Izinsiz ticari ileti engellenir', v_msg.status::text);
  perform public.t_assert(v_msg.error like '%İYS%',
    'Engel nedeni İYS olarak yazilir', coalesce(v_msg.error, 'NULL'));

  -- Aynı cariye BİLGİLENDİRME iletisi: izin aranmaz.
  select * into v_msg from core.sms_enqueue(v_p.id, null, 'siparisiniz hazir', false);
  perform public.t_assert(v_msg.status = 'queued',
    'Bilgilendirme iletisi izin aramaz', v_msg.status::text);

  -- İzin verilince ticari ileti de geçer.
  update core.partners set consent_sms = true where id = v_p.id;
  select * into v_msg from core.sms_enqueue(v_p.id, null, 'kampanya', true);
  perform public.t_assert(v_msg.status = 'queued',
    'Izinli ticari ileti kuyruga girer', v_msg.status::text);
  perform public.t_assert(v_msg.phone = '+905321234567',
    'Kayitta numara normalize edilmis halde durur', v_msg.phone);

  raise exception 'test-geri-al';
exception when others then
  if sqlerrm <> 'test-geri-al' then raise; end if;
end $$;

-- UYGULAMA ROLÜ ŞART: bir önceki bölüm `reset role` ile tablo sahibine
-- dönüyor ve sahip RLS'i ATLAR -- politikalar sınanmadan her satır görünür.
-- Kiracı da yok, çünkü o bölüm platform yöneticisiyle bitiyor.
set role sezra_app;
select public.t_login('22222222-2222-2222-2222-222222222222');

-- =============================================================================
-- MÜŞTERİ PORTALI: kapsam yalıtımı
--
-- Portal kullanıcısının göreceği veri AYRI politikalarla tanımlıdır; yanlışlıkla
-- verilmiş bir izin bile personel ekranlarını açmamalıdır. Aşağıdaki testler
-- tam olarak bunu kanıtlar.
-- =============================================================================
do $$
declare
  v_alfa uuid; v_beta uuid; v_tok text; v_uid uuid; v_pid uuid; v_sayi integer;
begin
  select id into v_alfa from core.partners where name like 'Alfa%';
  select id into v_beta from core.partners where name like 'Beta%';

  -- İKİ CARİYE DE FATURA: pozitif ve negatif sınamanın ikisi de gerçek
  -- veriye dayansın. Yalnızca negatifi sınamak, "hiç fatura görmüyor"
  -- durumunda da geçerdi -- yalıtımı değil, boşluğu kanıtlardı.
  insert into finance.invoices (tenant_id, branch_id, kind, partner_id, issue_date,
                                due_date, status, currency, subtotal, tax_total,
                                total, paid_total)
  select p.tenant_id, p.branch_id, 'sale', p.id, current_date, current_date + 30,
         'posted', 'TRY', 1000, 200, 1200, 0
  from core.partners p where p.id in (v_alfa, v_beta);

  select token into v_tok from core.portal_invite(v_alfa, 'portal-test@alfa.test');
  perform public.t_assert(v_tok is not null and length(v_tok) > 30,
    'Davet jetonu uretilir');
  -- HAM JETON SAKLANMAZ: tablodan sızan bir satır hesap ele geçirmeye
  -- yetmemeli. Yalnızca sha256 özeti durur.
  perform public.t_assert(
    not exists (select 1 from core.portal_invitations where token_hash = v_tok),
    'Ham jeton tabloda saklanmaz');

  begin
    perform core.portal_invite(v_alfa, 'portal-test@alfa.test');
    raise exception 'BEKLENEN HATA GELMEDI';
  exception when unique_violation then
    perform public.t_assert(true, 'Ayni adrese ikinci acik davet reddedilir');
  end;

  select portal_user_id, portal_partner_id into v_uid, v_pid
    from core.portal_accept(v_tok, 'Alfa Muhasebe');
  perform public.t_assert(v_pid = v_alfa, 'Kabul dogru cariye baglar');

  begin
    perform core.portal_accept(v_tok);
    raise exception 'BEKLENEN HATA GELMEDI';
  exception when check_violation then
    perform public.t_assert(true, 'Kullanilmis davet tekrar kabul edilemez');
  end;

  -- Buradan sonrası PORTAL OTURUMU.
  perform set_config('app.user_id', v_uid::text, false);
  perform public.t_assert(core.is_portal_session(), 'Portal oturumu taninir');
  perform public.t_assert(core.current_portal_partner_id() = v_alfa,
    'Portal kapsami kendi carisidir');

  select count(*) into v_sayi from core.partners;
  perform public.t_assert(v_sayi = 1, 'Portal YALNIZCA kendi firmasini gorur',
                          v_sayi::text);
  select count(*) into v_sayi from finance.invoices where partner_id = v_beta;
  perform public.t_assert(v_sayi = 0, 'Baska carinin faturasi gorunmez',
                          v_sayi::text);
  select count(*) into v_sayi from finance.invoices;
  perform public.t_assert(v_sayi = 1, 'Kendi faturasini gorur, yalnizca onu',
                          v_sayi::text);
  select count(*) into v_sayi from hr.employees;
  perform public.t_assert(v_sayi = 0, 'Portal personel verisini gormez',
                          v_sayi::text);
  select count(*) into v_sayi from finance.notes;
  perform public.t_assert(v_sayi = 0, 'Portal cek/senet portfoyunu gormez',
                          v_sayi::text);

  -- YAZMA HİÇBİR YERDE YOK: politikalar yalnızca SELECT içindir.
  update core.partners set notes = 'portal yazdi' where id = v_alfa;
  get diagnostics v_sayi = row_count;
  perform public.t_assert(v_sayi = 0, 'Portal kendi cari kartini bile yazamaz',
                          v_sayi::text);

  raise exception 'test-geri-al';
exception when others then
  if sqlerrm <> 'test-geri-al' then raise; end if;
end $$;

-- Portal bölümü oturumu portal kullanıcısında bıraktı; geri al.
select public.t_login('22222222-2222-2222-2222-222222222222');

reset role;
drop function if exists public.t_assert(boolean, text, text);
drop function if exists public.t_login(uuid, uuid);
\echo ''
\echo '=== RLS TESTLERİ TAMAMLANDI ==='
