import { Link, useParams } from 'react-router-dom';
import { useItem, useList } from '../ui/useResource';
import { Card, Empty, ErrorBox, PageFoot, PageHead, Stat } from '../ui';
import { Landmark, MonitorSmartphone, ReceiptText, RefreshCw, Wallet } from 'lucide-react';
import { ResourceList, type Kolon } from '../ui/ResourceList';
import { kolonAd, kolonBelgeNo, kolonPara, kolonSayi } from '../ui/kolonlar';
import { money, date, num } from '../i18n';
import { useSession } from '../api/session';

/**
 * POS'un YÖNETİCİ tarafı.
 *
 * Kasiyer ekranı ayrı bir istemcidir (tablet/el terminali, offline çalışır ve
 * /pos/sync ile senkronize olur). Web arayüzü kasa açmaz, fiş kesmez; kasaları
 * izler, Z raporunu okur ve satış raporlarını gösterir. İkisini tek uygulamada
 * birleştirmek, internet kesildiğinde tüm yönetimi de kilitlerdi.
 */

interface PosSession {
  id: string; number?: string; status: string; terminal_code: string; terminal_name: string;
  opened_at: string; closed_at?: string; opened_by_name?: string; closed_by_name?: string;
  opening_cash: string; counted_cash?: string; expected_cash: string; cash_difference: string;
  order_count: number; gross_sales: string; tax_total: string; net_sales: string;
  refund_total: string; branch_name?: string; hours_open?: string;
}

/**
 * Kasa oturumları.
 *
 * BAŞ RAKAM BRÜT SATIŞTIR; ama kasa farkını görebilen kullanıcıda LİDER
 * DEĞİŞİR ve açık veren vardiya öne geçer. Kasa açığı, ciro rakamının
 * yanında küçük bir sayı olarak durduğunda kimsenin dikkatini çekmiyordu;
 * oysa bu ekranın varlık sebebi odur.
 */
