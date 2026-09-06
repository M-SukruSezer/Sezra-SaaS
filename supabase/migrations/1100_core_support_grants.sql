-- =============================================================================
-- 1100 — Kişiye ve süreye bağlı destek erişim izinleri
-- =============================================================================
-- ÖNCEKİ DAVRANIŞ (tek faktörlü): herhangi bir platform yöneticisi token'ı +
-- `x-support-mode: on` + `x-tenant-id: <kurban>` başlıkları, o kiracının TÜM
-- verisini okumaya yetiyordu. core.support_tenant_id() yalnızca kiracı satırının
-- var olup olmadığına bakıyordu — çalınmış bir personel hesabı her müşterinin
-- defterini okuyabilirdi.
--
-- YENİ DAVRANIŞ (güvenli varsayılan): bir platform yöneticisinin bir kiracıya
-- destek erişimi, ancak core.support_grants içinde o yöneticiye + o kiracıya
-- ait, süresi dolmamış ve iptal edilmemiş CANLI bir kayıt varsa mümkündür.
-- Kayıt yoksa erişim yoktur. Kaydı başka bir platform yöneticisi verir; kimin
-- verdiği, gerekçesi ve ne zaman biteceği kayıtta durur.
--
-- core.is_support_session() / core.support_tenant_id() bu tabloya danışır ve
-- canlı izin yoksa REDDEDER. Mevcut audit_log.support_session izi korunur:
-- destek modunda yapılan her okuma/yazma denetim izinde işaretli kalır.
-- =============================================================================

create table if not exists core.support_grants (
  id            uuid primary key default gen_random_uuid(),
  -- Erişimi VERİLEN yönetici
  admin_user_id uuid not null references core.users(id) on delete cascade,
  -- Erişilecek kiracı
  tenant_id     uuid not null references core.tenants(id) on delete cascade,
  -- Neden: destek talebi no'su, olay kaydı vb. Boş geçilemez.
  reason        text not null,
  -- İzni VEREN yönetici (istemciden gelen değere güvenilmez; trigger damgalar)
  granted_by    uuid not null references core.users(id),
  granted_at    timestamptz not null default now(),
  -- Zorunlu son kullanma: süresiz destek erişimi diye bir şey yok.
  expires_at    timestamptz not null,
  -- İptal: kayıt silinmez, revoked_at ile kapatılır (iz kalsın).
  revoked_at    timestamptz,
  revoked_by    uuid references core.users(id),
  constraint support_grants_ttl_ck    check (expires_at > granted_at),
  constraint support_grants_reason_ck check (length(btrim(reason)) >= 3),
  constraint support_grants_revoke_ck check (
    (revoked_at is null     and revoked_by is null) or
    (revoked_at is not null  and revoked_by is not null)
  )
);

comment on table core.support_grants is
  'Platform yöneticisinin bir kiracıya SÜRELİ destek erişimi. is_support_session()/support_tenant_id() burada canlı bir kayıt arar; yoksa erişim yok.';

-- Canlı izin sorgusu satır başına değil, RLS InitPlan'ında bir kez koşar;
-- kısmi indeks yalnızca iptal edilmemiş kayıtları tutar.
create index if not exists ix_support_grants_live
  on core.support_grants (admin_user_id, tenant_id, expires_at)
  where revoked_at is null;

-- -----------------------------------------------------------------------------
-- granted_by / revoked_by daima işlemi yapan yönetici olsun
-- -----------------------------------------------------------------------------
create or replace function core.fn_support_grant_actor()
returns trigger
language plpgsql
as $$
begin
  if tg_op = 'INSERT' then
    new.granted_by := coalesce(core.current_user_id(), new.granted_by);
    if new.revoked_at is not null then
      new.revoked_by := coalesce(new.revoked_by, core.current_user_id());
    end if;
  elsif tg_op = 'UPDATE' then
    -- Bir kez iptal edilen kayıt yeniden canlandırılamaz.
    if old.revoked_at is not null then
      new.revoked_at := old.revoked_at;
      new.revoked_by := old.revoked_by;
    elsif new.revoked_at is not null then
      new.revoked_by := coalesce(core.current_user_id(), new.revoked_by);
    end if;
  end if;
  return new;
end;
$$;

drop trigger if exists trg_support_grants_actor on core.support_grants;
create trigger trg_support_grants_actor
  before insert or update on core.support_grants
  for each row execute function core.fn_support_grant_actor();

-- Denetim izi: platformun "kim, hangi kiracıya, ne zaman, neden destek aldı"
-- sorusunu kendi izinden yanıtlayabilmesi için.
select core.attach_audit('core', 'support_grants');

-- -----------------------------------------------------------------------------
-- RLS: yalnızca platform yöneticileri destek izinlerini görebilir/verebilir/
-- iptal edebilir. DELETE politikası YOK — iptal revoked_at ile yapılır.
-- -----------------------------------------------------------------------------
alter table core.support_grants enable row level security;
alter table core.support_grants force row level security;

drop policy if exists p_support_grants_select on core.support_grants;
create policy p_support_grants_select on core.support_grants for select
  using ((select core.is_platform_admin()));

drop policy if exists p_support_grants_insert on core.support_grants;
create policy p_support_grants_insert on core.support_grants for insert
  with check ((select core.is_platform_admin()));

