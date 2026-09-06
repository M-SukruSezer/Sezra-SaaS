-- =============================================================================
-- 0104 — CRM tablolarının portal görünürlüğü
--
-- Politikayı çekirdek değil modül takar: çekirdek migration'ları modüllerden
-- önce koşar, dolayısıyla `0027` içinde `crm.quotations` adını anmak tablo
-- henüz yokken politika yazmaya çalışmak olurdu.
--
-- Müşteri kendi teklifini ve siparişini görür. FIRSAT (opportunity) BİLEREK
-- DIŞARIDA: içinde kazanma olasılığı ve iç notlar var; müşteriye gösterilecek
-- veri değil.
-- =============================================================================
set client_min_messages = warning;

select core.attach_portal_policy('crm', 'quotations');
select core.attach_portal_policy('crm', 'sale_orders');
