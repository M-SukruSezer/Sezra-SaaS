-- =============================================================================
-- 0802 — POS: RLS, izinler, kiracı kurulumu
-- =============================================================================
select core.register_tenant_table('pos', 'terminals', 'pos.terminal', true, false);
select core.register_tenant_table('pos', 'sessions',  'pos.session',  true, true);
select core.register_tenant_table('pos', 'orders',    'pos.order',    true, false);

do $$
declare v record;
begin
  for v in select * from (values
      ('cash_movements', 'sessions', 'session_id'),
      ('order_lines',    'orders',   'order_id'),
      ('payments',       'orders',   'order_id')
    ) as t(child, parent, fk)
  loop
    execute format('alter table pos.%I enable row level security', v.child);
    execute format('alter table pos.%I force row level security', v.child);
    execute format('drop policy if exists p_%s_all on pos.%I', v.child, v.child);
    execute format($p$create policy p_%1$s_all on pos.%1$I for all
        using (exists (select 1 from pos.%2$I h where h.id = %3$I))
        with check (exists (select 1 from pos.%2$I h where h.id = %3$I))$p$,
      v.child, v.parent, v.fk);
    execute format('create index if not exists ix_pos_%1$s_tenant on pos.%1$I (tenant_id)', v.child);
    perform core.attach_updated_at('pos', v.child);
    perform core.attach_row_defaults('pos', v.child);
    perform core.attach_audit('pos', v.child);
  end loop;
end $$;

-- -----------------------------------------------------------------------------
-- İzinler
-- -----------------------------------------------------------------------------
select core.declare_entity_permissions('pos', 'terminal', 'Kasa terminali', false);
select core.declare_entity_permissions('pos', 'session',  'Kasa oturumu');
select core.declare_entity_permissions('pos', 'order',    'Fiş', false);

select core.declare_permission('pos.session.close', 'pos', 'pos.session', 'approve',
       'Kasa kapat (Z raporu)');
select core.declare_permission('pos.order.refund',  'pos', 'pos.order', 'approve',
       'Fiş iadesi yap');
select core.declare_permission('pos.report.read',   'pos', 'pos.report', 'read',
       'Kasa ve satış raporları');
-- Kasa farkını görmek ayrı yetkidir: kasiyerin kendi açığını göremediği bir
-- sistemde fark, ancak müdür bakınca ortaya çıkar.
select core.declare_permission('pos.report.cash_variance', 'pos', 'pos.report', 'read',
       'Kasa fark (açık/fazla) raporunu görüntüle');

select core.grant_module_to_role('tenant_admin', 'pos');

-- Şube müdürü: kasayı açar, kapatır, iade yapar, farkı görür.
select core.grant_to_role('branch_manager', array[
  'pos.terminal.read.all','pos.terminal.write.all','pos.terminal.create',
  'pos.session.read.all','pos.session.write.all','pos.session.create','pos.session.close',
  'pos.order.read.all','pos.order.write.all','pos.order.create','pos.order.refund',
  'pos.report.read','pos.report.cash_variance'
]);

-- Kasiyer (çalışan öz servisi): fiş keser, kasa açar. KAPATAMAZ ve İADE YAPAMAZ —
-- ikisi de kasa açığını gizlemenin en kolay yollarıdır.
select core.grant_to_role('employee', array[
  'pos.terminal.read.all',
  'pos.session.read.all','pos.session.create','pos.session.write.all',
  'pos.order.read.all','pos.order.write.all','pos.order.create',
  'pos.report.read'
]);

select core.grant_to_role('accounting', array[
  'pos.session.read.all','pos.order.read.all','pos.terminal.read.all',
  'pos.report.read','pos.report.cash_variance'
]);

select core.grant_to_role('readonly', array['pos.session.read.all','pos.order.read.all']);

-- -----------------------------------------------------------------------------
-- Kurulum kancası
-- -----------------------------------------------------------------------------
create or replace function pos.provision_pos(p_tenant_id uuid)
returns void
language plpgsql
security definer
set search_path = pos, core, pg_temp
as $$
declare r record;
begin
  insert into core.sequences (tenant_id, code, prefix, padding, period) values
    (p_tenant_id, 'pos_session', 'KSA-', 6, 'year'),
    -- Fiş numarası GÜNLÜK değil yıllık seri; şube bazlı ayrışması için
    -- next_sequence şubeye özel satır bulunca onu kullanır.
    (p_tenant_id, 'pos_receipt', 'FIS-', 8, 'year')
  on conflict do nothing;

  -- Her şubeye bir kasa terminali
  for r in select id, code, name from core.branches
            where tenant_id = p_tenant_id and is_active
  loop
    insert into pos.terminals (tenant_id, branch_id, code, name)
    values (p_tenant_id, r.id, 'KASA-' || r.code, r.name || ' Kasa 1')
    on conflict (tenant_id, code) do nothing;
  end loop;
end;
$$;

select core.register_provisioner('pos', 'pos.provision_pos', 65::smallint);

-- Sonradan açılan şubeye de kasa (0502'deki envanter tetikleyicisiyle aynı kalıp)
create or replace function pos.fn_provision_branch()
returns trigger
language plpgsql
security definer
set search_path = pos, core, pg_temp
as $$
begin
  if not exists (select 1 from core.tenant_modules
                  where tenant_id = new.tenant_id and module_code = 'pos' and enabled) then
    return new;
  end if;
  insert into pos.terminals (tenant_id, branch_id, code, name)
  values (new.tenant_id, new.id, 'KASA-' || new.code, new.name || ' Kasa 1')
  on conflict (tenant_id, code) do nothing;
  return new;
end;
$$;

drop trigger if exists trg_branch_provision_pos on core.branches;
create trigger trg_branch_provision_pos after insert on core.branches
  for each row execute function pos.fn_provision_branch();
