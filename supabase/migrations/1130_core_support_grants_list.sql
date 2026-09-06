-- =============================================================================
-- 1130 — Canli destek izinlerini listeleme kontrati
-- =============================================================================
-- 1100 core.support_grants tablosunu ve grant_support_access /
-- revoke_support_access fonksiyonlarini getirdi. Operatorun O AN hangi
-- yoneticinin hangi kiraciya erisimi oldugunu gorebilmesi gerekir; goremezse
-- izni denetlenebilir kilmanin anlami kalmaz.
--
-- Bu fonksiyon platform konsolu icindir: yetkiyi ILK SATIRDA platform_guard()
-- ile kontrol eder (0015'teki konsol fonksiyonlariyla ayni desen) ve yonetici
-- + kiraci adlarini birlestirerek dondurur.
-- =============================================================================
set client_min_messages = warning;

create or replace function core.list_support_grants(p_include_expired boolean default false)
returns table (
  id              uuid,
  admin_user_id   uuid,
  admin_name      text,
  admin_email     text,
  tenant_id       uuid,
  tenant_name     text,
  reason          text,
  granted_by      uuid,
  granted_by_name text,
  granted_at      timestamptz,
  expires_at      timestamptz,
  revoked_at      timestamptz,
  revoked_by      uuid,
  is_live         boolean
)
language plpgsql
stable
security definer
set search_path = core, pg_temp
as $$
begin
  perform core.platform_guard();

  return query
    select g.id, g.admin_user_id, a.full_name, a.email,
           g.tenant_id, t.name, g.reason,
           g.granted_by, gb.full_name, g.granted_at,
           g.expires_at, g.revoked_at, g.revoked_by,
           (g.revoked_at is null and g.expires_at > now()) as is_live
    from core.support_grants g
    join core.users   a  on a.id = g.admin_user_id
    join core.tenants t  on t.id = g.tenant_id
    left join core.users gb on gb.id = g.granted_by
    where p_include_expired
       or (g.revoked_at is null and g.expires_at > now())
    order by g.granted_at desc;
end;
$$;

comment on function core.list_support_grants(boolean) is
  'Platform konsolu: canli (varsayilan) ya da tum destek izinlerini yonetici/kiraci adlariyla listeler.';

select core.apply_grants();
