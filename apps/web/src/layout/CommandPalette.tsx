import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { ArrowRight, CornerDownLeft, Plus, Search } from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import type { HizliMadde } from './QuickAccess';

/* ===========================================================================
   Komut paleti
   ===========================================================================
   ÜST ÇUBUKTAKİ ARAMA KUTUSU ÖLÜYDÜ: yer tutucusu "Arama yap veya komut
   çalıştır" diyor, yanında Ctrl+K rozeti duruyordu ama yazılan hiçbir şey
   bir yere gitmiyordu. Rozet gösterip kısayolu bağlamamak, kullanıcıya
   çalışmayan bir söz vermektir. Palet o sözü karşılıyor.

   İKİ BÖLÜM, İKİ FARKLI SORU: "hangi sayfa" ve "ne oluşturayım". İkisi tek
   listede karışsaydı, kullanıcı bir eylemi sayfa sanıp tıklardı.

   YALNIZCA ERİŞİLEBİLİR OLAN LİSTELENİR: liste menünün SÜZÜLMÜŞ hâlinden
   türer, yani modülü kapalı ya da izni olmayan bir ekran hiç önerilmez.
   Önerip boş sayfaya götürmek, hiç önermemekten kötüdür.
   ========================================================================= */

/** Hızlı oluşturma eylemi. Yalnızca GERÇEKTEN çalışan bir hedefi olanlar. */
export interface HizliEylem {
  ad: string;
  /** Gidilecek yol. Kayıt oluşturma ekranı ya da formu açan liste. */
  yol: string;
  simge: LucideIcon;
  /** Kısayol rozeti. Bağlanmadıysa verilmez -- yalancı rozet olmaz. */
  kisayol?: string;
  /** Görünürlük: izin yoksa eylem hiç çizilmez. */
  gorunur: boolean;
  aciklama: string;
}

/**
 * Türkçe duyarlı arama katlaması.
 *
 * Kullanıcı "irsaliye" yazıp "İrsaliyeler"i bulamazsa arama bozuktur.
 * Küçültme önce Türkçe kurala göre yapılır (I -> ı, İ -> i), sonra
 * aksanlar sadeleştirilir ki ASCII klavyeyle yazan da bulsun.
 */
function katla(s: string): string {
  return s
    .toLocaleLowerCase('tr')
    .replace(/ı/g, 'i').replace(/ğ/g, 'g').replace(/ü/g, 'u')
    .replace(/ş/g, 's').replace(/ö/g, 'o').replace(/ç/g, 'c');
}

interface Satir {
  tur: 'eylem' | 'sayfa';
  ad: string;
  altMetin: string;
  yol: string;
  simge: LucideIcon;
  kisayol?: string;
}

