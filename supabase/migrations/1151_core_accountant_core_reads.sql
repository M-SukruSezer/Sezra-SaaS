-- =============================================================================
-- 1151 — Musavir okumasi: elle yazilmis core tablo politikalari
-- =============================================================================
-- 1150 modul tablolarinin RLS politika URETICISINI degistirdi; ama core.tenants,
-- core.branches, core.tenant_modules, core.subscriptions ve core.users
-- politikalari 0009'da ELLE yazilmis ve ureticiden gecmez. Musavir oturumu bu
-- tablolari goremezse panel calisir ama kiracinin adini, subelerini ve acik
-- modul listesini cozemez (/me bos doner).
--
-- Bu dosya o bes politikaya `core.accountant_tenant_id()` OR dalini ekler.
-- YALNIZCA for-select: musavir bu tablolarda da yazamaz (yazma politikalari
-- degismedi). Destek erisimi bu tablolarda is_platform_admin() ile calisiyordu
-- (destek admini zaten platform yoneticisi); musavirin oyle bir kestirmesi yok,
-- bu yuzden acik terim gerekli.
-- =============================================================================
set client_min_messages = warning;

-- core.tenants — musavir yalnizca erisimli oldugu kiraciyi gorur
drop policy if exists p_tenants_select on core.tenants;
create policy p_tenants_select on core.tenants for select
  using (
    core.is_platform_admin()
    or id = (select core.accountant_tenant_id())
    or id in (select m.tenant_id from core.memberships m
              where m.user_id = (select core.current_user_id()) and m.is_active)
  );

-- core.branches — musavir kiracinin tum subelerini okuyabilir (rapor suzgeci)
drop policy if exists p_branches_select on core.branches;
create policy p_branches_select on core.branches for select
  using (
    tenant_id = (select core.support_tenant_id())
    or tenant_id = (select core.accountant_tenant_id())
    or (tenant_id = (select core.current_tenant_id())
        and (select core.accessible_branch_ids()) @> array[id])
  );

-- core.subscriptions / core.tenant_modules — /me menusu icin modul listesi
do $$
declare t text;
begin
  foreach t in array array['subscriptions', 'tenant_modules'] loop
    execute format('drop policy if exists p_%s_select on core.%I', t, t);
    execute format($p$create policy p_%1$s_select on core.%1$I for select
      using (tenant_id = (select core.support_tenant_id())
             or tenant_id = (select core.accountant_tenant_id())
             or tenant_id = (select core.current_tenant_id()))$p$, t);
  end loop;
end $$;

-- core.users — musavir, erisimli kiracinin etkin uyelerini okuyabilir
-- (fatura/kayit sahibi adlari v_*_list gorunumlerinde cozulsun).
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
    or (
      (select core.accountant_tenant_id()) is not null
      and id in (select m.user_id from core.memberships m
                 where m.tenant_id = (select core.accountant_tenant_id()) and m.is_active)
    )
  );
