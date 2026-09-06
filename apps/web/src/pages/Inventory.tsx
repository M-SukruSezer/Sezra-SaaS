import { useState } from 'react';
import { useList } from '../ui/useResource';
import { Card, Empty, EmptyPage, ErrorBox, PageFoot, PageHead, Stat, TableScroll, Toolbar } from '../ui';
import { Boxes, Coins, GitBranch, Layers, Lock, TriangleAlert } from 'lucide-react';
import { ResourceList, type Kolon } from '../ui/ResourceList';
import { kolonAd, kolonBelgeNo, kolonPara, kolonTarih } from '../ui/kolonlar';
import { money, date, num, sayi } from '../i18n';
import { useSession } from '../api/session';

interface StockRow {
  product_id: string; sku: string; product_name: string; uom_code?: string;
  warehouse_name: string; branch_name?: string;
  quantity: string; reserved: string; available: string;
  average_cost?: string; stock_value?: string;
}

interface LedgerRow {
  id: string; number?: string; move_date: string; direction: string;
  sku: string; product_name: string; lot_code?: string;
  from_code?: string; to_code?: string;
  signed_quantity: string; unit_cost: string; total_cost: string;
  source_module?: string; reference?: string; branch_name?: string;
}

// =============================================================================
// Stok durumu
// =============================================================================
/**
 * Stok durumu.
 *
 * BAŞ RAKAM STOK DEĞERİDİR -- depo sorumlusu için miktar, mali taraf için
 * değer önemlidir ve ikisi aynı bantta durur.
 *
 * MALİYETİ GÖREMEYEN KULLANICIDA (RLS) BANT KAYBOLMAZ, LİDER DEĞİŞİR: baş
 * rakam toplam miktara döner. Bandı tamamen gizlemek, yetkisi olmayan
 * kullanıcıya odak noktası olmayan bir sayfa bırakıyordu. Maliyet kolonları
 * da gizlenir: boş bir kolon "veri yok" gibi okunur, oysa gerçek sebep yetki.
 */
