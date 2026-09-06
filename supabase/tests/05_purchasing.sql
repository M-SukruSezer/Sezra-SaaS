-- =============================================================================
-- Satın Alma & Tedarikçi Yönetimi testleri
-- =============================================================================
-- Kapsam: kiracı/şube izolasyonu, modül aktivasyonu, talep onay akışı,
-- kademeli fiyat, sipariş değişmezliği, fazla kabul engeli, kısmi kabul
-- muhasebesi ve mal kabul → alış faturası köprüsü.
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
select id as supplier from core.partners
 where tenant_id = :'ornek' and name = 'Epsilon Hammadde İthalat Ltd.' \gset
select id as duzce from core.branches where tenant_id = :'ornek' and code = 'MERKEZ' \gset
select id as zonguldak from core.branches where tenant_id = :'ornek' and code = 'ZONGULDAK' \gset

\echo ''
\echo '=== 1. İZOLASYON VE MODÜL AKTİVASYONU ==='
set role sezra_app;

select set_config('app.user_id', '55555555-5555-5555-5555-555555555555', false);
select public.t_assert(
  (select count(*) from purchasing.requisitions) = 0,
  'Rakip Ticaret yöneticisi Örnek Ticaret taleplerini GÖREMEZ');

-- Rakip Ticaret 'baslangic' planında: satın alma modülü kapalı
select public.t_assert(
  (select count(*) from unnest(core.permission_codes()) c where c like 'purchasing.%') = 0,
  'Satın Alma kapalı kiracıda hiçbir satın alma izni etkin değil',
  (select string_agg(c, ',') from unnest(core.permission_codes()) c where c like 'purchasing.%'));

select set_config('app.user_id', '44444444-4444-4444-4444-444444444444', false);  -- Deniz, Zonguldak
select public.t_assert(
  (select count(*) from purchasing.requisitions) = 0,
  'Zonguldak müdürü Düzce''nin talebini göremez (şube kapsamı)',
  (select count(*)::text from purchasing.requisitions));

\echo ''
\echo '=== 2. TALEP ONAY AKIŞI ==='
select set_config('app.user_id', '22222222-2222-2222-2222-222222222222', false);
select id as req from purchasing.requisitions where status = 'draft' limit 1 \gset

select public.t_assert(
  (select total from purchasing.requisitions where id = :'req') = 83628.00,
  'Talep toplamı satır trigger''larından hesaplandı (120 × 690 + %1 KDV)',
  (select total::text from purchasing.requisitions where id = :'req'));

select public.t_assert(
  public.t_raises(format('select purchasing.approve_requisition(%L)', :'req')) = '23514',
  'Gönderilmemiş (taslak) talep onaylanamaz');

select purchasing.submit_requisition(:'req') is not null as submitted \gset
select purchasing.approve_requisition(:'req') is not null as approved \gset

select public.t_assert(
  (select status from purchasing.requisitions where id = :'req') = 'approved',
  'Talep onaylandı');
select public.t_assert(
  (select number from purchasing.requisitions where id = :'req') like 'STL-%',
  'Onayda talep numarası verildi',
  (select number from purchasing.requisitions where id = :'req'));

