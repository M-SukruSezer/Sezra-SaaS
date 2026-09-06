import { useEffect, useMemo, useRef, useState } from 'react';
import { Link, useLocation } from 'react-router-dom';
import { ChevronDown, Pencil, Pin, PinOff, RotateCcw, Zap } from 'lucide-react';
import type { LucideIcon } from 'lucide-react';

/**
 * Hızlı Erişim.
 *
 * "EN ÇOK KULLANDIĞIN MENÜLER" GERÇEK BİR ÖLÇÜMDÜR. Sabit bir liste
 * gösterip ona "en çok kullandığın" demek, kullanıcıya kendi verisi diye
 * uydurma sunmaktır. Burada sayaçlar gerçek gezintiden birikir: her sayfa
 * değişiminde o yol bir artar.
 *
 * SAYAÇLAR TARAYICIDA KALIR, SUNUCUYA GİTMEZ. Hangi ekranı kaç kez açtığınız
 * davranış verisidir; ürünün onu toplaması için bir sebep yok. Bedeli, listenin
 * cihaz başına ayrı olması — kabul edilebilir bir takas.
 *
 * SABİTLENENLER ÖNCE GELİR: kullanıcı bir ekranı elle sabitlediyse, sayaç ne
 * derse desin o listede kalır. Ölçüm bir öneridir, kullanıcının kararı değil.
 */

export interface HizliMadde {
  to: string;
  label: string;
  grup: string;
  simge?: LucideIcon;
}

const GOSTERILEN = 5;

const sayacAnahtari = (userId: string) => `sezra.quick.usage.${userId}`;
const sabitAnahtari = (userId: string) => `sezra.quick.pinned.${userId}`;

function oku<T>(key: string, varsayilan: T): T {
  try {
    const raw = localStorage.getItem(key);
    return raw ? (JSON.parse(raw) as T) : varsayilan;
  } catch { return varsayilan; }
}
function yaz(key: string, value: unknown): void {
  try { localStorage.setItem(key, JSON.stringify(value)); } catch { /* depolama kapalı */ }
}

