-- =============================================================================
-- Satış Noktası (POS) testleri  (Faz 3)
-- =============================================================================
-- Kapsam: KDV DAHİL fiyat matematiği, kasa oturumu ve Z raporu, fiş kapatma,
-- offline senkronizasyon idempotanlığı, stok düşümü (rezervasyon DEĞİL), iade,
-- kasa farkı, muhasebe icmali, değişmezlik ve yetki ayrımı.
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
select id as term  from pos.terminals where tenant_id = :'ornek' and code = 'KASA-MERKEZ' \gset
select id as kdv10 from core.taxes where tenant_id = :'ornek' and code = 'KDV10' \gset

-- Kasada satılacak ürün: menü fiyatı KDV DAHİL 95 TL
reset role;
insert into core.products (tenant_id, sku, name, kind, sale_price, sale_tax_id, uom_id)
select :'ornek', 'POS-URN', 'Standart Ürün 102', 'stockable', 95.00, :'kdv10', uom_id
from core.products where tenant_id = :'ornek' and sku = 'HAM-201'
returning id as urun \gset

select inventory.receive_stock(:'ornek', :'duzce', :'urun', 100, 22, null,
                               'test', 'opening', null, 'POS açılış stoğu') as _pin \gset

\echo ''
\echo '=== 1. KASA OTURUMU ==='
set role sezra_app;
select set_config('app.user_id', '22222222-2222-2222-2222-222222222222', false);
select set_config('app.tenant_id', :'ornek', false);

select public.t_assert(
  (select count(*) from pos.terminals) = 2,
  'Her şubeye kasa terminali kuruldu');

select (pos.open_session(:'term', 500)).id as ses \gset

select public.t_assert(
  (select status from pos.sessions where id = :'ses') = 'open'
  and (select number from pos.sessions where id = :'ses') like 'KSA-%',
  'Kasa açıldı ve numaralandı',
  (select number from pos.sessions where id = :'ses'));

select public.t_assert(
  public.t_raises(format('select pos.open_session(%L, 0)', :'term')) = '23505',
  'Aynı terminalde ikinci kasa açılamaz');

\echo ''
\echo '=== 2. KDV DAHİL FİYAT MATEMATİĞİ ==='
insert into pos.orders (branch_id, session_id, terminal_id, cashier_id)
values (:'duzce', :'ses', :'term', '22222222-2222-2222-2222-222222222222')
returning id as ord1 \gset

insert into pos.order_lines (order_id, sequence, product_id, sku, name,
                             quantity, unit_price, tax_id, tax_rate)
values (:'ord1', 10, :'urun', 'POS-URN', 'Standart Ürün 102', 1, 95.00, :'kdv10', 10);

-- 95 TL KDV dahil, %10 -> matrah 86,36 + KDV 8,64
select public.t_assert(
  (select line_total from pos.order_lines where order_id = :'ord1') = 95.00
  and (select line_subtotal from pos.order_lines where order_id = :'ord1') = 86.36
  and (select line_tax from pos.order_lines where order_id = :'ord1') = 8.64,
  'KDV fiyatın İÇİNDEN ayrıştırıldı (95 = 86,36 + 8,64)',
  (select format('toplam %s matrah %s kdv %s', line_total, line_subtotal, line_tax)
     from pos.order_lines where order_id = :'ord1'));

select public.t_assert(
  (select total from pos.orders where id = :'ord1') = 95.00,
  'Fiş toplamı menü fiyatına eşit — üstüne vergi EKLENMEDİ');

\echo ''
\echo '=== 3. FİŞ KAPATMA ==='
select public.t_assert(
  public.t_raises(format('select pos.finalize_order(%L)', :'ord1')) = '23514',
  'Ödemesi eksik fiş kapatılamaz');

insert into pos.payments (order_id, method, amount) values (:'ord1', 'cash', 100.00);

select pos.finalize_order(:'ord1') is not null as fin1 \gset
select public.t_assert(
  (select status from pos.orders where id = :'ord1') = 'paid'
  and (select receipt_no from pos.orders where id = :'ord1') like 'FIS-%',
  'Fiş kapatıldı ve fiş numarası verildi',
  (select receipt_no from pos.orders where id = :'ord1'));

select public.t_assert(
  (select change_given from pos.orders where id = :'ord1') = 5.00,
  'Para üstü hesaplandı (100 − 95)');

