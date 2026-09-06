-- =============================================================================
-- Kalite Kontrol testleri (Faz 2)
-- =============================================================================
-- Kapsam: plan seçimi, mal kabulden otomatik muayene açılması, ölçüt anlık
-- görüntüsü, geçti/kaldı türetimi, yarım muayene engeli, uygunsuzluk ve
-- tasarruf kaydı, tamamlanmış muayenenin değişmezliği, izolasyon.
--
-- ÖN KOŞUL: 05_purchasing.sql bir mal kabul onayladı; 0603 köprüsü o olaydan
-- taslak muayene açmış olmalı.
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
select id as product from core.products where tenant_id = :'ornek' and sku = 'HAM-201' \gset

\echo ''
\echo '=== 1. MAL KABULDEN OTOMATİK MUAYENE ==='
set role sezra_app;
select set_config('app.user_id', '22222222-2222-2222-2222-222222222222', false);
select set_config('app.tenant_id', :'ornek', false);

select public.t_assert(
  (select count(*) from quality.inspections
    where source_module = 'purchasing' and source_table = 'receipts') = 1,
  'Mal kabul olayı taslak muayene açtı');

select id as insp from quality.inspections
 where source_module = 'purchasing' limit 1 \gset

select public.t_assert(
  (select status from quality.inspections where id = :'insp') = 'draft',
  'Muayene TASLAK doğdu — otomatik geçmedi');

select public.t_assert(
  (select count(*) from quality.results where inspection_id = :'insp') = 5,
  'Plandaki 5 ölçüt muayeneye kopyalandı',
  (select count(*)::text from quality.results where inspection_id = :'insp'));

-- Örnekleme: plan %10 diyor, 55 adet kabul edildi -> 5,5
select public.t_assert(
  (select sampled_quantity from quality.inspections where id = :'insp') = 5.5,
  'Örneklem miktarı plandaki yüzdeden hesaplandı (55 × %10)',
  (select sampled_quantity::text from quality.inspections where id = :'insp'));

\echo ''
\echo '=== 2. ÖLÇÜT ANLIK GÖRÜNTÜSÜ ==='
select public.t_assert(
  (select min_value from quality.results where inspection_id = :'insp' and code = 'NEM') = 9.0
  and (select max_value from quality.results where inspection_id = :'insp' and code = 'NEM') = 12.5,
  'Ölçüt limitleri sonuç satırına kopyalandı');

-- Plan değişse bile açılmış muayenenin ölçütü değişmemeli
reset role;
update quality.check_points set min_value = 50, max_value = 60
 where code = 'NEM' and plan_id = (select plan_id from quality.inspections where id = :'insp');
set role sezra_app;
select set_config('app.user_id', '22222222-2222-2222-2222-222222222222', false);

select public.t_assert(
  (select max_value from quality.results where inspection_id = :'insp' and code = 'NEM') = 12.5,
  'Plan sonradan değişti ama AÇIK muayenenin ölçütü değişmedi',
  (select max_value::text from quality.results where inspection_id = :'insp' and code = 'NEM'));

\echo ''
\echo '=== 3. YARIM MUAYENE TAMAMLANAMAZ ==='
select public.t_assert(
  public.t_raises(format('select quality.complete_inspection(%L)', :'insp')) = '23514',
  'Ölçülmemiş ölçüt varken muayene tamamlanamaz');

\echo ''
\echo '=== 4. ÖLÇÜM DEĞERLENDİRME ==='
update quality.results set numeric_value = 10.8 where inspection_id = :'insp' and code = 'NEM';
select public.t_assert(
  (select passed from quality.results where inspection_id = :'insp' and code = 'NEM'),
  'Limit içindeki sayısal ölçüm geçti (9,0 ≤ 10,8 ≤ 12,5)');

update quality.results set numeric_value = 13.4 where inspection_id = :'insp' and code = 'NEM';
select public.t_assert(
  (select passed from quality.results where inspection_id = :'insp' and code = 'NEM') = false,
  'Üst limiti aşan ölçüm kaldı');

update quality.results set numeric_value = 10.8 where inspection_id = :'insp' and code = 'NEM';
update quality.results set numeric_value = 0.4  where inspection_id = :'insp' and code = 'YBM';
update quality.results set bool_value = true    where inspection_id = :'insp' and code = 'AMB';
update quality.results set text_value = 'temiz' where inspection_id = :'insp' and code = 'KOKU';
update quality.results set text_value = 'Numune fotoğrafı arşivde'
 where inspection_id = :'insp' and code = 'NOT';

select public.t_assert(
  (select passed from quality.results where inspection_id = :'insp' and code = 'KOKU'),
  'Beklenen seçenek işaretlendiğinde geçti');

select public.t_assert(
  (select passed from quality.results where inspection_id = :'insp' and code = 'NOT'),
  'Serbest metin ölçütü doldurulunca geçmiş sayılır (değerlendirme değil, kayıt)');

\echo ''
\echo '=== 5. GEÇEN MUAYENE ==='
select quality.complete_inspection(:'insp') is not null as done \gset

select public.t_assert(
  (select status from quality.inspections where id = :'insp') = 'passed',
  'Tüm ölçütler geçince muayene GEÇTİ');

select public.t_assert(
  (select number from quality.inspections where id = :'insp') like 'KKR-%',
  'Tamamlanınca muayene numarası verildi',
  (select number from quality.inspections where id = :'insp'));

select public.t_assert(
  (select count(*) from quality.nonconformities where inspection_id = :'insp') = 0,
  'Geçen muayene uygunsuzluk açmaz');

