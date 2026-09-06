-- =============================================================================
-- 0803 — POS köprüleri ve raporları
-- =============================================================================
-- Handler'lar ait oldukları modülün adını taşır (0305/0503/0703 kuralı).
-- POS, Envanter ve Muhasebe'nin varlığını bilmez.

-- -----------------------------------------------------------------------------
-- Envanter: kasa satışı stoku HEMEN düşer
-- -----------------------------------------------------------------------------
-- Satış siparişinde rezervasyon yapıyoruz çünkü mal sonra sevk edilir (0503).
-- Kasada müşteri malı alıp çıkar — rezervasyon aşaması yoktur (0800, karar 2).
create or replace function inventory.on_pos_sale_completed(p_event jsonb)
returns void
language plpgsql
security definer
set search_path = inventory, core, pg_temp
as $$
declare
  v_tenant  uuid  := (p_event ->> 'tenant_id')::uuid;
  v_branch  uuid  := nullif(p_event ->> 'branch_id', '')::uuid;
  v_payload jsonb := p_event -> 'payload';
  v_order   uuid  := (v_payload ->> 'order_id')::uuid;
  v_line    jsonb;
  v_qty     numeric;
begin
  if exists (
    select 1 from inventory.moves
    where tenant_id = v_tenant and source_module = 'pos'
      and source_table = 'orders' and source_id = v_order
  ) then
    return;
  end if;

  for v_line in select * from jsonb_array_elements(v_payload -> 'lines')
  loop
    if not exists (
      select 1 from core.products p
      where p.id = nullif(v_line ->> 'product_id', '')::uuid and p.kind = 'stockable'
    ) then
      continue;
    end if;

    v_qty := coalesce((v_line ->> 'quantity')::numeric, 0);
    if v_qty <= 0 then continue; end if;

    perform inventory.deliver_stock(
      v_tenant, v_branch, (v_line ->> 'product_id')::uuid, v_qty,
      'pos', 'orders', v_order, coalesce(v_payload ->> 'receipt_no', ''));
  end loop;
end;
$$;

-- İade: mal geri gelir, stoka girer. Maliyet o anki ortalamadır — iade edilen
-- malın alış maliyetini geri hesaplamak, kapanmış ayın maliyetini değiştirirdi.
create or replace function inventory.on_pos_sale_refunded(p_event jsonb)
returns void
language plpgsql
security definer
set search_path = inventory, core, pg_temp
as $$
declare
  v_tenant  uuid  := (p_event ->> 'tenant_id')::uuid;
  v_branch  uuid  := nullif(p_event ->> 'branch_id', '')::uuid;
  v_payload jsonb := p_event -> 'payload';
  v_order   uuid  := (v_payload ->> 'order_id')::uuid;
  v_line    jsonb;
  v_qty     numeric;
  v_cost    numeric;
begin
  if exists (
    select 1 from inventory.moves
    where tenant_id = v_tenant and source_module = 'pos'
      and source_table = 'orders' and source_id = v_order
  ) then
    return;
  end if;

  for v_line in select * from jsonb_array_elements(v_payload -> 'lines')
  loop
    if not exists (
      select 1 from core.products p
      where p.id = nullif(v_line ->> 'product_id', '')::uuid and p.kind = 'stockable'
    ) then
      continue;
    end if;

    -- İade satırında miktar EKSİ gelir; stok girişi için mutlak değeri alınır.
    v_qty := abs(coalesce((v_line ->> 'quantity')::numeric, 0));
    if v_qty = 0 then continue; end if;

    select average_cost into v_cost from inventory.product_costs
     where tenant_id = v_tenant and product_id = (v_line ->> 'product_id')::uuid;

    perform inventory.receive_stock(
      v_tenant, v_branch, (v_line ->> 'product_id')::uuid, v_qty,
      coalesce(v_cost, 0), null,
      'pos', 'orders', v_order, coalesce(v_payload ->> 'receipt_no', ''));
  end loop;
end;
$$;

select core.subscribe('pos.sale.completed', 'inventory', 'inventory.on_pos_sale_completed');
select core.subscribe('pos.sale.refunded',  'inventory', 'inventory.on_pos_sale_refunded');

-- -----------------------------------------------------------------------------
-- Muhasebe: kasa kapanışından yevmiye kaydı
-- -----------------------------------------------------------------------------
-- Fiş başına kayıt ATILMAZ. Günde binlerce fiş kesen bir satış noktasında her fiş için
-- yevmiye maddesi açmak defteri kullanılamaz hâle getirir; muhasebe pratiği de
-- gün sonu icmalidir. Kayıt kasa kapanışında, ödeme türü kırılımıyla atılır.
create or replace function finance.on_pos_session_closed(p_event jsonb)
returns void
language plpgsql
security definer
set search_path = finance, core, pos, pg_temp
as $$
declare
  v_tenant   uuid  := (p_event ->> 'tenant_id')::uuid;
  v_branch   uuid  := nullif(p_event ->> 'branch_id', '')::uuid;
  v_payload  jsonb := p_event -> 'payload';
  v_session  uuid  := (v_payload ->> 'session_id')::uuid;
  v_entry    uuid;
  v_journal  uuid;
  v_cash     numeric;
  v_noncash  numeric;
  v_change   numeric;
  v_net      numeric;
  v_tax      numeric;
  v_gross    numeric;