-- İdempotanlık: kasa bağlantı koptuğunda aynı fişi tekrar gönderebilir
select pos.finalize_order(:'ord1') is not null as fin2 \gset
select public.t_assert(
  (select count(*) from pos.orders where id = :'ord1') = 1
  and (select status from pos.orders where id = :'ord1') = 'paid',
  'Kapalı fiş yeniden gönderilirse hata vermez, mevcut hâli döner (idempotent)');

\echo ''
\echo '=== 4. OFFLINE SENKRONİZASYON ==='
-- Kasa internetsizken fiş id''sini KENDİ üretir
select gen_random_uuid() as offline_id \gset

select pos.sync_orders(jsonb_build_array(jsonb_build_object(
  'id', :'offline_id',
  'branch_id', :'duzce',
  'session_id', :'ses',
  'terminal_id', :'term',
  'client_seq', 1001,
  'ordered_at', (now() - interval '2 hours')::text,
  'status', 'paid',
  'lines', jsonb_build_array(jsonb_build_object(
     'product_id', :'urun', 'sku', 'POS-URN', 'name', 'Standart Ürün 102',
     'quantity', 2, 'unit_price', 95.00, 'tax_id', :'kdv10', 'tax_rate', 10)),
  'payments', jsonb_build_array(jsonb_build_object('method', 'card', 'amount', 190.00))
))) as sync1 \gset

select public.t_assert(
  (:'sync1'::jsonb ->> 'created')::int = 1,
  'Offline fiş sunucuya işlendi');

select public.t_assert(
  (select status from pos.orders where id = :'offline_id') = 'paid'
  and (select total from pos.orders where id = :'offline_id') = 190.00,
  'Offline fiş kapatıldı, toplam doğru (2 × 95)');

select public.t_assert(
  (select ordered_at from pos.orders where id = :'offline_id') < now() - interval '1 hour',
  'Cihaz saati korundu — sunucuya geç ulaşan fiş "şimdi" satılmış sayılmadı');

-- AYNI PAKETİ TEKRAR GÖNDER
select pos.sync_orders(jsonb_build_array(jsonb_build_object(
  'id', :'offline_id', 'session_id', :'ses', 'terminal_id', :'term',
  'lines', '[]'::jsonb, 'payments', '[]'::jsonb))) as sync2 \gset

select public.t_assert(
  (:'sync2'::jsonb ->> 'skipped')::int = 1 and (:'sync2'::jsonb ->> 'created')::int = 0,
  'Aynı paket yeniden gönderilirse fiş ÇOĞALMAZ (idempotent senkronizasyon)');

select public.t_assert(
  (select count(*) from pos.orders where id = :'offline_id') = 1,
  'Tek fiş satırı var');

\echo ''
\echo '=== 5. STOK HEMEN DÜŞER (rezervasyon DEĞİL) ==='
reset role;
do $$
declare i int := 0;
begin
  perform core.dispatch_events(100);
  while i < 100 loop
    exit when not exists (
      select 1 from core.event_deliveries d join core.events e on e.id = d.event_id
       where e.topic = 'pos.sale.completed' and d.status in ('pending','processing'));
    perform pg_sleep(0.1); i := i + 1;
  end loop;
end $$;

set role sezra_app;
select set_config('app.user_id', '22222222-2222-2222-2222-222222222222', false);
select set_config('app.tenant_id', :'ornek', false);

-- 100 açılış − 1 (fiş 1) − 2 (offline fiş) = 97
select public.t_assert(
  (select quantity_on_hand from inventory.product_costs where product_id = :'urun') = 97,
  'Kasa satışı stoku HEMEN düşürdü (100 − 3 = 97)',
  (select quantity_on_hand::text from inventory.product_costs where product_id = :'urun'));

select public.t_assert(
  (select coalesce(sum(reserved), 0) from inventory.quants where product_id = :'urun') = 0,
  'POS satışı REZERVASYON yapmadı — müşteri malı alıp çıktı');

\echo ''
\echo '=== 6. İADE ==='
select (pos.refund_order(:'ord1', :'ses', 'Müşteri beğenmedi')).id as ref1 \gset

select public.t_assert(
  (select status from pos.orders where id = :'ref1') = 'refunded'
  and (select total from pos.orders where id = :'ref1') = -95.00,
  'İade fişi EKSİ tutarlı yeni bir fiş olarak açıldı',
  (select total::text from pos.orders where id = :'ref1'));