-- Kendi talebini onaylama yasağı (İK'daki izin onayıyla aynı kural)
select public.t_assert(
  public.t_raises($q$do $x$
    declare v uuid;
    begin
      insert into purchasing.requisitions (branch_id, justification)
      values (null, 'Kendi talebim') returning id into v;
      insert into purchasing.requisition_lines (requisition_id, description, quantity, unit_price)
      values (v, 'Test', 1, 100);
      perform purchasing.submit_requisition(v);
      perform purchasing.approve_requisition(v);
    end $x$$q$) = '42501',
  'Kullanıcı kendi satın alma talebini onaylayamaz');

\echo ''
\echo '=== 3. KADEMELİ TEDARİKÇİ FİYATI ==='
select id as product from core.products where tenant_id = :'ornek' and sku = 'HAM-201' \gset

select public.t_assert(
  (select unit_price from purchasing.best_supplier_price(:'product', 50)) = 690.00,
  '50 kg için taban kademe fiyatı (690)',
  (select unit_price::text from purchasing.best_supplier_price(:'product', 50)));

select public.t_assert(
  (select unit_price from purchasing.best_supplier_price(:'product', 120)) = 640.00,
  '120 kg için 100+ kademesi devreye girer (640)',
  (select unit_price::text from purchasing.best_supplier_price(:'product', 120)));

\echo ''
\echo '=== 4. TALEPTEN SİPARİŞ ==='
select (purchasing.create_order_from_requisition(:'req', :'supplier')).id as ord \gset

select public.t_assert(
  (select status from purchasing.requisitions where id = :'req') = 'ordered',
  'Sipariş açılınca talep "sipariş edildi" oldu');

select public.t_assert(
  (select unit_price from purchasing.order_lines where order_id = :'ord') = 640.00,
  'Sipariş fiyatı GÜNCEL fiyat listesinden tazelendi (talepteki 690 değil)',
  (select unit_price::text from purchasing.order_lines where order_id = :'ord'));

select purchasing.confirm_order(:'ord') is not null as confirmed \gset
select public.t_assert(
  (select number from purchasing.orders where id = :'ord') like 'SAS-%',
  'Onayda sipariş numarası verildi');

select public.t_assert(
  public.t_raises(format(
    'update purchasing.order_lines set quantity = 999 where order_id = %L', :'ord')) = '23514',
  'Onaylanmış siparişin satırları değiştirilemez (tedarikçiye taahhüt)');

\echo ''
\echo '=== 5. KISMİ MAL KABUL ==='
select id as ol from purchasing.order_lines where order_id = :'ord' \gset

insert into purchasing.receipts (branch_id, order_id, partner_id, waybill_no)
select branch_id, :'ord', :'supplier', 'IRS-TEST-1' from purchasing.orders where id = :'ord'
returning id as rec \gset

insert into purchasing.receipt_lines (receipt_id, order_line_id, quantity, rejected_quantity, reject_reason)
values (:'rec', :'ol', 60, 5, 'Nem almış çuval');

-- Fazla kabul engeli
select public.t_assert(
  public.t_raises(format($q$
    do $x$ begin
      insert into purchasing.receipt_lines (receipt_id, order_line_id, sequence, quantity)
      values (%L, %L, 20, 200);
      perform purchasing.confirm_receipt(%L);
    end $x$$q$, :'rec', :'ol', :'rec')) = '23514',
  'Sipariş miktarını aşan mal kabul onaylanamaz');

delete from purchasing.receipt_lines where receipt_id = :'rec' and sequence = 20;

select purchasing.confirm_receipt(:'rec') is not null as received \gset

select public.t_assert(
  (select received_quantity from purchasing.order_lines where id = :'ol') = 55,
  'Kabul miktarı REDDEDİLEN düşülerek işlendi (60 geldi, 5 hasarlı -> 55)',
  (select received_quantity::text from purchasing.order_lines where id = :'ol'));

select public.t_assert(
  (select status from purchasing.orders where id = :'ord') = 'partially_received',
  'Sipariş kısmen teslim alındı durumuna geçti');

select public.t_assert(
  public.t_raises(format(
    'update purchasing.receipt_lines set quantity = 10 where receipt_id = %L', :'rec')) = '23514',
  'Onaylanmış mal kabulün satırları değiştirilemez');

\echo ''
\echo '=== 6. MAL KABUL -> ALIŞ FATURASI (olay tabanlı) ==='
reset role;

do $$
declare i int := 0;
begin
  perform core.dispatch_events(50);
  while i < 100 loop
    exit when not exists (
      select 1 from core.event_deliveries d
        join core.events e on e.id = d.event_id
       where e.topic = 'purchasing.receipt.confirmed' and d.status in ('pending', 'processing'));
    perform pg_sleep(0.1);
    i := i + 1;
  end loop;
end $$;

select public.t_assert(
  (select count(*) from core.event_deliveries d
     join core.events e on e.id = d.event_id
    where e.topic = 'purchasing.receipt.confirmed' and d.status <> 'done') = 0,
  'Mal kabul olayı hatasız işlendi',
  (select coalesce(string_agg(d.last_error, ' | '), '-') from core.event_deliveries d
     join core.events e on e.id = d.event_id
    where e.topic = 'purchasing.receipt.confirmed' and d.status <> 'done'));

set role sezra_app;
select set_config('app.user_id', '22222222-2222-2222-2222-222222222222', false);

select public.t_assert(
  (select count(*) from finance.invoices
    where source_module = 'purchasing' and source_table = 'receipts' and source_id = :'rec') = 1,
  'Mal kabulden alış faturası taslağı üretildi');

-- Fatura KABUL EDİLEN miktar üzerinden olmalı: 55 × 640 = 35.200
select public.t_assert(
  (select subtotal from finance.invoices
    where source_module = 'purchasing' and source_id = :'rec') = 35200.00,
  'Fatura matrahı kabul edilen miktar üzerinden (reddedilen 5 adet hariç)',
  (select subtotal::text from finance.invoices
    where source_module = 'purchasing' and source_id = :'rec'));

select public.t_assert(
  (select kind from finance.invoices
    where source_module = 'purchasing' and source_id = :'rec')::text = 'purchase',
  'Üretilen fatura ALIŞ faturası');

-- İdempotanlık
reset role;
select finance.on_purchase_receipt_confirmed(jsonb_build_object(
  'tenant_id', :'ornek', 'branch_id', null,
  'payload', jsonb_build_object('receipt_id', :'rec'))) as retried \gset

set role sezra_app;
select set_config('app.user_id', '22222222-2222-2222-2222-222222222222', false);
select public.t_assert(
  (select count(*) from finance.invoices
    where source_module = 'purchasing' and source_id = :'rec') = 1,
  'Olay yeniden teslim edilirse ikinci fatura oluşmaz (idempotent handler)');

\echo ''
\echo '=== 7. TEDARİKÇİ PERFORMANSI ==='
select public.t_assert(
  (select receipt_count from purchasing.v_supplier_performance
    where partner_id = :'supplier') = 1,
  'Tedarikçi performans raporu kabulü sayıyor');

select public.t_assert(
  (select rejection_pct from purchasing.v_supplier_performance
    where partner_id = :'supplier') = 8.33,
  'Ret oranı doğru hesaplandı (5/60 = %8,33)',
  (select rejection_pct::text from purchasing.v_supplier_performance
    where partner_id = :'supplier'));

select public.t_assert(
  (select count(*) from purchasing.v_open_orders where id = :'ord') = 1,
  'Kısmen teslim alınan sipariş "bekleyen teslimat" listesinde');

reset role;
