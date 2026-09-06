-- =============================================================================
-- Envanter & Stok testleri (Faz 2)
-- =============================================================================
-- Kapsam: kurulum, olaydan stok girişi, hareketli ortalama maliyet, rezervasyon
-- modeli, negatif stok engeli, defter değişmezliği, sayım, FEFO, maliyet
-- gizliliği ve minimum seviye uyarısı.
--
-- ÖN KOŞUL: 05_purchasing.sql, 55 adet HAM-201'i 640 TL'den mal kabul etti ve
-- olayı işledi. Bu dosya o stoğun üzerine kurulur — modüller arası zincirin
-- gerçekten çalıştığını göstermenin en dolaysız yolu bu.
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
select id as duzce from core.branches where tenant_id = :'ornek' and code = 'MERKEZ' \gset
select id as product from core.products where tenant_id = :'ornek' and sku = 'HAM-201' \gset

\echo ''
\echo '=== 1. KURULUM ==='
set role sezra_app;
select set_config('app.user_id', '22222222-2222-2222-2222-222222222222', false);
select set_config('app.tenant_id', :'ornek', false);

select public.t_assert(
  (select count(*) from inventory.warehouses) = 2,
  'Her şube için bir depo kuruldu (Düzce + Zonguldak)',
  (select count(*)::text from inventory.warehouses));

select public.t_assert(
  (select count(*) from inventory.locations where kind = 'stock') = 2
  and (select count(*) from inventory.locations where kind = 'scrap') = 2,
  'Her depoda stok ve fire konumu var');

\echo ''
\echo '=== 2. MAL KABULDEN OTOMATİK STOK GİRİŞİ ==='
-- 05_purchasing: 60 geldi, 5 hasarlı -> 55 kabul, birim 640.
-- Toplam stok DEĞİL, mal kabulden doğan HAREKET sınanıyor: demo veri açılış
-- stoğu da ekliyor ve mutlak toplama bakmak testi tohum verisine bağlardı.
select public.t_assert(
  (select quantity from inventory.moves
    where source_module = 'purchasing' and source_table = 'receipts' and state = 'done') = 55,
  'Mal kabul olayı stoka 55 adet girdi (reddedilen 5 hariç)',
  (select coalesce(sum(quantity),0)::text from inventory.moves
    where source_module = 'purchasing' and source_table = 'receipts'));

select public.t_assert(
  (select unit_cost from inventory.moves
    where source_module = 'purchasing' and source_table = 'receipts' and state = 'done') = 640.0000,
  'Giriş maliyeti fiili alış fiyatı (640)');

select public.t_assert(
  (select count(*) from inventory.moves
    where source_module = 'purchasing' and source_table = 'receipts' and state = 'done') = 1,
  'Girişin kaynağı mal kabul belgesine bağlı');

\echo ''
\echo '=== 3. HAREKETLİ ORTALAMA MALİYET ==='
-- Maliyet matematiği KENDİ ürünüyle sınanır: sıfırdan başlayan bilinen girdiler,
-- demo verisi değiştiğinde kırılmayan sabit bir beklenti verir.
reset role;
insert into core.products (tenant_id, sku, name, kind, uom_id)
select :'ornek', 'TEST-MALIYET', 'Maliyet testi ürünü', 'stockable', uom_id
from core.products where tenant_id = :'ornek' and sku = 'HAM-201'
returning id as tprod \gset

select inventory.receive_stock(:'ornek', :'duzce', :'tprod', 55, 640, null,
                               'test', 'manual', null, 'birinci alış') as m1 \gset
select inventory.receive_stock(:'ornek', :'duzce', :'tprod', 45, 800, null,
                               'test', 'manual', null, 'ikinci alış') as m2 \gset
set role sezra_app;
select set_config('app.user_id', '22222222-2222-2222-2222-222222222222', false);

-- (55×640 + 45×800) / 100 = (35.200 + 36.000) / 100 = 712
select public.t_assert(
  (select average_cost from inventory.product_costs where product_id = :'tprod') = 712.0000,
  'İki farklı fiyattan giriş sonrası ortalama 712 ((55×640 + 45×800) / 100)',
  (select average_cost::text from inventory.product_costs where product_id = :'tprod'));

