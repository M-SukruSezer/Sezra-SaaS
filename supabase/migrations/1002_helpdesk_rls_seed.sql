-- =============================================================================
-- 1002 — Destek Masası: RLS, izinler, kiracı kurulumu
-- =============================================================================
select core.register_tenant_table('helpdesk', 'teams',        'helpdesk.team',   true,  false);
select core.register_tenant_table('helpdesk', 'sla_policies', 'helpdesk.sla',    false, false);
select core.register_tenant_table('helpdesk', 'tickets',      'helpdesk.ticket', true,  true);

-- Mesajlar yetkiyi biletten devralır
alter table helpdesk.messages enable row level security;
alter table helpdesk.messages force row level security;
drop policy if exists p_hd_messages_all on helpdesk.messages;
create policy p_hd_messages_all on helpdesk.messages for all
  using (exists (select 1 from helpdesk.tickets t where t.id = ticket_id))
  with check (exists (select 1 from helpdesk.tickets t where t.id = ticket_id));
create index if not exists ix_hd_messages_tenant on helpdesk.messages (tenant_id);
select core.attach_updated_at('helpdesk', 'messages');
select core.attach_row_defaults('helpdesk', 'messages');
select core.attach_audit('helpdesk', 'messages');

select core.declare_entity_permissions('helpdesk', 'team',   'Destek ekibi', false);
select core.declare_entity_permissions('helpdesk', 'sla',    'SLA politikası', false);
select core.declare_entity_permissions('helpdesk', 'ticket', 'Destek bileti');

select core.declare_permission('helpdesk.ticket.resolve', 'helpdesk', 'helpdesk.ticket',
       'approve', 'Bileti çöz');
select core.declare_permission('helpdesk.report.read', 'helpdesk', 'helpdesk.report',
       'read', 'Destek raporları ve SLA performansı');

select core.grant_module_to_role('tenant_admin', 'helpdesk');

select core.grant_to_role('branch_manager', array[
  'helpdesk.team.read.all','helpdesk.sla.read.all',
  'helpdesk.ticket.read.all','helpdesk.ticket.write.all','helpdesk.ticket.create',
  'helpdesk.ticket.resolve','helpdesk.report.read'
]);

-- Satış: müşterisiyle ilgili bileti açar ve izler; çözmek destek ekibinin işi.
select core.grant_to_role('sales', array[
  'helpdesk.ticket.read.all','helpdesk.ticket.create','helpdesk.ticket.write.own',
  'helpdesk.team.read.all'
]);

-- Çalışan (destek temsilcisi): kendisine atanan biletleri çözer.
select core.grant_to_role('employee', array[
  'helpdesk.team.read.all','helpdesk.sla.read.all',
  'helpdesk.ticket.read.all','helpdesk.ticket.write.all','helpdesk.ticket.create',
  'helpdesk.ticket.resolve'
]);

select core.grant_to_role('readonly', array['helpdesk.ticket.read.all']);

-- -----------------------------------------------------------------------------
-- Kurulum kancası
-- -----------------------------------------------------------------------------
create or replace function helpdesk.provision_helpdesk(p_tenant_id uuid)
returns void
language plpgsql
security definer
set search_path = helpdesk, core, pg_temp
as $$
declare v_team uuid;
begin
  insert into core.sequences (tenant_id, code, prefix, padding, period)
  values (p_tenant_id, 'helpdesk_ticket', 'DST-', 6, 'year')
  on conflict do nothing;

  insert into helpdesk.teams (tenant_id, code, name, description)
  values (p_tenant_id, 'GENEL', 'Genel Destek', 'Varsayılan destek ekibi')
  on conflict (tenant_id, code) do nothing
  returning id into v_team;

  -- Varsayılan SLA hedefleri. Rakamlar iş saatine göre değil TAKVİM DAKİKASINA
  -- göredir; iş takvimi desteği eklendiğinde politika tablosuna bir takvim
  -- referansı eklenir ve bu hedefler oradan çözülür.
  insert into helpdesk.sla_policies
    (tenant_id, code, name, priority, first_response_minutes, resolution_minutes)
  values
    (p_tenant_id, 'SLA-URGENT', 'Acil',   'urgent',   30,   240),
    (p_tenant_id, 'SLA-HIGH',   'Yüksek', 'high',    120,  1440),
    (p_tenant_id, 'SLA-NORMAL', 'Normal', 'normal',  480,  4320),
    (p_tenant_id, 'SLA-LOW',    'Düşük',  'low',    1440, 10080)
  on conflict (tenant_id, code) do nothing;
end;
$$;

select core.register_provisioner('helpdesk', 'helpdesk.provision_helpdesk', 75::smallint);
