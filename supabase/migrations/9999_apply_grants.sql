-- =============================================================================
-- 9999 — Tüm modül tabloları oluşturulduktan sonra yetkileri yeniden uygula.
-- Bu dosya HER ZAMAN en son çalışır; yeni bir modül eklendiğinde ayrıca
-- yetki migration'ı yazmaya gerek kalmaz.
-- =============================================================================
select core.apply_grants();
