-- =============================================================================
-- 0300 — İnsan Kaynakları: şema  (Bölüm 4.3)
-- =============================================================================
-- TASARIM KARARLARI
--
-- 1. hr.employees, core.partners'tan AYRI bir tablodur.
--    core.partners'ta is_employee bayrağı var ama bordro bir cariden çok daha
--    fazlasını ister (SGK sicili, işe giriş/çıkış, pozisyon, yönetici zinciri).
--    Bunları partners'a doldurmak, çalışan alanlarını tüm müşteri kayıtlarına
--    yaymak demekti. Bunun yerine opsiyonel `partner_id` bağı bıraktık: bordro
--    muhasebeleştiğinde 335 PERSONELE BORÇLAR hesabının cari alt kırılımı bu
--    partner üzerinden yürür.
--
-- 2. ÜCRET, hr.employees'ta DEĞİL, hr.employee_contracts'ta tutulur ve kendi
--    izin kodunu (hr.contract.*) taşır. Böylece bir departman yöneticisi ekip
--    listesini, izin taleplerini ve puantajı görürken maaşları göremez.
--    KVKK'nın "gerektiği kadar veri" ilkesinin şemadaki karşılığı budur;
--    tek tabloda tutulsaydı kolon bazlı yetki gerekirdi ve RLS bunu satır
--    düzeyinde çözemezdi.
--
-- 3. Sözleşme geçmişi versiyonludur (valid_from/valid_to). Geçmiş bir ayın
--    bordrosu yeniden hesaplandığında O AYKİ ücret kullanılır — zam, geçmiş
--    bordroları geriye dönük bozmaz.
-- =============================================================================

do $$ begin
  create type hr.employment_type as enum ('full_time', 'part_time', 'temporary', 'intern', 'seasonal');
exception when duplicate_object then null; end $$;

do $$ begin
  create type hr.leave_status as enum ('draft', 'pending', 'approved', 'rejected', 'cancelled');
exception when duplicate_object then null; end $$;

do $$ begin
  create type hr.payroll_status as enum ('draft', 'calculated', 'approved', 'posted', 'cancelled');
exception when duplicate_object then null; end $$;

do $$ begin
  create type hr.payslip_line_kind as enum ('earning', 'deduction', 'employer_cost', 'info');
exception when duplicate_object then null; end $$;

-- -----------------------------------------------------------------------------
-- Departmanlar — organizasyon şeması
-- -----------------------------------------------------------------------------
create table if not exists hr.departments (
  id           uuid primary key default gen_random_uuid(),
  tenant_id    uuid not null references core.tenants(id) on delete cascade,
  branch_id    uuid references core.branches(id) on delete set null,
  parent_id    uuid references hr.departments(id) on delete set null,
  code         text not null,
  name         text not null,
  manager_id   uuid,                              -- hr.employees(id); FK aşağıda
  is_active    boolean not null default true,
  created_by   uuid references core.users(id),
  updated_by   uuid references core.users(id),
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);
create unique index if not exists ux_hr_departments_code on hr.departments (tenant_id, code);

-- -----------------------------------------------------------------------------
-- Pozisyonlar / unvanlar
-- -----------------------------------------------------------------------------
create table if not exists hr.positions (
  id            uuid primary key default gen_random_uuid(),
  tenant_id     uuid not null references core.tenants(id) on delete cascade,
  department_id uuid references hr.departments(id) on delete set null,
  code          text not null,
  name          text not null,
  -- SGK meslek kodu (e-Bildirge için gerekli; ilk sürümde yalnızca saklanır)
  occupation_code text,
  is_active     boolean not null default true,
  created_by    uuid references core.users(id),
  updated_by    uuid references core.users(id),
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);
create unique index if not exists ux_hr_positions_code on hr.positions (tenant_id, code);

-- -----------------------------------------------------------------------------
-- Personel
-- -----------------------------------------------------------------------------
create table if not exists hr.employees (
  id                uuid primary key default gen_random_uuid(),
  tenant_id         uuid not null references core.tenants(id) on delete cascade,
  branch_id         uuid references core.branches(id) on delete set null,
  -- Muhasebe alt kırılımı için (335 PERSONELE BORÇLAR). Zorunlu değil.
  partner_id        uuid references core.partners(id) on delete set null,
  -- Çalışan aynı zamanda sistem kullanıcısıysa: kendi izin talebini görebilsin
  user_id           uuid references core.users(id) on delete set null,
  employee_no       text not null,
  first_name        text not null,
  last_name         text not null,
  -- TCKN: KVKK kapsamında özel nitelikli olmayan ama kimliği doğrudan belirleyen
  -- veri. Kiracı bazında tekil; hr.employee.read yetkisi olmayan hiç göremez.
  national_id       text,
  birth_date        date,
  gender            text check (gender in ('female', 'male', 'other')),
  email             text,
  phone             text,
  address           text,
  iban              text,
  department_id     uuid references hr.departments(id) on delete set null,
  position_id       uuid references hr.positions(id) on delete set null,
  manager_id        uuid references hr.employees(id) on delete set null,
  hire_date         date not null,
  termination_date  date,
  termination_reason text,
  -- SGK sicil numarası ve işten çıkış kodu (e-Bildirge kapsam dışı, saklanıyor)
  sgk_no            text,
  sgk_exit_code     text,
  is_active         boolean not null default true,
  owner_id          uuid references core.users(id),
  created_by        uuid references core.users(id),
  updated_by        uuid references core.users(id),
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now(),
  constraint ck_hr_employees_dates
    check (termination_date is null or termination_date >= hire_date)
);

