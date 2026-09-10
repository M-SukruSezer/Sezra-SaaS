-- =============================================================================
-- 1170 -- Cari kartina resmi sicil alanlari: MERSIS no, vergi dairesi kodu,
--         mukellefiyet turu (T-028: VKN'den firma bilgisi otomatik getirme)
-- =============================================================================
-- KESIF (dispatch'te dogrulandi): core.partners'ta bugun mersis_no,
-- tax_office_code ve mukellefiyet turu YOK. VKN'den gelen firma bilgisini
-- karta yazabilmek icin uc NULLABLE kolon ekleniyor.
--
-- MEVCUT KAYITLAR VE CALISAN OZELLIKLER ETKILENMEZ:
--   - Ucu de nullable, varsayilan yok. Eski cariler NULL kalir.
--   - CHECK kisitlari yalnizca DOLU degeri sinar; NULL her zaman gecer.
--   - v_partner_list "select pa.*" ile kuruldugu icin yeni kolonlari
--     otomatik ALMAZ; gorunum yeniden olusturuluyor (bagimli SQL gorunumu yok,
--     yalniz uygulama okuyor).
-- =============================================================================
set client_min_messages = warning;

alter table core.partners
  -- MERSIS: Merkezi Sicil Kayit Sistemi numarasi. 16 hane.
  add column if not exists mersis_no          text,
  -- GIB vergi dairesi kodu (ornek: "034261" Buyuk Mukellefler VD). Vergi
  -- dairesi ADI (tax_office) zaten var; kod ondan ayri ve GIB entegrasyonunda
  -- kullanilir.
  add column if not exists tax_office_code    text,
  -- Mukellefiyet / vergi turu: "gercek", "tuzel", "basit usul" gibi. Saglayici
  -- bunu her zaman vermez; serbest metin, sozluge baglamiyoruz.
  add column if not exists tax_liability_type text;

-- Format kontrolleri: yalnizca DOLU deger sinanir (mevcut NULL kayitlar gecer).
do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'ck_partners_mersis_no') then
    alter table core.partners
      add constraint ck_partners_mersis_no
      check (mersis_no is null or mersis_no ~ '^[0-9]{16}$');
  end if;
  if not exists (select 1 from pg_constraint where conname = 'ck_partners_tax_office_code') then
    alter table core.partners
      add constraint ck_partners_tax_office_code
      check (tax_office_code is null or tax_office_code ~ '^[0-9]{1,10}$');
  end if;
  if not exists (select 1 from pg_constraint where conname = 'ck_partners_tax_liability_type') then
    alter table core.partners
      add constraint ck_partners_tax_liability_type
      check (tax_liability_type is null or length(tax_liability_type) <= 60);
  end if;
end $$;

comment on column core.partners.mersis_no is
  'Merkezi Sicil Kayit Sistemi numarasi (16 hane). VKN sorgusundan gelebilir.';
comment on column core.partners.tax_office_code is
  'GIB vergi dairesi kodu. tax_office (ad) alanindan ayridir.';
comment on column core.partners.tax_liability_type is
  'Mukellefiyet / vergi turu (serbest metin, en fazla 60 karakter).';

-- -----------------------------------------------------------------------------
-- v_partner_list: "select pa.*" yeni kolonlari otomatik almadigi icin yeniden
-- olusturuluyor. Tanim 0103_crm_list_views.sql ile bire bir ayni; yalnizca
-- kaynak tablo artik 3 kolon daha tasiyor.
-- -----------------------------------------------------------------------------
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
