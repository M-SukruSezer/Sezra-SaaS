import { Link } from 'react-router-dom';
import { useItem, useList } from '../ui/useResource';
import { Card, Empty, ErrorBox, PageHead, Stat } from '../ui';
import { money } from '../i18n';
import { useSession } from '../api/session';
import type { Board } from '../api/types';

interface PipelineRow { stage_id: string; stage_name: string; lead_count: string; total_revenue: string; weighted_revenue: string }
interface OverdueRow { id: string; subject: string; lead_name: string | null; assignee_name: string | null; days_overdue: number }

export function Dashboard() {
  const { me } = useSession();
  const currency = me?.tenant?.currency ?? 'TRY';
  const board = useItem<Board>('/crm/board');
  const pipeline = useList<PipelineRow>('/crm/reports/pipeline');
  const overdue = useList<OverdueRow>('/crm/reports/overdue-activities');

  const openLeads = board.data?.stages.reduce((n, s) => n + s.leads.length, 0) ?? 0;
  const pipelineValue = board.data?.stages.reduce((n, s) => n + s.total_revenue, 0) ?? 0;
  const weighted = pipeline.data.reduce((n, r) => n + Number(r.weighted_revenue ?? 0), 0);

  return (
    <>
      <PageHead
        title={`Merhaba, ${me?.user.full_name?.split(' ')[0] ?? ''}`}
        subtitle={me?.tenant?.name}
      />
      <ErrorBox error={board.error ?? pipeline.error} />

      <div className="grid grid-4" style={{ marginBottom: 24 }}>
        <Stat label="Açık fırsat" value={openLeads} />
        <Stat label="Huni değeri" value={money(pipelineValue, currency)} />
        <Stat label="Ağırlıklı beklenti" value={money(weighted, currency)}
              hint="olasılıkla çarpılmış" />
        <Stat label="Gecikmiş aktivite" value={overdue.total || overdue.data.length} />
      </div>

      <div className="grid grid-2">
        <Card title="Satış hunisi" actions={<Link className="btn btn-sm" to="/crm/board">Tahtayı aç</Link>}>
          {pipeline.data.length === 0 ? <Empty /> : (
            <table className="tbl">
              <thead>
                <tr><th>Aşama</th><th className="r">Fırsat</th><th className="r">Değer</th></tr>
              </thead>
              <tbody>
                {pipeline.data.map((r) => (
                  <tr key={r.stage_id}>
                    <td>{r.stage_name}</td>
                    <td className="r">{r.lead_count}</td>
                    <td className="r">{money(r.total_revenue, currency)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </Card>

        <Card title="Gecikmiş aktiviteler">
          {overdue.data.length === 0 ? <Empty>Gecikmiş aktivite yok</Empty> : (
            <table className="tbl">
              <thead>
                <tr><th>Konu</th><th>Fırsat</th><th className="r">Gecikme</th></tr>
              </thead>
              <tbody>
                {overdue.data.slice(0, 8).map((a) => (
                  <tr key={a.id}>
                    <td>{a.subject}</td>
                    <td className="muted">{a.lead_name ?? '—'}</td>
                    <td className="r"><span className="badge badge-warn">{a.days_overdue} gün</span></td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </Card>
      </div>
    </>
  );
}