create unique index if not exists ux_hr_employees_no on hr.employees (tenant_id, employee_no);
create unique index if not exists ux_hr_employees_national_id
  on hr.employees (tenant_id, national_id) where national_id is not null;
create index if not exists ix_hr_employees_department on hr.employees (tenant_id, department_id);
create index if not exists ix_hr_employees_manager on hr.employees (tenant_id, manager_id);
create index if not exists ix_hr_employees_user on hr.employees (tenant_id, user_id) where user_id is not null;
create index if not exists ix_hr_employees_name_trgm
  on hr.employees using gin ((first_name || ' ' || last_name) gin_trgm_ops);

alter table hr.departments drop constraint if exists fk_hr_departments_manager;
alter table hr.departments
  add constraint fk_hr_departments_manager
  foreign key (manager_id) references hr.employees(id) on delete set null;

-- -----------------------------------------------------------------------------
-- Sözleşmeler — ücret ve SGK parametreleri (ayrı yetki alanı)
-- -----------------------------------------------------------------------------
create table if not exists hr.employee_contracts (
  id                 uuid primary key default gen_random_uuid(),
  tenant_id          uuid not null references core.tenants(id) on delete cascade,
  branch_id          uuid references core.branches(id) on delete set null,
  employee_id        uuid not null references hr.employees(id) on delete cascade,
  valid_from         date not null,
  valid_to           date,
  employment_type    hr.employment_type not null default 'full_time',
  -- Ücret brüt mü net mi anlaşıldı? Net anlaşmada brüt geriye doğru çözülür.
  wage_basis         text not null default 'gross' check (wage_basis in ('gross', 'net')),
  wage_amount        numeric(18,4) not null default 0,
  wage_period        text not null default 'month' check (wage_period in ('month', 'day', 'hour')),
  currency           char(3) not null default 'TRY',
  weekly_hours       numeric(6,2) not null default 45,
  -- Bordro istisna/indirim girdileri (Bölüm 6: kod dışında parametre)
  sgk_discount_5510  boolean not null default true,   -- 5 puanlık işveren indirimi
  disability_degree  smallint check (disability_degree between 0 and 3),
  is_pensioner       boolean not null default false,  -- emekli: SGDP uygulanır
  is_exempt_from_stamp_tax boolean not null default false,
  annual_leave_entitlement_days smallint,             -- boşsa kıdemden hesaplanır
  notes              text,
  created_by         uuid references core.users(id),
  updated_by         uuid references core.users(id),
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now(),
  constraint ck_hr_contracts_dates check (valid_to is null or valid_to >= valid_from)
);

create index if not exists ix_hr_contracts_employee
  on hr.employee_contracts (tenant_id, employee_id, valid_from desc);

-- Bir çalışanın aynı anda iki yürürlükteki sözleşmesi olamaz.
-- daterange + exclusion constraint, uygulama kodunda unutulabilecek bir
-- kontrolü veritabanına taşır.
create extension if not exists btree_gist;
alter table hr.employee_contracts drop constraint if exists ex_hr_contracts_no_overlap;
alter table hr.employee_contracts
  add constraint ex_hr_contracts_no_overlap
  exclude using gist (
    employee_id with =,
    daterange(valid_from, valid_to, '[]') with &&
  );

-- -----------------------------------------------------------------------------
-- İzin tipleri ve bakiyeleri
-- -----------------------------------------------------------------------------
create table if not exists hr.leave_types (
  id                uuid primary key default gen_random_uuid(),
  tenant_id         uuid not null references core.tenants(id) on delete cascade,
  code              text not null,
  name              text not null,
  is_paid           boolean not null default true,
  -- Bakiyeden düşer mi? Mazeret/rapor izni genelde düşmez.
  consumes_balance  boolean not null default true,
  requires_approval boolean not null default true,
  -- Ücretsiz izin SGK gün sayısını düşürür (bordroda eksik gün)
  reduces_sgk_days  boolean not null default false,
  max_days_per_year smallint,
  is_active         boolean not null default true,
  created_by        uuid references core.users(id),
  updated_by        uuid references core.users(id),
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now()
);
create unique index if not exists ux_hr_leave_types_code on hr.leave_types (tenant_id, code);

