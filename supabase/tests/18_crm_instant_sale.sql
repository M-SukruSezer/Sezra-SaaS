-- =============================================================================
-- 18 -- CRM "aninda satis" belge tipi (T-034 / FAZ 3.1)
-- =============================================================================
-- Kanit odakli: hibrit atomik satis TEK transaction'da stok + cari + fatura
-- islemeli; herhangi bir adim patlarsa HICBIR SEY yazilmamali.
--
-- 1. ATOMIKLIK (yetersiz stok): confirm patlar -> ne fatura, ne stok hareketi,
--    ne alacak, belge hala 'draft'.  (islemin bolunmezligini kanitlar)
-- 2. MUTLU YOL (vadeli): stok tam dususte, fatura muhasebelesir, 120 ALICILAR
--    borclanir -- hepsi TEK cagride.
-- 3. MUTLU YOL (pesin): ayni transaction'da tahsilat da kapanir.
-- 4. KURALLAR: cift onay, iptal (silme yok), satir kilidi.
-- 5. REGRESYON: mevcut crm.confirm_sale_order akisi bozulmadi.
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

select id as ornek   from core.tenants  where slug = 'ornek-ticaret' \gset
select id as merkez  from core.branches where tenant_id = :'ornek' and code = 'MERKEZ' \gset

-- ---------------------------------------------------------------------------
-- KURULUM (owner): temiz bir stoklu urun + 20 adet acilis stogu.
-- ---------------------------------------------------------------------------
reset role;
insert into core.products (tenant_id, sku, name, kind, uom_id, sale_price, sale_tax_id, is_active)
select :'ornek', 'TST-INSTANT', 'Aninda satis test urunu', 'stockable',
       (select id from core.uoms  where tenant_id = :'ornek' and code = 'ADET'),
       100.00,
       (select id from core.taxes where tenant_id = :'ornek' and code = 'KDV10'),
       true
returning id as prod \gset

select inventory.receive_stock(:'ornek', :'merkez', :'prod', 20, 60.00, null,
       'test', 'instant_sale_setup', null, 'Aninda satis testi acilis stogu');

select id as alfa from core.partners
 where tenant_id = :'ornek' and name = 'Alfa Sanayi Ltd. Şti.' \gset

set role sezra_app;
select set_config('app.user_id', '22222222-2222-2222-2222-222222222222', false);  -- Merve, tenant_admin
select set_config('app.tenant_id', :'ornek', false);

select quantity as stok0 from inventory.quants q
 where q.tenant_id = :'ornek' and q.product_id = :'prod' \gset
select public.t_assert(:'stok0'::numeric = 20, 'Kurulum: 20 adet stok var', :'stok0');

\echo ''
\echo '=== 1. ATOMIKLIK -- yetersiz stokta HICBIR SEY yazilmaz ==='

insert into crm.instant_sales (tenant_id, branch_id, partner_id, sale_date)
values (:'ornek', :'merkez', :'alfa', current_date)
returning id as sale_fail \gset

insert into crm.instant_sale_lines (tenant_id, instant_sale_id, sequence, product_id,
       description, quantity, uom_id, unit_price, tax_id)
select :'ornek', :'sale_fail', 10, :'prod', 'Fazla miktar', 50,
       (select id from core.uoms  where tenant_id = :'ornek' and code = 'ADET'),
       100.00,
       (select id from core.taxes where tenant_id = :'ornek' and code = 'KDV10');

select public.t_assert(
  public.t_raises(format('select crm.confirm_instant_sale(%L)', :'sale_fail')) = '23514',
  'Yetersiz stokta confirm 23514 ile reddedilir');

select public.t_assert(
  (select status from crm.instant_sales where id = :'sale_fail') = 'draft'
  and (select number from crm.instant_sales where id = :'sale_fail') is null,
  'Basarisiz onay sonrasi belge hala taslak, numara verilmemis');

select public.t_assert(
  not exists (select 1 from finance.invoices
              where source_module = 'crm' and source_table = 'instant_sales'
                and source_id = :'sale_fail'),
  'Basarisiz onay fatura BIRAKMADI (rollback)');

select public.t_assert(
  not exists (select 1 from inventory.moves
              where source_module = 'crm' and source_table = 'instant_sales'
                and source_id = :'sale_fail'),
  'Basarisiz onay stok hareketi BIRAKMADI (rollback)');

select public.t_assert(
  (select quantity from inventory.quants where tenant_id = :'ornek' and product_id = :'prod') = 20,
  'Stok bakiyesi degismedi (hala 20)');

\echo ''
\echo '=== 2. MUTLU YOL (vadeli) -- stok + fatura + cari alacak tek cagride ==='

