-- =============================================================================
-- 1160 -- Kullanicinin kendi e-posta hesabini baglamasi (IMAP / POP3 / Graph / Gmail)
-- =============================================================================
-- TEK, SAGLAYICI-BAGIMSIZ MODEL: `core.mail_accounts`. Dort saglayici icin dort
-- ayri sema yok. Saglayiciya ozel olan kisimlar iki yerde saklanir:
--   - config  jsonb : gizli OLMAYAN baglanti ayarlari (sunucu, port, guvenlik,
--                      kullanici adi, oauth kapsamlari). Duz metin, sorunsuz.
--   - secret_cipher  : gizli olan her sey (parola, access/refresh token, client
--                      secret) UYGULAMA KATMANINDA sifrelenmis tek bir blob.
--                      Veritabani icin OPAK: cozemez, anlamlandiramaz.
--
-- GUVENLIK -- pazarlik konusu degil:
--   1. RLS: bir kullanici YALNIZCA kendi hesaplarini gorur/yonetir. owner_id =
--      current_user_id(). Kiraci yoneticisi bile baskasinin satirini goremez;
--      destek modu (support_tenant_id) da BURADA baypas ETMEZ -- kisisel posta
--      kisiseldir.
--   2. secret_cipher hicbir OKUMA fonksiyonundan donmez. core.mail_account_list()
--      onu SELECT etmez; yalnizca "gizli tanimli mi" (has_secret) doner. Blobun
--      kendisine erisen tek yol, uygulamanin RLS altinda yaptigi ic sorgudur
--      (baglanti dogrulama / posta cekme) ve o da HTTP yanitina koymaz.
--   3. Denetim izi SCRUB'LU: genel core.attach_audit KULLANILMAZ (o to_jsonb(new)
--      ile tum satiri, yani cipher'i, audit_log'a yazardi). Yerine
--      core.mail_account_audit yalnizca eylem + saglayici + e-posta yazar.
--
-- KAPSAM: yalnizca BAGLANTI KURULUMU. Posta cekme/gonderme/gelen kutusu bu
-- migration'da yok.
-- =============================================================================
set client_min_messages = warning;

-- -----------------------------------------------------------------------------
-- Tablo
-- -----------------------------------------------------------------------------
create table if not exists core.mail_accounts (
  id            uuid primary key default gen_random_uuid(),
  -- SAHIP: hesabi baglayan kullanici. RLS'in tek dayanagi.
  owner_id      uuid not null references core.users(id) on delete cascade,
  -- Baglam icin kiraci (hangi calisma alaninda eklendi). RLS BUNU KULLANMAZ.
  -- Kisisel hesap kiracisiz de olabilir (platform yoneticisi).
  tenant_id     uuid references core.tenants(id) on delete set null,
  provider      text not null check (provider in ('imap', 'pop3', 'ms_graph', 'gmail')),
  -- Kullanicinin verdigi etiket ("Is e-postam").
  display_name  text not null check (length(btrim(display_name)) between 1 and 120),
  email_address text not null check (position('@' in email_address) > 1),
  -- Gizli OLMAYAN baglanti ayarlari (sunucu/port/guvenlik/kullanici adi/kapsam).
  config        jsonb not null default '{}'::jsonb,
  -- Uygulama katmaninda sifrelenmis gizli demet. NULL = kimlik bilgisi girilmedi.
  -- Bicim uygulamaya ait ("v1:iv:tag:ct"); veritabani icin sadece metin.
  secret_cipher text,
  -- Baglanti durumu.
  status        text not null default 'pending'
    check (status in ('pending', 'verified', 'error', 'expired')),
  -- Kullaniciya gosterilecek son durum aciklamasi (yanlis parola / TLS hatasi vb.).
  status_detail text,
  last_verified_at timestamptz,
  -- OAuth: saklanan access token'in bitis zamani (status='expired' bundan turer).
  token_expires_at timestamptz,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);

create index if not exists ix_mail_accounts_owner on core.mail_accounts (owner_id, created_at desc);
-- Ayni kullanici ayni adresi ayni saglayiciyla iki kez baglayamaz.
create unique index if not exists ux_mail_accounts_owner_provider_email
  on core.mail_accounts (owner_id, provider, lower(email_address));

