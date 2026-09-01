-- =============================================================================
-- CRM uçtan uca akış testi: Teklif -> Sipariş -> Olay
-- Ayrıca: belge numaralandırma, KDV/tevkifat matematiği, denetim izi,
--         "RLS'siz tablo kalmadı" koruması.
-- =============================================================================
\set ON_ERROR_STOP on
set client_min_messages = notice;

create or replace function public.t_assert(p_ok boolean, p_label text, p_detail text default null)
returns void language plpgsql as $$
begin
  if p_ok then raise notice 'PASS  %', p_label;
  else raise exception 'FAIL  % %', p_label, coalesce('(' || p_detail || ')', ''); end if;
end $$;

-- Verilen SQL'in hangi hata koduyla patladığını döndürür ('NO_ERROR' = patlamadı).
-- psql değişkenleri ($$...$$ gövdesi içinde genişletilmediği için) DO bloğu yerine
-- format() ile buraya aktarılır.
create or replace function public.t_raises(p_sql text)
returns text language plpgsql as $$
begin
  execute p_sql;
  return 'NO_ERROR';
exception when others then
  return sqlstate;
end $$;

\echo ''
\echo '=== 1. TEKLİF TUTARLARI (KDV) ==='
set role sezra_app;
select set_config('app.user_id', '22222222-2222-2222-2222-222222222222', false);
select set_config('app.tenant_id', '', false);

select id as q_id from crm.quotations limit 1 \gset

-- 150 kg x 760,00 x %5 iskonto = 108.300,00 ; KDV %1 = 1.083,00
-- 400 ad x  70,00                =  28.000,00 ; KDV %10 = 2.800,00
select public.t_assert(
  (select subtotal from crm.quotations where id = :'q_id') = 136300.00,
  'Teklif ara toplamı doğru (136.300,00)',
  (select subtotal::text from crm.quotations where id = :'q_id'));

select public.t_assert(
  (select tax_total from crm.quotations where id = :'q_id') = 3883.00,
  'KDV toplamı doğru (3.883,00)',
  (select tax_total::text from crm.quotations where id = :'q_id'));

select public.t_assert(
  (select discount_total from crm.quotations where id = :'q_id') = 5700.00,
  'İskonto toplamı doğru (5.700,00)',
  (select discount_total::text from crm.quotations where id = :'q_id'));

select public.t_assert(
  (select total from crm.quotations where id = :'q_id') = 140183.00,
  'Genel toplam doğru (140.183,00)',
  (select total::text from crm.quotations where id = :'q_id'));

\echo ''
\echo '=== 2. TEVKİFATLI KDV ==='
do $$
declare
  v_tax uuid;
  v     core.line_amounts;
begin
  insert into core.taxes (tenant_id, code, name, rate, kind, withholding_num, withholding_den)
  values (core.current_tenant_id(), 'KDV20-T910', 'KDV %20 (9/10 tevkifat)', 20, 'withholding', 9, 10)
  returning id into v_tax;

  -- 10.000,00 matrah -> KDV 2.000,00 -> tevkifat 1.800,00 -> tahsil 10.200,00
  v := core.compute_line_amounts(10, 1000, 0, v_tax);
  perform public.t_assert(v.subtotal = 10000.00, '  Matrah 10.000,00', v.subtotal::text);
  perform public.t_assert(v.tax = 2000.00,       '  Hesaplanan KDV 2.000,00', v.tax::text);
  perform public.t_assert(v.withholding = 1800.00,'  Tevkifat 1.800,00 (9/10)', v.withholding::text);
  perform public.t_assert(v.total = 10200.00,    '  Tahsil edilecek 10.200,00', v.total::text);
end $$;

\echo ''
\echo '=== 3. TEKLİF -> SİPARİŞ AKIŞI ==='
select public.t_assert(
  (select number from crm.quotations where id = :'q_id') is null,
  'Taslak teklifin numarası henüz yok');

select crm.send_quotation(:'q_id'::uuid) is not null as sent \gset
select public.t_assert(
  (select number from crm.quotations where id = :'q_id') = 'TKL-' || to_char(now(),'YYYY') || '-00001',
  'Gönderilen teklife sıra numarası verildi',
  (select number from crm.quotations where id = :'q_id'));

select (crm.accept_quotation(:'q_id'::uuid)).id as so_id \gset

select public.t_assert(
  (select status from crm.quotations where id = :'q_id') = 'accepted',
  'Teklif onaylandı');

select public.t_assert(
  (select count(*) from crm.sale_order_lines where sale_order_id = :'so_id') = 2,
  'Sipariş satırları tekliften kopyalandı');

select public.t_assert(
  (select total from crm.sale_orders where id = :'so_id') = 140183.00,
  'Sipariş toplamı teklifle birebir aynı',
  (select total::text from crm.sale_orders where id = :'so_id'));

select public.t_assert(
  (select l.status from crm.leads l
    join crm.quotations q on q.lead_id = l.id where q.id = :'q_id') = 'won',
  'Bağlı fırsat otomatik "kazanıldı" oldu');

