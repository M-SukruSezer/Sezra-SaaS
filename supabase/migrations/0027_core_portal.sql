-- =============================================================================
-- 0027 — Müşteri portalı
--
-- Müşteri, kendi faturasını ve siparişini görmek için şirketi aramak zorunda
-- kalmasın. Portal kullanıcısı bir MÜŞTERİ TEMSİLCİSİDİR, personel değildir:
-- yalnızca kendi firmasının belgelerini görür, hiçbir şey yazamaz.
--
-- KAPSAM ÜYELİKTE TAŞINIR. `memberships.portal_partner_id` doluysa o üyelik
-- bir portal üyeliğidir ve o cariye bağlıdır. Kapsamı uygulama katmanında
-- bir süzgeçle taşımak, tek bir unutulmuş sorguda başka müşterinin faturasını
-- göstermek demekti; burada sınır RLS'in kendisi.
--
-- İZİN DEĞİL, AYRI POLİTİKA. Portal rolüne normal izinler verilmez; mevcut
-- politikalar `has_perm` istediği için portal kullanıcısına hiçbir şey
-- açmazlar. Görünürlük, tabloya eklenen AYRI bir portal politikasından gelir.
-- Böylece "portal rolüne yanlışlıkla bir izin verildi" hatası, veriyi
-- açmaz -- politikalar ayrı yollardan geçer.
--
-- DAVET JETONU SAKLANMAZ, ÖZETİ SAKLANIR. Veritabanını okuyan biri (yedek,
-- log, destek oturumu) jetonu ele geçirip müşteri adına portala giremesin.
-- =============================================================================
set client_min_messages = warning;

alter table core.memberships
  add column if not exists portal_partner_id uuid references core.partners(id) on delete cascade;

create index if not exists ix_memberships_portal
  on core.memberships (tenant_id, portal_partner_id)
  where portal_partner_id is not null;

comment on column core.memberships.portal_partner_id is
  'Doluysa bu üyelik bir MÜŞTERİ PORTALI üyeliğidir ve yalnızca bu carinin '
  'verisine erişir. Personel üyeliklerinde NULL.';

-- -----------------------------------------------------------------------------
-- Bağlam
-- -----------------------------------------------------------------------------
/**
 * Oturumun portal kapsamı.
 *
 * Portal üyeliği değilse NULL döner ve portal politikaları hiçbir satırla
 * eşleşmez. `stable` ve tek sorgu: her satırda çağrılacak.
 */
create or replace function core.current_portal_partner_id()
returns uuid
language sql stable
security definer
set search_path = core, pg_temp
as $$
  select m.portal_partner_id
  from core.memberships m
  where m.user_id = core.current_user_id()
    and m.tenant_id = core.current_tenant_id()
    and m.is_active
    and m.portal_partner_id is not null
  limit 1;
$$;

/** Oturum portal oturumu mu? Arayüz ve uçlar bunu sorar. */
create or replace function core.is_portal_session()
returns boolean
language sql stable as $$
  select core.current_portal_partner_id() is not null;
$$;

