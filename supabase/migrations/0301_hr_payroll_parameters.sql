-- =============================================================================
-- 0301 — Bordro mevzuat parametreleri  (Bölüm 6)
-- =============================================================================
-- Bu dosya, bordro modülünün en riskli kısmını izole eder: mevzuat her yıl
-- (bazen yıl içinde) değişir. Kural şudur: HESAPLAMA MANTIĞI koda, SAYILAR
-- veritabanına yazılır. 2027 asgari ücreti açıklandığında yeni bir parametre
-- seti satırı eklenir — tek satır SQL, sıfır dağıtım.
--
-- Bir "parametre seti" belirli bir tarih aralığında yürürlükteki mevzuattır.
-- tenant_id NULL olan setler platform genelidir; kiracı kendi setini tanımlarsa
-- (özel muafiyet, farklı toplu sözleşme) o öncelik kazanır.
--
-- AGİ HAKKINDA NOT: Bölüm 4.3 "asgari geçim indirimi (AGİ)" diyor. AGİ 2022
-- başında kaldırıldı; yerine ASGARİ ÜCRET İSTİSNASI geldi — asgari ücrete denk
-- gelen kısım gelir ve damga vergisinden istisna tutuluyor. Motor bu istisnayı
-- uyguluyor. AGİ'yi yeniden yürürlüğe koyan bir düzenleme olursa `agi_enabled`
-- parametresi ve hr.agi_rates tablosu yeri hazır duruyor.
-- =============================================================================

