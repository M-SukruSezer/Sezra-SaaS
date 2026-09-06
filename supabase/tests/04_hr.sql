-- =============================================================================
-- İnsan Kaynakları & Bordro testleri
-- =============================================================================
-- Kapsam: kiracı izolasyonu, şube kapsamı, ÜCRET GİZLİLİĞİ (ayrı izin alanı),
-- modül aktivasyonu, izin onay akışı, bordro hesabı ve muhasebe köprüsü.
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
\echo '=== 1. KİRACI VE ŞUBE İZOLASYONU ==='
set role sezra_app;

select set_config('app.user_id', '55555555-5555-5555-5555-555555555555', false);
select public.t_assert(
  (select count(*) from hr.employees) = 0,
  'Rakip Ticaret yöneticisi Örnek Ticaret personelini GÖREMEZ',
  (select count(*)::text from hr.employees));

select set_config('app.user_id', '22222222-2222-2222-2222-222222222222', false);
select public.t_assert(
  (select count(*) from hr.employees) = 5,
  'Şirket yöneticisi tüm kadroyu görür',
  (select count(*)::text from hr.employees));

select set_config('app.user_id', '44444444-4444-4444-4444-444444444444', false);
select public.t_assert(
  (select count(*) from hr.employees) = 2,
  'Zonguldak şube müdürü yalnızca kendi şubesinin kadrosunu görür',
  (select string_agg(employee_no, ',') from hr.employees));

\echo ''
\echo '=== 2. ÜCRET GİZLİLİĞİ (ayrı izin alanı) ==='
-- Şube müdürü ekibini yönetir ama sözleşme/ücret izni YOK.
select public.t_assert(
  (select count(*) from hr.employee_contracts) = 0,
  'Şube müdürü ücret bilgisini GÖREMEZ (hr.contract izni yok)',
  (select count(*)::text from hr.employee_contracts));

select public.t_assert(
  (select count(*) from hr.v_employee_list) = 2,
  'Ücret göremeyen kullanıcı personel listesini yine de görür');

select set_config('app.user_id', '22222222-2222-2222-2222-222222222222', false);
select public.t_assert(
  (select count(*) from hr.employee_contracts) = 5,
  'Şirket yöneticisi ücretleri görür',
  (select count(*)::text from hr.employee_contracts));

\echo ''
\echo '=== 3. MODÜL AKTİVASYONU ==='
select public.t_assert(
  (select count(*) from unnest(core.permission_codes()) c where c like 'hr.%') > 0,
  'İK açık kiracıda İK izinleri etkin');

select set_config('app.user_id', '55555555-5555-5555-5555-555555555555', false);
select public.t_assert(
  (select count(*) from unnest(core.permission_codes()) c where c like 'hr.%') = 0,
  'İK kapalı kiracıda hiçbir İK izni etkin değil — modül satın alınmadan erişim yok',
  (select string_agg(c, ',') from unnest(core.permission_codes()) c where c like 'hr.%'));

\echo ''
\echo '=== 4. İZİN ONAY AKIŞI ==='
select set_config('app.user_id', '22222222-2222-2222-2222-222222222222', false);
select set_config('app.tenant_id', :'ornek', false);

select id as leave_req from hr.leave_requests where status = 'pending' limit 1 \gset
select employee_id as leave_emp from hr.leave_requests where id = :'leave_req' \gset
select leave_type_id as leave_type from hr.leave_requests where id = :'leave_req' \gset
select days as leave_days from hr.leave_requests where id = :'leave_req' \gset

select public.t_assert(
  :leave_days > 0,
  'İzin gün sayısı tarih aralığından türetildi (pazar ve resmî tatil hariç)',
  :'leave_days');

select coalesce((select used_days from hr.leave_balances
                 where employee_id = :'leave_emp' and leave_type_id = :'leave_type'
                   and year = extract(year from current_date)::smallint), 0) as used_before \gset

