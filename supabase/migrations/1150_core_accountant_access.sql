-- =============================================================================
-- 1150 — Mali musavir erisimi: kiraciya SALT OKUNUR, tenant basina en fazla 1
-- =============================================================================
-- AMAC: Bir kiraci, defterlerini tutan mali musavirini davet edip faturalarini
-- (ve diger is verisini) SALT OKUNUR gormesini saglayabilsin. Musavirin kendi
-- paneli vardir; oradan yetkili oldugu kiracilara gecer.
--
-- KIMLIK KARARI (belirsizlik cozumu): musavir icin AYRI bir hesap tipi ACILMAZ.
-- Musavir, `core.users` icinde sirodan bir kullanicidir; baska kiracilarda
-- uyeligi olabilir. Erisimi tamamen `core.accountant_grants` satirlarindan
-- turer. Gerekce:
--   * BOUNDARY "mevcut yetkilendirme modelini yeniden yazma, uzerine ekle" —
--     yeni bir principal tipi tum auth zincirini (JWT, memberships, RBAC)
--     etkilerdi.
--   * 1100 destek erisimi ve 1110 davet akisi ayni deseni kullaniyor: cross-
--     tenant erisim = ayri bir grant tablosu + GUC modu, uyelik degil.
--   * RLS ile bestelenebilir: tek bir yeni yardimci fonksiyon SELECT
--     politikasina eklenir, yazma politikalarina EKLENMEZ.
--
-- SALT OKUNURLUK KARARI: erisim RLS SEVIYESINDE salt okunurdur, yalnizca
-- uygulama katmaninda degil. `core.apply_rls` politika ureticisi degistirilir:
-- musavir kapsami (`core.accountant_tenant_id()`) SADECE for-select
-- politikasina bir OR dali olarak girer. insert/update/delete politikalari
-- musavir terimini HIC gormez -> musavir oturumu bir satiri yazmayi
-- YAPISAL OLARAK deneyemez (politika calismadan false doner). Sonra
-- `core.reapply_rls_all()` ile tum kayitli modul tablolarina yeniden uygulanir.
--
-- KAPSAM: destek erisiminde oldugu gibi kapsam TABLO BAZINDA degil kiraci
-- bazindadir; musavir kiracinin tum modul verisini OKUYABILIR (faturalar dahil).
-- Bir mali musavirin defter gorunurlugu zaten tum finansal + bordro verisini
-- kapsar; destek erisiminden (okuma+yazma) DAHA DAR bir yetkidir.
--
-- TENANT BASINA EN FAZLA 1: `revoked_at is null` uzerinde kismi ESSIZ indeks.
-- Bekleyen ya da aktif ikinci bir davet 23505 ile reddedilir.
-- =============================================================================
set client_min_messages = warning;

-- -----------------------------------------------------------------------------
-- Grant tablosu
-- -----------------------------------------------------------------------------
create table if not exists core.accountant_grants (
  id                 uuid primary key default gen_random_uuid(),
  -- Erisilecek kiraci
  tenant_id          uuid not null references core.tenants(id) on delete cascade,
  -- Musavir kullanici. Davet aninda mevcut kullaniciya baglanir; yoksa davet
  -- kabulunde `core.current_user_id()` ile sabitlenir.
  accountant_user_id uuid references core.users(id) on delete cascade,
  -- Davet edilen e-posta (kabulde kullanici e-postasi ile eslesmeli).
  email              text not null,
  -- Daveti VEREN (istemciden gelen degere guvenilmez; trigger damgalar).
  invited_by         uuid not null references core.users(id),
  invited_at         timestamptz not null default now(),
  -- Kabul: musavir daveti kabul edene kadar NULL. Erisim yalnizca dolu iken acik.
  accepted_at        timestamptz,
  -- Iptal: kayit silinmez, revoked_at ile kapatilir (iz kalsin).
  revoked_at         timestamptz,
  revoked_by         uuid references core.users(id),
  -- Tek kullanimlik davet belirteci (kabulde temizlenir).
  invite_token       text,
  constraint accountant_grants_email_ck check (length(btrim(email)) >= 3),
  constraint accountant_grants_revoke_ck check (
    (revoked_at is null     and revoked_by is null) or
    (revoked_at is not null  and revoked_by is not null)
  )
);

comment on table core.accountant_grants is
  'Kiracinin mali musavirine SALT OKUNUR erisimi. core.accountant_tenant_id() '
  'burada canli (kabul edilmis, iptal edilmemis) bir kayit arar; yoksa erisim yok.';

