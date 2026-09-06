-- =============================================================================
-- Muhasebe & Finans testleri
-- =============================================================================
-- 02_crm_flow.sql'in bıraktığı durumdan devam eder: onaylanmış bir satış
-- siparişi ve kuyrukta bekleyen bir sales.order.confirmed olayı var.
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
begin
  execute p_sql;
  return 'NO_ERROR';
exception when others then
  return sqlstate;
end $$;

create or replace function public.t_error(p_sql text)
returns text language plpgsql as $$
begin
  execute p_sql;
  return 'NO_ERROR';
exception when others then
  return sqlerrm;
end $$;

set role sezra_app;
select set_config('app.user_id', '22222222-2222-2222-2222-222222222222', false);
select set_config('app.tenant_id', '', false);
select set_config('app.support_mode', 'off', false);

\echo ''
\echo '=== 1. TEKDÜZEN HESAP PLANI ==='
select public.t_assert(
  (select count(*) from finance.accounts) = 63,
  'Hesap planı şablonu kuruldu (63 hesap)',
  (select count(*)::text from finance.accounts));

select public.t_assert(
  (select requires_partner from finance.accounts where code = '120'),
  '120 ALICILAR cari zorunlu olarak işaretli');

select public.t_assert(
  not (select is_leaf from finance.accounts where code = '12'),
  '12 grup hesabına doğrudan kayıt atılamaz (is_leaf = false)');

-- Sayı DEĞİL, anahtar varlığı sınanıyor: başka bir modül kendi eşlemesini
-- eklediğinde (ör. bordro köprüsü) bu test kırılmamalı, ama finance'in kendi
-- eşlemelerinden biri kaybolursa kırılmalı.
select public.t_assert(
  not exists (
    select 1 from unnest(array[
      'receivable','payable','vat_output','vat_input','vat_withholding_payable',
      'sales_income','sales_discount','purchase_expense','cash','bank','period_profit'
    ]) k
    where not exists (select 1 from finance.account_mappings m where m.key = k)),
  'Muhasebe hesap eşlemelerinin tamamı tanımlı',
  (select string_agg(k, ', ') from unnest(array[
      'receivable','payable','vat_output','vat_input','vat_withholding_payable',
      'sales_income','sales_discount','purchase_expense','cash','bank','period_profit'
    ]) k
    where not exists (select 1 from finance.account_mappings m where m.key = k)));

select public.t_assert(
  (select a.code from finance.accounts a
    join finance.account_mappings m on m.account_id = a.id and m.key = 'vat_output') = '391',
  'vat_output eşlemesi 391 HESAPLANAN KDV''ye bakıyor');

\echo ''
\echo '=== 2. ÇİFT TARAFLI KAYIT ZORUNLU ==='
select id as gen_journal from finance.journals where code = 'GENEL' limit 1 \gset
select id as acc_100 from finance.accounts where code = '100' \gset
select id as acc_600 from finance.accounts where code = '600' \gset
select id as acc_120 from finance.accounts where code = '120' \gset
select id as acc_12  from finance.accounts where code = '12'  \gset

-- Dengesiz kayıt
insert into finance.journal_entries (journal_id, entry_date, description)
values (:'gen_journal', current_date, 'Dengesiz test kaydı')
returning id as unbalanced_id \gset

insert into finance.journal_entry_lines (entry_id, sequence, account_id, debit)
values (:'unbalanced_id', 10, :'acc_100', 1000);

select public.t_assert(
  public.t_error(format('select finance.post_entry(%L)', :'unbalanced_id'))
    like '%dengeli olmalı%',
  'Dengesiz kayıt muhasebeleştirilemez',
  public.t_error(format('select finance.post_entry(%L)', :'unbalanced_id')));

-- Grup hesabına kayıt
insert into finance.journal_entry_lines (entry_id, sequence, account_id, credit)
values (:'unbalanced_id', 20, :'acc_12', 1000);

select public.t_assert(
  public.t_error(format('select finance.post_entry(%L)', :'unbalanced_id'))
    like '%grup ya da pasif hesap%',
  'Grup hesabına kayıt atılamaz');

