import { useEffect, useState } from 'react';
import {
  ArrowDownRight, ArrowRight, ArrowUpRight, CircleCheck, CircleDashed,
  CircleHelp, Minus,
} from 'lucide-react';
import { api, baglantiDinle, baglantiDurumu, type BaglantiDurumu } from '../api/client';
import { num } from '../i18n';

/** Komut paleti kısayolunun rozet metni. Bağlanan tuşla aynı olmalı. */
const KISAYOL = typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform)
  ? '\u2318 F' : 'Ctrl F';

/**
 * Alt durum çubuğu.
 *
 * Bir "footer" değil, bir DURUM ÇUBUĞUdur: içeriğin bittiğini söylemez,
 * uygulamanın o anki hâlini söyler. Bu yüzden sayfayla birlikte kaymaz,
 * pencerenin altında sabit durur.
 *
 * HER ALAN GERÇEK BİR KAYNAĞA BAĞLIDIR. Bir durum çubuğunun tek işi doğru
 * olmaktır: uydurulmuş bir "çevrimiçi" ya da elle yazılmış bir sürüm
 * numarası, çubuğun tamamına olan güveni bitirir. Kaynağı olmayan bir alan
 * gösterilmez; değeri bilinmeyen bir alan tire ile geçilir, sıfırla değil.
 */

interface FxKur {
  currency: string;
  unit: number;
  selling: string | null;
  change_pct: string | null;
  bulletin_date: string | null;
  bulletin_no: string | null;
}

interface FxYanit {
  rates: FxKur[];
  source: string;
  fetched_at: string | null;
  stale: boolean;
}

/** Kur bülteni gün içinde bir kez değişir; sık sormanın anlamı yok. */
const FX_ARALIK_MS = 15 * 60 * 1000;

