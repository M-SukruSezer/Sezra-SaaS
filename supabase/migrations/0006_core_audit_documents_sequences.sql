-- =============================================================================
-- 0006 — Denetim izi, belge deposu, belge numaralandırma
-- =============================================================================

-- -----------------------------------------------------------------------------
-- Denetim izi (Bölüm 9) — fatura onayı, bordro tahakkuku, stok düzeltmesi vb.
-- -----------------------------------------------------------------------------
create table if not exists core.audit_log (
  id             bigint generated always as identity primary key,
  tenant_id      uuid,
  branch_id      uuid,
  actor_id       uuid,
  action         core.audit_action not null,
  entity_schema  text not null,
  entity_table   text not null,
  entity_id      uuid,
  changed_fields text[],                       -- UPDATE'te yalnızca değişen alan adları
  old_data       jsonb,
  new_data       jsonb,
  support_session boolean not null default false,
  occurred_at    timestamptz not null default now()
);

create index if not exists ix_audit_tenant_time on core.audit_log (tenant_id, occurred_at desc);
create index if not exists ix_audit_entity on core.audit_log (entity_schema, entity_table, entity_id);
create index if not exists ix_audit_actor on core.audit_log (tenant_id, actor_id, occurred_at desc);

-- Genel denetim trigger'ı — her kiracı tablosuna takılabilir.
create or replace function core.fn_audit()
returns trigger
language plpgsql
security definer
set search_path = core, pg_temp
as $$
declare
  v_old      jsonb;
  v_new      jsonb;
  v_changed  text[];
  v_id       uuid;
  v_tenant   uuid;
  v_branch   uuid;
  v_action   core.audit_action;
begin
  if tg_op = 'INSERT' then
    v_action := 'insert'; v_new := to_jsonb(new);
  elsif tg_op = 'UPDATE' then
    v_action := 'update'; v_old := to_jsonb(old); v_new := to_jsonb(new);
    select coalesce(array_agg(e.key), '{}'::text[]) into v_changed
    from jsonb_each(v_new) as e(key, value)
    where (v_old -> e.key) is distinct from e.value
      and e.key not in ('updated_at', 'updated_by');
    -- Yalnızca updated_at değiştiyse gürültü üretme
    if v_changed = '{}'::text[] then
      return null;
    end if;
  else
    v_action := 'delete'; v_old := to_jsonb(old);
  end if;

  v_id     := nullif(coalesce(v_new, v_old) ->> 'id', '')::uuid;
  v_tenant := nullif(coalesce(v_new, v_old) ->> 'tenant_id', '')::uuid;
  v_branch := nullif(coalesce(v_new, v_old) ->> 'branch_id', '')::uuid;

  insert into core.audit_log (
    tenant_id, branch_id, actor_id, action, entity_schema, entity_table,
    entity_id, changed_fields, old_data, new_data, support_session
  ) values (
    v_tenant, v_branch, core.current_user_id(), v_action, tg_table_schema, tg_table_name,
    v_id, v_changed, v_old, v_new, core.is_support_session()
  );
  return null;
end;
$$;

create or replace function core.attach_audit(p_schema text, p_table text)
returns void
language plpgsql
as $$
begin
  execute format(
    'drop trigger if exists trg_%1$s_audit on %2$I.%1$I;
     create trigger trg_%1$s_audit after insert or update or delete on %2$I.%1$I
       for each row execute function core.fn_audit();',
    p_table, p_schema
  );
end;
$$;

-- Denetim izi yalnızca okunur: hiç kimse UPDATE/DELETE yapamaz.
alter table core.audit_log enable row level security;
alter table core.audit_log force row level security;

drop policy if exists p_audit_log_select on core.audit_log;
create policy p_audit_log_select on core.audit_log for select
  using (
    (select core.is_support_session())
    or (tenant_id = (select core.current_tenant_id())
        and (select core.has_perm('core.audit.read.all')))
  );
-- INSERT yalnızca security definer trigger üzerinden; doğrudan insert politikası yok.