create table if not exists hr.leave_balances (
  id             uuid primary key default gen_random_uuid(),
  tenant_id      uuid not null references core.tenants(id) on delete cascade,
  employee_id    uuid not null references hr.employees(id) on delete cascade,
  leave_type_id  uuid not null references hr.leave_types(id) on delete cascade,
  year           smallint not null,
  entitled_days  numeric(6,2) not null default 0,   -- hak edilen
  carried_days   numeric(6,2) not null default 0,   -- devreden
  used_days      numeric(6,2) not null default 0,   -- kullanılan (onaylı talepler)
  created_by     uuid references core.users(id),
  updated_by     uuid references core.users(id),
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now()
);
create unique index if not exists ux_hr_leave_balances
  on hr.leave_balances (tenant_id, employee_id, leave_type_id, year);

create table if not exists hr.leave_requests (
  id             uuid primary key default gen_random_uuid(),
  tenant_id      uuid not null references core.tenants(id) on delete cascade,
  branch_id      uuid references core.branches(id) on delete set null,
  employee_id    uuid not null references hr.employees(id) on delete cascade,
  leave_type_id  uuid not null references hr.leave_types(id),
  date_from      date not null,
  date_to        date not null,
  -- Yarım gün desteği için numeric; hesaplanır, elle girilmez.
  days           numeric(6,2) not null default 0,
  reason         text,
  status         hr.leave_status not null default 'draft',
  approver_id    uuid references core.users(id),
  approved_at    timestamptz,
  rejection_reason text,
  -- owner_id = talebi giren kullanıcı; çalışan kendi talebini `.own` ile görür
  owner_id       uuid references core.users(id),
  created_by     uuid references core.users(id),
  updated_by     uuid references core.users(id),
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now(),
  constraint ck_hr_leave_dates check (date_to >= date_from)
);

create index if not exists ix_hr_leave_requests_employee
  on hr.leave_requests (tenant_id, employee_id, date_from desc);
create index if not exists ix_hr_leave_requests_status
  on hr.leave_requests (tenant_id, status) where status = 'pending';

-- -----------------------------------------------------------------------------
-- Vardiyalar ve puantaj
-- -----------------------------------------------------------------------------
-- Vardiya tanımı esnek tutuldu: vardiyalı çalışan senaryosunda gece
-- vardiyası ertesi güne taşabildiği için bitiş saati başlangıçtan küçük olabilir.
create table if not exists hr.shifts (
  id             uuid primary key default gen_random_uuid(),
  tenant_id      uuid not null references core.tenants(id) on delete cascade,
  branch_id      uuid references core.branches(id) on delete cascade,
  code           text not null,
  name           text not null,
  start_time     time not null,
  end_time       time not null,
  break_minutes  smallint not null default 0,
  -- Gece vardiyası: 20:00-06:00 gibi. Süre hesabı gün aşımını dikkate alır.
  crosses_midnight boolean generated always as (end_time <= start_time) stored,
  is_active      boolean not null default true,
  created_by     uuid references core.users(id),
  updated_by     uuid references core.users(id),
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now()
);
create unique index if not exists ux_hr_shifts_code on hr.shifts (tenant_id, code);

create table if not exists hr.attendance (
  id               uuid primary key default gen_random_uuid(),
  tenant_id        uuid not null references core.tenants(id) on delete cascade,
  branch_id        uuid references core.branches(id) on delete set null,
  employee_id      uuid not null references hr.employees(id) on delete cascade,
  work_date        date not null,
  shift_id         uuid references hr.shifts(id) on delete set null,
  check_in         timestamptz,
  check_out        timestamptz,
  -- Trigger ile hesaplanır; elle de girilebilsin diye kolon (generated değil)
  worked_minutes   integer not null default 0,
  overtime_minutes integer not null default 0,
  -- Devamsızlık: izin varsa leave_request_id dolar, yoksa serbest metin
  leave_request_id uuid references hr.leave_requests(id) on delete set null,
  absence_code     text,
  note             text,
  created_by       uuid references core.users(id),
  updated_by       uuid references core.users(id),
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now(),
  constraint ck_hr_attendance_order check (check_out is null or check_in is null or check_out >= check_in)
);

create unique index if not exists ux_hr_attendance_day
  on hr.attendance (tenant_id, employee_id, work_date);
create index if not exists ix_hr_attendance_date
  on hr.attendance (tenant_id, work_date, branch_id);
