-- =============================================================================
-- Bakım & Ekipman testleri (Faz 2)
-- =============================================================================
-- Kapsam: vade hesabı (takvim + sayaç), plandan iş emri üretimi ve kopya
-- engeli, arıza bildirimi, iş emri akışı, yapılmamış görev engeli, maliyet
-- toplama, parça tüketiminin envantere gitmesi, şube izolasyonu.
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
select id as eq1 from maintenance.equipment where code = 'EKP-001' \gset
select id as eq3 from maintenance.equipment where code = 'EKP-003' \gset
select id as mplan from maintenance.plans where code = 'BKM-PERIYODIK' \gset

\echo ''
\echo '=== 1. VADE HESABI ==='
set role sezra_app;
select set_config('app.user_id', '22222222-2222-2222-2222-222222222222', false);
select set_config('app.tenant_id', :'ornek', false);

-- Kategori planı iki üretim hattına da uygulanmalı, yardımcı ekipmana UYGULANMAMALI
select public.t_assert(
  (select count(*) from maintenance.v_due_plans where plan_id = :'mplan') = 2,
  'Kategori planı yalnızca üretim hatlarına uygulandı (yardımcı ekipman hariç)',
  (select string_agg(equipment_code, ',') from maintenance.v_due_plans where plan_id = :'mplan'));

-- EKP-001: 184.000 devir, hiç bakım yok -> sayaç eşiği (20.000) çoktan aşıldı
select public.t_assert(
  (select usage_since_service from maintenance.v_due_plans
    where plan_id = :'mplan' and equipment_id = :'eq1') = 184000,
  'Hiç bakım yapılmamışsa sayaç sıfırdan sayılır',
  (select usage_since_service::text from maintenance.v_due_plans
    where plan_id = :'mplan' and equipment_id = :'eq1'));

-- Takvim vadesi alım tarihinden hesaplanır (2023-05-10 + 90 gün, çoktan geçti)
select public.t_assert(
  (select days_left from maintenance.v_due_plans
    where plan_id = :'mplan' and equipment_id = :'eq1') < 0,
  'Takvim vadesi alım tarihinden hesaplanıp geçmiş görünüyor');

\echo ''
\echo '=== 2. PLANDAN İŞ EMRİ ÜRETİMİ ==='
reset role;
select maintenance.generate_work_orders() as made \gset
set role sezra_app;
select set_config('app.user_id', '22222222-2222-2222-2222-222222222222', false);
select set_config('app.tenant_id', :'ornek', false);

select public.t_assert(
  :made = 2,
  'Vadesi gelen iki makine için iş emri açıldı',
  :'made');

select public.t_assert(
  (select count(*) from maintenance.work_orders
    where plan_id = :'mplan' and kind = 'preventive' and status = 'scheduled') = 2,
  'İş emirleri PLANLANMIŞ ve periyodik tipte');

select public.t_assert(
  (select count(*) from maintenance.work_order_tasks t
     join maintenance.work_orders w on w.id = t.work_order_id
    where w.equipment_id = :'eq1') = 5,
  'Plan görevleri iş emrine kopyalandı (5 görev)');

select public.t_assert(
  (select priority from maintenance.work_orders
    where equipment_id = :'eq1' and plan_id = :'mplan') = 2,
  'Kritik ekipmanın iş emri yüksek öncelikli açıldı');

-- KOPYA ENGELİ: cron tekrar çalışsa da ikinci iş emri açılmamalı
reset role;
select maintenance.generate_work_orders() as made2 \gset
set role sezra_app;
select set_config('app.user_id', '22222222-2222-2222-2222-222222222222', false);

select public.t_assert(
  :made2 = 0,
  'Açık iş emri varken cron ikinci kez iş emri AÇMAZ',
  :'made2');

\echo ''
\echo '=== 3. ARIZA BİLDİRİMİ ==='
select (maintenance.report_breakdown(
  :'eq3', 'Su almıyor', 'Pompa sesi geliyor ama grup kafadan su gelmiyor')).id as wo_ariza \gset