export function QuickAccess({ maddeler, userId }: { maddeler: HizliMadde[]; userId: string }) {
  const konum = useLocation();
  const [acik, setAcik] = useState(false);
  const [duzenle, setDuzenle] = useState(false);
  const [ara, setAra] = useState('');
  const [sayaclar, setSayaclar] = useState<Record<string, number>>(
    () => oku(sayacAnahtari(userId), {}));
  const [sabitler, setSabitler] = useState<string[]>(
    () => oku(sabitAnahtari(userId), []));
  const kutuRef = useRef<HTMLDivElement>(null);
  /* Menü listesi efektin bağımlılığı DEĞİL: her çizimde yeni bir dizi
     üretiliyor ve bağımlılık yapılsaydı efekt boşuna tekrar çalışırdı. */
  const maddelerRef = useRef(maddeler);
  maddelerRef.current = maddeler;

  // Kullanıcı değişirse (şirket/oturum geçişi) sayaçlar da o kullanıcınındır.
  useEffect(() => {
    setSayaclar(oku(sayacAnahtari(userId), {}));
    setSabitler(oku(sabitAnahtari(userId), []));
  }, [userId]);

  /**
   * Gezinti sayacı.
   *
   * Yalnızca MENÜDE OLAN yollar sayılır: detay sayfaları (bir faturanın
   * kendisi gibi) hızlı erişimde anlamlı değil ve sayılsaydı listeyi tek
   * seferlik kayıtlarla doldururdu.
   *
   * SAYIM YOLA GÖRE KİLİTLENİR, efekt çalışmasına göre değil. `maddeler`
   * her çizimde yeni bir dizi olduğu için efekt yol değişmeden de tekrar
   * çalışıyor ve aynı ziyaret birden çok sayılıyordu -- sayaç bozulunca
   * "en çok kullandığın" sıralaması da gerçeği göstermiyordu.
   */
  const sayilanYol = useRef<string | null>(null);
  useEffect(() => {
    const yol = konum.pathname;
    if (sayilanYol.current === yol) return;
    if (!maddelerRef.current.some((m) => m.to === yol)) return;
    sayilanYol.current = yol;

    // DOĞRULUK KAYNAĞI DEPO, React durumu DEĞİL. Durumdan okuyup yazarken,
    // ilk çizimde çalışan "kullanıcı değişti" etkisi ile sayaç etkisi
    // birbirini eziyordu: tam sayfa yüklemesinde sayılan ekran, bir sonraki
    // yazımda sessizce kayboluyordu. Depodan okuyup depoya yazmak sıralamadan
    // bağımsızdır; durum yalnızca çizim için tutulan bir kopya.
    const guncel = oku<Record<string, number>>(sayacAnahtari(userId), {});
    const yeni = { ...guncel, [yol]: (guncel[yol] ?? 0) + 1 };
    yaz(sayacAnahtari(userId), yeni);
    setSayaclar(yeni);
  }, [konum.pathname, userId]);

  useEffect(() => {
    if (!acik) return;
    const kapat = (e: KeyboardEvent) => { if (e.key === 'Escape') { setAcik(false); setDuzenle(false); } };
    const disariTikla = (e: MouseEvent) => {
      if (kutuRef.current && !kutuRef.current.contains(e.target as Node)) {
        setAcik(false); setDuzenle(false);
      }
    };
    window.addEventListener('keydown', kapat);
    window.addEventListener('mousedown', disariTikla);
    return () => {
      window.removeEventListener('keydown', kapat);
      window.removeEventListener('mousedown', disariTikla);
    };
  }, [acik]);

  const sirali = useMemo(() => {
    const sabitKume = new Set(sabitler);
    const sabitlenen = maddeler.filter((m) => sabitKume.has(m.to));
    const kalan = maddeler
      .filter((m) => !sabitKume.has(m.to) && (sayaclar[m.to] ?? 0) > 0)
      .sort((a, b) => (sayaclar[b.to] ?? 0) - (sayaclar[a.to] ?? 0));
    return [...sabitlenen, ...kalan].slice(0, GOSTERILEN);
  }, [maddeler, sayaclar, sabitler]);

  const sabitleDegistir = (to: string) => {
    const guncel = oku<string[]>(sabitAnahtari(userId), []);
    const yeni = guncel.includes(to) ? guncel.filter((x) => x !== to) : [...guncel, to];
    yaz(sabitAnahtari(userId), yeni);
    setSabitler(yeni);
  };

  const sayaclariSifirla = () => {
    setSayaclar({});
    yaz(sayacAnahtari(userId), {});
  };

  const duzenlemeListesi = useMemo(() => {
    const q = ara.trim().toLocaleLowerCase('tr');
    const eslesen = q === ''
      ? maddeler
      : maddeler.filter((m) => `${m.label} ${m.grup}`.toLocaleLowerCase('tr').includes(q));
    // Sabitlenenler üstte: kullanıcı neyi seçtiğini aramadan görmeli.
    const sabitKume = new Set(sabitler);
    return [...eslesen].sort((a, b) =>
      Number(sabitKume.has(b.to)) - Number(sabitKume.has(a.to)));
  }, [maddeler, ara, sabitler]);

  return (
    <div className="hizli" ref={kutuRef}>
      <button
        className={`btn btn-sm hizli-dugme${acik ? ' acik' : ''}`}
        onClick={() => { setAcik((v) => !v); setDuzenle(false); }}
        aria-expanded={acik}
        aria-haspopup="true"
        title="Hızlı Erişim"
        aria-label="Hızlı Erişim"
      >
        <span className="hizli-simge" aria-hidden="true"><Zap size={14} /></span>
        <span className="btn-label">Hızlı Erişim</span>
        {sirali.length > 0 && <span className="hizli-sayi">{sirali.length}</span>}
        <ChevronDown size={14} className={`hizli-ok${acik ? ' acik' : ''}`} aria-hidden="true" />
      </button>

      {acik && (
        <div className="hizli-panel" role="dialog" aria-label="Hızlı Erişim">
          <div className="hizli-baslik">
            <span className="hizli-simge" aria-hidden="true"><Zap size={16} /></span>
            <span>
              <strong>Hızlı Erişim</strong>
              <span className="hizli-alt">
                {duzenle ? 'sabitlemek istediklerini seç' : 'en çok kullandığın menüler'}
              </span>
            </span>
          </div>

          {duzenle ? (
            <>
              <div className="hizli-arama">
                <input
                  type="search" value={ara} autoFocus
                  placeholder="Menüde ara…"
                  aria-label="Sabitlenecek menüyü ara"
                  onChange={(e) => setAra(e.target.value)}
                />
              </div>
              <ul className="hizli-liste hizli-liste-uzun">
                {duzenlemeListesi.map((m) => {
                  const sabit = sabitler.includes(m.to);
                  return (
                    <li key={m.to}>
                      <button
                        className={`hizli-oge hizli-oge-dugme${sabit ? ' sabit' : ''}`}
                        onClick={() => sabitleDegistir(m.to)}
                        aria-pressed={sabit}
                      >
                        {m.simge && <m.simge className="hizli-oge-simge" aria-hidden="true" />}
                        <span className="hizli-oge-ad">
                          {m.label}
                          <span className="hizli-oge-grup">{m.grup}</span>
                        </span>
                        {sabit
                          ? <Pin size={14} aria-hidden="true" />
                          : <PinOff size={14} className="hizli-sonuk" aria-hidden="true" />}
                      </button>
                    </li>
                  );
                })}
                {duzenlemeListesi.length === 0 && (
                  <li className="hizli-bos">Eşleşen menü yok.</li>
                )}
              </ul>
              <div className="hizli-alt-cubuk">
                <button className="btn btn-sm" onClick={() => { setDuzenle(false); setAra(''); }}>
                  Bitti
                </button>
                <button className="btn btn-sm hizli-sifirla" onClick={sayaclariSifirla}
                        title="Kullanım sayaçlarını sıfırla">
                  <RotateCcw size={14} aria-hidden="true" /> Sayaçları sıfırla
                </button>
              </div>
            </>
          ) : (
            <>
              {sirali.length === 0 ? (
                /* UYDURMA LİSTE YOK. Sayaç birikmeden "en çok kullandığın"
                   diyecek bir veri yok; ekran bunu söyler ve ne yapılacağını
                   gösterir. */
                <p className="hizli-bos">
                  Menülerde gezdikçe en çok açtıklarınız burada birikir.
                  Dilerseniz şimdiden birkaç ekranı sabitleyebilirsiniz.
                </p>
              ) : (
                <ul className="hizli-liste">
                  {sirali.map((m, i) => (
                    <li key={m.to}>
                      <Link className="hizli-oge" to={m.to} onClick={() => setAcik(false)}>
                        <span className="hizli-sira" aria-hidden="true">{i + 1}</span>
                        {m.simge && <m.simge className="hizli-oge-simge" aria-hidden="true" />}
                        <span className="hizli-oge-ad">
                          {m.label}
                          <span className="hizli-oge-grup">{m.grup}</span>
                        </span>
                        {sabitler.includes(m.to) && <Pin size={13} aria-label="Sabitlenmiş" />}
                      </Link>
                    </li>
                  ))}
                </ul>
              )}

              <div className="hizli-alt-cubuk">
                <button className="btn btn-sm" onClick={() => setDuzenle(true)}>
                  <Pencil size={14} aria-hidden="true" /> Kısayolları düzenle
                </button>
              </div>
            </>
          )}
        </div>
      )}
    </div>
  );
}
