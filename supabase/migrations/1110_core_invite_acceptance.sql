-- =============================================================================
-- 1110 — Davet kabulu: cross-tenant uyelik enjeksiyonunu kapat
-- =============================================================================
-- SORUN (confused-deputy): `core.invite_user` verilen e-postayi TUM kiracilardaki
-- `core.users` satirlariyla eslestiriyor, sonra cagiran kiracinin uyeligini
-- DOGRUDAN AKTIF ekliyordu (`on conflict do update set is_active = true`). Bir
-- kiraci yoneticisi boylece baska sirketlerde hesabi olan tanidigi birini
-- sessizce kendi kiracisina aktif uye yapabiliyordu; kurbanin kiraci
-- degistiricisi bir anda yabanci bir sirketi listeliyor, `core.current_tenant_id`
-- ve `core.permission_codes` o kiraci icin doluyordu.
--
-- COZUM: baska yerde uyeligi OLAN bir kullanici icin davet artik BEKLEMEDE
-- olusturulur (`is_active = false`, `accepted_at = null`) ve yalnizca davetlinin
-- kendisi `core.accept_invite` cagirinca etkinlesir. Hicbir yerde uyeligi
-- olmayan (yeni) bir kullanici icin kurban yoktur — dogrudan katilir, davranis
-- degismez.
--
-- IKINCI KUSUR: `p_branch_ids` cagiran kiraciya ait oldugu dogrulanmiyordu;
-- baska kiracinin sube id'si verilip orphan `core.membership_branches` satiri
-- yaratilabiliyordu. Artik her id `v_tenant`e ait olmali.
--
-- NOT: 0012 yerinde duzenlenmez; bu ileri migration fonksiyonu degistirir.
-- =============================================================================
set client_min_messages = warning;

-- -----------------------------------------------------------------------------
-- Uyelik: kabul zaman damgasi
-- -----------------------------------------------------------------------------
-- `accepted_at` NULL => uyelik beklemede (davet edildi, kabul edilmedi).
-- Varsayilan `now()` oldugu icin dogrudan yazilan uyelikler (seed, self-servis
-- provisioning) kendiliginden kabul edilmis sayilir; yalnizca `invite_user`
-- bekleyen yolda acikca NULL gecer.
alter table core.memberships
  add column if not exists accepted_at timestamptz;

alter table core.memberships
  alter column accepted_at set default now();

-- Mevcut tum uyelikler kabul edilmis kabul edilir (davranis degismez).
update core.memberships set accepted_at = joined_at where accepted_at is null;

comment on column core.memberships.accepted_at is
  'Davetlinin uyeligi kabul ettigi an. NULL ise uyelik beklemededir ve '
  'core.current_tenant_id / permission_codes bu kiraciyi gormez.';

-- -----------------------------------------------------------------------------
-- Kullaniciyi kiraciya davet et (guclendirilmis)
-- -----------------------------------------------------------------------------
create or replace function core.invite_user(
  p_email text, p_full_name text, p_role_code text,
  p_branch_ids uuid[] default null, p_user_id uuid default null
)
returns uuid
language plpgsql
security definer
set search_path = core, pg_temp
as $$
declare
  v_tenant     uuid := core.current_tenant_id();
  v_user_id    uuid;
  v_membership uuid;
  v_role_id    uuid;
  v_is_new     boolean := false;
  v_auto_join  boolean;
  v_alien      integer;
begin
  if v_tenant is null then
    raise exception 'Aktif kiracı yok' using errcode = '42501';
  end if;
  if not core.has_perm('core.user.write.all') then
    raise exception 'Kullanıcı davet etme yetkiniz yok' using errcode = '42501';
  end if;

  select id into v_user_id from core.users where lower(email) = lower(p_email);
  if v_user_id is null then
    -- Supabase'de auth.users kaydı API katmanında yaratılır; burada yalnızca
    -- profil satırı hazırlanır ve id dışarıdan verilir.
    v_user_id := coalesce(p_user_id, gen_random_uuid());
    insert into core.users (id, email, full_name) values (v_user_id, p_email, p_full_name);
    v_is_new := true;
  end if;

  -- CONFUSED-DEPUTY KORUMASI: davetlinin BASKA bir kiracida uyeligi varsa davet
  -- beklemede olusturulur; yalnizca davetli `core.accept_invite` ile etkinlestirir.
  -- Hicbir uyeligi olmayan (yeni) kullanici icin kurban yoktur -> dogrudan katilir.
  v_auto_join := v_is_new or not exists (
    select 1 from core.memberships m where m.user_id = v_user_id
  );

  insert into core.memberships (user_id, tenant_id, invited_by, is_active, accepted_at)
  values (v_user_id, v_tenant, core.current_user_id(), v_auto_join,
          case when v_auto_join then now() else null end)
  on conflict (user_id, tenant_id) do update
     set invited_by = excluded.invited_by,
         -- Bir kez kabul edilmis uyelik yeniden davetle tekrar acilir; hic
         -- kabul edilmemis (beklemede) uyelik davetle ACILMAZ.
         is_active  = (core.memberships.accepted_at is not null),
         updated_at = now()
  returning id into v_membership;

  select id into v_role_id from core.roles
   where code = p_role_code and (tenant_id is null or tenant_id = v_tenant)
   order by tenant_id nulls last limit 1;
  if v_role_id is null then
    raise exception 'Rol bulunamadı: %', p_role_code using errcode = 'P0002';
  end if;

  insert into core.membership_roles (membership_id, role_id)
  values (v_membership, v_role_id) on conflict do nothing;

  -- SUBE DOGRULAMASI: p_branch_ids'in HER id'si bu kiraciya ait olmali. Aksi
  -- halde baska kiracinin sube id'si orphan membership_branches satiri yaratir.
  delete from core.membership_branches where membership_id = v_membership;
  if p_branch_ids is not null then
    select count(*) into v_alien
    from unnest(p_branch_ids) as t(bid)
    where not exists (
      select 1 from core.branches b
       where b.id = t.bid and b.tenant_id = v_tenant
    );
    if v_alien > 0 then
      raise exception 'Şube bu kiracıya ait değil' using errcode = '42501';
    end if;
    insert into core.membership_branches (membership_id, branch_id)
    select v_membership, t.bid from unnest(p_branch_ids) as t(bid)
    on conflict do nothing;
  end if;

  return v_user_id;