select hr.approve_leave_request(:'leave_req') is not null as approved \gset

select public.t_assert(
  (select status from hr.leave_requests where id = :'leave_req') = 'approved',
  'İzin talebi onaylandı');

select public.t_assert(
  (select used_days from hr.leave_balances
    where employee_id = :'leave_emp' and leave_type_id = :'leave_type'
      and year = extract(year from current_date)::smallint) = :used_before + :leave_days,
  'Onay, izin bakiyesinden gün düştü');

-- İptal bakiyeyi geri vermeli
select hr.cancel_leave_request(:'leave_req') is not null as cancelled \gset
select public.t_assert(
  (select used_days from hr.leave_balances
    where employee_id = :'leave_emp' and leave_type_id = :'leave_type'
      and year = extract(year from current_date)::smallint) = :used_before,
  'İptal, düşülen izin gününü geri verdi');

-- Bakiye koruması, override İZNİ OLMAYAN bir rolle sınanmalı.
-- Şube müdürü izin onaylar ama hr.leave.override'ı yoktur; şirket yöneticisinde
-- (tenant_admin) override vardır ve bilerek geçebilir. İkisini de doğruluyoruz —
-- aksi hâlde "koruma çalışıyor" ile "override çalışıyor" ayırt edilemez.
select set_config('app.user_id', '44444444-4444-4444-4444-444444444444', false);  -- Deniz, şube müdürü
select public.t_assert(
  public.t_raises(format(
    $q$do $x$
      declare v uuid;
      begin
        insert into hr.leave_requests (branch_id, employee_id, leave_type_id, date_from, date_to, status)
        select e.branch_id, e.id, %L, current_date + 40, current_date + 200, 'pending'
        from hr.employees e where e.employee_no = 'P-004' returning id into v;
        perform hr.approve_leave_request(v);
      end $x$$q$, :'leave_type')) = '23514',
  'Şube müdürü bakiyeyi aşan izni onaylayamaz');

select set_config('app.user_id', '22222222-2222-2222-2222-222222222222', false);  -- Merve, tenant_admin
select public.t_assert(
  public.t_raises(format(
    $q$do $x$
      declare v uuid;
      begin
        insert into hr.leave_requests (branch_id, employee_id, leave_type_id, date_from, date_to, status)
        select e.branch_id, e.id, %L, current_date + 220, current_date + 380, 'pending'
        from hr.employees e where e.employee_no = 'P-002' returning id into v;
        perform hr.approve_leave_request(v);
      end $x$$q$, :'leave_type')) = 'NO_ERROR',
  'hr.leave.override izni olan bakiyeyi aşarak onaylayabilir');

-- Kendi talebini onaylama yasağı: onay bir kontroldür, kişiye bırakılamaz.
select public.t_assert(
  public.t_raises(format(
    $q$do $x$
      declare v uuid; e uuid;
      begin
        update hr.employees set user_id = '22222222-2222-2222-2222-222222222222'
         where employee_no = 'P-001' returning id into e;
        insert into hr.leave_requests (employee_id, leave_type_id, date_from, date_to, status)
        values (e, %L, current_date + 400, current_date + 401, 'pending') returning id into v;
        perform hr.approve_leave_request(v);
      end $x$$q$, :'leave_type')) = '42501',
  'Kullanıcı kendi izin talebini onaylayamaz');

\echo ''
\echo '=== 5. BORDRO HESABI ==='
-- Referans doğrulama: 2025 brüt asgari ücretin neti bilinen bir sayıdır.
-- Motorun SGK, asgari ücret istisnası ve damga vergisi zincirini tek seferde
-- sınar; sapma olursa mevzuat mantığında bir şey bozulmuş demektir.
select public.t_assert(
  (select round(net, 2) from hr.compute_payslip(
     (select id from hr.employees where employee_no = 'P-002'), 2025::smallint, 3::smallint)) = 22104.67,
  '2025 asgari ücret neti referans değerle birebir (22.104,67 TL)',
  (select round(net,2)::text from hr.compute_payslip(
     (select id from hr.employees where employee_no = 'P-002'), 2025::smallint, 3::smallint)));

