-- =============================================================================
-- 0021 — Platform iletişim bilgileri
--
-- Üst çubuktaki "Bize ulaşın" kutusunda görünen numaralar. Marka logosuyla
-- aynı tabloda ve aynı kuralla: SEZRA'nın kendi bilgisidir, kiracının değil.
-- Bir kiracı bunu değiştirebilseydi, kendi müşterisine Sezra'nın destek
-- numarası diye başka bir numara gösterebilirdi.
--
-- OKUMA HERKESE AÇIK: numara giriş ekranında da görünebilmeli; kurulum
-- sırasında takılan kullanıcı henüz oturum açamamış olabilir ve tam da o an
-- aramaya ihtiyaç duyar.
--
-- ETİKETLER DE SAKLANIR ("sabit" / "cep"): numaranın türü sabit kodlanırsa,
-- ileride üçüncü bir numara ya da farklı bir etiket gerektiğinde arayüz
-- değiştirmek gerekir. Etiketi veriyle taşımak bunu ayar hâline getirir.
-- =============================================================================

alter table core.platform_settings
  add column if not exists contact_note      text,
  add column if not exists contact_phone1    text,
  add column if not exists contact_phone1_label text,
  add column if not exists contact_phone2    text,
  add column if not exists contact_phone2_label text,
  add column if not exists contact_whatsapp  text;

/**
 * İletişim bilgilerini ayarlar.
 *
 * Boş string ile NULL AYNI ŞEYDİR: arayüzden temizlenen bir alan boş string
 * gönderir, ama "numara yok" durumu NULL olmalı ki okuma tarafı boş bir
 * satır çizmesin.
 */
create or replace function core.platform_set_contact(
  p_note      text,
  p_phone1    text,
  p_label1    text,
  p_phone2    text,
  p_label2    text,
  p_whatsapp  text
) returns void
language plpgsql
security definer
set search_path = core, pg_temp
as $$
declare
  v_bos constant text := '';
begin
  perform core.platform_guard();

  update core.platform_settings
     set contact_note         = nullif(btrim(coalesce(p_note, v_bos)), v_bos),
         contact_phone1       = nullif(btrim(coalesce(p_phone1, v_bos)), v_bos),
         contact_phone1_label = nullif(btrim(coalesce(p_label1, v_bos)), v_bos),
         contact_phone2       = nullif(btrim(coalesce(p_phone2, v_bos)), v_bos),
         contact_phone2_label = nullif(btrim(coalesce(p_label2, v_bos)), v_bos),
         contact_whatsapp     = nullif(btrim(coalesce(p_whatsapp, v_bos)), v_bos),
         updated_at           = now()
   where id;

  perform core.platform_log(null, 'update', 'platform_settings', null, null,
    jsonb_build_object('contact', 'set'));
end;
$$;

-- Marka okuma iletişimi de taşır: üst çubuk tek çağrıda kurulsun.
drop function if exists core.platform_branding();

create or replace function core.platform_branding()
returns table (
  logo_data_uri      text,
  logo_mime          text,
  logo_dark_data_uri text,
  logo_dark_mime     text,
  logo_updated_at    timestamptz,
  contact_note       text,
  contact_phone1     text,
  contact_phone1_label text,
  contact_phone2     text,
  contact_phone2_label text,
  contact_whatsapp   text
)
language sql
stable
security definer
set search_path = core, pg_temp
as $$
  select s.logo_data_uri, s.logo_mime,
         s.logo_dark_data_uri, s.logo_dark_mime,
         s.logo_updated_at,
         s.contact_note,
         s.contact_phone1, s.contact_phone1_label,
         s.contact_phone2, s.contact_phone2_label,
         s.contact_whatsapp
  from core.platform_settings s
  where s.id;
$$;

select core.apply_grants();
