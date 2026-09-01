-- =============================================================================
-- 0102 — CRM kurulum kancası ve raporlar (Bölüm 4.1)
-- =============================================================================

create or replace function crm.provision_crm(p_tenant_id uuid)
returns void
language plpgsql
security definer
set search_path = crm, core, pg_temp
as $$
declare v_pipeline uuid;
begin
  insert into crm.pipelines (tenant_id, name, is_default)
  values (p_tenant_id, 'Satış Hunisi', true)
  returning id into v_pipeline;

  insert into crm.stages (tenant_id, pipeline_id, name, sequence, probability, is_won, is_lost) values
    (p_tenant_id, v_pipeline, 'Yeni',        10, 10,  false, false),
    (p_tenant_id, v_pipeline, 'İletişimde',  20, 30,  false, false),
    (p_tenant_id, v_pipeline, 'Teklif',      30, 60,  false, false),
    (p_tenant_id, v_pipeline, 'Kazanıldı',   40, 100, true,  false),
    (p_tenant_id, v_pipeline, 'Kaybedildi',  50, 0,   false, true);

  insert into crm.lost_reasons (tenant_id, name) values
    (p_tenant_id, 'Fiyat yüksek'),
    (p_tenant_id, 'Rakibe gitti'),
    (p_tenant_id, 'Bütçe yok'),
    (p_tenant_id, 'Zamanlama uygun değil'),
    (p_tenant_id, 'İletişim kurulamadı');

  insert into core.sequences (tenant_id, code, prefix, padding, period) values
    (p_tenant_id, 'crm_quotation',  'TKL-', 5, 'year'),
    (p_tenant_id, 'crm_sale_order', 'SIP-', 5, 'year')
  on conflict do nothing;
end;
$$;

select core.register_provisioner('crm', 'crm.provision_crm', 20::smallint);

-- =============================================================================
-- Raporlar
-- =============================================================================
-- security_invoker = on ZORUNLU: aksi hâlde view, sahibinin haklarıyla çalışır
-- ve RLS'i tamamen atlar — çok kiracılı bir sistemde bu doğrudan veri sızıntısıdır.

-- Temsilci bazlı performans
create or replace view crm.v_rep_performance
with (security_invoker = on) as
select
  l.tenant_id,
  l.branch_id,
  l.owner_id,
  u.full_name                                            as rep_name,
  date_trunc('month', l.created_at)::date                as period,
  count(*)                                               as lead_count,
  count(*) filter (where l.status = 'won')               as won_count,
  count(*) filter (where l.status = 'lost')              as lost_count,
  round(100.0 * count(*) filter (where l.status = 'won')
        / nullif(count(*) filter (where l.status in ('won','lost')), 0), 1) as win_rate_pct,
  sum(l.expected_revenue) filter (where l.status = 'won') as won_revenue,
  sum(l.expected_revenue) filter (where l.status = 'open') as pipeline_revenue
from crm.leads l
left join core.users u on u.id = l.owner_id
group by l.tenant_id, l.branch_id, l.owner_id, u.full_name, date_trunc('month', l.created_at);

-- Kayıp sebebi analizi
create or replace view crm.v_lost_reason_analysis
with (security_invoker = on) as
select
  l.tenant_id,
  l.branch_id,
  r.id                              as lost_reason_id,
  r.name                            as lost_reason,
  count(*)                          as lost_count,
  sum(l.expected_revenue)           as lost_revenue,
  round(100.0 * count(*) / nullif(sum(count(*)) over (partition by l.tenant_id, l.branch_id), 0), 1)
                                    as share_pct
from crm.leads l
join crm.lost_reasons r on r.id = l.lost_reason_id
where l.status = 'lost'
group by l.tenant_id, l.branch_id, r.id, r.name;

-- Huni özeti (kanban sütun başlıkları için)
create or replace view crm.v_pipeline_summary
with (security_invoker = on) as
select
  l.tenant_id,
  l.branch_id,
  s.pipeline_id,
  s.id                                        as stage_id,
  s.name                                      as stage_name,
  s.sequence,
  count(l.id)                                 as lead_count,
  coalesce(sum(l.expected_revenue), 0)        as total_revenue,
  coalesce(sum(l.expected_revenue * l.probability / 100.0), 0) as weighted_revenue
from crm.stages s
left join crm.leads l on l.stage_id = s.id and l.status = 'open'
group by l.tenant_id, l.branch_id, s.pipeline_id, s.id, s.name, s.sequence;

-- Gecikmiş aktiviteler (dashboard widget'ı)
create or replace view crm.v_overdue_activities
with (security_invoker = on) as
select a.tenant_id, a.branch_id, a.id, a.kind, a.subject, a.due_at,
       a.assigned_to, u.full_name as assignee_name,
       a.lead_id, l.name as lead_name,
       (current_date - a.due_at::date) as days_overdue
from crm.activities a
left join core.users u on u.id = a.assigned_to
left join crm.leads l on l.id = a.lead_id
where a.done_at is null and a.due_at < now();
