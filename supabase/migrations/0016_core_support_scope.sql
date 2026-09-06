-- =============================================================================
-- 0016 — Destek erişimini seçilen kiracıya daralt
-- =============================================================================
-- ÖNCEKİ DAVRANIŞ: politikalarda `(select core.is_support_session())` koşulsuz
-- bir baypastı. Destek modundaki platform yöneticisi, hangi kiracıyı seçtiğinden
-- BAĞIMSIZ olarak tüm kiracıların verisini görüyordu. Ölçülen sonuç: Örnek Ticaret
-- seçiliyken finance.accounts sorgusu 2 kiracının 126 satırını döndürüyordu.
--
-- İki sorun üretiyordu:
--   1. Bir müşteriye destek verirken yanlışlıkla BAŞKA müşterinin verisine
--      bakmak mümkündü.
--   2. Denetim izi erişimi tek bir kiracıya atfediyordu; oysa erişim hepsineydi.
--
-- YENİ DAVRANIŞ: `tenant_id = (select core.support_tenant_id())`. Destek modu
-- artık "seçtiğim kiracının üyesiymişim gibi davran" demek. Kiracı seçilmemişse
-- hiçbir şey görünmez.
--
-- Bu dosya, ZATEN GÖÇÜRÜLMÜŞ bir veritabanının politikalarını yeniden üretir.
-- Sıfırdan kurulan veritabanlarında 0005'teki üretici zaten yeni hâliyle
-- çalışır; buradaki çağrı o durumda yalnızca aynı politikaları tazeler.
-- =============================================================================

do $$
declare n integer;
begin
  select core.reapply_rls_all() into n;
  raise notice 'Destek kapsamı % modül tablosuna yeniden uygulandı', n;
end $$;
