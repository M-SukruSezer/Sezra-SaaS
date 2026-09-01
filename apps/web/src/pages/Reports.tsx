import { useList } from '../ui/useResource';
import { Card, Empty, ErrorBox, PageHead } from '../ui';
import { money, date } from '../i18n';
import { useSession } from '../api/session';

interface RepRow {
  owner_id: string; rep_name: string | null; period: string;
  lead_count: string; won_count: string; lost_count: string;
  win_rate_pct: string | null; won_revenue: string | null; pipeline_revenue: string | null;
}
interface LostRow { lost_reason_id: string; lost_reason: string; lost_count: string; lost_revenue: string; share_pct: string }

export function Reports() {
  const { me } = useSession();
  const currency = me?.tenant?.currency ?? 'TRY';
  const reps = useList<RepRow>('/crm/reports/rep-performance');
  const lost = useList<LostRow>('/crm/reports/lost-reasons');

  return (
    <>
      <PageHead title="CRM Raporları" subtitle="Yalnızca erişebildiğiniz şube ve kayıtlar" />
      <ErrorBox error={reps.error ?? lost.error} />

      <div className="grid" style={{ gap: 24 }}>
        <Card title="Temsilci performansı" padded={false}>
          <div className="tbl-wrap">
            <table className="tbl">
              <thead>
                <tr>
                  <th>Temsilci</th><th>Dönem</th>
                  <th className="r">Fırsat</th><th className="r">Kazanılan</th><th className="r">Kaybedilen</th>
                  <th className="r">Kazanma oranı</th><th className="r">Kazanılan ciro</th><th className="r">Açık huni</th>
                </tr>
              </thead>
              <tbody>
                {reps.data.map((r) => (
                  <tr key={`${r.owner_id}-${r.period}`}>
                    <td><strong>{r.rep_name ?? '—'}</strong></td>
                    <td>{date(r.period)}</td>
                    <td className="r">{r.lead_count}</td>
                    <td className="r">{r.won_count}</td>
                    <td className="r">{r.lost_count}</td>
                    <td className="r">{r.win_rate_pct ? `%${r.win_rate_pct}` : '—'}</td>
                    <td className="r">{money(r.won_revenue, currency)}</td>
                    <td className="r">{money(r.pipeline_revenue, currency)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            {!reps.loading && reps.data.length === 0 && <Empty />}
          </div>
        </Card>

        <Card title="Kayıp sebebi analizi" padded={false}>
          <div className="tbl-wrap">
            <table className="tbl">
              <thead>
                <tr><th>Sebep</th><th className="r">Adet</th><th className="r">Kaçan ciro</th><th className="r">Pay</th><th>Dağılım</th></tr>
              </thead>
              <tbody>
                {lost.data.map((r) => (
                  <tr key={r.lost_reason_id}>
                    <td><strong>{r.lost_reason}</strong></td>
                    <td className="r">{r.lost_count}</td>
                    <td className="r">{money(r.lost_revenue, currency)}</td>
                    <td className="r">%{r.share_pct}</td>
                    <td style={{ width: 160 }}>
                      <div style={{ background: 'var(--c-surface-2)', borderRadius: 999, height: 6 }}>
                        <div style={{
                          width: `${Math.min(Number(r.share_pct), 100)}%`, height: 6,
                          background: 'var(--c-brand)', borderRadius: 999,
                        }} />
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            {!lost.loading && lost.data.length === 0 && <Empty />}
          </div>
        </Card>
      </div>
    </>
  );
}
