-- =============================================================================
-- 1194 — Pasif cari / pasif ürün yeni işlemde seçilemez (T-033 kart 1.2)
--
-- Şartname madde 10 ve 45:
--   "Pasif cari: yeni işlemlerde seçilememeli, geçmiş belgeleri ve hareketleri
--    korunmalı, raporlarda görünmeye devam etmeli."
--   "Pasif ürün ve cariler yeni işlemlerde seçilememeli."
--
-- YAKLAŞIM — iş kuralı veritabanı katmanında (yalnızca formda gizlemek yetmez):
--   * Ticari belge başlık/satır tablolarına BEFORE INSERT tetikleyicisi:
--     is_active = false olan cari/ürün seçilmişse hata (SQLSTATE 23514 ->
--     API katmanı 422 check_violation'a çeviriyor, kullanıcıya anlaşılır mesaj).
--   * BEFORE UPDATE tetikleyicisi YALNIZCA partner_id/product_id DEĞİŞTİĞİNDE
--     çalışır (WHEN kolonu). Böylece:
--       - Geçmiş belgeler dokunulmadan kalır: eski bir belgede tutar/not
--         güncellemek, cari sonradan pasifleştirilmiş olsa bile serbest.
--       - Ama var olan bir belgeyi pasif bir cariye/ürüne YÖNLENDİRMEK de engellenir.
--   * SELECT'e hiç dokunulmaz: raporlar, geçmiş belge listeleri, cari detay
--     ekranı pasif kayıtları görmeye devam eder.
--
-- KAPSAM — kullanıcının cari/ürün SEÇEREK yeni ticari belge başlattığı yerler:
--   Cari:  crm.quotations, crm.sale_orders, purchasing.orders, pos.orders
--   Ürün:  crm.quotation_lines, crm.sale_order_lines,
--          purchasing.requisition_lines, purchasing.order_lines, pos.order_lines
--
-- KAPSAM DIŞI (bilerek):
--   * finance.invoices / invoice_lines — fatura ya kaynak belgeden (SO/PO, zaten
--     korumalı) türer ya da açık borcun kaydıdır. Özellikle ALIŞ faturası:
--     tedarikçi mal kabulden sonra pasifleştirilmiş olsa bile borç fatura
--     onayında doğmalı (god kararı: mevcut tedarikçi-borç akışı korunuyor).
--   * finance.payments — pasif carinin AÇIK BAKİYESİNİN tahsilatı/ödemesi her
--     zaman yapılabilmeli; yeni satış/alış değil, eski borcun kapatılması.
--   * purchasing.receipts / receipt_lines — daha önce verilmiş bir siparişin mal
--     kabulü, tedarikçi/ürün sonradan pasifleştirilse bile tamamlanabilmeli.
--   * Türev muhasebe kayıtları (finance.journal_entries), CRM lead/aktivite,
--     kalite/bakım/proje/destek kayıtları — şartname FAZ 1 ticari kapsamı dışı.
-- =============================================================================
set client_min_messages = warning;

-- -----------------------------------------------------------------------------
-- Tetikleyici fonksiyonları — SECURITY DEFINER: kullanıcının cari/ürün OKUMA
-- iznine (read.own / read.all) bakılmaksızın aynı kiracı içindeki kaydın
-- aktiflik durumu kontrol edilir (sezra_owner BYPASSRLS'tir; kiracı kapsamı
-- WHERE tenant_id = new.tenant_id ile korunur). search_path sabitlenir.
-- -----------------------------------------------------------------------------
create or replace function core.assert_ref_partner_active()
returns trigger
language plpgsql
security definer
set search_path = core, pg_temp
as $fn$
declare
  v_name text;
  v_active boolean;
begin
  if new.partner_id is null then
    return new;
  end if;
  select p.name, p.is_active into v_name, v_active
    from core.partners p
   where p.id = new.partner_id and p.tenant_id = new.tenant_id;
  if not found then
    return new;   -- FK zaten yakalar; burada karar vermeyiz
  end if;
  if not v_active then
    raise exception 'Pasif cari yeni işlemde seçilemez: %', coalesce(v_name, new.partner_id::text)
      using errcode = 'check_violation',
            hint = 'Cariyi yeniden aktifleştirin ya da başka bir cari seçin.';
  end if;
  return new;
end;
$fn$;

create or replace function core.assert_ref_product_active()
returns trigger
language plpgsql
security definer
set search_path = core, pg_temp
as $fn$
declare
  v_name text;
  v_active boolean;
begin
  if new.product_id is null then
    return new;
  end if;
  select p.name, p.is_active into v_name, v_active
    from core.products p
   where p.id = new.product_id and p.tenant_id = new.tenant_id;
  if not found then
    return new;
  end if;
  if not v_active then
    raise exception 'Pasif ürün yeni işlemde seçilemez: %', coalesce(v_name, new.product_id::text)
      using errcode = 'check_violation',
            hint = 'Ürünü yeniden aktifleştirin ya da başka bir ürün seçin.';
  end if;
  return new;
end;
$fn$;

-- -----------------------------------------------------------------------------
-- Tetikleyicileri bağla
-- -----------------------------------------------------------------------------
do $$
declare
  r record;
begin
  -- cari (partner_id) taşıyan başlık tabloları
  for r in
    select * from (values
      ('crm', 'quotations'),
      ('crm', 'sale_orders'),
      ('purchasing', 'orders'),
      ('pos', 'orders')
    ) as t(sch, tbl)
  loop
    execute format('drop trigger if exists trg_%s_%s_partner_active on %I.%I',
                   r.sch, r.tbl, r.sch, r.tbl);
    execute format($t$
      create trigger trg_%1$s_%2$s_partner_active
        before insert on %1$I.%2$I
        for each row execute function core.assert_ref_partner_active()
    $t$, r.sch, r.tbl);
    execute format($t$
      create trigger trg_%1$s_%2$s_partner_active_upd
        before update of partner_id on %1$I.%2$I
        for each row
        when (new.partner_id is distinct from old.partner_id)
        execute function core.assert_ref_partner_active()
    $t$, r.sch, r.tbl);
  end loop;

  -- ürün (product_id) taşıyan satır tabloları
  for r in
    select * from (values
      ('crm', 'quotation_lines'),
      ('crm', 'sale_order_lines'),
      ('purchasing', 'requisition_lines'),
      ('purchasing', 'order_lines'),
      ('pos', 'order_lines')
    ) as t(sch, tbl)
  loop
    execute format('drop trigger if exists trg_%s_%s_product_active on %I.%I',
                   r.sch, r.tbl, r.sch, r.tbl);
    execute format($t$
      create trigger trg_%1$s_%2$s_product_active
        before insert on %1$I.%2$I
        for each row execute function core.assert_ref_product_active()
    $t$, r.sch, r.tbl);
    execute format($t$
      create trigger trg_%1$s_%2$s_product_active_upd
        before update of product_id on %1$I.%2$I
        for each row
        when (new.product_id is distinct from old.product_id)
        execute function core.assert_ref_product_active()
    $t$, r.sch, r.tbl);
  end loop;
end $$;

comment on function core.assert_ref_partner_active() is
  'T-033/1.2: pasif cari yeni ticari belgede seçilemez (INSERT + partner_id değişikliği). Geçmiş belge/rapor etkilenmez.';
comment on function core.assert_ref_product_active() is
  'T-033/1.2: pasif ürün yeni ticari belge satırında seçilemez (INSERT + product_id değişikliği). Geçmiş belge/rapor etkilenmez.';
