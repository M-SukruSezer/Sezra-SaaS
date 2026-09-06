-- =============================================================================
-- 0801 — POS iş kuralları
-- =============================================================================

-- -----------------------------------------------------------------------------
-- Satır matematiği
-- -----------------------------------------------------------------------------
-- KDV DAHİL fiyatta vergi eklenmez, İÇİNDEN AYRIŞTIRILIR:
--   brüt = adet × fiyat × (1 − iskonto)
--   matrah = brüt / (1 + oran)          KDV = brüt − matrah
-- KDV hariç fiyatta klasik yol izlenir. İkisini tek formülle yazmaya çalışmak,
-- yuvarlama farkını gizleyen bir kod üretirdi; ayrı tutuldu.
create or replace function pos.fn_calc_order_line()
returns trigger
language plpgsql
as $$
declare
  v_incl  boolean;
  v_gross numeric;
begin
  select t.prices_include_tax into v_incl
  from pos.orders o join pos.terminals t on t.id = o.terminal_id
  where o.id = new.order_id;

  if coalesce(v_incl, true) then
    v_gross := round(new.quantity * new.unit_price * (1 - new.discount_pct / 100), 2);
    new.line_total    := v_gross;
    new.line_subtotal := round(v_gross / (1 + new.tax_rate / 100), 2);
    new.line_tax      := v_gross - new.line_subtotal;
  else
    new.line_subtotal := round(new.quantity * new.unit_price * (1 - new.discount_pct / 100), 2);
    new.line_tax      := round(new.line_subtotal * new.tax_rate / 100, 2);
    new.line_total    := new.line_subtotal + new.line_tax;
  end if;

  return new;
end;
$$;

drop trigger if exists trg_pos_line_calc on pos.order_lines;
create trigger trg_pos_line_calc before insert or update on pos.order_lines
  for each row execute function pos.fn_calc_order_line();

create or replace function pos.fn_recalc_order()
returns trigger
language plpgsql
as $$
declare v_id uuid := coalesce(new.order_id, old.order_id);
begin
  update pos.orders o
     set subtotal = coalesce(s.sub, 0),
         tax_total = coalesce(s.tax, 0),
         total = coalesce(s.tot, 0),
         discount_total = coalesce(s.disc, 0)
  from (select sum(l.line_subtotal) as sub, sum(l.line_tax) as tax,
               sum(l.line_total) as tot,
               sum(round(l.quantity * l.unit_price * l.discount_pct / 100, 2)) as disc
          from pos.order_lines l where l.order_id = v_id) s
  where o.id = v_id;
  return null;
end;
$$;

drop trigger if exists trg_pos_order_rollup on pos.order_lines;
create trigger trg_pos_order_rollup after insert or update or delete on pos.order_lines
  for each row execute function pos.fn_recalc_order();

-- Ödeme değişince fişin ödenen toplamı tazelenir
create or replace function pos.fn_recalc_payments()
returns trigger
language plpgsql
as $$
declare v_id uuid := coalesce(new.order_id, old.order_id);
begin
  update pos.orders o
     set paid_total = coalesce(
           (select sum(p.amount) from pos.payments p where p.order_id = v_id), 0)
  where o.id = v_id;
  return null;
end;
$$;

drop trigger if exists trg_pos_payments_rollup on pos.payments;
create trigger trg_pos_payments_rollup after insert or update or delete on pos.payments
  for each row execute function pos.fn_recalc_payments();

-- -----------------------------------------------------------------------------
-- Kasa oturumu
-- -----------------------------------------------------------------------------
create or replace function pos.open_session(
  p_terminal_id uuid, p_opening_cash numeric default 0
)
returns pos.sessions
language plpgsql
security invoker
as $$
declare
  v_term pos.terminals;
  v_ses  pos.sessions;