export function StockOnHand() {
  const { can } = useSession();
  const showCost = can('inventory.cost.read');
  const valuation = useList<{ product_count: number; total_quantity: string; total_value: string }>(
    '/inventory/reports/valuation');
  const reorder = useList<{ product_id: string }>('/inventory/reports/reorder-alerts');
  const expiring = useList<{ product_id: string; expiry_date: string }>('/inventory/reports/expiring');
  const v = valuation.data[0];

  const kolonlar: Kolon<StockRow>[] = [
    {
      anahtar: 'sku', baslik: 'Stok kodu', sirala: true, suz: 'metin',
      govde: (r) => <span className="num badge-code">{r.sku}</span>, disa: (r) => r.sku,
    },
    {
      anahtar: 'product_name', baslik: 'Ürün', sirala: true, suz: 'metin',
      govde: (r) => <strong>{r.product_name}</strong>, disa: (r) => r.product_name,
    },
    kolonAd<StockRow>('warehouse_name', 'Depo'),
    kolonAd<StockRow>('branch_name', 'Şube', { gizli: true }),
    {
      anahtar: 'quantity', baslik: 'Miktar', hizala: 'sag', sirala: true,
      govde: (r) => <>{num(r.quantity)} <span className="muted">{r.uom_code ?? ''}</span></>,
      disa: (r) => r.quantity,
    },
    {
      anahtar: 'reserved', baslik: 'Ayrılan', hizala: 'sag', sirala: true,
      govde: (r) => (Number(r.reserved) > 0
        ? <span className="badge badge-warn">{num(r.reserved)}</span>
        : <span className="muted">—</span>),
      disa: (r) => r.reserved,
    },
    {
      anahtar: 'available', baslik: 'Kullanılabilir', hizala: 'sag', sirala: true,
      // EKSİ KULLANILABİLİR bir uyarıdır: rezerve, eldekini aşmış demektir.
      // Renk tek başına taşımasın diye rozetin kendisi sayıyı da yazıyor.
      govde: (r) => (Number(r.available) < 0
        ? <span className="badge badge-danger">{num(r.available)}</span>
        : <strong>{num(r.available)}</strong>),
      disa: (r) => r.available,
    },
    ...(showCost ? [
      kolonPara<StockRow>('average_cost', 'Ort. maliyet'),
      kolonPara<StockRow>('stock_value', 'Değer', { kalin: true, sirala: true }),
    ] : []),
  ];

  return (
    <ResourceList<StockRow>
      kicker="Envanter · Stok Durumu"
      baslik="Stok Durumu"
      altBaslik="Ürün-depo kırılımında eldeki, ayrılan ve kullanılabilir miktar."
      yol="/inventory/stock"
      aramaYer="Ürün adı, stok kodu…"
      varsayilanSirala={{ kolon: 'product_name', yon: 'asc' }}
      kolonlar={kolonlar}
      // Görünüm satırının kendi kimliği yok: anahtar ürün + depo çiftidir.
      anahtarAl={(r) => `${r.product_id}-${r.warehouse_name}`}
      yetenekler={[
        { simge: Boxes, etiket: 'Depo', deger: 'Çok depolu kırılım' },
        { simge: Layers, etiket: 'Lot', deger: 'Parti ve SKT takibi' },
        { simge: Lock, etiket: 'Rezerve', deger: 'Siparişe ayrılan' },
        { simge: Coins, etiket: 'Maliyet', deger: 'Hareketli ortalama' },
        { simge: TriangleAlert, etiket: 'Uyarı', deger: 'Kritik seviye · SKT' },
      ]}
      sayimlar={(t) => [
        { deger: t, etiket: 'stok satırı' },
        { deger: v?.product_count ?? 0, etiket: 'stoklu ürün' },
      ]}
      gostergeler={(rows) => {
        if (rows.length === 0) return null;
        const ayrilan = rows.reduce((t, r) => t + Number(r.reserved || 0), 0);
        const deger = (
          <Stat label="Stok değeri" value={v ? money(v.total_value) : '—'}
                hint="Hareketli ortalama maliyetle" />
        );
        const miktar = (
          <Stat label="Toplam miktar" value={v ? sayi(v.total_quantity) : '—'}
                hint={`${v?.product_count ?? 0} stoklu ürün`} />
        );
        return (
          <div className="grid grid-4">
            {showCost ? deger : miktar}
            {showCost ? miktar
              : <Stat label="Ayrılan" value={sayi(ayrilan)} hint="Siparişe rezerve" />}
            <Stat label="Kritik seviye altı" value={reorder.data.length}
                  hint={reorder.data.length === 0 ? 'Tüm ürünler seviyede' : 'Sipariş açılması gerekiyor'} />
            <Stat label="Son kullanma yaklaşan" value={expiring.data.length}
                  hint={expiring.data.length === 0 ? 'Yaklaşan parti yok' : 'FEFO ile önce bunlar çıkar'} />
          </div>
        );
      }}
      bosBaslik="Stokta kayıt yok"
      bosMetin="Stok, mal kabulü onaylanan bir satın alma siparişiyle ya da açılış sayımıyla oluşur. İlk hareketten sonra burada depo kırılımında miktar, ayrılan tutar ve hareketli ortalama maliyet görünür."
      dipnot={showCost ? undefined
        : <span>Maliyet ve değer kolonları ayrı bir izne bağlıdır.</span>}
    />
  );
}

/**
 * Stok defteri.
 *
 * KAYNAK DEĞİŞTİ: eskiden `/inventory/reports/ledger` okunuyordu; o bir rapor
 * ucu ve sayfalama, sıralama, süzgeç desteklemiyor -- yani iki yüz satırdan
 * sonrası sessizce kayboluyordu. `/inventory/moves` aynı alanları taşıyan
 * gerçek kaynaktır ve sunucu tarafında sıralanıp süzülebilir.
 *
 * HAREKET SİLİNMEZ: düzeltme sayımla ya da ters hareketle yapılır. Bu yüzden
 * bu ekranda toplu silme YOKTUR.
 */
