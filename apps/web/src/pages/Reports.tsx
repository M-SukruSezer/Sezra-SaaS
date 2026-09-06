import { useList } from '../ui/useResource';
import { Card, Empty, EmptyPage, ErrorBox, PageFoot, PageHead, Stat } from '../ui';
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

  // Baş rakam KAZANILAN CİRO: satış raporunun tek özet cümlesi. Kaçan ciro
  // hemen yanında durur çünkü ikisi birlikte okunmadan kazanma oranının ne
  // anlama geldiği belli olmaz.
  const kazanilan = reps.data.reduce((t, r) => t + Number(r.won_revenue || 0), 0);
  const huni      = reps.data.reduce((t, r) => t + Number(r.pipeline_revenue || 0), 0);
  const kacan     = lost.data.reduce((t, r) => t + Number(r.lost_revenue || 0), 0);
  const kazanildi = reps.data.reduce((t, r) => t + Number(r.won_count || 0), 0);
  const kaybedildi = reps.data.reduce((t, r) => t + Number(r.lost_count || 0), 0);
  const sonuclanan = kazanildi + kaybedildi;
  const oran = sonuclanan === 0 ? null : Math.round((kazanildi / sonuclanan) * 100);

  if (!(reps.loading || lost.loading) && reps.data.length === 0 && lost.data.length === 0) {
    return (
      <>
        <PageHead kicker="CRM" title="CRM Raporları"
                  subtitle="Temsilci performansı ve kayıp sebebi analizi." />
        <ErrorBox error={reps.error ?? lost.error} />
        <EmptyPage title="Rapor için yeterli veri yok">
          Raporlar kapanmış fırsatlardan beslenir. İlk fırsatlar kazanıldıkça
          ya da kaybedildikçe temsilci karnesi ve kayıp sebebi dağılımı burada
          oluşur.
        </EmptyPage>
      </>
    );
  }

  return (
    <>
      <PageHead kicker="CRM" title="CRM Raporları"
                subtitle="Temsilci performansı ve kayıp sebebi analizi." />
      <ErrorBox error={reps.error ?? lost.error} />

      <div className="grid grid-4">
        <Stat label="Kazanılan ciro" value={money(kazanilan, currency)}
              hint={`${kazanildi} kazanılan fırsat`} />
        <Stat label="Kaçan ciro" value={money(kacan, currency)}
              hint={kaybedildi === 0 ? 'Kaybedilen fırsat yok' : `${kaybedildi} kaybedilen fırsat`} />
        <Stat label="Kazanma oranı" value={oran === null ? '—' : `%${oran}`}
              hint={sonuclanan === 0 ? 'Sonuçlanan fırsat yok' : `${sonuclanan} sonuçlanan fırsat`} />
        <Stat label="Açık huni" value={money(huni, currency)}
              hint={`${reps.data.length} temsilci`} />
      </div>

      <div className="grid-sections">
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
            {!reps.loading && reps.data.length === 0 && (
              <Empty title="Veri yok">Bu kırılımda temsilci performansı oluşmamış.</Empty>
            )}
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
            {!lost.loading && lost.data.length === 0 && (
              <Empty title="Veri yok">Henüz kaybedilen fırsat kaydı yok.</Empty>
            )}
          </div>
        </Card>
      </div>

      <PageFoot>
        <span>Rakamlar yalnızca erişebildiğiniz şube ve kayıtları kapsar (RLS).</span>
        <span>Kayıp sebepleri kiracıya özel tanımlanır; dağılım kaçan ciroya göredir.</span>
      </PageFoot>
    </>
  );
}