select public.t_assert(
  public.t_raises(format(
    'update quality.results set numeric_value = 1 where inspection_id = %L', :'insp')) = '23514',
  'Tamamlanmış muayenenin ölçümleri değiştirilemez');

\echo ''
\echo '=== 6. KALAN MUAYENE VE UYGUNSUZLUK ==='
reset role;
select id as supplier from core.partners
 where tenant_id = :'ornek' and name = 'Epsilon Hammadde İthalat Ltd.' \gset
select id as duzce from core.branches where tenant_id = :'ornek' and code = 'MERKEZ' \gset

select quality.open_inspection(:'ornek', :'duzce', :'product', 200,
                               :'supplier', null, 'incoming',
                               'test', 'manual', gen_random_uuid()) as insp2 \gset

set role sezra_app;
select set_config('app.user_id', '22222222-2222-2222-2222-222222222222', false);
select set_config('app.tenant_id', :'ornek', false);

-- Kritik ölçüt kalıyor: nem çok yüksek, koku küflü
update quality.results set numeric_value = 18.2 where inspection_id = :'insp2' and code = 'NEM';
update quality.results set numeric_value = 0.2  where inspection_id = :'insp2' and code = 'YBM';
update quality.results set bool_value = true    where inspection_id = :'insp2' and code = 'AMB';
update quality.results set text_value = 'küflü' where inspection_id = :'insp2' and code = 'KOKU';
update quality.results set text_value = 'Çuvallar nemli depoda beklemiş'
 where inspection_id = :'insp2' and code = 'NOT';

select quality.complete_inspection(:'insp2') is not null as done2 \gset

select public.t_assert(
  (select status from quality.inspections where id = :'insp2') = 'failed',
  'Ölçüt kalınca muayene KALDI');

select public.t_assert(
  (select count(*) from quality.nonconformities where inspection_id = :'insp2') = 1,
  'Kalan muayene otomatik uygunsuzluk kaydı açtı');

select id as nc from quality.nonconformities where inspection_id = :'insp2' \gset

select public.t_assert(
  (select severity from quality.nonconformities where id = :'nc') = 'critical',
  'Kritik ölçüt kaldığı için uygunsuzluk KRİTİK işaretlendi',
  (select severity from quality.nonconformities where id = :'nc'));

select public.t_assert(
  (select number from quality.nonconformities where id = :'nc') like 'UYG-%',
  'Uygunsuzluk numarası verildi');

select public.t_assert(
  (select count(*) from core.events where topic = 'quality.inspection.failed') = 1,
  'quality.inspection.failed olayı yayınlandı');

\echo ''
\echo '=== 7. TASARRUF KARARI ==='
-- Gerekçesiz "sapmayla kabul" reddedilmeli
select public.t_assert(
  public.t_raises(format(
    'select quality.decide_nonconformity(%L, ''accept_with_deviation''::quality.disposition)',
    :'nc')) = '23514',
  'Sapmayla kabul gerekçesiz verilemez');

select public.t_assert(
  public.t_raises(format(
    'select quality.decide_nonconformity(%L, ''pending''::quality.disposition)', :'nc')) = '23514',
  'Tasarruf "beklemede" olarak kapatılamaz');

select quality.decide_nonconformity(
  :'nc', 'return_to_supplier'::quality.disposition,
  'Nem oranı sınırın çok üstünde, parti iade edildi',
  'Tedarikçiden nakliye sırasında nem koruması talep edilecek') is not null as decided \gset

select public.t_assert(
  (select disposition from quality.nonconformities where id = :'nc')::text = 'return_to_supplier'
  and (select closed_at from quality.nonconformities where id = :'nc') is not null,
  'Tasarruf kararı kaydedildi ve uygunsuzluk kapandı');

select public.t_assert(
  public.t_raises(format(
    'select quality.decide_nonconformity(%L, ''accept''::quality.disposition)', :'nc')) = 'P0002',
  'Kapanmış uygunsuzluk yeniden karara bağlanamaz');

\echo ''
\echo '=== 8. TEDARİKÇİ KALİTE KARNESİ ==='
select public.t_assert(
  (select inspection_count from quality.v_supplier_quality where partner_id = :'supplier') >= 1,
  'Tedarikçi kalite karnesi muayeneleri sayıyor');

select public.t_assert(
  (select critical_nc_count from quality.v_supplier_quality where partner_id = :'supplier') = 1,
  'Kritik uygunsuzluk tedarikçi karnesine işlendi');

select public.t_assert(
  (select fail_count from quality.v_failed_checks where code = 'NEM') = 1,
  'Kalan ölçüt dağılımı raporu nem sorununu gösteriyor');

\echo ''
\echo '=== 9. İZOLASYON VE YETKİ ==='
select set_config('app.user_id', '55555555-5555-5555-5555-555555555555', false);
select public.t_assert(
  (select count(*) from quality.inspections) = 0,
  'Başka kiracı Örnek Ticaret muayenelerini göremez');

-- Depo sorumlusu muayene eder ama TASARRUF KARARI VEREMEZ
select set_config('app.user_id', '22222222-2222-2222-2222-222222222222', false);
select public.t_assert(
  not exists (
    select 1 from core.role_permissions rp
    join core.roles r on r.id = rp.role_id
    where r.code = 'warehouse' and r.tenant_id is null
      and rp.permission_code = 'quality.nonconformity.decide'),
  'Depo rolünde tasarruf kararı yetkisi YOK (görevler ayrılığı)');

reset role;
