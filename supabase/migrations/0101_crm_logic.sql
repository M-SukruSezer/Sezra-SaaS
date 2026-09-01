-- =============================================================================
-- 0101 — CRM iş mantığı: tetikleyiciler, durum geçişleri, olaylar, RLS, raporlar
-- =============================================================================

-- -----------------------------------------------------------------------------
-- Satır matematiği
-- -----------------------------------------------------------------------------
select core.attach_document_line_math('crm', 'quotation_lines',  'crm.quotations', 'quotation_id');
select core.attach_document_line_math('crm', 'sale_order_lines', 'crm.sale_orders', 'sale_order_id');

-- -----------------------------------------------------------------------------
-- Aday durum tutarlılığı: aşama değişince status/olasılık senkronize olsun
-- -----------------------------------------------------------------------------
create or replace function crm.fn_sync_lead_stage()
returns trigger
language plpgsql
as $$
declare v_stage crm.stages;
begin
  select * into v_stage from crm.stages where id = new.stage_id;
  if not found then
    raise exception 'Geçersiz aşama: %', new.stage_id;
  end if;

  if v_stage.is_won then
    new.status := 'won';
    new.probability := 100;
    new.closed_at := coalesce(new.closed_at, now());
  elsif v_stage.is_lost then
    new.status := 'lost';
    new.probability := 0;
    new.closed_at := coalesce(new.closed_at, now());
  else
    new.status := 'open';
    new.closed_at := null;
    if tg_op = 'INSERT' or new.stage_id is distinct from old.stage_id then
      new.probability := v_stage.probability;
    end if;
  end if;
  return new;
end;
$$;

drop trigger if exists trg_leads_sync_stage on crm.leads;
create trigger trg_leads_sync_stage before insert or update on crm.leads
  for each row execute function crm.fn_sync_lead_stage();

-- Fırsat kazanıldığında olay yayınla (Envanter/Muhasebe dinleyebilir)
create or replace function crm.fn_lead_won_event()
returns trigger
language plpgsql
as $$
begin
  if new.status = 'won' and coalesce(old.status, '') <> 'won' then
    perform core.emit_event('crm.lead.won', jsonb_build_object(
      'lead_id', new.id, 'partner_id', new.partner_id, 'owner_id', new.owner_id,
      'expected_revenue', new.expected_revenue, 'currency', new.currency
    ), new.branch_id);
  end if;
  return null;
end;
$$;

drop trigger if exists trg_leads_won_event on crm.leads;
create trigger trg_leads_won_event after update on crm.leads
  for each row execute function crm.fn_lead_won_event();

-- -----------------------------------------------------------------------------
-- Durum geçişleri
-- -----------------------------------------------------------------------------
-- Belge onaylandıktan sonra satırları değişemez. Bunu RLS ile değil trigger ile
-- yaparız: RLS "hangi satırı görürsün" sorusunu, iş kuralı "ne zaman değişir"
-- sorusunu yanıtlar; ikisini karıştırmak politikaları okunamaz hâle getirir.
create or replace function crm.fn_lock_confirmed_document()
returns trigger
language plpgsql
as $$
declare v_status text;
begin
  execute format('select status from %s where id = $1',
                 case tg_table_name when 'quotation_lines' then 'crm.quotations'
                                    else 'crm.sale_orders' end)
    into v_status
    using coalesce(
      (to_jsonb(case when tg_op = 'DELETE' then old else new end) ->> tg_argv[0])::uuid);

  if v_status in ('accepted', 'confirmed', 'delivered', 'invoiced', 'cancelled') then
    raise exception 'Kilitli belge (% durumunda) satırları değiştirilemez', v_status
      using errcode = '23514';
  end if;
  return case when tg_op = 'DELETE' then old else new end;
end;
$$;

drop trigger if exists trg_quotation_lines_lock on crm.quotation_lines;
create trigger trg_quotation_lines_lock before insert or update or delete on crm.quotation_lines
  for each row execute function crm.fn_lock_confirmed_document('quotation_id');