export function PosSessionList() {
  const { can } = useSession();
  const showVariance = can('pos.report.cash_variance');

  const kolonlar: Kolon<PosSession>[] = [
    kolonBelgeNo<PosSession>('No'),
    {
      anahtar: 'terminal_code', baslik: 'Kasa', suz: 'metin', gruplanir: true,
      govde: (s) => (
        <>
          <strong>{s.terminal_name}</strong>
          <div className="muted micro num">{s.terminal_code}</div>
        </>
      ),
      disa: (s) => `${s.terminal_name} (${s.terminal_code})`,
    },
    kolonAd<PosSession>('branch_name', 'Şube'),
    kolonAd<PosSession>('opened_by_name', 'Açan'),
    {
      anahtar: 'opened_at', baslik: 'Açılış', sirala: true,
      govde: (s) => (
        <>
          {date(s.opened_at)}
          {s.hours_open && <div className="muted micro">{num(s.hours_open, 1)} saat açık</div>}
        </>
      ),
      disa: (s) => s.opened_at,
    },
    {
      anahtar: 'status', baslik: 'Durum', suz: 'secim', gruplanir: true,
      secenekler: [{ deger: 'open', etiket: 'Açık' }, { deger: 'closed', etiket: 'Kapalı' }],
      govde: (s) => (s.status === 'closed'
        ? <span className="badge badge-ok">Kapalı</span>
        : <span className="badge badge-info">Açık</span>),
      disa: (s) => (s.status === 'closed' ? 'Kapalı' : 'Açık'),
    },
    kolonSayi<PosSession>('order_count', 'Fiş'),
    kolonPara<PosSession>('gross_sales', 'Brüt satış', { kalin: true }),
    kolonPara<PosSession>('net_sales', 'Net satış', { gizli: true }),
    kolonPara<PosSession>('refund_total', 'İade', { gizli: true }),
    // KASA FARKI AYRI BİR İZNE bağlı: kasiyerin açığı, herkesin göreceği bir
    // bilgi değil. İzin yoksa kolon hiç çizilmez -- boş bir kolon "veri yok"
    // gibi okunurdu.
    ...(showVariance ? [
      kolonPara<PosSession>('expected_cash', 'Beklenen'),
      kolonPara<PosSession>('counted_cash', 'Sayılan'),
      {
        anahtar: 'cash_difference', baslik: 'Fark', hizala: 'sag' as const,
        govde: (s: PosSession) => {
          if (s.status !== 'closed') return <span className="muted">—</span>;
          const f = Number(s.cash_difference);
          if (f === 0) return <span className="badge badge-ok">tam</span>;
          return (
            <span className={`badge ${f < 0 ? 'badge-danger' : 'badge-warn'}`}>
              {f > 0 ? '+' : ''}{money(s.cash_difference)}
            </span>
          );
        },
        disa: (s: PosSession) => s.cash_difference,
      },
    ] : []),
  ];

  return (
    <ResourceList<PosSession>
      kicker="Perakende · Kasa Oturumları"
      baslik="Kasa Oturumları"
      altBaslik="Vardiyalar, fiş sayısı, brüt satış ve kasa farkı."
      yol="/pos/sessions"
      aramaYer="Oturum no, kasa kodu…"
      varsayilanSirala={{ kolon: 'opened_at', yon: 'desc' }}
      kolonlar={kolonlar}
      satirYolu={(s) => `/pos/sessions/${s.id}`}
      yetenekler={[
        { simge: MonitorSmartphone, etiket: 'Çevrimdışı', deger: 'Kasa istemcisi ayrı' },
        { simge: RefreshCw, etiket: 'Senkron', deger: 'Bağlantı gelince' },
        { simge: Wallet, etiket: 'Kasa', deger: 'Açılış ve sayım' },
        { simge: ReceiptText, etiket: 'Z raporu', deger: 'Kapanışta üretilir' },
        { simge: Landmark, etiket: 'Muhasebe', deger: 'Kapanış fiş üretir' },
      ]}
      sayimlar={(t, rows) => [
        { deger: t, etiket: 'oturum' },
        { deger: rows.filter((s) => s.status !== 'closed').length, etiket: 'açık kasa' },
      ]}
      gostergeler={(rows) => {
        if (rows.length === 0) return null;
        const acik = rows.filter((s) => s.status !== 'closed');
        const shortages = rows.filter((s) => Number(s.cash_difference) < 0);
        const acikTutar = shortages.reduce((t, x) => t + Number(x.cash_difference || 0), 0);
        const brut = rows.reduce((t, s) => t + Number(s.gross_sales || 0), 0);
        const fis = rows.reduce((t, s) => t + Number(s.order_count || 0), 0);
        const sepet = fis === 0 ? null : brut / fis;
        const brutG = <Stat label="Listelenen brüt satış" value={money(brut)} hint={`${fis} fiş`} />;
        const acikG = (
          <Stat label="Açık veren vardiya" value={shortages.length}
                hint={shortages.length === 0 ? 'Kasa farkı yok' : money(acikTutar)} />
        );
        return (
          <div className="grid grid-4">
            {showVariance ? acikG : brutG}
            {showVariance ? brutG
              : <Stat label="Açık kasa" value={acik.length}
                      hint={acik.length === 0 ? 'Tüm kasalar kapalı' : 'Vardiya sürüyor'} />}
            <Stat label="Sepet ortalaması" value={sepet === null ? '—' : money(sepet)}
                  hint={fis === 0 ? 'Fiş yok' : `${fis} fişte`} />
            <Stat label="Açık kasa" value={acik.length}
                  hint={acik.length === 0 ? 'Tüm kasalar kapalı' : 'Z raporu bekliyor'} />
          </div>
        );
      }}
      bosBaslik="Kasa oturumu yok"
      bosMetin="Kasa oturumu, kasiyer istemcisinden açılır: web arayüzü kasaları izler, Z raporunu okur ve raporları gösterir; fiş kesmez. İlk vardiya açıldığında burada listelenir."
      dipnot={showVariance ? undefined
        : <span>Kasa farkı kolonları ayrı bir izne bağlıdır.</span>}
    />
  );
}

