-- =============================================================================
-- 0004 — Oturum bağlamı ve yetki fonksiyonları
-- =============================================================================
-- PERFORMANS NOTU (Bölüm 9):
-- Buradaki fonksiyonlar argümansız ve STABLE'dır. RLS politikalarında daima
-- `(select core.fn())` biçiminde sarmalanarak kullanılırlar; böylece PostgreSQL
-- bunları satır başına değil, sorgu başına BİR KEZ (InitPlan) çalıştırır.
-- Argüman alan bir can_select(entity, owner, branch) yardımcısı daha DRY
-- görünürdü ama satır başına fonksiyon çağrısı demek olurdu — bilinçli olarak
-- tercih edilmedi; DRY'lik bunun yerine politika ÜRETİCİSİNDE (0005) sağlanır.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- Kullanıcı kimliği — Supabase JWT, PostgREST claim'i veya düz GUC üzerinden
-- (sonuncusu, testlerin ve arka plan işlerinin auth şeması olmadan çalışması için)
-- -----------------------------------------------------------------------------
create or replace function core.current_user_id()
returns uuid
language plpgsql
stable
as $$
declare
  v_raw text;
begin
  v_raw := nullif(current_setting('request.jwt.claim.sub', true), '');
  if v_raw is null then
    begin
      v_raw := nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'sub';
    exception when others then
      v_raw := null;
    end;
  end if;
  if v_raw is null then
    v_raw := nullif(current_setting('app.user_id', true), '');
  end if;
  begin
    return v_raw::uuid;
  exception when others then
    return null;
  end;
end;
$$;

comment on function core.current_user_id() is
  'Oturumdaki kullanıcı id''si. Sırayla: JWT sub claim -> claims JSON -> app.user_id GUC.';

-- -----------------------------------------------------------------------------
-- Platform yöneticisi (Sezra) — kiracılar arası destek erişimi
-- -----------------------------------------------------------------------------
create or replace function core.is_platform_admin()
returns boolean
language sql
stable
security definer
set search_path = core, pg_temp
as $$
  select coalesce((select u.is_platform_admin
                   from core.users u
                   where u.id = core.current_user_id()
                     and u.disabled_at is null), false);
$$;

-- Destek oturumu: platform admini OLSANIZ BİLE kiracı verisi görmek için
-- `set local app.support_mode = 'on'` demeniz gerekir. Kazara kiracılar arası
-- veri sızmasını engeller ve bu oturumların audit_log'da işaretlenmesini sağlar.
create or replace function core.is_support_session()
returns boolean
language sql
stable
as $$
  select coalesce(nullif(current_setting('app.support_mode', true), ''), 'off') = 'on'
     and core.is_platform_admin();
$$;

-- Destek oturumunda ERİŞİLEN kiracı.
--
-- is_support_session() yalnızca "destek modundayım" der; hangi kiracıya
-- bakıldığını söylemez. Politikalarda koşulsuz baypas olarak kullanılırsa
-- platform yöneticisi TÜM kiracıların verisini birden görür: yanlışlıkla başka
-- müşterinin verisine bakmak mümkün olur ve denetim izi ziyareti tek bir
-- kiracıya atfedip yanıltır.
--
-- Bu fonksiyon seçilen kiracıyı döndürür; seçilmemişse ya da kiracı yoksa NULL
-- döner. Politikalarda `tenant_id = support_tenant_id()` biçiminde kullanılır,
-- yani NULL durumunda karşılaştırma false olur ve HİÇBİR ŞEY görünmez.
-- Güvenli varsayılan budur: destek erişimi bilinçli bir seçim gerektirir.
create or replace function core.support_tenant_id()
returns uuid
language plpgsql
stable
security definer
set search_path = core, pg_temp
as $$
declare v uuid;
begin
  if not core.is_support_session() then
    return null;
  end if;
  begin
    v := nullif(current_setting('app.tenant_id', true), '')::uuid;
  exception when others then
    return null;
  end;
  if v is null then
    return null;
  end if;
  if not exists (select 1 from core.tenants t where t.id = v and t.deleted_at is null) then
    return null;
  end if;
  return v;
end;
$$;

-- -----------------------------------------------------------------------------
-- Aktif kiracı
-- -----------------------------------------------------------------------------
-- app.tenant_id GUC'si istemciden gelir AMA asla güvenilmez: üyelik tablosuna
-- karşı doğrulanır. Doğrulanamazsa null döner ve tüm RLS politikaları kapanır.
create or replace function core.current_tenant_id()
returns uuid
language sql
stable
security definer
set search_path = core, pg_temp
as $$
  select m.tenant_id
  from core.memberships m
  join core.tenants t on t.id = m.tenant_id and t.deleted_at is null
  where m.user_id = core.current_user_id()
    and m.is_active
    and (
      nullif(current_setting('app.tenant_id', true), '') is null
      or m.tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid
    )
  order by m.is_default desc, m.joined_at
  limit 1;
$$;

create or replace function core.current_membership_id()
returns uuid
language sql
stable
security definer
set search_path = core, pg_temp
as $$
  select m.id
  from core.memberships m
  where m.user_id = core.current_user_id()
    and m.tenant_id = core.current_tenant_id()
    and m.is_active
  limit 1;
$$;

