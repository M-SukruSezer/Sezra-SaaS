import { useCallback, useEffect, useRef, useState } from 'react';
import { CheckCircle2, ScanLine, Undo2, XCircle } from 'lucide-react';
import { api, ApiError } from '../api/client';
import { useList } from '../ui/useResource';
import {
  Card, Empty, EmptyPage, ErrorBox, PageFoot, PageHead, Stat, TableScroll,
} from '../ui';
import { num } from '../i18n';
import { useSession } from '../api/session';

interface Resolved {
  product_id: string; sku: string; product_name: string;
  multiplier: string; barcode_kind: string;
  stock: { warehouse_name: string; quantity: string; reserved: string; available: string }[];
}

interface CountRow { id: string; number?: string; count_date: string; status: string }
interface CountLine {
  id: string; product_id: string;
  counted_quantity: string; system_quantity: string;
}

/** Oturum içi okutma kaydı. Geri alma için barkodun kendisi de saklanır. */
interface Okutma {
  id: number;
  barkod: string;
  sku: string;
  ad: string;
  adet: number;
  saat: string;
  /** Sayıma yazıldıysa geri alınabilir. */
  sayimaYazildi: boolean;
  geriAlindi: boolean;
}

/**
 * Miktar bicimi.
 *
 * Depoda okunan sey ADETTIR: "12" okunur, "12,00" degil -- iki basamak
 * gereksiz gurultu yapar ve sayfadaki her sayiyi birbirine benzetir. Ama
 * kiloyla sayilan urunler gercek, o yuzden ondalik varsa korunur.
 */
const adet = (v: string | number | null | undefined): string => {
  const n = Number(v ?? 0);
  return num(n, Number.isInteger(n) ? 0 : 2);
};

/**
 * Barkod turu. Veritabani bunu Ingilizce bir enum olarak tutuyor ('case',
 * 'pallet'...); depodaki operatore oldugu gibi gostermek, arayuzun geri
 * kalani Turkceyken tek basina bir Ingilizce kelime cikarmak demek olurdu.
 * Cevrilemeyen bir deger gelirse ham hali gosterilir -- bos birakmak, bilginin
 * kendisini kaybetmekten daha kotu.
 */
const TUR_ADI: Record<string, string> = {
  unit: 'Adet', case: 'Koli', pallet: 'Palet', internal: 'Dahili',
};

type Sonuc =
  | { tur: 'bekliyor' }
  | { tur: 'bulundu'; veri: Resolved; sayimaYazildi: boolean }
  | { tur: 'bulunamadi'; barkod: string; mesaj: string; eslesmedi: boolean };

/**
 * Barkod okutma.
 *
 * BU EKRAN KOL MESAFESİNDEN OKUNUR. Depoda eldivenli, elinde okutucu olan
 * biri ekrana yaklaşmaz; sonucu bir bakışta anlaması gerekir. Bu yüzden
 * sayfanın baş nesnesi sonuç panelidir: büyük, renk VE simge VE kelimeyle
 * kodlanmış. Renk tek başına taşımaz -- depo aydınlatması ve renk körlüğü
 * ikisi de gerçek.
 *
 * OKUTUCU KLAVYE TAKLİDİ YAPAR: kodu yazıp Enter'a basar. Ekranın tek
 * kritik işi, girdi kutusunu odakta tutmaktır; odak kaybı = kayıp okutma.
 */
