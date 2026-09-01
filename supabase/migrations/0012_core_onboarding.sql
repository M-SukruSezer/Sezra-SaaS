-- =============================================================================
-- 0012 — Self-servis onboarding (Bölüm 2)
-- =============================================================================
-- Kayıt ol -> şirket + sektör -> plan modülleri -> varsayılan veriler.
--
-- Modül kurulum kancaları (provisioner): core, CRM'in "varsayılan satış hunisi"
-- veya finance'in "tekdüzen hesap planı" hakkında hiçbir şey bilmez. Her modül
-- kendi kurulum fonksiyonunu buraya kaydeder; onboarding yalnızca kiracıda AÇIK
-- olan modüllerin kancalarını çağırır.
--
-- NOT: Bu fonksiyonlar SECURITY DEFINER'dır ve şemayı kuran (BYPASSRLS yetkili)
-- rolün haklarıyla çalışır — henüz üyeliği olmayan bir kullanıcı için kiracı
-- yaratmanın başka yolu yoktur.
-- =============================================================================

create table if not exists core.tenant_provisioners (
  module_code text primary key references core.modules(code) on delete cascade,
  fn_name     text not null,
  sequence    smallint not null default 100
);

create or replace function core.register_provisioner(
  p_module text, p_fn text, p_sequence smallint default 100
)
returns void
language sql
as $$
  insert into core.tenant_provisioners (module_code, fn_name, sequence)
  values (p_module, p_fn, p_sequence)
  on conflict (module_code) do update set fn_name = excluded.fn_name, sequence = excluded.sequence;
$$;

-- -----------------------------------------------------------------------------
-- Çekirdek varsayılanları: birimler ve vergiler
-- -----------------------------------------------------------------------------
create or replace function core.provision_core(p_tenant_id uuid)
returns void
language plpgsql
security definer
set search_path = core, pg_temp
as $$
begin
  insert into core.uoms (tenant_id, code, name, category, ratio) values
    (p_tenant_id, 'ADET',  'Adet',        'unit',   1),
    (p_tenant_id, 'PAKET', 'Paket',       'unit',   1),
    (p_tenant_id, 'KOLI',  'Koli',        'unit',   1),
    (p_tenant_id, 'KG',    'Kilogram',    'weight', 1),
    (p_tenant_id, 'GR',    'Gram',        'weight', 0.001),
    (p_tenant_id, 'LT',    'Litre',       'volume', 1),
    (p_tenant_id, 'ML',    'Mililitre',   'volume', 0.001),
    (p_tenant_id, 'SAAT',  'Saat',        'time',   1)
  on conflict do nothing;

  -- 2026 itibarıyla geçerli KDV oranları. Oranlar mevzuatla değiştiği için
  -- kod içine gömülmez; kiracı bazlı satır olarak tutulur ve düzenlenebilir.
  insert into core.taxes (tenant_id, code, name, rate, kind, is_default_sale, is_default_purchase) values
    (p_tenant_id, 'KDV20', 'KDV %20', 20, 'vat', true,  true),
    (p_tenant_id, 'KDV10', 'KDV %10', 10, 'vat', false, false),
    (p_tenant_id, 'KDV1',  'KDV %1',   1, 'vat', false, false),
    (p_tenant_id, 'KDV0',  'KDV %0',   0, 'exempt', false, false)
  on conflict do nothing;
end;
$$;

select core.register_provisioner('core', 'core.provision_core', 10::smallint);

-- -----------------------------------------------------------------------------
-- Kiracı oluşturma
-- -----------------------------------------------------------------------------
create or replace function core.provision_tenant(
  p_name         text,
  p_slug         text default null,
  p_plan_code    text default 'baslangic',
  p_admin_user_id uuid default null,
  p_sector       text default null,
  p_branch_name  text default 'Merkez',
  p_extra_modules text[] default '{}'
)
returns uuid
language plpgsql
security definer
set search_path = core, pg_temp
as $$
declare
  v_tenant_id  uuid;
  v_slug       text;
  v_branch_id  uuid;
  v_membership uuid;
  v_admin_role uuid;
  v_admin      uuid := coalesce(p_admin_user_id, core.current_user_id());
  v_prov       record;