begin
  if exists (
    select 1 from finance.journal_entries
    where tenant_id = v_tenant and source_module = 'pos'
      and source_table = 'sessions' and source_id = v_session
  ) then
    return;
  end if;

  -- Rakamlar Z RAPORU ÖZETİNDEN DEĞİL, FİŞLERDEN hesaplanır.
  -- Z raporu brüt satışı ve iadeyi AYRI gösterir (kasiyer için doğru olan
  -- budur); muhasebe ise NET geliri ister. İkisini karıştırmak, iade olan bir
  -- vardiyada borç–alacak dengesini bozar: para tarafı iadeyi düşer, gelir
  -- tarafı düşmezdi.
  select coalesce(sum(o.subtotal), 0), coalesce(sum(o.tax_total), 0),
         coalesce(sum(o.total), 0), coalesce(sum(o.change_given), 0)
    into v_net, v_tax, v_gross, v_change
  from pos.orders o
  where o.session_id = v_session and o.status in ('paid', 'refunded');

  if v_gross = 0 then return; end if;

  select id into v_journal from finance.journals
   where tenant_id = v_tenant and kind = 'cash' limit 1;
  if v_journal is null then
    select id into v_journal from finance.journals
     where tenant_id = v_tenant and kind = 'general' limit 1;
  end if;
  if v_journal is null then
    raise exception 'Kasa yevmiyesi tanımsız (kiracı %)', v_tenant;
  end if;

  -- Nakit tarafında PARA ÜSTÜ düşülür: pos.payments müşterinin verdiğini
  -- taşır, çekmeceye giren ise para üstü çıktıktan sonrasıdır (0801'deki
  -- pos.expected_cash ile aynı kural).
  select coalesce(sum(p.amount) filter (where p.method = 'cash'), 0) - v_change,
         coalesce(sum(p.amount) filter (where p.method <> 'cash'), 0)
    into v_cash, v_noncash
  from pos.payments p
  join pos.orders o on o.id = p.order_id
  where o.session_id = v_session and o.status in ('paid', 'refunded');

  insert into finance.journal_entries (
    tenant_id, branch_id, journal_id, entry_date, reference, description,
    status, source_module, source_table, source_id)
  values (
    v_tenant, v_branch, v_journal,
    coalesce((v_payload ->> 'closed_at')::timestamptz::date, current_date),
    v_payload ->> 'number',
    format('Kasa icmali %s (%s fiş)', coalesce(v_payload ->> 'number', ''),
           coalesce(v_payload ->> 'order_count', '0')),
    'draft', 'pos', 'sessions', v_session)
  returning id into v_entry;

  -- Borç: tahsil edilen para (nakit + kart/diğer)
  if v_cash <> 0 then
    insert into finance.journal_entry_lines
      (tenant_id, entry_id, sequence, account_id, description, debit)
    values (v_tenant, v_entry, 10, finance.mapped_account('cash', v_tenant),
            'Kasa nakit tahsilat', v_cash);
  end if;
  if v_noncash <> 0 then
    insert into finance.journal_entry_lines
      (tenant_id, entry_id, sequence, account_id, description, debit)
    values (v_tenant, v_entry, 20, finance.mapped_account('bank', v_tenant),
            'Kart / diğer tahsilat', v_noncash);
  end if;

  -- Alacak: satış geliri ve hesaplanan KDV
  insert into finance.journal_entry_lines
    (tenant_id, entry_id, sequence, account_id, description, credit)
  values
    (v_tenant, v_entry, 30, finance.mapped_account('sales_income', v_tenant),
     'Perakende satış geliri', v_net),
    (v_tenant, v_entry, 40, finance.mapped_account('vat_output', v_tenant),
     'Hesaplanan KDV', v_tax);

  perform core.emit_event('finance.entry.drafted', jsonb_build_object(
    'entry_id', v_entry, 'source_module', 'pos', 'source_id', v_session,
    'total', v_gross
  ), v_branch, null, v_tenant);
end;
$$;

select core.subscribe('pos.session.closed', 'finance', 'finance.on_pos_session_closed');

-- -----------------------------------------------------------------------------
-- Raporlar
-- -----------------------------------------------------------------------------
create or replace view pos.v_session_list
with (security_invoker = on) as
select
  s.id, s.tenant_id, s.branch_id, s.number, s.status,
  s.terminal_id, t.code as terminal_code, t.name as terminal_name,
  s.opened_at, s.closed_at,
  s.opened_by, uo.full_name as opened_by_name,
  s.closed_by, uc.full_name as closed_by_name,
  s.opening_cash, s.counted_cash, s.expected_cash, s.cash_difference,
  s.order_count, s.gross_sales, s.discount_total, s.tax_total, s.net_sales, s.refund_total,
  b.name as branch_name, s.notes,
  -- Vardiya süresi
  case when s.closed_at is not null
       then round(extract(epoch from (s.closed_at - s.opened_at)) / 3600, 1) end as hours_open