select public.t_assert(
  (select total_value from inventory.product_costs where product_id = :'tprod') = 71200.00,
  'Stok değeri 71.200 TL');

\echo ''
\echo '=== 4. REZERVASYON MODELİ (satış siparişi onayı) ==='
-- 02_crm_flow onaylanmış siparişi bıraktı; envanter onu stoktan DÜŞMEDİ, ayırdı.
select public.t_assert(
  (select count(*) from inventory.moves
    where source_module = 'crm' and source_table = 'sale_orders'
      and state = 'draft' and reserves_stock) > 0,
  'Satış siparişi onayı stok DÜŞÜRMEDİ, taslak rezervasyon hareketi açtı');

select public.t_assert(
  (select sum(reserved) from inventory.quants) > 0,
  'Bakiyede ayrılan miktar görünüyor',
  (select coalesce(sum(reserved),0)::text from inventory.quants));

-- Stok yetmeyen rezervasyon olay yayınlamalı ama hata vermemeli
select public.t_assert(
  (select count(*) from core.events where topic = 'inventory.stock.shortage') > 0,
  'Yetersiz stokta rezervasyon hata vermez, eksik OLAY olarak duyurulur');

\echo ''
\echo '=== 5. SEVKİYAT: rezervasyon -> fiili çıkış ==='
reset role;
select inventory.reserve_stock(:'ornek', :'duzce', :'tprod', 10,
                               'test', 'shipment', gen_random_uuid(), 'sevk testi') as rmove \gset
select source_id as ship_src from inventory.moves where id = :'rmove' \gset

select inventory.ship_reservation('test', 'shipment', :'ship_src') as shipped \gset

set role sezra_app;
select set_config('app.user_id', '22222222-2222-2222-2222-222222222222', false);

select public.t_assert(
  (select state from inventory.moves where id = :'rmove') = 'done',
  'Sevkiyatta rezervasyon hareketi işlendi');

select public.t_assert(
  (select unit_cost from inventory.moves where id = :'rmove') = 712.0000,
  'Çıkış maliyeti o anki hareketli ortalama (712)',
  (select unit_cost::text from inventory.moves where id = :'rmove'));

select public.t_assert(
  (select quantity_on_hand from inventory.product_costs where product_id = :'tprod') = 90,
  '10 adet çıkınca eldeki miktar 90 (100 - 10)',
  (select quantity_on_hand::text from inventory.product_costs where product_id = :'tprod'));

\echo ''
\echo '=== 6. DEFTERİN DEĞİŞMEZLİĞİ ==='
select public.t_assert(
  public.t_raises(format(
    'update inventory.moves set quantity = 999 where id = %L', :'rmove')) = '23514',
  'İşlenmiş stok hareketi değiştirilemez');

select public.t_assert(
  public.t_raises(format(
    'delete from inventory.moves where id = %L', :'rmove')) = '23514',
  'İşlenmiş stok hareketi silinemez');