-- TENANT BASINA EN FAZLA 1 CANLI/BEKLEYEN MUSAVIR (veritabani kisiti).
create unique index if not exists ux_accountant_grants_one_per_tenant
  on core.accountant_grants (tenant_id)
  where revoked_at is null;

-- Politika InitPlan'inda tek sefer kosan canli-kayit sorgusu icin.
create index if not exists ix_accountant_grants_live
  on core.accountant_grants (accountant_user_id, tenant_id)
  where revoked_at is null and accepted_at is not null;

-- -----------------------------------------------------------------------------
-- invited_by / revoked_by daima islemi yapan kullanici olsun; kabul/iptal
-- edilmis kayit yeniden canlandirilmaz.
-- -----------------------------------------------------------------------------
create or replace function core.fn_accountant_grant_actor()
returns trigger
language plpgsql
as $$
begin
  if tg_op = 'INSERT' then
    new.invited_by := coalesce(core.current_user_id(), new.invited_by);
  elsif tg_op = 'UPDATE' then
    -- Bir kez iptal edilen kayit yeniden acilmaz.
    if old.revoked_at is not null then
      new.revoked_at := old.revoked_at;
      new.revoked_by := old.revoked_by;
      new.accepted_at := old.accepted_at;
    elsif new.revoked_at is not null and old.revoked_at is null then
      new.revoked_by := coalesce(new.revoked_by, core.current_user_id());
    end if;
  end if;
  return new;
end;
$$;

drop trigger if exists trg_accountant_grants_actor on core.accountant_grants;
create trigger trg_accountant_grants_actor
  before insert or update on core.accountant_grants
  for each row execute function core.fn_accountant_grant_actor();

-- Denetim izi: "kim, hangi kiraciya, ne zaman musavir erisimi verdi/aldi".
select core.attach_audit('core', 'accountant_grants');

-- -----------------------------------------------------------------------------
-- RLS: tablonun kendisi
-- -----------------------------------------------------------------------------
-- Yonetim fonksiyonlari SECURITY DEFINER (sahip sezra_owner, BYPASSRLS) oldugu
-- icin asil yol bu politikalara TABI DEGILDIR; buradaki politikalar dogrudan
-- sezra_app erisimi icindir. DELETE politikasi YOK — iptal revoked_at ile.
alter table core.accountant_grants enable row level security;
alter table core.accountant_grants force row level security;

drop policy if exists p_accountant_grants_select on core.accountant_grants;
create policy p_accountant_grants_select on core.accountant_grants for select
  using (
    (select core.is_platform_admin())
    or accountant_user_id = (select core.current_user_id())
    or (tenant_id = (select core.current_tenant_id())
        and (select core.has_perm('core.user.write.all')))
  );

drop policy if exists p_accountant_grants_insert on core.accountant_grants;
create policy p_accountant_grants_insert on core.accountant_grants for insert
  with check (
    (select core.is_platform_admin())
    or (tenant_id = (select core.current_tenant_id())
        and (select core.has_perm('core.user.write.all')))
  );

drop policy if exists p_accountant_grants_update on core.accountant_grants;
create policy p_accountant_grants_update on core.accountant_grants for update
  using (
    (select core.is_platform_admin())
    or (tenant_id = (select core.current_tenant_id())
        and (select core.has_perm('core.user.write.all')))
    or (invite_token is not null and accepted_at is null and revoked_at is null)
  )
  with check (
    (select core.is_platform_admin())
    or (tenant_id = (select core.current_tenant_id())
        and (select core.has_perm('core.user.write.all')))
    or accountant_user_id = (select core.current_user_id())
  );

-- -----------------------------------------------------------------------------
-- core.accountant_tenant_id() — musavir oturumunda ERISILEN kiraci
-- -----------------------------------------------------------------------------
-- Sira: musavir modu acik mi -> kiraci secili mi -> kiraci var mi -> bu
-- kullaniciya + bu kiraciya KABUL EDILMIS, iptal edilmemis bir kayit var mi.
-- Herhangi biri duserse NULL doner ve `tenant_id = accountant_tenant_id()`
-- karsilastirmasi false olur: hicbir sey gorunmez. Destek erisiminin aksine
-- SURE SINIRI yoktur (musavirlik surekli bir iliskidir); kapatan tek sey iptal.
create or replace function core.accountant_tenant_id()
returns uuid
language plpgsql
stable
security definer
set search_path = core, pg_temp
as $$
declare v uuid;
begin
  if coalesce(nullif(current_setting('app.accountant_mode', true), ''), 'off') <> 'on' then
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
  if not exists (
    select 1 from core.accountant_grants g
    where g.tenant_id = v
      and g.accountant_user_id = core.current_user_id()
      and g.accepted_at is not null
      and g.revoked_at is null
  ) then
    return null;
  end if;
  return v;
