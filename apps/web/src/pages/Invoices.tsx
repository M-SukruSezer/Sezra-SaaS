import { useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { api } from '../api/client';
import { useItem, useList } from '../ui/useResource';
import { Card, Empty, ErrorBox, PageHead, SearchInput, StatusBadge, Toolbar } from '../ui';
import { money, date, num } from '../i18n';
import { useSession } from '../api/session';
import type { Invoice } from '../api/types';

export function InvoiceList({ kind }: { kind: 'sale' | 'purchase' }) {
  const [q, setQ] = useState('');
  const [status, setStatus] = useState('');
  const list = useList<Invoice>('/finance/invoices', {
    kind, q, status: status || undefined, limit: 100,
  });

  return (
    <>
      <PageHead
        title={kind === 'sale' ? 'Satış Faturaları' : 'Alış Faturaları'}
        subtitle={`${list.total} kayıt`}
      />
      <Toolbar>
        <SearchInput value={q} onChange={setQ} placeholder="Fatura no, cari, not…" />
        <select style={{ width: 'auto' }} value={status} onChange={(e) => setStatus(e.target.value)}>
          <option value="">Tüm durumlar</option>
          <option value="draft">Taslak</option>
          <option value="posted">Muhasebeleşti</option>
          <option value="partially_paid">Kısmen ödendi</option>
          <option value="paid">Ödendi</option>
          <option value="cancelled">İptal</option>
        </select>
      </Toolbar>
      <ErrorBox error={list.error} />

      <Card padded={false}>
        <div className="tbl-wrap">
          <table className="tbl">
            <thead>
              <tr>
                <th>No</th><th>Cari</th><th>Tarih</th><th>Vade</th><th>Durum</th>
                <th className="r">Matrah</th><th className="r">KDV</th>
                <th className="r">Toplam</th><th className="r">Kalan</th><th>e-Fatura</th>
              </tr>
            </thead>
            <tbody>
              {list.data.map((i) => (
                <tr key={i.id}>
                  <td><Link to={`/finance/${kind === 'sale' ? 'sales' : 'purchases'}/${i.id}`}>
                    <strong>{i.number ?? 'Taslak'}</strong></Link></td>
                  <td>{i.partner_name ?? '—'}</td>
                  <td>{date(i.issue_date)}</td>
                  <td>{date(i.due_date)}</td>
                  <td><StatusBadge status={i.status} /></td>
                  <td className="r">{money(i.subtotal, i.currency)}</td>
                  <td className="r">{money(i.tax_total, i.currency)}</td>
                  <td className="r"><strong>{money(i.total, i.currency)}</strong></td>
                  <td className="r">{Number(i.balance_due) > 0
                    ? money(i.balance_due, i.currency) : <span className="muted">—</span>}</td>
                  <td>{i.einvoice_status
                    ? <span className="badge badge-info">{i.einvoice_status}</span>
                    : <span className="muted">—</span>}</td>
                </tr>
              ))}
            </tbody>
          </table>
          {!list.loading && list.data.length === 0 && <Empty />}
        </div>
      </Card>
    </>
  );
}

export function InvoiceDetail({ kind }: { kind: 'sale' | 'purchase' }) {
  const { id } = useParams();
  const { can } = useSession();
  const doc = useItem<Invoice>(`/finance/invoices/${id}/full`);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [payAmount, setPayAmount] = useState('');

  const act = async (action: string, body?: unknown) => {
    setBusy(true); setError(null);
    try {
      await api.post(`/finance/invoices/${id}/${action}`, body);
      await doc.reload();
      setPayAmount('');
    } catch (err) { setError(err); } finally { setBusy(false); }
  };

  if (doc.loading) return <p className="muted">Yükleniyor…</p>;
  if (!doc.data) return <ErrorBox error={doc.error} />;
  const i = doc.data;
  const cur = i.currency;
  const payable = ['posted', 'partially_paid'].includes(i.status);

  return (
    <>
      <PageHead
        title={`${kind === 'sale' ? 'Satış' : 'Alış'} Faturası ${i.number ?? '(taslak)'}`}
        subtitle={<><StatusBadge status={i.status} /> · {i.partner_name}
          {i.source_module === 'crm' && <span className="badge badge-info" style={{ marginLeft: 8 }}>
            Siparişten otomatik</span>}</>}
        actions={
          <div className="row">
            {['draft', 'approved'].includes(i.status) && can('finance.invoice.post') && (
              <button className="btn btn-primary" disabled={busy}
                      onClick={() => void act('post')}>Muhasebeleştir</button>
            )}
            {kind === 'sale' && i.status !== 'draft' && can('finance.einvoice.create') && (
              <button className="btn" disabled={busy}
                      onClick={() => void act('einvoice')}>
                {i.einvoice_status ? 'e-Faturayı yenile' : 'e-Fatura gönder'}
              </button>
            )}
          </div>
        }
      />
      <ErrorBox error={error} />

      <div className="split">
        <div className="grid">
          <Card title="Kalemler" padded={false}>
            <div className="tbl-wrap">
              <table className="tbl">
                <thead>
                  <tr>
                    <th>Açıklama</th><th>Hesap</th><th className="r">Miktar</th>
                    <th className="r">Birim fiyat</th><th className="r">İsk.</th>
                    <th>KDV</th><th className="r">Matrah</th>
                  </tr>
                </thead>
                <tbody>
                  {(i.lines ?? []).map((l) => (
                    <tr key={l.id}>
                      <td>
                        <strong>{l.description}</strong>
                        {l.sku && <div className="muted" style={{ fontSize: 12 }}>{l.sku}</div>}
                      </td>
                      <td className="muted num">{l.account_code ?? '—'}</td>
                      <td className="r">{num(l.quantity)} {l.uom_code ?? ''}</td>
                      <td className="r">{money(l.unit_price, cur)}</td>
                      <td className="r">{Number(l.discount_pct) > 0 ? `%${num(l.discount_pct, 0)}` : '—'}</td>
                      <td>{l.tax_code ?? '—'}</td>
                      <td className="r">{money(l.line_subtotal, cur)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
              {(i.lines ?? []).length === 0 && <Empty>Kalem yok</Empty>}
            </div>
          </Card>

          {(i.payments ?? []).length > 0 && (
            <Card title="Tahsilatlar" padded={false}>
              <table className="tbl">
                <thead><tr><th>No</th><th>Tarih</th><th>Yöntem</th><th className="r">Tutar</th></tr></thead>
                <tbody>
                  {i.payments!.map((p, ix) => (
                    <tr key={ix}>
                      <td className="num">{p.number}</td>
                      <td>{date(p.payment_date)}</td>
                      <td className="muted">{p.method}</td>
                      <td className="r">{money(p.amount, cur)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </Card>
          )}
        </div>

        <div className="grid">
          <Card title="Tutarlar">
            <table className="tbl">
              <tbody>
                <tr><td>Matrah</td><td className="r">{money(i.subtotal, cur)}</td></tr>
                {Number(i.discount_total) > 0 && (
                  <tr><td>İskonto</td><td className="r">−{money(i.discount_total, cur)}</td></tr>
                )}
                <tr><td>KDV</td><td className="r">{money(i.tax_total, cur)}</td></tr>
                {Number(i.withholding_total) > 0 && (
                  <tr><td>Tevkifat</td><td className="r">−{money(i.withholding_total, cur)}</td></tr>
                )}
                <tr><td><strong>Genel toplam</strong></td>
                    <td className="r"><strong>{money(i.total, cur)}</strong></td></tr>
                <tr><td>Ödenen</td><td className="r">{money(i.paid_total, cur)}</td></tr>
                <tr><td><strong>Kalan</strong></td>
                    <td className="r"><strong>{money(i.balance_due, cur)}</strong></td></tr>
              </tbody>
            </table>
          </Card>

          {payable && can('finance.payment.post') && (
            <Card title={kind === 'sale' ? 'Tahsilat' : 'Ödeme'}>
              <div className="field">
                <label>Tutar</label>
                <input type="number" step="0.01" placeholder={String(i.balance_due)}
                       value={payAmount} onChange={(e) => setPayAmount(e.target.value)} />
                <span className="hint">Boş bırakılırsa kalan tutarın tamamı</span>
              </div>
              <button className="btn btn-primary" disabled={busy}
                      onClick={() => void act('pay', payAmount ? { amount: Number(payAmount) } : {})}>
                {kind === 'sale' ? 'Tahsilatı kaydet' : 'Ödemeyi kaydet'}
              </button>
            </Card>
          )}

          <Card title="Bilgiler">
            <div style={{ display: 'grid', gap: 8, fontSize: 13 }}>
              <div><strong>{i.partner_name}</strong></div>
              {i.tax_no && <div className="muted">VKN {i.tax_no}</div>}
              <div className="muted">Düzenleme: {date(i.issue_date)}</div>
              <div className="muted">Vade: {date(i.due_date)} ({i.payment_term_days} gün)</div>
              {i.branch_name && <div className="muted">Şube: {i.branch_name}</div>}
              {i.journal_entry_id && (
                <div><Link className="btn btn-sm" to={`/finance/entries/${i.journal_entry_id}`}>
                  Yevmiye kaydını gör</Link></div>
              )}
              {i.einvoice_status && (
                <div>e-Fatura: <span className="badge badge-info">{i.einvoice_status}</span></div>
              )}
            </div>
          </Card>
        </div>
      </div>
    </>
  );
}