drop trigger if exists trg_sale_order_lines_lock on crm.sale_order_lines;
create trigger trg_sale_order_lines_lock before insert or update or delete on crm.sale_order_lines
  for each row execute function crm.fn_lock_confirmed_document('sale_order_id');

-- Teklifi gönder
create or replace function crm.send_quotation(p_id uuid)
returns crm.quotations
language plpgsql
security invoker
as $$
declare v_q crm.quotations;
begin
  select * into v_q from crm.quotations where id = p_id for update;
  if not found then raise exception 'Teklif bulunamadı' using errcode = 'P0002'; end if;
  if v_q.status <> 'draft' then
    raise exception 'Yalnızca taslak teklifler gönderilebilir (mevcut: %)', v_q.status;
  end if;

  update crm.quotations
     set status = 'sent',
         number = coalesce(number, core.next_sequence('crm_quotation', branch_id))
   where id = p_id
   returning * into v_q;

  perform core.emit_event('crm.quotation.sent',
    jsonb_build_object('quotation_id', v_q.id, 'partner_id', v_q.partner_id,
                       'number', v_q.number, 'total', v_q.total),
    v_q.branch_id);
  return v_q;
end;
$$;

-- Teklif onaylandığında otomatik sipariş (Bölüm 4.1)
create or replace function crm.accept_quotation(p_id uuid)
returns crm.sale_orders
language plpgsql
security invoker
as $$
declare
  v_q  crm.quotations;
  v_so crm.sale_orders;
begin
  select * into v_q from crm.quotations where id = p_id for update;
  if not found then raise exception 'Teklif bulunamadı' using errcode = 'P0002'; end if;
  if v_q.status not in ('draft', 'sent') then
    raise exception 'Bu teklif onaylanamaz (mevcut durum: %)', v_q.status;
  end if;

  update crm.quotations
     set status = 'accepted', accepted_at = now(),
         number = coalesce(number, core.next_sequence('crm_quotation', branch_id))
   where id = p_id
   returning * into v_q;

  insert into crm.sale_orders (
    tenant_id, branch_id, partner_id, quotation_id, order_date, status,
    currency, payment_term_days, notes, owner_id
  ) values (
    v_q.tenant_id, v_q.branch_id, v_q.partner_id, v_q.id, current_date, 'draft',
    v_q.currency, v_q.payment_term_days, v_q.notes, v_q.owner_id
  ) returning * into v_so;

  insert into crm.sale_order_lines (
    tenant_id, sale_order_id, sequence, product_id, description,
    quantity, uom_id, unit_price, discount_pct, tax_id
  )
  select v_q.tenant_id, v_so.id, l.sequence, l.product_id, l.description,
         l.quantity, l.uom_id, l.unit_price, l.discount_pct, l.tax_id
  from crm.quotation_lines l
  where l.quotation_id = v_q.id
  order by l.sequence;

  -- Aday varsa kazanıldı olarak işaretle
  if v_q.lead_id is not null then
    update crm.leads
       set stage_id = (select s.id from crm.stages s
                       where s.pipeline_id = crm.leads.pipeline_id and s.is_won
                       order by s.sequence limit 1)
     where id = v_q.lead_id and status = 'open';
  end if;

  perform core.emit_event('crm.quotation.accepted',
    jsonb_build_object('quotation_id', v_q.id, 'sale_order_id', v_so.id,
                       'partner_id', v_q.partner_id, 'total', v_q.total),
    v_q.branch_id);

  select * into v_so from crm.sale_orders where id = v_so.id;
  return v_so;
end;
$$;

-- Siparişi onayla -> Muhasebe fatura taslağı, Envanter stok hareketi bu olayı dinler
create or replace function crm.confirm_sale_order(p_id uuid)
returns crm.sale_orders
language plpgsql
security invoker
as $$
declare
  v_so    crm.sale_orders;
  v_lines jsonb;