select public.t_assert(
  (select round(income_tax, 2) from hr.compute_payslip(
     (select id from hr.employees where employee_no = 'P-002'), 2025::smallint, 3::smallint)) = 0,
  'Asgari ücretliden gelir vergisi kesilmez (asgari ücret istisnası)');

-- Eksik gün orantılaması
select public.t_assert(
  (select round(sgk_base, 2) from hr.compute_payslip(
     (select id from hr.employees where employee_no = 'P-002'), 2025::smallint, 3::smallint, 10)) = 17337.00,
  '10 gün eksik günde SGK matrahı 20/30 oranında düşer');

-- Net anlaşma tersine tutarlı
select public.t_assert(
  abs(hr.net_from_gross(
        hr.gross_from_net(40000, (select id from hr.employees where employee_no = 'P-001'),
                          2025::smallint, 3::smallint),
        (select id from hr.employees where employee_no = 'P-001'), 2025::smallint, 3::smallint)
      - 40000) < 0.01,
  'Net→brüt çözümü geri hesaplandığında aynı neti verir');

\echo ''
\echo '=== 6. BORDRO ONAYI VE MEVZUAT TEYİDİ ==='
select hr.create_payroll_run(2025::smallint, 3::smallint) as run \gset
select id as run_id from hr.payroll_runs where period_year = 2025 and period_month = 3 \gset

select hr.calculate_payroll_run(:'run_id') is not null as calculated \gset
select public.t_assert(
  (select employee_count from hr.payroll_runs where id = :'run_id') = 5,
  'Bordro 5 personel için hesaplandı',
  (select employee_count::text from hr.payroll_runs where id = :'run_id'));

select public.t_assert(
  (select abs(total_gross - total_net
              - coalesce((select sum(sgk_employee + unemployment_employee + income_tax + stamp_tax)
                          from hr.payslips where run_id = :'run_id'), 0)) < 0.01
     from hr.payroll_runs where id = :'run_id'),
  'Brüt = net + tüm kesintiler (pusula içsel tutarlılığı)');

-- TEYİT EDİLMEMİŞ parametreyle onay ENGELLENMELİ
select public.t_assert(
  public.t_raises(format('select hr.approve_payroll_run(%L)', :'run_id')) = '23514',
  'Teyit edilmemiş mevzuat parametresiyle bordro ONAYLANAMAZ');

reset role;
update hr.payroll_parameter_sets set is_verified = true where code = 'TR-2025';
set role sezra_app;
select set_config('app.user_id', '22222222-2222-2222-2222-222222222222', false);
select set_config('app.tenant_id', :'ornek', false);

select hr.approve_payroll_run(:'run_id') is not null as approved \gset
select public.t_assert(
  (select status from hr.payroll_runs where id = :'run_id') = 'approved',
  'Teyitli parametreyle bordro onaylandı');

select public.t_assert(
  (select number from hr.payroll_runs where id = :'run_id') like 'BOR-%',
  'Onayda bordro numarası verildi',
  (select number from hr.payroll_runs where id = :'run_id'));

-- Onaylanmış bordro dokunulmaz
select public.t_assert(
  public.t_raises(format(
    'update hr.payslips set gross = gross + 1 where run_id = %L', :'run_id')) = '23514',
  'Onaylanmış bordronun pusulaları değiştirilemez');

\echo ''
\echo '=== 7. BORDRO -> MUHASEBE KÖPRÜSÜ (olay tabanlı) ==='
reset role;
select public.t_assert(
  (select count(*) from core.events where topic = 'hr.payroll.approved') = 1,
  'Bordro onayı olayı yayınlandı');