from pos.sessions s
join pos.terminals t on t.id = s.terminal_id
left join core.users uo on uo.id = s.opened_by
left join core.users uc on uc.id = s.closed_by
left join core.branches b on b.id = s.branch_id;

create or replace view pos.v_order_list
with (security_invoker = on) as
select
  o.id, o.tenant_id, o.branch_id, o.receipt_no, o.status,
  o.session_id, s.number as session_number,
  o.terminal_id, t.code as terminal_code,
  o.ordered_at, o.synced_at, o.client_seq,
  o.cashier_id, u.full_name as cashier_name,
  o.partner_id, pa.name as partner_name,
  o.subtotal, o.discount_total, o.tax_total, o.total, o.paid_total, o.change_given,
  o.refund_of_id, ro.receipt_no as refund_of_receipt,
  b.name as branch_name, o.note,
  (select count(*) from pos.order_lines l where l.order_id = o.id) as line_count,
  (select string_agg(distinct p.method::text, ', ') from pos.payments p
    where p.order_id = o.id) as payment_methods
from pos.orders o
join pos.sessions s on s.id = o.session_id
join pos.terminals t on t.id = o.terminal_id
left join core.users u on u.id = o.cashier_id
left join core.partners pa on pa.id = o.partner_id
left join pos.orders ro on ro.id = o.refund_of_id
left join core.branches b on b.id = o.branch_id;

-- Günlük satış icmali — şube ve terminal kırılımıyla
create or replace view pos.v_daily_sales
with (security_invoker = on) as
select
  o.tenant_id, o.branch_id, b.name as branch_name,
  o.terminal_id, t.code as terminal_code,
  o.ordered_at::date as sale_date,
  count(*) filter (where o.status = 'paid')     as order_count,
  count(*) filter (where o.status = 'refunded') as refund_count,
  coalesce(sum(o.subtotal) filter (where o.status = 'paid'), 0)  as net_sales,
  coalesce(sum(o.tax_total) filter (where o.status = 'paid'), 0) as tax_total,
  coalesce(sum(o.total) filter (where o.status = 'paid'), 0)     as gross_sales,
  coalesce(sum(abs(o.total)) filter (where o.status = 'refunded'), 0) as refund_total,
  -- Sepet ortalaması: satış noktasında en çok bakılan tek sayı
  round(coalesce(sum(o.total) filter (where o.status = 'paid'), 0)
        / nullif(count(*) filter (where o.status = 'paid'), 0), 2) as average_basket
from pos.orders o
join pos.terminals t on t.id = o.terminal_id
left join core.branches b on b.id = o.branch_id
group by o.tenant_id, o.branch_id, b.name, o.terminal_id, t.code, o.ordered_at::date;

-- Saatlik yoğunluk: vardiya planlaması bu tabloyla yapılır (İK ile birleşir)
create or replace view pos.v_hourly_sales
with (security_invoker = on) as
select
  o.tenant_id, o.branch_id, b.name as branch_name,
  extract(hour from o.ordered_at)::smallint as hour_of_day,
  extract(isodow from o.ordered_at)::smallint as day_of_week,
  count(*)                                   as order_count,
  coalesce(sum(o.total), 0)                  as gross_sales,
  round(coalesce(sum(o.total), 0) / nullif(count(*), 0), 2) as average_basket
from pos.orders o
left join core.branches b on b.id = o.branch_id
where o.status = 'paid'
group by o.tenant_id, o.branch_id, b.name,
         extract(hour from o.ordered_at), extract(isodow from o.ordered_at);

-- Ürün bazlı satış — menü kararlarının dayanağı
create or replace view pos.v_product_sales
with (security_invoker = on) as
select
  l.tenant_id, o.branch_id, b.name as branch_name,
  l.product_id, l.sku, l.name as product_name,
  sum(l.quantity)      as quantity_sold,
  sum(l.line_total)    as gross_sales,
  sum(l.line_subtotal) as net_sales,
  count(distinct o.id) as order_count
from pos.order_lines l
join pos.orders o on o.id = l.order_id
left join core.branches b on b.id = o.branch_id
where o.status = 'paid'
group by l.tenant_id, o.branch_id, b.name, l.product_id, l.sku, l.name;

-- Ödeme türü kırılımı — banka mutabakatının girdisi
create or replace view pos.v_payment_breakdown
with (security_invoker = on) as
select
  p.tenant_id, o.branch_id, b.name as branch_name,
  o.session_id, s.number as session_number,
  o.ordered_at::date as sale_date,
  p.method,
  count(*)               as payment_count,
  coalesce(sum(p.amount), 0) as amount
from pos.payments p
join pos.orders o on o.id = p.order_id
join pos.sessions s on s.id = o.session_id
left join core.branches b on b.id = o.branch_id
where o.status in ('paid', 'refunded')
group by p.tenant_id, o.branch_id, b.name, o.session_id, s.number,
         o.ordered_at::date, p.method;