begin
  if not core.has_perm('crm.order.confirm') then
    raise exception 'Sipariş onaylama yetkiniz yok' using errcode = '42501';
  end if;

  select * into v_so from crm.sale_orders where id = p_id for update;
  if not found then raise exception 'Sipariş bulunamadı' using errcode = 'P0002'; end if;
  if v_so.status <> 'draft' then
    raise exception 'Yalnızca taslak siparişler onaylanabilir (mevcut: %)', v_so.status;
  end if;
  if not exists (select 1 from crm.sale_order_lines where sale_order_id = p_id) then
    raise exception 'Satırı olmayan sipariş onaylanamaz';
  end if;

  update crm.sale_orders
     set status = 'confirmed', confirmed_at = now(),
         number = coalesce(number, core.next_sequence('crm_sale_order', branch_id))
   where id = p_id
   returning * into v_so;

  select jsonb_agg(jsonb_build_object(
           'product_id', l.product_id, 'description', l.description,
           'quantity', l.quantity, 'uom_id', l.uom_id, 'unit_price', l.unit_price,
           'discount_pct', l.discount_pct, 'tax_id', l.tax_id,
           'line_subtotal', l.line_subtotal, 'line_tax', l.line_tax,
           'line_withholding', l.line_withholding, 'line_total', l.line_total)
         order by l.sequence)
    into v_lines
  from crm.sale_order_lines l where l.sale_order_id = p_id;

  perform core.emit_event('sales.order.confirmed', jsonb_build_object(
    'sale_order_id', v_so.id, 'number', v_so.number, 'partner_id', v_so.partner_id,
    'order_date', v_so.order_date, 'currency', v_so.currency,
    'subtotal', v_so.subtotal, 'tax_total', v_so.tax_total,
    'withholding_total', v_so.withholding_total, 'total', v_so.total,
    'payment_term_days', v_so.payment_term_days, 'lines', v_lines
  ), v_so.branch_id);

  return v_so;
end;
$$;

create or replace function crm.cancel_sale_order(p_id uuid, p_reason text default null)
returns crm.sale_orders
language plpgsql
security invoker
as $$
declare v_so crm.sale_orders;
begin
  if not core.has_perm('crm.order.confirm') then
    raise exception 'Sipariş iptal yetkiniz yok' using errcode = '42501';
  end if;
  select * into v_so from crm.sale_orders where id = p_id for update;
  if not found then raise exception 'Sipariş bulunamadı' using errcode = 'P0002'; end if;
  if v_so.status = 'invoiced' then
    raise exception 'Faturalanmış sipariş iptal edilemez; iade süreci kullanılmalı';
  end if;

  update crm.sale_orders
     set status = 'cancelled', cancelled_at = now(),
         notes = coalesce(notes, '') || case when p_reason is null then '' else E'\niptal: ' || p_reason end
   where id = p_id returning * into v_so;

  perform core.emit_event('sales.order.cancelled',
    jsonb_build_object('sale_order_id', v_so.id, 'number', v_so.number, 'reason', p_reason),
    v_so.branch_id);
  return v_so;
end;
$$;

-- -----------------------------------------------------------------------------
-- Olay tipleri
-- -----------------------------------------------------------------------------
select core.declare_event('crm.lead.won', 'crm', 'Fırsat kazanıldı');
select core.declare_event('crm.quotation.sent', 'crm', 'Teklif müşteriye gönderildi');
select core.declare_event('crm.quotation.accepted', 'crm', 'Teklif onaylandı, sipariş oluştu');
select core.declare_event('sales.order.confirmed', 'crm',
  'Satış siparişi onaylandı — Muhasebe fatura taslağı, Envanter stok çıkışı üretir',
  '{"sale_order_id":"uuid","partner_id":"uuid","total":"numeric","lines":"array"}'::jsonb);
select core.declare_event('sales.order.cancelled', 'crm', 'Satış siparişi iptal edildi');

