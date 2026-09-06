import { useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { api } from '../api/client';
import { useItem, useList } from '../ui/useResource';
import { Card, Empty, ErrorBox, PageFoot, PageHead, Stat, StatusBadge } from '../ui';
import { Boxes, Building2, ClipboardCheck, Coins, FileClock, ReceiptText, Truck } from 'lucide-react';
import { ResourceList, type Kolon } from '../ui/ResourceList';
import { kolonAd, kolonBelgeNo, kolonCari, kolonDurum, kolonPara, kolonSayi, kolonTarih } from '../ui/kolonlar';
import { money, date, num } from '../i18n';
import { useSession } from '../api/session';

interface Requisition {
  id: string; number?: string; request_date: string; needed_by?: string; status: string;
  currency: string; total: string; suggested_partner_id?: string; suggested_partner_name?: string;
  justification?: string; approver_name?: string; branch_name?: string; owner_name?: string;
  line_count: number;
}

interface PurchaseOrder {
  id: string; number?: string; partner_id: string; partner_name: string;
  requisition_number?: string; order_date: string; promised_date?: string; status: string;
  currency: string; subtotal: string; tax_total: string; total: string;
  branch_name?: string; line_count: number; received_pct: string;
}

interface Receipt {
  id: string; number?: string; order_id: string; order_number?: string; partner_name: string;
  receipt_date: string; status: string; waybill_no?: string; total_quantity: string;
  rejected_quantity: string; delay_days?: number; branch_name?: string;
}

interface DocLine {
  id: string; sequence: number; description: string; quantity: string; unit_price: string;
  discount_pct: string; line_total: string; sku?: string; uom_code?: string;
  received_quantity?: string;
}

// =============================================================================
// Satın alma talepleri
// =============================================================================
/**
 * Satın alma talepleri.
 *
 * BAŞ RAKAM ONAY BEKLEYEN TUTARDIR. Bu ekran bir arşiv değil bir kuyruktur;
 * buraya bakan kişi kendi onayını bekleyen işi arar, geçmiş taleplerin
 * toplamını değil.
 *
 * SATIR İÇİ EYLEM DEVAM EDERKEN DÜĞME SÖNDÜRÜLMEZ, etiketi değişir. Sönük
 * düğme "bunu yapamazsın" der; oysa olan şey "bu yapılıyor"dur. `disabled`
 * yalnızca çift gönderimi engellemek için kalır, `aria-busy` ile birlikte
 * görünüm tam güçte tutulur.
 */
export function RequisitionList() {
  const { can } = useSession();
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<unknown>(null);
  const suppliers = useList<{ id: string; name: string }>('/core/partners', {
    is_supplier: 'true', limit: 200,
  });
  const canApprove = can('purchasing.requisition.approve');

  const act = async (id: string, action: string, yenile: () => Promise<void>, body?: unknown) => {
    setBusy(id); setError(null);
    try {
      await api.post(`/purchasing/requisitions/${id}/${action}`, body);
      await yenile();
    } catch (err) { setError(err); } finally { setBusy(null); }
  };

  const topla = (xs: Requisition[]) => xs.reduce((t, r) => t + Number(r.total || 0), 0);

  const kolonlar: Kolon<Requisition>[] = [
    kolonBelgeNo<Requisition>('No'),
    kolonTarih<Requisition>('request_date', 'Tarih'),
    kolonTarih<Requisition>('needed_by', 'İhtiyaç tarihi'),
    {
      anahtar: 'justification', baslik: 'Gerekçe', suz: 'metin',
      govde: (r) => <span className="muted">{r.justification ?? '—'}</span>,
      disa: (r) => r.justification ?? '',
    },
    kolonAd<Requisition>('branch_name', 'Şube'),
    kolonAd<Requisition>('owner_name', 'Talep eden'),
    kolonDurum<Requisition>([
      { deger: 'draft', etiket: 'Taslak' },
      { deger: 'pending', etiket: 'Onay bekliyor' },
      { deger: 'approved', etiket: 'Onaylandı' },
      { deger: 'rejected', etiket: 'Reddedildi' },
      { deger: 'ordered', etiket: 'Sipariş edildi' },
    ]),
    kolonSayi<Requisition>('line_count', 'Kalem', { gizli: true }),
    kolonPara<Requisition>('total', 'Tutar', { kalin: true }),
  ];

  return (
    <>
      <ErrorBox error={error} />
      <ResourceList<Requisition>
        kicker="Satın Alma · Talepler"
        baslik="Satın Alma Talepleri"
        altBaslik="Onay kuyruğu, onaylanan talepler ve sipariş açılışı."
        yol="/purchasing/requisitions"
        aramaYer="Talep no, gerekçe…"
        varsayilanSirala={{ kolon: 'request_date', yon: 'desc' }}
        kolonlar={kolonlar}
        satirYolu={(r) => `/purchasing/requisitions/${r.id}`}
        yazmaIzni="purchasing.requisition.create"
        silmeIzni="purchasing.requisition.delete.all"
        yetenekler={[
          { simge: ClipboardCheck, etiket: 'Onay', deger: 'Kademeli yetki' },
          { simge: Truck, etiket: 'Sipariş', deger: 'Onaydan doğar' },
          { simge: Coins, etiket: 'Çoklu para', deger: 'Talep bazında' },
          { simge: Building2, etiket: 'Şube', deger: 'Kendi şubeniz' },
          { simge: FileClock, etiket: 'İz', deger: 'Ret gerekçesi saklanır' },
        ]}
        sayimlar={(t, rows) => [
          { deger: t, etiket: 'talep' },
          { deger: rows.filter((r) => r.status === 'pending').length, etiket: 'onay bekliyor' },
        ]}
        satirEylem={(r, yenile) => {
          const calisiyor = busy === r.id;
          return (
            <>
              {r.status === 'draft' && (
                <button className="btn btn-sm" disabled={calisiyor} aria-busy={calisiyor}
                        onClick={() => void act(r.id, 'submit', yenile)}>
                  {calisiyor ? 'Gönderiliyor…' : 'Onaya gönder'}
                </button>
              )}
              {r.status === 'pending' && canApprove && (
                <>
                  <button className="btn btn-sm btn-primary" disabled={calisiyor} aria-busy={calisiyor}
                          onClick={() => void act(r.id, 'approve', yenile)}>
                    {calisiyor ? 'Onaylanıyor…' : 'Onayla'}
                  </button>
                  <button className="btn btn-sm" disabled={calisiyor} aria-busy={calisiyor}
                          onClick={() => {
                            const reason = window.prompt('Ret gerekçesi:');
                            if (reason !== null) void act(r.id, 'reject', yenile, { reason });
                          }}>Reddet</button>
                </>
              )}
              {r.status === 'approved' && can('purchasing.order.create') && (
                <select className="satir-secim" defaultValue="" disabled={calisiyor}
                        aria-label="Tedarikçi seçerek sipariş aç"
                        onChange={(e) => {
                          if (e.target.value) {
                            void act(r.id, 'create-order', yenile, { partner_id: e.target.value });
                          }
                        }}>
                  <option value="">Tedarikçi seç → sipariş aç</option>
                  {suppliers.data.map((sup) => (
                    <option key={sup.id} value={sup.id}>{sup.name}</option>
                  ))}
                </select>
              )}
            </>
          );
        }}
        gostergeler={(rows) => {
          if (rows.length === 0) return null;
          const pb = rows[0]?.currency ?? 'TRY';
          const bekleyen = rows.filter((r) => r.status === 'pending');
          const onaylanan = rows.filter((r) => r.status === 'approved');
          const taslak = rows.filter((r) => r.status === 'draft');
          return (
            <div className="grid grid-4">
              <Stat label="Onay bekleyen tutar" value={money(topla(bekleyen), pb)}
                    hint={bekleyen.length === 0 ? 'Onay kuyruğu boş' : `${bekleyen.length} talep`} />
              <Stat label="Onaylanan" value={onaylanan.length}
                    hint={onaylanan.length === 0 ? 'Sipariş açılacak talep yok' : money(topla(onaylanan), pb)} />
              <Stat label="Taslak" value={taslak.length}
                    hint={taslak.length === 0 ? 'Taslak yok' : 'Henüz onaya gönderilmedi'} />
              <Stat label="Listelenen toplam" value={money(topla(rows), pb)}
                    hint={`${rows.length} talep`} />
            </div>
          );
        }}
        bosBaslik="Bekleyen talep yok"
        bosMetin="Satın alma talebi, ihtiyacı olan kişinin açtığı kayıttır. Onaylandığında tedarikçi seçilerek siparişe dönüşür; mal kabulünde stok girişi ve alış faturası taslağı kendiliğinden oluşur."
        dipnot={canApprove ? undefined
          : <span>Onaylama yetkiniz yok; talepleri yalnızca izleyebilirsiniz.</span>}
      />
    </>
  );
}

export function RequisitionDetail() {
  const { id } = useParams();
  const doc = useItem<Requisition & { lines: DocLine[] }>(
    id ? `/purchasing/requisitions/${id}/full` : null);

  if (doc.loading) return <div className="empty">Yükleniyor…</div>;
  if (!doc.data) return <ErrorBox error={doc.error ?? 'Talep bulunamadı'} />;
  const d = doc.data;

  return (
    <>
      <PageHead kicker="Satın Alma"         title={`Talep ${d.number ?? '(taslak)'}`}
        subtitle={<><StatusBadge status={d.status} /> · {d.branch_name ?? '—'} · {date(d.request_date)}</>}
        actions={<Link className="btn" to="/purchasing/requisitions">Listeye dön</Link>}
      />
      {d.justification && <Card title="Gerekçe">{d.justification}</Card>}
      <Card title="Satırlar" padded={false}>
        <div className="tbl-wrap">
          <table className="tbl">
            <thead>
              <tr>
                <th>#</th><th>Ürün</th><th className="r">Miktar</th>
                <th className="r">Tahmini fiyat</th><th className="r">Tutar</th>
              </tr>
            </thead>
            <tbody>
              {(d.lines ?? []).map((l) => (
                <tr key={l.id}>
                  <td>{l.sequence}</td>
                  <td>{l.description}{l.sku && <span className="muted"> · {l.sku}</span>}</td>
                  <td className="r">{num(l.quantity)} {l.uom_code ?? ''}</td>
                  <td className="r">{money(l.unit_price, d.currency)}</td>
                  <td className="r">{money(l.line_total, d.currency)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Card>
    </>
  );
}

// =============================================================================
// Siparişler
// =============================================================================
/**
 * Satın alma siparişleri.
 *
 * KOMPOZİSYON: baş rakam MAL KABULÜ BEKLEYEN tutardır (onaylanan + kısmen
 * teslim alınan). Bu ekranın varlık sebebi "ne sipariş ettik"ten çok
 * "ne gelmedi"dir; gelen mal zaten stoğa ve alış faturasına dönüşmüştür.
 *
 * Geciken sipariş ayrı bir gösterge: söz verilen tarih tabloda bir kolon
 * olarak duruyordu ve gecikme yalnızca satır satır bakınca görülüyordu.
 */
/**
 * Satın alma siparişleri.
 *
 * BAŞ RAKAM MAL KABULÜ BEKLEYEN TUTARDIR: sipariş ekranına bakan kişi
 * "ne kadar sipariş verdik"i değil, "ne kadar hâlâ gelmedi"yi arar.
 *
 * GECİKME AYRI BİR GÖSTERGE: söz verilen tarihi geçmiş sipariş, bekleyen
 * tutarın içinde eridiğinde kimse fark etmez.
 */
export function PurchaseOrderList() {
  const bugun = new Date(); bugun.setHours(0, 0, 0, 0);
  const gecikmis = (o: PurchaseOrder) =>
    ['confirmed', 'partially_received'].includes(o.status)
    && o.promised_date != null && new Date(o.promised_date) < bugun;
  const topla = (xs: PurchaseOrder[]) => xs.reduce((t, o) => t + Number(o.total || 0), 0);

  const kolonlar: Kolon<PurchaseOrder>[] = [
    kolonBelgeNo<PurchaseOrder>('No'),
    kolonCari<PurchaseOrder>('partner_name', 'Tedarikçi'),
    kolonTarih<PurchaseOrder>('order_date', 'Sipariş tarihi'),
    {
      anahtar: 'promised_date', baslik: 'Söz verilen', sirala: true,
      govde: (o) => (gecikmis(o)
        ? <span className="badge badge-danger">{date(o.promised_date)} · gecikti</span>
        : date(o.promised_date)),
      disa: (o) => o.promised_date ?? '',
    },
    kolonDurum<PurchaseOrder>([
      { deger: 'draft', etiket: 'Taslak' },
      { deger: 'confirmed', etiket: 'Onaylandı' },
      { deger: 'partially_received', etiket: 'Kısmen teslim alındı' },
      { deger: 'received', etiket: 'Teslim alındı' },
      { deger: 'cancelled', etiket: 'İptal' },
    ]),
    {
      anahtar: 'received_pct', baslik: 'Teslim', hizala: 'sag',
      // ORAN ÇUBUĞU rakamdan önce okunur: uzun listede gözün tutunacağı
      // değişken budur.
      govde: (o) => {
        const p = Math.max(0, Math.min(100, Number(o.received_pct || 0)));
        return (
          <>
            <span className="meter"><span className="meter-fill" style={{ inlineSize: `${p}%` }} /></span>
            %{num(p, 0)}
          </>
        );
      },
      disa: (o) => o.received_pct,
    },
    kolonSayi<PurchaseOrder>('line_count', 'Kalem', { gizli: true }),
    kolonPara<PurchaseOrder>('subtotal', 'Ara toplam', { gizli: true }),
    kolonPara<PurchaseOrder>('tax_total', 'KDV', { gizli: true }),
    kolonPara<PurchaseOrder>('total', 'Toplam', { kalin: true }),
    kolonAd<PurchaseOrder>('branch_name', 'Şube', { gizli: true }),
  ];

  return (
    <ResourceList<PurchaseOrder>
      kicker="Satın Alma · Siparişler"
      baslik="Satın Alma Siparişleri"
      altBaslik="Tedarikçiye açılan siparişler, teslim durumu ve gecikmeler."
      yol="/purchasing/orders"
      aramaYer="Sipariş no, tedarikçi, tedarikçi referansı…"
      varsayilanSirala={{ kolon: 'order_date', yon: 'desc' }}
      kolonlar={kolonlar}
      satirYolu={(o) => `/purchasing/orders/${o.id}`}
      yazmaIzni="purchasing.order.create"
      silmeIzni="purchasing.order.delete.all"
      yetenekler={[
        { simge: Truck, etiket: 'Mal kabul', deger: 'Kısmi teslim izlenir' },
        { simge: Boxes, etiket: 'Stok', deger: 'Kabulde giriş yapar' },
        { simge: ReceiptText, etiket: 'Fatura', deger: 'Taslak kendiliğinden' },
        { simge: Coins, etiket: 'Çoklu para', deger: 'Sipariş bazında' },
        { simge: ClipboardCheck, etiket: 'Kaynak', deger: 'Onaylı talepten' },
      ]}
      sayimlar={(t, rows) => [
        { deger: t, etiket: 'sipariş' },
        { deger: rows.filter(gecikmis).length, etiket: 'geciken' },
      ]}
      gostergeler={(rows) => {
        if (rows.length === 0) return null;
        const pb = rows[0]?.currency ?? 'TRY';
        const bekleyen = rows.filter((o) => ['confirmed', 'partially_received'].includes(o.status));
        const geciken = bekleyen.filter(gecikmis);
        const teslim = rows.filter((o) => o.status === 'received');
        return (
          <div className="grid grid-4">
            <Stat label="Mal kabulü bekleyen" value={money(topla(bekleyen), pb)}
                  hint={bekleyen.length === 0 ? 'Bekleyen sipariş yok' : `${bekleyen.length} sipariş`} />
            <Stat label="Söz verilen tarihi geçen" value={geciken.length}
                  hint={geciken.length === 0 ? 'Geciken sipariş yok' : money(topla(geciken), pb)} />
            <Stat label="Teslim alındı" value={teslim.length} hint={money(topla(teslim), pb)} />
            <Stat label="Listelenen toplam" value={money(topla(rows), pb)} hint={`${rows.length} sipariş`} />
          </div>
        );
      }}
      bosBaslik="Açık sipariş yok"
      bosMetin="Sipariş, onaylanmış bir satın alma talebine tedarikçi seçilerek açılır. Mal kabulü onaylandığında stok girişi ve alış faturası taslağı kendiliğinden oluşur."
      dipnot={<span>Teslim oranı kabul edilen miktarın sipariş miktarına oranıdır.</span>}
    />
  );
}

export function PurchaseOrderDetail() {
  const { id } = useParams();
  const { can } = useSession();
  const doc = useItem<PurchaseOrder & { lines: DocLine[] }>(
    id ? `/purchasing/orders/${id}/full` : null);
  const receipts = useList<Receipt>('/purchasing/receipts', { order_id: id, limit: 50 });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);

  const act = async (action: string, body?: unknown) => {
    setBusy(true); setError(null);
    try {
      await api.post(`/purchasing/orders/${id}/${action}`, body);
      await doc.reload();
    } catch (err) { setError(err); } finally { setBusy(false); }
  };

  if (doc.loading) return <div className="empty">Yükleniyor…</div>;
  if (!doc.data) return <ErrorBox error={doc.error ?? 'Sipariş bulunamadı'} />;
  const d = doc.data;

  return (
    <>
      <PageHead kicker="Satın Alma"         title={`Sipariş ${d.number ?? '(taslak)'}`}
        subtitle={<>
          <StatusBadge status={d.status} /> · {d.partner_name} · {date(d.order_date)}
          {d.requisition_number && <> · talep {d.requisition_number}</>}
        </>}
        actions={
          <span className="row" style={{ gap: 8 }}>
            {d.status === 'draft' && can('purchasing.order.confirm') && (
              <button className="btn btn-primary" disabled={busy}
                      onClick={() => act('confirm')}>Siparişi onayla</button>
            )}
            {(d.status === 'draft' || d.status === 'confirmed') && (
              <button className="btn" disabled={busy} onClick={() => {
                const reason = window.prompt('İptal gerekçesi:');
                if (reason !== null) void act('cancel', { reason });
              }}>İptal et</button>
            )}
            <Link className="btn" to="/purchasing/orders">Listeye dön</Link>
          </span>
        }
      />
      <ErrorBox error={error} />

      <Card title="Satırlar" padded={false}>
        <div className="tbl-wrap">
          <table className="tbl">
            <thead>
              <tr>
                <th>#</th><th>Ürün</th><th className="r">Sipariş</th><th className="r">Teslim alınan</th>
                <th className="r">Birim fiyat</th><th className="r">İskonto</th><th className="r">Tutar</th>
              </tr>
            </thead>
            <tbody>
              {(d.lines ?? []).map((l) => {
                const pending = Number(l.quantity) - Number(l.received_quantity ?? 0);
                return (
                  <tr key={l.id}>
                    <td>{l.sequence}</td>
                    <td>{l.description}{l.sku && <span className="muted"> · {l.sku}</span>}</td>
                    <td className="r">{num(l.quantity)} {l.uom_code ?? ''}</td>
                    <td className="r">
                      {num(l.received_quantity ?? 0)}
                      {pending > 0 && (
                        <div className="muted" style={{ fontSize: 11 }}>{num(pending)} bekliyor</div>
                      )}
                    </td>
                    <td className="r">{money(l.unit_price, d.currency)}</td>
                    <td className="r">{Number(l.discount_pct) > 0 ? `%${num(l.discount_pct)}` : '—'}</td>
                    <td className="r"><strong>{money(l.line_total, d.currency)}</strong></td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </Card>

      <Card title="Mal kabuller" padded={false}>
        <div className="tbl-wrap">
          <table className="tbl">
            <thead>
              <tr>
                <th>No</th><th>Tarih</th><th>İrsaliye</th><th>Durum</th>
                <th className="r">Gelen</th><th className="r">Reddedilen</th><th className="r">Gecikme</th>
              </tr>
            </thead>
            <tbody>
              {receipts.data.map((r) => (
                <tr key={r.id}>
                  <td><strong>{r.number ?? 'Taslak'}</strong></td>
                  <td>{date(r.receipt_date)}</td>
                  <td>{r.waybill_no ?? '—'}</td>
                  <td><StatusBadge status={r.status} /></td>
                  <td className="r">{num(r.total_quantity)}</td>
                  <td className="r">
                    {Number(r.rejected_quantity) > 0
                      ? <span className="badge badge-danger">{num(r.rejected_quantity)}</span>
                      : '—'}
                  </td>
                  <td className="r">
                    {r.delay_days === undefined || r.delay_days === null ? '—'
                      : r.delay_days > 0 ? <span className="badge badge-warn">{r.delay_days} gün geç</span>
                      : <span className="muted">zamanında</span>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          {!receipts.loading && receipts.data.length === 0 && <Empty>Henüz mal kabul yok</Empty>}
        </div>
      </Card>
    </>
  );
}

// =============================================================================
// Tedarikçi performansı
// =============================================================================
export function SupplierPerformance() {
  const perf = useList<{
    partner_id: string; partner_name: string; order_count: number; receipt_count: number;
    total_spend: string; currency: string; avg_lead_days?: string; on_time_pct?: string;
    rejection_pct?: string; last_receipt_date?: string;
  }>('/purchasing/reports/supplier-performance');

  const open = useList<{
    id: string; number?: string; partner_name: string; promised_date?: string;
    pending_quantity: string; overdue_days?: number; total: string; currency: string;
  }>('/purchasing/reports/open-orders');

  // LİDER ZAMANINDA TESLİM ORANI: tedarikçi sayısı bir envanter rakamıdır.
  // Bu ekranın sorusu "kaç tedarikçimiz var" değil, "söz verdiklerini
  // tutuyorlar mı"dır. Harcama tutarı hemen yanında durur çünkü kötü
  // performansın maliyeti ancak onunla tartılır.
  const totalSpend = perf.data.reduce((t, r) => t + Number(r.total_spend ?? 0), 0);
  const geciken = open.data.filter((o) => (o.overdue_days ?? 0) > 0);
  const oranli = perf.data.filter((r) => r.on_time_pct != null);
  const zamaninda = oranli.length === 0 ? null
    : Math.round(oranli.reduce((t, r) => t + Number(r.on_time_pct), 0) / oranli.length);
  const redli = perf.data.filter((r) => Number(r.rejection_pct ?? 0) > 0);

  return (
    <>
      <PageHead kicker="Satın Alma" title="Tedarikçi Performansı"
                subtitle="Teslim süresi, zamanında teslim oranı ve bekleyen siparişler." />
      <ErrorBox error={perf.error ?? open.error} />
      <div className="grid grid-4">
        <Stat label="Zamanında teslim" value={zamaninda === null ? '—' : `%${zamaninda}`}
              hint={oranli.length === 0 ? 'Ölçülecek teslimat yok' : `${oranli.length} tedarikçide`} />
        <Stat label="Toplam satın alma" value={money(totalSpend)}
              hint={`${perf.data.length} tedarikçi`} />
        <Stat label="Geciken teslimat" value={geciken.length}
              hint={geciken.length === 0 ? 'Geciken sipariş yok'
                : `${open.data.length} bekleyen teslimattan`} />
        <Stat label="Ret yaşanan tedarikçi" value={redli.length}
              hint={redli.length === 0 ? 'Mal kabulde ret yok' : 'Kalite kontrolde kalan sevkiyat'} />
      </div>

      <Card title="Tedarikçi karnesi" padded={false}>
        <div className="tbl-wrap">
          <table className="tbl">
            <thead>
              <tr>
                <th>Tedarikçi</th><th className="r">Sipariş</th><th className="r">Kabul</th>
                <th className="r">Toplam harcama</th><th className="r">Ort. teslim</th>
                <th className="r">Zamanında</th><th className="r">Ret oranı</th><th>Son teslimat</th>
              </tr>
            </thead>
            <tbody>
              {perf.data.map((r) => (
                <tr key={r.partner_id}>
                  <td><strong>{r.partner_name}</strong></td>
                  <td className="r">{r.order_count}</td>
                  <td className="r">{r.receipt_count}</td>
                  <td className="r">{money(r.total_spend, r.currency)}</td>
                  <td className="r">{r.avg_lead_days ? `${num(r.avg_lead_days)} gün` : '—'}</td>
                  <td className="r">
                    {r.on_time_pct === null || r.on_time_pct === undefined ? '—' : (
                      <span className={`badge ${Number(r.on_time_pct) >= 90 ? 'badge-ok'
                        : Number(r.on_time_pct) >= 70 ? 'badge-warn' : 'badge-danger'}`}>
                        %{num(r.on_time_pct)}
                      </span>
                    )}
                  </td>
                  <td className="r">
                    {r.rejection_pct === null || r.rejection_pct === undefined ? '—' : (
                      <span className={`badge ${Number(r.rejection_pct) === 0 ? 'badge-ok'
                        : Number(r.rejection_pct) <= 5 ? 'badge-warn' : 'badge-danger'}`}>
                        %{num(r.rejection_pct)}
                      </span>
                    )}
                  </td>
                  <td>{r.last_receipt_date ? date(r.last_receipt_date) : '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
          {!perf.loading && perf.data.length === 0 && <Empty>Henüz sipariş yok</Empty>}
        </div>
      </Card>

      <Card title="Bekleyen teslimatlar" padded={false}>
        <div className="tbl-wrap">
          <table className="tbl">
            <thead>
              <tr>
                <th>Sipariş</th><th>Tedarikçi</th><th>Söz verilen</th>
                <th className="r">Bekleyen miktar</th><th className="r">Gecikme</th><th className="r">Tutar</th>
              </tr>
            </thead>
            <tbody>
              {open.data.map((o) => (
                <tr key={o.id}>
                  <td><Link to={`/purchasing/orders/${o.id}`}><strong>{o.number}</strong></Link></td>
                  <td>{o.partner_name}</td>
                  <td>{o.promised_date ? date(o.promised_date) : '—'}</td>
                  <td className="r">{num(o.pending_quantity)}</td>
                  <td className="r">
                    {o.overdue_days ? <span className="badge badge-danger">{o.overdue_days} gün</span> : '—'}
                  </td>
                  <td className="r">{money(o.total, o.currency)}</td>
                </tr>
              ))}
            </tbody>
          </table>
          {!open.loading && open.data.length === 0 && (
            <Empty title="Bekleyen yok">Açık siparişlerin tamamı teslim alınmış.</Empty>
          )}
        </div>
      </Card>

      <PageFoot>
        <span><strong>{perf.data.length}</strong> tedarikçi izleniyor</span>
        <span>Toplam satın alma <strong>{money(totalSpend)}</strong></span>
        <span>Zamanında teslim, söz verilen tarih ile mal kabul tarihi karşılaştırılarak ölçülür.</span>
      </PageFoot>
    </>
  );
}
