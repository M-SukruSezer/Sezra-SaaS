-- =============================================================================
-- 0026 — SMS gönderimi
--
-- İKİ TABLO, İKİ AYRI SORUMLULUK: `sms_settings` sağlayıcı yapılandırmasıdır
-- (kiracı başına tek satır), `sms_messages` gönderim kaydıdır. Ayarları
-- mesajın içine gömmek, sağlayıcı değiştiğinde geçmiş mesajların hangi
-- hesaptan gittiğini kaybetmek olurdu.
--
-- İYS İZNİ VERİTABANINDA KONTROL EDİLİR. 6563 sayılı kanuna göre ticari
-- ileti, alıcının KANAL BAZINDA onayı olmadan gönderilemez ve denetimde
-- ispatı gönderende aranır. Kontrolü yalnızca arayüze bırakmak, API'yi
-- doğrudan çağıran bir entegrasyonun izinsiz mesaj atmasına açık kapı
-- bırakırdı — bu bir arayüz tercihi değil, hukuki bir sınır.
--
-- BİLGİLENDİRME İLETİSİ AYRI: "siparişiniz kargoya verildi" ticari ileti
-- değildir ve izin gerektirmez. `is_commercial` bu ayrımı taşır; her mesajı
-- ticari saymak, meşru bilgilendirmeyi de imkânsız kılardı.
-- =============================================================================
set client_min_messages = warning;

create table if not exists core.sms_settings (
  tenant_id     uuid primary key references core.tenants(id) on delete cascade,
  provider      text not null default 'log',
  -- Gönderen adı / başlık. Operatörde tanımlı olmayan başlıkla mesaj gitmez.
  sender        text,
  -- Sağlayıcı kimlik bilgileri. İSTEMCİYE ASLA DÖNÜLMEZ; uçlar bu kolonları
  -- seçmez, yalnızca yazar.
  username      text,
  password      text,
  api_key       text,
  is_active     boolean not null default false,
  updated_by    uuid references core.users(id),
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);

create table if not exists core.sms_messages (
  id            uuid primary key default gen_random_uuid(),
  tenant_id     uuid not null references core.tenants(id) on delete cascade,
  branch_id     uuid references core.branches(id),
  partner_id    uuid references core.partners(id),
  contact_id    uuid references core.partner_contacts(id),
  -- Numara MESAJIN İÇİNDE saklanır: cari sonradan numarasını değiştirirse,
  -- mesajın gerçekte hangi numaraya gittiği kaybolmamalı.
  phone         text not null,
  body          text not null,
  -- Ticari ileti mi: İYS izni yalnızca ticari iletide aranır.
  is_commercial boolean not null default true,
  status        text not null default 'queued'
    check (status in ('queued', 'sent', 'failed', 'blocked')),
  provider      text,
  provider_ref  text,
  error         text,
  sent_at       timestamptz,
  owner_id      uuid references core.users(id),
  created_by    uuid references core.users(id),
  updated_by    uuid references core.users(id),
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);

create index if not exists ix_sms_messages_tenant  on core.sms_messages (tenant_id, created_at desc);
create index if not exists ix_sms_messages_partner on core.sms_messages (tenant_id, partner_id, created_at desc);

select core.attach_updated_at('core', 'sms_settings');
select core.attach_updated_at('core', 'sms_messages');
select core.attach_row_defaults('core', 'sms_messages');
select core.attach_audit('core', 'sms_messages');
select core.attach_audit('core', 'sms_settings');

-- -----------------------------------------------------------------------------
-- Numara normalizasyonu
-- -----------------------------------------------------------------------------
/**
 * Türkiye cep numarasını E.164'e çevirir: +905321234567.
 *
 * Kullanıcı numarayı "0532 123 45 67", "532 1234567", "+90 532..." gibi
 * ondan fazla biçimde yazar. Sağlayıcı tek biçim ister ve yanlış biçimde
 * mesaj sessizce düşer. Normalizasyon TEK YERDE: arayüzde, uçta ve
 * sağlayıcı adapterında ayrı ayrı yazılsaydı üçü ayrışırdı.
 *
 * Cep olmayan numara NULL döner: sabit hatta SMS gitmez ve denemek,
 * sağlayıcıda ücretli bir hata üretir.
 */
create or replace function core.normalize_msisdn(p_phone text)
returns text
language plpgsql immutable as $$
declare
  v text;
begin
  v := regexp_replace(coalesce(p_phone, ''), '[^0-9]', '', 'g');
  if v = '' then return null; end if;

  -- Ülke kodu varyantlarını at: 0090…, 90…, 0…
  if left(v, 4) = '0090' then v := substring(v from 5);
  elsif left(v, 2) = '90' and length(v) = 12 then v := substring(v from 3);
  elsif left(v, 1) = '0' then v := substring(v from 2);
  end if;

  -- Kalan on hane ve 5 ile başlamalı: Türkiye cep numarası.
  if length(v) <> 10 or left(v, 1) <> '5' then return null; end if;
  return '+90' || v;
end $$;

comment on function core.normalize_msisdn(text) is
  'Türkiye cep numarasını E.164 biçimine çevirir. Cep değilse NULL.';

