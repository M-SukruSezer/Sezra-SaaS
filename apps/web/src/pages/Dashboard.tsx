import { lazy, Suspense } from 'react';
import { Link } from 'react-router-dom';
import { Home } from 'lucide-react';
import { Card, Empty, ErrorBox, StatusBadge } from '../ui';
import { money, date, num } from '../i18n';
import { useSession } from '../api/session';
import { useDashboard } from '../dashboard/useDashboard';
import { KPICard, KPIGrid, KPISkeleton } from '../dashboard/KPIGrid';
// Grafik kütüphanesi ilk yüklemeyi iki katına çıkarıyordu. Tembel yüklenince
// gösterge kartları ve tablolar beklemeden geliyor; grafikler arkadan ekleniyor.
// İkisi de AYNI modülden geldiği için tek ek parça oluşuyor.
const SalesChart = lazy(() =>
  import('../dashboard/Charts').then((m) => ({ default: m.SalesChart })));
const CashBankChart = lazy(() =>
  import('../dashboard/Charts').then((m) => ({ default: m.CashBankChart })));

/**
 * Genel Bakış.
 *
 * ÖNCELİK SIRASI (yukarıdan aşağı): satış, tahsilat, kasa/banka, borç ve
 * alacak, stok, grafikler, detaylı analiz. Kullanıcı ekranı açtığında
 * işletmenin durumunu birkaç saniyede okuyabilmeli.
 *
 * Göstergeler modüle bağlı: Envanter kapalı bir kiracıda düşük stok kartı ve
 * bölümü hiç çizilmez. Boş kart göstermek, kapalı modülü bozuk gibi gösterir.
 */