delete from finance.journal_entry_lines where entry_id = :'unbalanced_id' and sequence = 20;

-- Cari zorunlu hesapta partner yok
insert into finance.journal_entry_lines (entry_id, sequence, account_id, credit)
values (:'unbalanced_id', 30, :'acc_120', 1000);

select public.t_assert(
  public.t_error(format('select finance.post_entry(%L)', :'unbalanced_id'))
    like '%cari bilgisi olmadan%',
  '120 hesabı cari olmadan kullanılamaz');

\echo ''
\echo '=== 3. MUHASEBELEŞTİRME VE DEĞİŞMEZLİK ==='
update finance.journal_entry_lines
   set partner_id = (select id from core.partners where name like 'Alfa%' limit 1)
 where entry_id = :'unbalanced_id' and sequence = 30;

select (finance.post_entry(:'unbalanced_id')).number as entry_number \gset
select public.t_assert(
  :'entry_number' like 'YEV-%',
  'Muhasebeleşen kayda yevmiye numarası verildi',
  :'entry_number');

select public.t_assert(
  (select status::text from finance.journal_entries where id = :'unbalanced_id') = 'posted',
  'Kayıt durumu posted');

select public.t_assert(
  public.t_raises(format(
    'update finance.journal_entry_lines set debit = 5 where entry_id = %L', :'unbalanced_id')) = '23514',
  'Muhasebeleşmiş kaydın satırları değiştirilemez');

select public.t_assert(
  public.t_raises(format(
    'delete from finance.journal_entries where id = %L', :'unbalanced_id')) = '23514',
  'Muhasebeleşmiş kayıt silinemez');

-- Bakiye tablosu güncellendi mi
select public.t_assert(
  (select debit_total from finance.account_balances b
    where b.account_id = :'acc_100' and b.period_start = date_trunc('month', current_date)::date) = 1000,
  '100 KASA borç bakiyesi tetikleyiciyle güncellendi');

-- Ters kayıt
select (finance.reverse_entry(:'unbalanced_id', current_date, 'test düzeltmesi')).id as rev_id \gset
select public.t_assert(
  (select status::text from finance.journal_entries where id = :'unbalanced_id') = 'reversed',
  'Orijinal kayıt reversed olarak işaretlendi');

select public.t_assert(
  (select debit_total - credit_total from finance.account_balances b
    where b.account_id = :'acc_100' and b.period_start = date_trunc('month', current_date)::date) = 0,
  'Ters kayıt bakiyeyi nötrledi (defterden satır düşürülmedi)');

\echo ''
\echo '=== 4. CRM SİPARİŞİ -> OTOMATİK FATURA TASLAĞI ==='
reset role;
-- NOT: Bekleyen teslimat sayısına DEĞİL, teslimatın var olduğuna bakıyoruz.
-- Geliştirici `npm run dev` ile API'yi açık bırakmışsa oradaki EventWorker
-- kuyruğu çoktan tüketmiş olabilir; test bu duruma da dayanıklı olmalı.
select public.t_assert(
  (select count(*) from core.event_deliveries d
    join core.events e on e.id = d.event_id
   where e.topic = 'sales.order.confirmed') >= 1,
  'Sipariş onayı olayı kuyruğa alındı');

select core.dispatch_events(50) as dispatched \gset

select public.t_assert(
  (select bool_and(d.status = 'done') from core.event_deliveries d
    join core.events e on e.id = d.event_id
   where e.topic = 'sales.order.confirmed'),
  'Teslimat başarıyla işlendi',
  (select string_agg(d.status::text, ',') from core.event_deliveries d));

select public.t_assert(
  (select count(*) from core.event_deliveries where status = 'failed' or status = 'dead') = 0,
  'Hiçbir teslimat hata almadı',
  (select coalesce(string_agg(last_error, ' | '), '-') from core.event_deliveries where last_error is not null));

set role sezra_app;
select public.t_assert(
  (select count(*) from finance.invoices
    where source_module = 'crm' and source_table = 'sale_orders') = 1,
  'Onaylanan siparişten fatura taslağı üretildi');

select id as inv_id from finance.invoices where source_module = 'crm' limit 1 \gset

