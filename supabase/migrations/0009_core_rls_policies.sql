-- =============================================================================
-- 0009 — Çekirdek tabloların RLS politikaları
-- =============================================================================
-- Bu tablolar standart üreticiyi (core.apply_rls) kullanamaz: bir kısmında
-- tenant_id yok (core.users), bir kısmı kiracılar üstü katalog (core.plans),
-- bir kısmı ise kendi kendine referans veren yetki tablosu. Elle yazıyoruz.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- Kiracılar üstü kataloglar: herkes okur, yalnızca platform yönetimi yazar
-- -----------------------------------------------------------------------------
do $$
declare t text;
begin
  foreach t in array array['plans', 'modules', 'permissions', 'plan_modules'] loop
    execute format('alter table core.%I enable row level security', t);
    execute format('alter table core.%I force row level security', t);
    execute format('drop policy if exists p_%s_select on core.%I', t, t);
    execute format('create policy p_%s_select on core.%I for select using (core.current_user_id() is not null)', t, t);
    execute format('drop policy if exists p_%s_admin on core.%I', t, t);
    execute format('create policy p_%s_admin on core.%I for all using (core.is_platform_admin()) with check (core.is_platform_admin())', t, t);
  end loop;
end $$;

-- -----------------------------------------------------------------------------
-- core.tenants — kullanıcı yalnızca üyesi olduğu kiracıyı görür
-- -----------------------------------------------------------------------------
alter table core.tenants enable row level security;
alter table core.tenants force row level security;

drop policy if exists p_tenants_select on core.tenants;
create policy p_tenants_select on core.tenants for select
  using (
    core.is_platform_admin()
    or id in (select m.tenant_id from core.memberships m
              where m.user_id = (select core.current_user_id()) and m.is_active)
  );

drop policy if exists p_tenants_update on core.tenants;
create policy p_tenants_update on core.tenants for update
  using (core.is_platform_admin()
         or (id = (select core.current_tenant_id()) and (select core.has_perm('core.tenant.write.all'))))
  with check (core.is_platform_admin()
         or (id = (select core.current_tenant_id()) and (select core.has_perm('core.tenant.write.all'))));

-- Kiracı oluşturma yalnızca onboarding fonksiyonu (security definer) üzerinden.
drop policy if exists p_tenants_admin_all on core.tenants;
create policy p_tenants_admin_all on core.tenants for all
  using (core.is_platform_admin()) with check (core.is_platform_admin());

-- -----------------------------------------------------------------------------
-- core.subscriptions / core.tenant_modules — üyeler okur, tenant admin yazar
-- -----------------------------------------------------------------------------
do $$
declare t text;
begin
  foreach t in array array['subscriptions', 'tenant_modules'] loop
    execute format('alter table core.%I enable row level security', t);
    execute format('alter table core.%I force row level security', t);
    execute format('drop policy if exists p_%s_select on core.%I', t, t);
    execute format($p$create policy p_%1$s_select on core.%1$I for select
      using (tenant_id = (select core.support_tenant_id()) or tenant_id = (select core.current_tenant_id()))$p$, t);
    execute format('drop policy if exists p_%s_write on core.%I', t, t);
    execute format($p$create policy p_%1$s_write on core.%1$I for all
      using (core.is_platform_admin()
             or (tenant_id = (select core.current_tenant_id()) and (select core.has_perm('core.tenant.write.all'))))
      with check (core.is_platform_admin()
             or (tenant_id = (select core.current_tenant_id()) and (select core.has_perm('core.tenant.write.all'))))$p$, t);
  end loop;
end $$;

-- -----------------------------------------------------------------------------
-- core.branches — şube kapsamına saygı gösterir
-- -----------------------------------------------------------------------------
alter table core.branches enable row level security;
alter table core.branches force row level security;

drop policy if exists p_branches_select on core.branches;
create policy p_branches_select on core.branches for select
  using (
    tenant_id = (select core.support_tenant_id())
    or (tenant_id = (select core.current_tenant_id())
        and (select core.accessible_branch_ids()) @> array[id])
  );

drop policy if exists p_branches_write on core.branches;
create policy p_branches_write on core.branches for all
  using (tenant_id = (select core.current_tenant_id()) and (select core.has_perm('core.branch.write.all')))
  with check (tenant_id = (select core.current_tenant_id()) and (select core.has_perm('core.branch.write.all')));

-- -----------------------------------------------------------------------------
-- core.users — kendini her zaman görür; başkalarını yalnızca aynı kiracıdaysa
-- ve core.user.read.all izni varsa görür.
-- -----------------------------------------------------------------------------
alter table core.users enable row level security;
alter table core.users force row level security;

drop policy if exists p_users_select on core.users;
create policy p_users_select on core.users for select
  using (
    core.is_platform_admin()
    or id = (select core.current_user_id())
    or (
      (select core.has_perm('core.user.read.all'))
      and id in (select m.user_id from core.memberships m
                 where m.tenant_id = (select core.current_tenant_id()) and m.is_active)
    )
  );

drop policy if exists p_users_update_self on core.users;
create policy p_users_update_self on core.users for update
  using (id = (select core.current_user_id()))
  with check (id = (select core.current_user_id()));