-- Bakiye tablosu uygulama rolünce yazılamaz (RLS'e EK tablo yetkisi kısıtı)
select public.t_assert(
  public.t_raises('update inventory.quants set quantity = 1') = '42501',
  'inventory.quants doğrudan değiştirilemez — tek yol stok hareketi');

\echo ''
\echo '=== 7. NEGATİF STOK ENGELİ ==='
reset role;
select public.t_assert(
  public.t_raises(format(
    'select inventory.deliver_stock(%L, %L, %L, 10000, ''test'', ''overdraw'', null, ''fazla çıkış'')',
    :'ornek', :'duzce', :'tprod')) = '23514',
  'Olmayan stok sevk edilemez (negatif bakiye engeli)');

\echo ''
\echo '=== 8. FEFO — önce SKT''si yakın lot ==='
select id as loc from inventory.locations
 where tenant_id = :'ornek' and kind = 'stock' limit 1 \gset

insert into inventory.lots (tenant_id, product_id, code, expiry_date) values
  (:'ornek', :'product', 'LOT-UZAK', current_date + 180),
  (:'ornek', :'product', 'LOT-YAKIN', current_date + 10);

select id as lot_uzak  from inventory.lots where code = 'LOT-UZAK' \gset
select id as lot_yakin from inventory.lots where code = 'LOT-YAKIN' \gset

select inventory.adjust_quant(:'ornek', :'loc', :'product', :'lot_uzak', 20) as q1 \gset
select inventory.adjust_quant(:'ornek', :'loc', :'product', :'lot_yakin', 20) as q2 \gset

select public.t_assert(
  inventory.pick_lot(:'product', :'loc', 5) = :'lot_yakin',
  'FEFO: son kullanma tarihi yakın lot önce seçilir');

set role sezra_app;
select set_config('app.user_id', '22222222-2222-2222-2222-222222222222', false);
select public.t_assert(
  (select urgency from inventory.v_expiring_stock where lot_id = :'lot_yakin') = 'yaklaşıyor',
  'SKT raporu yaklaşan lotu işaretliyor',
  (select urgency from inventory.v_expiring_stock where lot_id = :'lot_yakin'));

\echo ''
\echo '=== 9. SAYIM FARKI ==='
select id as wh from inventory.warehouses where branch_id = :'duzce' \gset
select (select sum(quantity) from inventory.quants where location_id = :'loc'
          and product_id = :'product') as sys_qty \gset

insert into inventory.counts (branch_id, warehouse_id, notes)
values (:'duzce', :'wh', 'Yıl sonu sayımı') returning id as cnt \gset

-- Sistemde X var, sayımda 3 eksik çıktı
insert into inventory.count_lines (count_id, location_id, product_id, system_quantity, counted_quantity)
values (:'cnt', :'loc', :'product', :sys_qty, :sys_qty - 3);

select purchasing.best_supplier_price(:'product', 1) is not null as _ \gset
select inventory.apply_count(:'cnt') is not null as applied \gset

select public.t_assert(
  (select status from inventory.counts where id = :'cnt') = 'applied',
  'Sayım uygulandı ve numaralandı');

select public.t_assert(
  (select count(*) from inventory.moves
    where source_module = 'inventory' and source_table = 'counts' and source_id = :'cnt') = 1,
  'Sayım farkı için düzeltme HAREKETİ üretildi (bakiye elle değiştirilmedi)');

select public.t_assert(
  (select sum(quantity) from inventory.quants
    where location_id = :'loc' and product_id = :'product') = :sys_qty - 3,
  'Sayım sonrası bakiye sayılan miktara eşit');

\echo ''
\echo '=== 10. MİNİMUM SEVİYE UYARISI ==='
reset role;
-- Kural test ürününe kurulur: tohum verisi seed ürünü için zaten bir kural
-- tanımlıyor ve aynı ürüne ikinci kural benzersizlik kısıtına takılır.
insert into inventory.reorder_rules (tenant_id, branch_id, product_id, min_quantity, max_quantity)
values (:'ornek', :'duzce', :'tprod', 100000, 120000);

select inventory.check_reorder_levels() as alerts \gset
select public.t_assert(
  :alerts >= 1,
  'Minimum seviyenin altındaki ürün için uyarı olayı yayınlandı',
  :'alerts');

select public.t_assert(
  (select count(*) from core.events where topic = 'inventory.stock.low') >= 1,
  'inventory.stock.low olayı kuyruğa girdi');

-- Sessizlik penceresi: hemen tekrar çalıştırınca aynı uyarı yinelenmez
select inventory.check_reorder_levels() as alerts2 \gset
select public.t_assert(
  :alerts2 = 0,
  'Aynı uyarı sessizlik penceresi içinde tekrarlanmaz');

\echo ''
\echo '=== 11. İZOLASYON VE MALİYET GİZLİLİĞİ ==='
set role sezra_app;

select set_config('app.user_id', '55555555-5555-5555-5555-555555555555', false);
select public.t_assert(
  (select count(*) from inventory.quants) = 0,
  'Başka kiracı Örnek Ticaret stoğunu göremez');

-- Satış temsilcisi: adet görür, MALİYET görmez
select set_config('app.user_id', '33333333-3333-3333-3333-333333333333', false);
select set_config('app.tenant_id', :'ornek', false);
select public.t_assert(
  (select count(*) from inventory.quants) > 0,
  'Satış temsilcisi stok adedini görebilir');
select public.t_assert(
  (select count(*) from inventory.product_costs) = 0,
  'Satış temsilcisi maliyeti GÖREMEZ (marj ticari sırdır)',
  (select count(*)::text from inventory.product_costs));

-- Muhasebe: değerleme bilanço kalemi, maliyeti görmeli
select set_config('app.user_id', '22222222-2222-2222-2222-222222222222', false);
select public.t_assert(
  (select total_value from inventory.v_stock_valuation) > 0,
  'Şirket yöneticisi stok değerlemesini görür');

reset role;

\echo ''
\echo '=== 12. BARKOD ==='
set role sezra_app;
select set_config('app.user_id', '22222222-2222-2222-2222-222222222222', false);
select set_config('app.tenant_id', :'ornek', false);

select public.t_assert(
  (select product_id from inventory.resolve_barcode('8690504000013')) = :'product',
  'Tekli barkod doğru ürüne çözümlendi');

select public.t_assert(
  (select multiplier from inventory.resolve_barcode('KOLI-CKR1-12')) = 12,
  'Koli barkodu 12 adet çarpanı taşıyor',
  (select multiplier::text from inventory.resolve_barcode('KOLI-CKR1-12')));

select public.t_assert(
  (select count(*) from inventory.resolve_barcode('YOK-BOYLE-BARKOD')) = 0,
  'Tanınmayan barkod boş döner');

-- core.products.barcode'daki mevcut barkodlar da çözümlenmeli (geriye dönük uyum)
select public.t_assert(
  public.t_raises($q$
    do $x$
    declare v uuid; n int;
    begin
      select id into v from core.products where sku = 'URN-101';
      update core.products set barcode = 'ESKI-KATALOG-KOD' where id = v;
      select count(*) into n from inventory.resolve_barcode('ESKI-KATALOG-KOD');
      if n <> 1 then raise exception 'katalog barkodu çözümlenmedi'; end if;
    end $x$$q$) = 'NO_ERROR',
  'core.products.barcode''daki mevcut kodlar da çözümlenir');

-- GTIN kontrol hanesi
select public.t_assert(
  public.t_raises(format($q$
    insert into inventory.barcodes (tenant_id, product_id, code, is_gtin)
    values (%L, %L, '8690504000014', true)$q$, :'ornek', :'product')) = '23514',
  'Bozuk GTIN kontrol hanesi reddedilir');

select public.t_assert(
  public.t_raises(format($q$
    insert into inventory.barcodes (tenant_id, product_id, code, is_gtin)
    values (%L, %L, 'ISLETME-IC-KODU-42', false)$q$, :'ornek', :'product')) = 'NO_ERROR',
  'GTIN olmayan iç kod kabul edilir (is_gtin = false)');

-- Aynı barkod iki ürüne bağlanamaz
select public.t_assert(
  public.t_raises(format($q$
    insert into inventory.barcodes (tenant_id, product_id, code)
    select %L, id, '8690504000013' from core.products where sku = 'URN-101'$q$,
    :'ornek')) = '23505',
  'Bir barkod kiracı içinde tek ürünü gösterebilir');

\echo ''
\echo '=== 13. OKUTARAK SAYIM ==='
insert into inventory.counts (branch_id, warehouse_id, notes)
values (:'duzce', :'wh', 'Barkodla sayım') returning id as scnt \gset

select inventory.scan_to_count(:'scnt', '8690504000013', 3) is not null as s1 \gset
select inventory.scan_to_count(:'scnt', 'KOLI-CKR1-12', 2) is not null as s2 \gset

-- 3 tekli + 2 koli × 12 = 27
select public.t_assert(
  (select counted_quantity from inventory.count_lines
    where count_id = :'scnt' and product_id = :'product') = 27,
  'Okutmalar birikiyor ve koli çarpanı uygulanıyor (3 + 2×12 = 27)',
  (select counted_quantity::text from inventory.count_lines
    where count_id = :'scnt' and product_id = :'product'));

select public.t_assert(
  (select count(*) from inventory.count_lines where count_id = :'scnt') = 1,
  'Aynı ürünün ikinci okutması yeni satır açmaz, mevcut satırı artırır');

select public.t_assert(
  public.t_raises(format(
    'select inventory.scan_to_count(%L, ''YOK-BOYLE'', 1)', :'scnt')) = 'P0002',
  'Tanınmayan barkod okutulduğunda anlaşılır hata verir');

reset role;