\echo ''
\echo '=== 4. KİLİTLİ BELGE ==='
select public.t_assert(
  public.t_raises(format(
    'update crm.quotation_lines set quantity = 999 where quotation_id = %L', :'q_id')) = '23514',
  'Onaylanmış teklifin satırları değiştirilemez',
  public.t_raises(format(
    'update crm.quotation_lines set quantity = 999 where quotation_id = %L', :'q_id')));

\echo ''
\echo '=== 5. SİPARİŞ ONAYI VE OLAY YAYINI ==='
select crm.confirm_sale_order(:'so_id'::uuid) is not null as ok \gset

select public.t_assert(
  (select number from crm.sale_orders where id = :'so_id') = 'SIP-' || to_char(now(),'YYYY') || '-00001',
  'Onaylanan siparişe sıra numarası verildi',
  (select number from crm.sale_orders where id = :'so_id'));

reset role;   -- core.events yalnızca yetkiyle okunur; doğrulamayı owner yapar
select public.t_assert(
  exists (select 1 from core.events where topic = 'sales.order.confirmed'
            and payload ->> 'sale_order_id' = :'so_id'),
  'sales.order.confirmed olayı yayınlandı');

select public.t_assert(
  (select jsonb_array_length(payload -> 'lines') from core.events
    where topic = 'sales.order.confirmed' and payload ->> 'sale_order_id' = :'so_id') = 2,
  'Olay yükü sipariş satırlarını taşıyor');

select public.t_assert(
  exists (select 1 from core.events where topic = 'crm.lead.won'),
  'crm.lead.won olayı yayınlandı');

-- Henüz abone yok (finance modülü sonraki fazda) -> teslimat satırı da yok
select public.t_assert(
  (select count(*) from core.event_deliveries) = 0,
  'Abone olmayan olay için teslimat kuyruğu boş (fan-out doğru)');

\echo ''
\echo '=== 6. DENETİM İZİ ==='
select public.t_assert(
  exists (select 1 from core.audit_log
           where entity_table = 'sale_orders' and action = 'update'
             and 'status' = any (changed_fields)),
  'Sipariş durum değişikliği audit_log''a yazıldı');

select public.t_assert(
  (select count(*) from core.audit_log where entity_schema = 'crm') > 0,
  'CRM tabloları denetleniyor');

\echo ''
\echo '=== 7. KORUMA: RLS''siz kiracı tablosu kalmadı ==='
do $$
declare v_missing text[];
begin
  select coalesce(array_agg(format('%s.%s', c.table_schema, c.table_name)), '{}')
    into v_missing
  from information_schema.columns c
  join pg_class pc on pc.relname = c.table_name
  join pg_namespace pn on pn.oid = pc.relnamespace and pn.nspname = c.table_schema
  where c.column_name = 'tenant_id'
    and c.table_schema in ('core','crm','finance','hr','purchasing')
    and pc.relkind = 'r'
    and not pc.relrowsecurity;

  if v_missing <> '{}'::text[] then
    raise exception 'FAIL  RLS''i açılmamış kiracı tablosu: %', array_to_string(v_missing, ', ');
  end if;
  raise notice 'PASS  tenant_id taşıyan tüm tablolarda RLS açık';
end $$;

do $$
declare v_missing text[];
begin
  select coalesce(array_agg(format('%s.%s', pn.nspname, pc.relname)), '{}') into v_missing
  from pg_class pc
  join pg_namespace pn on pn.oid = pc.relnamespace
  where pn.nspname in ('core','crm','finance','hr','purchasing')
    and pc.relkind = 'r' and pc.relrowsecurity and not pc.relforcerowsecurity;
  if v_missing <> '{}'::text[] then
    raise warning 'UYARI  FORCE RLS kapalı: %', array_to_string(v_missing, ', ');
  else
    raise notice 'PASS  Tüm RLS tablolarında FORCE açık (sahip rolü de kapsanıyor)';
  end if;
end $$;

do $$
declare v_bad text[];
begin
  select coalesce(array_agg(format('%s.%s', pn.nspname, pc.relname)), '{}') into v_bad
  from pg_class pc
  join pg_namespace pn on pn.oid = pc.relnamespace
  where pn.nspname in ('core','crm','finance','hr','purchasing')
    and pc.relkind = 'v'
    -- reloptions'da değer 'on' ya da 'true' olarak saklanabilir; ikisi de geçerli
    and coalesce((select option_value from pg_options_to_table(pc.reloptions)
                  where option_name = 'security_invoker'), 'false') not in ('on', 'true');
  if v_bad <> '{}'::text[] then
    raise exception 'FAIL  security_invoker kapalı view (RLS atlanır): %', array_to_string(v_bad, ', ');
  end if;
  raise notice 'PASS  Tüm view''ler security_invoker = on';
end $$;

drop function if exists public.t_assert(boolean, text, text);
drop function if exists public.t_raises(text);
\echo ''
\echo '=== AKIŞ TESTLERİ TAMAMLANDI ==='