-- -----------------------------------------------------------------------------
-- Belge deposu — modüller arası ortak (Bölüm 7: documents)
-- -----------------------------------------------------------------------------
create table if not exists core.documents (
  id             uuid primary key default gen_random_uuid(),
  tenant_id      uuid not null references core.tenants(id) on delete cascade,
  branch_id      uuid references core.branches(id) on delete set null,
  related_module text not null,                  -- 'crm' | 'finance' | ...
  related_table  text not null,
  related_id     uuid,
  name           text not null,
  mime_type      text,
  size_bytes     bigint,
  storage_path   text not null,                  -- Supabase Storage nesne yolu
  checksum       text,
  owner_id       uuid references core.users(id),
  created_by     uuid references core.users(id),
  updated_by     uuid references core.users(id),
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now()
);

create index if not exists ix_documents_related
  on core.documents (tenant_id, related_module, related_table, related_id);

-- -----------------------------------------------------------------------------
-- Belge numaralandırma (fatura no, sipariş no, teklif no...)
-- -----------------------------------------------------------------------------
-- PostgreSQL SEQUENCE kullanmıyoruz: numaralar kiracı+şube+yıl bazlı ve
-- boşluksuz olmalı (mali mevzuat), bu da satır kilidi gerektirir.
create table if not exists core.sequences (
  id           uuid primary key default gen_random_uuid(),
  tenant_id    uuid not null references core.tenants(id) on delete cascade,
  branch_id    uuid references core.branches(id) on delete cascade,
  code         text not null,                    -- 'sale_order' | 'sale_invoice' | ...
  prefix       text not null default '',
  suffix       text not null default '',
  padding      smallint not null default 6,
  period       text not null default 'year'      -- 'year' | 'month' | 'never'
                 check (period in ('year', 'month', 'never')),
  period_key   text not null default '',         -- '2026' | '2026-09' | ''
  next_value   bigint not null default 1,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);

create unique index if not exists ux_sequences_scope
  on core.sequences (tenant_id, coalesce(branch_id, '00000000-0000-0000-0000-000000000000'::uuid), code);

create or replace function core.next_sequence(p_code text, p_branch_id uuid default null)
returns text
language plpgsql
security definer
set search_path = core, pg_temp
as $$
declare
  v_tenant     uuid := core.current_tenant_id();
  v_seq        core.sequences;
  v_period_key text;
  v_value      bigint;
begin
  if v_tenant is null then
    raise exception 'Aktif kiracı bulunamadı (core.next_sequence)' using errcode = '42501';
  end if;

  -- Önce şubeye özel seri aranır; yoksa kiracı geneli (branch_id is null) seriye
  -- düşülür. Böylece varsayılan davranış kiracı bazlı tek seridir; şube bazlı
  -- seri isteyen kiracı ilgili şube için satır ekleyerek bunu devreye alır.
  select * into v_seq
  from core.sequences s
  where s.tenant_id = v_tenant
    and s.code = p_code
    and (s.branch_id = p_branch_id or s.branch_id is null)
  order by (s.branch_id is null)
  limit 1
  for update;

  if not found then
    insert into core.sequences (tenant_id, branch_id, code, prefix)
    values (v_tenant, null, p_code, upper(left(p_code, 3)) || '-')
    returning * into v_seq;
  end if;

  v_period_key := case v_seq.period
    when 'year'  then to_char(now(), 'YYYY')
    when 'month' then to_char(now(), 'YYYY-MM')
    else ''
  end;

  if v_seq.period_key is distinct from v_period_key then
    v_value := 1;
  else
    v_value := v_seq.next_value;
  end if;

  update core.sequences
     set next_value = v_value + 1,
         period_key = v_period_key,
         updated_at = now()
   where id = v_seq.id;

  return v_seq.prefix
       || case when v_period_key = '' then '' else v_period_key || '-' end
       || lpad(v_value::text, v_seq.padding, '0')
       || v_seq.suffix;
end;
$$;

select core.attach_updated_at('core', 'documents');
select core.attach_updated_at('core', 'sequences');
