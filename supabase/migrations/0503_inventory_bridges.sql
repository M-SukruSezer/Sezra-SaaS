-- =============================================================================
-- 0503 — Envanter köprüleri: satın alma girişi, satış çıkışı
-- =============================================================================
-- Bu dosyadaki handler'lar ENVANTER modülüne aittir ve BAŞKA modüllerin
-- olaylarını dinler. Satın Alma ve CRM'de tek satır değişmedi — Faz 1'de
-- yayınlanan olaylar, Faz 2'de yeni bir abone kazandı. Olay tabanlı
-- entegrasyonun asıl getirisi budur.
--
-- MUHASEBE KAYDI BİLEREK OTOMATİK DEĞİL:
-- Stok çıkışında 621 SATILAN TİCARİ MALLAR MALİYETİ kaydını otomatik atmak,
-- kiracıya SÜREKLİ ENVANTER yöntemini dayatır. Türkiye'de KOBİ'lerin çoğu
-- ARALIKLI ENVANTER kullanır ve maliyeti dönem sonunda hesaplar. Yöntem
-- seçimi muhasebe ayarı hâline gelmeden bu kaydı otomatikleştirmiyoruz;
-- değerleme raporu (0504) her iki yöntemde de doğru veriyi üretir.
-- =============================================================================

create or replace function inventory.on_purchase_receipt_confirmed(p_event jsonb)
returns void
language plpgsql
security definer
set search_path = inventory, core, pg_temp
as $$
declare
  v_tenant  uuid  := (p_event ->> 'tenant_id')::uuid;
  v_branch  uuid  := nullif(p_event ->> 'branch_id', '')::uuid;
  v_payload jsonb := p_event -> 'payload';
  v_receipt uuid  := (v_payload ->> 'receipt_id')::uuid;
  v_line    jsonb;
  v_cost    numeric;
begin
  -- İdempotanlık: aynı mal kabulden ikinci kez stok girişi yapılmaz.
  if exists (
    select 1 from inventory.moves
    where tenant_id = v_tenant and source_module = 'purchasing'
      and source_table = 'receipts' and source_id = v_receipt
  ) then
    return;
  end if;

  for v_line in select * from jsonb_array_elements(v_payload -> 'lines')
  loop
    -- Hizmet ve sarf kalemleri stokta izlenmez
    if not exists (
      select 1 from core.products p
      where p.id = nullif(v_line ->> 'product_id', '')::uuid and p.kind = 'stockable'
    ) then
      continue;
    end if;

    -- Giriş maliyeti: iskonto düşülmüş fiili birim fiyat (KDV hariç)
    v_cost := coalesce((v_line ->> 'unit_price')::numeric, 0)
              * (1 - coalesce((v_line ->> 'discount_pct')::numeric, 0) / 100);

    perform inventory.receive_stock(
      v_tenant, v_branch,
      (v_line ->> 'product_id')::uuid,
      coalesce((v_line ->> 'quantity')::numeric, 0),
      v_cost, null,
      'purchasing', 'receipts', v_receipt,
      coalesce(v_payload ->> 'number', ''));
  end loop;
end;
$$;

create or replace function inventory.on_sales_order_confirmed(p_event jsonb)
returns void
language plpgsql
security definer
set search_path = inventory, core, pg_temp
as $$
declare
  v_tenant  uuid  := (p_event ->> 'tenant_id')::uuid;
  v_branch  uuid  := nullif(p_event ->> 'branch_id', '')::uuid;
  v_payload jsonb := p_event -> 'payload';
  v_order   uuid  := (v_payload ->> 'sale_order_id')::uuid;
  v_line    jsonb;
begin
  if exists (
    select 1 from inventory.moves
    where tenant_id = v_tenant and source_module = 'crm'
      and source_table = 'sale_orders' and source_id = v_order
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

    -- STOK DÜŞÜLMEZ, REZERVE EDİLİR.
    -- Siparişi onaylamak mal göndermek değildir; satın almada faturayı sipariş
    -- onayında değil mal kabulde kesmemizle aynı gerekçe. Fiili çıkış, sevkiyat
    -- anında inventory.ship_reservation ile olur.
    perform inventory.reserve_stock(
      v_tenant, v_branch,
      (v_line ->> 'product_id')::uuid,
      coalesce((v_line ->> 'quantity')::numeric, 0),
      'crm', 'sale_orders', v_order,
      coalesce(v_payload ->> 'number', ''));
  end loop;
end;
$$;

select core.subscribe('purchasing.receipt.confirmed', 'inventory',
                      'inventory.on_purchase_receipt_confirmed');
select core.subscribe('sales.order.confirmed', 'inventory',
                      'inventory.on_sales_order_confirmed');