-- -----------------------------------------------------------------------------
-- Davetler
-- -----------------------------------------------------------------------------
create table if not exists core.portal_invitations (
  id          uuid primary key default gen_random_uuid(),
  tenant_id   uuid not null references core.tenants(id) on delete cascade,
  partner_id  uuid not null references core.partners(id) on delete cascade,
  contact_id  uuid references core.partner_contacts(id) on delete set null,
  email       text not null,
  -- JETONUN KENDİSİ SAKLANMAZ. Yalnızca sha256 özeti; bağlantı bir kez
  -- gösterilir ve bir daha üretilemez.
  token_hash  text not null,
  expires_at  timestamptz not null,
  accepted_at timestamptz,
  accepted_user_id uuid references core.users(id),
  revoked_at  timestamptz,
  created_by  uuid references core.users(id),
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

create unique index if not exists ux_portal_inv_token on core.portal_invitations (token_hash);
create index if not exists ix_portal_inv_partner on core.portal_invitations (tenant_id, partner_id);

select core.attach_updated_at('core', 'portal_invitations');
select core.attach_audit('core', 'portal_invitations');

alter table core.portal_invitations enable row level security;
alter table core.portal_invitations force row level security;

drop policy if exists p_portal_inv_all on core.portal_invitations;
create policy p_portal_inv_all on core.portal_invitations for all
  using (tenant_id = (select core.current_tenant_id())
         and (select core.has_perm('core.portal.invite')))
  with check (tenant_id = (select core.current_tenant_id())
              and (select core.has_perm('core.portal.invite')));

/**
 * Davet oluşturur ve HAM JETONU bir kez döndürür.
 *
 * Jeton yalnızca bu çağrının dönüşünde görünür; tabloda özeti durur. Çağıran
 * taraf bağlantıyı kullanıcıya gösterir ya da e-postayla yollar.
 *
 * AYNI CARİYE AÇIK DAVET VARSA yenisi açılmaz: iki geçerli bağlantı, hangisinin
 * iptal edildiğini takip edilemez hâle getirir.
 */
create or replace function core.portal_invite(
  p_partner_id uuid, p_email text, p_contact_id uuid default null,
  p_gun integer default 14
) returns table (invite_id uuid, token text, expires_until timestamptz)
language plpgsql
security definer
-- pgcrypto `public` şemasında; `search_path` sabitlendiği için
-- `gen_random_bytes` ve `digest` NİTELENEREK çağrılır. search_path'i
-- gevşetmek, güvenlik tanımlı bir fonksiyonda arama yolunu saldırıya
-- açmak olurdu.
set search_path = core, pg_temp
as $$
declare
  v_tenant uuid := core.current_tenant_id();
  v_token  text;
  v_id     uuid;
  v_exp    timestamptz;
begin
  if v_tenant is null then
    raise exception 'Aktif kiracı yok' using errcode = '42501';
  end if;
  if not core.has_perm('core.portal.invite') then
    raise exception 'Portala davet yetkiniz yok' using errcode = '42501';
  end if;
  if coalesce(btrim(p_email), '') = '' then
    raise exception 'E-posta zorunlu' using errcode = '23502';
  end if;
  if not exists (select 1 from core.partners
                 where id = p_partner_id and tenant_id = v_tenant) then
    raise exception 'Cari bulunamadı' using errcode = 'P0002';
  end if;

  -- PERSONEL ADRESİNE PORTAL DAVETİ GÖNDERİLEMEZ. Aksi hâlde davet kabul
  -- edildiğinde `portal_partner_id` mevcut personel üyeliğinin üzerine
  -- yazılır: kişi hem çalışan hem portal kullanıcısı olur, oturumu portal
  -- sayılır ama personel rollerini taşımaya devam eder. Bu karışık hâli
  -- sonradan çözmek yerine daveti burada reddetmek doğru: yanlışlıkla
  -- yazılmış bir adresin bedeli, bir çalışanın erişiminin bozulması olmamalı.
  if exists (
    select 1
    from core.users u
    join core.memberships m on m.user_id = u.id and m.tenant_id = v_tenant
    where lower(u.email) = lower(btrim(p_email))
      and m.portal_partner_id is null
  ) then
    raise exception 'Bu adres bu kiracıda bir kullanıcıya ait; portal daveti gönderilemez'
      using errcode = '23505';
  end if;

  -- TAKMA AD ŞART: `returns table` kolon adları (`expires_at`) sorgudaki
  -- tablo kolonlarıyla aynı adı taşıdığında PostgreSQL hangisini
  -- kastettiğimizi bilemiyor ve "column reference is ambiguous" diyor.
  if exists (
    select 1 from core.portal_invitations pi
    where pi.tenant_id = v_tenant and pi.partner_id = p_partner_id
      and lower(pi.email) = lower(p_email)
      and pi.accepted_at is null and pi.revoked_at is null and pi.expires_at > now()
  ) then
    raise exception 'Bu adrese açık bir davet zaten var; önce onu iptal edin'
      using errcode = '23505';
  end if;

  -- 32 bayt rastgele; base64url'de yaklaşık 43 karakter.
  v_token := replace(replace(encode(public.gen_random_bytes(32), 'base64'), '+', '-'), '/', '_');
  v_token := replace(v_token, '=', '');
  v_exp := now() + make_interval(days => greatest(1, least(p_gun, 90)));

  insert into core.portal_invitations (
    tenant_id, partner_id, contact_id, email, token_hash, expires_at, created_by)
  values (
    v_tenant, p_partner_id, p_contact_id, btrim(p_email),
    encode(public.digest(v_token, 'sha256'), 'hex'), v_exp, core.current_user_id())
  returning core.portal_invitations.id into v_id;

  return query select v_id, v_token, v_exp;
end $$;

/**
 * Daveti kabul eder: portal kullanıcısını ve üyeliğini kurar.
 *
 * SECURITY DEFINER ve bağlamsız çalışır — daveti kabul eden kişinin henüz
 * oturumu yoktur. Yetki sınırı jetonun kendisidir: bilen kabul eder.
 *
 * SÜRESİ GEÇMİŞ, İPTAL EDİLMİŞ ve KULLANILMIŞ davet reddedilir; üçü de ayrı
 * cümleyle çünkü kullanıcının yapması gereken şey üçünde farklı.
 *
 * `p_user_id` kimlik sağlayıcısındaki (Supabase auth.users) kimliktir ve
 * `core.invite_user` ile AYNI sözleşmedir: auth kaydını uygulama katmanı
 * açar, buraya kimliğini verir. `core.users.id` varsayılansızdır -- bilerek:
 * burada kendi başımıza üretilen bir kimlik, oturum açan auth kullanıcısıyla
 * eşleşmeyen ve hiçbir zaman giriş yapamayan bir profil satırı bırakırdı.
 */
-- İMZA DEĞİŞTİ: `create or replace` yeni bir AŞIRI YÜKLEME yaratır, eskisini
-- değiştirmez. Eski imza kalırsa çağrı "is not unique" ile düşer.
drop function if exists core.portal_accept(text, text);

create or replace function core.portal_accept(
  p_token text,
  p_full_name text default null,
  p_user_id uuid default null
)
returns table (portal_user_id uuid, portal_tenant_id uuid, portal_partner_id uuid)
language plpgsql
security definer
set search_path = core, pg_temp
as $$
declare
  v_inv  core.portal_invitations;
  v_user uuid;
  v_mem  uuid;
  v_role uuid;
begin
  select * into v_inv from core.portal_invitations pi
   where pi.token_hash = encode(public.digest(coalesce(p_token, ''), 'sha256'), 'hex')
   for update;
  if not found then
    raise exception 'Davet bağlantısı geçersiz' using errcode = 'P0002';
  end if;
  if v_inv.revoked_at is not null then
    raise exception 'Bu davet iptal edilmiş' using errcode = '23514';
  end if;
  if v_inv.accepted_at is not null then
    raise exception 'Bu davet zaten kullanılmış' using errcode = '23514';
  end if;
  if v_inv.expires_at <= now() then
    raise exception 'Davetin süresi dolmuş; yeni davet isteyin' using errcode = '23514';
  end if;

  select id into v_user from core.users where lower(email) = lower(v_inv.email);
  if v_user is null then
    v_user := coalesce(p_user_id, gen_random_uuid());
    insert into core.users (id, email, full_name)
    values (v_user, v_inv.email,
            coalesce(nullif(btrim(p_full_name), ''), v_inv.email));
  end if;

  -- İKİNCİ KEZ KONTROL: davetle kabul arasında geçen günlerde bu kişi
  -- kiracıya personel olarak eklenmiş olabilir. Davet anındaki kontrol o
  -- durumu göremez; üzerine yazan `on conflict` ise personel üyeliğini
  -- sessizce portala çevirirdi.
  if exists (
    select 1 from core.memberships m
    where m.user_id = v_user and m.tenant_id = v_inv.tenant_id
      and m.portal_partner_id is null
  ) then
    raise exception 'Bu hesap bu firmada zaten kullanıcı; portal daveti kabul edilemez'
      using errcode = '23505';
  end if;

  insert into core.memberships (user_id, tenant_id, portal_partner_id, invited_by, is_active)
  values (v_user, v_inv.tenant_id, v_inv.partner_id, v_inv.created_by, true)
  on conflict (user_id, tenant_id) do update
    set portal_partner_id = excluded.portal_partner_id, is_active = true
  returning id into v_mem;

  select r.id into v_role from core.roles r where r.code = 'portal' and r.tenant_id is null;
  if v_role is not null then
    insert into core.membership_roles (membership_id, role_id)
    values (v_mem, v_role) on conflict do nothing;
  end if;

  update core.portal_invitations pi
     set accepted_at = now(), accepted_user_id = v_user
   where pi.id = v_inv.id;

  return query select v_user, v_inv.tenant_id, v_inv.partner_id;
end $$;

/**
 * Daveti KABUL ETMEDEN özetler: hangi firma, hangi adres, ne zamana kadar.
 *
 * Kabul ekranının "Alfa Sanayi sizi portalına davet etti" diyebilmesi için.
 * Bunsuz ekranda yalnızca çıplak bir jeton olurdu ve kullanıcı neyi kabul
 * ettiğini bilmeden düğmeye basardı -- kabul, bilerek verilmiş bir onay
 * olmalı.
 *
 * SECURITY DEFINER ve bağlamsız: daveti kabul edecek kişinin henüz üyeliği
 * yok, dolayısıyla tabloyu RLS üzerinden okuyamaz. Sızma riski yok: jetonu
 * bilen zaten daveti kabul edebiliyor, özeti görmesi yeni bir yetki değil.
 * GEÇERSİZ JETON HİÇBİR SATIR DÖNDÜRMEZ -- var/yok bilgisi bile sızmasın.
 */
create or replace function core.portal_invite_preview(p_token text)
returns table (partner_name text, email text, expires_until timestamptz)
language sql
stable
security definer
set search_path = core, pg_temp as $$
  select p.name, pi.email, pi.expires_at
  from core.portal_invitations pi
  join core.partners p on p.id = pi.partner_id
  where pi.token_hash = encode(public.digest(coalesce(p_token, ''), 'sha256'), 'hex')
    and pi.accepted_at is null
    and pi.revoked_at is null
    and pi.expires_at > now();
$$;

comment on function core.portal_invite_preview(text) is
  'Daveti kabul etmeden özetler. Geçersiz/kullanılmış jeton boş döner.';

/**
 * Daveti iptal eder.
 *
 * KABUL EDİLMİŞ DAVET İPTAL EDİLEMEZ. Jeton kabul edildiği anda işlevini
 * yitirir; erişimi olan artık davet değil, ÜYELİKTİR. İptali burada kabul
 * etmek, yöneticiye erişimi kestiği izlenimi verirken portal kullanıcısının
 * girmeye devam etmesi demek olurdu -- erişim kesme yolu üyeliği pasife
 * almaktır.
 *
 * `security invoker`: yetki sınırı tablonun RLS politikası, ayrı bir kontrol
 * değil.
 */
create or replace function core.portal_revoke_invite(p_id uuid)
returns core.portal_invitations
language plpgsql
security invoker as $$
declare
  v_inv core.portal_invitations;
begin
  select * into v_inv from core.portal_invitations where id = p_id;
  if not found then
    raise exception 'Davet bulunamadı' using errcode = 'P0002';
  end if;
  if v_inv.accepted_at is not null then
    raise exception 'Kabul edilmiş davet iptal edilemez; erişimi kesmek için '
                    'kullanıcıyı pasife alın'
      using errcode = '23514';
  end if;

  update core.portal_invitations
     set revoked_at = coalesce(revoked_at, now())
   where id = p_id
  returning * into v_inv;
  return v_inv;
end $$;

-- -----------------------------------------------------------------------------
-- Portal rolü ve izni
-- -----------------------------------------------------------------------------
-- ROL BOŞ: portal kullanıcısına hiçbir normal izin verilmez. Görünürlük
-- aşağıdaki ayrı politikalardan gelir; role izin eklenirse bile personel
-- ekranları açılmaz çünkü portal üyeliği şube kapsamı da taşımaz.
-- `ux_roles_system_code` KISMİ bir indekstir (`where tenant_id is null`),
-- dolayısıyla `on conflict (code)` onu bulamaz. Kısmi indeksi hedeflemek için
-- aynı koşulu `on conflict` içinde tekrarlamak gerekir.
insert into core.roles (code, name, description, is_system, rank)
values ('portal', 'Müşteri Portalı',
        'Kendi firmasının belgelerini görür; hiçbir şey yazamaz.', true, 900)
on conflict (code) where tenant_id is null do nothing;

select core.declare_permission('core.portal.invite', 'core', 'core.portal', 'create',
  'Müşteriyi portala davet et');
select core.grant_to_role('tenant_admin', array['core.portal.invite']);
select core.grant_to_role('sales', array['core.portal.invite']);

-- -----------------------------------------------------------------------------
-- Portal görünürlüğü: her tabloya AYRI politika
-- -----------------------------------------------------------------------------
-- Yalnızca SELECT ve yalnızca kendi carisi. Yazma politikası YOK: portal
-- kullanıcısı hiçbir tabloya satır yazamaz, mevcut yazma politikaları da
-- `has_perm` istediği için ona kapalıdır.
--
-- POLİTİKAYI ÇEKİRDEK DEĞİL, MODÜL TAKAR. Buradan `finance.invoices` ya da
-- `crm.quotations` adını anmak iki şeyi birden bozardı: çekirdek modül
-- tablolarına bağımlı hale gelirdi ve çekirdek migration'ları modüllerden
-- ÖNCE koştuğu için tablo henüz yokken politika yazmaya çalışırdı. Çekirdek
-- yalnızca kalıbı verir; her modül kendi tablosuna kendi migration'ında takar
-- -- arama, bildirim ve cari ilişkilerinde kullanılan kayıt kalıbının aynısı.
/**
 * Bir modül tablosuna portal görünürlük politikası takar.
 *
 * Tablo `tenant_id` ve `partner_id` kolonlarını taşımalıdır; taşımıyorsa
 * politika sessizce yanlış çalışmaz, tanımlanırken hata verir.
 */
create or replace function core.attach_portal_policy(p_schema text, p_table text)
returns void
language plpgsql as $$
begin
  execute format('drop policy if exists p_%1$s_portal on %2$I.%1$I', p_table, p_schema);
  execute format($p$create policy p_%1$s_portal on %2$I.%1$I for select
      using (tenant_id = (select core.current_tenant_id())
             and partner_id = (select core.current_portal_partner_id()))$p$,
    p_table, p_schema);
end $$;

comment on function core.attach_portal_policy(text, text) is
  'Modül tablosuna portal SELECT politikası takar. Modül kendi migration''ında çağırır.';

-- Cari kartının kendisi: portal kullanıcısı yalnızca KENDİ firmasını görür.
-- Kendi bilgilerini göremeyen bir portal, adres teyidi bile yaptıramaz.
drop policy if exists p_partners_portal on core.partners;
create policy p_partners_portal on core.partners for select
  using (id = (select core.current_portal_partner_id()));

comment on table core.portal_invitations is
  'Müşteri portalı davetleri. Jeton saklanmaz, sha256 özeti saklanır.';