export function StockLedger() {
  const { can } = useSession();
  const showCost = can('inventory.cost.read');
  const miktar = (xs: LedgerRow[]) => xs.reduce((t, m) => t + Number(m.signed_quantity || 0), 0);

  const kolonlar: Kolon<LedgerRow>[] = [
    kolonBelgeNo<LedgerRow>('No'),
    kolonTarih<LedgerRow>('move_date', 'Tarih'),
    {
      anahtar: 'product_name', baslik: 'Ürün', sirala: true, suz: 'metin',
      govde: (m) => (
        <>
          <strong>{m.product_name}</strong>
          <div className="muted micro num">{m.sku}</div>
        </>
      ),
      disa: (m) => `${m.product_name} (${m.sku})`,
    },
    kolonAd<LedgerRow>('lot_code', 'Lot', { gizli: true }),
    {
      anahtar: 'direction', baslik: 'Yön', suz: 'secim', gruplanir: true,
      secenekler: [
        { deger: 'in', etiket: 'Giriş' },
        { deger: 'out', etiket: 'Çıkış' },
        { deger: 'internal', etiket: 'Transfer' },
      ],
      govde: (m) => (Number(m.signed_quantity) > 0
        ? <span className="badge badge-ok">Giriş</span>
        : <span className="badge badge-warn">Çıkış</span>),
      disa: (m) => (Number(m.signed_quantity) > 0 ? 'Giriş' : 'Çıkış'),
    },
    kolonAd<LedgerRow>('from_code', 'Nereden', { grup: false }),
    kolonAd<LedgerRow>('to_code', 'Nereye', { grup: false }),
    {
      anahtar: 'signed_quantity', baslik: 'Miktar', hizala: 'sag', sirala: true,
      govde: (m) => {
        const n = Number(m.signed_quantity);
        return <strong className={n < 0 ? 'muted' : undefined}>{n > 0 ? '+' : ''}{num(n)}</strong>;
      },
      disa: (m) => m.signed_quantity,
    },
    ...(showCost ? [
      kolonPara<LedgerRow>('unit_cost', 'Birim maliyet'),
      kolonPara<LedgerRow>('total_cost', 'Toplam maliyet', { gizli: true }),
    ] : []),
    kolonAd<LedgerRow>('source_module', 'Kaynak'),
    {
      anahtar: 'reference', baslik: 'Referans', gizliBaslangic: true,
      govde: (m) => <span className="muted">{m.reference ?? '—'}</span>,
      disa: (m) => m.reference ?? '',
    },
  ];

  return (
    <ResourceList<LedgerRow>
      kicker="Envanter · Stok Defteri"
      baslik="Stok Defteri"
      altBaslik="Her hareket kalıcıdır; düzeltme sayımla yapılır."
      yol="/inventory/moves"
      aramaYer="Hareket no, ürün, stok kodu, referans…"
      varsayilanSirala={{ kolon: 'move_date', yon: 'desc' }}
      kolonlar={kolonlar}
      yetenekler={[
        { simge: Lock, etiket: 'Değişmez', deger: 'Hareket silinmez' },
        { simge: Layers, etiket: 'Lot', deger: 'Parti bazında iz' },
        { simge: Boxes, etiket: 'Konum', deger: 'Nereden → nereye' },
        { simge: Coins, etiket: 'Maliyet', deger: 'Hareket anında donar' },
        { simge: GitBranch, etiket: 'Kaynak', deger: 'Hangi modül üretti' },
      ]}
      sayimlar={(t, rows) => [
        { deger: t, etiket: 'hareket' },
        { deger: rows.filter((m) => Number(m.signed_quantity) > 0).length, etiket: 'giriş' },
        { deger: rows.filter((m) => Number(m.signed_quantity) < 0).length, etiket: 'çıkış' },
      ]}
      gostergeler={(rows) => {
        if (rows.length === 0) return null;
        const giris = rows.filter((m) => Number(m.signed_quantity) > 0);
        const cikis = rows.filter((m) => Number(m.signed_quantity) < 0);
        const kaynaklar = new Set(rows.map((m) => m.source_module ?? 'elle'));
        const net = miktar(rows);
        return (
          <div className="grid grid-4">
            <Stat label="Net değişim" value={`${net > 0 ? '+' : ''}${sayi(net)}`}
                  hint={`${rows.length} hareket listeleniyor`} />
            <Stat label="Giriş" value={sayi(miktar(giris))} hint={`${giris.length} hareket`} />
            <Stat label="Çıkış" value={sayi(Math.abs(miktar(cikis)))} hint={`${cikis.length} hareket`} />
            <Stat label="Kaynak" value={kaynaklar.size}
                  hint={[...kaynaklar].join(', ') || 'Kaynak yok'} />
          </div>
        );
      }}
      bosBaslik="Defterde hareket yok"
      bosMetin="Stok hareketi silinmez, düzeltilmez: yanlış giriş ancak bir sayım ya da ters hareketle düzeltilir. İlk mal kabulü ya da açılış sayımından sonra her hareket kaynağıyla birlikte burada görünür."
      dipnot={<span>Net değişim yalnızca listelenen hareketleri kapsar.</span>}
    />
  );
}