select public.t_assert(
  (select total from finance.invoices where id = :'inv_id') = 140183.00,
  'Fatura toplamı siparişle birebir aynı',
  (select total::text from finance.invoices where id = :'inv_id'));

select public.t_assert(
  (select count(*) from finance.invoice_lines where invoice_id = :'inv_id') = 2,
  'Fatura satırları olay yükünden kopyalandı');

-- İdempotanlık: aynı olay yeniden teslim edilirse ikinci fatura oluşmamalı
reset role;
do $$
declare v_event jsonb;
begin
  select jsonb_build_object('id', e.id, 'tenant_id', e.tenant_id, 'branch_id', e.branch_id,
                            'topic', e.topic, 'payload', e.payload, 'actor_id', e.actor_id,
                            'occurred_at', e.occurred_at)
    into v_event
  from core.events e where e.topic = 'sales.order.confirmed' limit 1;
  perform finance.on_sales_order_confirmed(v_event);
end $$;
set role sezra_app;
select public.t_assert(
  (select count(*) from finance.invoices where source_module = 'crm') = 1,
  'Olay yeniden teslim edilse de ikinci fatura üretilmez (idempotent)');

\echo ''
\echo '=== 5. SATIŞ FATURASI MUHASEBELEŞMESİ ==='
select (finance.post_invoice(:'inv_id')).number as inv_number \gset
select public.t_assert(:'inv_number' like 'SFT-%', 'Faturaya numara verildi', :'inv_number');

select journal_entry_id as inv_entry from finance.invoices where id = :'inv_id' \gset

select public.t_assert(
  (select total_debit from finance.journal_entries where id = :'inv_entry') = 140183.00
  and (select total_credit from finance.journal_entries where id = :'inv_entry') = 140183.00,
  'Yevmiye kaydı dengeli (140.183,00)');

select public.t_assert(
  (select l.debit from finance.journal_entry_lines l
    join finance.accounts a on a.id = l.account_id
   where l.entry_id = :'inv_entry' and a.code = '120') = 140183.00,
  '120 ALICILAR borçlandırıldı');

select public.t_assert(
  (select l.credit from finance.journal_entry_lines l
    join finance.accounts a on a.id = l.account_id
   where l.entry_id = :'inv_entry' and a.code = '600') = 136300.00,
  '600 YURTİÇİ SATIŞLAR matrahla alacaklandırıldı');

select public.t_assert(
  (select l.credit from finance.journal_entry_lines l
    join finance.accounts a on a.id = l.account_id
   where l.entry_id = :'inv_entry' and a.code = '391') = 3883.00,
  '391 HESAPLANAN KDV alacaklandırıldı');

select public.t_assert(
  (select partner_id is not null from finance.journal_entry_lines l
    join finance.accounts a on a.id = l.account_id
   where l.entry_id = :'inv_entry' and a.code = '120'),
  'Cari hesap satırı partner taşıyor');

\echo ''
\echo '=== 6. TEVKİFATLI ALIŞ FATURASI ==='
select id as tax_wh from core.taxes where code = 'KDV20' \gset
select id as supplier from core.partners where is_supplier limit 1 \gset
select id as acc_153 from finance.accounts where code = '153' \gset

insert into core.taxes (code, name, rate, kind, withholding_num, withholding_den)
values ('KDV20-T510', 'KDV %20 (5/10 tevkifat)', 20, 'withholding', 5, 10)
returning id as tax_t510 \gset

insert into finance.invoices (kind, partner_id, issue_date, payment_term_days)
values ('purchase', :'supplier', current_date, 30)
returning id as pinv_id \gset

insert into finance.invoice_lines (invoice_id, sequence, account_id, description, quantity, unit_price, tax_id)
values (:'pinv_id', 10, :'acc_153', 'Hammadde 201 — 100 kg', 100, 500, :'tax_t510');

