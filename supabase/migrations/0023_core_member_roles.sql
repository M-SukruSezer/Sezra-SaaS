-- =============================================================================
-- 0023 — Üyelik rolü ve şube kapsamı yönetimi
--
-- `core.invite_user` yalnızca rol EKLER (`on conflict do nothing`). Bir
-- kullanıcının rolünü "Satış"tan "Muhasebe"ye çevirmek için onu tekrar davet
-- etmek, eski rolü de üzerinde bırakıyordu — yani yetki daraltmak imkânsızdı,
-- yalnızca genişletilebiliyordu. Aşağıdaki fonksiyon rolleri DEĞİŞTİRİR.
--
-- KENDİNİ KİLİTLEME KORUMASI: bir şirkette en az bir yönetici kalmalıdır.
-- Tek yöneticinin kendi yöneticiliğini alması, kiracıyı kimsenin
-- yönetemeyeceği bir duruma sokar ve bunun geri dönüşü yalnızca platform
-- tarafından, destek modunda mümkündür. Veritabanı bunu en baştan reddeder;
-- kontrolü arayüze bırakmak, API'yi doğrudan çağıran birine açık kapı olurdu.
-- =============================================================================
set client_min_messages = warning;

/**
 * Bir üyenin rollerini ve şube kapsamını TAMAMEN değiştirir.
 *
 * Rol listesi boş olamaz: rolsüz bir üyelik, giriş yapabilen ama hiçbir şey
 * göremeyen bir kullanıcı demektir; bu bir yetki durumu değil, bir arıza
 * gibi görünür. Erişimi kaldırmak isteyen `core.set_member_active` kullanır.
 *
 * `p_branch_ids` NULL ise kapsam TÜM şubelerdir; boş dizi ise hiçbiri.
 * İkisi farklı şeydir ve karıştırılırsa şube müdürü bir anda tüm şirketi
 * görmeye başlar.
 */
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
  v_branch     uuid;
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
    foreach v_branch in array p_branch_ids loop
      insert into core.membership_branches (membership_id, branch_id)
      values (v_membership, v_branch) on conflict do nothing;
    end loop;
  end if;
end;
$$;

/**
 * Üyeliği açar ya da kapatır.
 *
 * KAYIT SİLİNMEZ: ayrılan bir kullanıcının açtığı teklifler, kestiği
 * faturalar ve denetim izi ona bağlıdır. Üyeliği kapatmak erişimi bitirir,
 * geçmişi bozmaz.
 *
 * KENDİNİ KAPATAMAZ: kullanıcının kendi erişimini kesmesi, geri alması
 * imkânsız bir kazadır.
 */
create or replace function core.set_member_active(p_user_id uuid, p_active boolean)
returns void
language plpgsql
security definer
set search_path = core, pg_temp
as $$
declare
  v_tenant uuid := core.current_tenant_id();
  v_admin_kalan integer;
begin
  if v_tenant is null then
    raise exception 'Aktif kiracı yok' using errcode = '42501';
  end if;
  if not core.has_perm('core.user.write.all') then
    raise exception 'Kullanıcı yetkisi değiştirme izniniz yok' using errcode = '42501';
  end if;
  if p_user_id = core.current_user_id() then
    raise exception 'Kendi erişiminizi kapatamazsınız' using errcode = '23514';
  end if;

  if not p_active then
    select count(*) into v_admin_kalan
    from core.memberships m
    join core.membership_roles mr on mr.membership_id = m.id
    join core.roles r on r.id = mr.role_id
    where m.tenant_id = v_tenant and m.is_active
      and r.code = 'tenant_admin' and m.user_id <> p_user_id;
    if v_admin_kalan = 0 then
      raise exception 'Şirketteki son yöneticinin erişimi kapatılamaz'
        using errcode = '23514';
    end if;
  end if;

  update core.memberships set is_active = p_active
   where user_id = p_user_id and tenant_id = v_tenant;
  if not found then
    raise exception 'Bu kullanıcı şirkete üye değil' using errcode = 'P0002';
  end if;
end;
$$;

comment on function core.set_member_roles(uuid, text[], uuid[]) is
  'Üyenin rollerini ve şube kapsamını değiştirir. Son yöneticinin '
  'yöneticiliğini almaya izin vermez.';
