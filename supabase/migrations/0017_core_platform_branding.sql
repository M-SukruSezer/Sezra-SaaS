-- =============================================================================
-- 0017 — Platform markası: SaaS yöneticisinin yönettiği ürün logosu
--
-- NEDEN AYRI BİR TABLO, KİRACI AYARI DEĞİL:
--   Bu logo ürünün (Sezra) kendi markasıdır, müşterinin değil. Kiracı başına
--   tutulsaydı her kiracı kendi kopyasını değiştirebilirdi; oysa burada
--   değiştirebilecek tek kişi platform yöneticisidir. Tablo tek satırlıdır ve
--   `tenant_id` TAŞIMAZ — taşısaydı RLS motoru onu kiracıya kapsardı ve
--   giriş ekranı (kiracısı belli olmayan bir bağlam) logoyu hiç göremezdi.
--
-- OKUMA HERKESE AÇIK, YAZMA YALNIZCA PLATFORM YÖNETİCİSİNE:
--   Logo giriş sayfasında, yani kimlik doğrulamadan ÖNCE görünür. Bu yüzden
--   okuma kimlik istemez. Yazma ise `core.platform_guard()` ile korunur:
--   kontrol uygulama katmanında değil, burada — atlanması imkânsız olsun diye.
-- =============================================================================

create table if not exists core.platform_settings (
  -- Tek satır garantisi: birincil anahtar sabit `true`, ikinci satır eklenemez.
  id              boolean primary key default true check (id),
  logo_data_uri   text,
  logo_mime       text,
  logo_bytes      integer,
  logo_updated_at timestamptz,
  logo_updated_by uuid references core.users(id),
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);

insert into core.platform_settings (id) values (true)
on conflict (id) do nothing;

alter table core.platform_settings enable row level security;
alter table core.platform_settings force row level security;

-- Okuma serbest: marka logosu zaten herkese görünen bir varlıktır ve giriş
-- ekranında kimlik yokken de gerekir. Tabloda müşteri verisi yoktur.
drop policy if exists p_platform_settings_select on core.platform_settings;
create policy p_platform_settings_select on core.platform_settings
  for select using (true);

-- Yazma politikası YOKTUR. Değişiklik yalnızca aşağıdaki SECURITY DEFINER
-- fonksiyonlarından geçer; doğrudan update denemesi politikasızlıktan düşer.

-- -----------------------------------------------------------------------------
-- Logo yazma / silme
-- -----------------------------------------------------------------------------

/**
 * Logoyu ayarlar.
 *
 * DOĞRULAMA BURADA DA YAPILIR: API katmanı da doğruluyor, ama oradaki bir
 * unutma bu tabloya çöp yazabilirdi. Boyut ve tür kontrolü veritabanında da
 * durur — iki katman da aynı sözleşmeyi uygular.
 */
create or replace function core.platform_set_logo(
  p_data_uri text,
  p_mime     text,
  p_bytes    integer
) returns void
language plpgsql
security definer
set search_path = core, pg_temp
as $$
begin
  perform core.platform_guard();

  if p_data_uri is null or p_data_uri = '' then
    raise exception 'Logo içeriği boş olamaz' using errcode = '22023';
  end if;

  if p_mime not in ('image/png', 'image/jpeg', 'image/webp', 'image/svg+xml') then
    raise exception 'Desteklenmeyen görsel türü: %', p_mime using errcode = '22023';
  end if;

  -- 512 KB üstü bir logo, her sayfa yüklemesinde taşınacak bir yüktür.
  if p_bytes is null or p_bytes <= 0 or p_bytes > 524288 then
    raise exception 'Logo boyutu 512 KB''ı aşamaz' using errcode = '22023';
  end if;

  if p_data_uri not like 'data:' || p_mime || ';base64,%' then
    raise exception 'Logo içeriği bildirilen türle uyuşmuyor' using errcode = '22023';
  end if;

  update core.platform_settings
     set logo_data_uri   = p_data_uri,
         logo_mime       = p_mime,
         logo_bytes      = p_bytes,
         logo_updated_at = now(),
         logo_updated_by = core.current_user_id(),
         updated_at      = now()
   where id;

  -- Kiracı yok: bu bir platform kaydıdır, müşteri verisi değil.
  perform core.platform_log(null, 'update', 'platform_settings', null, null,
    jsonb_build_object('logo', 'set', 'mime', p_mime, 'bytes', p_bytes));
end;
$$;

create or replace function core.platform_clear_logo()
returns void
language plpgsql
security definer
set search_path = core, pg_temp
as $$
begin
  perform core.platform_guard();

  update core.platform_settings
     set logo_data_uri   = null,
         logo_mime       = null,
         logo_bytes      = null,
         logo_updated_at = now(),
         logo_updated_by = core.current_user_id(),
         updated_at      = now()
   where id;

  perform core.platform_log(null, 'update', 'platform_settings', null, null,
    jsonb_build_object('logo', 'cleared'));
end;
$$;

/**
 * Marka okuma.
 *
 * Kimlik doğrulamasız çağrılır (giriş ekranı). Yalnızca logoyu ve son
 * güncelleme zamanını döndürür; kimin değiştirdiği burada YOKTUR — o bilgi
 * platform konsoluna aittir, anonim bir uca değil.
 */
create or replace function core.platform_branding()
returns table (logo_data_uri text, logo_mime text, logo_updated_at timestamptz)
language sql
stable
security definer
set search_path = core, pg_temp
as $$
  select s.logo_data_uri, s.logo_mime, s.logo_updated_at
  from core.platform_settings s
  where s.id;
$$;

select core.apply_grants();