select core.attach_updated_at('core', 'mail_accounts');
-- attach_row_defaults: owner_id / tenant_id / *_by kolonlarini otomatik doldurur
-- (bu tabloda owner_id ve tenant_id). Fonksiyonlar da acikca set eder;
-- tetikleyici ikinci savunma.
select core.attach_row_defaults('core', 'mail_accounts');
-- DIKKAT: core.attach_audit BILEREK CAGRILMIYOR -- cipher'i audit_log'a yazardi.

-- -----------------------------------------------------------------------------
-- RLS -- yalnizca sahip
-- -----------------------------------------------------------------------------
alter table core.mail_accounts enable row level security;
alter table core.mail_accounts force row level security;

drop policy if exists p_mail_accounts_own on core.mail_accounts;
create policy p_mail_accounts_own on core.mail_accounts for all
  using (owner_id = (select core.current_user_id()))
  with check (owner_id = (select core.current_user_id()));

-- -----------------------------------------------------------------------------
-- Scrub'lu denetim -- gizli asla yazilmaz
-- -----------------------------------------------------------------------------
create or replace function core.mail_account_audit(
  p_action core.audit_action, p_id uuid, p_provider text, p_email text
)
returns void
language sql
security definer
set search_path = core, pg_temp
as $$
  insert into core.audit_log (
    tenant_id, actor_id, action, entity_schema, entity_table, entity_id,
    changed_fields, new_data, support_session)
  values (
    core.current_tenant_id(), core.current_user_id(), p_action,
    'core', 'mail_accounts', p_id,
    array['status'],
    -- YALNIZCA gizli olmayan alanlar. Parola/token BURAYA GIRMEZ.
    jsonb_build_object('provider', p_provider, 'email_address', p_email),
    false);
$$;

comment on function core.mail_account_audit(core.audit_action, uuid, text, text) is
  'core.mail_accounts icin scrub''lu denetim kaydi: eylem + saglayici + e-posta. '
  'Gizli kimlik bilgisi (secret_cipher) ASLA yazilmaz.';

-- -----------------------------------------------------------------------------
-- CRUD -- hepsi security definer, owner_id = current_user_id() ile kendi kendini
-- sinirlar. Oturum yoksa reddeder. Kimse baskasinin hesabina dokunamaz.
-- -----------------------------------------------------------------------------

-- Listeler: SADECE benim hesaplarim. secret_cipher DONMEZ.
create or replace function core.mail_account_list()
returns table (
  id               uuid,
  provider         text,
  display_name     text,
  email_address    text,
  config           jsonb,
  status           text,
  status_detail    text,
  last_verified_at timestamptz,
  token_expires_at timestamptz,
  has_secret       boolean,
  created_at       timestamptz,
  updated_at       timestamptz
)
language sql
stable
security definer
set search_path = core, pg_temp
as $$
  select
    a.id, a.provider, a.display_name, a.email_address, a.config,
    a.status, a.status_detail, a.last_verified_at, a.token_expires_at,
    (a.secret_cipher is not null) as has_secret,
    a.created_at, a.updated_at
  from core.mail_accounts a
  where a.owner_id = core.current_user_id()
  order by a.created_at desc;
$$;

comment on function core.mail_account_list() is
  'Oturumdaki kullanicinin bagli mail hesaplari. secret_cipher DONMEZ; yalnizca has_secret.';

-- Kaydeder (yeni ya da guncelleme). p_secret_cipher NULL ise mevcut gizli KORUNUR
-- (kullanici parolayi tekrar girmeden ayar duzenleyebilsin). p_secret_cipher ''
-- ise gizli SILINIR ve durum 'pending'e doner.
create or replace function core.mail_account_save(
  p_id            uuid,
  p_provider      text,
  p_display_name  text,
  p_email         text,
  p_config        jsonb default '{}'::jsonb,
  p_secret_cipher text default null
)
returns uuid
language plpgsql
security definer
set search_path = core, pg_temp
as $$
declare
  v_user uuid := core.current_user_id();
  v_id   uuid;
  v_new  boolean := (p_id is null);
  v_act  core.audit_action;