begin
  if not core.has_perm('pos.session.create') then
    raise exception 'Kasa açma yetkiniz yok' using errcode = '42501';
  end if;

  select * into v_term from pos.terminals where id = p_terminal_id;
  if not found then raise exception 'Terminal bulunamadı' using errcode = 'P0002'; end if;
  if not v_term.is_active then
    raise exception 'Pasif terminalde kasa açılamaz (%)', v_term.code using errcode = '23514';
  end if;

  -- Aynı terminalde ikinci oturumu benzersizlik indeksi engeller; hatayı
  -- anlaşılır hâle getiriyoruz.
  if exists (select 1 from pos.sessions
              where terminal_id = p_terminal_id and status <> 'closed') then
    raise exception '% terminalinde zaten açık kasa var — önce kapatın', v_term.code
      using errcode = '23505';
  end if;

  insert into pos.sessions (branch_id, terminal_id, opening_cash, opened_by,
                            expected_cash, number)
  values (v_term.branch_id, p_terminal_id, coalesce(p_opening_cash, 0),
          core.current_user_id(), coalesce(p_opening_cash, 0),
          core.next_sequence('pos_session', v_term.branch_id))
  returning * into v_ses;

  return v_ses;
end;
$$;

-- Beklenen nakit: açılış + nakit satış − nakit iade + kasa girişi − kasa çıkışı
create or replace function pos.expected_cash(p_session_id uuid)
returns numeric
language sql
stable
security definer
set search_path = pos, pg_temp
as $$
  -- PARA ÜSTÜ DÜŞÜLÜR. pos.payments, müşterinin VERDİĞİ tutarı taşır (100 TL);
  -- çekmecede kalan ise verilen para üstü çıkarıldıktan sonrasıdır (95 TL).
  -- Bunu atlamak, para üstü verilen her fişte kasayı fazla gösterirdi.
  select round(
    s.opening_cash
    + coalesce((select sum(p.amount) from pos.payments p
                 join pos.orders o on o.id = p.order_id
                where o.session_id = s.id and p.method = 'cash'
                  and o.status in ('paid', 'refunded')), 0)
    - coalesce((select sum(o.change_given) from pos.orders o
                where o.session_id = s.id and o.status in ('paid', 'refunded')), 0)
    + coalesce((select sum(m.amount) from pos.cash_movements m
                where m.session_id = s.id and m.direction = 'in'), 0)
    - coalesce((select sum(m.amount) from pos.cash_movements m
                where m.session_id = s.id and m.direction = 'out'), 0)
  , 2)
  from pos.sessions s where s.id = p_session_id;
$$;

create or replace function pos.close_session(
  p_session_id uuid, p_counted_cash numeric, p_notes text default null
)
returns pos.sessions
language plpgsql
security invoker
as $$
declare
  v_ses  pos.sessions;
  v_open integer;
begin
  if not core.has_perm('pos.session.close') then
    raise exception 'Kasa kapatma yetkiniz yok' using errcode = '42501';
  end if;

  select * into v_ses from pos.sessions where id = p_session_id for update;
  if not found then raise exception 'Kasa oturumu bulunamadı' using errcode = 'P0002'; end if;
  if v_ses.status = 'closed' then
    raise exception 'Kasa zaten kapatılmış (%)', v_ses.number using errcode = '23514';
  end if;

  -- Ödenmemiş fiş varken kasa kapatılamaz: açık adisyon, sayılan nakitle
  -- beklenen nakit arasındaki farkı açıklanamaz hâle getirir.
  select count(*) into v_open from pos.orders
   where session_id = p_session_id and status = 'draft';
  if v_open > 0 then
    raise exception '% adet ödenmemiş fiş var — önce kapatın ya da iptal edin', v_open
      using errcode = '23514';
  end if;

  update pos.sessions s
     set status = 'closed',
         closed_at = now(),
         closed_by = core.current_user_id(),
         counted_cash = p_counted_cash,
         expected_cash = pos.expected_cash(p_session_id),
         notes = coalesce(p_notes, s.notes),
         order_count = (select count(*) from pos.orders o
                         where o.session_id = p_session_id and o.status = 'paid'),
         gross_sales = coalesce((select sum(o.total) from pos.orders o
                         where o.session_id = p_session_id and o.status = 'paid'), 0),
         discount_total = coalesce((select sum(o.discount_total) from pos.orders o
                         where o.session_id = p_session_id and o.status = 'paid'), 0),
         tax_total = coalesce((select sum(o.tax_total) from pos.orders o
                         where o.session_id = p_session_id and o.status = 'paid'), 0),
         net_sales = coalesce((select sum(o.subtotal) from pos.orders o
                         where o.session_id = p_session_id and o.status = 'paid'), 0),
         refund_total = coalesce((select sum(abs(o.total)) from pos.orders o
                         where o.session_id = p_session_id and o.status = 'refunded'), 0)
   where s.id = p_session_id
   returning * into v_ses;

  perform core.emit_event('pos.session.closed', jsonb_build_object(
    'session_id', v_ses.id, 'number', v_ses.number, 'terminal_id', v_ses.terminal_id,
    'opened_at', v_ses.opened_at, 'closed_at', v_ses.closed_at,
    'order_count', v_ses.order_count, 'gross_sales', v_ses.gross_sales,
    'net_sales', v_ses.net_sales, 'tax_total', v_ses.tax_total,
    'expected_cash', v_ses.expected_cash, 'counted_cash', v_ses.counted_cash,
    'cash_difference', v_ses.cash_difference,
    'payments', (select jsonb_object_agg(x.method, x.amount) from (
                   select p.method::text as method, sum(p.amount) as amount
                   from pos.payments p join pos.orders o on o.id = p.order_id
                   where o.session_id = v_ses.id and o.status in ('paid','refunded')
                   group by p.method) x)
  ), v_ses.branch_id, null, v_ses.tenant_id);

  return v_ses;
