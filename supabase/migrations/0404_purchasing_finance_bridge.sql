-- =============================================================================
-- 0404 — Mal kabul → Muhasebe köprüsü
-- =============================================================================
-- 0305'teki bordro köprüsüyle aynı kural: buradaki fonksiyon FINANCE modülüne
-- aittir, migration sırası yüzünden bu numarada duruyor. Bağımlılık yönü doğru —
-- Muhasebe, Satın Alma'yı bilir; Satın Alma, Muhasebe'yi bilmez.
--
-- FATURA neden SİPARİŞ ONAYINDA değil MAL KABULDE doğuyor?
-- Sipariş bir taahhüttür, borç doğurmaz. Borç malın teslim alınmasıyla doğar
-- ve tutarı FİİLEN GELEN miktar üzerinden hesaplanmalıdır — 100 sipariş edip
-- 60 teslim alındıysa fatura 60 üzerindendir. Sipariş onayında fatura kesmek,
-- kısmi teslimatta yanlış tutarlı borç yaratırdı.
-- =============================================================================

create or replace function finance.on_purchase_receipt_confirmed(p_event jsonb)
returns void
language plpgsql
security definer
set search_path = finance, core, purchasing, pg_temp
as $$
declare
  v_tenant     uuid  := (p_event ->> 'tenant_id')::uuid;
  v_branch     uuid  := nullif(p_event ->> 'branch_id', '')::uuid;
  v_payload    jsonb := p_event -> 'payload';
  v_receipt_id uuid  := (v_payload ->> 'receipt_id')::uuid;
  v_invoice_id uuid;
  v_expense    uuid;
  v_line       jsonb;
  v_seq        smallint := 10;
begin
  -- İdempotanlık: yeniden teslimat ikinci fatura üretmez.
  if exists (
    select 1 from finance.invoices
    where tenant_id = v_tenant and source_module = 'purchasing'
      and source_table = 'receipts' and source_id = v_receipt_id
  ) then
    return;
  end if;

  select account_id into v_expense
  from finance.account_mappings where tenant_id = v_tenant and key = 'purchase_expense';
  if v_expense is null then
    raise exception 'purchase_expense hesap eşlemesi tanımsız (kiracı %)', v_tenant;
  end if;

  insert into finance.invoices (
    tenant_id, branch_id, kind, partner_id, issue_date, status, currency,
    payment_term_days, source_module, source_table, source_id, notes
  ) values (
    v_tenant, v_branch, 'purchase', (v_payload ->> 'partner_id')::uuid,
    coalesce((v_payload ->> 'receipt_date')::date, current_date), 'draft',
    coalesce(v_payload ->> 'currency', 'TRY'),
    coalesce((v_payload ->> 'payment_term_days')::smallint, 0),
    'purchasing', 'receipts', v_receipt_id,
    format('Mal kabul %s (sipariş %s) üzerinden otomatik oluşturuldu',
           coalesce(v_payload ->> 'number', ''), coalesce(v_payload ->> 'order_number', ''))
  ) returning id into v_invoice_id;

  for v_line in select * from jsonb_array_elements(v_payload -> 'lines')
  loop
    insert into finance.invoice_lines (
      tenant_id, invoice_id, sequence, product_id, account_id, description,
      quantity, uom_id, unit_price, discount_pct, tax_id
    ) values (
      v_tenant, v_invoice_id, v_seq,
      nullif(v_line ->> 'product_id', '')::uuid, v_expense,
      coalesce(v_line ->> 'description', 'Alış'),
      coalesce((v_line ->> 'quantity')::numeric, 1),
      nullif(v_line ->> 'uom_id', '')::uuid,
      coalesce((v_line ->> 'unit_price')::numeric, 0),
      coalesce((v_line ->> 'discount_pct')::numeric, 0),
      nullif(v_line ->> 'tax_id', '')::uuid
    );
    v_seq := v_seq + 10;
  end loop;

  perform core.emit_event('finance.invoice.drafted', jsonb_build_object(
    'invoice_id', v_invoice_id, 'source_module', 'purchasing', 'source_id', v_receipt_id
  ), v_branch, null, v_tenant);
end;
$$;

select core.subscribe('purchasing.receipt.confirmed', 'finance',
                      'finance.on_purchase_receipt_confirmed');
