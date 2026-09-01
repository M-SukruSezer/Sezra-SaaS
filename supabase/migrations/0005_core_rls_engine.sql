-- =============================================================================
-- 0005 — RLS motoru: standart politika üreticisi
-- =============================================================================
-- Her modül tablosu için elle politika yazmak yerine tek bir üretici kullanıyoruz.
-- Böylece "yeni tablo eklendi ama RLS yazılmayı unutuldu" sınıfı hatalar
-- imkânsızlaşır (0009'daki koruma testi bunu ayrıca doğrular).
--
-- Üretilen politikalar üç katmanı birlikte uygular:
--   1. Kiracı izolasyonu : tenant_id = aktif kiracı
--   2. Şube kapsamı      : branch_id, kullanıcının erişebildiği şubelerde mi
--   3. Kayıt kuralı      : <varlık>.<eylem>.all  ya da  .own + owner_id eşleşmesi
-- =============================================================================

create or replace function core.apply_rls(
  p_schema     text,
  p_table      text,
  p_entity     text,                     -- izin kodu ön eki, ör. 'crm.lead'
  p_has_branch boolean default true,
  p_has_owner  boolean default true,
  p_soft_delete boolean default false
)
returns void
language plpgsql
as $fn$
declare
  v_tbl        text := format('%I.%I', p_schema, p_table);
  v_tenant     text := 'tenant_id = (select core.current_tenant_id())';
  v_branch     text := '';
  v_support    text := '(select core.is_support_session())';
  v_read       text;
  v_create     text;
  v_write      text;
  v_delete     text;
begin
  if p_has_branch then
    v_branch := ' and (branch_id is null or (select core.accessible_branch_ids()) @> array[branch_id])';
  end if;

  -- Kayıt kuralı ifadeleri
  if p_has_owner then
    v_read   := format('((select core.has_perm(%L)) or ((select core.has_perm(%L)) and owner_id = (select core.current_user_id())))',
                       p_entity || '.read.all',   p_entity || '.read.own');
    v_write  := format('((select core.has_perm(%L)) or ((select core.has_perm(%L)) and owner_id = (select core.current_user_id())))',
                       p_entity || '.write.all',  p_entity || '.write.own');
    v_delete := format('((select core.has_perm(%L)) or ((select core.has_perm(%L)) and owner_id = (select core.current_user_id())))',
                       p_entity || '.delete.all', p_entity || '.delete.own');
  else
    v_read   := format('(select core.has_perm(%L))', p_entity || '.read.all');
    v_write  := format('(select core.has_perm(%L))', p_entity || '.write.all');
    v_delete := format('(select core.has_perm(%L))', p_entity || '.delete.all');
  end if;
  v_create := format('(select core.has_perm(%L))', p_entity || '.create');

  execute format('alter table %s enable row level security', v_tbl);
  -- FORCE: tablo sahibi (migration rolü) için de RLS uygulanır. Bu olmadan
  -- postgres/owner bağlantısıyla yapılan sorgular izolasyonu atlar.
  execute format('alter table %s force row level security', v_tbl);

  execute format('drop policy if exists p_%s_select on %s', p_table, v_tbl);
  execute format(
    'create policy p_%s_select on %s for select using (%s or (%s%s and %s%s))',
    p_table, v_tbl, v_support, v_tenant, v_branch, v_read,
    case when p_soft_delete then ' and deleted_at is null' else '' end
  );

  execute format('drop policy if exists p_%s_insert on %s', p_table, v_tbl);
  execute format(
    'create policy p_%s_insert on %s for insert with check (%s or (%s%s and %s))',
    p_table, v_tbl, v_support, v_tenant, v_branch, v_create
  );

  execute format('drop policy if exists p_%s_update on %s', p_table, v_tbl);
  execute format(
    'create policy p_%s_update on %s for update using (%s or (%s%s and %s)) with check (%s or (%s%s and %s))',
    p_table, v_tbl, v_support, v_tenant, v_branch, v_write,
              v_support, v_tenant, v_branch, v_write
  );

  execute format('drop policy if exists p_%s_delete on %s', p_table, v_tbl);
  execute format(
    'create policy p_%s_delete on %s for delete using (%s or (%s%s and %s))',
    p_table, v_tbl, v_support, v_tenant, v_branch, v_delete
  );

  -- Kiracı bazlı sorgular her zaman tenant_id ile başlar: composite index şart (Bölüm 9)
  execute format('create index if not exists ix_%s_tenant on %s (tenant_id)', p_table, v_tbl);
  if p_has_branch then
    execute format('create index if not exists ix_%s_tenant_branch on %s (tenant_id, branch_id)', p_table, v_tbl);
  end if;
  if p_has_owner then
    execute format('create index if not exists ix_%s_tenant_owner on %s (tenant_id, owner_id)', p_table, v_tbl);
  end if;
end;
$fn$;

comment on function core.apply_rls(text,text,text,boolean,boolean,boolean) is
  'Bir modül tablosuna standart kiracı+şube+kayıt kuralı RLS politikalarını ve zorunlu indeksleri uygular.';

-- Tabloyu tek çağrıyla "kiracıya ait tablo" hâline getiren kısayol:
-- varsayılan tetikleyiciler + RLS + denetim izi birlikte.
create or replace function core.register_tenant_table(
  p_schema     text,
  p_table      text,
  p_entity     text,
  p_has_branch boolean default true,
  p_has_owner  boolean default true,
  p_soft_delete boolean default false,
  p_audit      boolean default true
)
returns void
language plpgsql
as $fn$
begin
  perform core.attach_updated_at(p_schema, p_table);
  perform core.attach_row_defaults(p_schema, p_table);
  perform core.apply_rls(p_schema, p_table, p_entity, p_has_branch, p_has_owner, p_soft_delete);
  if p_audit then
    perform core.attach_audit(p_schema, p_table);   -- 0007'de tanımlanır
  end if;
end;
$fn$;
