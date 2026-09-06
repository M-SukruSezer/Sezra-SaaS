-- =============================================================================
-- 0401 — Satın Alma iş kuralları
-- =============================================================================

-- Satır tutarları ve başlık toplamları çekirdek motordan gelir (0011).
select core.attach_document_line_math('purchasing', 'requisition_lines',
                                      'purchasing.requisitions', 'requisition_id');
select core.attach_document_line_math('purchasing', 'order_lines',
                                      'purchasing.orders', 'order_id');

-- -----------------------------------------------------------------------------
-- Tedarikçi fiyat önerisi
-- -----------------------------------------------------------------------------
-- Verilen ürün ve miktar için geçerli en iyi fiyatı bulur. Kademeli fiyatta
-- miktarı KARŞILAYAN en yüksek kademe seçilir (min_quantity <= miktar), sonra
-- en ucuz olan. Sipariş satırı açılırken fiyatın elle girilmesini gereksiz kılar.
create or replace function purchasing.best_supplier_price(
  p_product_id uuid, p_quantity numeric default 1, p_partner_id uuid default null
)
returns purchasing.supplier_prices
language sql
stable
as $$
  select *
  from purchasing.supplier_prices sp
  where sp.product_id = p_product_id
    and sp.is_active
    and sp.min_quantity <= p_quantity
    and sp.valid_from <= current_date
    and (sp.valid_to is null or sp.valid_to >= current_date)
    and (p_partner_id is null or sp.partner_id = p_partner_id)
  order by sp.min_quantity desc, sp.unit_price asc
  limit 1;
$$;

-- -----------------------------------------------------------------------------
-- Talep akışı
-- -----------------------------------------------------------------------------
create or replace function purchasing.submit_requisition(p_id uuid)
returns purchasing.requisitions
language plpgsql
security invoker
as $$
declare v_req purchasing.requisitions;
begin
  select * into v_req from purchasing.requisitions where id = p_id for update;
  if not found then raise exception 'Talep bulunamadı' using errcode = 'P0002'; end if;
  if v_req.status <> 'draft' then
    raise exception 'Yalnızca taslak talep gönderilebilir (mevcut: %)', v_req.status
      using errcode = '23514';
  end if;
  if not exists (select 1 from purchasing.requisition_lines where requisition_id = p_id) then
    raise exception 'Satırı olmayan talep gönderilemez' using errcode = '23514';
  end if;

  update purchasing.requisitions set status = 'pending' where id = p_id returning * into v_req;
  return v_req;
end;
$$;

create or replace function purchasing.approve_requisition(p_id uuid)
returns purchasing.requisitions
language plpgsql
security invoker
as $$
declare v_req purchasing.requisitions;
begin
  if not core.has_perm('purchasing.requisition.approve') then
    raise exception 'Talep onaylama yetkiniz yok' using errcode = '42501';
  end if;

  select * into v_req from purchasing.requisitions where id = p_id for update;
  if not found then raise exception 'Talep bulunamadı' using errcode = 'P0002'; end if;
  if v_req.status <> 'pending' then
    raise exception 'Yalnızca onay bekleyen talep onaylanabilir (mevcut: %)', v_req.status
      using errcode = '23514';
  end if;

  -- Kendi talebini onaylayamaz (İK'daki izin onayıyla aynı gerekçe: onay bir
  -- kontroldür, kontrolü isteyenin kendisine bırakmak onu kontrol olmaktan çıkarır).
  if v_req.owner_id = core.current_user_id()
     and not core.has_perm('purchasing.requisition.self_approve') then
    raise exception 'Kendi satın alma talebinizi onaylayamazsınız' using errcode = '42501';
  end if;

  update purchasing.requisitions
     set status = 'approved', approver_id = core.current_user_id(), approved_at = now(),
         number = coalesce(number, core.next_sequence('purchase_requisition', branch_id))
   where id = p_id returning * into v_req;

  perform core.emit_event('purchasing.requisition.approved', jsonb_build_object(
    'requisition_id', v_req.id, 'number', v_req.number, 'total', v_req.total,
    'suggested_partner_id', v_req.suggested_partner_id
  ), v_req.branch_id);

  return v_req;
end;
$$;

