-- =============================================================================
-- 1004 — Destek taleplerinin portal görünürlüğü
--
-- Müşteri kendi açtığı destek taleplerini görür. Yazma yok: portaldan talep
-- açma ayrı bir uçtur ve ayrı denetlenir.
-- =============================================================================
set client_min_messages = warning;

select core.attach_portal_policy('helpdesk', 'tickets');