drop policy if exists p_support_grants_update on core.support_grants;
create policy p_support_grants_update on core.support_grants for update
  using ((select core.is_platform_admin()))
  with check ((select core.is_platform_admin()));

-- -----------------------------------------------------------------------------
-- Canlı destek izni var mı?
-- -----------------------------------------------------------------------------
create or replace function core.has_live_support_grant(p_admin uuid, p_tenant uuid)
returns boolean
language sql
stable
security definer
set search_path = core, pg_temp
as $$
  select exists (
    select 1 from core.support_grants g
    where g.admin_user_id = p_admin
      and g.tenant_id     = p_tenant
      and g.revoked_at is null
      and g.expires_at > now()
  );
$$;

comment on function core.has_live_support_grant(uuid, uuid) is
  'p_admin''in p_tenant üzerinde süresi dolmamış, iptal edilmemiş bir destek izni var mı.';

-- -----------------------------------------------------------------------------
-- support_tenant_id() — artık CANLI İZİN şartı var
-- -----------------------------------------------------------------------------
-- Sıra: destek modu açık mı -> platform yöneticisi mi -> kiracı seçili mi ->
-- kiracı var mı -> bu yöneticiye + bu kiracıya CANLI izin var mı. Herhangi biri
-- düşerse NULL döner ve politikalarda `tenant_id = support_tenant_id()`
-- karşılaştırması false olur: hiçbir şey görünmez.
create or replace function core.support_tenant_id()
returns uuid
language plpgsql
stable
security definer
set search_path = core, pg_temp
as $$
declare v uuid;
begin
  if coalesce(nullif(current_setting('app.support_mode', true), ''), 'off') <> 'on' then
    return null;
  end if;
  if not core.is_platform_admin() then
    return null;
  end if;
  begin
    v := nullif(current_setting('app.tenant_id', true), '')::uuid;
  exception when others then
    return null;
  end;
  if v is null then
    return null;
  end if;
  if not exists (select 1 from core.tenants t where t.id = v and t.deleted_at is null) then
    return null;
  end if;
  if not core.has_live_support_grant(core.current_user_id(), v) then
    return null;
  end if;
  return v;
end;
$$;

-- -----------------------------------------------------------------------------
-- is_support_session() — geçerli, canlı-izinli bir destek kapsamı var mı
-- -----------------------------------------------------------------------------
-- support_tenant_id() NULL döndüğü her durumda (mod kapalı, yönetici değil,
-- kiracı seçilmemiş, kiracı yok, izin yok/expired/iptal) destek oturumu da
-- YOKTUR. Denetim tetikleyicisi bu fonksiyonu okuyup satırı işaretler.
create or replace function core.is_support_session()
returns boolean
language sql
stable
as $$
  select core.support_tenant_id() is not null;
$$;

-- -----------------------------------------------------------------------------
-- Yönetim yüzeyi: izni ver / iptal et (yalnızca platform yöneticisi)
-- -----------------------------------------------------------------------------
create or replace function core.grant_support_access(
  p_admin    uuid,
  p_tenant   uuid,
  p_reason   text,
  p_duration interval default interval '1 hour'
)
returns core.support_grants
language plpgsql
security definer
set search_path = core, pg_temp
as $$
declare v_row core.support_grants;
begin
  if not core.is_platform_admin() then
    raise exception 'destek izni yalnızca platform yöneticisi verebilir'
      using errcode = '42501';
  end if;
  if not exists (select 1 from core.users u
                  where u.id = p_admin and u.is_platform_admin and u.disabled_at is null) then
    raise exception 'destek izni yalnızca etkin bir platform yöneticisine verilebilir'
      using errcode = '23514';
  end if;
  if not exists (select 1 from core.tenants t where t.id = p_tenant and t.deleted_at is null) then
    raise exception 'kiracı bulunamadı' using errcode = '23503';
  end if;
  if coalesce(btrim(p_reason), '') = '' then
    raise exception 'destek izni gerekçesiz verilemez' using errcode = '23514';
  end if;

  insert into core.support_grants (admin_user_id, tenant_id, reason, granted_by, expires_at)
  values (p_admin, p_tenant, btrim(p_reason), core.current_user_id(),
          now() + greatest(p_duration, interval '1 minute'))
  returning * into v_row;
  return v_row;
end;
$$;

comment on function core.grant_support_access(uuid, uuid, text, interval) is
  'Bir platform yöneticisine bir kiracı için süreli destek erişimi verir. Varsayılan süre 1 saat.';

create or replace function core.revoke_support_access(p_grant_id uuid)
returns void
language plpgsql
security definer
set search_path = core, pg_temp
as $$
begin
  if not core.is_platform_admin() then
    raise exception 'destek iznini yalnızca platform yöneticisi iptal edebilir'
      using errcode = '42501';
  end if;
  update core.support_grants
     set revoked_at = now(), revoked_by = core.current_user_id()
   where id = p_grant_id and revoked_at is null;
end;
$$;

comment on function core.revoke_support_access(uuid) is
  'Canlı bir destek iznini hemen kapatır. Kayıt silinmez; revoked_at ile iz kalır.';

-- Yeni tablo ve fonksiyonlar için uygulama rolü yetkileri (9999 zaten en sonda
-- tekrar çalışır; buradaki çağrı kısmi migration turlarında da tutarlılık için).
select core.apply_grants();