export function BarcodeScan() {
  const { can } = useSession();
  const [code, setCode] = useState('');
  const [sonuc, setSonuc] = useState<Sonuc>({ tur: 'bekliyor' });
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  const [countId, setCountId] = useState('');
  const [log, setLog] = useState<Okutma[]>([]);
  const inputRef = useRef<HTMLInputElement>(null);
  const sayacRef = useRef(0);

  const counts = useList<CountRow>('/inventory/counts', { status: 'draft', limit: 20 });
  const lines = useList<CountLine>(countId ? '/inventory/count-lines' : '',
    { count_id: countId, limit: 200 });
  // Sayım satırları yalnızca ürün kimliği taşır; operatör kimliği okuyamaz.
  const products = useList<{ id: string; sku: string; name: string }>(
    countId ? '/core/products' : '', { limit: 500 });
  const urunAdi = (id: string) => {
    const p = products.data.find((x) => x.id === id);
    return p ? { ad: p.name, sku: p.sku } : { ad: id.slice(0, 8), sku: '—' };
  };

  /**
   * ODAĞI GERİ AL.
   *
   * Önceki sürümde bu efektin bağımlılık dizisi YOKTU, yani her çizimde
   * çalışıyordu ve "sayıma bağla" listesi tıklanır tıklanmaz odak girdiye
   * kaçıyordu -- liste kullanılamaz hâldeydi. Şimdi odak yalnızca gerçekten
   * gereken anlarda geri alınır: ilk açılış, her okutmadan sonra ve boş bir
   * alana tıklandığında.
   */
  const odaklan = useCallback(() => { inputRef.current?.focus(); }, []);
  useEffect(() => { odaklan(); }, [odaklan]);

  /**
   * Kart icinde BOS bir yere tiklamak odagi barkod kutusuna geri verir.
   * Odagi kaybetmis bir okutucu kodu hicbir yere yazmaz ve operator bunu
   * ancak sayim tutmadiginda fark eder; geri donusu bir tikla vermek en ucuz
   * sigortadir. Denetimlerin uzerindeki tiklamalar dokunulmadan gecer.
   */
  const bosaTikla = (e: React.MouseEvent) => {
    if ((e.target as HTMLElement).closest('input, select, button, a, label')) return;
    e.preventDefault();
    odaklan();
  };

  const scan = async (raw: string) => {
    const value = raw.trim();
    if (!value || busy) return;
    setBusy(true); setError(null);
    try {
      // ONCE COZUMLE, SONRA YAZ. Tersi olsaydi ve yazma basarili olup
      // cozumleme dusseydi, ekran "taninmadi" derken sayima kayit gitmis
      // olurdu -- operatorun sonradan bulamayacagi bir yalan.
      const res = await api.get<{ data: Resolved }>(
        `/inventory/barcode/${encodeURIComponent(value)}`);
      let yazildi = false;
      if (countId) {
        await api.post(`/inventory/counts/${countId}/scan`, { barcode: value, quantity: 1 });
        await lines.reload();
        yazildi = true;
      }
      setSonuc({ tur: 'bulundu', veri: res.data, sayimaYazildi: yazildi });
      sayacRef.current += 1;
      setLog((l) => [{
        id: sayacRef.current,
        barkod: value,
        sku: res.data.sku,
        ad: res.data.product_name,
        adet: Number(res.data.multiplier) || 1,
        saat: new Date().toLocaleTimeString('tr-TR'),
        sayimaYazildi: yazildi,
        geriAlindi: false,
      }, ...l].slice(0, 50));
      setCode('');
    } catch (err) {
      // TANINMAYAN BARKOD ile GERCEK BIR HATA ayri seylerdir. Ilki gunluk bir
      // durum ve operatorun ne yapacagi bellidir; sunucunun "Barkod taninmadi:
      // <kod>" metnini oldugu gibi basmak, basligi ve kodu ucuncu kez tekrar
      // etmekten baska is gormezdi. Ikincisinde ise sunucunun soyledigi sey
      // tek bilgi kaynagimiz, o yuzden aynen gosterilir.
      const eslesmedi = err instanceof ApiError && err.code === 'not_found';
      const mesaj = eslesmedi
        ? 'Bu kod hiçbir ürüne bağlı değil. Ürünü Envanter > Barkodlar\'dan eşleştirin ya da kodu not alıp sayıma devam edin.'
        : (err instanceof ApiError ? err.message : 'Okutma başarısız. Bağlantıyı kontrol edip tekrar okutun.');
      setSonuc({ tur: 'bulunamadi', barkod: value, mesaj, eslesmedi });
      setCode('');
    } finally {
      setBusy(false);
      odaklan();
    }
  };

  /**
   * Geri alma.
   *
   * Aynı kutuyu iki kez okutmak deponun en sık hatasıdır ve düzeltmesi bu
   * ekranda yoksa operatör sayımı bozuk bırakıp gider. Geri alma, aynı
   * barkodu EKSİ miktarla yeniden yazar -- sayım satırı toplama çalıştığı
   * için bu, kaydı silmeden doğru sonucu verir ve iz de kaybolmaz.
   */
  const geriAl = async (o: Okutma) => {
    if (!countId || o.geriAlindi || busy) return;
    setBusy(true); setError(null);
    try {
      await api.post(`/inventory/counts/${countId}/scan`, { barcode: o.barkod, quantity: -1 });
      await lines.reload();
      setLog((l) => l.map((x) => (x.id === o.id ? { ...x, geriAlindi: true } : x)));
    } catch (err) { setError(err); } finally { setBusy(false); odaklan(); }
  };

  if (!can('inventory.barcode.read.all')) {
    return (
      <>
        <PageHead kicker="Envanter" title="Barkod Okut"
                  subtitle="El terminaliyle stok sorgulama ve sayım." />
        <EmptyPage title="Bu ekrana erişiminiz yok">
          Barkod okutma yetkisi depo ve sayım rollerine verilir. İhtiyacınız
          varsa şirket yöneticinizden `inventory.barcode.read.all` iznini
          isteyebilirsiniz.
        </EmptyPage>
      </>
    );
  }

  const gecerliOkutma = log.filter((l) => !l.geriAlindi);
  const farkliUrun = new Set(gecerliOkutma.map((l) => l.sku)).size;
  const toplamAdet = gecerliOkutma.reduce((t, l) => t + l.adet, 0);
  const sayim = counts.data.find((c) => c.id === countId);
  const farkliSatir = lines.data.filter(
    (l) => Number(l.counted_quantity) !== Number(l.system_quantity)).length;

  return (
    <>
      <PageHead
        kicker="Envanter"
        title="Barkod Okut"
        subtitle="Okutucu kodu yazıp Enter gönderir; kutu her zaman odakta kalır."
      />
      {/* Liste hatalari da GORUNUR olmali: sessizce bos donen bir tablo,
          "sayim bos" diye okunur ve operator var olmayan bir farki kovalar.
          Bu ekran tam da bu yuzden bir kez yanlis calisti. */}
      <ErrorBox error={error ?? lines.error ?? counts.error} />

      <div className="grid grid-4">
        <Stat label="Bu oturumda okutma" value={gecerliOkutma.length}
              hint={log.length !== gecerliOkutma.length
                ? `${log.length - gecerliOkutma.length} okutma geri alındı`
                : 'Geri alınan yok'} />
        <Stat label="Farklı ürün" value={farkliUrun}
              hint={`${adet(toplamAdet)} birim okutuldu`} />
        <Stat label="Mod" value={countId ? 'Sayıma yazıyor' : 'Sorgulama'}
              hint={countId
                ? (sayim?.number ?? 'Taslak sayım')
                : 'Stok değişmez'} />
        <Stat label="Sayımda fark" value={countId ? farkliSatir : '—'}
              hint={countId
                ? `${lines.data.length} satırdan`
                : 'Sayıma bağlanmadı'} />
      </div>

      {/* OKUTMA ALANI: sayfanın baş nesnesi. Girdi ve sonuç yan yana durur ki
          operatör gözünü kaydırmadan okutup sonucu görsün. */}
      <div className="tarama" onMouseDown={bosaTikla}>
        <div className="tarama-giris">
          <label className="tarama-etiket" htmlFor="barkod-girdi">Barkod</label>
          <div className="tarama-kutu">
            <ScanLine size={20} aria-hidden="true" />
            <input
              id="barkod-girdi"
              ref={inputRef}
              value={code}
              autoFocus
              inputMode="numeric"
              autoComplete="off"
              placeholder="Okutun ya da yazıp Enter'a basın"
              aria-describedby="barkod-mod"
              onChange={(e) => setCode(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter') void scan(code); }}
            />
          </div>

          <div className="tarama-mod" id="barkod-mod">
            <label htmlFor="sayim-secim">Sayıma bağla</label>
            <select
              id="sayim-secim"
              value={countId}
              onChange={(e) => setCountId(e.target.value)}
              /* Secim bittiginde odak barkod kutusuna doner -- ama yalnizca
                 odagi baska bir denetim ALMADIYSA. Kosulsuz geri alsaydik
                 klavyeyle secenekler arasinda gezinmek imkansiz olurdu:
                 kapali bir listede ok tusu her adimda change tetikler. */
              onBlur={(e) => { if (!e.relatedTarget) odaklan(); }}
            >
              <option value="">Sadece sorgula — stok değişmez</option>
              {counts.data.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.number ?? 'Taslak sayım'} · {c.count_date?.slice(0, 10)}
                </option>
              ))}
            </select>
          </div>
        </div>

        {/* SONUÇ: renk TEK BAŞINA anlam taşımaz — simge ve kelime her zaman
            yanında. Depo aydınlatması ve renk körlüğü ikisi de gerçek. */}
        <div className={`tarama-sonuc tarama-${sonuc.tur}`} role="status" aria-live="polite">
          {sonuc.tur === 'bekliyor' && (
            <>
              <ScanLine size={28} aria-hidden="true" />
              <div>
                <strong>Okutmaya hazır</strong>
                <p>Okutucuyu barkoda tutun. Kutu odakta, ayrıca tıklamanız gerekmez.</p>
              </div>
            </>
          )}

          {sonuc.tur === 'bulunamadi' && (
            <>
              <XCircle size={28} aria-hidden="true" />
              <div>
                <strong>{sonuc.eslesmedi ? 'Barkod tanınmadı' : 'Okutma yapılamadı'}</strong>
                <p>
                  <span className="badge badge-danger tarama-koli num">{sonuc.barkod}</span>
                  <span>{sonuc.mesaj}</span>
                </p>
              </div>
            </>
          )}

          {sonuc.tur === 'bulundu' && (
            <>
              <CheckCircle2 size={28} aria-hidden="true" />
              <div>
                <strong>{sonuc.veri.product_name}</strong>
                <p>
                  <span className="num">{sonuc.veri.sku}</span>
                  {Number(sonuc.veri.multiplier) !== 1 && (
                    <span className="badge badge-info tarama-koli">
                      {TUR_ADI[sonuc.veri.barcode_kind] ?? sonuc.veri.barcode_kind} · {adet(sonuc.veri.multiplier)} adet
                    </span>
                  )}
                  {sonuc.sayimaYazildi && (
                    <span className="badge badge-ok tarama-koli">sayıma yazıldı</span>
                  )}
                </p>
              </div>
            </>
          )}
        </div>
      </div>

      {sonuc.tur === 'bulundu' && (
        <Card title="Okutulan ürünün stoğu" padded={false}>
          <TableScroll label="Depo bazında stok">
            <table className="tbl">
              <thead>
                <tr><th>Depo</th><th className="r">Stok</th><th className="r">Ayrılan</th>
                    <th className="r">Kullanılabilir</th></tr>
              </thead>
              <tbody>
                {sonuc.veri.stock.map((s, i) => (
                  <tr key={i}>
                    <td>{s.warehouse_name}</td>
                    <td className="r">{adet(s.quantity)}</td>
                    <td className="r">{adet(s.reserved)}</td>
                    <td className="r"><strong>{adet(s.available)}</strong></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </TableScroll>
          {sonuc.veri.stock.length === 0 && (
            <Empty title="Stok yok">Bu ürünün hiçbir depoda eldeki miktarı yok.</Empty>
          )}
        </Card>
      )}

      <div className="settings-split">
        <Card title="Okutma geçmişi" padded={false}>
          <TableScroll label="Bu oturumdaki okutmalar">
            <table className="tbl">
              <thead>
                <tr>
                  <th>Saat</th><th>Ürün</th><th className="r">Adet</th>
                  {countId && <th />}
                </tr>
              </thead>
              <tbody>
                {log.map((l) => (
                  <tr key={l.id} className={l.geriAlindi ? 'tarama-iptal' : undefined}>
                    <td className="muted num">{l.saat}</td>
                    <td>
                      <strong>{l.ad}</strong>
                      <div className="muted micro">{l.sku}</div>
                    </td>
                    <td className="r">{adet(l.adet)}</td>
                    {countId && (
                      <td className="r">
                        {l.geriAlindi
                          ? <span className="badge">geri alındı</span>
                          : l.sayimaYazildi && (
                            <button className="btn btn-sm" disabled={busy} aria-busy={busy}
                                    onClick={() => void geriAl(l)}>
                              <Undo2 size={14} aria-hidden="true" /> Geri al
                            </button>
                          )}
                      </td>
                    )}
                  </tr>
                ))}
              </tbody>
            </table>
          </TableScroll>
          {log.length === 0 && (
            <Empty title="Okutma yok">Bu oturumda henüz barkod okutulmadı.</Empty>
          )}
        </Card>

        {countId && (
          <Card title="Sayım satırları" padded={false}>
            <TableScroll label="Sayım satırları">
              <table className="tbl">
                <thead>
                  <tr><th>Ürün</th><th className="r">Sistem</th><th className="r">Sayılan</th>
                      <th className="r">Fark</th></tr>
                </thead>
                <tbody>
                  {lines.data.map((l) => {
                    const diff = Number(l.counted_quantity) - Number(l.system_quantity);
                    const u = urunAdi(l.product_id);
                    return (
                      <tr key={l.id}>
                        <td>
                          <strong>{u.ad}</strong>
                          <div className="muted micro">{u.sku}</div>
                        </td>
                        <td className="r">{adet(l.system_quantity)}</td>
                        <td className="r"><strong>{adet(l.counted_quantity)}</strong></td>
                        <td className="r">
                          {diff === 0
                            ? <span className="muted">eşit</span>
                            : (
                              <span className={`badge ${diff < 0 ? 'badge-danger' : 'badge-warn'}`}>
                                {diff > 0 ? '+' : ''}{adet(diff)}
                              </span>
                            )}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </TableScroll>
            {!lines.loading && lines.data.length === 0 && (
              <Empty title="Satır yok">Bu sayıma henüz okutma yapılmadı.</Empty>
            )}
          </Card>
        )}
      </div>

      <PageFoot>
        <span>Bu oturumda <strong>{gecerliOkutma.length}</strong> okutma</span>
        <span>{countId
          ? 'Okutmalar seçili sayıma yazılıyor; yanlış okutmayı satırdan geri alabilirsiniz.'
          : 'Sorgulama modunda stok değişmez.'}</span>
        <span>Koli barkodu okutulduğunda sayıma kolinin içindeki adet yazılır.</span>
      </PageFoot>
    </>
  );
}