create or replace function purchasing.reject_requisition(p_id uuid, p_reason text default null)
returns purchasing.requisitions
language plpgsql
security invoker
as $$
declare v_req purchasing.requisitions;
begin
  if not core.has_perm('purchasing.requisition.approve') then
    raise exception 'Talep onaylama yetkiniz yok' using errcode = '42501';
  end if;
  update purchasing.requisitions
     set status = 'rejected', approver_id = core.current_user_id(),
         approved_at = now(), rejection_reason = p_reason
   where id = p_id and status = 'pending'
   returning * into v_req;
  if not found then
    raise exception 'Onay bekleyen talep bulunamadı' using errcode = 'P0002';
  end if;
  return v_req;
end;
$$;

-- -----------------------------------------------------------------------------
-- Talepten sipariş üretme
-- -----------------------------------------------------------------------------
-- Onaylı talep, seçilen tedarikçiyle siparişe dönüşür. Fiyat, tedarikçi fiyat
-- listesinden GÜNCEL değerle tazelenir: talep haftalar önce açılmış olabilir.
create or replace function purchasing.create_order_from_requisition(
  p_requisition_id uuid, p_partner_id uuid
)
returns purchasing.orders
language plpgsql
security invoker
as $$
declare
  v_req   purchasing.requisitions;
  v_order purchasing.orders;
  r       record;
  v_price purchasing.supplier_prices;
begin
  select * into v_req from purchasing.requisitions where id = p_requisition_id for update;
  if not found then raise exception 'Talep bulunamadı' using errcode = 'P0002'; end if;
  if v_req.status <> 'approved' then
    raise exception 'Yalnızca onaylanmış talepten sipariş açılabilir (mevcut: %)', v_req.status
      using errcode = '23514';
  end if;

  insert into purchasing.orders (branch_id, partner_id, requisition_id, currency,
                                 promised_date, notes, owner_id)
  values (v_req.branch_id, p_partner_id, p_requisition_id, v_req.currency,
          v_req.needed_by, v_req.notes, core.current_user_id())
  returning * into v_order;

  for r in
    select * from purchasing.requisition_lines
     where requisition_id = p_requisition_id order by sequence
  loop
    v_price := null;
    if r.product_id is not null then
      v_price := purchasing.best_supplier_price(r.product_id, r.quantity, p_partner_id);
    end if;

    insert into purchasing.order_lines (
      order_id, requisition_line_id, sequence, product_id, description,
      quantity, uom_id, unit_price, discount_pct, tax_id)
    values (
      v_order.id, r.id, r.sequence, r.product_id, r.description,
      r.quantity, coalesce(v_price.uom_id, r.uom_id),
      -- Fiyat listesi varsa o, yoksa talepteki tahmini fiyat
      coalesce(v_price.unit_price, r.unit_price),
      r.discount_pct, r.tax_id);
  end loop;

  update purchasing.requisitions set status = 'ordered' where id = p_requisition_id;

  select * into v_order from purchasing.orders where id = v_order.id;
  return v_order;
end;
$$;

-- -----------------------------------------------------------------------------
-- Sipariş akışı
-- -----------------------------------------------------------------------------
create or replace function purchasing.confirm_order(p_id uuid)
returns purchasing.orders
language plpgsql
security invoker
as $$
declare v_order purchasing.orders;
begin
  if not core.has_perm('purchasing.order.confirm') then
    raise exception 'Sipariş onaylama yetkiniz yok' using errcode = '42501';
  end if;

  select * into v_order from purchasing.orders where id = p_id for update;
  if not found then raise exception 'Sipariş bulunamadı' using errcode = 'P0002'; end if;
  if v_order.status <> 'draft' then
    raise exception 'Yalnızca taslak sipariş onaylanabilir (mevcut: %)', v_order.status
      using errcode = '23514';
  end if;
  if not exists (select 1 from purchasing.order_lines where order_id = p_id) then
    raise exception 'Satırı olmayan sipariş onaylanamaz' using errcode = '23514';
  end if;

  update purchasing.orders
     set status = 'confirmed', confirmed_at = now(),
         number = coalesce(number, core.next_sequence('purchase_order', branch_id))
   where id = p_id returning * into v_order;

  perform core.emit_event('purchase.order.confirmed', jsonb_build_object(
    'purchase_order_id', v_order.id, 'number', v_order.number,
    'partner_id', v_order.partner_id, 'order_date', v_order.order_date,
    'promised_date', v_order.promised_date, 'currency', v_order.currency,
    'payment_term_days', v_order.payment_term_days, 'total', v_order.total
  ), v_order.branch_id);

  return v_order;
