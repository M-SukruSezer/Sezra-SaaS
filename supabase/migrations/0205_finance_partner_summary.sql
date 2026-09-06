-- =============================================================================
-- 0205 — Cari kartı özeti (finance'e bağımlı)
--
-- Bu görünüm core'a ait ama finance.invoices'a bakıyor. Core migration'ları
-- finance'ten ÖNCE çalıştığı için 0024'te duramaz: temiz bir veritabanında
-- "relation finance.invoices does not exist" ile düşüyordu. Bağımlılığın
-- olduğu yere taşındı.
-- =============================================================================
set client_min_messages = warning;

-- -----------------------------------------------------------------------------
-- Cari kartı özeti
-- -----------------------------------------------------------------------------
/**
 * Cari detayının tek satırlık özeti.
 *
 * ORTALAMA VADE TUTARLA AĞIRLIKLIDIR: on liralık bir faturayla yüz bin
 * liralık bir fatura, vadeyi aynı ölçüde çekmemeli. Basit ortalama alınsaydı
 * küçük ve uzak vadeli tek bir fatura tabloyu bozardı.
 *
 * Görünüm, kartın üstündeki bandın ihtiyacı olan HER ŞEYİ tek sorguda verir;
 * ekranın altı ayrı istek atması gerekmez.
 */
create or replace view core.v_partner_summary
with (security_invoker = true) as
with acik as (
  select i.partner_id,
         -- BAKİYE VADEDEN BAĞIMSIZ: vadesi girilmemiş bir fatura da
         -- alacaktır. İkisi tek koşulda toplanınca, vadesiz fatura
         -- bakiyeden de düşüyordu -- sessiz ve yanlış.
         sum(i.total - i.paid_total) as bakiye,
         count(*) as acik_fatura,
         -- Ağırlıklı ortalama vade YALNIZCA vadesi olanlardan hesaplanır.
         -- Tutarla ağırlıklı: on liralık faturayla yüz bin liralık fatura
         -- vadeyi aynı ölçüde çekmemeli.
         (sum(extract(epoch from i.due_date::timestamp) * (i.total - i.paid_total))
            filter (where i.due_date is not null)
          / nullif(sum(i.total - i.paid_total) filter (where i.due_date is not null), 0)
         ) as agirlikli_epoch,
         count(*) filter (where i.due_date is not null) as vadeli_fatura
  from finance.invoices i
  -- TASLAK ALACAK DEĞİLDİR: müşteriye kesilmemiş bir fatura tahsil
  -- edilemez; bakiyeye katmak alacağı olduğundan büyük gösterirdi.
  where i.kind = 'sale'
    and i.status in ('approved', 'posted', 'partially_paid')
    and i.total > i.paid_total
  group by i.partner_id
)
select
  p.id as partner_id,
  p.tenant_id,
  core.tax_no_valid(p.tax_no) as tax_no_valid,
  coalesce(a.bakiye, 0) as acik_bakiye,
  coalesce(a.acik_fatura, 0) as acik_fatura_sayisi,
  coalesce(a.vadeli_fatura, 0) as vadeli_fatura_sayisi,
  case when a.agirlikli_epoch is null then null
       else to_timestamp(a.agirlikli_epoch)::date end as ortalama_vade,
  (select count(*) from core.partner_contacts c where c.partner_id = p.id) as kisi_sayisi
from core.partners p
left join acik a on a.partner_id = p.id;

comment on view core.v_partner_summary is
  'Cari kartının üst bandı: açık bakiye, tutarla ağırlıklı ortalama vade, '
  'vergi no geçerliliği ve ilgili kişi sayısı.';

select core.apply_grants();