end;
$$;

-- -----------------------------------------------------------------------------
-- Fiş kapatma
-- -----------------------------------------------------------------------------
create or replace function pos.finalize_order(p_order_id uuid)
returns pos.orders
language plpgsql
security invoker
as $$
declare
  v_ord   pos.orders;
  v_ses   pos.sessions;
  v_lines jsonb;
begin
  select * into v_ord from pos.orders where id = p_order_id for update;
  if not found then raise exception 'Fiş bulunamadı' using errcode = 'P0002'; end if;
  if v_ord.status <> 'draft' then
    -- İDEMPOTANLIK: kasa aynı fişi tekrar gönderebilir (bağlantı koptu, yeniden
    -- denedi). Hata vermek yerine mevcut hâli döndürüyoruz.
    return v_ord;
  end if;
  if not exists (select 1 from pos.order_lines where order_id = p_order_id) then
    raise exception 'Boş fiş kapatılamaz' using errcode = '23514';
  end if;

  select * into v_ses from pos.sessions where id = v_ord.session_id;
  if v_ses.status = 'closed' then
    raise exception 'Kapanmış kasaya fiş eklenemez (%)', v_ses.number using errcode = '23514';
  end if;

  if v_ord.paid_total < v_ord.total then
    raise exception 'Ödeme eksik: toplam %, ödenen %', v_ord.total, v_ord.paid_total
      using errcode = '23514';
  end if;

  update pos.orders
     set status = 'paid',
         change_given = greatest(paid_total - total, 0),
         receipt_no = coalesce(receipt_no,
                        core.next_sequence('pos_receipt', branch_id, tenant_id)),
         synced_at = coalesce(synced_at, now())
   where id = p_order_id returning * into v_ord;

  select jsonb_agg(jsonb_build_object(
           'product_id', l.product_id, 'quantity', l.quantity,
           'unit_price', l.unit_price, 'name', l.name))
    into v_lines
  from pos.order_lines l where l.order_id = p_order_id and l.product_id is not null;

  -- Envanter bu olayı dinleyip stoku HEMEN düşer (0800, karar 2).
  perform core.emit_event('pos.sale.completed', jsonb_build_object(
    'order_id', v_ord.id, 'receipt_no', v_ord.receipt_no,
    'session_id', v_ord.session_id, 'terminal_id', v_ord.terminal_id,
    'ordered_at', v_ord.ordered_at, 'total', v_ord.total, 'tax_total', v_ord.tax_total,
    'lines', coalesce(v_lines, '[]'::jsonb)
  ), v_ord.branch_id, null, v_ord.tenant_id);

  return v_ord;
end;
$$;

-- -----------------------------------------------------------------------------
-- Offline senkronizasyon
-- -----------------------------------------------------------------------------
-- Kasa, internet gelince biriken fişleri toplu gönderir. Fonksiyon
-- İDEMPOTENTTİR: aynı paket defalarca gönderilse de fiş bir kez oluşur.
-- Kimlik cihazdan geldiği için (0800, karar 1) çakışma çözümü basittir:
-- id zaten varsa dokunma.
create or replace function pos.sync_orders(p_orders jsonb)
returns jsonb
language plpgsql
security invoker
as $$
declare
  v_ord     jsonb;
  v_line    jsonb;
  v_pay     jsonb;
  v_id      uuid;
  v_created integer := 0;
  v_skipped integer := 0;
  v_seq     smallint;
