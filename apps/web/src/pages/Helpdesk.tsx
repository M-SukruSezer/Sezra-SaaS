import { useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { api } from '../api/client';
import { useItem, useList } from '../ui/useResource';
import { Card, Empty, ErrorBox, Field, PageFoot, PageHead, Stat } from '../ui';
import { Inbox, MessageSquare, Star, Timer, Users } from 'lucide-react';
import { ResourceList, type Kolon } from '../ui/ResourceList';
import { kolonAd, kolonBelgeNo, kolonGecen, kolonSayi } from '../ui/kolonlar';
import { date, num } from '../i18n';
import { useSession } from '../api/session';

interface Ticket {
  id: string; number?: string; subject: string; status: string; priority: string;
  channel: string; partner_name?: string; contact_name?: string;
  team_name?: string; assignee_name?: string;
  created_at: string; first_response_at?: string; resolved_at?: string;
  resolution_due?: string; first_response_breached: boolean; resolution_breached: boolean;
  paused_minutes: number; satisfaction?: number; resolution?: string;
  message_count: number; first_response_minutes?: number;
  resolution_minutes?: number; minutes_to_due?: number;
}

interface Message {
  id: string; author_full_name?: string; author_name?: string;
  is_internal: boolean; is_from_customer: boolean; body: string; created_at: string;
}

const STATUS: Record<string, { label: string; tone: string }> = {
  new: { label: 'Yeni', tone: 'badge-info' },
  open: { label: 'Açık', tone: 'badge-warn' },
  pending_customer: { label: 'Müşteri bekleniyor', tone: '' },
  resolved: { label: 'Çözüldü', tone: 'badge-ok' },
  closed: { label: 'Kapandı', tone: 'badge-ok' },
  cancelled: { label: 'İptal', tone: '' },
};
const PRIORITY: Record<string, { label: string; tone: string }> = {
  low: { label: 'Düşük', tone: '' },
  normal: { label: 'Normal', tone: '' },
  high: { label: 'Yüksek', tone: 'badge-warn' },
  urgent: { label: 'Acil', tone: 'badge-danger' },
};

/** Dakikayı okunur süreye çevirir — SLA her yerde dakika tutuyor. */
function duration(minutes?: number | null): string {
  if (minutes === null || minutes === undefined) return '—';
  const abs = Math.abs(minutes);
  const s = abs < 60 ? `${abs} dk`
    : abs < 1440 ? `${Math.floor(abs / 60)} sa ${abs % 60} dk`
    : `${Math.floor(abs / 1440)} gün ${Math.floor((abs % 1440) / 60)} sa`;
  return minutes < 0 ? `${s} geçti` : s;
}

// =============================================================================
/**
 * Destek biletleri.
 *
 * BAŞ RAKAM YANITLANMAMIŞ BİLETTİR. Açık bilet sayısı bir iş yükü ölçüsüdür
 * ama müşteri için asıl kırılma noktası ilk dönüşün gecikmesidir; SLA
 * ihlallerinin çoğu orada başlar.
 */
export function TicketList() {
  const kolonlar: Kolon<Ticket>[] = [
    kolonBelgeNo<Ticket>('No'),
    {
      anahtar: 'subject', baslik: 'Konu', suz: 'metin',
      govde: (t) => <strong>{t.subject}</strong>, disa: (t) => t.subject,
    },
    {
      anahtar: 'partner_name', baslik: 'Müşteri', suz: 'metin', gruplanir: true,
      govde: (t) => t.partner_name ?? t.contact_name ?? <span className="muted">—</span>,
      disa: (t) => t.partner_name ?? t.contact_name ?? '',
    },
    {
      anahtar: 'priority', baslik: 'Öncelik', suz: 'secim', gruplanir: true,
      secenekler: Object.entries(PRIORITY).map(([deger, v]) => ({ deger, etiket: v.label })),
      govde: (t) => {
        const p = PRIORITY[t.priority];
        return <span className={`badge ${p?.tone ?? ''}`}>{p?.label ?? t.priority}</span>;
      },
      disa: (t) => PRIORITY[t.priority]?.label ?? t.priority,
    },
    {
      anahtar: 'status', baslik: 'Durum', suz: 'secim', gruplanir: true,
      secenekler: Object.entries(STATUS).map(([deger, v]) => ({ deger, etiket: v.label })),
      govde: (t) => {
        const st = STATUS[t.status];
        return <span className={`badge ${st?.tone ?? ''}`}>{st?.label ?? t.status}</span>;
      },
      disa: (t) => STATUS[t.status]?.label ?? t.status,
    },
    kolonAd<Ticket>('team_name', 'Ekip', { gizli: true }),
    {
      anahtar: 'assignee_name', baslik: 'Sorumlu', gruplanir: true,
      govde: (t) => t.assignee_name ?? <span className="muted">atanmadı</span>,
      disa: (t) => t.assignee_name ?? '',
    },
    {
      anahtar: 'first_response_minutes', baslik: 'İlk yanıt', hizala: 'sag',
      govde: (t) => (t.first_response_at
        ? (
          <span className={t.first_response_breached ? 'badge badge-danger' : undefined}>
            {duration(t.first_response_minutes)}
          </span>
        )
        : <span className="badge badge-warn">bekliyor</span>),
      disa: (t) => duration(t.first_response_minutes),
    },
    {
      anahtar: 'minutes_to_due', baslik: 'Kalan süre', hizala: 'sag',
      // NEGATİF KALAN SÜRE gecikmedir; SLA'nın en okunur göstergesi budur.
      // Üç kademe: geçmiş (kırmızı), iki saatten az (turuncu), rahat (sade).
      govde: (t) => {
        if (t.status === 'resolved' || t.status === 'closed') {
          return <span className="muted">{duration(t.resolution_minutes)}</span>;
        }
        if (t.minutes_to_due === null || t.minutes_to_due === undefined) {
          return <span className="muted">—</span>;
        }
        return (
          <span className={`badge ${t.minutes_to_due < 0 ? 'badge-danger'
            : t.minutes_to_due < 120 ? 'badge-warn' : ''}`}>
            {duration(t.minutes_to_due)}
          </span>
        );
      },
      disa: (t) => duration(t.minutes_to_due),
    },
    {
      anahtar: 'channel', baslik: 'Kanal', suz: 'secim', gruplanir: true, gizliBaslangic: true,
      secenekler: [
        { deger: 'email', etiket: 'E-posta' },
        { deger: 'phone', etiket: 'Telefon' },
        { deger: 'web', etiket: 'Web' },
        { deger: 'internal', etiket: 'İç kayıt' },
      ],
      govde: (t) => <span className="muted">{t.channel}</span>, disa: (t) => t.channel,
    },
    kolonSayi<Ticket>('message_count', 'Mesaj'),
    kolonGecen<Ticket>('created_at', 'Açılma', false),
  ];

  return (
    <ResourceList<Ticket>
      kicker="Destek · Biletler"
      baslik="Destek Biletleri"
      altBaslik="SLA durumu, ilk yanıt süresi ve çözüm kuyruğu."
      yol="/helpdesk/tickets"
      aramaYer="Bilet no, konu, açıklama, müşteri…"
      kolonlar={kolonlar}
      satirYolu={(t) => `/helpdesk/${t.id}`}
      yazmaIzni="helpdesk.ticket.create"
      silmeIzni="helpdesk.ticket.delete.all"
      yetenekler={[
        { simge: Timer, etiket: 'SLA', deger: 'İlk yanıt ve çözüm' },
        { simge: Users, etiket: 'Ekip', deger: 'Yönlendirme ve atama' },
        { simge: MessageSquare, etiket: 'Yazışma', deger: 'İç not ayrı tutulur' },
        { simge: Inbox, etiket: 'Kanal', deger: 'E-posta · telefon · web' },
        { simge: Star, etiket: 'Memnuniyet', deger: 'Kapanışta sorulur' },
      ]}
      sayimlar={(t, rows) => [
        { deger: t, etiket: 'bilet' },
        { deger: rows.filter((x) => x.resolution_breached).length, etiket: 'SLA ihlali' },
      ]}
      gostergeler={(rows) => {
        if (rows.length === 0) return null;
        const breached = rows.filter((t) => t.resolution_breached);
        const unanswered = rows.filter((t) => !t.first_response_at
          && (t.status === 'new' || t.status === 'open'));
        const acik = rows.filter((t) => t.status !== 'closed');
        const sahipsiz = rows.filter((t) => !t.assignee_name && t.status !== 'closed');
        return (
          <div className="grid grid-4">
            <Stat label="Yanıtlanmamış" value={unanswered.length}
                  hint={unanswered.length === 0 ? 'Tümü yanıtlandı' : 'İlk dönüş bekliyor'} />
            <Stat label="SLA ihlali" value={breached.length}
                  hint={breached.length === 0 ? 'İhlal yok' : 'Çözüm süresi aşıldı'} />
            <Stat label="Sahipsiz" value={sahipsiz.length}
                  hint={sahipsiz.length === 0 ? 'Tümü atandı' : 'Sorumlu atanmalı'} />
            <Stat label="Açık bilet" value={acik.length}
                  hint={`${rows.length} bilet listeleniyor`} />
          </div>
        );
      }}
      bosBaslik="Açık bilet yok"
      bosMetin="Bilet, müşteri bir kanaldan ulaştığında açılır. SLA politikası ilk yanıt ve çözüm süresini takip eder; süre aşıldığında bilet ihlal olarak işaretlenir."
      dipnot={<span>Kalan süre negatifse çözüm SLA'sı aşılmış demektir.</span>}
    />
  );
}

export function TicketDetail() {
  const { id } = useParams();
  const { can } = useSession();
  const doc = useItem<Ticket & { messages: Message[]; description?: string }>(
    id ? `/helpdesk/tickets/${id}/full` : null);
  const [reply, setReply] = useState('');
  const [internal, setInternal] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);

  const act = async (path: string, body?: unknown) => {
    setBusy(true); setError(null);
    try {
      await api.post(`/helpdesk/tickets/${id}/${path}`, body);
      await doc.reload();
    } catch (err) { setError(err); } finally { setBusy(false); }
  };

  const send = async () => {
    if (!reply.trim()) return;
    await act('reply', { body: reply, is_internal: internal });
    setReply('');
  };

  if (doc.loading) return <div className="empty">Yükleniyor…</div>;
  if (!doc.data) return <ErrorBox error={doc.error ?? 'Bilet bulunamadı'} />;
  const d = doc.data;
  const open = d.status === 'new' || d.status === 'open' || d.status === 'pending_customer';

  return (
    <>
      <PageHead
        title={`${d.number} — ${d.subject}`}
        subtitle={<>
          <span className={`badge ${STATUS[d.status]?.tone ?? ''}`}>
            {STATUS[d.status]?.label ?? d.status}
          </span>
          {' '}
          <span className={`badge ${PRIORITY[d.priority]?.tone ?? ''}`}>
            {PRIORITY[d.priority]?.label}
          </span>
          {d.partner_name && <> · {d.partner_name}</>}
          {d.assignee_name && <> · {d.assignee_name}</>}
        </>}
        actions={
          <span className="row" style={{ gap: 8 }}>
            {open && d.status !== 'pending_customer' && (
              <button className="btn" disabled={busy} onClick={() => {
                const note = window.prompt('Müşteriden ne bekleniyor? (iç not)');
                void act('wait-customer', { note });
              }}>Müşteri bekle</button>
            )}
            {open && can('helpdesk.ticket.resolve') && (
              <button className="btn btn-primary" disabled={busy} onClick={() => {
                const resolution = window.prompt('Çözüm açıklaması:');
                if (resolution !== null) void act('resolve', { resolution });
              }}>Çöz</button>
            )}
            {d.status === 'resolved' && (
              <button className="btn" disabled={busy} onClick={() => {
                const s = window.prompt('Memnuniyet puanı (1-5):', '5');
                if (s !== null) void act('close', { satisfaction: Number(s) });
              }}>Kapat</button>
            )}
            <Link className="btn" to="/helpdesk">Listeye dön</Link>
          </span>
        }
      />
      <ErrorBox error={error} />

      <div className="grid grid-4">
        <Stat label="İlk yanıt"
              value={d.first_response_at ? duration(d.first_response_minutes) : 'bekliyor'}
              hint={d.first_response_breached ? 'SLA aşıldı' : undefined} />
        <Stat label={open ? 'Kalan süre' : 'Çözüm süresi'}
              value={open ? duration(d.minutes_to_due) : duration(d.resolution_minutes)}
              hint={d.resolution_breached ? 'SLA aşıldı' : undefined} />
        {d.paused_minutes > 0 && (
          <Stat label="Müşteri beklendi" value={duration(d.paused_minutes)}
                hint="Bu süre SLA'dan düşüldü" />
        )}
        {d.satisfaction && <Stat label="Memnuniyet" value={`${d.satisfaction}/5`} />}
      </div>

      {d.description && <Card title="Açıklama">{d.description}</Card>}
      {d.resolution && <Card title="Çözüm">{d.resolution}</Card>}

      <Card title="Yazışma">
        <div style={{ display: 'grid', gap: 12, marginBottom: 16 }}>
          {(d.messages ?? []).map((m) => (
            <div key={m.id} style={{
              padding: 12,
              borderRadius: 8,
              border: '1px solid var(--c-border, #e5e7eb)',
              // İç not görsel olarak AYRIŞMALI: yanlışlıkla müşteriye gittiği
              // sanılan bir not, en pahalı destek hatasıdır.
              background: m.is_internal ? 'rgba(224,160,32,.08)'
                : m.is_from_customer ? 'rgba(61,126,255,.06)' : 'transparent',
            }}>
              <div className="row" style={{ justifyContent: 'space-between', marginBottom: 6 }}>
                <strong>
                  {m.is_from_customer
                    ? (m.author_name ?? 'Müşteri')
                    : (m.author_full_name ?? 'Ekip')}
                  {m.is_internal && (
                    <span className="badge badge-warn" style={{ marginLeft: 8 }}>iç not</span>
                  )}
                  {m.is_from_customer && (
                    <span className="badge badge-info" style={{ marginLeft: 8 }}>müşteri</span>
                  )}
                </strong>
                <span className="muted" style={{ fontSize: 12 }}>{date(m.created_at)}</span>
              </div>
              <div style={{ whiteSpace: 'pre-wrap' }}>{m.body}</div>
            </div>
          ))}
          {(d.messages ?? []).length === 0 && <Empty>Henüz mesaj yok</Empty>}
        </div>

        {open && (
          <>
            <Field label="Yanıt"
                   hint={internal
                     ? 'İç not müşteriye GİTMEZ ve ilk yanıt sayılmaz'
                     : 'Müşteriye gönderilecek — ilk yanıt süresi bu mesajla durur'}>
              <textarea rows={4} value={reply} onChange={(e) => setReply(e.target.value)}
                        style={{ width: '100%', padding: 10 }} />
            </Field>
            <div className="row" style={{ gap: 12 }}>
              <label className="row" style={{ gap: 6, fontSize: 13 }}>
                <input type="checkbox" style={{ width: 'auto' }}
                       checked={internal} onChange={(e) => setInternal(e.target.checked)} />
                İç not
              </label>
              <button className="btn btn-primary" disabled={busy || !reply.trim()}
                      onClick={send}>Gönder</button>
            </div>
          </>
        )}
      </Card>
    </>
  );
}

// =============================================================================
export function HelpdeskReports() {
  const sla = useList<{
    team_name?: string; priority: string; ticket_count: number;
    fr_breach_count: number; res_breach_count: number;
    fr_compliance_pct?: string; res_compliance_pct?: string;
    avg_first_response_minutes?: string; avg_resolution_minutes?: string;
    avg_satisfaction?: string;
  }>('/helpdesk/reports/sla');

  const agents = useList<{
    assignee_id: string; agent_name: string; open_count: number; closed_count: number;
    breach_count: number; avg_resolution_minutes?: string; avg_satisfaction?: string;
  }>('/helpdesk/reports/agents');

  const partners = useList<{
    partner_id: string; partner_name: string; ticket_count: number; open_count: number;
    high_priority_count: number; breach_count: number; avg_satisfaction?: string;
    last_ticket_at?: string;
  }>('/helpdesk/reports/partners');

  // Baş rakam SLA UYUMU: destek raporunun tek özet cümlesi. Toplam bilet
  // sayısı iş yükünü söyler ama sözün tutulup tutulmadığını söylemez.
  const bilet  = sla.data.reduce((t, r) => t + Number(r.ticket_count || 0), 0);
  const ihlal  = sla.data.reduce((t, r) => t + Number(r.res_breach_count || 0), 0);
  const frIhlal = sla.data.reduce((t, r) => t + Number(r.fr_breach_count || 0), 0);
  const uyum = bilet === 0 ? null : Math.round(((bilet - ihlal) / bilet) * 100);
  const puanlar = sla.data.map((r) => Number(r.avg_satisfaction)).filter((v) => v > 0);
  const memnuniyet = puanlar.length === 0 ? null
    : puanlar.reduce((t, v) => t + v, 0) / puanlar.length;

  return (
    <>
      <PageHead kicker="Destek" title="Destek Raporları"
                subtitle="SLA uyumu, temsilci performansı ve müşteri kırılımı." />

      <div className="grid grid-4">
        <Stat label="Çözüm SLA uyumu" value={uyum === null ? '—' : `%${uyum}`}
              hint={bilet === 0 ? 'Bilet kaydı yok' : `${bilet} bilette`} />
        <Stat label="İlk yanıt ihlali" value={frIhlal}
              hint={frIhlal === 0 ? 'İlk yanıt sözü tutuldu' : 'İlk dönüş geciktir'} />
        <Stat label="Çözüm ihlali" value={ihlal}
              hint={ihlal === 0 ? 'Çözüm sözü tutuldu' : 'Çözüm süresi aşıldı'} />
        <Stat label="Ortalama memnuniyet"
              value={memnuniyet === null ? '—' : num(memnuniyet.toFixed(1))}
              hint={memnuniyet === null ? 'Puanlama yok' : `${agents.data.length} temsilci`} />
      </div>
      <ErrorBox error={sla.error} />

      <Card title="SLA performansı" padded={false}>
        <div className="tbl-wrap">
          <table className="tbl">
            <thead>
              <tr>
                <th>Ekip</th><th>Öncelik</th><th className="r">Bilet</th>
                <th className="r">İlk yanıt uyumu</th><th className="r">Çözüm uyumu</th>
                <th className="r">Ort. ilk yanıt</th><th className="r">Ort. çözüm</th>
                <th className="r">Memnuniyet</th>
              </tr>
            </thead>
            <tbody>
              {sla.data.map((r, i) => (
                <tr key={i}>
                  <td>{r.team_name ?? '—'}</td>
                  <td>
                    <span className={`badge ${PRIORITY[r.priority]?.tone ?? ''}`}>
                      {PRIORITY[r.priority]?.label ?? r.priority}
                    </span>
                  </td>
                  <td className="r">{r.ticket_count}</td>
                  <td className="r">
                    {r.fr_compliance_pct === null || r.fr_compliance_pct === undefined ? '—' : (
                      <span className={`badge ${Number(r.fr_compliance_pct) >= 90 ? 'badge-ok'
                        : Number(r.fr_compliance_pct) >= 70 ? 'badge-warn' : 'badge-danger'}`}>
                        %{num(r.fr_compliance_pct)}
                      </span>
                    )}
                  </td>
                  <td className="r">
                    {r.res_compliance_pct === null || r.res_compliance_pct === undefined ? '—' : (
                      <span className={`badge ${Number(r.res_compliance_pct) >= 90 ? 'badge-ok'
                        : Number(r.res_compliance_pct) >= 70 ? 'badge-warn' : 'badge-danger'}`}>
                        %{num(r.res_compliance_pct)}
                      </span>
                    )}
                  </td>
                  <td className="r">{duration(Number(r.avg_first_response_minutes) || null)}</td>
                  <td className="r">{duration(Number(r.avg_resolution_minutes) || null)}</td>
                  <td className="r">{r.avg_satisfaction ? `${num(r.avg_satisfaction)}/5` : '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
          {!sla.loading && sla.data.length === 0 && <Empty>Henüz bilet yok</Empty>}
        </div>
      </Card>

      <div className="grid grid-2">
        <Card title="Temsilci yükü" padded={false}>
          <div className="tbl-wrap">
            <table className="tbl">
              <thead>
                <tr><th>Temsilci</th><th className="r">Açık</th><th className="r">Kapanan</th>
                    <th className="r">İhlal</th><th className="r">Memnuniyet</th></tr>
              </thead>
              <tbody>
                {agents.data.map((a) => (
                  <tr key={a.assignee_id}>
                    <td>{a.agent_name}</td>
                    <td className="r"><strong>{a.open_count}</strong></td>
                    <td className="r">{a.closed_count}</td>
                    <td className="r">
                      {a.breach_count > 0
                        ? <span className="badge badge-danger">{a.breach_count}</span> : '—'}
                    </td>
                    <td className="r">{a.avg_satisfaction ? `${num(a.avg_satisfaction)}/5` : '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            {!agents.loading && agents.data.length === 0 && <Empty />}
          </div>
        </Card>

        <Card title="Müşteri bazlı destek yükü" padded={false}>
          <div className="tbl-wrap">
            <table className="tbl">
              <thead>
                <tr><th>Müşteri</th><th className="r">Bilet</th><th className="r">Açık</th>
                    <th className="r">Yüksek öncelik</th><th className="r">Memnuniyet</th></tr>
              </thead>
              <tbody>
                {partners.data.map((p) => (
                  <tr key={p.partner_id}>
                    <td>{p.partner_name}</td>
                    <td className="r">{p.ticket_count}</td>
                    <td className="r">{p.open_count || '—'}</td>
                    <td className="r">
                      {p.high_priority_count > 0
                        ? <span className="badge badge-warn">{p.high_priority_count}</span> : '—'}
                    </td>
                    <td className="r">{p.avg_satisfaction ? `${num(p.avg_satisfaction)}/5` : '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            {!partners.loading && partners.data.length === 0 && (
              <Empty title="Veri yok">Bu kırılımda müşteri kaydı bulunmuyor.</Empty>
            )}
          </div>
        </Card>
      </div>

      <PageFoot>
        <span><strong>{bilet}</strong> bilet, <strong>{agents.data.length}</strong> temsilci</span>
        <span>SLA sayacı müşteri yanıtı beklenen sürede durur.</span>
      </PageFoot>
    </>
  );
}