create table if not exists hr.payroll_parameter_sets (
  id          uuid primary key default gen_random_uuid(),
  -- NULL = platform geneli (Sezra'nın bakımını üstlendiği mevzuat verisi)
  tenant_id   uuid references core.tenants(id) on delete cascade,
  code        text not null,                    -- 'TR-2025', 'TR-2025-H2'
  name        text not null,
  valid_from  date not null,
  valid_to    date,                             -- NULL = açık uçlu
  country_code char(2) not null default 'TR',
  -- Sayılar Resmî Gazete'den teyit edildi mi? Edilmediyse motor hesaplamayı
  -- yapar ama bordroyu ONAYLATMAZ (bkz. hr.approve_payroll_run).
  is_verified boolean not null default false,
  source      text,                             -- 'Resmî Gazete 30.12.2024 / 32768'
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  constraint ck_hr_param_sets_dates check (valid_to is null or valid_to >= valid_from)
);

create unique index if not exists ux_hr_param_sets_code
  on hr.payroll_parameter_sets (coalesce(tenant_id, '00000000-0000-0000-0000-000000000000'::uuid), code);
create index if not exists ix_hr_param_sets_period
  on hr.payroll_parameter_sets (country_code, valid_from desc);

create table if not exists hr.payroll_parameters (
  set_id      uuid not null references hr.payroll_parameter_sets(id) on delete cascade,
  code        text not null,
  value       numeric(18,6) not null,
  unit        text not null default 'ratio' check (unit in ('ratio', 'amount', 'days', 'count', 'flag')),
  description text,
  primary key (set_id, code)
);

-- Gelir vergisi dilimleri (kümülatif matrah üzerinden)
create table if not exists hr.income_tax_brackets (
  set_id      uuid not null references hr.payroll_parameter_sets(id) on delete cascade,
  seq         smallint not null,
  -- NULL = üst sınırsız (son dilim)
  upper_limit numeric(18,2),
  rate        numeric(6,4) not null,
  primary key (set_id, seq)
);

-- -----------------------------------------------------------------------------
-- Parametre çözümleme
-- -----------------------------------------------------------------------------
-- Verilen tarihte geçerli seti bulur: önce kiracıya özel, yoksa platform geneli.
create or replace function hr.resolve_parameter_set(p_date date, p_tenant_id uuid default null)
returns uuid
language sql
stable
security definer
set search_path = hr, core, pg_temp
as $$
  select s.id
  from hr.payroll_parameter_sets s
  where s.valid_from <= p_date
    and (s.valid_to is null or s.valid_to >= p_date)
    and (s.tenant_id = coalesce(p_tenant_id, core.current_tenant_id()) or s.tenant_id is null)
  order by (s.tenant_id is not null) desc, s.valid_from desc
  limit 1;
$$;

-- Parametreyi okur. YOKSA HATA VERİR — eksik parametreyle hesaplama yapmak,
-- yanlış bordro üretmenin en sessiz yoludur.
create or replace function hr.param(p_set_id uuid, p_code text)
returns numeric
language plpgsql
stable
security definer
set search_path = hr, pg_temp
as $$
declare v numeric;
begin
  select value into v from hr.payroll_parameters where set_id = p_set_id and code = p_code;
  if v is null then
    raise exception 'Bordro parametresi tanımsız: % (set %)', p_code, p_set_id
      using errcode = '22023',
            hint = 'hr.payroll_parameters tablosuna ilgili dönem için değeri ekleyin.';
  end if;
  return v;
end;
$$;

create or replace function hr.param_or(p_set_id uuid, p_code text, p_default numeric)
returns numeric
language sql
stable
security definer
set search_path = hr, pg_temp
as $$
  select coalesce((select value from hr.payroll_parameters where set_id = p_set_id and code = p_code),
                  p_default);
$$;

-- -----------------------------------------------------------------------------
-- Platform geneli seed: Türkiye 2025
-- -----------------------------------------------------------------------------
-- UYARI: ORANLAR kanuni ve yıllar içinde sabittir (SGK %14, işsizlik %1, damga
--   ‰7,59 gibi). TUTARLAR ve VERGİ DİLİMLERİ her yıl değişir ve aşağıdakiler
--   TEYİT EDİLMEMİŞ olarak işaretlidir: is_verified = false.
--   Bir bordro dönemi doğrulanmamış sete denk gelirse hesaplanır ama
--   onaylanamaz. Üretime çıkmadan önce Resmî Gazete'den teyit edip
--   is_verified = true yapın.
do $$
declare v_set uuid;
begin
  insert into hr.payroll_parameter_sets (tenant_id, code, name, valid_from, valid_to, is_verified, source)
  values (null, 'TR-2025', 'Türkiye 2025 bordro parametreleri',
          date '2025-01-01', date '2025-12-31', false,
          'TEYİT BEKLİYOR — tutarlar ve vergi dilimleri Resmî Gazete ile karşılaştırılmalı')
  on conflict (coalesce(tenant_id, '00000000-0000-0000-0000-000000000000'::uuid), code)
  do update set name = excluded.name
  returning id into v_set;

  insert into hr.payroll_parameters (set_id, code, value, unit, description) values
    -- Tutarlar (yıllık değişir)
    (v_set, 'minimum_wage_gross_monthly',   26005.50, 'amount', 'Aylık brüt asgari ücret'),
    (v_set, 'sgk_base_ceiling_multiplier',       7.5, 'count',  'SGK matrah tavanı = asgari ücret × bu katsayı'),
    -- Kanuni oranlar (istikrarlı)
    (v_set, 'sgk_employee_rate',              0.1400, 'ratio',  'SGK işçi payı'),
    (v_set, 'unemployment_employee_rate',     0.0100, 'ratio',  'İşsizlik sigortası işçi payı'),
    (v_set, 'sgk_employer_rate',              0.2075, 'ratio',  'SGK işveren payı (indirimsiz)'),
    (v_set, 'sgk_employer_discount_rate',     0.0500, 'ratio',  '5510 sayılı kanun 5 puanlık işveren indirimi'),
    (v_set, 'unemployment_employer_rate',     0.0200, 'ratio',  'İşsizlik sigortası işveren payı'),
    (v_set, 'stamp_tax_rate',                 0.00759,'ratio',  'Damga vergisi oranı (binde 7,59)'),
    -- Emekli çalışan (sosyal güvenlik destek primi)
    (v_set, 'sgdp_employee_rate',             0.0750, 'ratio',  'SGDP işçi payı'),
    (v_set, 'sgdp_employer_rate',             0.2450, 'ratio',  'SGDP işveren payı'),
    -- Gün ve istisna kuralları
    (v_set, 'payroll_days_per_month',           30.0, 'days',   'Bordro ay gün sayısı (takvimden bağımsız)'),
    (v_set, 'minimum_wage_exemption_enabled',      1, 'flag',   'Asgari ücret gelir+damga vergisi istisnası'),
    (v_set, 'agi_enabled',                         0, 'flag',   'AGİ (2022''de kaldırıldı; yeniden gelirse 1 yapın)')
  on conflict (set_id, code) do update set value = excluded.value, description = excluded.description;

  insert into hr.income_tax_brackets (set_id, seq, upper_limit, rate) values
    (v_set, 1,   158000.00, 0.15),
    (v_set, 2,   330000.00, 0.20),
    (v_set, 3,  1200000.00, 0.27),
    (v_set, 4,  4300000.00, 0.35),
    (v_set, 5,        null, 0.40)
  on conflict (set_id, seq) do update set upper_limit = excluded.upper_limit, rate = excluded.rate;
end $$;

select core.attach_updated_at('hr', 'payroll_parameter_sets');
