import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { api } from '../api/client';
import { useItem } from '../ui/useResource';
import { EmptyPage, ErrorBox, PageFoot, PageHead, Stat } from '../ui';
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
  if (!board.data) {
    return (
      <>
        <PageHead kicker="CRM" title="Satış Hattı" subtitle="Aşamalara göre açık fırsatlar." />
        <ErrorBox error={board.error} />
        <EmptyPage title="Hat yüklenemedi">
          Varsayılan satış hattı bulunamadı. CRM modülü sağlandığında aşamalar
          kiracıya kendiliğinden kurulur.
        </EmptyPage>
      </>
    );
  }

  const yeniButon = can('crm.lead.create')
    ? <button className="btn btn-primary" onClick={() => nav('/crm/leads/yeni')}>Yeni fırsat</button>
    : null;

  // Baş rakam AĞIRLIKLI TAHMİNdir: her fırsatın beklenen cirosu kendi
  // olasılığıyla çarpılır. Ham hat toplamı her zaman iyimserdir; satış
  // toplantısında konuşulan sayı ağırlıklı olandır.
  const tumFirsatlar = board.data.stages.flatMap((st) => st.leads);
  const hatToplami = board.data.stages.reduce((t, st) => t + Number(st.total_revenue || 0), 0);
  const agirlikli = tumFirsatlar.reduce(
    (t, l) => t + Number(l.expected_revenue || 0) * (Number(l.probability || 0) / 100), 0);
  const gecikmis = tumFirsatlar.reduce((t, l) => t + Number(l.overdue_activities || 0), 0);
  const doluAsama = board.data.stages.filter((st) => st.leads.length > 0).length;

  if (tumFirsatlar.length === 0) {
    return (
      <>
        <PageHead kicker="CRM" title={board.data.pipeline.name}
                  subtitle="Aşamalara göre açık fırsatlar." actions={yeniButon} />
        <ErrorBox error={error} />
        <EmptyPage title="Hatta açık fırsat yok" action={yeniButon}>
          Satış hattı, açık fırsatları aşamalarına göre gösterir. İlk fırsatı
          açtığınızda kartı buraya düşer; kartın üzerindeki aşama seçiciyle
          ilerletirsiniz ve her aşamanın toplam değeri başlığında görünür.
        </EmptyPage>
      </>
    );
  }

  return (
    <>
      <PageHead
        kicker="CRM"
        title={board.data.pipeline.name}
        subtitle="Kartı taşımak için aşama seçin."
        actions={yeniButon}
      />
      <ErrorBox error={error} />

      <div className="grid grid-4">
        <Stat label="Ağırlıklı tahmin" value={money(agirlikli, currency)}
              hint="Beklenen ciro × olasılık" />
        <Stat label="Hat toplamı" value={money(hatToplami, currency)}
              hint={`${tumFirsatlar.length} açık fırsat`} />
        <Stat label="Gecikmiş aktivite" value={gecikmis}
              hint={gecikmis === 0 ? 'Gecikmiş takip yok' : 'Takip araması bekliyor'} />
        <Stat label="Dolu aşama" value={`${doluAsama} / ${board.data.stages.length}`}
              hint={doluAsama < board.data.stages.length ? 'Bazı aşamalar boş' : 'Tüm aşamalarda fırsat var'} />
      </div>

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
              <div className="muted micro board-col-empty">Bu aşamada fırsat yok</div>
            )}
          </div>
        ))}
      </div>

      <PageFoot>
        <span><strong>{tumFirsatlar.length}</strong> açık fırsat, <strong>{board.data.stages.length}</strong> aşamada</span>
        <span>Ağırlıklı tahmin <strong>{money(agirlikli, currency)}</strong></span>
        <span>Aşama değiştiğinde olasılık da aşamanın varsayılanına çekilir.</span>
      </PageFoot>
    </>
  );
}