end;
$$;

comment on function core.accountant_tenant_id() is
  'Musavir oturumunda (app.accountant_mode = on) erisilen kiraci; canli grant '
  'yoksa NULL. SALT OKUNUR: yalnizca for-select politikalarinda kullanilir.';

create or replace function core.is_accountant_session()
returns boolean
language sql
stable
as $$
  select core.accountant_tenant_id() is not null;
$$;

comment on function core.is_accountant_session() is
  'Gecerli, canli-grantli bir musavir okuma kapsami var mi.';

-- -----------------------------------------------------------------------------
-- Politika ureticisini guncelle: musavir SADECE okuyabilir
-- -----------------------------------------------------------------------------
-- 0005'teki ureticinin birebir kopyasi; TEK fark: for-select politikasina
-- `core.accountant_tenant_id()` OR dali eklenir. insert/update/delete
-- politikalari degismez -> musavir yazamaz.
create or replace function core.apply_rls(
  p_schema     text,
  p_table      text,
  p_entity     text,
  p_has_branch boolean default true,
  p_has_owner  boolean default true,
  p_soft_delete boolean default false
)
returns void
language plpgsql
as $fn$
declare
  v_tbl        text := format('%I.%I', p_schema, p_table);
  v_tenant     text := 'tenant_id = (select core.current_tenant_id())';
  v_branch     text := '';
  v_support    text := 'tenant_id = (select core.support_tenant_id())';
  -- Mali musavir kapsami: kiraciya daraltilmis, SADECE okuma.
  v_accountant text := 'tenant_id = (select core.accountant_tenant_id())';
  v_read       text;
  v_create     text;
  v_write      text;
  v_delete     text;
begin
  if p_has_branch then
    v_branch := ' and (branch_id is null or (select core.accessible_branch_ids()) @> array[branch_id])';
  end if;

  if p_has_owner then
    v_read   := format('((select core.has_perm(%L)) or ((select core.has_perm(%L)) and owner_id = (select core.current_user_id())))',
                       p_entity || '.read.all',   p_entity || '.read.own');
    v_write  := format('((select core.has_perm(%L)) or ((select core.has_perm(%L)) and owner_id = (select core.current_user_id())))',
                       p_entity || '.write.all',  p_entity || '.write.own');
    v_delete := format('((select core.has_perm(%L)) or ((select core.has_perm(%L)) and owner_id = (select core.current_user_id())))',
                       p_entity || '.delete.all', p_entity || '.delete.own');
  else
    v_read   := format('(select core.has_perm(%L))', p_entity || '.read.all');
    v_write  := format('(select core.has_perm(%L))', p_entity || '.write.all');
    v_delete := format('(select core.has_perm(%L))', p_entity || '.delete.all');
  end if;
  v_create := format('(select core.has_perm(%L))', p_entity || '.create');

  execute format('alter table %s enable row level security', v_tbl);
  execute format('alter table %s force row level security', v_tbl);

  execute format('drop policy if exists p_%s_select on %s', p_table, v_tbl);
  execute format(
    'create policy p_%s_select on %s for select using (%s or %s or (%s%s and %s%s))',
    p_table, v_tbl, v_support, v_accountant, v_tenant, v_branch, v_read,
    case when p_soft_delete then ' and deleted_at is null' else '' end
  );

  execute format('drop policy if exists p_%s_insert on %s', p_table, v_tbl);
  execute format(
    'create policy p_%s_insert on %s for insert with check (%s or (%s%s and %s))',
    p_table, v_tbl, v_support, v_tenant, v_branch, v_create
  );

  execute format('drop policy if exists p_%s_update on %s', p_table, v_tbl);
  execute format(
    'create policy p_%s_update on %s for update using (%s or (%s%s and %s)) with check (%s or (%s%s and %s))',
    p_table, v_tbl, v_support, v_tenant, v_branch, v_write,
              v_support, v_tenant, v_branch, v_write
  );

  execute format('drop policy if exists p_%s_delete on %s', p_table, v_tbl);
  execute format(
    'create policy p_%s_delete on %s for delete using (%s or (%s%s and %s))',
    p_table, v_tbl, v_support, v_tenant, v_branch, v_delete
  );

  execute format('create index if not exists ix_%s_tenant on %s (tenant_id)', p_table, v_tbl);
  if p_has_branch then
    execute format('create index if not exists ix_%s_tenant_branch on %s (tenant_id, branch_id)', p_table, v_tbl);
  end if;
  if p_has_owner then
    execute format('create index if not exists ix_%s_tenant_owner on %s (tenant_id, owner_id)', p_table, v_tbl);
  end if;
