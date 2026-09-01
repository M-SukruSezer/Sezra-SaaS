-- =============================================================================
-- 0002 — Kiracılar, şubeler, kullanıcılar, üyelikler, abonelik & modül aktivasyonu
-- =============================================================================
-- VARSAYIM / SAPMA (Bölüm 7'den):
-- Doküman çekirdek modeli `users (id, tenant_id, email, role)` şeklinde tanımlıyor.
-- Bunu bilinçli olarak users + memberships şeklinde ikiye ayırdım:
--   1. Bir muhasebeci/danışman birden fazla kiracıya hizmet verebilir (SaaS'ta
--      çok yaygın); tenant_id'yi user'a gömmek bunu imkânsız kılar.
--   2. Sezra'nın "Süper Admin" rolü hiçbir kiracıya ait değildir.
--   3. Rol, kullanıcının kendisinin değil, kullanıcı-kiracı ilişkisinin özelliğidir.
-- Tek kiracılı kullanıcı bu modelin dejenere hâli olduğu için hiçbir şey kaybetmiyoruz.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- Planlar (fiyatlandırma katmanları) — Bölüm 2
-- -----------------------------------------------------------------------------
create table if not exists core.plans (
  code              text primary key,                 -- 'baslangic' | 'buyume' | 'kurumsal'
  name              text not null,
  monthly_price     numeric(12,2) not null default 0,
  currency          char(3) not null default 'TRY',
  included_users    integer not null default 3,
  included_branches integer not null default 1,
  extra_user_price  numeric(12,2) not null default 0,
  extra_branch_price numeric(12,2) not null default 0,
  is_public         boolean not null default true,
  sort_order        integer not null default 0,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now()
);

-- -----------------------------------------------------------------------------
-- Modül kayıt defteri (registry) — her modül kendini buraya yazar
-- -----------------------------------------------------------------------------
create table if not exists core.modules (
  code           text primary key,                    -- 'crm', 'finance', 'hr', 'purchasing'
  name           text not null,
  description    text,
  phase          smallint not null default 1,
  depends_on     text[] not null default '{}',        -- diğer modül kodları
  is_core        boolean not null default false,      -- çekirdek: kapatılamaz
  created_at     timestamptz not null default now()
);

create table if not exists core.plan_modules (
  plan_code    text not null references core.plans(code) on delete cascade,
  module_code  text not null references core.modules(code) on delete cascade,
  primary key (plan_code, module_code)
);

-- -----------------------------------------------------------------------------
-- Kiracılar
-- -----------------------------------------------------------------------------
create table if not exists core.tenants (
  id              uuid primary key default gen_random_uuid(),
  slug            text not null unique,
  name            text not null,
  legal_name      text,
  tax_office      text,                                -- vergi dairesi
  tax_no          text,                                -- VKN/TCKN
  sector          text,                                -- onboarding'de seçilen sektör
  country_code    char(2) not null default 'TR',
  currency        char(3) not null default 'TRY',
  locale          text not null default 'tr-TR',
  timezone        text not null default 'Europe/Istanbul',
  fiscal_year_start_month smallint not null default 1
                    check (fiscal_year_start_month between 1 and 12),
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  deleted_at      timestamptz
);

create index if not exists ix_tenants_slug on core.tenants (slug) where deleted_at is null;

-- Abonelik durumu kiracıdan ayrı: plan değişikliği geçmişi tutulabilsin
create table if not exists core.subscriptions (
  id                uuid primary key default gen_random_uuid(),
  tenant_id         uuid not null references core.tenants(id) on delete cascade,
  plan_code         text not null references core.plans(code),
  status            core.subscription_status not null default 'trial',
  seats             integer not null default 3,
  branch_quota      integer not null default 1,
  trial_ends_at     timestamptz,
  current_period_start date,
  current_period_end   date,
  cancelled_at      timestamptz,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now()
);

create unique index if not exists ux_subscriptions_active_tenant
  on core.subscriptions (tenant_id)
  where status in ('trial', 'active', 'past_due');

-- Kiracı bazlı modül aktivasyonu — "sadece CRM + Muhasebe" senaryosu (Bölüm 3.5)
create table if not exists core.tenant_modules (
  tenant_id    uuid not null references core.tenants(id) on delete cascade,
  module_code  text not null references core.modules(code) on delete cascade,
  enabled      boolean not null default true,
  enabled_at   timestamptz not null default now(),
  primary key (tenant_id, module_code)
);

-- -----------------------------------------------------------------------------
-- Şubeler — tenant altındaki ikinci izolasyon katmanı (Bölüm 3.3)
-- -----------------------------------------------------------------------------
create table if not exists core.branches (
  id            uuid primary key default gen_random_uuid(),
  tenant_id     uuid not null references core.tenants(id) on delete cascade,
  code          text not null,                          -- 'DUZCE-MRK', 'ZONGULDAK'
  name          text not null,
  address       text,
  city          text,
  phone         text,
  is_headquarter boolean not null default false,
  is_active     boolean not null default true,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);

create unique index if not exists ux_branches_tenant_code on core.branches (tenant_id, code);
create index if not exists ix_branches_tenant on core.branches (tenant_id) where is_active;

-- -----------------------------------------------------------------------------
-- Kullanıcılar
-- -----------------------------------------------------------------------------
-- Supabase'de kimlik doğrulama auth.users'ta yaşar; core.users onun uygulama
-- tarafındaki profil uzantısıdır ve id'si auth.users.id ile birebir aynıdır.
-- FK'yi opsiyonel bıraktık ki şema saf PostgreSQL üzerinde (CI testleri, yerel
-- geliştirme) auth şeması olmadan da kurulabilsin.
create table if not exists core.users (
  id                 uuid primary key,
  email              text not null,
  full_name          text,
  phone              text,
  avatar_url         text,
  locale             text not null default 'tr-TR',
  timezone           text not null default 'Europe/Istanbul',
  is_platform_admin  boolean not null default false,   -- Sezra / Süper Admin
  last_seen_at       timestamptz,
  disabled_at        timestamptz,
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now()
);

create unique index if not exists ux_users_email on core.users (lower(email));

-- auth.users mevcutsa FK'yi bağla (Supabase ortamı)
do $$
begin
  if exists (select 1 from information_schema.tables
             where table_schema = 'auth' and table_name = 'users') then
    begin
      alter table core.users
        add constraint fk_users_auth_users
        foreign key (id) references auth.users(id) on delete cascade;
    exception when duplicate_object then null; end;
  end if;
end $$;

-- -----------------------------------------------------------------------------
-- Üyelikler: kullanıcı ↔ kiracı ilişkisi
-- -----------------------------------------------------------------------------
create table if not exists core.memberships (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid not null references core.users(id) on delete cascade,
  tenant_id   uuid not null references core.tenants(id) on delete cascade,
  is_default  boolean not null default false,   -- oturum açınca varsayılan kiracı
  is_active   boolean not null default true,
  invited_by  uuid references core.users(id),
  joined_at   timestamptz not null default now(),
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

create unique index if not exists ux_memberships_user_tenant
  on core.memberships (user_id, tenant_id);
create index if not exists ix_memberships_tenant on core.memberships (tenant_id) where is_active;
create index if not exists ix_memberships_user on core.memberships (user_id) where is_active;

-- Bir kullanıcının en fazla bir varsayılan kiracısı olabilir
create unique index if not exists ux_memberships_one_default
  on core.memberships (user_id) where is_default;

select core.attach_updated_at('core', t) from (values
  ('plans'), ('tenants'), ('subscriptions'), ('branches'), ('users'), ('memberships')
) as x(t);