begin
  if v_user is null then
    raise exception 'Oturum yok' using errcode = '42501';
  end if;
  if p_provider is null or p_provider not in ('imap', 'pop3', 'ms_graph', 'gmail') then
    raise exception 'Gecersiz saglayici: %', coalesce(p_provider, '(bos)') using errcode = '23514';
  end if;
  if coalesce(btrim(p_display_name), '') = '' then
    raise exception 'Etiket bos olamaz' using errcode = '23514';
  end if;
  if coalesce(p_email, '') !~ '^[^@[:space:]]+@[^@[:space:]]+$' then
    raise exception 'Gecersiz e-posta adresi' using errcode = '23514';
  end if;

  if v_new then
    insert into core.mail_accounts (
      owner_id, tenant_id, provider, display_name, email_address, config,
      secret_cipher,
      status)
    values (
      v_user, core.current_tenant_id(), p_provider, btrim(p_display_name), lower(btrim(p_email)),
      coalesce(p_config, '{}'::jsonb),
      nullif(p_secret_cipher, ''),
      'pending')
    returning id into v_id;
    v_act := 'insert';
  else
    update core.mail_accounts a set
      provider      = p_provider,
      display_name  = btrim(p_display_name),
      email_address = lower(btrim(p_email)),
      config        = coalesce(p_config, '{}'::jsonb),
      -- NULL: dokunma. '': sil. Aksi: yeni deger.
      secret_cipher = case
                        when p_secret_cipher is null then a.secret_cipher
                        when p_secret_cipher = ''    then null
                        else p_secret_cipher
                      end,
      -- Gizli degistiyse ya da silindiyse yeniden dogrulanmali.
      status        = case when p_secret_cipher is not null then 'pending' else a.status end,
      status_detail = case when p_secret_cipher is not null then null else a.status_detail end
    where a.id = p_id and a.owner_id = v_user
    returning a.id into v_id;
    if v_id is null then
      raise exception 'Mail hesabi bulunamadi' using errcode = 'P0002';
    end if;
    v_act := 'update';
  end if;

  perform core.mail_account_audit(v_act, v_id, p_provider, lower(btrim(p_email)));
  return v_id;
end;
$$;

comment on function core.mail_account_save(uuid, text, text, text, jsonb, text) is
  'Bagli mail hesabi kaydeder. p_secret_cipher: NULL=koru, ''''=sil, aksi=yeni sifreli demet. '
  'Yalnizca oturumdaki kullanicinin kendi hesabi.';

-- Durum yazar (uygulama, baglanti dogrulamasindan / token yenilemesinden sonra cagirir).
create or replace function core.mail_account_set_status(
  p_id uuid, p_status text, p_detail text default null, p_token_expires_at timestamptz default null
)
returns void
language plpgsql
security definer
set search_path = core, pg_temp
as $$
declare v_user uuid := core.current_user_id();
begin
  if v_user is null then
    raise exception 'Oturum yok' using errcode = '42501';
  end if;
  if p_status not in ('pending', 'verified', 'error', 'expired') then
    raise exception 'Gecersiz durum: %', p_status using errcode = '23514';
  end if;
  update core.mail_accounts a set
    status           = p_status,
    status_detail    = p_detail,
    last_verified_at = case when p_status = 'verified' then now() else a.last_verified_at end,
    token_expires_at = coalesce(p_token_expires_at, a.token_expires_at)
  where a.id = p_id and a.owner_id = v_user;
  if not found then
    raise exception 'Mail hesabi bulunamadi' using errcode = 'P0002';
  end if;
end;
$$;

-- Siler. Yalnizca kendi hesabi.
create or replace function core.mail_account_delete(p_id uuid)
returns void
language plpgsql
security definer
set search_path = core, pg_temp
as $$
declare
  v_user uuid := core.current_user_id();
  v_row  core.mail_accounts;
begin
  if v_user is null then
    raise exception 'Oturum yok' using errcode = '42501';
  end if;
  delete from core.mail_accounts a
   where a.id = p_id and a.owner_id = v_user
  returning a.* into v_row;
  if v_row.id is null then
    raise exception 'Mail hesabi bulunamadi' using errcode = 'P0002';
  end if;
  perform core.mail_account_audit('delete', v_row.id, v_row.provider, v_row.email_address);
end;
$$;

-- 9999_apply_grants.sql en sonda calisir ve sezra_app'e tum core tablolarinda
-- DML + fonksiyonlarda EXECUTE verir; bu tablo/fonksiyonlar da kapsanir.