-- -----------------------------------------------------------------------------
-- RLS
-- -----------------------------------------------------------------------------
select core.register_tenant_table('crm', 'pipelines',        'crm.setup',      false, false);
select core.register_tenant_table('crm', 'stages',           'crm.setup',      false, false);
select core.register_tenant_table('crm', 'lost_reasons',     'crm.setup',      false, false);
select core.register_tenant_table('crm', 'leads',            'crm.lead',       true,  true);
select core.register_tenant_table('crm', 'activities',       'crm.activity',   true,  true);
select core.register_tenant_table('crm', 'quotations',       'crm.quotation',  true,  true);
select core.register_tenant_table('crm', 'sale_orders',      'crm.order',      true,  true);

-- Belge satırları: yetkiyi başlıktan devralır (ayrı izin kodu yok)
do $$
declare
  v record;
begin
  for v in select * from (values
      ('quotation_lines',  'quotations',  'quotation_id'),
      ('sale_order_lines', 'sale_orders', 'sale_order_id')
    ) as t(line_table, header_table, fk)
  loop
    execute format('alter table crm.%I enable row level security', v.line_table);
    execute format('alter table crm.%I force row level security', v.line_table);
    execute format('drop policy if exists p_%s_all on crm.%I', v.line_table, v.line_table);
    execute format($p$create policy p_%1$s_all on crm.%1$I for all
        using (exists (select 1 from crm.%2$I h where h.id = %3$I))
        with check (exists (select 1 from crm.%2$I h where h.id = %3$I))$p$,
      v.line_table, v.header_table, v.fk);
    execute format('create index if not exists ix_%1$s_tenant on crm.%1$I (tenant_id)', v.line_table);
    perform core.attach_updated_at('crm', v.line_table);
    perform core.attach_row_defaults('crm', v.line_table);
    perform core.attach_audit('crm', v.line_table);
  end loop;
end $$;

-- -----------------------------------------------------------------------------
-- İzinler ve roller
-- -----------------------------------------------------------------------------
select core.declare_entity_permissions('crm', 'lead',      'Fırsat');
select core.declare_entity_permissions('crm', 'activity',  'Aktivite');
select core.declare_entity_permissions('crm', 'quotation', 'Teklif');
select core.declare_entity_permissions('crm', 'order',     'Satış siparişi');
select core.declare_entity_permissions('crm', 'setup',     'CRM ayarları', false);
select core.declare_permission('crm.order.confirm', 'crm', 'crm.order', 'approve', 'Satış siparişi onayla/iptal et');
select core.declare_permission('crm.report.read',   'crm', 'crm.report', 'read',   'CRM raporlarını görüntüle');

select core.grant_module_to_role('tenant_admin', 'crm');

select core.grant_to_role('branch_manager', array[
  'crm.lead.read.all','crm.lead.write.all','crm.lead.create','crm.lead.delete.all',
  'crm.activity.read.all','crm.activity.write.all','crm.activity.create',
  'crm.quotation.read.all','crm.quotation.write.all','crm.quotation.create',
  'crm.order.read.all','crm.order.write.all','crm.order.create','crm.order.confirm',
  'crm.setup.read.all','crm.report.read'
]);

-- Satış temsilcisi: YALNIZCA kendi fırsatlarını görür (Bölüm 3.4 örneği)
select core.grant_to_role('sales', array[
  'crm.lead.read.own','crm.lead.write.own','crm.lead.create','crm.lead.delete.own',
  'crm.activity.read.own','crm.activity.write.own','crm.activity.create',
  'crm.quotation.read.own','crm.quotation.write.own','crm.quotation.create',
  'crm.order.read.own','crm.order.write.own','crm.order.create',
  'crm.setup.read.all'
]);

select core.grant_to_role('accounting', array[
  'crm.quotation.read.all','crm.order.read.all','crm.report.read','crm.setup.read.all'
]);

select core.grant_to_role('readonly', array[
  'crm.lead.read.all','crm.activity.read.all','crm.quotation.read.all','crm.order.read.all','crm.setup.read.all'
]);
