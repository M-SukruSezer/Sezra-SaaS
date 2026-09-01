import { useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { api } from '../api/client';
import { useItem, useList } from '../ui/useResource';
import { Card, Empty, ErrorBox, PageHead, SearchInput, StatusBadge, Toolbar } from '../ui';
import { money, date, num } from '../i18n';
import { useSession } from '../api/session';
import type { SalesDocument } from '../api/types';

function DocumentTable({ rows, base, dateKey }: {
  rows: SalesDocument[]; base: string; dateKey: 'issue_date' | 'order_date';
}) {
  return (
    <div className="tbl-wrap">
      <table className="tbl">
        <thead>
          <tr>
            <th>No</th><th>Cari</th><th>Tarih</th><th>Durum</th><th className="r">Kalem</th>
            <th className="r">Ara toplam</th><th className="r">KDV</th><th className="r">Toplam</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((d) => (
            <tr key={d.id}>
              <td><Link to={`${base}/${d.id}`}><strong>{d.number ?? 'Taslak'}</strong></Link></td>
              <td>{d.partner_name ?? '—'}</td>
              <td>{date(d[dateKey])}</td>
              <td><StatusBadge status={d.status} /></td>
              <td className="r muted">{(d as { line_count?: string }).line_count ?? '—'}</td>
              <td className="r">{money(d.subtotal, d.currency)}</td>
              <td className="r">{money(d.tax_total, d.currency)}</td>
              <td className="r"><strong>{money(d.total, d.currency)}</strong></td>
            </tr>
          ))}
        </tbody>
      </table>
      {rows.length === 0 && <Empty />}
    </div>
  );
}

export function QuotationList() {
  const [q, setQ] = useState('');
  const list = useList<SalesDocument>('/crm/quotations', { q, limit: 100 });
  return (
    <>
      <PageHead title="Teklifler" subtitle={`${list.total} kayıt`} />
      <Toolbar><SearchInput value={q} onChange={setQ} placeholder="Teklif no, not…" /></Toolbar>
      <ErrorBox error={list.error} />
      <Card padded={false}>
        <DocumentTable rows={list.data} base="/crm/quotations" dateKey="issue_date" />
      </Card>
    </>
  );
}

export function OrderList() {
  const [q, setQ] = useState('');
  const list = useList<SalesDocument>('/crm/sale-orders', { q, limit: 100 });
  return (
    <>
      <PageHead title="Satış Siparişleri" subtitle={`${list.total} kayıt`} />
      <Toolbar><SearchInput value={q} onChange={setQ} placeholder="Sipariş no, not…" /></Toolbar>
      <ErrorBox error={list.error} />
      <Card padded={false}>
        <DocumentTable rows={list.data} base="/crm/orders" dateKey="order_date" />
      </Card>
    </>
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
