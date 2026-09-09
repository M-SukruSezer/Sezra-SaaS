-- =============================================================================
-- 1190 — Envanter: araç (vehicle) lokasyon tipi
--
-- Araç üzerindeki stoğu takip etmek için inventory.location_kind enum'una
-- 'vehicle' değeri eklenir. Ayrı migration: ALTER TYPE ... ADD VALUE aynı
-- transaction'daki CREATE OR REPLACE VIEW ile kullanılamaz (PostgreSQL kısıtı).
-- 1191 bu değeri raporlara ekler.
-- =============================================================================
alter type inventory.location_kind add value if not exists 'vehicle';