-- -----------------------------------------------------------------------------
-- Gönderim kaydı: izin kontrolü BURADA
-- -----------------------------------------------------------------------------
/**
 * SMS kaydı açar ve izin/numara kontrollerini uygular.
 *
 * Kayıt `queued` ya da `blocked` olarak açılır; gerçek gönderimi uygulama
 * katmanı yapar ve sonucu `core.sms_mark` ile yazar. Gönderimi burada
 * yapmamak bilinçli: veritabanı dışarıya HTTP isteği atmamalı, atarsa
 * işlem süresi ağın insafına kalır ve kilitler uzar.
 *
 * ENGELLENEN MESAJ DA KAYDEDİLİR. Sessizce atmamak, denetimde "neden
 * gönderilmedi" sorusunun cevabını bırakır.
 */
create or replace function core.sms_enqueue(
  p_partner_id uuid,
  p_phone text,
  p_body text,
  p_is_commercial boolean default true,
  p_contact_id uuid default null
) returns core.sms_messages
language plpgsql
security invoker
as $$
declare
  v_tenant uuid := core.current_tenant_id();
  v_p      core.partners;
  v_no     text;
  v_msg    core.sms_messages;
  v_engel  text;
begin
  if v_tenant is null then
    raise exception 'Aktif kiracı yok' using errcode = '42501';
  end if;
  if not core.has_perm('core.sms.send') then
    raise exception 'SMS gönderme yetkiniz yok' using errcode = '42501';
  end if;
  if coalesce(btrim(p_body), '') = '' then
    raise exception 'Mesaj metni boş olamaz' using errcode = '23514';
  end if;

  if p_partner_id is not null then
    select * into v_p from core.partners where id = p_partner_id;
    if not found then
      raise exception 'Cari bulunamadı' using errcode = 'P0002';
    end if;
  end if;

  v_no := core.normalize_msisdn(coalesce(p_phone, v_p.phone));

  if v_no is null then
    v_engel := 'Geçerli bir cep telefonu numarası yok';
  elsif p_is_commercial and p_partner_id is not null and not v_p.consent_sms then
    -- İYS: ticari ileti izinsiz gönderilemez.
    v_engel := 'Bu cari SMS ile ticari ileti iznini vermemiş (İYS)';
  end if;

  insert into core.sms_messages (
    tenant_id, branch_id, partner_id, contact_id, phone, body,
    is_commercial, status, error)
  values (
    v_tenant, v_p.branch_id, p_partner_id, p_contact_id,
    coalesce(v_no, coalesce(p_phone, '')), p_body,
    p_is_commercial,
    case when v_engel is null then 'queued' else 'blocked' end,
    v_engel)
  returning * into v_msg;

  return v_msg;
end $$;

/** Gönderim sonucunu yazar. Uygulama katmanı sağlayıcıdan dönünce çağırır. */
create or replace function core.sms_mark(
  p_id uuid, p_status text, p_provider text default null,
  p_ref text default null, p_error text default null
) returns void
language plpgsql
security invoker as $$
begin
  if p_status not in ('sent', 'failed') then
    raise exception 'Geçersiz durum: %', p_status using errcode = '23514';
  end if;
  update core.sms_messages
     set status = p_status,
         provider = coalesce(p_provider, provider),
         provider_ref = coalesce(p_ref, provider_ref),
         error = p_error,
         sent_at = case when p_status = 'sent' then now() else sent_at end
   where id = p_id and status = 'queued';
  if not found then
    raise exception 'Kuyrukta böyle bir mesaj yok' using errcode = 'P0002';
  end if;
end $$;

-- -----------------------------------------------------------------------------
-- RLS
-- -----------------------------------------------------------------------------
alter table core.sms_settings enable row level security;
alter table core.sms_settings force row level security;
alter table core.sms_messages enable row level security;
alter table core.sms_messages force row level security;

-- AYARLAR YALNIZCA YÖNETİCİYE: içinde sağlayıcı parolası var.
drop policy if exists p_sms_settings_all on core.sms_settings;
create policy p_sms_settings_all on core.sms_settings for all
  using (tenant_id = (select core.current_tenant_id())
         and (select core.has_perm('core.sms.configure')))
  with check (tenant_id = (select core.current_tenant_id())
              and (select core.has_perm('core.sms.configure')));

drop policy if exists p_sms_messages_select on core.sms_messages;
create policy p_sms_messages_select on core.sms_messages for select
  using (tenant_id = (select core.support_tenant_id())
         or (tenant_id = (select core.current_tenant_id())
             and (select core.has_perm('core.sms.read'))));

drop policy if exists p_sms_messages_write on core.sms_messages;
create policy p_sms_messages_write on core.sms_messages for all
  using (tenant_id = (select core.current_tenant_id())
         and (select core.has_perm('core.sms.send')))
  with check (tenant_id = (select core.current_tenant_id())
              and (select core.has_perm('core.sms.send')));

-- -----------------------------------------------------------------------------
-- İzinler
-- -----------------------------------------------------------------------------
select core.declare_permission('core.sms.send', 'core', 'core.sms', 'create',
  'SMS gönder');
select core.declare_permission('core.sms.read', 'core', 'core.sms', 'read',
  'SMS geçmişini görüntüle');
select core.declare_permission('core.sms.configure', 'core', 'core.sms', 'write',
  'SMS sağlayıcı ayarlarını değiştir');

select core.grant_to_role('tenant_admin',
  array['core.sms.send', 'core.sms.read', 'core.sms.configure']);
-- Satış SMS atar ve geçmişi görür ama sağlayıcı ayarına dokunamaz: ayarda
-- operatör parolası var.
select core.grant_to_role('sales', array['core.sms.send', 'core.sms.read']);

comment on table core.sms_messages is
  'SMS gönderim kaydı. Engellenen mesaj da saklanır: denetimde "neden '
  'gönderilmedi" sorusunun cevabı burada.';