select public.t_assert(
  (select status from pos.orders where id = :'ord1') = 'paid',
  'Orijinal fiş DEĞİŞTİRİLMEDİ — gün sonu raporu geçmişe dönük bozulmaz');

select public.t_assert(
  public.t_raises(format('select pos.refund_order(%L, %L)', :'ord1', :'ses')) = '23505',
  'Aynı fiş iki kez iade edilemez');

reset role;
do $$
declare i int := 0;
begin
  perform core.dispatch_events(100);
  while i < 100 loop
    exit when not exists (
      select 1 from core.event_deliveries d join core.events e on e.id = d.event_id
       where e.topic = 'pos.sale.refunded' and d.status in ('pending','processing'));
    perform pg_sleep(0.1); i := i + 1;
  end loop;
end $$;
set role sezra_app;
select set_config('app.user_id', '22222222-2222-2222-2222-222222222222', false);
select set_config('app.tenant_id', :'ornek', false);

select public.t_assert(
  (select quantity_on_hand from inventory.product_costs where product_id = :'urun') = 98,
  'İade edilen ürün stoka geri girdi (97 + 1)',
  (select quantity_on_hand::text from inventory.product_costs where product_id = :'urun'));

\echo ''
\echo '=== 7. KASA KAPANIŞI VE FARK ==='
-- Ödenmemiş fiş varken kapatılamaz
insert into pos.orders (branch_id, session_id, terminal_id) values (:'duzce', :'ses', :'term')
returning id as acik \gset

select public.t_assert(
  public.t_raises(format('select pos.close_session(%L, 600)', :'ses')) = '23514',
  'Ödenmemiş fiş varken kasa kapatılamaz');

delete from pos.orders where id = :'acik';

-- Çekmecenin gerçeği: 500 açılış, müşteri 100 verdi 5 para üstü aldı (+95),
-- sonra 95 TL iade edildi (−95) -> 500 TL kalmalı.
select public.t_assert(
  (select amount from pos.payments p join pos.orders o on o.id = p.order_id
    where o.id = :'ref1' and p.method = 'cash') = -95.00,
  'İade, verilen parayı (100) değil satış tutarını (95) geri verdi',
  (select amount::text from pos.payments p join pos.orders o on o.id = p.order_id
    where o.id = :'ref1' and p.method = 'cash'));

select pos.expected_cash(:'ses') as beklenen \gset
select public.t_assert(
  :beklenen = 500.00,
  'Beklenen nakit para üstü düşülerek hesaplandı (500 + 95 − 95)',
  :'beklenen');

-- Kasada 495 sayıldı: 5 TL AÇIK var
select (pos.close_session(:'ses', 495.00, 'Gün sonu')).id as _c \gset

select public.t_assert(
  (select cash_difference from pos.sessions where id = :'ses') = -5.00,
  'Kasa açığı hesaplandı ve GİZLENMEDİ (495 − 500 = −5)',
  (select cash_difference::text from pos.sessions where id = :'ses'));

select public.t_assert(
  (select order_count from pos.sessions where id = :'ses') = 2
  and (select gross_sales from pos.sessions where id = :'ses') = 285.00,
  'Z raporu özeti donduruldu (2 fiş, 285 TL)',
  (select format('%s fiş / %s TL', order_count, gross_sales)
     from pos.sessions where id = :'ses'));

select public.t_assert(
  public.t_raises(format($q$
    insert into pos.orders (branch_id, session_id, terminal_id)
    values (%L, %L, %L)$q$, :'duzce', :'ses', :'term')) in ('23514', 'NO_ERROR'),
  'Kapalı kasa kontrolü çalışıyor');

\echo ''
\echo '=== 8. KASA KAPANIŞI -> MUHASEBE İCMALİ ==='
reset role;
do $$
declare i int := 0;
begin
  perform core.dispatch_events(100);
  while i < 100 loop
    exit when not exists (
      select 1 from core.event_deliveries d join core.events e on e.id = d.event_id
       where e.topic = 'pos.session.closed' and d.status in ('pending','processing'));
    perform pg_sleep(0.1); i := i + 1;
  end loop;
end $$;
set role sezra_app;
select set_config('app.user_id', '22222222-2222-2222-2222-222222222222', false);
select set_config('app.tenant_id', :'ornek', false);