end;
$$;

create or replace function purchasing.cancel_order(p_id uuid, p_reason text default null)
returns purchasing.orders
language plpgsql
security invoker
as $$
declare v_order purchasing.orders;
begin
  select * into v_order from purchasing.orders where id = p_id for update;
  if not found then raise exception 'Sipariş bulunamadı' using errcode = 'P0002'; end if;
  if v_order.status in ('received', 'partially_received') then
    raise exception 'Mal kabulü yapılmış sipariş iptal edilemez (%)', v_order.number
      using errcode = '23514';
  end if;

  update purchasing.orders
     set status = 'cancelled', cancelled_at = now(), cancel_reason = p_reason
   where id = p_id returning * into v_order;

  perform core.emit_event('purchase.order.cancelled', jsonb_build_object(
    'purchase_order_id', v_order.id, 'number', v_order.number, 'reason', p_reason
  ), v_order.branch_id);

  return v_order;
end;
$$;

-- Onaylanmış siparişin satırları değiştirilemez — tedarikçiye giden taahhüt.
create or replace function purchasing.fn_lock_confirmed_order_line()
returns trigger
language plpgsql
as $$
declare v_status purchasing.order_status;
begin
  select status into v_status from purchasing.orders
   where id = coalesce(new.order_id, old.order_id);
  -- received_quantity mal kabulü tarafından güncellenir; onu engellemiyoruz.
  if v_status is not null and v_status <> 'draft'
     and (tg_op <> 'UPDATE'
          or (new.quantity, new.unit_price, new.discount_pct, new.tax_id, new.product_id)
             is distinct from (old.quantity, old.unit_price, old.discount_pct, old.tax_id, old.product_id))
  then
    raise exception 'Onaylanmış siparişin satırları değiştirilemez' using errcode = '23514';
  end if;
  return coalesce(new, old);
end;
$$;

drop trigger if exists trg_purchase_order_lines_lock on purchasing.order_lines;
create trigger trg_purchase_order_lines_lock
  before insert or update or delete on purchasing.order_lines
  for each row execute function purchasing.fn_lock_confirmed_order_line();

-- -----------------------------------------------------------------------------
-- Mal kabul
-- -----------------------------------------------------------------------------
create or replace function purchasing.confirm_receipt(p_id uuid)
returns purchasing.receipts
language plpgsql
security invoker
as $$
declare
  v_rec    purchasing.receipts;
  v_order  purchasing.orders;
  v_over   text;
  v_lines  jsonb;
  v_all    boolean;