select public.t_assert(
  (select status from maintenance.equipment where id = :'eq3') = 'down',
  'Arıza bildirimi ekipmanı DURDU durumuna çekti');

select public.t_assert(
  (select kind from maintenance.work_orders where id = :'wo_ariza')::text = 'corrective'
  and (select priority from maintenance.work_orders where id = :'wo_ariza') = 1,
  'Arıza iş emri düzeltici ve en yüksek öncelikli');

select public.t_assert(
  (select count(*) from core.events where topic = 'maintenance.equipment.down') = 1,
  'maintenance.equipment.down olayı yayınlandı');

\echo ''
\echo '=== 4. İŞ EMRİ AKIŞI ==='
select id as wo1 from maintenance.work_orders
 where equipment_id = :'eq1' and plan_id = :'mplan' \gset

select maintenance.start_work_order(:'wo1') is not null as started \gset
select public.t_assert(
  (select status from maintenance.equipment where id = :'eq1') = 'maintenance',
  'Bakıma alınan ekipman "bakımda" — "arızalı" değil (ikisi farklı şeydir)');

-- Yapılmamış görev varken tamamlanamaz
select public.t_assert(
  public.t_raises(format('select maintenance.complete_work_order(%L)', :'wo1')) = '23514',
  'Yapılmamış görev varken iş emri tamamlanamaz');

update maintenance.work_order_tasks set is_done = true, done_at = now()
 where work_order_id = :'wo1';

\echo ''
\echo '=== 5. MALİYET TOPLAMA VE PARÇA ==='
select id as parca from core.products where tenant_id = :'ornek' and sku = 'PRC-CONTA' \gset

insert into maintenance.work_order_parts (work_order_id, product_id, quantity, unit_cost)
values (:'wo1', :'parca', 4, 185.00);

select public.t_assert(
  (select parts_cost from maintenance.work_orders where id = :'wo1') = 740.00,
  'Parça maliyeti satırlardan toplandı (4 × 185)',
  (select parts_cost::text from maintenance.work_orders where id = :'wo1'));

update maintenance.work_orders set labor_cost = 900, service_cost = 250 where id = :'wo1';
select public.t_assert(
  (select total_cost from maintenance.work_orders where id = :'wo1') = 1890.00,
  'Toplam maliyet = işçilik + parça + servis (900 + 740 + 250)',
  (select total_cost::text from maintenance.work_orders where id = :'wo1'));

-- Parça stokta yoksa envanter çıkışı reddedilir; önce stok girelim
reset role;
select inventory.receive_stock(:'ornek', null, :'parca', 20, 185, null,
                               'test', 'manual', null, 'parça açılış stoğu') as pin \gset

select maintenance.complete_work_order(
  :'wo1', 'İç devre temizlendi, 4 conta değiştirildi', 45) as done \gset

set role sezra_app;
select set_config('app.user_id', '22222222-2222-2222-2222-222222222222', false);
select set_config('app.tenant_id', :'ornek', false);

select public.t_assert(
  (select status from maintenance.work_orders where id = :'wo1') = 'done'
  and (select number from maintenance.work_orders where id = :'wo1') like 'BKM-%',
  'İş emri tamamlandı ve numaralandı',
  (select number from maintenance.work_orders where id = :'wo1'));

select public.t_assert(
  (select status from maintenance.equipment where id = :'eq1') = 'operational',
  'Bakım bitince ekipman çalışır duruma döndü');

select public.t_assert(
  (select usage_at_service from maintenance.work_orders where id = :'wo1') = 184000,
  'Bakım anındaki sayaç donduruldu (bir sonraki vadenin dayanağı)',
  (select usage_at_service::text from maintenance.work_orders where id = :'wo1'));

select public.t_assert(
  (select downtime_minutes from maintenance.work_orders where id = :'wo1') = 45,
  'Duruş süresi kaydedildi');

