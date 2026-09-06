-- =============================================================================
-- 1120 — Sube kapsami dogrulamasi: core.set_member_roles'daki acigi kapat
-- =============================================================================
-- SORUN: `core.set_member_roles` (0023_core_member_roles.sql:89-95) `p_branch_ids`
-- dizisini, o subelerin cagiranin kiracisina ait oldugunu KONTROL ETMEDEN
-- `core.membership_branches`e yaziyordu. Bir kiraci yoneticisi baska kiracinin
-- sube id'sini gecirip orphan bir kapsam satiri yaratabiliyordu. Bu, T-010'da
-- `core.invite_user` icin kapatilan (1110_core_invite_acceptance.sql) kusurun
-- birebir aynisi.
--
-- COZUM: dogrulamayi tek bir yardimci fonksiyonda topla
-- (`core.assert_branches_in_tenant`) ve HER IKI cagiran da onu kullansin — iki
-- fonksiyon artik ayni kodu, ayni hatayi (42501 'Sube bu kiraciya ait degil')
-- ve ayni davranisi (fonksiyon atomik oldugu icin kotu id tum cagriyi geri alir)
-- paylasir. `invite_user` da satir ici kontrolden yardimciya cevrilir ki ikisi
-- zamanla ayrisamasin.
--
-- NOT: 0023 ve 1110 yerinde duzenlenmez; bu ileri migration fonksiyonlari
-- degistirir.
-- =============================================================================
set client_min_messages = warning;

-- -----------------------------------------------------------------------------
-- Yardimci: verilen sube id'lerinin tamami kiraciya ait olmali
-- -----------------------------------------------------------------------------
-- p_branch_ids NULL ise ("tum subeler") hicbir sey dogrulanmaz. Bos dizi de
-- gecerlidir ("hicbir sube"). Yalnizca kiraci disi bir id 42501 firlatir.
-- SECURITY DEFINER: core.current_tenant_id gibi diger baglam yardimcilariyla
-- ayni kalip. core.branches RLS'ini atlar; kiraci id'si zaten cagirandan
-- acikca gelir ve fonksiyon yalnizca "ait mi degil mi" der, satir dondurmez.
create or replace function core.assert_branches_in_tenant(
  p_branch_ids uuid[], p_tenant uuid
)
returns void
language plpgsql
stable
security definer
set search_path = core, pg_temp
as $$
begin
  if p_branch_ids is null then
    return;
  end if;
  if exists (
    select 1 from unnest(p_branch_ids) as t(bid)
    where not exists (
      select 1 from core.branches b
       where b.id = t.bid and b.tenant_id = p_tenant
    )
  ) then
    raise exception 'Şube bu kiracıya ait değil' using errcode = '42501';
  end if;
end;
$$;

comment on function core.assert_branches_in_tenant(uuid[], uuid) is
  'p_branch_ids icindeki her id p_tenant kiracisina ait degilse 42501 firlatir. '
  'core.invite_user ve core.set_member_roles bunu paylasir.';

-- -----------------------------------------------------------------------------
-- core.set_member_roles — sube dogrulamasi eklendi
-- -----------------------------------------------------------------------------
create or replace function core.set_member_roles(
  p_user_id uuid, p_role_codes text[], p_branch_ids uuid[] default null
)
returns void
language plpgsql
security definer
set search_path = core, pg_temp
as $$
declare
  v_tenant     uuid := core.current_tenant_id();
  v_membership uuid;
  v_role_id    uuid;
  v_code       text;
  v_admin_kalan integer;