end;
$$;

comment on function core.invite_user(text, text, text, uuid[], uuid) is
  'Kullaniciyi aktif kiraciya davet eder. Davetlinin baska kiracida uyeligi '
  'varsa uyelik BEKLEMEDE olusturulur ve core.accept_invite ile etkinlesir.';

-- -----------------------------------------------------------------------------
-- Bekleyen davetler ve kabul
-- -----------------------------------------------------------------------------
create or replace function core.pending_invites()
returns table (
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
  select m.tenant_id, t.name, u.full_name, m.created_at
  from core.memberships m
  join core.tenants t on t.id = m.tenant_id and t.deleted_at is null
  left join core.users u on u.id = m.invited_by
  where m.user_id = core.current_user_id()
    and m.accepted_at is null;
$$;

comment on function core.pending_invites() is
  'Oturumdaki kullanicinin henuz kabul etmedigi kiraci davetleri.';

/**
 * Bekleyen bir daveti kabul eder: uyeligi etkinlestirir. Yalnizca davetlinin
 * KENDISI cagirabilir (SECURITY DEFINER ama kullaniciyi core.current_user_id
 * ile sabitler). Baska kimse bir kullaniciyi bir kiraciya "kabul ettiremez".
 */
create or replace function core.accept_invite(p_tenant_id uuid)
returns uuid
language plpgsql
security definer
set search_path = core, pg_temp
as $$
declare
  v_user       uuid := core.current_user_id();
  v_membership uuid;
begin
  if v_user is null then
    raise exception 'Oturum yok' using errcode = '42501';
  end if;

  update core.memberships m
     set is_active   = true,
         accepted_at = now(),
         -- Kullanicinin baska varsayilan kiracisi yoksa bunu varsayilan yap
         -- (ux_memberships_one_default kismi essiz indeksini bozmadan).
         is_default  = not exists (
           select 1 from core.memberships d
           where d.user_id = v_user and d.is_default and d.tenant_id <> p_tenant_id
         ),
         updated_at  = now()
   where m.user_id = v_user
     and m.tenant_id = p_tenant_id
     and m.accepted_at is null
  returning m.id into v_membership;

  if v_membership is null then
    raise exception 'Bekleyen davet yok' using errcode = 'P0002';
  end if;

  return v_membership;
end;
$$;

comment on function core.accept_invite(uuid) is
  'Oturumdaki kullanicinin bekleyen kiraci davetini kabul eder ve uyeligi acar.';

/**
 * Bekleyen bir daveti reddeder: uyelik satirini siler. Yalnizca davetlinin
 * kendisi cagirabilir. Kabul edilmis bir uyelik BU YOLLA silinmez — onun icin
 * core.set_member_active kullanilir.
 */
create or replace function core.decline_invite(p_tenant_id uuid)
returns void
language plpgsql
security definer
set search_path = core, pg_temp
as $$
declare
  v_user uuid := core.current_user_id();
begin
  if v_user is null then
    raise exception 'Oturum yok' using errcode = '42501';
  end if;

  delete from core.memberships
   where user_id = v_user
     and tenant_id = p_tenant_id
     and accepted_at is null;

  if not found then
    raise exception 'Bekleyen davet yok' using errcode = 'P0002';
  end if;
end;
$$;

comment on function core.decline_invite(uuid) is
  'Oturumdaki kullanicinin bekleyen kiraci davetini reddeder (uyelik satirini siler).';
