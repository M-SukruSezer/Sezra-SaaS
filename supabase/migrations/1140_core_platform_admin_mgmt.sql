-- =============================================================================
-- 1140 — Platform yoneticisi yonetimi (yetki yukseltme yuzeyi)
-- =============================================================================
-- BUGUNE KADAR `core.users.is_platform_admin` yalnizca elle SQL ile
-- degistirilebiliyordu. Bu dosya urun icinden yonetmeyi getirir: listele,
-- yukselt (grant), indir (revoke). Platformun EN TEHLIKELI yuzeyidir; o yuzden:
--
--   1. YETKI: yalnizca mevcut bir platform yoneticisi bayragi verebilir/alabilir.
--      Kontrol SQL'de: her fonksiyon ilk satirda core.platform_guard() cagirir
--      (42501 -> translatePgError -> 403). Uygulama katmani ikinci bir kapi
--      degil, yalnizca erken/anlasilir hata icindir. (0009'daki
--      fn_guard_platform_admin trigger'i da bayragi ayrica koruyor.)
--
--   2. DENETIM: her degisiklik core.audit_log'a yazilir -- kim (actor_id),
--      kime (entity_id + hedef e-posta), ne zaman (occurred_at), eski/yeni deger.
--      tenant_id NULL: bu bir platform olayi, kiraci olayi degil.
--
--   3. KILITLENME KURALI (iki katman, ikisi de SQL'de zorunlu):
--      R1 - Kimse KENDI platform yoneticiligini kaldiramaz. Indirme islemini
--           daima BASKA bir yonetici yapar. Bu tek basina "en az bir yonetici
--           kalir" garantisini verir: A ve B yoneticiyken A, B'yi indirebilir
--           ama sonra kendini indiremez; B artik yonetici olmadigi icin A'yi
--           indiremez -> her zaman >= 1 yonetici.
--      R2 - Ek olarak: bir kullanicidan bayragi almak, geriye SIFIR etkin
--           (disabled_at IS NULL) platform yoneticisi birakacaksa reddedilir.
--           Tek is parcacikli yolda R1 zaten yeter; R2 ESZAMANLI iki indirmenin
--           yaristigi durum icindir (A, B'yi indirirken B de A'yi indiriyor).
--           Bu yuzden kontrolden once yonetici satirlari FOR UPDATE ile kilitlenir
--           -> iki cagri seri hale gelir, ikincisi azalmis sayiyi gorur.
--
--   4. Devre disi (disabled_at) bir hesap platform yoneticisi YAPILAMAZ: uykuda
--      bir hesaba superadmin vermek tam da engellenmesi gereken sey.
-- =============================================================================
set client_min_messages = warning;

-- -----------------------------------------------------------------------------
-- Cekirdek islem: bir kullanicinin platform yoneticisi bayragini degistir
-- -----------------------------------------------------------------------------
create or replace function core.set_platform_admin(p_user_id uuid, p_enabled boolean)
returns void
language plpgsql
security definer
set search_path = core, pg_temp
as $$
declare
  v_actor    uuid := core.current_user_id();
  v_old      boolean;
  v_email    text;
  v_disabled timestamptz;
begin
  perform core.platform_guard();

  select is_platform_admin, email, disabled_at
    into v_old, v_email, v_disabled
    from core.users where id = p_user_id;
  if not found then
    raise exception 'Kullanici bulunamadi' using errcode = 'P0002';
  end if;

  -- Zaten istenen durumda: sessiz basari, denetim izine gurultu yazma.
  if v_old is not distinct from p_enabled then
    return;
  end if;

  if p_enabled then
    if v_disabled is not null then
      raise exception 'Devre disi bir hesap platform yoneticisi yapilamaz; once hesabi etkinlestirin'
        using errcode = '23514';
    end if;
  else
    -- R1: kendini indirme yasak.
    if p_user_id = v_actor then
      raise exception 'Kendi platform yoneticiliginizi kaldiramazsiniz; baska bir platform yoneticisi yapmali'
        using errcode = '42501';
    end if;
    -- R2: son etkin yoneticiyi birakma. Once yonetici satirlarini kilitle ki
    -- es zamanli iki indirme seri hale gelsin ve ikisi birden gecip sifir
    -- yonetici birakmasin.
    perform 1 from core.users
      where is_platform_admin and disabled_at is null
      for update;
    if (select count(*) from core.users
          where is_platform_admin and disabled_at is null and id <> p_user_id) = 0 then
      raise exception 'Platformda en az bir etkin platform yoneticisi kalmali'
        using errcode = '23514';
    end if;
  end if;

  update core.users
     set is_platform_admin = p_enabled, updated_at = now()
   where id = p_user_id;

  -- DENETIM: platform olayi (tenant_id NULL). platform_log tenant zorunlu
  -- kildigi icin dogrudan audit_log'a yaziyoruz; desen 0015 ile ayni.
  insert into core.audit_log (
    tenant_id, actor_id, action, entity_schema, entity_table,
    entity_id, changed_fields, old_data, new_data, support_session
  ) values (
    null, v_actor, 'update', 'core', 'users',
    p_user_id, array['is_platform_admin'],
    jsonb_build_object('is_platform_admin', v_old,      'email', v_email),
    jsonb_build_object('is_platform_admin', p_enabled,  'email', v_email),
    false
  );
end;
$$;

comment on function core.set_platform_admin(uuid, boolean) is
  'Bir kullanicinin is_platform_admin bayragini degistirir. Yalnizca platform '
  'yoneticisi cagirabilir; kendini indiremez; son etkin yoneticiyi birakamaz; '
  'devre disi hesabi yukseltemez. Degisiklik audit_log e yazilir.';

-- -----------------------------------------------------------------------------
-- E-posta ile yukseltme: operator bir uuid degil e-posta bilir
-- -----------------------------------------------------------------------------
create or replace function core.grant_platform_admin(p_email text)
returns uuid
language plpgsql
security definer
set search_path = core, pg_temp
as $$
declare v_id uuid;
begin
  perform core.platform_guard();

  select id into v_id from core.users
   where lower(email) = lower(btrim(p_email)) and disabled_at is null;
  if v_id is null then
    raise exception 'Etkin kullanici bulunamadi: %', p_email using errcode = 'P0002';
  end if;

  perform core.set_platform_admin(v_id, true);
  return v_id;
end;
$$;

comment on function core.grant_platform_admin(text) is
  'E-postayla bir kullaniciyi platform yoneticisi yapar. core.set_platform_admin uzerinden.';

-- -----------------------------------------------------------------------------
-- Listeleme: mevcut platform yoneticileri
-- -----------------------------------------------------------------------------
create or replace function core.list_platform_admins()
returns table (
  id           uuid,
  email        text,
  full_name    text,
  disabled_at  timestamptz,
  last_seen_at timestamptz,
  is_self      boolean
)
language plpgsql
stable
security definer
set search_path = core, pg_temp
as $$
begin
  perform core.platform_guard();
  return query
    select u.id, u.email, u.full_name, u.disabled_at, u.last_seen_at,
           (u.id = core.current_user_id()) as is_self
    from core.users u
    where u.is_platform_admin
    order by (u.disabled_at is not null), lower(u.email);
end;
$$;

comment on function core.list_platform_admins() is
  'is_platform_admin bayragi acik tum kullanicilar (devre disi olanlar dahil).';

-- -----------------------------------------------------------------------------
-- Denetim: son platform-yoneticisi degisiklikleri (ekran icin)
-- -----------------------------------------------------------------------------
create or replace function core.list_platform_admin_events(p_limit integer default 50)
returns table (
  occurred_at  timestamptz,
  actor_id     uuid,
  actor_name   text,
  actor_email  text,
  target_id    uuid,
  target_email text,
  granted      boolean
)
language plpgsql
stable
security definer
set search_path = core, pg_temp
as $$
begin
  perform core.platform_guard();
  return query
    select a.occurred_at, a.actor_id, act.full_name, act.email,
           a.entity_id,
           coalesce(a.new_data->>'email', a.old_data->>'email'),
           (a.new_data->>'is_platform_admin')::boolean
    from core.audit_log a
    left join core.users act on act.id = a.actor_id
    where a.entity_schema = 'core' and a.entity_table = 'users'
      and a.changed_fields @> array['is_platform_admin']
    order by a.occurred_at desc
    limit greatest(p_limit, 1);
end;
$$;

comment on function core.list_platform_admin_events(integer) is
  'Platform-yoneticisi bayrak degisikliklerinin denetim izi (en yeni once).';

select core.apply_grants();
