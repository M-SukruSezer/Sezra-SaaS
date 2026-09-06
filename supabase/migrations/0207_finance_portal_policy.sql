-- =============================================================================
-- 0207 — Finans tablolarının portal görünürlüğü
--
-- Müşteri kendi faturasını görür. ÇEK/SENET PORTFÖYÜ DIŞARIDA: kendi verdiği
-- çekin durumunu görmek makul görünse de aynı tabloda başka carilere ciro
-- edilmiş kayıtlar ve tahsilat stratejisi duruyor.
-- =============================================================================
set client_min_messages = warning;

select core.attach_portal_policy('finance', 'invoices');
