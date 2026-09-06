-- =============================================================================
-- 0018 — Marka: açık ve koyu tema için ayrı logo
--
-- NEDEN İKİ DOSYA, TEK DOSYA + FİLTRE DEĞİL:
--   Koyu zeminde okunsun diye logoyu CSS ile ters çevirmek (`filter: invert`)
--   markanın rengini bozar: lacivert bir işaret sarıya döner. Kurumsal kimlik
--   kılavuzları zaten iki ayrı dosya tanımlar; ürün de onu saklamalı.
--
-- KOYU VARYANT ZORUNLU DEĞİLDİR:
--   Yalnızca açık varyant yüklenirse iki temada da o kullanılır. Böylece tek
--   dosyayla da çalışır; iki dosya bir zorunluluk değil, bir incelik olur.
--
-- `logo_data_uri` AÇIK varyanttır ve adı DEĞİŞMEZ: 0017'de yazılmış veriyi
-- taşımak için yeniden adlandırmak yerine, koyu varyant yanına eklenir.
-- =============================================================================

alter table core.platform_settings
  add column if not exists logo_dark_data_uri text,
  add column if not exists logo_dark_mime     text,
  add column if not exists logo_dark_bytes    integer;

-- Eski imzalar yerini varyant alan sürümlere bırakır. `platform_branding`
-- de düşürülür: dönüş tipi değiştiği için `create or replace` yetmez.
drop function if exists core.platform_set_logo(text, text, integer);
drop function if exists core.platform_clear_logo();
drop function if exists core.platform_branding();

/**
 * Logoyu ayarlar.
 *
 * `p_variant`: 'light' (açık zemin, varsayılan) ya da 'dark'.
 *
 * DOĞRULAMA BURADA DA YAPILIR: API katmanı da doğruluyor, ama oradaki bir
 * unutma bu tabloya çöp yazabilirdi. İki katman da aynı sözleşmeyi uygular.
 */
create or replace function core.platform_set_logo(
  p_data_uri text,
  p_mime     text,
  p_bytes    integer,
  p_variant  text default 'light'
) returns void
language plpgsql
security definer
set search_path = core, pg_temp
as $$
begin
  perform core.platform_guard();

  if p_variant not in ('light', 'dark') then
    raise exception 'Geçersiz logo varyantı: %', p_variant using errcode = '22023';
  end if;

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

  if p_variant = 'dark' then
    update core.platform_settings
       set logo_dark_data_uri = p_data_uri,
           logo_dark_mime     = p_mime,
           logo_dark_bytes    = p_bytes,
           logo_updated_at    = now(),
           logo_updated_by    = core.current_user_id(),
           updated_at         = now()
     where id;
  else
    update core.platform_settings
       set logo_data_uri    = p_data_uri,
           logo_mime        = p_mime,
           logo_bytes       = p_bytes,
           logo_updated_at  = now(),
           logo_updated_by  = core.current_user_id(),
           updated_at       = now()
     where id;
  end if;

  -- Kiracı yok: bu bir platform kaydıdır, müşteri verisi değil.
  perform core.platform_log(null, 'update', 'platform_settings', null, null,
    jsonb_build_object('logo', 'set', 'variant', p_variant,
                       'mime', p_mime, 'bytes', p_bytes));
end;
$$;

create or replace function core.platform_clear_logo(p_variant text default 'light')
returns void
language plpgsql
security definer
set search_path = core, pg_temp
as $$
begin
  perform core.platform_guard();

  if p_variant not in ('light', 'dark') then
    raise exception 'Geçersiz logo varyantı: %', p_variant using errcode = '22023';
  end if;

  if p_variant = 'dark' then
    update core.platform_settings
       set logo_dark_data_uri = null, logo_dark_mime = null, logo_dark_bytes = null,
           logo_updated_at = now(), logo_updated_by = core.current_user_id(),
           updated_at = now()
     where id;
  else
    update core.platform_settings
       set logo_data_uri = null, logo_mime = null, logo_bytes = null,
           logo_updated_at = now(), logo_updated_by = core.current_user_id(),
           updated_at = now()
     where id;
  end if;

  perform core.platform_log(null, 'update', 'platform_settings', null, null,
    jsonb_build_object('logo', 'cleared', 'variant', p_variant));
end;
$$;

/**
 * Marka okuma.
 *
 * Kimlik doğrulamasız çağrılır (giriş ekranı). İki varyantı da döndürür;
 * hangisinin gösterileceğine istemci karar verir çünkü etkin temayı yalnızca
 * tarayıcı bilir (`prefers-color-scheme` sunucuya ulaşmaz).
 */
create or replace function core.platform_branding()
returns table (
  logo_data_uri      text,
  logo_mime          text,
  logo_dark_data_uri text,
  logo_dark_mime     text,
  logo_updated_at    timestamptz
)
language sql
stable
security definer
set search_path = core, pg_temp
as $$
  select s.logo_data_uri, s.logo_mime,
         s.logo_dark_data_uri, s.logo_dark_mime,
         s.logo_updated_at
  from core.platform_settings s
  where s.id;
$$;

select core.apply_grants();
