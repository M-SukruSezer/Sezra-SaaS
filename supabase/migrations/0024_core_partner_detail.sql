-- =============================================================================
-- 0024 — Cari kartı: eksik alanlar, vergi no doğrulaması ve özet görünümü
--
-- Cari detay ekranı üç şeyi soruyor ve şemada karşılığı yoktu: sektör,
-- caride tanımlı iskonto oranı ve İYS pazarlama izinleri.
--
-- İYS İZNİ AYRI ALANLARDA: tek bir "pazarlama izni" bayrağı olsaydı, SMS
-- iznini veren ama e-posta istemeyen bir müşteriye e-posta gönderilirdi.
-- 6563 sayılı kanun izni KANAL BAZINDA arar; şema da öyle tutmalı.
--
-- CARİ ÖZET GÖRÜNÜMÜ BURADA DEĞİL: o görünüm finance.invoices'a bakıyor ve
-- core migration'ları finance'ten ÖNCE çalışıyor. Temiz bir veritabanında
-- "relation finance.invoices does not exist" ile düşüyordu; görünüm
-- 0205'e taşındı. Liste görünümü de burada kurulmaz: onun sahibi 0103 ve
-- iki yerde kurulan bir görünüm, kolon listesi ayrıştığı an çakışır.
-- =============================================================================
set client_min_messages = warning;

alter table core.partners
  add column if not exists sector           text,
  -- Teklif/sipariş/faturada satır iskontosunun varsayılanı.
  add column if not exists discount_pct     numeric(5,2)
    check (discount_pct is null or (discount_pct >= 0 and discount_pct <= 100)),
  add column if not exists consent_sms      boolean not null default false,
  add column if not exists consent_email    boolean not null default false,
  add column if not exists consent_whatsapp boolean not null default false,
  -- İzin ne zaman alındı: İYS denetiminde sorulan ilk şey budur.
  add column if not exists consent_at       timestamptz;

-- -----------------------------------------------------------------------------
-- Vergi numarası doğrulaması
-- -----------------------------------------------------------------------------
/**
 * VKN (10 hane) ve TCKN (11 hane) sağlama toplamı.
 *
 * NEDEN VERİTABANINDA: aynı kontrol arayüzde, içe aktarmada, e-Fatura
 * gönderiminde ve raporda ayrı ayrı yazılsaydı dördü de zamanla ayrışırdı.
 * Burada bir kez durur ve her yerden aynı cevabı verir.
 *
 * REDDETMEZ, İŞARETLER. Geçersiz bir vergi numarası kaydı engellemez: veri
 * çoğu zaman eski bir sistemden gelir ve kullanıcı onu düzeltene kadar
 * cariyle çalışmaya devam etmek zorundadır. Ekran "GEÇERSİZ" der, kapıyı
 * kapatmaz.
 *
 * NULL girdi NULL döner: "numara yok" ile "numara yanlış" farklı şeylerdir
 * ve ikisini aynı kırmızı rozetle göstermek yanlış olurdu.
 */
create or replace function core.tax_no_valid(p_tax_no text)
returns boolean
language plpgsql
immutable
as $$
declare
  v_t     text;
  d       integer[];
  i       integer;
  v_tmp   integer;
  v_deger integer;
  v_top   integer := 0;
  v_tek   integer := 0;
  v_cift  integer := 0;
begin
  v_t := regexp_replace(coalesce(p_tax_no, ''), '\s', '', 'g');
  if v_t = '' then return null; end if;
  if v_t !~ '^[0-9]+$' then return false; end if;

  d := array(select (substring(v_t from g for 1))::integer
             from generate_series(1, length(v_t)) g);

  -- ---- VKN: 10 hane -------------------------------------------------------
  if length(v_t) = 10 then
    for i in 1..9 loop
      v_tmp := (d[i] + (10 - i)) % 10;
      if v_tmp = 0 then
        v_deger := 0;
      else
        -- 2^(10-i) mod 9; sıfıra düşerse 9 sayılır.
        v_deger := (v_tmp * (2 ^ (10 - i))::bigint) % 9;
        if v_deger = 0 then v_deger := 9; end if;
      end if;
      v_top := v_top + v_deger;
    end loop;
    return d[10] = (10 - (v_top % 10)) % 10;
  end if;

  -- ---- TCKN: 11 hane ------------------------------------------------------
  if length(v_t) = 11 then
    if d[1] = 0 then return false; end if;
    v_tek  := d[1] + d[3] + d[5] + d[7] + d[9];
    v_cift := d[2] + d[4] + d[6] + d[8];
    if ((v_tek * 7) - v_cift) % 10 <> d[10] then return false; end if;
    v_top := 0;
    for i in 1..10 loop v_top := v_top + d[i]; end loop;
    return v_top % 10 = d[11];
  end if;

  -- Ne 10 ne 11 hane: geçersiz.
  return false;
end;
$$;

comment on function core.tax_no_valid(text) is
  'VKN/TCKN sağlama toplamı. NULL girdi NULL döner (numara yok), '
  'hatalı numara false. Kaydı engellemez, yalnızca işaretler.';
