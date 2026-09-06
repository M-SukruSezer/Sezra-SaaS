import { useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { api } from '../api/client';
import { useItem, useList } from '../ui/useResource';
import { Card, Empty, ErrorBox, PageFoot, PageHead, Stat, StatusBadge } from '../ui';
import { Boxes, Coins, Lock, ShieldCheck, Timer, TriangleAlert, Wrench } from 'lucide-react';
import { ResourceList, type Kolon } from '../ui/ResourceList';
import { kolonAd, kolonBelgeNo, kolonDurum, kolonOncelik, kolonPara, kolonSayi } from '../ui/kolonlar';
import { money, date, num } from '../i18n';
import { useSession } from '../api/session';

interface Equipment {
  id: string; code: string; name: string; category?: string;
  manufacturer?: string; model?: string; status: string; is_critical: boolean;
  under_warranty?: boolean; warranty_until?: string;
  usage_counter: string; usage_unit?: string; location_note?: string;
  service_partner_name?: string; branch_name?: string;
  open_work_orders: number; last_service_at?: string;
  lifetime_cost: string; lifetime_downtime_minutes: number;
}

interface WorkOrder {
  id: string; number?: string; kind: string; status: string; priority: number;
  title: string; equipment_code: string; equipment_name: string; is_critical: boolean;
  plan_name?: string; scheduled_date?: string; assignee_name?: string;
  downtime_minutes: number; total_cost: string; branch_name?: string;
  task_count: number; pending_task_count: number; overdue_days?: number;
}

interface Task { id: string; sequence: number; name: string; instructions?: string; is_done: boolean }
interface Part { id: string; sku?: string; product_name?: string; quantity: string; unit_cost: string; total_cost: string; stock_issued: boolean }

const EQ_STATUS: Record<string, { label: string; tone: string }> = {
  operational: { label: 'Çalışıyor', tone: 'badge-ok' },
  maintenance: { label: 'Bakımda', tone: 'badge-warn' },
  down: { label: 'Arızalı', tone: 'badge-danger' },
  retired: { label: 'Hurdaya ayrıldı', tone: '' },
};

// =============================================================================
// Ekipman
// =============================================================================
/**
 * Ekipman.
 *
 * BAŞ RAKAM DURAN EKİPMANDIR: bakım ekranına bakan kişinin ilk sorusu
 * "üretim duruyor mu". Toplam ekipman sayısı envanter bilgisidir ve dördüncü
 * sıraya iner.
 */
export function EquipmentList() {
  const { can } = useSession();
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<unknown>(null);

  const reportBreakdown = async (e: Equipment, yenile: () => Promise<void>) => {
    const title = window.prompt(`${e.name} — arıza nedir?`);
    if (!title) return;
    setBusy(e.id); setError(null);
    try {
      await api.post('/maintenance/work-orders', {
        equipment_id: e.id, kind: 'corrective', priority: 1, title,
      });
      await yenile();
    } catch (err) { setError(err); } finally { setBusy(null); }
  };

  const kolonlar: Kolon<Equipment>[] = [
    {
      anahtar: 'code', baslik: 'Kod', sirala: true, suz: 'metin',
      govde: (e) => <span className="num badge-code">{e.code}</span>, disa: (e) => e.code,
    },
    {
      anahtar: 'name', baslik: 'Ekipman', sirala: true, suz: 'metin',
      govde: (e) => (
        <>
          <strong>{e.name}</strong>
          {e.is_critical && <span className="badge badge-danger">kritik</span>}
          {(e.manufacturer || e.model) && (
            <div className="muted micro">{[e.manufacturer, e.model].filter(Boolean).join(' · ')}</div>
          )}
        </>
      ),
      disa: (e) => e.name,
    },
    kolonAd<Equipment>('category', 'Kategori'),
    kolonAd<Equipment>('branch_name', 'Şube'),
    {
      anahtar: 'status', baslik: 'Durum', suz: 'secim', gruplanir: true,
      secenekler: Object.entries(EQ_STATUS).map(([deger, v]) => ({ deger, etiket: v.label })),
      govde: (e) => {
        const st = EQ_STATUS[e.status];
        return (
          <span className="row">
            <span className={`badge ${st?.tone ?? ''}`}>{st?.label ?? e.status}</span>
            {e.open_work_orders > 0 && (
              <span className="badge badge-warn">{e.open_work_orders} açık iş emri</span>
            )}
          </span>
        );
      },
      disa: (e) => EQ_STATUS[e.status]?.label ?? e.status,
    },
    {
      anahtar: 'usage_counter', baslik: 'Sayaç', hizala: 'sag', sirala: true,
      govde: (e) => <>{num(e.usage_counter)} <span className="muted">{e.usage_unit ?? ''}</span></>,
      disa: (e) => e.usage_counter,
    },
    {
      anahtar: 'warranty_until', baslik: 'Garanti',
      govde: (e) => (e.under_warranty
        ? <span className="badge badge-ok">{e.warranty_until ? date(e.warranty_until) : 'sürüyor'}</span>
        : <span className="muted">{e.warranty_until ? date(e.warranty_until) : '—'}</span>),
      disa: (e) => e.warranty_until ?? '',
    },
    {
      anahtar: 'last_service_at', baslik: 'Son bakım', sirala: true,
      govde: (e) => (e.last_service_at ? date(e.last_service_at) : <span className="muted">hiç</span>),
      disa: (e) => e.last_service_at ?? '',
    },
    kolonPara<Equipment>('lifetime_cost', 'Ömür maliyeti'),
    {
      anahtar: 'lifetime_downtime_minutes', baslik: 'Duruş', hizala: 'sag', sirala: true,
      // DAKİKA DEĞİL SAAT: bakımda konuşulan birim saattir; dört haneli bir
      // dakika sayısı okunmadan geçilir.
      govde: (e) => (e.lifetime_downtime_minutes > 0
        ? <>{num(e.lifetime_downtime_minutes / 60, 0)} sa</>
        : <span className="muted">—</span>),
      disa: (e) => e.lifetime_downtime_minutes,
    },
    kolonAd<Equipment>('service_partner_name', 'Servis firması', { gizli: true }),
  ];

  return (
    <>
      <ErrorBox error={error} />
      <ResourceList<Equipment>
        kicker="Bakım · Ekipman"
        baslik="Ekipman"
        altBaslik="Makine parkı, garanti durumu ve ömür maliyeti."
        yol="/maintenance/equipment"
        aramaYer="Kod, ad, seri no, model…"
        varsayilanSirala={{ kolon: 'code', yon: 'asc' }}
        kolonlar={kolonlar}
        yazmaIzni="maintenance.equipment.create"
        silmeIzni="maintenance.equipment.delete.all"
        yazilabilir={['code', 'name', 'category', 'manufacturer', 'model', 'serial_no',
          'purchase_date', 'warranty_until', 'purchase_cost', 'location_note', 'usage_unit']}
        yetenekler={[
          { simge: Wrench, etiket: 'Periyodik', deger: 'Takvim ve sayaç' },
          { simge: TriangleAlert, etiket: 'Arıza', deger: 'Tek tıkla iş emri' },
          { simge: ShieldCheck, etiket: 'Garanti', deger: 'Süre takibi' },
          { simge: Coins, etiket: 'Maliyet', deger: 'Ömür boyu birikir' },
          { simge: Timer, etiket: 'Duruş', deger: 'Toplam süre izlenir' },
        ]}
        sayimlar={(t, rows) => [
          { deger: t, etiket: 'ekipman' },
          { deger: rows.filter((e) => e.status === 'down').length, etiket: 'duran' },
        ]}
        satirEylem={can('maintenance.workorder.create') ? (e, yenile) => (
          e.status !== 'down' && e.status !== 'retired' ? (
            <button className="btn btn-sm" disabled={busy === e.id} aria-busy={busy === e.id}
                    onClick={() => void reportBreakdown(e, yenile)}>Arıza bildir</button>
          ) : null
        ) : undefined}
        gostergeler={(rows) => {
          if (rows.length === 0) return null;
          const down = rows.filter((e) => e.status === 'down');
          const garantili = rows.filter((e) => e.under_warranty);
          const acikIsEmri = rows.reduce((t, e) => t + e.open_work_orders, 0);
          return (
            <div className="grid grid-4">
              <Stat label="Duran ekipman" value={down.length}
                    hint={down.length === 0 ? 'Tüm ekipman çalışıyor' : 'Üretim etkileniyor'} />
              <Stat label="Açık iş emri" value={acikIsEmri}
                    hint={acikIsEmri === 0 ? 'Bekleyen iş yok' : 'Bakım kuyruğunda'} />
              <Stat label="Garantisi süren" value={garantili.length}
                    hint={garantili.length === 0 ? 'Garantili ekipman yok' : 'Servis maliyeti üreticide'} />
              <Stat label="Listelenen ekipman" value={rows.length}
                    hint={`${rows.filter((e) => e.is_critical).length} kritik`} />
            </div>
          );
        }}
        bosBaslik="Ekipman kaydı yok"
        bosMetin="Ekipman kaydı açtığınızda garanti süresi, kullanım sayacı ve bakım planı bu kayıt üzerinden işler. Bakım vadesi hem takvimden hem sayaçtan hesaplanır."
        dipnot={<span>Bakım vadesi hem takvimden hem kullanım sayacından hesaplanır; hangisi önce gelirse iş emri o zaman açılır.</span>}
      />
    </>
  );
}

// =============================================================================
// İş emirleri
// =============================================================================
/**
 * İş emirleri.
 *
 * BAŞ RAKAM VADESİ GEÇEN iş emridir. Bir bakım kuyruğunda toplam sayı değil,
 * GECİKMENİN BÜYÜKLÜĞÜ karar verdirir: kaç gün geçtiği ipucunda durur, çünkü
 * "3 iş emri gecikti" ile "biri 40 gündür bekliyor" aynı şey değildir.
 */
export function WorkOrderList() {
  const { can } = useSession();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [tazele, setTazele] = useState(0);

  const generate = async () => {
    setBusy(true); setError(null);
    try {
      const res = await api.post<{ data: { created: number } }>('/maintenance/generate-work-orders');
      setTazele((v) => v + 1);
      window.alert(`${res.data.created} iş emri açıldı`);
    } catch (err) { setError(err); } finally { setBusy(false); }
  };

  const kolonlar: Kolon<WorkOrder>[] = [
    kolonBelgeNo<WorkOrder>('No'),
    {
      anahtar: 'equipment_name', baslik: 'Ekipman', suz: 'metin',
      govde: (w) => (
        <>
          <strong>{w.equipment_name}</strong>
          {w.is_critical && <span className="badge badge-danger">kritik</span>}
          <div className="muted micro num">{w.equipment_code}</div>
        </>
      ),
      disa: (w) => `${w.equipment_name} (${w.equipment_code})`,
    },
    {
      anahtar: 'title', baslik: 'Konu', suz: 'metin',
      govde: (w) => w.title, disa: (w) => w.title,
    },
    {
      anahtar: 'kind', baslik: 'Tür', suz: 'secim', gruplanir: true,
      secenekler: [
        { deger: 'preventive', etiket: 'Periyodik' },
        { deger: 'corrective', etiket: 'Arıza' },
        { deger: 'inspection', etiket: 'Kontrol' },
      ],
      govde: (w) => <span className="badge">{WO_KIND[w.kind] ?? w.kind}</span>,
      disa: (w) => WO_KIND[w.kind] ?? w.kind,
    },
    kolonOncelik<WorkOrder>('priority', 'Öncelik'),
    {
      anahtar: 'scheduled_date', baslik: 'Planlanan', sirala: true,
      govde: (w) => ((w.overdue_days ?? 0) > 0
        ? <span className="badge badge-danger">{date(w.scheduled_date)} · {w.overdue_days} gün geçti</span>
        : date(w.scheduled_date)),
      disa: (w) => w.scheduled_date ?? '',
    },
    kolonDurum<WorkOrder>([
      { deger: 'scheduled', etiket: 'Planlandı' },
      { deger: 'in_progress', etiket: 'Devam ediyor' },
      { deger: 'done', etiket: 'Tamamlandı' },
      { deger: 'cancelled', etiket: 'İptal' },
    ]),
    {
      anahtar: 'task_count', baslik: 'Görev', hizala: 'sag',
      govde: (w) => (w.pending_task_count > 0
        ? <span className="badge badge-warn">{w.pending_task_count}/{w.task_count}</span>
        : <>{w.task_count}</>),
      disa: (w) => `${w.pending_task_count}/${w.task_count}`,
    },
    kolonAd<WorkOrder>('assignee_name', 'Atanan'),
    kolonSayi<WorkOrder>('downtime_minutes', 'Duruş (dk)', { gizli: true }),
    kolonPara<WorkOrder>('total_cost', 'Maliyet', { kalin: true }),
  ];

  return (
    <>
      <ErrorBox error={error} />
      <ResourceList<WorkOrder>
        key={tazele}
        kicker="Bakım · İş Emirleri"
        baslik="İş Emirleri"
        altBaslik="Periyodik ve arıza kaynaklı iş emirleri, gecikme ve maliyet."
        yol="/maintenance/work-orders"
        aramaYer="İş emri no, konu, ekipman…"
        varsayilanSirala={{ kolon: 'reported_at', yon: 'desc' }}
        kolonlar={kolonlar}
        satirYolu={(w) => `/maintenance/work-orders/${w.id}`}
        yazmaIzni="maintenance.workorder.create"
        silmeIzni="maintenance.workorder.delete.all"
        yetenekler={[
          { simge: Wrench, etiket: 'Görev', deger: 'Kontrol listesi' },
          { simge: Boxes, etiket: 'Parça', deger: 'Stoktan düşer' },
          { simge: Timer, etiket: 'Duruş', deger: 'Süre kaydedilir' },
          { simge: Coins, etiket: 'Maliyet', deger: 'İşçilik + parça + servis' },
          { simge: Lock, etiket: 'Kilit', deger: 'Tamamlanan iş emri donar' },
        ]}
        sayimlar={(t, rows) => [
          { deger: t, etiket: 'iş emri' },
          { deger: rows.filter((w) => (w.overdue_days ?? 0) > 0).length, etiket: 'gecikmiş' },
        ]}
        birincilEylem={can('maintenance.workorder.create') ? (
          <button className="btn" disabled={busy} aria-busy={busy} onClick={() => void generate()}>
            {busy ? 'Üretiliyor…' : 'Periyodikleri üret'}
          </button>
        ) : null}
        gostergeler={(rows) => {
          if (rows.length === 0) return null;
          const overdue = rows.filter((w) => (w.overdue_days ?? 0) > 0);
          const enUzun = overdue.reduce((m, w) => Math.max(m, Number(w.overdue_days ?? 0)), 0);
          const devam = rows.filter((w) => w.status === 'in_progress');
          const planli = rows.filter((w) => w.status === 'scheduled');
          return (
            <div className="grid grid-4">
              <Stat label="Vadesi geçen" value={overdue.length}
                    hint={overdue.length === 0 ? 'Gecikmiş iş emri yok'
                      : `En uzunu ${enUzun} gündür bekliyor`} />
              <Stat label="Devam eden" value={devam.length}
                    hint={devam.length === 0 ? 'Devam eden iş yok' : 'Ekipman bakımda olabilir'} />
              <Stat label="Planlanmış" value={planli.length}
                    hint={planli.length === 0 ? 'Planlı iş yok' : 'Henüz başlamadı'} />
              <Stat label="Listelenen maliyet"
                    value={money(rows.reduce((t, w) => t + Number(w.total_cost || 0), 0))}
                    hint={`${rows.length} iş emri`} />
            </div>
          );
        }}
        bosBaslik="İş emri yok"
        bosMetin="İş emri ya bir arıza bildiriminden ya da bakım planının vadesi geldiğinde kendiliğinden doğar. “Periyodikleri üret” diyerek vadesi gelen planlar için iş emirlerini toplu açabilirsiniz."
        dipnot={<span>Tamamlanan iş emri kilitlenir; sayaç değeri o anda dondurulur.</span>}
      />
    </>
  );
}

const WO_KIND: Record<string, string> = {
  preventive: 'Periyodik', corrective: 'Arıza', inspection: 'Kontrol',
};

export function WorkOrderDetail() {
  const { id } = useParams();
  const { can } = useSession();
  const doc = useItem<WorkOrder & { tasks: Task[]; parts: Part[]; description?: string; resolution?: string }>(
    id ? `/maintenance/work-orders/${id}/full` : null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);

  const act = async (action: string, body?: unknown) => {
    setBusy(true); setError(null);
    try {
      await api.post(`/maintenance/work-orders/${id}/${action}`, body);
      await doc.reload();
    } catch (err) { setError(err); } finally { setBusy(false); }
  };

  const toggleTask = async (t: Task) => {
    setError(null);
    try {
      await api.patch(`/maintenance/work-order-tasks/${t.id}`, { is_done: !t.is_done });
      await doc.reload();
    } catch (err) { setError(err); }
  };

  if (doc.loading) return <div className="empty">Yükleniyor…</div>;
  if (!doc.data) return <ErrorBox error={doc.error ?? 'İş emri bulunamadı'} />;
  const d = doc.data;
  const editable = d.status !== 'done' && d.status !== 'cancelled';

  return (
    <>
      <PageHead
        title={`İş Emri ${d.number ?? '(taslak)'}`}
        subtitle={<>
          <StatusBadge status={d.status} /> · {d.equipment_name} ({d.equipment_code})
          {d.plan_name && <> · {d.plan_name}</>}
        </>}
        actions={
          <span className="row" style={{ gap: 8 }}>
            {d.status === 'scheduled' && (
              <button className="btn" disabled={busy} onClick={() => act('start')}>Başlat</button>
            )}
            {editable && can('maintenance.workorder.complete') && (
              <button className="btn btn-primary" disabled={busy || d.pending_task_count > 0}
                      title={d.pending_task_count > 0 ? 'Önce tüm görevleri işaretleyin' : undefined}
                      onClick={() => {
                        const resolution = window.prompt('Yapılan işlem:') ?? undefined;
                        const dt = window.prompt('Ekipmanın durduğu süre (dakika):', '0');
                        void act('complete', {
                          resolution,
                          downtime_minutes: dt === null ? undefined : Number(dt),
                        });
                      }}>
                Tamamla
              </button>
            )}
            <Link className="btn" to="/maintenance/work-orders">Listeye dön</Link>
          </span>
        }
      />
      <ErrorBox error={error} />

      {d.description && <Card title="Açıklama">{d.description}</Card>}
      {d.resolution && <Card title="Yapılan işlem">{d.resolution}</Card>}

      <div className="grid grid-2">
        {/* Görevler doğrudan listede işaretlenir: teknisyen makine başında
            tek tek onaylar, her görev için ayrı ekrana girmez. */}
        <Card title={`Görevler — ${d.task_count - d.pending_task_count}/${d.task_count}`} padded={false}>
          <div className="tbl-wrap">
            <table className="tbl">
              <tbody>
                {(d.tasks ?? []).map((t) => (
                  <tr key={t.id}>
                    <td style={{ width: 40 }}>
                      <input type="checkbox" style={{ width: 'auto' }}
                             checked={t.is_done} disabled={!editable}
                             onChange={() => void toggleTask(t)} />
                    </td>
                    <td>
                      <span style={{ textDecoration: t.is_done ? 'line-through' : undefined }}>
                        {t.name}
                      </span>
                      {t.instructions && (
                        <div className="muted" style={{ fontSize: 11 }}>{t.instructions}</div>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            {(d.tasks ?? []).length === 0 && <Empty>Görev yok</Empty>}
          </div>
        </Card>

        <Card title="Kullanılan parçalar" padded={false}>
          <div className="tbl-wrap">
            <table className="tbl">
              <thead>
                <tr><th>Parça</th><th className="r">Adet</th><th className="r">Birim</th>
                    <th className="r">Tutar</th><th>Stok</th></tr>
              </thead>
              <tbody>
                {(d.parts ?? []).map((p) => (
                  <tr key={p.id}>
                    <td>{p.product_name}<span className="muted"> · {p.sku}</span></td>
                    <td className="r">{num(p.quantity)}</td>
                    <td className="r">{money(p.unit_cost)}</td>
                    <td className="r">{money(p.total_cost)}</td>
                    <td>
                      {p.stock_issued
                        ? <span className="badge badge-ok">düşüldü</span>
                        : <span className="badge badge-warn">bekliyor</span>}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            {(d.parts ?? []).length === 0 && <Empty>Parça kullanılmadı</Empty>}
          </div>
          <div className="row" style={{ justifyContent: 'space-between', marginTop: 12 }}>
            <span className="muted">Toplam maliyet</span>
            <strong>{money(d.total_cost)}</strong>
          </div>
        </Card>
      </div>
    </>
  );
}

// =============================================================================
// Bakım raporları
// =============================================================================
export function MaintenanceReports() {
  const due = useList<{
    plan_code: string; plan_name: string; equipment_code: string; equipment_name: string;
    branch_id?: string; is_critical: boolean; due_date?: string; days_left?: number;
    usage_since_service?: string; interval_usage?: string;
  }>('/maintenance/reports/due-plans');

  const rel = useList<{
    equipment_id: string; code: string; name: string; category?: string;
    branch_name?: string; is_critical: boolean; purchase_cost?: string;
    service_count: number; breakdown_count: number; total_cost: string;
    total_downtime_minutes: number; mean_days_between_failures?: string;
    cost_vs_purchase_pct?: string;
  }>('/maintenance/reports/reliability');

  // Rapor sayfasının baş rakamı da bir karar rakamıdır: VADESİ GELEN bakım,
  // yani şimdi iş emri açılması gerekenler. Güvenilirlik tablosu geçmişi
  // anlatır; bant bugünü.
  const gecikmis = due.data.filter((d) => (d.days_left ?? 0) < 0);
  const kritikDue = due.data.filter((d) => d.is_critical);
  const arizaSayisi = rel.data.reduce((t, r) => t + Number(r.breakdown_count || 0), 0);
  const durusDk = rel.data.reduce((t, r) => t + Number(r.total_downtime_minutes || 0), 0);

  return (
    <>
      <PageHead kicker="Bakım" title="Bakım Raporları"
                subtitle="Vadesi yaklaşan bakımlar ve ekipman güvenilirliği." />
      <ErrorBox error={due.error ?? rel.error} />

      <div className="grid grid-4">
        <Stat label="Vadesi gelen bakım" value={due.data.length}
              hint={gecikmis.length === 0 ? 'Geciken yok' : `${gecikmis.length} tanesi gecikmiş`} />
        <Stat label="Kritik ekipmanda" value={kritikDue.length}
              hint={kritikDue.length === 0 ? 'Kritik ekipman vadesinde değil' : 'Önce bunlar planlanmalı'} />
        <Stat label="Toplam arıza" value={arizaSayisi}
              hint={`${rel.data.length} ekipman izleniyor`} />
        <Stat label="Toplam duruş" value={`${num(durusDk / 60)} saat`}
              hint={durusDk === 0 ? 'Duruş kaydı yok' : 'Arıza kaynaklı'} />
      </div>

      <Card title="Vadesi yaklaşan bakımlar" padded={false}>
        <div className="tbl-wrap">
          <table className="tbl">
            <thead>
              <tr>
                <th>Ekipman</th><th>Plan</th><th>Vade</th><th className="r">Kalan gün</th>
                <th className="r">Sayaç (son bakımdan)</th>
              </tr>
            </thead>
            <tbody>
              {due.data.map((d, i) => (
                <tr key={i}>
                  <td>
                    {d.equipment_name}
                    {d.is_critical && (
                      <span className="badge badge-danger" style={{ marginLeft: 6 }}>kritik</span>
                    )}
                    <div className="muted" style={{ fontSize: 11 }}>{d.equipment_code}</div>
                  </td>
                  <td>{d.plan_name}</td>
                  <td>{d.due_date ? date(d.due_date) : '—'}</td>
                  <td className="r">
                    {d.days_left === null || d.days_left === undefined ? '—' : (
                      <span className={`badge ${d.days_left < 0 ? 'badge-danger'
                        : d.days_left <= 7 ? 'badge-warn' : ''}`}>
                        {d.days_left < 0 ? `${Math.abs(d.days_left)} gün geçti` : `${d.days_left} gün`}
                      </span>
                    )}
                  </td>
                  <td className="r">
                    {d.usage_since_service
                      ? <>{num(d.usage_since_service)}{d.interval_usage && ` / ${num(d.interval_usage)}`}</>
                      : '—'}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          {!due.loading && due.data.length === 0 && <Empty>Tanımlı bakım planı yok</Empty>}
        </div>
      </Card>

      {/* Yenileme kararının verildiği tablo: bakım maliyeti alım bedeline
          yaklaşıyorsa makineyi tamir etmek yerine değiştirmek gerekir. */}
      <Card title="Ekipman güvenilirliği" padded={false}>
        <div className="tbl-wrap">
          <table className="tbl">
            <thead>
              <tr>
                <th>Ekipman</th><th>Şube</th><th className="r">Bakım</th><th className="r">Arıza</th>
                <th className="r">Arızalar arası</th><th className="r">Toplam maliyet</th>
                <th className="r">Alım bedelinin %</th><th className="r">Duruş</th>
              </tr>
            </thead>
            <tbody>
              {rel.data.map((r) => (
                <tr key={r.equipment_id}>
                  <td>
                    {r.name}
                    <div className="muted" style={{ fontSize: 11 }}>{r.code}</div>
                  </td>
                  <td>{r.branch_name ?? '—'}</td>
                  <td className="r">{r.service_count}</td>
                  <td className="r">
                    {r.breakdown_count > 0
                      ? <span className="badge badge-warn">{r.breakdown_count}</span> : '—'}
                  </td>
                  <td className="r">
                    {r.mean_days_between_failures ? `${num(r.mean_days_between_failures)} gün` : '—'}
                  </td>
                  <td className="r">{money(r.total_cost)}</td>
                  <td className="r">
                    {r.cost_vs_purchase_pct === null || r.cost_vs_purchase_pct === undefined ? '—' : (
                      <span className={`badge ${Number(r.cost_vs_purchase_pct) >= 50 ? 'badge-danger'
                        : Number(r.cost_vs_purchase_pct) >= 25 ? 'badge-warn' : ''}`}>
                        %{num(r.cost_vs_purchase_pct)}
                      </span>
                    )}
                  </td>
                  <td className="r">
                    {r.total_downtime_minutes > 0
                      ? `${Math.round(r.total_downtime_minutes / 60)} sa` : '—'}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          {!rel.loading && rel.data.length === 0 && (
            <Empty title="Veri yok">Henüz güvenilirlik geçmişi oluşmamış.</Empty>
          )}
        </div>
      </Card>

      <PageFoot>
        <span><strong>{rel.data.length}</strong> ekipman izleniyor</span>
        <span><strong>{due.data.length}</strong> bakım vadesi geldi</span>
        <span>Vade hem takvimden hem sayaçtan hesaplanır; hangisi önce gelirse iş emri o zaman açılır.</span>
      </PageFoot>
    </>
  );
}