const saat = (d: Date) =>
  d.toLocaleTimeString('tr-TR', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
const saatKisa = (d: Date) =>
  d.toLocaleTimeString('tr-TR', { hour: '2-digit', minute: '2-digit' });

function useBaglanti(): BaglantiDurumu {
  const [durum, setDurum] = useState<BaglantiDurumu>(baglantiDurumu);
  useEffect(() => baglantiDinle(setDurum), []);
  return durum;
}

/**
 * "Son sync" saniye saniye yaşlanır; çubuğun kendisi de her saniye yeniden
 * çizilmesin diye yalnızca görüntülenen değer bir aralıkla tazelenir.
 */
function useSaniyeTikTak(): void {
  const [, setTik] = useState(0);
  useEffect(() => {
    const id = window.setInterval(() => setTik((t) => t + 1), 1000);
    return () => window.clearInterval(id);
  }, []);
}

export function StatusBar() {
  const baglanti = useBaglanti();
  const [fx, setFx] = useState<FxYanit | null>(null);
  useSaniyeTikTak();

  useEffect(() => {
    let iptal = false;
    const cek = async () => {
      try {
        const res = await api.get<{ data: FxYanit }>('/fx/rates');
        if (!iptal) setFx(res.data);
      } catch {
        // Kur alınamazsa çubuk kur alanını göstermez. Durum çubuğunun
        // kendisi bir hata yüzeyi değildir; sessizce eksik kalır.
        if (!iptal) setFx(null);
      }
    };
    void cek();
    const id = window.setInterval(() => void cek(), FX_ARALIK_MS);
    return () => { iptal = true; window.clearInterval(id); };
  }, []);

  const cevrimici = baglanti.durum === 'cevrimici';
  const bilinmiyor = baglanti.durum === 'bilinmiyor';

  const bultenSaati = fx?.fetched_at ? saatKisa(new Date(fx.fetched_at)) : null;

  return (
    <footer className="statusbar">
      <div className="statusbar-sol">
        <span className="statusbar-oge" title={baglanti.sonHata ?? undefined}>
          {/* Çevrimiçiyken nokta SONAR gibi dışa doğru atar: bağlantının
              canlı olduğunu, durağan bir noktanın söyleyemeyeceği biçimde
              söyler. Dalga yalnızca çevrimiçiyken çalışır -- kopukken de
              atsaydı "her şey yolunda" der gibi olurdu. */}
          <span
            className={`durum-noktasi${cevrimici ? ' durum-ok durum-sonar' : bilinmiyor ? '' : ' durum-hata'}`}
            aria-hidden="true"
          />
          {/* Renk TEK BAŞINA anlam taşımaz: nokta yanında her zaman kelime var. */}
          {bilinmiyor ? 'Bağlanıyor' : cevrimici ? 'Çevrimiçi' : 'Çevrimdışı'}
        </span>

        <span className="statusbar-ayrac" aria-hidden="true" />

        <span className="statusbar-oge">
          {/* Simge durumu ANLATIR: son eşitlemenin başarılı olduğunu tek
              bakışta söyler, kelimeyi okumaya gerek bırakmadan. Kelime yine
              de yerinde -- simge tek başına taşımaz. */}
          {/* Başarılı eşitleme YEŞİL: simge tek başına "oldu mu" sorusunu
              yanıtlar. Hiç eşitlenmediyse nötr kalır -- yeşil bir "hiç" ,
              olmamış bir şeyi olmuş gibi gösterirdi. */}
          {baglanti.sonBasari
            ? <CircleCheck size={12} className="statusbar-sync-ok" aria-hidden="true" />
            : <CircleDashed size={12} aria-hidden="true" />}
          Son sync{' '}
          {baglanti.sonBasari
            ? <span className="num">{saat(baglanti.sonBasari)}</span>
            : <span className="statusbar-bos">—</span>}
        </span>

        <span className="statusbar-ayrac" aria-hidden="true" />

        <span className="statusbar-telif">
          © {new Date().getFullYear()}{' '}
          <strong>Sezra Yazılım ve Bilişim Teknolojileri Tic. Ltd. Şti.</strong>
          {' '}— Tüm hakları saklıdır.
        </span>
      </div>

      <div className="statusbar-sag">
        {fx && fx.rates.length > 0 && (
          <span className="statusbar-kur">
            {fx.rates.map((k) => {
              const deger = k.selling === null ? null : Number(k.selling);
              const degisim = k.change_pct === null ? null : Number(k.change_pct);
              // YÖN OKU renkten bağımsız bir işaret: yükseliş, düşüş ve
              // "değişmedi" üç farklı ŞEKİL. Yalnızca yeşil/kırmızı ile
              // kodlansaydı renk körlüğünde üçü de aynı görünürdü.
              const Ok = degisim === null ? Minus
                : degisim > 0 ? ArrowUpRight
                : degisim < 0 ? ArrowDownRight : ArrowRight;
              const ton = degisim === null ? 'statusbar-bos'
                : degisim > 0 ? 'fx-artis'
                : degisim < 0 ? 'fx-azalis' : 'fx-sabit';
              return (
                <span className="statusbar-oge" key={k.currency}>
                  <span className="statusbar-etiket">{k.currency}</span>
                  <span className="num statusbar-kur-deger">
                    {deger === null ? '—' : num(deger, 2)}
                  </span>
                  <span className={`statusbar-degisim ${ton}`}>
                    <Ok size={11} aria-hidden="true" />
                    {degisim === null
                      ? <span title="Önceki bültenle karşılaştırma henüz yok">—</span>
                      : <>{num(Math.abs(degisim), 1)}%</>}
                  </span>
                </span>
              );
            })}
          </span>
        )}

        {fx && (
          <>
            <span className="statusbar-ayrac" aria-hidden="true" />
            <span className="statusbar-oge statusbar-kaynak" title={
              fx.stale
                ? 'TCMB\'ye ulaşılamadı; elimizdeki son bülten gösteriliyor'
                : `Kaynak: TCMB${fx.rates[0]?.bulletin_no ? ` · bülten ${fx.rates[0].bulletin_no}` : ''}`
            }>
              {fx.source}{bultenSaati ? ` · ${bultenSaati}` : ''}
              {fx.stale && <span className="badge badge-warn statusbar-rozet">eski</span>}
            </span>
          </>
        )}

        <span className="statusbar-ayrac" aria-hidden="true" />
        <span className="statusbar-oge statusbar-surum">v{__APP_VERSION__}</span>

        <a className="statusbar-oge statusbar-bag" href="https://sezra.dev/yardim"
           target="_blank" rel="noopener noreferrer">
          <CircleHelp size={12} aria-hidden="true" /> Yardım
        </a>

        {/* Kısayol rozeti GERÇEK: aynı tuş bileşimi komut paletini açıyor.
            Rozet gösterip tuşu bağlamamak, çalışmayan bir söz vermektir. */}
        <kbd className="kbd statusbar-kisayol">{KISAYOL}</kbd>
      </div>
    </footer>
  );
}
