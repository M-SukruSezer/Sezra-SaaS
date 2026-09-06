-- =============================================================================
-- 1003 — Destek Masası raporları
-- =============================================================================
create or replace view helpdesk.v_ticket_list
with (security_invoker = on) as
select
  t.id, t.tenant_id, t.branch_id, t.number, t.subject, t.status, t.priority, t.channel,
  t.partner_id, pa.name as partner_name, t.contact_name, t.contact_email,
  t.team_id, tm.name as team_name,
  t.assignee_id, u.full_name as assignee_name,
  t.created_at, t.first_response_at, t.resolved_at, t.closed_at,
  t.first_response_due, t.resolution_due,
  t.first_response_breached, t.resolution_breached,
  t.paused_minutes, t.satisfaction, t.resolution,
  b.name as branch_name, t.owner_id, t.tags,
  (select count(*) from helpdesk.messages m
    where m.ticket_id = t.id and not m.is_internal)                as message_count,
  -- İlk yanıt süresi (dakika) — en çok bakılan metrik
  case when t.first_response_at is not null
       then floor(extract(epoch from (t.first_response_at - t.created_at)) / 60)::integer
  end as first_response_minutes,
  -- Çözüm süresi, BEKLEME DÜŞÜLEREK
  case when t.resolved_at is not null
       then floor(extract(epoch from (t.resolved_at - t.created_at)) / 60)::integer
            - t.paused_minutes
  end as resolution_minutes,
  -- Açık biletlerde kalan süre; eksi = gecikmede
  case when t.status in ('new', 'open') and t.resolution_due is not null
       then floor(extract(epoch from (t.resolution_due - now())) / 60)::integer
  end as minutes_to_due
from helpdesk.tickets t
left join core.partners pa on pa.id = t.partner_id
left join helpdesk.teams tm on tm.id = t.team_id
left join core.users u on u.id = t.assignee_id
left join core.branches b on b.id = t.branch_id;

-- SLA performansı: hedefe uyum oranı ekibin karnesidir
create or replace view helpdesk.v_sla_performance
with (security_invoker = on) as
select
  t.tenant_id, t.team_id, tm.name as team_name, t.priority,
  count(*)                                                    as ticket_count,
  count(*) filter (where t.first_response_at is not null)     as responded_count,
  count(*) filter (where t.first_response_breached)           as fr_breach_count,
  count(*) filter (where t.resolution_breached)               as res_breach_count,
  round(count(*) filter (where not t.first_response_breached)::numeric
        / nullif(count(*), 0) * 100, 1)                       as fr_compliance_pct,
  round(count(*) filter (where not t.resolution_breached)::numeric
        / nullif(count(*), 0) * 100, 1)                       as res_compliance_pct,
  round(avg(extract(epoch from (t.first_response_at - t.created_at)) / 60)
        filter (where t.first_response_at is not null))       as avg_first_response_minutes,
  round(avg(extract(epoch from (t.resolved_at - t.created_at)) / 60 - t.paused_minutes)
        filter (where t.resolved_at is not null))             as avg_resolution_minutes,
  round(avg(t.satisfaction) filter (where t.satisfaction is not null), 2) as avg_satisfaction
from helpdesk.tickets t
left join helpdesk.teams tm on tm.id = t.team_id
group by t.tenant_id, t.team_id, tm.name, t.priority;

-- Temsilci yükü ve performansı
create or replace view helpdesk.v_agent_workload
with (security_invoker = on) as
select
  t.tenant_id, t.assignee_id, u.full_name as agent_name,
  count(*) filter (where t.status in ('new','open','pending_customer')) as open_count,
  count(*) filter (where t.status in ('resolved','closed'))             as closed_count,
  count(*) filter (where t.resolution_breached)                          as breach_count,
  round(avg(extract(epoch from (t.resolved_at - t.created_at)) / 60 - t.paused_minutes)
        filter (where t.resolved_at is not null))                        as avg_resolution_minutes,
  round(avg(t.satisfaction) filter (where t.satisfaction is not null), 2) as avg_satisfaction
from helpdesk.tickets t
join core.users u on u.id = t.assignee_id
group by t.tenant_id, t.assignee_id, u.full_name;

-- Müşteri bazlı destek yükü: hangi müşteri ne kadar destek tüketiyor
create or replace view helpdesk.v_partner_support
with (security_invoker = on) as
select
  t.tenant_id, t.partner_id, pa.name as partner_name,
  count(*)                                              as ticket_count,
  count(*) filter (where t.status not in ('closed','cancelled')) as open_count,
  count(*) filter (where t.priority in ('high','urgent'))        as high_priority_count,
  count(*) filter (where t.resolution_breached)                  as breach_count,
  round(avg(t.satisfaction) filter (where t.satisfaction is not null), 2) as avg_satisfaction,
  max(t.created_at)                                     as last_ticket_at
from helpdesk.tickets t
join core.partners pa on pa.id = t.partner_id
group by t.tenant_id, t.partner_id, pa.name;