end;
$fn$;

-- Zaten gocurulmus veritabaninin politikalarini yeni uretici ile tazele.
do $$
declare n integer;
begin
  select core.reapply_rls_all() into n;
  raise notice 'Musavir okuma kapsami % modul tablosuna uygulandi', n;
end $$;

-- -----------------------------------------------------------------------------
-- Yonetim yuzeyi: davet / kabul / reddet / iptal
-- -----------------------------------------------------------------------------

-- Kiraci yoneticisi musaviri e-postayla davet eder. Yetki: uygulama katmani
-- degil, buradaki `core.has_perm('core.user.write.all')` (kiraci yoneticisi).
create or replace function core.invite_accountant(
  p_email     text,
  p_full_name text default null
)
returns core.accountant_grants
language plpgsql
security definer
set search_path = core, pg_temp
as $$
declare
  v_tenant uuid := core.current_tenant_id();
  v_user   uuid;
  v_row    core.accountant_grants;
begin
  if v_tenant is null then
    raise exception 'Aktif kiraci yok' using errcode = '42501';
  end if;
  if not core.has_perm('core.user.write.all') then
    raise exception 'Musavir davet etme yetkiniz yok' using errcode = '42501';
  end if;
  if coalesce(btrim(p_email), '') = '' then
    raise exception 'E-posta zorunlu' using errcode = '23514';
  end if;

  select id into v_user from core.users where lower(email) = lower(btrim(p_email));
  if v_user is null then
    v_user := gen_random_uuid();
    insert into core.users (id, email, full_name)
    values (v_user, btrim(p_email), coalesce(nullif(btrim(p_full_name), ''), btrim(p_email)));
  end if;

  -- ux_accountant_grants_one_per_tenant: kiracida zaten canli/bekleyen bir
  -- musavir varsa 23505 -> API 409.
  insert into core.accountant_grants (tenant_id, accountant_user_id, email, invited_by, invite_token)
  values (v_tenant, v_user, lower(btrim(p_email)), core.current_user_id(),
          replace(gen_random_uuid()::text, '-', '') || replace(gen_random_uuid()::text, '-', ''))
  returning * into v_row;
  return v_row;
end;
$$;

comment on function core.invite_accountant(text, text) is
  'Aktif kiracinin mali musavirini e-postayla davet eder. Kiracida zaten canli '
  'bir musavir varsa 23505 ile reddedilir (tenant basina en fazla 1).';

-- Musavir daveti kabul eder: yalnizca davetlinin KENDISI (e-posta eslesmeli).
create or replace function core.accept_accountant_invite(p_token text)
returns core.accountant_grants
language plpgsql
security definer
set search_path = core, pg_temp
as $$
declare
  v_user  uuid := core.current_user_id();
  v_email text;
  v_row   core.accountant_grants;
begin
  if v_user is null then
    raise exception 'Oturum yok' using errcode = '42501';
  end if;
  select lower(email) into v_email from core.users where id = v_user;

  update core.accountant_grants g
     set accepted_at        = now(),
         accountant_user_id = v_user,
         invite_token       = null
   where g.invite_token = p_token
     and g.accepted_at is null
     and g.revoked_at is null
     and (g.accountant_user_id = v_user or lower(g.email) = v_email)
  returning * into v_row;

  if v_row.id is null then
    raise exception 'Gecerli bir musavir daveti bulunamadi' using errcode = 'P0002';
  end if;
  return v_row;
end;
$$;

comment on function core.accept_accountant_invite(text) is
  'Oturumdaki kullanicinin musavir davetini kabul eder; erisim bundan sonra acik.';

create or replace function core.decline_accountant_invite(p_token text)
returns void
language plpgsql
security definer
set search_path = core, pg_temp
as $$
declare
  v_user  uuid := core.current_user_id();
  v_email text;