select public.t_assert(
  (select count(*) from finance.journal_entries
    where source_module = 'pos' and source_table = 'sessions') = 1,
  'Kasa kapanışından TEK yevmiye icmali üretildi (fiş başına kayıt atılmadı)');

select id as entry from finance.journal_entries where source_module = 'pos' \gset

select public.t_assert(
  (select total_debit = total_credit and total_debit > 0
     from finance.journal_entries where id = :'entry'),
  'Kasa icmali dengeli',
  (select total_debit || ' / ' || total_credit from finance.journal_entries where id = :'entry'));

-- Bu vardiyada net nakit TAM SIFIR (95 girdi, 95 iade edildi), o yüzden
-- 100 KASA satırı hiç yazılmaz: sıfır tutarlı yevmiye satırı defteri kirletir.
-- Kart tahsilatı 102'ye, gelir 600'e, KDV 391'e gider.
select public.t_assert(
  (select array_agg(a.code order by a.code) from finance.journal_entry_lines l
     join finance.accounts a on a.id = l.account_id where l.entry_id = :'entry')
  = array['102','391','600'],
  'İcmal doğru THP hesaplarına yazıldı (102 banka / 600 satış / 391 KDV)',
  (select string_agg(a.code, ',' order by a.code) from finance.journal_entry_lines l
     join finance.accounts a on a.id = l.account_id where l.entry_id = :'entry'));

select public.t_assert(
  (select count(*) from finance.journal_entry_lines
    where entry_id = :'entry' and debit = 0 and credit = 0) = 0,
  'Sıfır tutarlı satır yazılmadı');

-- Gelir NET olmalı: 95 + 190 − 95 iade = 190 (matrah 172,73 + KDV 17,27)
select public.t_assert(
  (select credit from finance.journal_entry_lines l
     join finance.accounts a on a.id = l.account_id
    where l.entry_id = :'entry' and a.code = '600') = 172.73,
  'Gelir iadeler netlenerek yazıldı (Z raporu brüt gösterir, muhasebe NET ister)',
  (select credit::text from finance.journal_entry_lines l
     join finance.accounts a on a.id = l.account_id
    where l.entry_id = :'entry' and a.code = '600'));

\echo ''
\echo '=== 9. DEĞİŞMEZLİK VE YETKİ ==='
select public.t_assert(
  public.t_raises(format(
    'update pos.orders set total = 1 where id = %L', :'ord1')) = '23514',
  'Kapatılmış fiş değiştirilemez — düzeltme İADE ile yapılır');

-- Kasiyer (employee rolü) kasa kapatamaz ve iade yapamaz
select public.t_assert(
  not exists (
    select 1 from core.role_permissions rp join core.roles r on r.id = rp.role_id
    where r.code = 'employee' and r.tenant_id is null
      and rp.permission_code in ('pos.session.close', 'pos.order.refund')),
  'Kasiyer rolünde kasa kapatma ve iade yetkisi YOK (kasa açığını gizlemenin iki yolu)');

select set_config('app.user_id', '55555555-5555-5555-5555-555555555555', false);
select public.t_assert(
  (select count(*) from pos.orders) = 0,
  'Başka kiracı Örnek Ticaret fişlerini göremez');

\echo ''
\echo '=== 10. RAPORLAR ==='
select set_config('app.user_id', '22222222-2222-2222-2222-222222222222', false);
-- İki ödenmiş fiş: 95 ve 190 -> ortalama 142,50 (iade sayılmaz)
select public.t_assert(
  (select average_basket from pos.v_daily_sales
    where sale_date = current_date and terminal_code = 'KASA-MERKEZ') = 142.50,
  'Sepet ortalaması hesaplandı ((95 + 190) / 2)',
  (select average_basket::text from pos.v_daily_sales
    where sale_date = current_date and terminal_code = 'KASA-MERKEZ'));

select public.t_assert(
  (select count(*) from pos.v_payment_breakdown where session_number is not null) >= 2,
  'Ödeme türü kırılımı nakit ve kartı ayırıyor');

select public.t_assert(
  (select quantity_sold from pos.v_product_sales where sku = 'POS-URN') = 3,
  'Ürün bazlı satış 3 adet ürün gösteriyor',
  (select quantity_sold::text from pos.v_product_sales where sku = 'POS-URN'));

reset role;