export function ZReport() {
  const { id } = useParams();
  const { can } = useSession();
  const z = useItem<PosSession & {
    payments: { method: string; payment_count: number; amount: string }[];
    movements: { id: string; direction: string; amount: string; reason: string }[];
    products: { sku?: string; name: string; quantity: string; total: string }[];
  }>(id ? `/pos/sessions/${id}/z-report` : null);

  if (z.loading) return <div className="empty">Yükleniyor…</div>;
  if (!z.data) return <ErrorBox error={z.error ?? 'Kasa oturumu bulunamadı'} />;
  const d = z.data;
  const showVariance = can('pos.report.cash_variance');

  return (
    <>
      <PageHead
        title={`Z Raporu — ${d.number ?? ''}`}
        subtitle={`${d.terminal_name} · ${d.branch_name ?? ''} · ${date(d.opened_at)}`}
        actions={<Link className="btn" to="/pos/sessions">Listeye dön</Link>}
      />

      <div className="grid grid-4">
        <Stat label="Fiş sayısı" value={d.order_count} />
        <Stat label="Brüt satış" value={money(d.gross_sales)} />
        <Stat label="Matrah" value={money(d.net_sales)} hint={`KDV ${money(d.tax_total)}`} />
        {Number(d.refund_total) > 0 && (
          <Stat label="İade" value={money(d.refund_total)} />
        )}
      </div>

      <div className="grid grid-2">
        {showVariance && (
          /* Kasa farkı Z raporunun ASIL kalemidir: gizlenirse kasiyer açığı
             aylar sonra fark edilir. */
          <Card title="Kasa sayımı">
            <table className="tbl">
              <tbody>
                <tr><td>Açılış bakiyesi</td><td className="r">{money(d.opening_cash)}</td></tr>
                <tr><td>Beklenen nakit</td><td className="r">{money(d.expected_cash)}</td></tr>
                <tr><td>Sayılan nakit</td>
                    <td className="r">{d.counted_cash ? money(d.counted_cash) : '—'}</td></tr>
                <tr>
                  <td><strong>Fark</strong></td>
                  <td className="r">
                    {Number(d.cash_difference) === 0
                      ? <span className="badge badge-ok">tam</span>
                      : <span className={`badge ${Number(d.cash_difference) < 0 ? 'badge-danger' : 'badge-warn'}`}>
                          {Number(d.cash_difference) > 0 ? '+' : ''}{money(d.cash_difference)}
                        </span>}
                  </td>
                </tr>
              </tbody>
            </table>
            {(d.movements ?? []).length > 0 && (
              <table className="tbl" style={{ marginTop: 12 }}>
                <thead><tr><th>Kasa hareketi</th><th className="r">Tutar</th></tr></thead>
                <tbody>
                  {d.movements.map((m) => (
                    <tr key={m.id}>
                      <td>{m.reason}<span className="muted"> · {m.direction === 'in' ? 'giriş' : 'çıkış'}</span></td>
                      <td className="r">{m.direction === 'out' ? '−' : '+'}{money(m.amount)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </Card>
        )}

        <Card title="Ödeme türleri">
          <table className="tbl">
            <tbody>
              {(d.payments ?? []).map((p, i) => (
                <tr key={i}>
                  <td>{p.method}<span className="muted"> · {p.payment_count} işlem</span></td>
                  <td className="r"><strong>{money(p.amount)}</strong></td>
                </tr>
              ))}
            </tbody>
          </table>
          {(d.payments ?? []).length === 0 && <Empty />}
        </Card>
      </div>

      <Card title="Satılan ürünler" padded={false}>
        <div className="tbl-wrap">
          <table className="tbl">
            <thead><tr><th>Stok kodu</th><th>Ürün</th><th className="r">Adet</th>
                       <th className="r">Tutar</th></tr></thead>
            <tbody>
              {(d.products ?? []).map((p, i) => (
                <tr key={i}>
                  <td>{p.sku ?? '—'}</td>
                  <td>{p.name}</td>
                  <td className="r">{num(p.quantity)}</td>
                  <td className="r">{money(p.total)}</td>
                </tr>
              ))}
            </tbody>
          </table>
          {(d.products ?? []).length === 0 && <Empty>Satış yok</Empty>}
        </div>
      </Card>
    </>
  );
}

export function PosReports() {
  const daily = useList<{
    sale_date: string; branch_name?: string; terminal_code: string;
    order_count: number; refund_count: number; gross_sales: string;
    net_sales: string; tax_total: string; refund_total: string; average_basket?: string;
  }>('/pos/reports/daily-sales');

  const hourly = useList<{
    hour_of_day: number; day_of_week: number; order_count: number;
    gross_sales: string; average_basket?: string; branch_name?: string;
  }>('/pos/reports/hourly-sales');

  const products = useList<{
    sku?: string; product_name: string; branch_name?: string;
    quantity_sold: string; gross_sales: string; order_count: number;
  }>('/pos/reports/product-sales');

  const peak = [...hourly.data].sort((a, b) => Number(b.gross_sales) - Number(a.gross_sales))[0];

  return (
    <>
      <PageHead title="Kasa Raporları" />
      <div className="grid grid-4">
        <Stat label="Toplam ciro"
              value={money(daily.data.reduce((s, r) => s + Number(r.gross_sales), 0))} />
        <Stat label="Fiş sayısı"
              value={daily.data.reduce((s, r) => s + Number(r.order_count), 0)} />
        {peak && (
          <Stat label="En yoğun saat" value={`${peak.hour_of_day}:00`}
                hint={`${peak.order_count} fiş · ${money(peak.gross_sales)}`} />
        )}
      </div>

      <ErrorBox error={daily.error} />
      <Card title="Günlük satış" padded={false}>
        <div className="tbl-wrap">
          <table className="tbl">
            <thead>
              <tr>
                <th>Tarih</th><th>Şube</th><th>Kasa</th><th className="r">Fiş</th>
                <th className="r">Matrah</th><th className="r">KDV</th>
                <th className="r">Brüt</th><th className="r">İade</th>
                <th className="r">Sepet ort.</th>
              </tr>
            </thead>
            <tbody>
              {daily.data.map((r, i) => (
                <tr key={i}>
                  <td>{date(r.sale_date)}</td>
                  <td>{r.branch_name ?? '—'}</td>
                  <td>{r.terminal_code}</td>
                  <td className="r">{r.order_count}</td>
                  <td className="r">{money(r.net_sales)}</td>
                  <td className="r">{money(r.tax_total)}</td>
                  <td className="r"><strong>{money(r.gross_sales)}</strong></td>
                  <td className="r">
                    {Number(r.refund_total) > 0
                      ? <span className="badge badge-warn">{money(r.refund_total)}</span> : '—'}
                  </td>
                  <td className="r">{r.average_basket ? money(r.average_basket) : '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
          {!daily.loading && daily.data.length === 0 && <Empty>Henüz satış yok</Empty>}
        </div>
      </Card>

      {/* Saatlik yoğunluk vardiya planlamasının girdisidir: İK'daki vardiya
          tanımları bu tabloya bakılarak yapılır. */}
      <Card title="Saatlik yoğunluk" padded={false}>
        <div className="tbl-wrap">
          <table className="tbl">
            <thead>
              <tr><th>Gün</th><th>Saat</th><th className="r">Fiş</th>
                  <th className="r">Ciro</th><th className="r">Sepet ort.</th></tr>
            </thead>
            <tbody>
              {hourly.data.map((h, i) => (
                <tr key={i}>
                  <td>{['Pzt','Sal','Çar','Per','Cum','Cmt','Paz'][h.day_of_week - 1] ?? h.day_of_week}</td>
                  <td>{String(h.hour_of_day).padStart(2, '0')}:00</td>
                  <td className="r">{h.order_count}</td>
                  <td className="r">{money(h.gross_sales)}</td>
                  <td className="r">{h.average_basket ? money(h.average_basket) : '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
          {!hourly.loading && hourly.data.length === 0 && <Empty />}
        </div>
      </Card>

      <Card title="Ürün bazlı satış" padded={false}>
        <div className="tbl-wrap">
          <table className="tbl">
            <thead>
              <tr><th>Stok kodu</th><th>Ürün</th><th>Şube</th>
                  <th className="r">Adet</th><th className="r">Ciro</th><th className="r">Fiş</th></tr>
            </thead>
            <tbody>
              {products.data.map((p, i) => (
                <tr key={i}>
                  <td>{p.sku ?? '—'}</td>
                  <td>{p.product_name}</td>
                  <td>{p.branch_name ?? '—'}</td>
                  <td className="r">{num(p.quantity_sold)}</td>
                  <td className="r"><strong>{money(p.gross_sales)}</strong></td>
                  <td className="r">{p.order_count}</td>
                </tr>
              ))}
            </tbody>
          </table>
          {!products.loading && products.data.length === 0 && (
            <Empty title="Veri yok">Bu dönemde ürün satışı kaydedilmemiş.</Empty>
          )}
        </div>
      </Card>

      <PageFoot>
        <span><strong>{daily.data.length}</strong> gün-kasa satırı, <strong>{products.data.length}</strong> ürün</span>
        {peak && <span>En yoğun saat <strong>{peak.hour_of_day}:00</strong></span>}
        <span>Fiyatlar KDV dahildir; muhasebeye kayıt fiş başına değil, kasa kapanışında atılır.</span>
      </PageFoot>
    </>
  );
}
