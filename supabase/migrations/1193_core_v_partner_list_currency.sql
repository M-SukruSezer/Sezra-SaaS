-- =============================================================================
-- 1193 — v_partner_list görünümünü currency kolonu için yeniden oluştur
--        (T-033 kart 1.1'in tamamlayıcısı)
--
-- /core/partners kaynağı v_partner_list üzerinden okur (coreModule.ts
-- readFrom: 'v_partner_list'). PostgreSQL bir görünümdeki "select pa.*"
-- ifadesini görünüm OLUŞTURULDUĞU an sabit kolon listesine çevirir; 1192'de
-- core.partners'a eklenen currency kolonu görünüme otomatik yansımaz.
-- Görünümü aynı tanımla yeniden oluşturmak kolonu dahil eder, yoksa
-- "column currency does not exist" ile liste ekranı düşer.
--
-- Tanım 0103_crm_list_views.sql ile birebir aynı (yalnızca * yeniden çözülür).
-- =============================================================================
-- DROP zorunlu: CREATE OR REPLACE var olan sutunlarin siralamasi degismis olsa
-- bile eskiyi silmeden kabul etmez; goruntunun bagli nesnesi yok (0103 migration'i
-- yalnizca SELECT verir, baska goruntu veya fonksiyon bu gorunteden bagimsiz).
drop view if exists core.v_partner_list;

create view core.v_partner_list
with (security_invoker = on) as
select pa.*,
       u.full_name as owner_name,
       b.name      as branch_name,
       core.tax_no_valid(pa.tax_no) as tax_no_valid
from core.partners pa
left join core.users u on u.id = pa.owner_id
left join core.branches b on b.id = pa.branch_id;

select core.apply_grants();
