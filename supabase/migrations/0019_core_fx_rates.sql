-- =============================================================================
-- 0019 — TCMB döviz kurları
--
-- NEDEN GEÇMİŞ SAKLANIYOR, YALNIZCA SON KUR DEĞİL:
--   Durum çubuğu kurun yanında değişim yüzdesi gösteriyor. O yüzde ancak bir
--   önceki bültenle karşılaştırılarak hesaplanır; tek satır tutulsaydı
--   değişim uydurulmak zorunda kalırdı. Geçmiş ayrıca geriye dönük belge
--   değerlemesi için de doğru zemindir.
--
-- KİRACI TAŞIMAZ:
--   Kur bir piyasa verisidir, müşteri verisi değil. `tenant_id` verilseydi
--   her kiracı için aynı satır tekrar tekrar yazılırdı ve RLS motoru onu
--   kiracıya kapsardı; oysa aynı gün herkes için aynı kur geçerlidir.
--
-- YAZMA POLİTİKASI YOKTUR:
--   Kurları yalnızca sunucu, TCMB'den çekerek sistem bağlamında yazar
--   (owner rolü). Kullanıcı isteğiyle gelen bir veri buraya giremez —
--   kur girdisi kabul eden bir uç, faturaları etkileyen bir saldırı yüzeyidir.
-- =============================================================================

create table if not exists core.fx_rates (
  currency         char(3)       not null,
  -- TCMB'nin bülten tarihi; çekildiği an değil. Aynı bülten gün içinde
  -- birkaç kez çekilse de tek satır kalır.
  bulletin_date    date          not null,
  unit             integer       not null default 1,
  forex_buying     numeric(18,6),
  forex_selling    numeric(18,6),
  banknote_buying  numeric(18,6),
  banknote_selling numeric(18,6),
  bulletin_no      text,
  source           text          not null default 'TCMB',
  fetched_at       timestamptz   not null default now(),
  primary key (currency, bulletin_date)
);

create index if not exists ix_fx_rates_date on core.fx_rates (bulletin_date desc);

alter table core.fx_rates enable row level security;
alter table core.fx_rates force row level security;

-- Okuma serbest: kur herkese açık bir piyasa verisidir ve giriş ekranında,
-- yani kimlik doğrulanmadan önce de gösterilebilir.
drop policy if exists p_fx_rates_select on core.fx_rates;
create policy p_fx_rates_select on core.fx_rates
  for select using (true);

/**
 * Son kur ve bir önceki bültene göre değişim.
 *
 * Değişim yüzdesi BURADA hesaplanır: iki satırı istemciye taşıyıp orada
 * bölmek, aynı hesabın her ekranda tekrar yazılması demekti. Önceki bülten
 * yoksa `change_pct` NULL döner — sıfır DEĞİL. Sıfır "değişmedi" der ve bu,
 * "bilinmiyor"dan başka bir şeydir.
 */
create or replace function core.fx_snapshot(p_currencies text[])
returns table (
  currency      char(3),
  bulletin_date date,
  bulletin_no   text,
  unit          integer,
  forex_selling numeric,
  previous      numeric,
  change_pct    numeric,
  fetched_at    timestamptz
)
language sql
stable
security definer
set search_path = core, pg_temp
as $$
  with sirali as (
    select r.*,
           lag(r.forex_selling) over (partition by r.currency order by r.bulletin_date) as onceki,
           row_number() over (partition by r.currency order by r.bulletin_date desc)    as sira
    from core.fx_rates r
    where r.currency = any (p_currencies)
  )
  select s.currency, s.bulletin_date, s.bulletin_no, s.unit,
         s.forex_selling,
         s.onceki,
         case
           when s.onceki is null or s.onceki = 0 then null
           else round(((s.forex_selling - s.onceki) / s.onceki) * 100, 2)
         end,
         s.fetched_at
  from sirali s
  where s.sira = 1
  order by array_position(p_currencies, s.currency::text);
$$;

select core.apply_grants();