export function Dashboard() {
  const { me } = useSession();
  const modules = new Set(me?.modules.map((m) => m.code) ?? []);
  const d = useDashboard({
    finance: modules.has('finance'),
    inventory: modules.has('inventory'),
  });

  const k = d.kpis.data;
  const receivables = d.aging.data.filter((r) => r.kind === 'sale' && Number(r.open_amount) > 0);

  return (
    <>
      <nav className="crumbs" aria-label="Konum">
        {/* KÖK BİR SİMGE: şirket adı zaten üst çubukta, oturum bloğunda
            yazıyor. İzde tekrar etmesi hem yer kaplıyor hem de uzun
            unvanlarda satırı kırıyordu. Ev simgesi kökü tek karakterde
            söyler; erişilebilir adı kaybolmaz. */}
        <Link className="crumb-kok" to="/" aria-label="Anlık görünüm">
          <Home size={14} aria-hidden="true" />
        </Link>
        <span aria-hidden="true" className="crumb-sep">/</span>
        <span className="crumb-current">Genel Bakış</span>
      </nav>

      <header className="page-head">
        <div style={{ flex: 1 }}>
          <h1 className="page-title">Genel Bakış</h1>
          <p className="page-sub">
            İşletmenizin güncel durumu: satış, tahsilat, stok ve vade özeti.
          </p>
        </div>
      </header>

      <ErrorBox error={d.kpis.error} />

      {d.kpis.loading && !k ? <KPISkeleton count={8} /> : k && (
        <KPIGrid>
          <KPICard label="Bugünkü satış" value={money(k.sales_today)}
                   hint="Bugün onaylanmış satış toplamı" />
          <KPICard label="Bu ayki satış" value={money(k.sales_mtd)}
                   hint="Ay başından bugüne onaylanmış satış" />
          <KPICard label="Bu ayki alış" value={money(k.purchases_mtd)}
                   hint="Ay başından bugüne onaylanmış alış" />
          <KPICard label="Kasa ve banka" value={money(k.cash_bank_total)}
                   hint="Aktif hesapların toplam bakiyesi" />

          <KPICard label="Bugünkü tahsilat" value={money(k.collections_today)}
                   hint="Bugün cariden alınan tahsilat" />
          <KPICard label="Bugünkü ödeme" value={money(k.payments_today)}
                   hint="Bugün cariye yapılan ödeme" />
          <KPICard label="Toplam alacak" value={money(k.receivable_total)}
                   hint="Tahsilat bekleyen açık kalemler" />
          <KPICard label="Toplam borç" value={money(k.payable_total)}
                   hint="Ödemesi bekleyen açık kalemler" />

          <KPICard
            label="Vadesi geçen alacaklar"
            value={money(k.receivable_overdue)}
            tone={Number(k.receivable_overdue) > 0 ? 'danger' : undefined}
            hint={`${k.receivable_overdue_count} açık kalem`}
          />
          <KPICard label="Yaklaşan ödemeler" value={money(k.payable_due_7d)}
                   hint="Önümüzdeki 7 gün içindeki vadeler" />
          <KPICard label="Ödeme bekleyen alışlar" value={money(k.purchase_unpaid)}
                   hint="Onaylı alışlarda kalan ödeme tutarı" />
          {modules.has('inventory') && (
            <KPICard
              label="Düşük stok"
              value={d.lowStock.data.length}
              tone={d.lowStock.data.length > 0 ? 'warn' : undefined}
              hint="Stok eşiğinin altındaki ürünler"
            />
          )}
        </KPIGrid>
      )}

      {/* Grafikler: geniş eğri + dar dağılım. Simetrik iki kutu bilgi vermiyordu. */}
      <div className="analytics">
        <Card title="Son 30 gün satış" padded={false}>
          {d.trend.data.length === 0
            ? <Empty title="Veri yok">Bu aralıkta onaylanmış satış bulunmuyor.</Empty>
            : (
              <div className="card-body">
                <Suspense fallback={<div className="chart chart-tall skeleton" />}>
                  <SalesChart data={d.trend.data} />
                </Suspense>
              </div>
            )}
        </Card>

        <Card title="Kasa ve banka dağılımı" padded={false}>
          <div className="card-body">
            <Suspense fallback={<div className="chart chart-donut skeleton" />}>
              <CashBankChart data={d.cash.data} />
            </Suspense>
          </div>
        </Card>
      </div>

      <div className="analytics">
        <Card
          title="Son satışlar"
          actions={<Link className="btn btn-sm" to="/finance/sales">Tümü</Link>}
          padded={false}
        >
          <div className="tbl-wrap">
            <table className="tbl">
              <thead>
                <tr><th>Belge</th><th>Cari</th><th>Tarih</th><th>Durum</th><th className="r">Tutar</th></tr>
              </thead>
              <tbody>
                {d.recent.data.map((r) => (
                  <tr key={r.id}>
                    <td><Link to={`/finance/sales/${r.id}`}><strong>{r.number ?? 'Taslak'}</strong></Link></td>
                    <td>{r.partner_name ?? '—'}</td>
                    <td className="muted">{date(r.issue_date)}</td>
                    <td><StatusBadge status={r.status} /></td>
                    <td className="r">{money(r.total)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            {!d.recent.loading && d.recent.data.length === 0 && (
              <Empty title="Boş">Henüz satış faturası yok.</Empty>
            )}
          </div>
        </Card>

        <Card title="En çok satan ürünler" padded={false}>
          <div className="tbl-wrap">
            <table className="tbl">
              <thead>
                <tr><th>Ürün</th><th className="r">Adet</th><th className="r">Ciro</th></tr>
              </thead>
              <tbody>
                {d.products.data.map((p) => (
                  <tr key={p.product_id}>
                    <td>
                      <strong>{p.name ?? '—'}</strong>
                      {p.sku && <div className="muted micro">{p.sku}</div>}
                    </td>
                    <td className="r">{num(p.quantity)}</td>
                    <td className="r">{money(p.revenue)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            {!d.products.loading && d.products.data.length === 0 && (
              <Empty title="Boş">Bu ay ürün bazlı satış kaydı yok.</Empty>
            )}
          </div>
        </Card>
      </div>

      <div className="analytics">
        <Card
          title="Tahsilat bekleyen cariler"
          actions={<Link className="btn btn-sm" to="/finance/reports">Yaşlandırma</Link>}
          padded={false}
        >
          <div className="tbl-wrap">
            <table className="tbl">
              <thead>
                <tr>
                  <th>Cari</th><th className="r">Açık tutar</th>
                  <th className="r">Vadesi geçen</th><th>En yakın vade</th>
                </tr>
              </thead>
              <tbody>
                {receivables.slice(0, 6).map((r) => {
                  const overdue = Number(r.overdue_0_30) + Number(r.overdue_31_60)
                    + Number(r.overdue_61_90) + Number(r.overdue_90_plus);
                  return (
                    <tr key={r.partner_id}>
                      <td><strong>{r.partner_name}</strong></td>
                      <td className="r">{money(r.open_amount)}</td>
                      <td className="r">
                        {overdue > 0
                          ? <span className="badge badge-danger">{money(overdue)}</span>
                          : <span className="muted">—</span>}
                      </td>
                      <td className="muted">{r.earliest_due ? date(r.earliest_due) : '—'}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
            {!d.aging.loading && receivables.length === 0 && (
              <Empty title="Temiz">Tahsilat bekleyen cari yok.</Empty>
            )}
          </div>
        </Card>

        {modules.has('inventory') && (
          <Card
            title="Düşük stok ürünleri"
            actions={<Link className="btn btn-sm" to="/inventory/alerts">Tümü</Link>}
            padded={false}
          >
            <div className="tbl-wrap">
              <table className="tbl">
                <thead>
                  <tr><th>Ürün</th><th className="r">Eldeki</th><th className="r">Minimum</th><th className="r">Öneri</th></tr>
                </thead>
                <tbody>
                  {d.lowStock.data.slice(0, 6).map((r) => (
                    <tr key={r.product_id}>
                      <td><strong>{r.product_name}</strong><div className="muted micro">{r.sku}</div></td>
                      <td className="r"><span className="badge badge-warn">{num(r.on_hand)}</span></td>
                      <td className="r">{num(r.min_quantity)}</td>
                      <td className="r">{num(r.suggested_quantity)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
              {!d.lowStock.loading && d.lowStock.data.length === 0 && (
                <Empty title="Temiz">Tüm ürünler minimum seviyenin üstünde.</Empty>
              )}
            </div>
          </Card>
        )}
      </div>
    </>
  );
}