select core.dispatch_events(50) as dispatched \gset

-- Teslimatın TERMİNAL duruma ulaşmasını bekle.
-- Geliştirici `npm run dev:api` ile sunucuyu açık bıraktıysa oradaki EventWorker
-- teslimatı bizden önce kapmış ve hâlâ işliyor olabilir. Anlık duruma bakan bir
-- iddia bu yarışta rastgele düşer; beklemek testi hem tek başına hem de canlı
-- worker varken belirleyici kılar.
do $$
declare i int := 0;
begin
  while i < 100 loop
    exit when not exists (
      select 1 from core.event_deliveries d
        join core.events e on e.id = d.event_id
       where e.topic = 'hr.payroll.approved' and d.status in ('pending', 'processing'));
    perform pg_sleep(0.1);
    i := i + 1;
  end loop;
end $$;

select public.t_assert(
  (select count(*) from core.event_deliveries d
    join core.events e on e.id = d.event_id
   where e.topic = 'hr.payroll.approved' and d.status <> 'done') = 0,
  'Teslimat hatasız işlendi',
  (select coalesce(string_agg(d.status::text || ': ' || coalesce(d.last_error, 'hata yok'), ' | '), '-')
     from core.event_deliveries d
     join core.events e on e.id = d.event_id
    where e.topic = 'hr.payroll.approved' and d.status <> 'done'));

set role sezra_app;
select set_config('app.user_id', '22222222-2222-2222-2222-222222222222', false);
select set_config('app.tenant_id', :'ornek', false);

select public.t_assert(
  (select count(*) from finance.journal_entries
    where source_module = 'hr' and source_table = 'payroll_runs' and source_id = :'run_id') = 1,
  'Bordrodan yevmiye kaydı taslağı üretildi');

select id as entry_id from finance.journal_entries
 where source_module = 'hr' and source_id = :'run_id' \gset

select public.t_assert(
  (select total_debit = total_credit and total_debit > 0
     from finance.journal_entries where id = :'entry_id'),
  'Bordro kaydı dengeli (borç = alacak)',
  (select total_debit || ' / ' || total_credit from finance.journal_entries where id = :'entry_id'));

-- Kaydın 335 / 360 / 361 hesaplarını kullandığını doğrula (Tekdüzen Hesap Planı)
select public.t_assert(
  (select array_agg(a.code order by a.code) from finance.journal_entry_lines l
     join finance.accounts a on a.id = l.account_id where l.entry_id = :'entry_id')
  = array['335','360','361','770'],
  'Tahakkuk doğru THP hesaplarına yazıldı (770 gider / 335 personel / 360 vergi / 361 SGK)',
  (select string_agg(a.code, ',' order by a.code) from finance.journal_entry_lines l
     join finance.accounts a on a.id = l.account_id where l.entry_id = :'entry_id'));

-- Net ücret 335'e yazılmalı
select public.t_assert(
  (select l.credit from finance.journal_entry_lines l
     join finance.accounts a on a.id = l.account_id
    where l.entry_id = :'entry_id' and a.code = '335')
  = (select total_net from hr.payroll_runs where id = :'run_id'),
  '335 PERSONELE BORÇLAR tutarı bordronun net toplamına eşit');

-- İdempotanlık: aynı olay ikinci kez işlenirse ikinci kayıt oluşmamalı
reset role;
select finance.on_payroll_approved(jsonb_build_object(
  'tenant_id', :'ornek', 'branch_id', null,
  'payload', jsonb_build_object('run_id', :'run_id'))) as retried \gset
set role sezra_app;
select set_config('app.user_id', '22222222-2222-2222-2222-222222222222', false);
select public.t_assert(
  (select count(*) from finance.journal_entries
    where source_module = 'hr' and source_id = :'run_id') = 1,
  'Olay yeniden teslim edilirse ikinci kayıt oluşmaz (idempotent handler)');

reset role;
