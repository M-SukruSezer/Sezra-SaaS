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

  /**
   * VKN'den firma bilgisi getirme.
   *
   * Akis: Frontend -> KENDI backend'imiz -> saglayici -> geri. Frontend ucuncu
   * tarafa hic gitmez. Gelen her alan SONRADAN ELLE DUZENLENEBILIR; kilitlemeyiz
   * ve kullanicinin zaten yazdigi alanin uzerine yazmayiz.
   */
  const [firmaDurum, setFirmaDurum] = useState<
    | { tip: 'bos' }
    | { tip: 'yukleniyor' }
    | { tip: 'sonuc'; ton: 'basarili' | 'bulunamadi' | 'hata' | 'bilgi'; mesaj: string }
  >({ tip: 'bos' });

  const firmaGetir = async (vkn: string) => {
    setFirmaDurum({ tip: 'yukleniyor' });
    try {
      const r = await api.get<{ data: {
        found: boolean; status: string; message: string;
        company?: Record<string, string>;
      } }>(`/core/company/lookup?tax_no=${encodeURIComponent(vkn)}`);
      const d = r.data;
      if (d.found && d.company) {
        setDraft((cur) => {
          const base = { ...(cur ?? {}) } as Record<string, unknown>;
          for (const [k, v] of Object.entries(d.company!)) {
            // Yalnizca BOS alani doldur -- kullanicinin girdisi korunur.
            if (v && (base[k] === undefined || base[k] === null || base[k] === '')) base[k] = v;
          }
          return base;
        });
        setFirmaDurum({ tip: 'sonuc', ton: 'basarili', mesaj: d.message });
      } else if (d.status === 'tckn') {
        setFirmaDurum({ tip: 'sonuc', ton: 'bilgi', mesaj: d.message });
      } else if (d.status === 'error') {
        setFirmaDurum({ tip: 'sonuc', ton: 'hata', mesaj: d.message });
      } else {
        setFirmaDurum({ tip: 'sonuc', ton: 'bulunamadi', mesaj: d.message });
      }
    } catch (err) {
      setFirmaDurum({
        tip: 'sonuc', ton: 'hata',
        mesaj: err instanceof Error && err.message
          ? err.message
          : 'Firma bilgisi sorgulanamadı. Bilgileri manuel olarak girebilirsiniz.',
      });
    }
  };

  // 10 hane tamamlaninca debounce ile otomatik sorgu. Kullanici butona da basabilir.
  const vknDeger = draft ? String(draft.tax_no ?? '').replace(/\D/g, '') : '';
  useEffect(() => {
    if (vknDeger.length === 11) {
      // 11 hane = TCKN. Firma sorgusu yapmayiz; backend'e hic gitmeyiz.
      setFirmaDurum({
        tip: 'sonuc', ton: 'bilgi',
        mesaj: 'Bu bir TC kimlik numarası; firma sorgusu yalnızca 10 haneli VKN için yapılır.',
      });
      return;
    }
    if (vknDeger.length !== 10) { setFirmaDurum({ tip: 'bos' }); return; }
    const t = setTimeout(() => void firmaGetir(vknDeger), 600);
    return () => clearTimeout(t);
  }, [vknDeger]); // eslint-disable-line react-hooks/exhaustive-deps

  // Durumun kullaniciya gorunen metni ve tonu (aria-live ile duyurulur).
  const firmaMesaji = firmaDurum.tip === 'yukleniyor'
    ? 'Firma bilgileri sorgulanıyor...'
    : firmaDurum.tip === 'sonuc' ? firmaDurum.mesaj : null;
  const firmaRenk = firmaDurum.tip === 'sonuc' && firmaDurum.ton === 'basarili' ? 'var(--c-ok)'
    : firmaDurum.tip === 'sonuc' && firmaDurum.ton === 'hata' ? 'var(--c-danger)'
    : firmaDurum.tip === 'sonuc' && firmaDurum.ton === 'bilgi' ? 'var(--c-info)'
    : undefined;

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
            <Field label="VKN / TCKN" hint="Firma bilgileri için 10 haneli VKN girin (11 hane = TCKN)">
              <div className="row">
                <input value={String(draft.tax_no ?? '')} style={{ flex: 1 }}
                       onChange={(e) => setDraft({ ...draft, tax_no: e.target.value || null })} />
                <button type="button" className="btn btn-sm"
                        disabled={vknDeger.length !== 10 || firmaDurum.tip === 'yukleniyor'}
                        onClick={() => void firmaGetir(vknDeger)}>
                  {firmaDurum.tip === 'yukleniyor' ? 'Sorgulanıyor…' : "VKN'den getir"}
                </button>
              </div>
              {firmaMesaji && (
                <span className="hint" role="status" aria-live="polite" style={{ color: firmaRenk }}>
                  {firmaMesaji}
                </span>
              )}
            </Field>
            <Field label="Vergi dairesi">
              <input value={String(draft.tax_office ?? '')}
                     onChange={(e) => setDraft({ ...draft, tax_office: e.target.value })} />
            </Field>
            <Field label="Vergi dairesi kodu">
              <input value={String(draft.tax_office_code ?? '')}
                     onChange={(e) => setDraft({ ...draft, tax_office_code: e.target.value || null })} />
            </Field>
            <Field label="MERSİS No">
              <input value={String(draft.mersis_no ?? '')}
                     onChange={(e) => setDraft({ ...draft, mersis_no: e.target.value || null })} />
            </Field>
            <Field label="Mükellefiyet türü">
              <input value={String(draft.tax_liability_type ?? '')}
                     onChange={(e) => setDraft({ ...draft, tax_liability_type: e.target.value || null })} />
            </Field>
            <Field label="Adres">
              <input value={String(draft.address ?? '')}
                     onChange={(e) => setDraft({ ...draft, address: e.target.value || null })} />
            </Field>
            <Field label="Şehir">
              <input value={String(draft.city ?? '')}
                     onChange={(e) => setDraft({ ...draft, city: e.target.value })} />
            </Field>
            <Field label="İlçe">
              <input value={String(draft.district ?? '')}
                     onChange={(e) => setDraft({ ...draft, district: e.target.value || null })} />
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
      anahtar: 'artikel_no', baslik: 'Artikel No', gizliBaslangic: true, suz: 'metin',
      govde: (s) => <span className="num">{s.artikel_no ?? ''}</span>,
      disa: (s) => s.artikel_no ?? '',
    },
    {
      anahtar: 'shelf_location', baslik: 'Raf/Lokasyon', gizliBaslangic: true, suz: 'metin',
      govde: (s) => <>{s.shelf_location ?? ''}</>,
      disa: (s) => s.shelf_location ?? '',
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
        'sale_price', 'purchase_price', 'currency', 'artikel_no', 'shelf_location']}
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