\echo ''
\echo '=== 6. PARÇA TÜKETİMİ -> ENVANTER (olay tabanlı) ==='
reset role;
do $$
declare i int := 0;
begin
  perform core.dispatch_events(50);
  while i < 100 loop
    exit when not exists (
      select 1 from core.event_deliveries d
        join core.events e on e.id = d.event_id
       where e.topic = 'maintenance.parts.consumed' and d.status in ('pending','processing'));
    perform pg_sleep(0.1);
    i := i + 1;
  end loop;
end $$;

select public.t_assert(
  (select count(*) from core.event_deliveries d
     join core.events e on e.id = d.event_id
    where e.topic = 'maintenance.parts.consumed' and d.status <> 'done') = 0,
  'Parça tüketimi olayı hatasız işlendi',
  (select coalesce(string_agg(d.last_error,' | '),'-') from core.event_deliveries d
     join core.events e on e.id = d.event_id
    where e.topic = 'maintenance.parts.consumed' and d.status <> 'done'));

set role sezra_app;
select set_config('app.user_id', '22222222-2222-2222-2222-222222222222', false);
select set_config('app.tenant_id', :'ornek', false);

select public.t_assert(
  (select quantity_on_hand from inventory.product_costs where product_id = :'parca') = 16,
  'Kullanılan 4 conta stoktan düştü (20 - 4)',
  (select quantity_on_hand::text from inventory.product_costs where product_id = :'parca'));

select public.t_assert(
  (select stock_issued from maintenance.work_order_parts where work_order_id = :'wo1'),
  'Parça satırı "stoktan düşüldü" olarak işaretlendi');

-- İdempotanlık
reset role;
select inventory.on_maintenance_parts_consumed(jsonb_build_object(
  'tenant_id', :'ornek', 'branch_id', null,
  'payload', jsonb_build_object(
    'work_order_id', :'wo1',
    'lines', (select jsonb_agg(jsonb_build_object(
                'product_id', product_id, 'quantity', quantity, 'part_id', id))
              from maintenance.work_order_parts where work_order_id = :'wo1')))) as retry \gset

set role sezra_app;
select set_config('app.user_id', '22222222-2222-2222-2222-222222222222', false);
select public.t_assert(
  (select quantity_on_hand from inventory.product_costs where product_id = :'parca') = 16,
  'Olay yeniden teslim edilirse stok ikinci kez düşmez (idempotent)');

\echo ''
\echo '=== 7. DEĞİŞMEZLİK VE İZOLASYON ==='
select public.t_assert(
  public.t_raises(format(
    'update maintenance.work_orders set downtime_minutes = 999 where id = %L', :'wo1')) = '23514',
  'Tamamlanmış iş emri değiştirilemez');

-- Zonguldak müdürü Düzce'nin ekipmanını göremez
select set_config('app.user_id', '44444444-4444-4444-4444-444444444444', false);
select public.t_assert(
  (select count(*) from maintenance.equipment) = 1,
  'Şube müdürü yalnızca kendi şubesinin ekipmanını görür',
  (select string_agg(code, ',') from maintenance.equipment));

select set_config('app.user_id', '55555555-5555-5555-5555-555555555555', false);
select public.t_assert(
  (select count(*) from maintenance.equipment) = 0,
  'Başka kiracı Örnek Ticaret ekipmanlarını göremez');

\echo ''
\echo '=== 8. GÜVENİLİRLİK RAPORU ==='
select set_config('app.user_id', '22222222-2222-2222-2222-222222222222', false);
select public.t_assert(
  (select total_cost from maintenance.v_equipment_reliability where equipment_id = :'eq1') = 1890.00,
  'Ekipman güvenilirlik raporu bakım maliyetini topluyor');

select public.t_assert(
  (select cost_vs_purchase_pct from maintenance.v_equipment_reliability
    where equipment_id = :'eq1') = 0.7,
  'Bakım maliyetinin alım bedeline oranı hesaplandı (1.890 / 285.000)',
  (select cost_vs_purchase_pct::text from maintenance.v_equipment_reliability
    where equipment_id = :'eq1'));

reset role;