export function InventoryAlerts() {
  const [days, setDays] = useState(30);
  const expiring = useList<{
    product_id: string; sku: string; product_name: string; lot_code: string;
    expiry_date: string; days_left: number; urgency: string;
    quantity: string; warehouse_name: string; branch_name?: string;
  }>('/inventory/reports/expiring', { days });

  const reorder = useList<{
    product_id: string; sku: string; product_name: string; branch_name?: string;
    on_hand: string; min_quantity: string; max_quantity?: string; suggested_quantity: string;
  }>('/inventory/reports/reorder-alerts');

  // "Geçmiş" ile "kritik" ayrı sayılır: biri kaybedilmiş stoktur, diğeri
  // hâlâ satılabilir. Tek gösterge altında toplanınca kaybın büyüklüğü
  // görünmüyordu.
  const gecmis  = expiring.data.filter((e) => e.urgency === 'geçmiş');
  const kritik  = expiring.data.filter((e) => e.urgency === 'kritik');
  const onerilen = reorder.data.reduce((t, r) => t + Number(r.suggested_quantity || 0), 0);

  if (!(reorder.loading || expiring.loading)
      && reorder.data.length === 0 && expiring.data.length === 0) {
    return (
      <>
        <PageHead kicker="Envanter" title="Stok Uyarıları"
                  subtitle="Minimum seviyenin altındaki ürünler ve son kullanma tarihi yaklaşan lotlar." />
        <ErrorBox error={reorder.error ?? expiring.error} />
        <EmptyPage title="Uyarı yok">
          Tüm ürünler minimum seviyenin üstünde ve seçilen aralıkta son kullanma
          tarihi yaklaşan lot bulunmuyor. Uyarı çıktığında burada, doğrudan
          satın alma talebine dönüştürülebilecek önerilen miktarla listelenir.
        </EmptyPage>
      </>
    );
  }

  return (
    <>
      <PageHead kicker="Envanter" title="Stok Uyarıları"
                subtitle="Minimum seviyenin altındaki ürünler ve son kullanma tarihi yaklaşan lotlar." />
      <ErrorBox error={reorder.error ?? expiring.error} />
      <div className="grid grid-4">
        <Stat label="Minimum seviye altı" value={reorder.data.length}
              hint={reorder.data.length === 0 ? 'Tüm ürünler seviyede'
                                              : `${num(onerilen)} birim sipariş önerisi`} />
        <Stat label="Son kullanma geçmiş" value={gecmis.length}
              hint={gecmis.length === 0 ? 'Süresi geçen lot yok' : 'Satılamaz; imha ya da iade'} />
        <Stat label="Son kullanma kritik" value={kritik.length}
              hint={kritik.length === 0 ? 'Kritik lot yok' : 'FEFO ile önce bunlar çıkar'} />
        <Stat label="İzlenen lot" value={expiring.data.length}
              hint={`Seçilen aralık: ${days} gün`} />
      </div>

      {/* Minimum seviye uyarısı doğrudan satın alma talebinin girdisidir:
          önerilen miktar, maksimum seviyeye tamamlayacak miktardır. */}
      <Card title="Minimum stok seviyesinin altındakiler" padded={false}>
        <TableScroll label="Minimum seviye altındaki ürünler">
          <table className="tbl">
            <thead>
              <tr>
                <th>Stok kodu</th><th>Ürün</th><th>Şube</th>
                <th className="r">Eldeki</th><th className="r">Minimum</th>
                <th className="r">Önerilen sipariş</th>
              </tr>
            </thead>
            <tbody>
              {reorder.data.map((r) => (
                <tr key={r.product_id}>
                  <td><strong>{r.sku}</strong></td>
                  <td>{r.product_name}</td>
                  <td>{r.branch_name ?? '—'}</td>
                  <td className="r"><span className="badge badge-danger">{num(r.on_hand)}</span></td>
                  <td className="r">{num(r.min_quantity)}</td>
                  <td className="r"><strong>{num(r.suggested_quantity)}</strong></td>
                </tr>
              ))}
            </tbody>
          </table>
        </TableScroll>
        {!reorder.loading && reorder.data.length === 0 && (
          <Empty title="Uyarı yok">Tüm ürünler minimum seviyenin üstünde.</Empty>
        )}
      </Card>

      <Toolbar>
        <span className="muted">Son kullanma tarihi</span>
        <select style={{ width: 'auto' }} value={days} onChange={(e) => setDays(Number(e.target.value))}>
          <option value={7}>7 gün içinde</option>
          <option value={30}>30 gün içinde</option>
          <option value={90}>90 gün içinde</option>
        </select>
      </Toolbar>

      <Card title="Son kullanma tarihi yaklaşan stok" padded={false}>
        <TableScroll label="Son kullanma tarihi yaklaşan lotlar">
          <table className="tbl">
            <thead>
              <tr>
                <th>Stok kodu</th><th>Ürün</th><th>Lot</th><th>SKT</th>
                <th className="r">Kalan gün</th><th className="r">Miktar</th><th>Depo</th>
              </tr>
            </thead>
            <tbody>
              {expiring.data.map((e) => (
                <tr key={`${e.product_id}-${e.lot_code}`}>
                  <td><strong>{e.sku}</strong></td>
                  <td>{e.product_name}</td>
                  <td>{e.lot_code}</td>
                  <td>{date(e.expiry_date)}</td>
                  <td className="r">
                    <span className={`badge ${e.urgency === 'geçmiş' ? 'badge-danger'
                      : e.urgency === 'kritik' ? 'badge-danger'
                      : e.urgency === 'yaklaşıyor' ? 'badge-warn' : ''}`}>
                      {e.days_left < 0 ? `${Math.abs(e.days_left)} gün geçti` : `${e.days_left} gün`}
                    </span>
                  </td>
                  <td className="r">{num(e.quantity)}</td>
                  <td>{e.warehouse_name}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </TableScroll>
        {!expiring.loading && expiring.data.length === 0 && (
          <Empty title="Lot yok">Seçilen aralıkta son kullanma tarihi yaklaşan lot bulunmuyor.</Empty>
        )}
      </Card>
      <PageFoot>
        <span><strong>{reorder.data.length}</strong> ürün minimum seviyenin altında</span>
        <span><strong>{expiring.data.length}</strong> lot son kullanma takibinde</span>
        <span>Önerilen sipariş miktarı, stoğu maksimum seviyeye tamamlar.</span>
      </PageFoot>
    </>
  );
}