export function CommandPalette({ acik, kapat, maddeler, eylemler }: {
  acik: boolean;
  kapat: () => void;
  maddeler: HizliMadde[];
  eylemler: HizliEylem[];
}) {
  const nav = useNavigate();
  const [sorgu, setSorgu] = useState('');
  const [imlec, setImlec] = useState(0);
  const girdiRef = useRef<HTMLInputElement>(null);
  const listeRef = useRef<HTMLDivElement>(null);

  const gorunurEylemler = useMemo(
    () => eylemler.filter((e) => e.gorunur), [eylemler]);

  const { eylemSatirlari, sayfaSatirlari } = useMemo(() => {
    const k = katla(sorgu.trim());
    const es = (metin: string) => k === '' || katla(metin).includes(k);

    const eyl: Satir[] = gorunurEylemler
      .filter((e) => es(e.ad) || es(e.aciklama))
      .map((e) => ({
        tur: 'eylem' as const, ad: e.ad, altMetin: e.aciklama,
        yol: e.yol, simge: e.simge, kisayol: e.kisayol,
      }));

    const say: Satir[] = maddeler
      .filter((m) => es(m.label) || es(m.grup) || es(m.to))
      .map((m) => ({
        tur: 'sayfa' as const, ad: m.label,
        altMetin: `${m.grup} · ${m.to}`,
        yol: m.to, simge: m.simge ?? ArrowRight,
      }));

    return { eylemSatirlari: eyl, sayfaSatirlari: say };
  }, [sorgu, maddeler, gorunurEylemler]);

  const tumSatirlar = useMemo(
    () => [...eylemSatirlari, ...sayfaSatirlari],
    [eylemSatirlari, sayfaSatirlari]);

  // Sorgu değişince imleç başa döner: eski konumda kalsaydı kullanıcı
  // Enter'a bastığında bambaşka bir sayfaya giderdi.
  useEffect(() => { setImlec(0); }, [sorgu]);

  useEffect(() => {
    if (!acik) return;
    setSorgu(''); setImlec(0);
    // Odak girdiye: palet klavyeyle açılıyor, fare beklemek anlamsız.
    const id = window.setTimeout(() => girdiRef.current?.focus(), 0);
    return () => window.clearTimeout(id);
  }, [acik]);

  // İmleç görünür alanın dışına çıkarsa kaydırılır; yoksa ok tuşuyla
  // gezinen kullanıcı seçili satırı kaybeder.
  useLayoutEffect(() => {
    if (!acik) return;
    const el = listeRef.current?.querySelector('[data-imlec="1"]');
    el?.scrollIntoView({ block: 'nearest' });
  }, [imlec, acik]);

  useEffect(() => {
    if (!acik) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') { e.preventDefault(); kapat(); return; }
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        setImlec((v) => (tumSatirlar.length === 0 ? 0 : (v + 1) % tumSatirlar.length));
      } else if (e.key === 'ArrowUp') {
        e.preventDefault();
        setImlec((v) => (tumSatirlar.length === 0 ? 0
          : (v - 1 + tumSatirlar.length) % tumSatirlar.length));
      } else if (e.key === 'Enter') {
        e.preventDefault();
        const s = tumSatirlar[imlec];
        if (s) { kapat(); nav(s.yol); }
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [acik, imlec, tumSatirlar, kapat, nav]);

  if (!acik) return null;

  const git = (yol: string) => { kapat(); nav(yol); };

  let sayac = -1;
  const satirCiz = (s: Satir) => {
    sayac += 1;
    const i = sayac;
    return (
      <button
        key={`${s.tur}-${s.yol}-${s.ad}`}
        className={`palet-satir${i === imlec ? ' imlec' : ''}`}
        data-imlec={i === imlec ? '1' : undefined}
        // Fare imleci satıra gelince klavye imleci de oraya taşınır:
        // iki ayrı "seçili" kavramı olsaydı Enter, farenin gösterdiğinden
        // başka bir satırı açardı.
        onMouseMove={() => setImlec(i)}
        onClick={() => git(s.yol)}
      >
        <span className={`palet-simge palet-simge-${s.tur}`}>
          <s.simge size={16} aria-hidden="true" />
        </span>
        <span className="palet-metin">
          <span className="palet-ad">{s.ad}</span>
          <span className="palet-alt">{s.altMetin}</span>
        </span>
        {s.kisayol && <kbd className="kbd">{s.kisayol}</kbd>}
      </button>
    );
  };

  return (
    <div className="palet-ortu" onMouseDown={(e) => { if (e.target === e.currentTarget) kapat(); }}>
      <div className="palet" role="dialog" aria-modal="true" aria-label="Komut paleti">
        <div className="palet-ara">
          <Search size={18} aria-hidden="true" />
          <input
            ref={girdiRef}
            value={sorgu}
            onChange={(e) => setSorgu(e.target.value)}
            placeholder="Sayfa ara, belge oluştur, modüle git…"
            aria-label="Sayfa ara, belge oluştur, modüle git"
            aria-controls="palet-liste"
            autoComplete="off"
          />
          {/* GERÇEK DÜĞME: tıklanabilir bir <kbd> klavyeyle erişilemez ve
              ekran okuyucuya düğme olduğunu söylemez. Görünüm rozet, davranış
              düğme. */}
          <button className="kbd palet-esc" onClick={kapat} aria-label="Paleti kapat">
            esc
          </button>
        </div>

        <div className="palet-liste" id="palet-liste" ref={listeRef} role="listbox"
             aria-label="Sonuçlar">
          {eylemSatirlari.length > 0 && (
            <>
              <div className="palet-baslik">Hızlı oluştur</div>
              {eylemSatirlari.map(satirCiz)}
            </>
          )}
          {sayfaSatirlari.length > 0 && (
            <>
              <div className="palet-baslik">Sayfaya git</div>
              {sayfaSatirlari.map(satirCiz)}
            </>
          )}
          {tumSatirlar.length === 0 && (
            <div className="palet-bos">
              <strong>Eşleşme yok</strong>
              <span>
                “{sorgu}” için sayfa ya da eylem bulunamadı. Modül kapalıysa
                ekranları burada çıkmaz.
              </span>
            </div>
          )}
        </div>

        <div className="palet-alt-serit">
          <span className="palet-ipucu">
            <CornerDownLeft size={13} aria-hidden="true" /> seç
          </span>
          {gorunurEylemler.length > 0 && (
            <span className="palet-ipucu">
              <Plus size={13} aria-hidden="true" /> hızlı oluştur
            </span>
          )}
          <span className="palet-sayac">
            {maddeler.length} sayfa · {tumSatirlar.length} eşleşme
          </span>
        </div>
      </div>
    </div>
  );
}
