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

  foreach v_role in array v_roles loop
    foreach v_schema in array array['core', 'crm', 'finance', 'hr', 'purchasing'] loop
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

  -- Denetim izi hiç kimse tarafından değiştirilemez (RLS'e ek olarak tablo yetkisi de kapalı)
  foreach v_role in array v_roles loop
    execute format('revoke insert, update, delete on core.audit_log from %I', v_role);
    execute format('revoke insert, update, delete on core.events, core.event_deliveries from %I', v_role);
    execute format('revoke insert, update, delete on core.plans, core.modules, core.permissions, core.plan_modules from %I', v_role);
  end loop;
end;
$$;

select core.apply_grants();