begin
  if v_admin is null then
    raise exception 'provision_tenant: yönetici kullanıcı belirtilmeli' using errcode = '22023';
  end if;
  if not exists (select 1 from core.users where id = v_admin) then
    raise exception 'provision_tenant: kullanıcı bulunamadı (%)', v_admin using errcode = 'P0002';
  end if;

  v_slug := coalesce(nullif(p_slug, ''), core.slugify(p_name));
  if exists (select 1 from core.tenants where slug = v_slug) then
    v_slug := v_slug || '-' || substr(gen_random_uuid()::text, 1, 6);
  end if;

  insert into core.tenants (slug, name, sector)
  values (v_slug, p_name, p_sector)
  returning id into v_tenant_id;

  insert into core.subscriptions (tenant_id, plan_code, status, trial_ends_at,
                                  seats, branch_quota,
                                  current_period_start, current_period_end)
  select v_tenant_id, p.code, 'trial', now() + interval '14 days',
         p.included_users, p.included_branches,
         current_date, (current_date + interval '1 month')::date
  from core.plans p where p.code = p_plan_code;

  -- Plandaki modüller + açıkça istenen ek modüller
  insert into core.tenant_modules (tenant_id, module_code)
  select v_tenant_id, pm.module_code from core.plan_modules pm where pm.plan_code = p_plan_code
  union
  select v_tenant_id, m.code from core.modules m where m.code = any (p_extra_modules)
  union
  select v_tenant_id, m.code from core.modules m where m.is_core
  on conflict do nothing;

  insert into core.branches (tenant_id, code, name, is_headquarter)
  values (v_tenant_id, 'MERKEZ', p_branch_name, true)
  returning id into v_branch_id;

  insert into core.memberships (user_id, tenant_id, is_default, is_active)
  values (v_admin, v_tenant_id,
          not exists (select 1 from core.memberships where user_id = v_admin), true)
  on conflict (user_id, tenant_id) do update set is_active = true
  returning id into v_membership;

  select id into v_admin_role from core.roles where tenant_id is null and code = 'tenant_admin';
  insert into core.membership_roles (membership_id, role_id)
  values (v_membership, v_admin_role) on conflict do nothing;
  -- Şube kısıtı YOK -> tüm şubeler (core.accessible_branch_ids kuralı)

  -- Açık modüllerin kurulum kancalarını çalıştır
  for v_prov in
    select tp.fn_name
    from core.tenant_provisioners tp
    join core.tenant_modules tm on tm.module_code = tp.module_code
                              and tm.tenant_id = v_tenant_id and tm.enabled
    order by tp.sequence
  loop
    execute format('select %s($1)', v_prov.fn_name) using v_tenant_id;
  end loop;

  perform core.emit_event('core.tenant.provisioned',
    jsonb_build_object('tenant_id', v_tenant_id, 'plan', p_plan_code, 'admin_user_id', v_admin),
    v_branch_id, null, v_tenant_id);

  return v_tenant_id;
end;
$$;

select core.declare_event('core.tenant.provisioned', 'core', 'Yeni kiracı kuruldu');

-- Kullanıcıyı kiracıya davet et
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
  v_branch     uuid;
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
  end if;

  insert into core.memberships (user_id, tenant_id, invited_by, is_active)
  values (v_user_id, v_tenant, core.current_user_id(), true)
  on conflict (user_id, tenant_id) do update set is_active = true
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
    foreach v_branch in array p_branch_ids loop
      insert into core.membership_branches (membership_id, branch_id)
      values (v_membership, v_branch) on conflict do nothing;
    end loop;
  end if;

  return v_user_id;
end;
$$;
