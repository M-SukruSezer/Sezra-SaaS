-- =============================================================================
-- 0010 — Modül/izin kayıt yardımcıları + çekirdek seed verisi
-- =============================================================================

-- -----------------------------------------------------------------------------
-- Modül kaydı
-- -----------------------------------------------------------------------------
create or replace function core.register_module(
  p_code text, p_name text, p_phase smallint default 1,
  p_depends text[] default '{}', p_is_core boolean default false,
  p_description text default null
)
returns void
language sql
as $$
  insert into core.modules (code, name, phase, depends_on, is_core, description)
  values (p_code, p_name, p_phase, p_depends, p_is_core, p_description)
  on conflict (code) do update
    set name = excluded.name, phase = excluded.phase,
        depends_on = excluded.depends_on, is_core = excluded.is_core,
        description = excluded.description;
$$;

-- Bir varlık için standart izin setini üretir:
--   <modül>.<varlık>.read.all / read.own / write.all / write.own /
--           create / delete.all / delete.own
create or replace function core.declare_entity_permissions(
  p_module text, p_entity text, p_label text default null,
  p_with_own boolean default true
)
returns void
language plpgsql
as $$
declare
  v_prefix text := p_module || '.' || p_entity;
  v_label  text := coalesce(p_label, p_entity);
begin
  insert into core.permissions (code, module_code, entity, action, scope, description) values
    (v_prefix || '.read.all',   p_module, v_prefix, 'read',   'all', v_label || ': tümünü görüntüle'),
    (v_prefix || '.write.all',  p_module, v_prefix, 'write',  'all', v_label || ': tümünü düzenle'),
    (v_prefix || '.create',     p_module, v_prefix, 'create', null,  v_label || ': oluştur'),
    (v_prefix || '.delete.all', p_module, v_prefix, 'delete', 'all', v_label || ': tümünü sil')
  on conflict (code) do update set description = excluded.description;

  if p_with_own then
    insert into core.permissions (code, module_code, entity, action, scope, description) values
      (v_prefix || '.read.own',   p_module, v_prefix, 'read',   'own', v_label || ': yalnızca kendi kayıtlarını görüntüle'),
      (v_prefix || '.write.own',  p_module, v_prefix, 'write',  'own', v_label || ': yalnızca kendi kayıtlarını düzenle'),
      (v_prefix || '.delete.own', p_module, v_prefix, 'delete', 'own', v_label || ': yalnızca kendi kayıtlarını sil')
    on conflict (code) do update set description = excluded.description;
  end if;
end;
$$;

create or replace function core.declare_permission(
  p_code text, p_module text, p_entity text, p_action text, p_description text
)
returns void
language sql
as $$
  insert into core.permissions (code, module_code, entity, action, scope, description)
  values (p_code, p_module, p_entity, p_action, null, p_description)
  on conflict (code) do update set description = excluded.description;
$$;

-- Sistem rolü tanımla / güncelle
create or replace function core.declare_system_role(
  p_code text, p_name text, p_rank smallint, p_description text default null
)
returns uuid
language plpgsql
as $$
declare v_id uuid;
begin
  insert into core.roles (tenant_id, code, name, description, is_system, rank)
  values (null, p_code, p_name, p_description, true, p_rank)
  on conflict (code) where tenant_id is null
  do update set name = excluded.name, description = excluded.description, rank = excluded.rank
  returning id into v_id;
  return v_id;
end;
$$;

-- Sistem rolüne izin ver (var olmayan izin kodu sessizce atlanmaz — hata verir)
create or replace function core.grant_to_role(p_role_code text, p_permissions text[])
returns void
language plpgsql
as $$
declare
  v_role_id uuid;
  v_missing text[];
begin
  select id into v_role_id from core.roles where tenant_id is null and code = p_role_code;
  if v_role_id is null then
    raise exception 'Sistem rolü bulunamadı: %', p_role_code;
  end if;

  select coalesce(array_agg(c), '{}') into v_missing
  from unnest(p_permissions) c
  where not exists (select 1 from core.permissions p where p.code = c);
  if v_missing <> '{}'::text[] then
    raise exception 'Tanımsız izin kodu: %', array_to_string(v_missing, ', ');
  end if;

  insert into core.role_permissions (role_id, permission_code)
  select v_role_id, c from unnest(p_permissions) c
  on conflict do nothing;
end;
$$;

-- Bir modülün TÜM izinlerini role ver (tenant_admin için pratik)
create or replace function core.grant_module_to_role(p_role_code text, p_module text)
returns void
language plpgsql
as $$
declare v_role_id uuid;
begin
  select id into v_role_id from core.roles where tenant_id is null and code = p_role_code;
  if v_role_id is null then
    raise exception 'Sistem rolü bulunamadı: %', p_role_code;
  end if;
  insert into core.role_permissions (role_id, permission_code)
  select v_role_id, p.code from core.permissions p
  where p.module_code = p_module and coalesce(p.scope, '') <> 'own'
  on conflict do nothing;
end;
$$;

-- =============================================================================
-- SEED
-- =============================================================================

-- Modüller
select core.register_module('core',       'Çekirdek',              1::smallint, '{}',                 true,
       'Kiracı, kullanıcı, yetki, cari, ürün, belge, denetim izi');
select core.register_module('crm',        'CRM & Satış',           1::smallint, '{core}',             false,
       'Müşteri kartları, satış hunisi, teklif-sipariş-fatura akışı');
