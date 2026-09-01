import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { api } from '../api/client';
import { useItem } from '../ui/useResource';
import { Empty, ErrorBox, PageHead } from '../ui';
import { money, date } from '../i18n';
import { useSession } from '../api/session';
import type { Board } from '../api/types';

/**
 * Kanban tahtası.
 *
 * Sürükle-bırak yerine kartın üzerindeki aşama seçici kullanılıyor: dokunmatik
 * cihazlarda güvenilir çalışır ve klavyeyle erişilebilir. Sürükleme sonradan
 * bunun üzerine ilerletme olarak eklenebilir.
 */
export function LeadsBoard() {
  const { me, can } = useSession();
  const nav = useNavigate();
  const board = useItem<Board>('/crm/board');
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<unknown>(null);
  const currency = me?.tenant?.currency ?? 'TRY';

  const move = async (leadId: string, stageId: string) => {
    setBusy(leadId); setError(null);
    try {
      await api.post(`/crm/leads/${leadId}/stage`, { stage_id: stageId });
      await board.reload();
    } catch (err) { setError(err); } finally { setBusy(null); }
  };

  if (board.loading) return <p className="muted">Yükleniyor…</p>;
  if (!board.data) return <><ErrorBox error={board.error} /><Empty /></>;

  return (
    <>
      <PageHead
        title={board.data.pipeline.name}
        subtitle="Kartı taşımak için aşama seçin"
        actions={can('crm.lead.create')
          ? <button className="btn btn-primary" onClick={() => nav('/crm/leads/yeni')}>Yeni fırsat</button>
          : null}
      />
      <ErrorBox error={error} />

      <div className="board">
        {board.data.stages.map((stage) => (
          <div className="board-col" key={stage.id}>
            <div className="board-col-head">
              <div className="board-col-title">
                <span>{stage.name}</span>
                <span className="muted">{stage.leads.length}</span>
              </div>
              <div className="board-col-total">{money(stage.total_revenue, currency)}</div>
            </div>

            {stage.leads.map((lead) => (
              <article className="lead-card" key={lead.id}>
                <div className="lead-card-title" onClick={() => nav(`/crm/leads/${lead.id}`)}>
                  {lead.name}
                </div>
                <div className="lead-card-meta">
                  <span>{lead.partner_name ?? '—'}</span>
                  <span className="num">{money(lead.expected_revenue, lead.currency)}</span>
                </div>
                <div className="lead-card-meta" style={{ marginTop: 6 }}>
                  <span className="muted">{lead.owner_name ?? '—'}</span>
                  {Number(lead.overdue_activities) > 0 && (
                    <span className="badge badge-warn">{lead.overdue_activities} gecikmiş</span>
                  )}
                </div>
                <div className="lead-card-meta" style={{ marginTop: 6 }}>
                  <span className="muted">{date(lead.expected_close_date)}</span>
                  <span className="muted">%{lead.probability}</span>
                </div>
                <select
                  className="btn-sm" style={{ marginTop: 8, fontSize: 12 }}
                  value={stage.id} disabled={busy === lead.id}
                  onChange={(e) => void move(lead.id, e.target.value)}
                >
                  {board.data!.stages.map((s) => (
                    <option key={s.id} value={s.id}>{s.name}</option>
                  ))}
                </select>
              </article>
            ))}

            {stage.leads.length === 0 && (
              <div className="muted" style={{ padding: 12, fontSize: 12 }}>Boş</div>
            )}
          </div>
        ))}
      </div>
    </>
  );
}
