-- =============================================================================
-- Proje & Zaman Çizelgesi testleri  (Faz 4)
-- =============================================================================
-- Kapsam: CRM'den proje doğması, zaman kaydının çift kullanımı (fatura + maliyet),
-- oran/maliyet dondurma, görev ağacı, hakediş faturalaması, faturalanmış kaydın
-- değişmezliği, kârlılık, maliyet gizliliği ve izolasyon.
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
select id as musteri from core.partners
 where tenant_id = :'ornek' and is_customer limit 1 \gset

\echo ''
\echo '=== 1. KAZANILAN FIRSATTAN PROJE ==='
-- 02_crm_flow bir fırsatı kazandırdı; Faz 4 abonesi ondan taslak proje açmalı.
reset role;
do $$
declare i int := 0;
begin
  perform core.dispatch_events(100);
  while i < 100 loop
    exit when not exists (
      select 1 from core.event_deliveries d join core.events e on e.id = d.event_id
       where e.topic = 'crm.lead.won' and d.status in ('pending','processing'));
    perform pg_sleep(0.1); i := i + 1;
  end loop;
end $$;

set role sezra_app;
select set_config('app.user_id', '22222222-2222-2222-2222-222222222222', false);
select set_config('app.tenant_id', :'ornek', false);

select public.t_assert(
  (select count(*) from projects.projects where source_module = 'crm') = 1,
  'Kazanılan fırsattan proje açıldı — CRM''de tek satır değişmeden');

select public.t_assert(
  (select status from projects.projects where source_module = 'crm') = 'draft',
  'Proje TASLAK doğdu (her fırsat proje gerektirmez)');

select public.t_assert(
  (select code from projects.projects where source_module = 'crm') like 'PRJ-%',
  'Projeye kod verildi',
  (select code from projects.projects where source_module = 'crm'));

\echo ''
\echo '=== 2. ZAMAN KAYDI: ORAN VE MALİYET DONDURMA ==='
reset role;
-- Ali'yi bir İK çalışanı olarak bağlayalım ki saatlik maliyet hesaplanabilsin.
-- (Aylık 45.000 brüt, haftalık 45 saat -> saatlik ≈ 230,77)
update hr.employees set user_id = '33333333-3333-3333-3333-333333333333'
 where tenant_id = :'ornek' and employee_no = 'P-001';
update hr.employee_contracts set wage_amount = 45000, weekly_hours = 45
 where employee_id = (select id from hr.employees where tenant_id = :'ornek'
                       and employee_no = 'P-001');

set role sezra_app;
select set_config('app.user_id', '22222222-2222-2222-2222-222222222222', false);
select set_config('app.tenant_id', :'ornek', false);

insert into projects.projects (branch_id, code, name, partner_id, status,
                               billing_type, hourly_rate, planned_hours, manager_id)
values (:'duzce', 'PRJ-TEST', 'Kurumsal kurulum danışmanlığı', :'musteri', 'active',
        'time_material', 1500, 100, '22222222-2222-2222-2222-222222222222')
returning id as prj \gset

insert into projects.timesheets (project_id, user_id, work_date, hours, description)
values (:'prj', '33333333-3333-3333-3333-333333333333', current_date, 8, 'Saha analizi')
returning id as ts1 \gset

select public.t_assert(
  (select hourly_rate from projects.timesheets where id = :'ts1') = 1500,
  'Faturalama oranı projeden donduruldu');

select public.t_assert(
  (select billable_amount from projects.timesheets where id = :'ts1') = 12000.00,
  'Faturalanacak tutar hesaplandı (8 × 1.500)',
  (select billable_amount::text from projects.timesheets where id = :'ts1'));

-- 45.000 / (45 × 52 / 12) = 45.000 / 195 = 230,7692
select public.t_assert(
  (select hourly_cost from projects.timesheets where id = :'ts1') = 230.7692,
  'Saatlik maliyet İK sözleşmesinden hesaplandı (45.000 / 195)',
  (select hourly_cost::text from projects.timesheets where id = :'ts1'));

select public.t_assert(
  (select cost_amount from projects.timesheets where id = :'ts1') = 1846.15,
  'Maliyet tutarı hesaplandı (8 × 230,7692)',
  (select cost_amount::text from projects.timesheets where id = :'ts1'));

