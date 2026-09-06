-- =============================================================================
-- 1101 — core.fx_rates: sistem bağlamı yazma politikası
-- =============================================================================
-- 0019 kur tablosunu "yazma politikası yok, yalnızca owner (BYPASSRLS) yazar"
-- diye tasarlamıştı. Artık withSystemContext ham owner bağlantısında kalmıyor:
-- DB_APP_ROLE ayarlıysa yetkisi daraltılmış role düşüyor ve `app.system_context`
-- GUC'sini 'on' yapıyor (withContext bunu ASLA yapmaz). Bu politika, TCMB kuru
-- çeken sunucu yolunun BYPASSRLS olmadan da yazabilmesini sağlar — kullanıcı
-- isteğinden gelen hiçbir yol bu GUC'yi taşımadığı için yüzey genişlemez.
-- =============================================================================

drop policy if exists p_fx_rates_system_insert on core.fx_rates;
create policy p_fx_rates_system_insert on core.fx_rates
  for insert
  with check (coalesce(nullif(current_setting('app.system_context', true), ''), 'off') = 'on');

drop policy if exists p_fx_rates_system_update on core.fx_rates;
create policy p_fx_rates_system_update on core.fx_rates
  for update
  using  (coalesce(nullif(current_setting('app.system_context', true), ''), 'off') = 'on')
  with check (coalesce(nullif(current_setting('app.system_context', true), ''), 'off') = 'on');
