-- =============================================================================
-- 0003 — RBAC: roller, izinler, şube kapsamı  (Bölüm 3.4)
-- =============================================================================
-- Odoo'daki "Access Rights + Record Rules" ikilisinin karşılığı:
--   (1) Access Rights  -> core.permissions + role_permissions  (modüle/varlığa erişim)
--   (2) Record Rules   -> izin kodundaki KAPSAM eki + şube kapsamı
--
-- İzin kodu sözleşmesi:  <modül>.<varlık>.<eylem>[.<kapsam>]
--   kapsam = 'own'  -> yalnızca sahibi olduğu kayıtlar (owner_id = kullanıcı)
--   kapsam = 'all'  -> erişebildiği şubelerdeki tüm kayıtlar
--   kapsamsız kodlar (ör. 'finance.invoice.approve') eylem bazlı yetkidir.
-- Bu sözleşme sayesinde her modül için ayrı politika mantığı yazmak yerine
-- tek bir core.can_select / core.can_write yardımcısı yeterli olur.
-- =============================================================================

create table if not exists core.permissions (
  code         text primary key,
  module_code  text not null references core.modules(code) on delete cascade,
  entity       text not null,
  action       text not null,                 -- read | write | create | delete | approve | export ...
  scope        text,                          -- own | all | null
  description  text,
  created_at   timestamptz not null default now()
);

create index if not exists ix_permissions_module on core.permissions (module_code);

create table if not exists core.roles (
  id           uuid primary key default gen_random_uuid(),
  tenant_id    uuid references core.tenants(id) on delete cascade,  -- null = sistem rolü
  code         text not null,
  name         text not null,
  description  text,
  is_system    boolean not null default false, -- kiracı silemez/değiştiremez
  rank         smallint not null default 50,   -- hiyerarşi: düşük = daha yetkili
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);

-- Sistem rollerinde tenant_id null olduğu için iki ayrı unique index gerekiyor
create unique index if not exists ux_roles_system_code
  on core.roles (code) where tenant_id is null;
create unique index if not exists ux_roles_tenant_code
  on core.roles (tenant_id, code) where tenant_id is not null;

create table if not exists core.role_permissions (
  role_id          uuid not null references core.roles(id) on delete cascade,
  permission_code  text not null references core.permissions(code) on delete cascade,
  primary key (role_id, permission_code)
);

-- Kullanıcının bir kiracıdaki rolleri (çoklu rol destekli)
create table if not exists core.membership_roles (
  membership_id uuid not null references core.memberships(id) on delete cascade,
  role_id       uuid not null references core.roles(id) on delete cascade,
  primary key (membership_id, role_id)
);

-- Kullanıcının erişebildiği şubeler.
-- KURAL: hiç satır yoksa -> kiracının TÜM şubeleri (tenant admin davranışı).
--        satır varsa    -> yalnızca listelenen şubeler.
create table if not exists core.membership_branches (
  membership_id uuid not null references core.memberships(id) on delete cascade,
  branch_id     uuid not null references core.branches(id) on delete cascade,
  primary key (membership_id, branch_id)
);

create index if not exists ix_membership_branches_branch on core.membership_branches (branch_id);

select core.attach_updated_at('core', 'roles');
