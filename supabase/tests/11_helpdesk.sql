-- =============================================================================
-- Destek Masası testleri  (Faz 4)
-- =============================================================================
-- Kapsam: SLA hedeflerinin dondurulması, ilk yanıt ölçümü, müşteri beklerken
-- saatin durması, ihlal taraması, çözüm/kapanış akışı, değişmezlik, izolasyon.
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
\echo '=== 1. KURULUM VE SLA HEDEFİ DONDURMA ==='
set role sezra_app;
select set_config('app.user_id', '22222222-2222-2222-2222-222222222222', false);
select set_config('app.tenant_id', :'ornek', false);

select public.t_assert(
  (select count(*) from helpdesk.sla_policies) = 4,
  'Dört öncelik için SLA politikası kuruldu');

insert into helpdesk.tickets (branch_id, subject, description, partner_id, priority, channel)
values (:'duzce', 'Üretim hattı çıktı vermiyor',
        'Hat basınç vermiyor', :'musteri', 'urgent', 'phone')
returning id as tkt \gset

select public.t_assert(
  (select number from helpdesk.tickets where id = :'tkt') like 'DST-%',
  'Bilet numaralandı',
  (select number from helpdesk.tickets where id = :'tkt'));

-- Acil: ilk yanıt 30 dk, çözüm 240 dk
select public.t_assert(
  (select first_response_target_minutes from helpdesk.tickets where id = :'tkt') = 30
  and (select resolution_target_minutes from helpdesk.tickets where id = :'tkt') = 240,
  'SLA hedefleri bilete DONDURULDU (acil: 30 dk / 240 dk)');

select public.t_assert(
  (select first_response_due from helpdesk.tickets where id = :'tkt') > now(),
  'İlk yanıt vadesi hesaplandı');

-- POLİTİKA DEĞİŞSE BİLE AÇIK BİLET ETKİLENMEZ
reset role;
update helpdesk.sla_policies set first_response_minutes = 5 where code = 'SLA-URGENT';
set role sezra_app;
select set_config('app.user_id', '22222222-2222-2222-2222-222222222222', false);

select public.t_assert(
  (select first_response_target_minutes from helpdesk.tickets where id = :'tkt') = 30,
  'Politika sonradan sıkılaştı ama AÇIK biletin hedefi değişmedi',
  (select first_response_target_minutes::text from helpdesk.tickets where id = :'tkt'));

select public.t_assert(
  (select count(*) from core.events where topic = 'helpdesk.ticket.created') = 1,
  'Bilet açılış olayı yayınlandı');

\echo ''
\echo '=== 2. İLK YANIT ÖLÇÜMÜ ==='
-- İÇ NOT ilk yanıt SAYILMAZ: ekip kendi arasında konuşurken müşteri bekliyor
insert into helpdesk.messages (ticket_id, author_id, body, is_internal)
values (:'tkt', '22222222-2222-2222-2222-222222222222', 'Servise bakalım', true);

select public.t_assert(
  (select first_response_at from helpdesk.tickets where id = :'tkt') is null,
  'İç not ilk yanıt sayılmadı');

select public.t_assert(
  public.t_raises(format('select helpdesk.resolve_ticket(%L)', :'tkt')) = '23514',
  'Müşteriye dönülmeden bilet çözülemez');

insert into helpdesk.messages (ticket_id, author_id, body)
values (:'tkt', '22222222-2222-2222-2222-222222222222',
        'Merhaba, servis ekibimiz bugün uğrayacak');

select public.t_assert(
  (select first_response_at from helpdesk.tickets where id = :'tkt') is not null,
  'Müşteriye giden mesaj ilk yanıt damgasını attı');

select public.t_assert(
  (select status from helpdesk.tickets where id = :'tkt') = 'open',
  'Bilet "yeni"den "açık"a geçti');

select public.t_assert(
  (select first_response_breached from helpdesk.tickets where id = :'tkt') = false,
  'İlk yanıt vadesinde verildi — ihlal yok');

\echo ''
\echo '=== 3. MÜŞTERİ BEKLERKEN SLA SAATİ DURUR ==='
select (select resolution_due from helpdesk.tickets where id = :'tkt') as due_once \gset

select helpdesk.wait_for_customer(:'tkt', 'Cihazın seri numarasını sorduk') is not null as _w \gset

select public.t_assert(
  (select status from helpdesk.tickets where id = :'tkt') = 'pending_customer'
  and (select paused_at from helpdesk.tickets where id = :'tkt') is not null,
  'Bilet müşteri beklemeye alındı, saat durduruldu');

-- Müşteri yanıt verince saat yeniden işler ve VADE ÖTELENİR
reset role;
update helpdesk.tickets set paused_at = now() - interval '45 minutes' where id = :'tkt';
set role sezra_app;
select set_config('app.user_id', '22222222-2222-2222-2222-222222222222', false);