select public.t_assert(
  (select subtotal from finance.invoices where id = :'pinv_id') = 50000.00
  and (select tax_total from finance.invoices where id = :'pinv_id') = 10000.00
  and (select withholding_total from finance.invoices where id = :'pinv_id') = 5000.00
  and (select total from finance.invoices where id = :'pinv_id') = 55000.00,
  'Tevkifatlı tutarlar: 50.000 matrah, 10.000 KDV, 5.000 tevkifat, 55.000 ödenecek',
  (select format('%s / %s / %s / %s', subtotal, tax_total, withholding_total, total)
     from finance.invoices where id = :'pinv_id'));

select finance.post_invoice(:'pinv_id') is not null as posted \gset
select journal_entry_id as pinv_entry from finance.invoices where id = :'pinv_id' \gset

select public.t_assert(
  (select l.debit from finance.journal_entry_lines l
    join finance.accounts a on a.id = l.account_id
   where l.entry_id = :'pinv_entry' and a.code = '153') = 50000.00,
  '153 TİCARİ MALLAR matrahla borçlandırıldı');

select public.t_assert(
  (select l.debit from finance.journal_entry_lines l
    join finance.accounts a on a.id = l.account_id
   where l.entry_id = :'pinv_entry' and a.code = '191') = 10000.00,
  '191 İNDİRİLECEK KDV tam KDV ile borçlandırıldı (tevkifat dâhil)');

select public.t_assert(
  (select l.credit from finance.journal_entry_lines l
    join finance.accounts a on a.id = l.account_id
   where l.entry_id = :'pinv_entry' and a.code = '320') = 55000.00,
  '320 SATICILAR ödenecek tutarla alacaklandırıldı');

select public.t_assert(
  (select l.credit from finance.journal_entry_lines l
    join finance.accounts a on a.id = l.account_id
   where l.entry_id = :'pinv_entry' and a.code = '360') = 5000.00,
  '360 ÖDENECEK VERGİ VE FONLAR tevkifatla alacaklandırıldı');

select public.t_assert(
  (select total_debit = total_credit from finance.journal_entries where id = :'pinv_entry'),
  'Tevkifatlı alış kaydı dengeli');

\echo ''
\echo '=== 7. TAHSİLAT ==='
select public.t_assert(
  public.t_error(format('select finance.register_payment(%L, 200000)', :'inv_id'))
    like '%kalan bakiyeyi%',
  'Fatura tutarını aşan tahsilat reddedilir');

select (finance.register_payment(:'inv_id', 40183.00, current_date, 'bank')).number as pay1 \gset
select public.t_assert(
  (select status::text from finance.invoices where id = :'inv_id') = 'partially_paid',
  'Kısmi tahsilat sonrası fatura kısmen ödendi',
  (select status::text from finance.invoices where id = :'inv_id'));

select finance.register_payment(:'inv_id') is not null as pay2 \gset
select public.t_assert(
  (select status::text from finance.invoices where id = :'inv_id') = 'paid'
  and (select paid_total from finance.invoices where id = :'inv_id') = 140183.00,
  'Kalan tahsil edilince fatura tamamen ödendi');

select public.t_assert(
  (select sum(l.debit) from finance.journal_entry_lines l
    join finance.accounts a on a.id = l.account_id
    join finance.journal_entries e on e.id = l.entry_id
   where a.code = '102' and e.source_table = 'payments') = 140183.00,
  '102 BANKALAR tahsilat toplamıyla borçlandırıldı');

\echo ''
\echo '=== 8. RAPORLAR ==='
select public.t_assert(
  (select sum(debit_total) - sum(credit_total) from finance.v_trial_balance) = 0,
  'Mizan dengeli (toplam borç = toplam alacak)',
  (select (sum(debit_total) - sum(credit_total))::text from finance.v_trial_balance));

select public.t_assert(
  (select gross_revenue from finance.v_profit_loss_summary
    where period_start = date_trunc('month', current_date)::date limit 1) = 136300.00,
  'P&L brüt satışları 136.300,00',
  (select gross_revenue::text from finance.v_profit_loss_summary limit 1));

select public.t_assert(
  (select open_amount from finance.v_partner_aging where kind = 'purchase' limit 1) = 55000.00,
  'Cari yaşlandırma açık satıcı borcunu gösteriyor');

