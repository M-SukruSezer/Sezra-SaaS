-- =============================================================================
-- 1192 — Ürün kartı ve cari kart eksik alanları (T-033 kart 1.1)
--
-- Ürün kartı (core.products):
--   artikel_no     : üreticinin kendi ürün kodu (SKU'dan ayrı; çok tedarikçili
--                    ürünlerde her tedarikçinin kodu aynı SKU'ya eşlenebilir)
--   shelf_location : depodaki raf/göz bilgisi (bilgi kolonu; stok hareketi
--                    değil; konum yönetimi inventory.locations üzerinde yapılır,
--                    bu alan yalnızca operasyonel kısa not içindir)
--
-- Cari kart (core.partners):
--   currency       : cari için varsayılan fatura para birimi (teklif/sipariş/
--                    fatura oluştururken ön doldurmak için; belge düzeyinde
--                    değiştirilebilir). NULL = sistem/şirket varsayılanı kullanılır.
--
-- Hepsi nullable eklenir: mevcut satırlar dokunulmaz, geçmiş belgeler ve
-- raporlar etkilenmez. T-028 core.partners'a ayrı kolonlar (mersis_no / vergi
-- dairesi kodu / mükellefiyet türü) ekliyor; çakışmayı önlemek için buradaki
-- eklemeler farklı adlı ve "add column if not exists" korumalı.
-- =============================================================================
set client_min_messages = warning;

alter table core.products
  add column if not exists artikel_no      text,
  add column if not exists shelf_location  text;

alter table core.partners
  add column if not exists currency  char(3);

comment on column core.products.artikel_no     is 'Üreticinin kendi ürün/artikel numarası (SKU''dan bağımsız bilgi alanı).';
comment on column core.products.shelf_location is 'Depoda raf/göz kısa notu (konum yönetimi inventory.locations üzerinde yapılır).';
comment on column core.partners.currency       is 'Cari için varsayılan belge para birimi (ISO 4217); NULL ise sistem varsayılanı.';