insert into crm.instant_sales (tenant_id, branch_id, partner_id, sale_date)
values (:'ornek', :'merkez', :'alfa', current_date)
returning id as sale_ok \gset

insert into crm.instant_sale_lines (tenant_id, instant_sale_id, sequence, product_id,
       description, quantity, uom_id, unit_price, tax_id)
select :'ornek', :'sale_ok', 10, :'prod', 'Standart satir', 5,
       (select id from core.uoms  where tenant_id = :'ornek' and code = 'ADET'),
       100.00,
       (select id from core.taxes where tenant_id = :'ornek' and code = 'KDV10');

select total as beklenen_total from crm.instant_sales where id = :'sale_ok' \gset
select public.t_assert(:'beklenen_total'::numeric = 550.00,
  'Satir matematigi: 5 x 100 + %10 KDV = 550,00', :'beklenen_total');

select invoice_id as inv_ok, status as st_ok, number as no_ok
  from crm.confirm_instant_sale(:'sale_ok') \gset

select public.t_assert(:'st_ok' = 'confirmed', 'Belge durumu confirmed', :'st_ok');
select public.t_assert(:'no_ok' like 'ASF-%', 'Belge numarasi ASF- serisinden', :'no_ok');
select public.t_assert(:'inv_ok' is not null and :'inv_ok' <> '',
  'Belge faturaya baglandi (invoice_id dolu)');

select status as inv_status, kind as inv_kind, total as inv_total,
       subtotal as inv_sub, tax_total as inv_tax
  from finance.invoices where id = :'inv_ok' \gset
select public.t_assert(:'inv_status' = 'posted', 'Fatura ANINDA muhasebelesti (posted)', :'inv_status');
select public.t_assert(:'inv_kind' = 'sale' and :'inv_total'::numeric = 550.00
  and :'inv_sub'::numeric = 500.00 and :'inv_tax'::numeric = 50.00,
  'Fatura tutarlari dogru (500 + 50 KDV = 550)');

select public.t_assert(
  (select coalesce(sum(jel.debit), 0)
     from finance.journal_entries je
     join finance.journal_entry_lines jel on jel.entry_id = je.id
     join finance.accounts a on a.id = jel.account_id
    where je.source_table = 'invoices' and je.source_id = :'inv_ok'
      and a.code = '120') = 550.00,
  '120 ALICILAR 550,00 borclandi -- cari alacak yapisal olarak dogdu');

select public.t_assert(
  (select quantity from inventory.quants where tenant_id = :'ornek' and product_id = :'prod') = 15,
  'Stok 20 -> 15 (5 adet ANINDA dustu, rezerve degil)');

select public.t_assert(
  exists (select 1 from inventory.moves
          where source_module = 'crm' and source_table = 'instant_sales'
            and source_id = :'sale_ok' and state = 'done'
            and from_location_id is not null and to_location_id is null),
  'Stok hareketi ISLENMIS cikis (state=done)');

select public.t_assert(
  (select paid_total from crm.instant_sales where id = :'sale_ok') = 0
  and (select payment_method from crm.instant_sales where id = :'sale_ok') = 'none',
  'Vadeli satis: tahsilat yok, payment_method none');

\echo ''
\echo '=== 3. MUTLU YOL (pesin) -- tahsilat ayni transaction''da kapanir ==='

insert into crm.instant_sales (tenant_id, branch_id, partner_id, sale_date)
values (:'ornek', :'merkez', :'alfa', current_date)
returning id as sale_cash \gset

insert into crm.instant_sale_lines (tenant_id, instant_sale_id, sequence, product_id,
       description, quantity, uom_id, unit_price, tax_id)
select :'ornek', :'sale_cash', 10, :'prod', 'Pesin satir', 3,
       (select id from core.uoms  where tenant_id = :'ornek' and code = 'ADET'),
       100.00,
       (select id from core.taxes where tenant_id = :'ornek' and code = 'KDV10');

select invoice_id as inv_cash from crm.confirm_instant_sale(:'sale_cash', true, 'cash') \gset

select public.t_assert(
  (select status from finance.invoices where id = :'inv_cash') = 'paid',
  'Pesin satis: fatura tamamen odendi (paid)');
select public.t_assert(
  (select paid_total from crm.instant_sales where id = :'sale_cash') = 330.00
  and (select payment_method from crm.instant_sales where id = :'sale_cash') = 'cash',
  'Belge paid_total 330,00 ve payment_method cash');
select public.t_assert(
  exists (select 1 from finance.payments p
          join finance.payment_allocations pa on pa.payment_id = p.id
          where pa.invoice_id = :'inv_cash' and p.direction = 'in'
            and p.status = 'posted' and p.amount = 330.00),
  'Muhasebelesmis tahsilat kaydi olustu (yon in, 330,00)');