-- -----------------------------------------------------------------------------
-- Şube kapsamı
-- -----------------------------------------------------------------------------
-- KURAL: membership_branches boşsa -> kiracının tüm aktif şubeleri.
create or replace function core.accessible_branch_ids()
returns uuid[]
language sql
stable
security definer
set search_path = core, pg_temp
as $$
  select case
    when exists (select 1 from core.membership_branches mb
                 where mb.membership_id = core.current_membership_id())
    then (select coalesce(array_agg(mb.branch_id), '{}')
          from core.membership_branches mb
          where mb.membership_id = core.current_membership_id())
    else (select coalesce(array_agg(b.id), '{}')
          from core.branches b
          where b.tenant_id = core.current_tenant_id() and b.is_active)
  end;
$$;

-- -----------------------------------------------------------------------------
-- İzinler
-- -----------------------------------------------------------------------------
create or replace function core.permission_codes()
returns text[]
language sql
stable
security definer
set search_path = core, pg_temp
as $$
  select coalesce(array_agg(distinct rp.permission_code), '{}')
  from core.memberships m
  join core.membership_roles mr on mr.membership_id = m.id
  join core.role_permissions rp on rp.role_id = mr.role_id
  join core.permissions p on p.code = rp.permission_code
  join core.tenant_modules tm on tm.module_code = p.module_code
                            and tm.tenant_id = m.tenant_id
                            and tm.enabled
  where m.user_id = core.current_user_id()
    and m.tenant_id = core.current_tenant_id()
    and m.is_active;
$$;

comment on function core.permission_codes() is
  'Aktif kiracıdaki etkin izin kodları. Kiracıda modül kapalıysa o modülün izinleri hiç dönmez — modül aktivasyonu ile yetkilendirme tek noktada birleşir.';

create or replace function core.has_perm(p_code text)
returns boolean
language sql
stable
as $$
  select p_code = any (core.permission_codes());
$$;

create or replace function core.module_enabled(p_module text)
returns boolean
language sql
stable
security definer
set search_path = core, pg_temp
as $$
  select exists (
    select 1 from core.tenant_modules tm
    where tm.tenant_id = core.current_tenant_id()
      and tm.module_code = p_module
      and tm.enabled
  );
$$;

-- -----------------------------------------------------------------------------
-- Yazma işlemlerinde tenant / sahiplik / iz alanları varsayılanları
-- -----------------------------------------------------------------------------
create or replace function core.fn_set_row_defaults()
returns trigger
language plpgsql
as $$
declare
  v_row jsonb := to_jsonb(new);
  v_tenant uuid := core.current_tenant_id();
  v_user   uuid := core.current_user_id();
begin
  -- NOT: koşullar İÇ İÇE yazılmak zorunda. plpgsql bir SQL ifadesini bir bütün
  -- olarak derler; `v_row ? 'owner_id' and new.owner_id is null` yazarsak,
  -- owner_id kolonu olmayan tablolarda ifade daha çalıştırılmadan
  -- "record new has no field owner_id" hatası verir.
  if v_row ? 'tenant_id' then
    if new.tenant_id is null then
      new.tenant_id := v_tenant;
    end if;
  end if;

  -- Şube ataması: kullanıcının erişimi TEK şubeyle sınırlıysa, belirtilmeyen
  -- branch_id o şubeye atanır.
  --
  -- Neden gerekli: RLS politikası `branch_id is null` satırları şube kısıtından
  -- muaf tutar (tedarikçi, merkezî ürün gibi gerçekten kiracı geneli kayıtlar
  -- için doğru davranış). Ama Düzce'ye kilitli bir temsilci şubesiz bir fırsat
  -- açarsa, o fırsat kazara TÜM şubelere görünür hâle gelirdi. Varsayılanı
  -- burada doldurmak bu sızıntı yolunu kapatır.
  if tg_op = 'INSERT' and v_row ? 'branch_id' then
    if new.branch_id is null then
      select case when array_length(core.accessible_branch_ids(), 1) = 1
                  then (core.accessible_branch_ids())[1] end
        into new.branch_id;
    end if;
  end if;

  if tg_op = 'INSERT' then
    if v_row ? 'created_by' then
      if new.created_by is null then
        new.created_by := v_user;
      end if;
    end if;
    if v_row ? 'owner_id' then
      if new.owner_id is null then
        new.owner_id := v_user;
      end if;
    end if;
  end if;

  if v_row ? 'updated_by' then
    new.updated_by := v_user;
  end if;

  return new;
end;
$$;

-- TETİKLEYİCİ ADI `trg_00_` İLE BAŞLAR — bu bir süs değil, ZORUNLULUKTUR.
--
-- PostgreSQL, aynı olaydaki BEFORE tetikleyicilerini AD SIRASINA göre çalıştırır.
-- Bu tetikleyici tenant_id/owner_id/created_by alanlarını dolduruyor; modüllerin
-- kendi hesaplama tetikleyicileri ondan SONRA çalışmazsa `new.tenant_id` NULL
-- görürler ve sessizce yanlış hesap yaparlar (ör. kiracıya bağlı bir parametreyi
-- bulamayıp sıfır dönerler — hata vermeden).
--
-- `00` öneki, modül tetikleyicileri hangi adı alırsa alsın bu tetikleyicinin ilk
-- sırada kalmasını garanti eder.
create or replace function core.attach_row_defaults(p_schema text, p_table text)
returns void
language plpgsql
as $$
begin
  execute format(
    'drop trigger if exists trg_%1$s_row_defaults on %2$I.%1$I;
     drop trigger if exists trg_00_%1$s_row_defaults on %2$I.%1$I;
     create trigger trg_00_%1$s_row_defaults before insert or update on %2$I.%1$I
       for each row execute function core.fn_set_row_defaults();',
    p_table, p_schema
  );
end;
$$;
