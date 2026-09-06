import { useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { api } from '../api/client';
import { useItem } from '../ui/useResource';
import { Coins, Landmark, Percent, ReceiptText, Wallet } from 'lucide-react';
import { Card, Empty, ErrorBox, PageHead, Stat, StatusBadge } from '../ui';
import { ResourceList, type Kolon } from '../ui/ResourceList';
import {
  DURUM_FATURA, kolonAd, kolonBelgeNo, kolonCari, kolonDurum, kolonPara,
  kolonSayi, kolonTarih,
} from '../ui/kolonlar';
import { money, date, num } from '../i18n';
import { useSession } from '../api/session';
import type { Invoice } from '../api/types';

/**
 * Fatura listesi (satış / alış).
 *
 * BAŞ RAKAM TAHSİL EDİLMEMİŞ BAKİYEDİR. Fatura ekranına bakan kişi "ne kadar
 * kesildi"yi değil "ne kadar gelmedi"yi arar; ciro zaten gösterge panelinde
 * durur.
 *
 * VADESİ GEÇEN AYRI BİR GÖSTERGE: bakiyenin içinde eriyince kimse fark
 * etmiyor. Tarih karşılaştırması gün başına yuvarlanır, aksi hâlde bugün
 * vadesi dolan fatura saate göre bazen gecikmiş görünürdü.
 */
export function InvoiceList({ kind }: { kind: 'sale' | 'purchase' }) {
  const satis = kind === 'sale';
  const baslik = satis ? 'Satış Faturaları' : 'Alış Faturaları';
  const bugun = new Date(); bugun.setHours(0, 0, 0, 0);
  const gecikmis = (i: Invoice) =>
    Number(i.balance_due) > 0 && i.due_date != null && new Date(i.due_date) < bugun;
  const topla = (xs: Invoice[], alan: 'total' | 'balance_due') =>
    xs.reduce((t, i) => t + Number(i[alan] || 0), 0);

  const kolonlar: Kolon<Invoice>[] = [
    kolonBelgeNo<Invoice>('No'),
    kolonCari<Invoice>(),
    kolonTarih<Invoice>('issue_date', 'Tarih'),
    {
      anahtar: 'due_date', baslik: 'Vade', sirala: true,
      // GECİKME RENKLE DEĞİL, KELİMEYLE de söylenir: "gecikti" yazmasaydı
      // bilgi yalnızca kırmızıda kalır ve renk körlüğünde kaybolurdu.
      govde: (i) => (gecikmis(i)
        ? <span className="badge badge-danger">{date(i.due_date)} · gecikti</span>
        : date(i.due_date)),
      disa: (i) => i.due_date ?? '',
    },
    kolonDurum<Invoice>(DURUM_FATURA),
    kolonPara<Invoice>('subtotal', 'Matrah'),
    kolonPara<Invoice>('tax_total', 'KDV'),
    kolonPara<Invoice>('withholding_total', 'Tevkifat', { gizli: true }),
    kolonPara<Invoice>('total', 'Toplam', { kalin: true }),
    {
      anahtar: 'balance_due', baslik: 'Kalan', hizala: 'sag',
      govde: (i) => (Number(i.balance_due) > 0
        ? money(i.balance_due, i.currency)
        : <span className="muted">—</span>),
      disa: (i) => i.balance_due,
    },
    {
      anahtar: 'einvoice_status', baslik: 'e-Fatura', gruplanir: true,
      govde: (i) => (i.einvoice_status
        ? <StatusBadge status={i.einvoice_status} />
        : <span className="muted">—</span>),
      disa: (i) => i.einvoice_status ?? '',
    },
    kolonSayi<Invoice>('line_count', 'Kalem', { basamak: 0, gizli: true }),
    kolonAd<Invoice>('owner_name', 'Sahibi', { gizli: true }),
  ];

  return (
    <ResourceList<Invoice>
      kicker={satis ? 'Muhasebe · Satış Faturaları' : 'Muhasebe · Alış Faturaları'}
      baslik={baslik}
      altBaslik={satis
        ? 'Kesilen faturalar, tahsilat durumu ve e-Fatura akıbeti.'
        : 'Gelen faturalar, ödeme durumu ve muhasebeleşme.'}
      yol="/finance/invoices"
      sabitSuzgec={{ kind }}
      aramaYer="Fatura no, cari, not…"
      varsayilanSirala={{ kolon: 'issue_date', yon: 'desc' }}
      kolonlar={kolonlar}
      satirYolu={(i) => `/finance/${satis ? 'sales' : 'purchases'}/${i.id}`}
      yazmaIzni="finance.invoice.create"
      silmeIzni="finance.invoice.delete.all"
      yetenekler={[
        { simge: ReceiptText, etiket: 'e-Fatura', deger: 'UBL-TR 1.2' },
        { simge: Percent, etiket: 'KDV', deger: 'Oran ve tevkifat' },
        { simge: Coins, etiket: 'Çoklu para', deger: 'Kur belgede donar' },
        { simge: Landmark, etiket: 'Muhasebe', deger: 'Yevmiye kaydı üretir' },
        { simge: Wallet, etiket: 'Tahsilat', deger: 'Kısmi ödeme izlenir' },
      ]}
      sayimlar={(t, rows) => [
        { deger: t, etiket: 'fatura' },
        { deger: rows.filter((i) => Number(i.balance_due) > 0).length, etiket: 'açık' },
        { deger: money(topla(rows.filter((i) => Number(i.balance_due) > 0), 'balance_due'),
                       rows[0]?.currency ?? 'TRY'), etiket: 'bakiye' },
      ]}
      gostergeler={(rows) => {
        if (rows.length === 0) return null;
        const pb = rows[0]?.currency ?? 'TRY';
        const acik = rows.filter((i) => Number(i.balance_due) > 0);
        const geciken = acik.filter(gecikmis);
        const taslak = rows.filter((i) => i.status === 'draft');
        return (
          <div className="grid grid-4">
            <Stat label="Tahsil edilmemiş bakiye" value={money(topla(acik, 'balance_due'), pb)}
                  hint={`${acik.length} açık fatura`} />
            <Stat label="Vadesi geçen" value={money(topla(geciken, 'balance_due'), pb)}
                  hint={geciken.length === 0 ? 'Geciken fatura yok' : `${geciken.length} fatura`} />
            <Stat label="Listelenen toplam" value={money(topla(rows, 'total'), pb)}
                  hint={`${rows.length} fatura`} />
            <Stat label="Taslak" value={taslak.length}
                  hint={taslak.length === 0 ? 'Bekleyen taslak yok' : 'Muhasebeleşmeyi bekliyor'} />
          </div>
        );
      }}
      bosBaslik="Henüz fatura yok"
      bosMetin={satis
        ? 'Onaylanan bir satış siparişi otomatik olarak fatura taslağı üretir. İlk fatura kesildiğinde matrahı, KDV\'si ve tahsilat durumu burada görünür.'
        : 'Mal kabulü onaylanan bir satın alma siparişi alış faturası taslağı üretir. İlk fatura girildiğinde burada listelenir.'}
      dipnot={<span>Muhasebeleşen fatura yevmiye kaydı üretir ve kalemleri kilitlenir.</span>}
    />
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