-- ZAM YAPILINCA GEÇMİŞ DEĞİŞMEMELİ
reset role;
update hr.employee_contracts set wage_amount = 90000
 where employee_id = (select id from hr.employees where tenant_id = :'ornek'
                       and employee_no = 'P-001');
set role sezra_app;
select set_config('app.user_id', '22222222-2222-2222-2222-222222222222', false);
select set_config('app.tenant_id', :'ornek', false);

select public.t_assert(
  (select hourly_cost from projects.timesheets where id = :'ts1') = 230.7692,
  'Zam sonrası GEÇMİŞ zaman kaydının maliyeti değişmedi',
  (select hourly_cost::text from projects.timesheets where id = :'ts1'));

insert into projects.timesheets (project_id, user_id, work_date, hours, description)
values (:'prj', '33333333-3333-3333-3333-333333333333', current_date, 2, 'Zam sonrası')
returning id as ts2 \gset

select public.t_assert(
  (select hourly_cost from projects.timesheets where id = :'ts2') = 461.5385,
  'YENİ kayıt güncel ücretten hesaplandı (90.000 / 195)',
  (select hourly_cost::text from projects.timesheets where id = :'ts2'));

\echo ''
\echo '=== 3. İÇ PROJEDE SAAT FATURALANMAZ ==='
insert into projects.projects (branch_id, code, name, status, billing_type, hourly_rate)
values (:'duzce', 'PRJ-IC', 'İç eğitim', 'active', 'internal', 1500)
returning id as prj_ic \gset

insert into projects.timesheets (project_id, user_id, work_date, hours)
values (:'prj_ic', '33333333-3333-3333-3333-333333333333', current_date, 4)
returning id as ts_ic \gset

select public.t_assert(
  (select is_billable from projects.timesheets where id = :'ts_ic') = false
  and (select billable_amount from projects.timesheets where id = :'ts_ic') = 0,
  'İç projede saat faturalanabilir işaretlenmez');

select public.t_assert(
  (select cost_amount from projects.timesheets where id = :'ts_ic') > 0,
  'İç projede saat yine de MALİYET üretir');

\echo ''
\echo '=== 4. GÖREV AĞACI ==='
insert into projects.tasks (project_id, name, planned_hours)
values (:'prj', 'Analiz fazı', 40) returning id as t_ust \gset
insert into projects.tasks (project_id, parent_id, name, planned_hours)
values (:'prj', :'t_ust', 'Şube ziyaretleri', 24) returning id as t_alt \gset

select public.t_assert(
  public.t_raises(format('select projects.complete_task(%L)', :'t_ust')) = '23514',
  'Alt görev açıkken üst görev tamamlanamaz');

select projects.complete_task(:'t_alt') is not null as _a \gset
select projects.complete_task(:'t_ust') is not null as _b \gset

select public.t_assert(
  (select status from projects.tasks where id = :'t_ust') = 'done',
  'Alt görevler kapanınca üst görev tamamlanabildi');

\echo ''
\echo '=== 5. HAKEDİŞ FATURALAMASI ==='
-- 8 + 2 = 10 saat × 1.500 = 15.000
select projects.bill_project(:'prj') as bill \gset

select public.t_assert(
  (:'bill'::jsonb ->> 'amount')::numeric = 15000.00
  and (:'bill'::jsonb ->> 'hours')::numeric = 10,
  'Hakediş toplandı (10 saat / 15.000 TL)',
  :'bill');

select public.t_assert(
  (select count(*) from projects.timesheets
    where project_id = :'prj' and invoiced_at is null and is_billable) = 0,
  'Faturalanan kayıtlar işaretlendi');

select public.t_assert(
  public.t_raises(format('select projects.bill_project(%L)', :'prj')) = 'P0002',
  'İkinci kez faturalanacak hakediş kalmadı');

-- KARAR 3: faturalanmış kayıt dokunulmaz
select public.t_assert(
  public.t_raises(format(
    'update projects.timesheets set hours = 99 where id = %L', :'ts1')) = '23514',
  'Faturalanmış zaman kaydı değiştirilemez');

\echo ''
\echo '=== 6. HAKEDİŞ -> SATIŞ FATURASI (olay tabanlı) ==='
reset role;
do $$
declare i int := 0;
begin
  perform core.dispatch_events(100);
  while i < 100 loop
    exit when not exists (
      select 1 from core.event_deliveries d join core.events e on e.id = d.event_id
       where e.topic = 'projects.billing.requested' and d.status in ('pending','processing'));
    perform pg_sleep(0.1); i := i + 1;
  end loop;
