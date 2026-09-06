import { useEffect, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import {
  Building2, Coins, FileClock, MapPin, Package, ScanBarcode, Tag, Wallet,
} from 'lucide-react';
import { api } from '../api/client';
import { ResourceList, type Kolon } from '../ui/ResourceList';
import { Card, ErrorBox, Field, Stat } from '../ui';
import { kolonGecen } from '../ui/kolonlar';
import { useSession } from '../api/session';
import type { Partner, Product } from '../api/types';
import { money, num } from '../i18n';

/**
 * Cariler.
 *
 * Ekranın kabuğu `ResourceList`ten gelir: arama, sıralama, kolon süzgeci,
 * yoğunluk, gruplama, seçim, dışa/içe aktarma ve toplu silme her modülde
 * aynı davranır. Burada kalan şey yalnızca BU modüle ait olan bilgi:
 * hangi kolonlar, hangi rozetler, sayılar ne anlama geliyor.
 */
export function Partners() {
  const { can } = useSession();
  const [arama, setArama] = useSearchParams();
  /**
   * `?yeni=1` ile gelen istek formu AÇAR.
   *
   * Komut paletindeki "Yeni cari ekle" buraya yönlendiriyor; parametre
   * okunmasaydı kullanıcı listeye düşer ve eylem hiçbir şey yapmamış olurdu.
   * Parametre okunur okunmaz URL'den silinir: yenilemede formun tekrar
   * açılması, kullanıcının bıraktığı yeri değil komutu hatırlamak olurdu.
   */
  const [draft, setDraft] = useState<Record<string, unknown> | null>(
    () => (arama.get('yeni') ? { name: '', is_customer: true } : null));
  useEffect(() => {
    if (arama.get('yeni')) { arama.delete('yeni'); setArama(arama, { replace: true }); }
  }, [arama, setArama]);
  const [error, setError] = useState<unknown>(null);
  const [tazele, setTazele] = useState(0);

  const save = async () => {
    setError(null);
    try {
      await api.post('/core/partners', draft);
      setDraft(null);
      setTazele((v) => v + 1);
    } catch (err) { setError(err); }
  };

  const kolonlar: Kolon<Partner>[] = [
    {
      anahtar: 'code', baslik: 'Kod', sirala: true, suz: 'metin',
      govde: (s) => <span className="num badge-code">{s.code ?? '—'}</span>,
      disa: (s) => s.code ?? '',
    },
    {
      anahtar: 'name', baslik: 'Unvan', sirala: true, suz: 'metin',
      govde: (s) => <strong>{s.name}</strong>,
      disa: (s) => s.name,
    },
    {
      anahtar: 'is_customer', baslik: 'Tip', suz: 'secim', gruplanir: true,
      secenekler: [{ deger: 'true', etiket: 'Müşteri' }, { deger: 'false', etiket: 'Müşteri değil' }],
      govde: (s) => (
        <span className="row">
          {s.is_customer && <span className="badge badge-info">Müşteri</span>}
          {s.is_supplier && <span className="badge">Tedarikçi</span>}
          {!s.is_customer && !s.is_supplier && <span className="muted">—</span>}
        </span>
      ),
      disa: (s) => [s.is_customer && 'Müşteri', s.is_supplier && 'Tedarikçi'].filter(Boolean).join(' / '),
    },
    {
      anahtar: 'tax_no', baslik: 'VKN / TCKN', suz: 'metin',
      govde: (s) => <span className="num">{s.tax_no ?? '—'}</span>,
      disa: (s) => s.tax_no ?? '',
    },
    {
      anahtar: 'email', baslik: 'E-posta',
      govde: (s) => (s.email
        ? <a className="hucre-bag" href={`mailto:${s.email}`}>{s.email}</a>
        : <span className="muted">—</span>),
      disa: (s) => s.email ?? '',
    },
    {
      anahtar: 'phone', baslik: 'Telefon',
      govde: (s) => (s.phone
        ? <a className="hucre-bag num" href={`tel:${s.phone.replace(/\s/g, '')}`}>{s.phone}</a>
        : <span className="muted">—</span>),
      disa: (s) => s.phone ?? '',
    },
    {
      anahtar: 'city', baslik: 'Şehir', sirala: true, suz: 'metin', gruplanir: true,
      govde: (s) => s.city ?? <span className="muted">—</span>,
      disa: (s) => s.city ?? '',
    },
    {
      anahtar: 'is_active', baslik: 'Durum', suz: 'secim', gruplanir: true,
      secenekler: [{ deger: 'true', etiket: 'Aktif' }, { deger: 'false', etiket: 'Pasif' }],
      govde: (s) => (s.is_active
        ? <span className="badge badge-ok">Aktif</span>
        : <span className="badge">Pasif</span>),
      disa: (s) => (s.is_active ? 'Aktif' : 'Pasif'),
    },
    {
      anahtar: 'owner_name', baslik: 'Sorumlu', gruplanir: true,
      govde: (s) => s.owner_name ?? <span className="muted">—</span>,
      disa: (s) => s.owner_name ?? '',
    },
    {
      anahtar: 'payment_term_days', baslik: 'Vade', hizala: 'sag', gizliBaslangic: true,
      govde: (s) => <>{num(s.payment_term_days, 0)} gün</>,
      disa: (s) => s.payment_term_days,
    },
    kolonGecen<Partner>('created_at', 'Eklenme'),
  ];

  return (
    <>
      <ErrorBox error={error} />

      {draft && (
        <Card title="Yeni cari" actions={
          <div className="row">
            <button className="btn btn-sm" onClick={() => setDraft(null)}>Vazgeç</button>
            <button className="btn btn-sm btn-primary" onClick={() => void save()}>Kaydet</button>
          </div>
        }>
          <div className="grid grid-2">
            <Field label="Unvan">
              <input value={String(draft.name ?? '')} autoFocus
                     onChange={(e) => setDraft({ ...draft, name: e.target.value })} />
            </Field>
            <Field label="VKN / TCKN" hint="10 ya da 11 hane">
              <input value={String(draft.tax_no ?? '')}
                     onChange={(e) => setDraft({ ...draft, tax_no: e.target.value || null })} />
            </Field>
            <Field label="Vergi dairesi">
              <input value={String(draft.tax_office ?? '')}
                     onChange={(e) => setDraft({ ...draft, tax_office: e.target.value })} />
            </Field>
            <Field label="Şehir">
              <input value={String(draft.city ?? '')}
                     onChange={(e) => setDraft({ ...draft, city: e.target.value })} />
            </Field>
            <Field label="E-posta">
              <input type="email" value={String(draft.email ?? '')}
                     onChange={(e) => setDraft({ ...draft, email: e.target.value })} />
            </Field>
            <Field label="Telefon">
              <input value={String(draft.phone ?? '')}
                     onChange={(e) => setDraft({ ...draft, phone: e.target.value })} />
            </Field>
          </div>
          <div className="row">
            <label className="onay-satir">
              <input type="checkbox" checked={Boolean(draft.is_customer)}
                     onChange={(e) => setDraft({ ...draft, is_customer: e.target.checked })} /> Müşteri
            </label>
            <label className="onay-satir">
              <input type="checkbox" checked={Boolean(draft.is_supplier)}
                     onChange={(e) => setDraft({ ...draft, is_supplier: e.target.checked })} /> Tedarikçi
            </label>
          </div>
        </Card>
      )}

      <ResourceList<Partner>
        key={tazele}
        kicker="Satış · Cariler"
        baslik="Cariler"
        altBaslik="Müşteri ve tedarikçiler tek kayıtta; bir cari her iki rolü de taşıyabilir."
        yol="/core/partners"
        aramaYer="Unvan, VKN, e-posta, telefon, şehir…"
        varsayilanSirala={{ kolon: 'name', yon: 'asc' }}
        kolonlar={kolonlar}
        satirYolu={(s) => `/partners/${s.id}`}
        // Bağlantı UNVANDA: kod çoğu caride boş ve boş bir hücreye
        // konan bağlantı bulunamaz.
        baglantiAnahtari="name"
        yazmaIzni="core.partner.create"
        silmeIzni="core.partner.delete.all"
        yazilabilir={['code', 'name', 'tax_office', 'tax_no', 'email', 'phone', 'address',
          'district', 'city', 'postal_code', 'payment_term_days', 'notes']}
        sayimlar={(toplam, satirlar) => [
          { deger: toplam, etiket: 'cari' },
          { deger: satirlar.filter((s) => s.is_customer).length, etiket: 'müşteri' },
          { deger: satirlar.filter((s) => s.is_supplier).length, etiket: 'tedarikçi' },
        ]}
        yetenekler={[
          { simge: Building2, etiket: 'Çift rol', deger: 'Müşteri + tedarikçi' },
          { simge: MapPin, etiket: 'Adres', deger: 'Şehir ve ilçe kırılımı' },
          { simge: Wallet, etiket: 'Vade', deger: 'Belgelere varsayılan' },
          { simge: FileClock, etiket: 'Geçmiş', deger: 'Teklif · sipariş · fatura' },
          { simge: Tag, etiket: 'Etiket', deger: 'Serbest etiketleme' },
        ]}
        birincilEylem={can('core.partner.create')
          ? <button className="btn btn-primary"
                    onClick={() => setDraft({ name: '', is_customer: true })}>
              Yeni cari
            </button>
          : null}
        gostergeler={(satirlar) => {
          if (satirlar.length === 0) return null;
          // Bir cari HEM müşteri hem tedarikçi olabilir; sayılar toplandığında
          // kayıt sayısını aşar. Üçüncü gösterge o çakışmayı görünür kılar,
          // aksi hâlde bant kendi kendisiyle çelişirdi.
          const ikisi = satirlar.filter((s) => s.is_customer && s.is_supplier);
          const vadeli = satirlar.filter((s) => Number(s.payment_term_days) > 0);
          const ortVade = vadeli.length === 0 ? null
            : vadeli.reduce((t, s) => t + Number(s.payment_term_days), 0) / vadeli.length;
          return (
            <div className="grid grid-4">
              <Stat label="Müşteri" value={satirlar.filter((s) => s.is_customer).length}
                    hint="Satış belgesi kesilebilir" />
              <Stat label="Tedarikçi" value={satirlar.filter((s) => s.is_supplier).length}
                    hint="Satın alma siparişi açılabilir" />
              <Stat label="Hem müşteri hem tedarikçi" value={ikisi.length}
                    hint={ikisi.length === 0 ? 'Çift rollü cari yok' : 'Cari hesabı iki yönlü işler'} />
              <Stat label="Ortalama vade"
                    value={ortVade === null ? '—' : `${num(ortVade, 0)} gün`}
                    hint={`${vadeli.length} vadeli caride`} />
            </div>
          );
        }}
        bosBaslik="Cari yok"
        bosMetin="Cari, teklif ve faturanın bağlandığı kayıttır: unvan, vergi bilgisi ve vade buradan gelir. İlk cariyi ekleyin ya da mevcut listenizi CSV ile içe aktarın."
        dipnot={<span>Vade, yeni belgelerde varsayılan ödeme süresi olarak uygulanır.</span>}
      />
    </>
  );
}

/**
 * Ürünler.
 *
 * BAŞ RAKAM AKTİF ÜRÜNDÜR: kataloğun gerçek büyüklüğü odur; pasif kayıtlar
 * geçmiş fiyatları taşımak için durur ve satış ekranlarında görünmez.
 */
export function Products() {
  // Ürün için oluşturma FORMU YOK, dolayısıyla "Yeni ürün" düğmesi de yok:
  // tıklandığında hiçbir şey yapmayan bir düğme, olmayan düğmeden kötüdür.
  // Form eklendiğinde düğme de geri gelir.
  const kolonlar: Kolon<Product>[] = [
    {
      anahtar: 'sku', baslik: 'SKU', sirala: true, suz: 'metin',
      govde: (s) => <span className="num badge-code">{s.sku}</span>,
      disa: (s) => s.sku,
    },
    {
      anahtar: 'name', baslik: 'Ad', sirala: true, suz: 'metin',
      govde: (s) => <strong>{s.name}</strong>,
      disa: (s) => s.name,
    },
    {
      anahtar: 'kind', baslik: 'Tip', suz: 'secim', gruplanir: true,
      secenekler: [
        { deger: 'stockable', etiket: 'Stoklu' },
        { deger: 'service', etiket: 'Hizmet' },
        { deger: 'consumable', etiket: 'Sarf' },
      ],
      govde: (s) => (s.kind === 'service'
        ? <span className="badge">Hizmet</span>
        : <span className="badge badge-info">Stoklu</span>),
      disa: (s) => (s.kind === 'service' ? 'Hizmet' : 'Stoklu'),
    },
    {
      anahtar: 'sale_price', baslik: 'Satış fiyatı', hizala: 'sag',
      govde: (s) => money(s.sale_price, s.currency),
      disa: (s) => s.sale_price,
    },
    {
      anahtar: 'currency', baslik: 'Para birimi', gizliBaslangic: true, gruplanir: true,
      govde: (s) => <span className="num">{s.currency}</span>,
      disa: (s) => s.currency,
    },
    {
      anahtar: 'is_active', baslik: 'Durum', suz: 'secim', gruplanir: true,
      secenekler: [{ deger: 'true', etiket: 'Aktif' }, { deger: 'false', etiket: 'Pasif' }],
      govde: (s) => (s.is_active
        ? <span className="badge badge-ok">Aktif</span>
        : <span className="badge">Pasif</span>),
      disa: (s) => (s.is_active ? 'Aktif' : 'Pasif'),
    },
  ];

  return (
    <ResourceList<Product>
      kicker="Tanımlar · Ürünler"
      baslik="Ürünler"
      altBaslik="Satış ve satın alma belgelerinde kullanılan ürün ve hizmetler."
      yol="/core/products"
      aramaYer="Ad, SKU, barkod…"
      varsayilanSirala={{ kolon: 'name', yon: 'asc' }}
      kolonlar={kolonlar}
      yazmaIzni="core.product.create"
      silmeIzni="core.product.delete.all"
      yazilabilir={['sku', 'barcode', 'name', 'description', 'kind',
        'sale_price', 'purchase_price', 'currency']}
      sayimlar={(toplam, satirlar) => [
        { deger: toplam, etiket: 'ürün' },
        { deger: satirlar.filter((s) => s.is_active).length, etiket: 'aktif' },
      ]}
      yetenekler={[
        { simge: Package, etiket: 'Katalog', deger: 'Ürün + hizmet' },
        { simge: ScanBarcode, etiket: 'Barkod', deger: 'Adet ve koli' },
        { simge: Coins, etiket: 'Çoklu para', deger: 'TRY · EUR · USD' },
        { simge: Wallet, etiket: 'Vergi', deger: 'Satış ve alış oranı' },
        { simge: FileClock, etiket: 'Geçmiş', deger: 'Fiyat değişimi izlenir' },
      ]}
      gostergeler={(satirlar) => {
        if (satirlar.length === 0) return null;
        const fiyatli = satirlar.filter((s) => Number(s.sale_price) > 0);
        const ort = fiyatli.length === 0 ? null
          : fiyatli.reduce((t, s) => t + Number(s.sale_price), 0) / fiyatli.length;
        return (
          <div className="grid grid-4">
            <Stat label="Aktif ürün" value={satirlar.filter((s) => s.is_active).length}
                  hint="Satış ekranlarında görünür" />
            <Stat label="Stoklu" value={satirlar.filter((s) => s.kind !== 'service').length}
                  hint="Envanter ve maliyet takibinde" />
            <Stat label="Hizmet" value={satirlar.filter((s) => s.kind === 'service').length}
                  hint="Stok hareketi üretmez" />
            <Stat label="Ortalama satış fiyatı"
                  value={ort === null ? '—' : money(ort, satirlar[0]?.currency ?? 'TRY')}
                  hint={`${fiyatli.length} fiyatlı üründe`} />
          </div>
        );
      }}
      bosBaslik="Katalog boş"
      bosMetin="Ürün, teklif ve fatura kalemlerinin dayandığı kayıttır: birimi, satış fiyatı ve KDV oranı buradan gelir. Stoklu tanımlananlar ayrıca envanter ve maliyet takibine girer."
      dipnot={<span>Satış fiyatı KDV hariçtir; oran ürünün vergi tanımından gelir.</span>}
    />
  );
}