begin
  for v_ord in select * from jsonb_array_elements(p_orders)
  loop
    v_id := (v_ord ->> 'id')::uuid;
    if v_id is null then
      raise exception 'Senkronizasyonda fiş id''si zorunlu (kasa üretir)'
        using errcode = '22023';
    end if;

    if exists (select 1 from pos.orders where id = v_id) then
      v_skipped := v_skipped + 1;
      continue;
    end if;

    insert into pos.orders (
      id, branch_id, session_id, terminal_id, client_seq, ordered_at,
      partner_id, cashier_id, note, synced_at)
    values (
      v_id,
      nullif(v_ord ->> 'branch_id', '')::uuid,
      (v_ord ->> 'session_id')::uuid,
      (v_ord ->> 'terminal_id')::uuid,
      nullif(v_ord ->> 'client_seq', '')::bigint,
      coalesce((v_ord ->> 'ordered_at')::timestamptz, now()),
      nullif(v_ord ->> 'partner_id', '')::uuid,
      nullif(v_ord ->> 'cashier_id', '')::uuid,
      v_ord ->> 'note',
      now());

    v_seq := 10;
    for v_line in select * from jsonb_array_elements(v_ord -> 'lines')
    loop
      insert into pos.order_lines (
        order_id, sequence, product_id, sku, name, quantity, uom_code,
        unit_price, discount_pct, tax_id, tax_rate, note)
      values (
        v_id, v_seq,
        nullif(v_line ->> 'product_id', '')::uuid,
        v_line ->> 'sku',
        coalesce(v_line ->> 'name', 'Ürün'),
        coalesce((v_line ->> 'quantity')::numeric, 1),
        v_line ->> 'uom_code',
        coalesce((v_line ->> 'unit_price')::numeric, 0),
        coalesce((v_line ->> 'discount_pct')::numeric, 0),
        nullif(v_line ->> 'tax_id', '')::uuid,
        coalesce((v_line ->> 'tax_rate')::numeric, 0),
        v_line ->> 'note');
      v_seq := v_seq + 10;
    end loop;

    for v_pay in select * from jsonb_array_elements(v_ord -> 'payments')
    loop
      insert into pos.payments (order_id, method, amount, reference, card_last4)
      values (
        v_id,
        (v_pay ->> 'method')::pos.payment_method,
        coalesce((v_pay ->> 'amount')::numeric, 0),
        v_pay ->> 'reference',
        nullif(v_pay ->> 'card_last4', ''));
    end loop;

    -- Kasa fişi kapatıp gönderdiyse burada da kapatılır
    if coalesce(v_ord ->> 'status', 'paid') = 'paid' then
      perform pos.finalize_order(v_id);
    end if;

    v_created := v_created + 1;
  end loop;

  return jsonb_build_object('created', v_created, 'skipped', v_skipped);
end;
$$;

-- -----------------------------------------------------------------------------
-- İade
-- -----------------------------------------------------------------------------
-- İade, orijinal fişi DEĞİŞTİRMEZ; eksi tutarlı yeni bir fiş üretir. Satılan
-- fişi düzeltmek, gün sonu raporunu geçmişe dönük değiştirmek olurdu.
create or replace function pos.refund_order(
  p_order_id uuid, p_session_id uuid, p_reason text default null
)
returns pos.orders
language plpgsql
security invoker
as $$
declare
  v_src pos.orders;
  v_new pos.orders;
  r     record;
  p     record;