end $$;
set role sezra_app;
select set_config('app.user_id', '22222222-2222-2222-2222-222222222222', false);
select set_config('app.tenant_id', :'ornek', false);

select public.t_assert(
  (select count(*) from finance.invoices
    where source_module = 'projects' and source_table = 'timesheets') = 1,
  'Hakedişten satış faturası taslağı üretildi');

select public.t_assert(
  (select subtotal from finance.invoices where source_module = 'projects') = 15000.00,
  'Fatura matrahı hakediş tutarına eşit',
  (select subtotal::text from finance.invoices where source_module = 'projects'));

-- Fatura satırı KİŞİ BAZINDA toplanmalı, 10 ayrı satır değil
select public.t_assert(
  (select count(*) from finance.invoice_lines l
     join finance.invoices i on i.id = l.invoice_id
    where i.source_module = 'projects') = 1,
  'Fatura satırı kişi bazında toplandı (ayrıntı zaman çizelgesinde kalır)');

\echo ''
\echo '=== 7. PROJE KAPATMA ==='
insert into projects.timesheets (project_id, user_id, work_date, hours)
values (:'prj', '33333333-3333-3333-3333-333333333333', current_date, 3)
returning id as ts3 \gset

select public.t_assert(
  public.t_raises(format('select projects.complete_project(%L)', :'prj')) = '23514',
  'Faturalanmamış hakediş varken proje kapatılamaz (gelirin unutulmasına ENGEL)');

select projects.bill_project(:'prj') as bill2 \gset
select projects.complete_project(:'prj') is not null as _c \gset

select public.t_assert(
  (select status from projects.projects where id = :'prj') = 'completed',
  'Hakediş faturalandıktan sonra proje kapandı');

\echo ''
\echo '=== 8. KÂRLILIK ==='
-- Gelir 13 saat × 1500 = 19.500
-- Maliyet: 8×230,7692 + 2×461,5385 + 3×461,5385 = 1846,15 + 923,08 + 1384,62 = 4153,85
select public.t_assert(
  (select revenue from projects.v_project_profitability where project_id = :'prj') = 19500.00,
  'Kârlılık geliri doğru (13 saat × 1.500)',
  (select revenue::text from projects.v_project_profitability where project_id = :'prj'));

select public.t_assert(
  (select cost from projects.v_project_profitability where project_id = :'prj') = 4153.85,
  'Maliyet, her kaydın KENDİ dondurulmuş oranıyla toplandı',
  (select cost::text from projects.v_project_profitability where project_id = :'prj'));

select public.t_assert(
  (select margin_pct from projects.v_project_profitability where project_id = :'prj') = 78.7,
  'Kâr marjı hesaplandı',
  (select margin_pct::text from projects.v_project_profitability where project_id = :'prj'));

select public.t_assert(
  (select billable_pct from projects.v_project_profitability where project_id = :'prj_ic') = 0,
  'İç projede faturalanabilirlik oranı sıfır');

\echo ''
\echo '=== 9. YETKİ VE İZOLASYON ==='
-- Çalışan yalnızca KENDİ zaman kaydını görür
select set_config('app.user_id', '33333333-3333-3333-3333-333333333333', false);
select public.t_assert(
  (select count(*) from projects.timesheets) >= 1,
  'Kullanıcı kendi zaman kayıtlarını görüyor');

select public.t_assert(
  not exists (
    select 1 from core.role_permissions rp join core.roles r on r.id = rp.role_id
    where r.code = 'employee' and r.tenant_id is null
      and rp.permission_code = 'projects.timesheet.read.all'),
  'Çalışan rolünde BAŞKASININ zaman kaydını görme yetkisi yok');

select public.t_assert(
  not exists (
    select 1 from core.role_permissions rp join core.roles r on r.id = rp.role_id
    where r.code = 'employee' and r.tenant_id is null
      and rp.permission_code = 'projects.report.profitability'),
  'Çalışan rolünde kârlılık yetkisi yok (maliyet, ekip arkadaşının maaşını ele verir)');

select set_config('app.user_id', '55555555-5555-5555-5555-555555555555', false);
select public.t_assert(
  (select count(*) from projects.projects) = 0,
  'Başka kiracı Örnek Ticaret projelerini göremez');

reset role;
