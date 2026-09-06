-- =============================================================================
-- 0013 — Veritabanı rolleri ve yetkileri
-- =============================================================================
-- Kritik kural: uygulamanın bağlandığı rol, tabloların SAHİBİ OLMAMALI ve
-- BYPASSRLS taşımamalıdır. Aksi hâlde RLS bir güvenlik sınırı değil, süs olur.
--
--   sezra_owner  : şemayı kuran rol. BYPASSRLS gerekir (migration + provisioning).
--   sezra_app    : API katmanının bağlandığı rol. RLS'e tabidir.
--
-- Supabase'de bunların karşılığı sırasıyla `postgres` ve `authenticated`tır;
-- her iki ortamda da çalışması için aşağıda ikisi de ele alınıyor.
-- =============================================================================

do $$
begin
  if not exists (select 1 from pg_roles where rolname = 'sezra_app') then
    create role sezra_app nologin;
  end if;
end $$;

create or replace function core.apply_grants()
returns void
language plpgsql
as $$
declare
  v_schema text;
  v_role   text;
  v_roles  text[] := array['sezra_app'];
begin
  -- Supabase ortamındaysa `authenticated` rolüne de aynı yetkiler verilir
  if exists (select 1 from pg_roles where rolname = 'authenticated') then
    v_roles := v_roles || 'authenticated';
  end if;

  -- Şema listesi ELLE SAYILMAZ: core.modules'a kayıtlı her modülün kendi adıyla
  -- bir şeması varsa yetkiler ona da verilir. Elle liste tutulsaydı yeni bir
  -- modül eklendiğinde tabloları sessizce erişilemez kalırdı — ve bu, RLS
  -- hatası gibi görünen ama aslında yetki eksiği olan bir hata sınıfı üretirdi.
  foreach v_role in array v_roles loop
    for v_schema in
      select n.nspname
      from pg_namespace n
      where n.nspname = 'core'
         or n.nspname in (select code from core.modules)
      order by n.nspname
    loop
      execute format('grant usage on schema %I to %I', v_schema, v_role);
      execute format('grant select, insert, update, delete on all tables in schema %I to %I', v_schema, v_role);
      execute format('grant usage, select on all sequences in schema %I to %I', v_schema, v_role);
      execute format('grant execute on all functions in schema %I to %I', v_schema, v_role);
      -- Bundan sonra oluşturulacak nesneler için de aynı varsayılanlar
      execute format(
        'alter default privileges for role %I in schema %I grant select, insert, update, delete on tables to %I',
        current_user, v_schema, v_role);
      execute format(
        'alter default privileges for role %I in schema %I grant execute on functions to %I',
        current_user, v_schema, v_role);
    end loop;
  end loop;

  -- TÜRETİLMİŞ ve DENETİM tabloları uygulama rolünce yazılamaz.
  -- Bunlar RLS'e EK bir katmandır: RLS "hangi satırı" görebileceğini, buradaki
  -- yetki kısıtı "hiç yazamaz"ı söyler. Türetilmiş tabloların tek meşru yazma
  -- yolu security definer fonksiyonlardır (ör. inventory.adjust_quant) ve onlar
  -- sahip rolüyle çalıştığı için bu kısıttan etkilenmez.
  --
  -- Liste var olmayan tabloyu atlar: modüller farklı fazlarda ekleniyor ve
  -- apply_grants her migration turunda yeniden çalışıyor.
  foreach v_role in array v_roles loop
    foreach v_schema in array array[
      'core.audit_log', 'core.events', 'core.event_deliveries',
      'core.plans', 'core.modules', 'core.permissions', 'core.plan_modules',
      'inventory.quants', 'inventory.product_costs'
    ] loop
      if to_regclass(v_schema) is not null then
        execute format('revoke insert, update, delete on %s from %I', v_schema, v_role);
      end if;
    end loop;
  end loop;
end;
$$;

select core.apply_grants();