begin
  if not core.has_perm('pos.order.refund') then
    raise exception 'İade yetkiniz yok' using errcode = '42501';
  end if;

  select * into v_src from pos.orders where id = p_order_id;
  if not found then raise exception 'Fiş bulunamadı' using errcode = 'P0002'; end if;
  if v_src.status <> 'paid' then
    raise exception 'Yalnızca ödenmiş fiş iade edilebilir (mevcut: %)', v_src.status
      using errcode = '23514';
  end if;
  if exists (select 1 from pos.orders where refund_of_id = p_order_id) then
    raise exception 'Bu fiş zaten iade edilmiş' using errcode = '23505';
  end if;

  insert into pos.orders (branch_id, session_id, terminal_id, ordered_at,
                          partner_id, cashier_id, refund_of_id, note)
  values (v_src.branch_id, p_session_id, v_src.terminal_id, now(),
          v_src.partner_id, core.current_user_id(), p_order_id,
          coalesce(p_reason, 'İade: ' || coalesce(v_src.receipt_no, '')))
  returning * into v_new;

  for r in select * from pos.order_lines where order_id = p_order_id order by sequence
  loop
    insert into pos.order_lines (order_id, sequence, product_id, sku, name,
                                 quantity, uom_code, unit_price, discount_pct,
                                 tax_id, tax_rate)
    values (v_new.id, r.sequence, r.product_id, r.sku, r.name,
            -r.quantity, r.uom_code, r.unit_price, r.discount_pct, r.tax_id, r.tax_rate);
  end loop;

  -- İADE, MÜŞTERİNİN VERDİĞİNİ DEĞİL, SATIŞIN TUTARINI GERİ VERİR.
  -- pos.payments tendere edilen parayı taşır: 95 TL'lik satışa 100 TL verilip
  -- 5 TL para üstü alınmışsa, iade 100 değil 95 TL'dir. Ödemeyi olduğu gibi
  -- ters çevirmek müşteriye para üstü kadar FAZLA ödeme yapardı.
  --
  -- Para üstü her zaman nakit verildiği için yöntem başına NET katkı:
  --   nakit dışı -> tutarın kendisi
  --   nakit      -> tutar − verilen para üstü
  -- Bu net katkıların toplamı fişin tutarına eşittir.
  -- Tablo takma adı `pay`: PL/pgSQL'de döngü DEĞİŞKENİ, sorgudaki aynı adlı
  -- tablo takma adını gölgeler ve "record is not assigned yet" hatası verir.
  for p in
    select pay.method,
           pay.amount - case when pay.method = 'cash' then v_src.change_given else 0 end
             as net_amount
    from pos.payments pay
    where pay.order_id = p_order_id
  loop
    if p.net_amount <> 0 then
      insert into pos.payments (order_id, method, amount, reference)
      values (v_new.id, p.method, -p.net_amount, 'İade');
    end if;
  end loop;

  update pos.orders
     set status = 'refunded',
         receipt_no = coalesce(receipt_no,
                        core.next_sequence('pos_receipt', branch_id, tenant_id))
   where id = v_new.id returning * into v_new;

  perform core.emit_event('pos.sale.refunded', jsonb_build_object(
    'order_id', v_new.id, 'refund_of_id', p_order_id,
    'receipt_no', v_new.receipt_no, 'total', v_new.total,
    'lines', (select jsonb_agg(jsonb_build_object(
                'product_id', l.product_id, 'quantity', l.quantity))
              from pos.order_lines l where l.order_id = v_new.id and l.product_id is not null)
  ), v_new.branch_id, null, v_new.tenant_id);

  return v_new;
end;
$$;

-- Kapanmış kasa ve ödenmiş fiş değiştirilemez.
create or replace function pos.fn_lock_paid_order()
returns trigger
language plpgsql
as $$
begin
  if tg_op = 'DELETE' then
    if old.status in ('paid', 'refunded') then
      raise exception 'Kapatılmış fiş silinemez (%)', old.receipt_no using errcode = '23514';
    end if;
    return old;
  end if;
  if old.status in ('paid', 'refunded') and new.status = old.status
     and (new.total, new.session_id, new.terminal_id) is distinct from
         (old.total, old.session_id, old.terminal_id) then
    raise exception 'Kapatılmış fiş değiştirilemez (%) — düzeltme İADE ile yapılır',
      old.receipt_no using errcode = '23514';
  end if;
  return new;
end;
$$;

drop trigger if exists trg_pos_order_lock on pos.orders;
create trigger trg_pos_order_lock before update or delete on pos.orders
  for each row execute function pos.fn_lock_paid_order();

select core.declare_event('pos.sale.completed', 'pos', 'Kasa satışı tamamlandı');
select core.declare_event('pos.sale.refunded',  'pos', 'Kasa satışı iade edildi');
select core.declare_event('pos.session.closed', 'pos',
       'Kasa kapatıldı — Z raporu ve muhasebe kaydı bu olaydan doğar');