begin
  if not core.has_perm('purchasing.receipt.confirm') then
    raise exception 'Mal kabul yetkiniz yok' using errcode = '42501';
  end if;

  select * into v_rec from purchasing.receipts where id = p_id for update;
  if not found then raise exception 'Mal kabul belgesi bulunamadı' using errcode = 'P0002'; end if;
  if v_rec.status <> 'draft' then
    raise exception 'Yalnızca taslak mal kabul onaylanabilir (mevcut: %)', v_rec.status
      using errcode = '23514';
  end if;
  if not exists (select 1 from purchasing.receipt_lines where receipt_id = p_id) then
    raise exception 'Satırı olmayan mal kabul onaylanamaz' using errcode = '23514';
  end if;

  select * into v_order from purchasing.orders where id = v_rec.order_id for update;
  if v_order.status not in ('confirmed', 'partially_received') then
    raise exception 'Sipariş mal kabule uygun durumda değil (%)', v_order.status
      using errcode = '23514';
  end if;

  -- FAZLA KABUL ENGELİ: bu kabul işlendiğinde sipariş satırının miktarı aşılıyor mu?
  -- Sessizce fazla mal girişi, stok ve fatura mutabakatını birlikte bozar.
  select string_agg(format('%s (sipariş %s, toplam kabul %s)',
                           ol.description, ol.quantity, ol.received_quantity + x.qty), '; ')
    into v_over
  from purchasing.order_lines ol
  join (select rl.order_line_id, sum(rl.quantity - rl.rejected_quantity) as qty
          from purchasing.receipt_lines rl where rl.receipt_id = p_id
         group by rl.order_line_id) x on x.order_line_id = ol.id
  where ol.received_quantity + x.qty > ol.quantity;

  if v_over is not null then
    raise exception 'Sipariş miktarı aşılıyor: %', v_over using errcode = '23514';
  end if;

  update purchasing.receipts
     set status = 'confirmed', confirmed_at = now(),
         number = coalesce(number, core.next_sequence('purchase_receipt', branch_id))
   where id = p_id returning * into v_rec;

  -- Sipariş satırlarındaki kabul miktarını ilerlet (reddedilen sayılmaz)
  update purchasing.order_lines ol
     set received_quantity = ol.received_quantity + x.qty
  from (select rl.order_line_id, sum(rl.quantity - rl.rejected_quantity) as qty
          from purchasing.receipt_lines rl where rl.receipt_id = p_id
         group by rl.order_line_id) x
  where ol.id = x.order_line_id;

  select bool_and(ol.received_quantity >= ol.quantity) into v_all
  from purchasing.order_lines ol where ol.order_id = v_order.id;

  -- CASE'in dalları `unknown` çözülüp text'e düştüğü için enum'a açık dönüşüm şart.
  update purchasing.orders
     set status = (case when v_all then 'received' else 'partially_received' end)::purchasing.order_status
   where id = v_order.id;

  -- Envanter modülü (Faz 2) bu olayı dinleyip stok girişi yapacak; Muhasebe
  -- ise alış faturası taslağı üretir. Satın Alma ikisini de bilmez.
  select jsonb_agg(jsonb_build_object(
           'product_id', ol.product_id, 'description', ol.description,
           'quantity', rl.quantity - rl.rejected_quantity, 'uom_id', ol.uom_id,
           'unit_price', ol.unit_price, 'discount_pct', ol.discount_pct,
           'tax_id', ol.tax_id) order by rl.sequence)
    into v_lines
  from purchasing.receipt_lines rl
  join purchasing.order_lines ol on ol.id = rl.order_line_id
  where rl.receipt_id = p_id and rl.quantity > rl.rejected_quantity;

  perform core.emit_event('purchasing.receipt.confirmed', jsonb_build_object(
    'receipt_id', v_rec.id, 'number', v_rec.number,
    'purchase_order_id', v_order.id, 'order_number', v_order.number,
    'partner_id', v_rec.partner_id, 'receipt_date', v_rec.receipt_date,
    'currency', v_order.currency, 'payment_term_days', v_order.payment_term_days,
    'promised_date', v_order.promised_date,
    'lines', coalesce(v_lines, '[]'::jsonb)
  ), v_rec.branch_id);

  return v_rec;
end;
$$;

-- Onaylanmış mal kabul değiştirilemez: stok ve fatura ondan türedi.
create or replace function purchasing.fn_lock_confirmed_receipt()
returns trigger
language plpgsql
as $$
declare v_status purchasing.receipt_status;
begin
  select status into v_status from purchasing.receipts
   where id = coalesce(new.receipt_id, old.receipt_id);
  if v_status = 'confirmed' then
    raise exception 'Onaylanmış mal kabulün satırları değiştirilemez' using errcode = '23514';
  end if;
  return coalesce(new, old);
end;
$$;

drop trigger if exists trg_receipt_lines_lock on purchasing.receipt_lines;
create trigger trg_receipt_lines_lock
  before insert or update or delete on purchasing.receipt_lines
  for each row execute function purchasing.fn_lock_confirmed_receipt();

-- -----------------------------------------------------------------------------
-- Olaylar
-- -----------------------------------------------------------------------------
select core.declare_event('purchasing.requisition.approved', 'purchasing',
       'Satın alma talebi onaylandı');
select core.declare_event('purchase.order.confirmed', 'purchasing',
       'Satın alma siparişi tedarikçiye onaylandı');
select core.declare_event('purchase.order.cancelled', 'purchasing',
       'Satın alma siparişi iptal edildi');
select core.declare_event('purchasing.receipt.confirmed', 'purchasing',
       'Mal kabul onaylandı — stok girişi ve alış faturası bu olaydan doğar',
       '{"receipt_id":"uuid","purchase_order_id":"uuid","partner_id":"uuid","lines":"[]"}'::jsonb);