drop policy if exists p_users_platform_admin on core.users;
create policy p_users_platform_admin on core.users for all
  using (core.is_platform_admin()) with check (core.is_platform_admin());

-- GÜVENLİK: is_platform_admin bayrağını kullanıcı kendi üzerinde değiştiremez.
create or replace function core.fn_guard_platform_admin()
returns trigger
language plpgsql
as $$
begin
  if new.is_platform_admin is distinct from old.is_platform_admin
     and not core.is_platform_admin() then
    raise exception 'is_platform_admin yalnızca platform yönetimi tarafından değiştirilebilir'
      using errcode = '42501';
  end if;
  return new;
end;
$$;

drop trigger if exists trg_users_guard_platform_admin on core.users;
create trigger trg_users_guard_platform_admin before update on core.users
  for each row execute function core.fn_guard_platform_admin();

-- -----------------------------------------------------------------------------
-- core.memberships
-- -----------------------------------------------------------------------------
alter table core.memberships enable row level security;
alter table core.memberships force row level security;

drop policy if exists p_memberships_select on core.memberships;
create policy p_memberships_select on core.memberships for select
  using (
    core.is_platform_admin()
    or user_id = (select core.current_user_id())
    or (tenant_id = (select core.current_tenant_id()) and (select core.has_perm('core.user.read.all')))
  );

drop policy if exists p_memberships_write on core.memberships;
create policy p_memberships_write on core.memberships for all
  using (core.is_platform_admin()
         or (tenant_id = (select core.current_tenant_id()) and (select core.has_perm('core.user.write.all'))))
  with check (core.is_platform_admin()
         or (tenant_id = (select core.current_tenant_id()) and (select core.has_perm('core.user.write.all'))));

-- -----------------------------------------------------------------------------
-- core.roles — sistem rolleri (tenant_id null) herkese okunur, salt okunur
-- -----------------------------------------------------------------------------
alter table core.roles enable row level security;
alter table core.roles force row level security;

drop policy if exists p_roles_select on core.roles;
create policy p_roles_select on core.roles for select
  using (
    core.is_platform_admin()
    or tenant_id is null
    or tenant_id = (select core.current_tenant_id())
  );

drop policy if exists p_roles_write on core.roles;
create policy p_roles_write on core.roles for all
  using (core.is_platform_admin()
         or (tenant_id = (select core.current_tenant_id()) and not is_system
             and (select core.has_perm('core.role.write.all'))))
  with check (core.is_platform_admin()
         or (tenant_id = (select core.current_tenant_id()) and not is_system
             and (select core.has_perm('core.role.write.all'))));

-- -----------------------------------------------------------------------------
-- Bağlantı tabloları — yetkiyi üst kayıttan devralır
-- -----------------------------------------------------------------------------
alter table core.role_permissions enable row level security;
alter table core.role_permissions force row level security;
drop policy if exists p_role_permissions_select on core.role_permissions;
create policy p_role_permissions_select on core.role_permissions for select
  using (exists (select 1 from core.roles r where r.id = role_id));   -- roles RLS'i uygulanır
drop policy if exists p_role_permissions_write on core.role_permissions;
create policy p_role_permissions_write on core.role_permissions for all
  using (exists (select 1 from core.roles r
                 where r.id = role_id and r.tenant_id = (select core.current_tenant_id())
                   and not r.is_system and (select core.has_perm('core.role.write.all'))))
  with check (exists (select 1 from core.roles r
                 where r.id = role_id and r.tenant_id = (select core.current_tenant_id())
                   and not r.is_system and (select core.has_perm('core.role.write.all'))));

do $$
declare t text;
begin
  foreach t in array array['membership_roles', 'membership_branches'] loop
    execute format('alter table core.%I enable row level security', t);
    execute format('alter table core.%I force row level security', t);
    execute format('drop policy if exists p_%s_select on core.%I', t, t);
    execute format($p$create policy p_%1$s_select on core.%1$I for select
      using (exists (select 1 from core.memberships m where m.id = membership_id))$p$, t);
    execute format('drop policy if exists p_%s_write on core.%I', t, t);
    execute format($p$create policy p_%1$s_write on core.%1$I for all
      using (exists (select 1 from core.memberships m
                     where m.id = membership_id and m.tenant_id = (select core.current_tenant_id())
                       and (select core.has_perm('core.user.write.all'))))
      with check (exists (select 1 from core.memberships m
                     where m.id = membership_id and m.tenant_id = (select core.current_tenant_id())
                       and (select core.has_perm('core.user.write.all'))))$p$, t);
  end loop;
end $$;

-- -----------------------------------------------------------------------------
-- core.sequences — okunur; artırma yalnızca core.next_sequence() üzerinden
-- -----------------------------------------------------------------------------
alter table core.sequences enable row level security;
alter table core.sequences force row level security;
drop policy if exists p_sequences_select on core.sequences;
create policy p_sequences_select on core.sequences for select
  using (tenant_id = (select core.support_tenant_id()) or tenant_id = (select core.current_tenant_id()));
drop policy if exists p_sequences_write on core.sequences;
create policy p_sequences_write on core.sequences for all
  using (tenant_id = (select core.current_tenant_id()) and (select core.has_perm('core.tenant.write.all')))
  with check (tenant_id = (select core.current_tenant_id()) and (select core.has_perm('core.tenant.write.all')));