begin
  if v_tenant is null then
    raise exception 'Aktif kiracı yok' using errcode = '42501';
  end if;
  if not core.has_perm('core.user.write.all') then
    raise exception 'Kullanıcı yetkisi değiştirme izniniz yok' using errcode = '42501';
  end if;
  if p_role_codes is null or cardinality(p_role_codes) = 0 then
    raise exception 'En az bir rol verilmelidir' using errcode = '23514';
  end if;

  -- SUBE DOGRULAMASI: rol ve uyelik degisiklikleri yazilmadan ONCE. Kotu bir
  -- sube id'si tum cagriyi geri almali; sonda kontrol etseydik roller degismis,
  -- kapsam yarim yazilmis olurdu.
  perform core.assert_branches_in_tenant(p_branch_ids, v_tenant);

  select id into v_membership from core.memberships
   where user_id = p_user_id and tenant_id = v_tenant;
  if v_membership is null then
    raise exception 'Bu kullanıcı şirkete üye değil' using errcode = 'P0002';
  end if;

  -- KİLİTLENME KONTROLÜ: yeni roller arasında tenant_admin yoksa ve bu
  -- kullanıcı son yöneticiyse işlem reddedilir.
  if not ('tenant_admin' = any(p_role_codes)) then
    select count(*) into v_admin_kalan
    from core.memberships m
    join core.membership_roles mr on mr.membership_id = m.id
    join core.roles r on r.id = mr.role_id
    where m.tenant_id = v_tenant and m.is_active
      and r.code = 'tenant_admin' and m.user_id <> p_user_id;

    if v_admin_kalan = 0 then
      raise exception
        'Şirkette en az bir yönetici kalmalı; son yöneticinin rolü değiştirilemez'
        using errcode = '23514';
    end if;
  end if;

  delete from core.membership_roles where membership_id = v_membership;
  foreach v_code in array p_role_codes loop
    select id into v_role_id from core.roles
     where code = v_code and (tenant_id is null or tenant_id = v_tenant)
     order by tenant_id nulls last limit 1;
    if v_role_id is null then
      raise exception 'Rol bulunamadı: %', v_code using errcode = 'P0002';
    end if;
    insert into core.membership_roles (membership_id, role_id)
    values (v_membership, v_role_id) on conflict do nothing;
  end loop;

  delete from core.membership_branches where membership_id = v_membership;
  if p_branch_ids is not null then
    insert into core.membership_branches (membership_id, branch_id)
    select v_membership, t.bid from unnest(p_branch_ids) as t(bid)
    on conflict do nothing;
  end if;
end;
$$;

comment on function core.set_member_roles(uuid, text[], uuid[]) is
  'Üyenin rollerini ve şube kapsamını değiştirir. Son yöneticinin '
  'yöneticiliğini almaya izin vermez. Şube id''leri kiracıya ait olmalı.';

-- -----------------------------------------------------------------------------
-- core.invite_user — satir ici sube kontrolu paylasilan yardimciya cevrildi
-- -----------------------------------------------------------------------------
-- Davranis 1110 ile aynidir; yalnizca dogrulama tek kaynaga tasindi.
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
begin
  if v_tenant is null then
    raise exception 'Aktif kiracı yok' using errcode = '42501';
  end if;
  if not core.has_perm('core.user.write.all') then
    raise exception 'Kullanıcı davet etme yetkiniz yok' using errcode = '42501';
  end if;

  -- SUBE DOGRULAMASI: kullanici satiri yazilmadan ONCE (fonksiyon atomik).
  perform core.assert_branches_in_tenant(p_branch_ids, v_tenant);

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

  delete from core.membership_branches where membership_id = v_membership;
  if p_branch_ids is not null then
    insert into core.membership_branches (membership_id, branch_id)
    select v_membership, t.bid from unnest(p_branch_ids) as t(bid)
    on conflict do nothing;
  end if;

  return v_user_id;
end;
$$;

comment on function core.invite_user(text, text, text, uuid[], uuid) is
  'Kullaniciyi aktif kiraciya davet eder. Davetlinin baska kiracida uyeligi '
  'varsa uyelik BEKLEMEDE olusturulur ve core.accept_invite ile etkinlesir. '
  'Sube id''leri kiraciya ait olmali.';