select public.t_assert(
  (select quantity from inventory.quants where tenant_id = :'ornek' and product_id = :'prod') = 12,
  'Stok 15 -> 12 (pesin satista da 3 adet dustu)');

\echo ''
\echo '=== 4. KURALLAR -- cift onay, iptal (silme yok), satir kilidi ==='

select public.t_assert(
  public.t_raises(format('select crm.confirm_instant_sale(%L)', :'sale_ok')) = '23514',
  'Onaylanmis belge yeniden onaylanamaz');

select public.t_assert(
  public.t_raises(format('select crm.cancel_instant_sale(%L, ''deneme'')', :'sale_ok')) = '23514',
  'Onaylanmis belge iptal edilemez (iade fisi gerekir)');

select public.t_assert(
  public.t_raises(format(
    'update crm.instant_sale_lines set quantity = 9 where instant_sale_id = %L', :'sale_ok')) = '23514',
  'Onaylanmis belgenin satirlari degistirilemez (kilit)');

insert into crm.instant_sales (tenant_id, branch_id, partner_id)
values (:'ornek', :'merkez', :'alfa')
returning id as sale_draft \gset

select status as cst from crm.cancel_instant_sale(:'sale_draft', 'vazgecildi') \gset
select public.t_assert(:'cst' = 'cancelled', 'Taslak belge iptal edilebilir (durum degisir, silinmez)');
select public.t_assert(
  exists (select 1 from crm.instant_sales where id = :'sale_draft'),
  'Iptal edilen belge FIZIKSEL olarak duruyor (silme yok)');
select public.t_assert(
  public.t_raises(format('select crm.confirm_instant_sale(%L)', :'sale_draft')) = '23514',
  'Iptal edilmis belge onaylanamaz');

\echo ''
\echo '=== 5. YETKI -- confirm izni olmayan rol reddedilir ==='

-- Ali (33333333) sadece 'sales' rolunde: crm.instant_sale.confirm YOK.
insert into crm.instant_sales (tenant_id, branch_id, partner_id, owner_id)
values (:'ornek', :'merkez', :'alfa', '33333333-3333-3333-3333-333333333333')
returning id as sale_perm \gset
insert into crm.instant_sale_lines (tenant_id, instant_sale_id, sequence, product_id,
       description, quantity, uom_id, unit_price, tax_id)
select :'ornek', :'sale_perm', 10, :'prod', 'Yetki testi', 1,
       (select id from core.uoms  where tenant_id = :'ornek' and code = 'ADET'),
       100.00,
       (select id from core.taxes where tenant_id = :'ornek' and code = 'KDV10');

select set_config('app.user_id', '33333333-3333-3333-3333-333333333333', false);
select public.t_assert(
  public.t_raises(format('select crm.confirm_instant_sale(%L)', :'sale_perm')) = '42501',
  'crm.instant_sale.confirm izni olmayan rol confirm cagiramaz (42501)');
select set_config('app.user_id', '22222222-2222-2222-2222-222222222222', false);

\echo ''
\echo '=== 6. REGRESYON -- mevcut crm.confirm_sale_order akisi bozulmadi ==='

insert into crm.sale_orders (tenant_id, branch_id, partner_id, order_date)
values (:'ornek', :'merkez', :'alfa', current_date)
returning id as so_reg \gset
insert into crm.sale_order_lines (tenant_id, sale_order_id, sequence, product_id,
       description, quantity, uom_id, unit_price, tax_id)
select :'ornek', :'so_reg', 10, :'prod', 'Regresyon satir', 2,
       (select id from core.uoms  where tenant_id = :'ornek' and code = 'ADET'),
       100.00,
       (select id from core.taxes where tenant_id = :'ornek' and code = 'KDV10');

select status as so_status from crm.confirm_sale_order(:'so_reg') \gset
select public.t_assert(:'so_status' = 'confirmed',
  'crm.confirm_sale_order hala calisiyor (siparis confirmed)');
select public.t_assert(
  not exists (select 1 from finance.invoices
              where source_table = 'sale_orders' and source_id = :'so_reg'),
  'Siparis onayi SENKRON fatura URETMEZ (eski akis: olayla asenkron) -- degismedi');
select public.t_assert(
  (select quantity from inventory.quants where tenant_id = :'ornek' and product_id = :'prod') = 12,
  'Siparis onayi stogu ANINDA dusurmez (eski akis: rezervasyon) -- degismedi');

\echo ''
\echo 'PASS  18_crm_instant_sale tamam'