begin
  if v_user is null then
    raise exception 'Oturum yok' using errcode = '42501';
  end if;
  select lower(email) into v_email from core.users where id = v_user;

  update core.accountant_grants g
     set revoked_at = now(), revoked_by = v_user
   where g.invite_token = p_token
     and g.accepted_at is null
     and g.revoked_at is null
     and (g.accountant_user_id = v_user or lower(g.email) = v_email);

  if not found then
    raise exception 'Gecerli bir musavir daveti bulunamadi' using errcode = 'P0002';
  end if;
end;
$$;

comment on function core.decline_accountant_invite(text) is
  'Oturumdaki kullanicinin musavir davetini reddeder (kayit iptal edilir).';

-- Kiraci yoneticisi musavir erisimini iptal eder.
create or replace function core.revoke_accountant(p_grant_id uuid)
returns void
language plpgsql
security definer
set search_path = core, pg_temp
as $$
declare
  v_tenant uuid := core.current_tenant_id();
  v_gt     uuid;
begin
  select tenant_id into v_gt from core.accountant_grants where id = p_grant_id;
  if v_gt is null then
    raise exception 'Kayit bulunamadi' using errcode = 'P0002';
  end if;
  if not core.is_platform_admin()
     and not (v_gt = v_tenant and core.has_perm('core.user.write.all')) then
    raise exception 'Musavir erisimini iptal etme yetkiniz yok' using errcode = '42501';
  end if;

  update core.accountant_grants
     set revoked_at = now(), revoked_by = core.current_user_id()
   where id = p_grant_id and revoked_at is null;
end;
$$;

comment on function core.revoke_accountant(uuid) is
  'Canli bir musavir erisimini hemen kapatir. Kayit silinmez; revoked_at ile iz kalir.';

-- -----------------------------------------------------------------------------
-- Okuma yuzeyi
-- -----------------------------------------------------------------------------

-- Kiraci konsolu: bu kiracinin musaviri (bekleyen ya da aktif).
create or replace function core.current_tenant_accountant()
returns table (
  id           uuid,
  email        text,
  full_name    text,
  invited_by   uuid,
  invited_at   timestamptz,
  accepted_at  timestamptz,
  status       text
)
language sql
stable
security definer
set search_path = core, pg_temp
as $$
  select g.id, g.email, u.full_name, g.invited_by, g.invited_at, g.accepted_at,
         case when g.accepted_at is not null then 'active' else 'pending' end
  from core.accountant_grants g
  left join core.users u on u.id = g.accountant_user_id
  where g.tenant_id = core.current_tenant_id()
    and g.revoked_at is null
    and core.has_perm('core.user.write.all');
$$;

comment on function core.current_tenant_accountant() is
  'Aktif kiracinin canli musavir kaydi (kiraci yoneticisi konsolu icin).';

-- Musavir paneli: yetkili oldugum kiracilar.
create or replace function core.accountant_tenants()
returns table (
  tenant_id   uuid,
  tenant_name text,
  tenant_slug text,
  accepted_at timestamptz
)
language sql
stable
security definer
set search_path = core, pg_temp
as $$
  select g.tenant_id, t.name, t.slug, g.accepted_at
  from core.accountant_grants g
  join core.tenants t on t.id = g.tenant_id and t.deleted_at is null
  where g.accountant_user_id = core.current_user_id()
    and g.accepted_at is not null
    and g.revoked_at is null
  order by t.name;
$$;

comment on function core.accountant_tenants() is
  'Musavir panelinin ana listesi: oturumdaki kullanicinin salt-okunur erisimi '
  'olan kiracilar.';

-- Musavir paneli: bekleyen davetlerim.
create or replace function core.pending_accountant_invites()
returns table (
  token           text,
  tenant_id       uuid,
  tenant_name     text,
  invited_by_name text,
  invited_at      timestamptz
)
language sql
stable
security definer
set search_path = core, pg_temp
as $$
  select g.invite_token, g.tenant_id, t.name, u.full_name, g.invited_at
  from core.accountant_grants g
  join core.tenants t on t.id = g.tenant_id and t.deleted_at is null
  left join core.users u on u.id = g.invited_by
  where g.accepted_at is null
    and g.revoked_at is null
    and g.invite_token is not null
    and (g.accountant_user_id = core.current_user_id()
         or lower(g.email) = lower((select email from core.users where id = core.current_user_id())));
$$;

comment on function core.pending_accountant_invites() is
  'Oturumdaki kullanicinin henuz kabul etmedigi musavir davetleri.';

select core.apply_grants();
