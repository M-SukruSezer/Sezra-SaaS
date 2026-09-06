import { useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { api } from '../api/client';
import { useItem, useList } from '../ui/useResource';
import { Card, Empty, ErrorBox, Field, PageFoot, PageHead, Stat, StatusBadge } from '../ui';
import { CalendarRange, Coins, FolderKanban, ReceiptText, Timer } from 'lucide-react';
import { ResourceList, type Kolon } from '../ui/ResourceList';
import { kolonAd, kolonPara, kolonSayi } from '../ui/kolonlar';
import { money, date, num, sayi } from '../i18n';
import { useSession } from '../api/session';

interface Project {
  id: string; code: string; name: string; status: string; billing_type: string;
  partner_name?: string; manager_name?: string; start_date?: string; due_date?: string;
  contract_amount?: string; hourly_rate?: string; currency: string; planned_hours?: string;
  task_count: number; done_task_count: number; actual_hours: string;
  hours_used_pct?: string; billable_amount: string; unbilled_amount: string;
  overdue_days?: number; branch_name?: string;
}

interface Task {
  id: string; parent_id?: string; name: string; status: string; priority: number;
  assignee_name?: string; planned_hours?: string; actual_hours: string;
  due_date?: string; overdue_days?: number; subtask_count: number;
}

interface Timesheet {
  id: string; work_date: string; user_name: string; task_name?: string;
  hours: string; description?: string; is_billable: boolean;
  billable_amount: string; is_invoiced: boolean;
}

const BILLING_LABEL: Record<string, string> = {
  fixed_price: 'Sabit fiyat', time_material: 'Zaman & malzeme', internal: 'İç proje',
};
const TASK_STATUS: Record<string, { label: string; tone: string }> = {
  todo: { label: 'Yapılacak', tone: '' },
  in_progress: { label: 'Devam ediyor', tone: 'badge-info' },
  blocked: { label: 'Engellendi', tone: 'badge-danger' },
  done: { label: 'Tamamlandı', tone: 'badge-ok' },
  cancelled: { label: 'İptal', tone: '' },
};

// =============================================================================
/**
 * Projeler.
 *
 * BAŞ RAKAM FATURALANMAMIŞ HAKEDİŞTİR: proje ekranında en kolay kaçırılan
 * para budur. Saat girilmiş, iş yapılmış ama faturaya dönmemiştir ve proje
 * kapatıldığında geri dönüşü yoktur.
 */
export function ProjectList() {
  const kolonlar: Kolon<Project>[] = [
    {
      anahtar: 'code', baslik: 'Kod', sirala: true, suz: 'metin',
      govde: (p) => <span className="num badge-code">{p.code}</span>, disa: (p) => p.code,
    },
    {
      anahtar: 'name', baslik: 'Proje', sirala: true, suz: 'metin',
      govde: (p) => <strong>{p.name}</strong>, disa: (p) => p.name,
    },
    {
      anahtar: 'partner_name', baslik: 'Müşteri', suz: 'metin', gruplanir: true,
      govde: (p) => p.partner_name ?? <span className="muted">iç</span>,
      disa: (p) => p.partner_name ?? 'iç',
    },
    {
      anahtar: 'billing_type', baslik: 'Tip', suz: 'secim', gruplanir: true,
      secenekler: Object.entries(BILLING_LABEL).map(([deger, etiket]) => ({ deger, etiket })),
      govde: (p) => <span className="muted">{BILLING_LABEL[p.billing_type] ?? p.billing_type}</span>,
      disa: (p) => BILLING_LABEL[p.billing_type] ?? p.billing_type,
    },
    {
      anahtar: 'status', baslik: 'Durum', suz: 'secim', gruplanir: true,
      secenekler: [
        { deger: 'draft', etiket: 'Taslak' },
        { deger: 'active', etiket: 'Aktif' },
        { deger: 'on_hold', etiket: 'Beklemede' },
        { deger: 'completed', etiket: 'Tamamlandı' },
        { deger: 'cancelled', etiket: 'İptal' },
      ],
      govde: (p) => <StatusBadge status={p.status === 'active' ? 'confirmed'
        : p.status === 'completed' ? 'accepted' : p.status} />,
      disa: (p) => p.status,
    },
    {
      anahtar: 'task_count', baslik: 'Görev', hizala: 'sag',
      govde: (p) => <>{p.done_task_count}/{p.task_count}</>,
      disa: (p) => `${p.done_task_count}/${p.task_count}`,
    },
    kolonSayi<Project>('actual_hours', 'Saat', { sirala: true }),
    {
      anahtar: 'hours_used_pct', baslik: 'Bütçe kullanımı', hizala: 'sag', sirala: true,
      // BÜTÇE AŞIMI ÜÇ KADEMELİ: yüzde tek başına okunmuyor, eşiği geçtiğini
      // rozet rengi VE metin birlikte söylüyor.
      govde: (p) => (p.hours_used_pct
        ? (
          <span className={`badge ${Number(p.hours_used_pct) > 100 ? 'badge-danger'
            : Number(p.hours_used_pct) > 85 ? 'badge-warn' : ''}`}>
            %{num(p.hours_used_pct, 0)}
          </span>
        )
        : <span className="muted">—</span>),
      disa: (p) => p.hours_used_pct ?? '',
    },
    {
      anahtar: 'unbilled_amount', baslik: 'Faturalanmamış', hizala: 'sag', sirala: true,
      govde: (p) => (Number(p.unbilled_amount) > 0
        ? <span className="badge badge-warn">{money(p.unbilled_amount, p.currency)}</span>
        : <span className="muted">—</span>),
      disa: (p) => p.unbilled_amount,
    },
    {
      anahtar: 'due_date', baslik: 'Termin', sirala: true,
      govde: (p) => (
        <>
          {p.due_date ? date(p.due_date) : '—'}
          {(p.overdue_days ?? 0) > 0 && (
            <span className="badge badge-danger">{p.overdue_days} gün</span>
          )}
        </>
      ),
      disa: (p) => p.due_date ?? '',
    },
    kolonAd<Project>('manager_name', 'Yönetici', { gizli: true }),
    kolonPara<Project>('contract_amount', 'Sözleşme', { gizli: true }),
  ];

  return (
    <ResourceList<Project>
      kicker="Projeler · Liste"
      baslik="Projeler"
      altBaslik="Bütçe kullanımı, hakediş ve termin takibi."
      yol="/projects/projects"
      aramaYer="Kod, proje adı, müşteri…"
      kolonlar={kolonlar}
      satirYolu={(p) => `/projects/${p.id}`}
      yazmaIzni="projects.project.create"
      silmeIzni="projects.project.delete.all"
      yazilabilir={['code', 'name', 'description', 'status', 'billing_type',
        'contract_amount', 'hourly_rate', 'currency', 'start_date', 'due_date', 'planned_hours']}
      yetenekler={[
        { simge: FolderKanban, etiket: 'Görev', deger: 'Alt görev hiyerarşisi' },
        { simge: Timer, etiket: 'Zaman', deger: 'Saat girişi ve onay' },
        { simge: Coins, etiket: 'Hakediş', deger: 'Sabit · zaman & malzeme' },
        { simge: ReceiptText, etiket: 'Fatura', deger: 'Hakedişten kesilir' },
        { simge: CalendarRange, etiket: 'Termin', deger: 'Gecikme gün sayılır' },
      ]}
      sayimlar={(t, rows) => [
        { deger: t, etiket: 'proje' },
        { deger: rows.filter((p) => p.status === 'active').length, etiket: 'aktif' },
      ]}
      gostergeler={(rows) => {
        if (rows.length === 0) return null;
        const unbilled = rows.reduce((t, p) => t + Number(p.unbilled_amount || 0), 0);
        const aktif = rows.filter((p) => p.status === 'active');
        const geciken = rows.filter((p) => (p.overdue_days ?? 0) > 0);
        const butceAsan = rows.filter((p) => Number(p.hours_used_pct ?? 0) > 100);
        const saat = rows.reduce((t, p) => t + Number(p.actual_hours || 0), 0);
        return (
          <div className="grid grid-4">
            <Stat label="Faturalanmamış hakediş" value={money(unbilled)}
                  hint={unbilled === 0 ? 'Bekleyen hakediş yok' : 'Faturaya dönmeyi bekliyor'} />
            <Stat label="Aktif proje" value={aktif.length}
                  hint={`${sayi(saat)} saat girildi`} />
            <Stat label="Termini geçen" value={geciken.length}
                  hint={geciken.length === 0 ? 'Gecikme yok' : 'Termin tarihi aşıldı'} />
            <Stat label="Bütçeyi aşan" value={butceAsan.length}
                  hint={butceAsan.length === 0 ? 'Bütçe içinde' : 'Planlanan saati aştı'} />
          </div>
        );
      }}
      bosBaslik="Proje yok"
      bosMetin="Proje elle açılabilir; kazanılan bir fırsat da kendiliğinden proje doğurabilir. Girilen saatler sözleşme tipine göre hakedişe dönüşür ve faturalanana kadar burada birikir."
      dipnot={<span>Bütçe kullanımı, girilen saatin planlanan saate oranıdır.</span>}
    />
  );
}

export function ProjectDetail() {
  const { id } = useParams();
  const { can, me } = useSession();
  const doc = useItem<Project & { tasks: Task[]; timesheets: Timesheet[] }>(
    id ? `/projects/projects/${id}/full` : null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [hours, setHours] = useState('');
  const [taskId, setTaskId] = useState('');
  const [note, setNote] = useState('');

  const act = async (path: string, body?: unknown) => {
    setBusy(true); setError(null);
    try {
      await api.post(`/projects/projects/${id}/${path}`, body);
      await doc.reload();
    } catch (err) { setError(err); } finally { setBusy(false); }
  };

  const logTime = async () => {
    if (!hours || !me) return;
    setBusy(true); setError(null);
    try {
      await api.post('/projects/timesheets', {
        project_id: id, task_id: taskId || null, user_id: me.user.id,
        hours: Number(hours), description: note || null,
      });
      setHours(''); setNote('');
      await doc.reload();
    } catch (err) { setError(err); } finally { setBusy(false); }
  };

  const complete = async (t: Task) => {
    setError(null);
    try {
      await api.post(`/projects/tasks/${t.id}/complete`);
      await doc.reload();
    } catch (err) { setError(err); }
  };

  if (doc.loading) return <div className="empty">Yükleniyor…</div>;
  if (!doc.data) return <ErrorBox error={doc.error ?? 'Proje bulunamadı'} />;
  const d = doc.data;
  const open = d.status === 'active' || d.status === 'draft' || d.status === 'on_hold';

  return (
    <>
      <PageHead
        title={`${d.code} — ${d.name}`}
        subtitle={<>
          <StatusBadge status={d.status === 'active' ? 'confirmed'
            : d.status === 'completed' ? 'posted' : 'draft'} />
          {' · '}{BILLING_LABEL[d.billing_type]}
          {d.partner_name && <> · {d.partner_name}</>}
        </>}
        actions={
          <span className="row" style={{ gap: 8 }}>
            {open && Number(d.unbilled_amount) > 0 && can('projects.project.bill') && (
              <button className="btn btn-primary" disabled={busy}
                      onClick={() => act('bill')}>
                Hakedişi faturala ({money(d.unbilled_amount)})
              </button>
            )}
            {open && can('projects.project.complete') && (
              <button className="btn" disabled={busy} onClick={() => act('complete')}>
                Projeyi kapat
              </button>
            )}
            <Link className="btn" to="/projects">Listeye dön</Link>
          </span>
        }
      />
      <ErrorBox error={error} />

      <div className="grid grid-4">
        <Stat label="Harcanan saat" value={num(d.actual_hours)}
              hint={d.planned_hours ? `${num(d.planned_hours)} planlandı` : undefined} />
        <Stat label="Görev" value={`${d.done_task_count}/${d.task_count}`} />
        <Stat label="Hakediş" value={money(d.billable_amount)} />
        <Stat label="Faturalanmamış" value={money(d.unbilled_amount)} />
      </div>

      <div className="grid grid-2">
        <Card title="Görevler" padded={false}>
          <div className="tbl-wrap">
            <table className="tbl">
              <thead>
                <tr><th>Görev</th><th>Sorumlu</th><th className="r">Saat</th>
                    <th>Durum</th><th /></tr>
              </thead>
              <tbody>
                {(d.tasks ?? []).map((t) => (
                  <tr key={t.id}>
                    <td style={{ paddingLeft: t.parent_id ? 28 : undefined }}>
                      {t.parent_id && <span className="muted">↳ </span>}
                      {t.name}
                      {(t.overdue_days ?? 0) > 0 && (
                        <span className="badge badge-danger" style={{ marginLeft: 6 }}>
                          {t.overdue_days} gün geç
                        </span>
                      )}
                    </td>
                    <td>{t.assignee_name ?? '—'}</td>
                    <td className="r">
                      {num(t.actual_hours)}
                      {t.planned_hours && (
                        <span className="muted"> / {num(t.planned_hours)}</span>
                      )}
                    </td>
                    <td>
                      <span className={`badge ${TASK_STATUS[t.status]?.tone ?? ''}`}>
                        {TASK_STATUS[t.status]?.label ?? t.status}
                      </span>
                    </td>
                    <td className="r">
                      {t.status !== 'done' && t.status !== 'cancelled' && (
                        <button className="btn btn-sm" onClick={() => complete(t)}>Bitir</button>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            {(d.tasks ?? []).length === 0 && <Empty>Görev yok</Empty>}
          </div>
        </Card>

        {/* Saat girişi projenin İÇİNDE: ayrı bir zaman çizelgesi ekranına gidip
            projeyi yeniden seçmek, en çok terk edilen akış. */}
        <Card title="Saat gir">
          <Field label="Görev (opsiyonel)">
            <select value={taskId} onChange={(e) => setTaskId(e.target.value)}>
              <option value="">— proje geneli —</option>
              {(d.tasks ?? []).filter((t) => t.status !== 'done').map((t) => (
                <option key={t.id} value={t.id}>{t.name}</option>
              ))}
            </select>
          </Field>
          <Field label="Saat">
            <input type="number" step="0.25" value={hours}
                   onChange={(e) => setHours(e.target.value)} placeholder="8" />
          </Field>
          <Field label="Açıklama">
            <input value={note} onChange={(e) => setNote(e.target.value)}
                   placeholder="Ne yapıldı" />
          </Field>
          <button className="btn btn-primary" disabled={busy || !hours} onClick={logTime}>
            Kaydet
          </button>
        </Card>
      </div>

      <Card title="Zaman çizelgesi" padded={false}>
        <div className="tbl-wrap">
          <table className="tbl">
            <thead>
              <tr><th>Tarih</th><th>Kişi</th><th>Görev</th><th>Açıklama</th>
                  <th className="r">Saat</th><th className="r">Hakediş</th><th>Fatura</th></tr>
            </thead>
            <tbody>
              {(d.timesheets ?? []).map((t) => (
                <tr key={t.id}>
                  <td>{date(t.work_date)}</td>
                  <td>{t.user_name}</td>
                  <td className="muted">{t.task_name ?? '—'}</td>
                  <td className="muted">{t.description ?? '—'}</td>
                  <td className="r">{num(t.hours)}</td>
                  <td className="r">
                    {t.is_billable ? money(t.billable_amount)
                      : <span className="muted">faturalanmaz</span>}
                  </td>
                  <td>
                    {t.is_invoiced
                      ? <span className="badge badge-ok">kesildi</span>
                      : t.is_billable ? <span className="badge badge-warn">bekliyor</span> : '—'}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          {(d.timesheets ?? []).length === 0 && <Empty>Kayıt yok</Empty>}
        </div>
      </Card>
    </>
  );
}

// =============================================================================
export function ProjectReports() {
  const { can } = useSession();
  const prof = useList<{
    project_id: string; code: string; name: string; partner_name?: string; status: string;
    actual_hours: string; billable_hours: string; revenue: string; cost: string;
    margin: string; margin_pct?: string; billable_pct?: string; currency: string;
  }>('/projects/reports/profitability');

  const util = useList<{
    user_id: string; user_name: string; period: string;
    total_hours: string; billable_hours: string; billable_pct?: string; project_count: number;
  }>('/projects/reports/utilization');

  const showCost = can('projects.report.profitability');

  // Baş rakam TOPLAM MARJdır — yetkisi olmayan kullanıcıda marj hiç
  // gelmez, o yüzden lider faturalanabilir saat oranına döner. Bandı
  // tamamen gizlemek, yetkisiz kullanıcıya odaksız bir sayfa bırakırdı.
  const marj  = prof.data.reduce((t, r) => t + Number(r.margin || 0), 0);
  const gelir = prof.data.reduce((t, r) => t + Number(r.revenue || 0), 0);
  const marjPct = gelir === 0 ? null : Math.round((marj / gelir) * 100);
  const toplamSaat = util.data.reduce((t, r) => t + Number(r.total_hours || 0), 0);
  const faturalanabilir = util.data.reduce((t, r) => t + Number(r.billable_hours || 0), 0);
  const doluluk = toplamSaat === 0 ? null : Math.round((faturalanabilir / toplamSaat) * 100);

  return (
    <>
      <PageHead kicker="Projeler" title="Proje Raporları"
                subtitle="Kârlılık ve ekip doluluk oranı." />
      <ErrorBox error={prof.error ?? util.error} />

      <div className="grid grid-4">
        {showCost
          ? <Stat label="Toplam marj" value={money(marj)}
                  hint={marjPct === null ? 'Gelir kaydı yok' : `Gelirin %${marjPct}'i`} />
          : <Stat label="Faturalanabilirlik" value={doluluk === null ? '—' : `%${doluluk}`}
                  hint={`${num(faturalanabilir)} / ${num(toplamSaat)} saat`} />}
        {showCost
          ? <Stat label="Toplam gelir" value={money(gelir)} hint={`${prof.data.length} proje`} />
          : <Stat label="Girilen saat" value={num(toplamSaat)} hint={`${util.data.length} kişi`} />}
        <Stat label="Faturalanabilir saat" value={num(faturalanabilir)}
              hint={doluluk === null ? 'Saat girilmemiş' : `Doluluk %${doluluk}`} />
        <Stat label="İzlenen proje" value={prof.data.length}
              hint={`${util.data.length} kişi puantaj girdi`} />
      </div>

      {/* Maliyet ve marj ayrı yetkiye tabidir: ekip arkadaşının saatlik
          maliyeti, maaşını ele verir. */}
      <Card title="Proje kârlılığı" padded={false}>
        <div className="tbl-wrap">
          <table className="tbl">
            <thead>
              <tr>
                <th>Kod</th><th>Proje</th><th>Müşteri</th>
                <th className="r">Saat</th><th className="r">Faturalanabilir</th>
                <th className="r">Gelir</th>
                {showCost && <><th className="r">Maliyet</th><th className="r">Marj</th>
                  <th className="r">Marj %</th></>}
              </tr>
            </thead>
            <tbody>
              {prof.data.map((p) => (
                <tr key={p.project_id}>
                  <td><strong>{p.code}</strong></td>
                  <td>{p.name}</td>
                  <td>{p.partner_name ?? <span className="muted">iç</span>}</td>
                  <td className="r">{num(p.actual_hours)}</td>
                  <td className="r">
                    {p.billable_pct !== null && p.billable_pct !== undefined
                      ? `%${num(p.billable_pct)}` : '—'}
                  </td>
                  <td className="r">{money(p.revenue, p.currency)}</td>
                  {showCost && (
                    <>
                      <td className="r">{money(p.cost, p.currency)}</td>
                      <td className="r"><strong>{money(p.margin, p.currency)}</strong></td>
                      <td className="r">
                        {p.margin_pct === null || p.margin_pct === undefined ? '—' : (
                          <span className={`badge ${Number(p.margin_pct) >= 40 ? 'badge-ok'
                            : Number(p.margin_pct) >= 15 ? 'badge-warn' : 'badge-danger'}`}>
                            %{num(p.margin_pct)}
                          </span>
                        )}
                      </td>
                    </>
                  )}
                </tr>
              ))}
            </tbody>
          </table>
          {!prof.loading && prof.data.length === 0 && <Empty>Henüz proje yok</Empty>}
        </div>
      </Card>

      <Card title="Kişi bazlı zaman kullanımı" padded={false}>
        <div className="tbl-wrap">
          <table className="tbl">
            <thead>
              <tr><th>Dönem</th><th>Kişi</th><th className="r">Toplam saat</th>
                  <th className="r">Faturalanabilir</th><th className="r">Oran</th>
                  <th className="r">Proje</th></tr>
            </thead>
            <tbody>
              {util.data.map((u, i) => (
                <tr key={i}>
                  <td>{date(u.period)}</td>
                  <td>{u.user_name}</td>
                  <td className="r">{num(u.total_hours)}</td>
                  <td className="r">{num(u.billable_hours)}</td>
                  <td className="r">
                    {u.billable_pct === null || u.billable_pct === undefined ? '—' : (
                      <span className={`badge ${Number(u.billable_pct) >= 70 ? 'badge-ok'
                        : Number(u.billable_pct) >= 40 ? 'badge-warn' : ''}`}>
                        %{num(u.billable_pct)}
                      </span>
                    )}
                  </td>
                  <td className="r">{u.project_count}</td>
                </tr>
              ))}
            </tbody>
          </table>
          {!util.loading && util.data.length === 0 && (
            <Empty title="Veri yok">Bu dönemde puantaj girilmemiş.</Empty>
          )}
        </div>
      </Card>

      <PageFoot>
        <span><strong>{prof.data.length}</strong> proje, <strong>{util.data.length}</strong> kişi</span>
        <span>Faturalanabilir saat <strong>{num(faturalanabilir)}</strong> / {num(toplamSaat)}</span>
        {!showCost && <span>Maliyet ve marj ayrı bir izne bağlıdır ve bu sayfada gizlidir.</span>}
      </PageFoot>
    </>
  );
}
