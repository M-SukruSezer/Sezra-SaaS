import { useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { api } from '../api/client';
import { useItem } from '../ui/useResource';
import { Coins, FileText, GitBranch, Lock, Percent } from 'lucide-react';
import { Card, Empty, ErrorBox, PageHead, Stat, StatusBadge } from '../ui';
import { ResourceList, type Kolon } from '../ui/ResourceList';
import {
  DURUM_BELGE, DURUM_SIPARIS, kolonAd, kolonBelgeNo, kolonCari, kolonDurum,
  kolonGecen, kolonPara, kolonSayi, kolonTarih,
} from '../ui/kolonlar';
import { money, num } from '../i18n';
import { useSession } from '../api/session';
import type { SalesDocument } from '../api/types';

/** Belge listelerinin ortak toplamı: para alanları string gelir. */
const topla = (rows: SalesDocument[]) => rows.reduce((t, d) => t + Number(d.total || 0), 0);

/**
 * Teklif ve sipariş aynı belge yapısını paylaşır, dolayısıyla kolonları da
 * paylaşır. Değişen tek şey tarih alanının adı ve durum sözlüğü.
 */
function belgeKolonlari(
  tarihAlani: string, tarihBaslik: string,
  durumlar: { deger: string; etiket: string }[],
): Kolon<SalesDocument>[] {
  return [
    kolonBelgeNo<SalesDocument>('No'),
    kolonCari<SalesDocument>(),
    kolonTarih<SalesDocument>(tarihAlani, tarihBaslik),
    kolonDurum<SalesDocument>(durumlar),
    kolonSayi<SalesDocument>('line_count', 'Kalem', { basamak: 0 }),
    kolonPara<SalesDocument>('subtotal', 'Ara toplam'),
    kolonPara<SalesDocument>('tax_total', 'KDV'),
    kolonPara<SalesDocument>('withholding_total', 'Tevkifat', { gizli: true }),
    kolonPara<SalesDocument>('total', 'Toplam', { kalin: true }),
    kolonAd<SalesDocument>('owner_name', 'Sahibi', { gizli: true }),
    kolonGecen<SalesDocument>('created_at', 'Eklenme', false),
  ];
}

const BELGE_YETENEK = [
  { simge: FileText, etiket: 'Kalem', deger: 'Ürün · iskonto · KDV' },
  { simge: Coins, etiket: 'Çoklu para', deger: 'TRY · EUR · USD' },
  { simge: Percent, etiket: 'Tevkifat', deger: 'Oranlı hesaplanır' },
  { simge: Lock, etiket: 'Kilit', deger: 'Gönderilen belge donar' },
  { simge: GitBranch, etiket: 'Akış', deger: 'Teklif → sipariş → fatura' },
];

/**
 * Teklifler.
 *
 * BAŞ RAKAM MÜŞTERİDE BEKLEYEN TUTARDIR (taslak + gönderilmiş). Kapanmış
 * tekliflerin toplamı geçmiştir; bu ekranda aranan, hâlâ cevap bekleyen
 * paradır. Dönüşüm oranı yanında durur çünkü bekleyen tutarın ne kadarının
 * gerçeğe döndüğünü ancak o söyler.
 */
export function QuotationList() {
  return (
    <ResourceList<SalesDocument>
      kicker="CRM · Teklifler"
      baslik="Teklifler"
      altBaslik="Müşteriye gönderilen fiyat teklifleri ve akıbetleri."
      yol="/crm/quotations"
      aramaYer="Teklif no, cari, not…"
      varsayilanSirala={{ kolon: 'issue_date', yon: 'desc' }}
      kolonlar={belgeKolonlari('issue_date', 'Tarih', DURUM_BELGE)}
      satirYolu={(d) => `/crm/quotations/${d.id}`}
      yazmaIzni="crm.quotation.create"
      silmeIzni="crm.quotation.delete.all"
      yetenekler={BELGE_YETENEK}
      sayimlar={(t, rows) => [
        { deger: t, etiket: 'teklif' },
        { deger: rows.filter((d) => d.status === 'sent').length, etiket: 'gönderildi' },
        { deger: money(topla(rows), rows[0]?.currency ?? 'TRY'), etiket: 'listelenen tutar' },
      ]}
      gostergeler={(rows) => {
        if (rows.length === 0) return null;
        const pb = rows[0]?.currency ?? 'TRY';
        const bekleyen = rows.filter((d) => d.status === 'draft' || d.status === 'sent');
        const onaylanan = rows.filter((d) => d.status === 'accepted');
        const kapanan = rows.filter((d) => ['accepted', 'rejected', 'expired', 'cancelled'].includes(d.status));
        const donusum = kapanan.length === 0 ? null
          : Math.round((onaylanan.length / kapanan.length) * 100);
        return (
          <div className="grid grid-4">
            <Stat label="Müşteride bekleyen" value={money(topla(bekleyen), pb)}
                  hint={bekleyen.length === 0 ? 'Bekleyen teklif yok' : `${bekleyen.length} teklif`} />
            <Stat label="Onaylanan" value={onaylanan.length} hint={money(topla(onaylanan), pb)} />
            <Stat label="Dönüşüm oranı" value={donusum === null ? '—' : `%${donusum}`}
                  hint={kapanan.length === 0 ? 'Kapanmış teklif yok' : `${kapanan.length} kapanmış teklif`} />
            <Stat label="Listelenen toplam" value={money(topla(rows), pb)} hint={`${rows.length} teklif`} />
          </div>
        );
      }}
      bosBaslik="Henüz teklif yok"
      bosMetin="Teklif bir fırsattan doğar: fırsatı açıp kalemleri girdiğinizde teklif numaralanır, gönderildiğinde müşteriye kilitlenir ve onaylandığında kendiliğinden satış siparişine dönüşür."
      dipnot={<span>Gönderilen teklifin kalemleri kilitlenir; değişiklik yeni teklif gerektirir.</span>}
    />
  );
}

/**
 * Satış siparişleri.
 *
 * BAŞ RAKAM FATURALANMAYI BEKLEYEN TUTARDIR (onaylanan + teslim edilen).
 * Sipariş ekranına bakan kişi ciroyu değil, "onayladık ama daha paraya
 * dönmedi" kısmını arar -- teklifteki bekleyen tutarın sipariş tarafındaki
 * karşılığı budur.
 */
export function OrderList() {
  return (
    <ResourceList<SalesDocument>
      kicker="CRM · Satış Siparişleri"
      baslik="Satış Siparişleri"
      altBaslik="Onaylanan siparişler, teslimat ve faturalama durumu."
      yol="/crm/sale-orders"
      aramaYer="Sipariş no, cari, not…"
      varsayilanSirala={{ kolon: 'order_date', yon: 'desc' }}
      kolonlar={belgeKolonlari('order_date', 'Tarih', DURUM_SIPARIS)}
      satirYolu={(d) => `/crm/orders/${d.id}`}
      yazmaIzni="crm.sale_order.create"
      silmeIzni="crm.sale_order.delete.all"
      yetenekler={BELGE_YETENEK}
      sayimlar={(t, rows) => [
        { deger: t, etiket: 'sipariş' },
        { deger: rows.filter((d) => d.status === 'confirmed').length, etiket: 'onaylı' },
        { deger: money(topla(rows), rows[0]?.currency ?? 'TRY'), etiket: 'listelenen tutar' },
      ]}
      gostergeler={(rows) => {
        if (rows.length === 0) return null;
        const pb = rows[0]?.currency ?? 'TRY';
        const bekleyen = rows.filter((d) => ['confirmed', 'delivered'].includes(d.status));
        const taslak = rows.filter((d) => d.status === 'draft');
        const faturalanan = rows.filter((d) => d.status === 'invoiced');
        return (
          <div className="grid grid-4">
            <Stat label="Faturalanmayı bekleyen" value={money(topla(bekleyen), pb)}
                  hint={bekleyen.length === 0 ? 'Bekleyen sipariş yok' : `${bekleyen.length} sipariş`} />
            <Stat label="Faturalandı" value={faturalanan.length} hint={money(topla(faturalanan), pb)} />
            <Stat label="Taslak" value={taslak.length}
                  hint={taslak.length === 0 ? 'Taslak yok' : 'Henüz onaylanmadı'} />
            <Stat label="Listelenen toplam" value={money(topla(rows), pb)} hint={`${rows.length} sipariş`} />
          </div>
        );
      }}
      bosBaslik="Henüz sipariş yok"
      bosMetin="Satış siparişi onaylanan bir tekliften doğar. Siparişi onayladığınızda stok rezerve edilir ve muhasebe tarafında fatura taslağı kendiliğinden oluşur -- iki modül birbirini olay üzerinden duyar."
      dipnot={<span>Sipariş onayı stok rezervini ve fatura taslağını tetikler.</span>}
    />
  );
}

/** Teklif ve sipariş detayları aynı belge yapısını paylaşır. */
function DocumentDetail({ kind }: { kind: 'quotation' | 'order' }) {
  const { id } = useParams();
  const nav = useNavigate();
  const { me, can } = useSession();
  const path = kind === 'quotation' ? 'quotations' : 'sale-orders';
  const doc = useItem<SalesDocument>(`/crm/${path}/${id}/full`);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);

  const act = async (action: string, body?: unknown) => {
    setBusy(true); setError(null);
    try {
      const res = await api.post<{ data: SalesDocument }>(`/crm/${path}/${id}/${action}`, body);
      // Onaylanan teklif bir sipariş doğurur; kullanıcıyı doğrudan ona götür
      if (action === 'accept' && res?.data?.id) nav(`/crm/orders/${res.data.id}`);
      else await doc.reload();
    } catch (err) { setError(err); } finally { setBusy(false); }
  };

  if (doc.loading) return <p className="muted">Yükleniyor…</p>;
  if (!doc.data) return <ErrorBox error={doc.error} />;
  const d = doc.data;
  const currency = d.currency || me?.tenant?.currency || 'TRY';

  const actions: React.ReactNode[] = [];
  if (kind === 'quotation') {
    if (d.status === 'draft' && can('crm.quotation.write.all') || d.status === 'draft' && can('crm.quotation.write.own')) {
      actions.push(<button key="send" className="btn" disabled={busy}
                           onClick={() => void act('send')}>Müşteriye gönder</button>);
    }
    if (['draft', 'sent'].includes(d.status)) {
      actions.push(<button key="accept" className="btn btn-primary" disabled={busy}
                           onClick={() => void act('accept')}>Onayla → sipariş oluştur</button>);
    }
  } else {
    if (d.status === 'draft' && can('crm.order.confirm')) {
      actions.push(<button key="confirm" className="btn btn-primary" disabled={busy}
                           onClick={() => void act('confirm')}>Siparişi onayla</button>);
    }
    if (['draft', 'confirmed'].includes(d.status) && can('crm.order.confirm')) {
      actions.push(<button key="cancel" className="btn btn-danger" disabled={busy}
                           onClick={() => void act('cancel', { reason: 'kullanıcı iptali' })}>İptal et</button>);
    }
  }

  return (
    <>
      <PageHead
        title={`${kind === 'quotation' ? 'Teklif' : 'Sipariş'} ${d.number ?? '(taslak)'}`}
        subtitle={<><StatusBadge status={d.status} /> · {d.partner_name}</>}
        actions={<div className="row">{actions}</div>}
      />
      <ErrorBox error={error} />

      <div className="split">
        <Card title="Kalemler" padded={false}>
          <div className="tbl-wrap">
            <table className="tbl">
              <thead>
                <tr>
                  <th>Ürün / Açıklama</th><th className="r">Miktar</th><th className="r">Birim fiyat</th>
                  <th className="r">İsk.</th><th>KDV</th><th className="r">Tutar</th>
                </tr>
              </thead>
              <tbody>
                {(d.lines ?? []).map((l) => (
                  <tr key={l.id}>
                    <td>
                      <strong>{l.description}</strong>
                      {l.sku && <div className="muted" style={{ fontSize: 12 }}>{l.sku}</div>}
                    </td>
                    <td className="r">{num(l.quantity, 2)} {l.uom_code ?? ''}</td>
                    <td className="r">{money(l.unit_price, currency)}</td>
                    <td className="r">{Number(l.discount_pct) > 0 ? `%${num(l.discount_pct, 0)}` : '—'}</td>
                    <td>{l.tax_code ?? '—'}</td>
                    <td className="r">{money(l.line_subtotal, currency)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            {(d.lines ?? []).length === 0 && <Empty>Kalem eklenmemiş</Empty>}
          </div>
        </Card>

        <div className="grid">
          <Card title="Tutarlar">
            <table className="tbl">
              <tbody>
                <tr><td>Ara toplam</td><td className="r">{money(d.subtotal, currency)}</td></tr>
                {Number(d.discount_total) > 0 && (
                  <tr><td>İskonto</td><td className="r">−{money(d.discount_total, currency)}</td></tr>
                )}
                <tr><td>KDV</td><td className="r">{money(d.tax_total, currency)}</td></tr>
                {Number(d.withholding_total) > 0 && (
                  <tr><td>Tevkifat</td><td className="r">−{money(d.withholding_total, currency)}</td></tr>
                )}
                <tr>
                  <td><strong>Genel toplam</strong></td>
                  <td className="r"><strong>{money(d.total, currency)}</strong></td>
                </tr>
              </tbody>
            </table>
          </Card>

          <Card title="Cari">
            <div style={{ display: 'grid', gap: 8, fontSize: 13 }}>
              <div><strong>{d.partner_name}</strong></div>
              {d.tax_no && <div className="muted">{d.tax_office} · VKN {d.tax_no}</div>}
              <div className="muted">Vade: {d.payment_term_days} gün</div>
              {d.owner_name && <div className="muted">Sorumlu: {d.owner_name}</div>}
            </div>
          </Card>
        </div>
      </div>
    </>
  );
}

export const QuotationDetail = () => <DocumentDetail kind="quotation" />;
export const OrderDetail = () => <DocumentDetail kind="order" />;