insert into helpdesk.messages (ticket_id, author_name, body, is_from_customer)
values (:'tkt', 'Müşteri', 'Seri no: LM-88213', true);

select public.t_assert(
  (select status from helpdesk.tickets where id = :'tkt') = 'open',
  'Müşteri yanıt verince bilet yeniden açıldı');

select public.t_assert(
  (select paused_minutes from helpdesk.tickets where id = :'tkt') >= 44,
  'Bekleme süresi biriktirildi (~45 dk)',
  (select paused_minutes::text from helpdesk.tickets where id = :'tkt'));

select public.t_assert(
  (select resolution_due from helpdesk.tickets where id = :'tkt') > :'due_once'::timestamptz,
  'Çözüm vadesi bekleme kadar ötelendi — müşterinin gecikmesi bize yazılmadı');

\echo ''
\echo '=== 4. ÇÖZÜM VE KAPANIŞ ==='
select helpdesk.resolve_ticket(:'tkt', 'Basınç valfi değiştirildi') is not null as _r \gset

select public.t_assert(
  (select status from helpdesk.tickets where id = :'tkt') = 'resolved'
  and (select resolution_breached from helpdesk.tickets where id = :'tkt') = false,
  'Bilet çözüldü, SLA ihlali yok');

select public.t_assert(
  (select resolution_minutes from helpdesk.v_ticket_list where id = :'tkt') < 5,
  'Çözüm süresi BEKLEME DÜŞÜLEREK hesaplandı (45 dk bekleme sayılmadı)',
  (select resolution_minutes::text from helpdesk.v_ticket_list where id = :'tkt'));

select public.t_assert(
  public.t_raises(format('select helpdesk.close_ticket(%L, 5::smallint)', :'tkt')) = 'NO_ERROR',
  'Çözülmüş bilet memnuniyet puanıyla kapatıldı');

select public.t_assert(
  (select satisfaction from helpdesk.tickets where id = :'tkt') = 5,
  'Memnuniyet puanı kaydedildi');

select public.t_assert(
  public.t_raises(format(
    'update helpdesk.tickets set subject = ''degisti'' where id = %L', :'tkt')) = '23514',
  'Kapanmış bilet değiştirilemez');

\echo ''
\echo '=== 5. SLA İHLAL TARAMASI ==='
-- Vadesi geçmiş ama hiç yanıtlanmamış bir bilet: en kötü senaryo
insert into helpdesk.tickets (branch_id, subject, partner_id, priority)
values (:'duzce', 'Değirmen ses yapıyor', :'musteri', 'high')
returning id as tkt2 \gset

reset role;
update helpdesk.tickets
   set first_response_due = now() - interval '3 hours',
       resolution_due = now() - interval '1 hour'
 where id = :'tkt2';

select helpdesk.check_sla_breaches() as breaches \gset
set role sezra_app;
select set_config('app.user_id', '22222222-2222-2222-2222-222222222222', false);
select set_config('app.tenant_id', :'ornek', false);

select public.t_assert(
  :breaches = 1,
  'Vadesi geçen bilet ihlal olarak işaretlendi',
  :'breaches');

select public.t_assert(
  (select first_response_breached and resolution_breached
     from helpdesk.tickets where id = :'tkt2'),
  'Hem ilk yanıt hem çözüm ihlali işaretlendi');

select public.t_assert(
  (select count(*) from core.events where topic = 'helpdesk.ticket.sla_breached') = 1,
  'SLA ihlal olayı yayınlandı');

-- İkinci tarama aynı ihlali TEKRAR bildirmemeli
reset role;
select helpdesk.check_sla_breaches() as breaches2 \gset
set role sezra_app;
select set_config('app.user_id', '22222222-2222-2222-2222-222222222222', false);

select public.t_assert(
  :breaches2 = 0,
  'İhlal bir kez bildirilir, tarama tekrarlamaz',
  :'breaches2');

\echo ''
\echo '=== 6. RAPORLAR VE İZOLASYON ==='
select public.t_assert(
  (select ticket_count from helpdesk.v_partner_support where partner_id = :'musteri') = 2,
  'Müşteri bazlı destek yükü sayılıyor');

select public.t_assert(
  (select avg_satisfaction from helpdesk.v_partner_support where partner_id = :'musteri') = 5.00,
  'Memnuniyet ortalaması hesaplandı');

select public.t_assert(
  (select res_breach_count from helpdesk.v_sla_performance where priority = 'high') = 1,
  'SLA performans raporu ihlali gösteriyor');

select set_config('app.user_id', '55555555-5555-5555-5555-555555555555', false);
select public.t_assert(
  (select count(*) from helpdesk.tickets) = 0,
  'Başka kiracı Örnek Ticaret biletlerini göremez');

select public.t_assert(
  (select count(*) from helpdesk.messages) = 0,
  'Başka kiracı yazışmaları göremez');

reset role;