select public.t_assert(
  (select count(*) from finance.v_open_invoices) = 1,
  'Ödenmiş fatura açık faturalar listesinden çıktı',
  (select count(*)::text from finance.v_open_invoices));

select public.t_assert(
  (select count(*) from finance.v_vat_summary where kind = 'sale') > 0
  and (select sum(tax_amount) from finance.v_vat_summary where kind = 'sale') = 3883.00,
  'KDV özeti satış KDV''sini doğru topluyor');

select public.t_assert(
  (select count(*) from finance.v_general_ledger where account_code = '120') >= 2,
  'Defter-i kebir 120 hesabında hem fatura hem tahsilat hareketini gösteriyor');

\echo ''
\echo '=== 9. KAPALI DÖNEM ==='
reset role;
update finance.fiscal_periods set is_closed = true
 where tenant_id = (select id from core.tenants where slug = 'ornek-ticaret')
   and current_date between date_from and date_to;
set role sezra_app;

insert into finance.journal_entries (journal_id, entry_date, description)
values (:'gen_journal', current_date, 'Kapalı dönem testi')
returning id as closed_entry \gset
insert into finance.journal_entry_lines (entry_id, sequence, account_id, debit)
values (:'closed_entry', 10, :'acc_100', 100);
insert into finance.journal_entry_lines (entry_id, sequence, account_id, credit)
values (:'closed_entry', 20, :'acc_600', 100);

select public.t_assert(
  public.t_error(format('select finance.post_entry(%L)', :'closed_entry')) like '%Kapalı döneme%',
  'Kapalı döneme kayıt atılamaz');

reset role;
update finance.fiscal_periods set is_closed = false
 where tenant_id = (select id from core.tenants where slug = 'ornek-ticaret');
set role sezra_app;

\echo ''
\echo '=== 10. ŞUBE VE ROL İZOLASYONU ==='
select set_config('app.user_id', '44444444-4444-4444-4444-444444444444', false);  -- Deniz, Zonguldak
select public.t_assert(
  (select count(*) from finance.invoices where branch_id is not null) = 0,
  'Zonguldak müdürü Düzce şubesinin faturalarını göremez',
  (select count(*)::text from finance.invoices where branch_id is not null));

-- BELGELENMİŞ DAVRANIŞ: branch_id boş olan kayıt kiracı genelidir ve şube
-- kısıtından muaftır. Merkezden girilen bir alış faturası ("şirket geneli
-- tedarik") tüm şube müdürlerine görünür; şubeye ait olması isteniyorsa
-- branch_id verilmelidir. Tek şubeye kilitli kullanıcıların açtığı kayıtlarda
-- bu alan zaten otomatik dolar (core.fn_set_row_defaults).
select public.t_assert(
  (select count(*) from finance.invoices where branch_id is null) = 1,
  'Şubesiz (kiracı geneli) fatura her şube müdürüne görünür — tasarım gereği',
  (select count(*)::text from finance.invoices where branch_id is null));

select public.t_assert(
  not core.has_perm('finance.invoice.post') and core.has_perm('finance.report.pl'),
  'Şube müdürü fatura muhasebeleştiremez ama P&L okuyabilir');

select set_config('app.user_id', '33333333-3333-3333-3333-333333333333', false);  -- Ali, satış
select public.t_assert(
  not core.has_perm('finance.report.pl') and not core.has_perm('finance.entry.read.all'),
  'Satış temsilcisinin muhasebe raporlarına erişimi yok');

select set_config('app.user_id', '55555555-5555-5555-5555-555555555555', false);  -- Rakip Ticaret
select public.t_assert(
  (select count(*) from finance.invoices) = 0
  and (select count(*) from finance.journal_entries) = 0,
  'Başka kiracı Örnek Ticaret''nın muhasebesini göremez');

select public.t_assert(
  (select count(*) from finance.accounts) = 63,
  'Başka kiracı KENDİ hesap planını görür (63 hesap)',
  (select count(*)::text from finance.accounts));

reset role;
drop function if exists public.t_assert(boolean, text, text);
drop function if exists public.t_raises(text);
drop function if exists public.t_error(text);
\echo ''
\echo '=== FİNANS TESTLERİ TAMAMLANDI ==='