select core.register_module('finance',    'Muhasebe & Finans',     1::smallint, '{core}',             false,
       'Tekdüzen hesap planı, yevmiye, KDV, fatura, P&L');
select core.register_module('hr',         'İnsan Kaynakları',      1::smallint, '{core}',             false,
       'Personel, izin, puantaj, bordro');
select core.register_module('purchasing', 'Satın Alma',            1::smallint, '{core,finance}',     false,
       'Tedarikçi, satın alma talebi, sipariş, mal kabul');

-- Çekirdek izinler
select core.declare_entity_permissions('core', 'partner',  'Cari hesap');
select core.declare_entity_permissions('core', 'product',  'Ürün',   false);
select core.declare_entity_permissions('core', 'uom',      'Birim',  false);
select core.declare_entity_permissions('core', 'tax',      'Vergi',  false);
select core.declare_entity_permissions('core', 'document', 'Belge');
select core.declare_entity_permissions('core', 'branch',   'Şube',   false);
select core.declare_entity_permissions('core', 'user',     'Kullanıcı', false);
select core.declare_entity_permissions('core', 'role',     'Rol',    false);
select core.declare_entity_permissions('core', 'tenant',   'Şirket ayarları', false);
select core.declare_permission('core.audit.read.all', 'core', 'core.audit', 'read', 'Denetim izini görüntüle');
select core.declare_permission('core.event.read.all', 'core', 'core.event', 'read', 'Olay kayıtlarını görüntüle');

-- Sistem rolleri (Bölüm 3.4 hiyerarşisi)
select core.declare_system_role('tenant_admin',   'Şirket Yöneticisi',   10::smallint, 'Kiracıdaki tüm modüllere tam erişim');
select core.declare_system_role('branch_manager', 'Şube Müdürü',         20::smallint, 'Yetkili olduğu şubelerin tüm verisi');
select core.declare_system_role('sales',          'Satış',               30::smallint, 'CRM ve satış belgeleri');
select core.declare_system_role('accounting',     'Muhasebe',            30::smallint, 'Muhasebe, fatura, raporlar');
select core.declare_system_role('hr_officer',     'İnsan Kaynakları',    30::smallint, 'Personel, izin, bordro');
select core.declare_system_role('warehouse',      'Depo / Satın Alma',   30::smallint, 'Satın alma ve mal kabul');
select core.declare_system_role('readonly',       'Salt Okunur',         90::smallint, 'Yalnızca görüntüleme');

-- Çekirdek izin dağıtımı
select core.grant_module_to_role('tenant_admin', 'core');

select core.grant_to_role('branch_manager', array[
  'core.partner.read.all','core.partner.write.all','core.partner.create',
  'core.product.read.all','core.uom.read.all','core.tax.read.all',
  'core.document.read.all','core.document.create','core.document.write.all',
  'core.branch.read.all','core.user.read.all','core.audit.read.all'
]);

select core.grant_to_role('sales', array[
  'core.partner.read.all','core.partner.write.own','core.partner.create','core.partner.read.own',
  'core.product.read.all','core.uom.read.all','core.tax.read.all',
  'core.document.read.own','core.document.create','core.branch.read.all'
]);

select core.grant_to_role('accounting', array[
  'core.partner.read.all','core.partner.write.all','core.partner.create',
  'core.product.read.all','core.uom.read.all','core.tax.read.all','core.tax.write.all','core.tax.create',
  'core.document.read.all','core.document.create','core.branch.read.all','core.audit.read.all'
]);

select core.grant_to_role('hr_officer', array[
  'core.partner.read.all','core.document.read.all','core.document.create','core.branch.read.all','core.user.read.all'
]);

select core.grant_to_role('warehouse', array[
  'core.partner.read.all','core.partner.create','core.partner.write.all',
  'core.product.read.all','core.product.write.all','core.product.create',
  'core.uom.read.all','core.tax.read.all','core.document.read.all','core.document.create','core.branch.read.all'
]);

select core.grant_to_role('readonly', array[
  'core.partner.read.all','core.product.read.all','core.uom.read.all',
  'core.tax.read.all','core.document.read.all','core.branch.read.all'
]);

-- Planlar (Bölüm 2 — rakamlar placeholder, Bölüm 11'de netleşecek)
insert into core.plans (code, name, monthly_price, included_users, included_branches,
                        extra_user_price, extra_branch_price, sort_order) values
  ('baslangic', 'Başlangıç',   1490.00, 3,  1,  290.00,  490.00, 10),
  ('buyume',    'Büyüme',      3490.00, 10, 3,  249.00,  390.00, 20),
  ('kurumsal',  'Kurumsal',    7990.00, 30, 10, 199.00,  290.00, 30)
on conflict (code) do update
  set name = excluded.name, monthly_price = excluded.monthly_price,
      included_users = excluded.included_users, included_branches = excluded.included_branches;

insert into core.plan_modules (plan_code, module_code) values
  ('baslangic', 'core'), ('baslangic', 'crm'), ('baslangic', 'finance'),
  ('buyume', 'core'), ('buyume', 'crm'), ('buyume', 'finance'), ('buyume', 'purchasing'),
  ('kurumsal', 'core'), ('kurumsal', 'crm'), ('kurumsal', 'finance'),
  ('kurumsal', 'purchasing'), ('kurumsal', 'hr')
on conflict do nothing;
