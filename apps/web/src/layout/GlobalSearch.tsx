import { useCallback, useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Loader2, Search } from 'lucide-react';
import { api } from '../api/client';

/* ===========================================================================
   Üst çubuk araması -- KAYIT arar
   ===========================================================================
   Firma, kişi, ürün, teklif, sipariş, fatura. SAYFA aramak ayrı bir iştir ve
   komut paletine (Ctrl+F) aittir; ikisi tek kutuda toplansaydı "Ahmet" yazan
   kullanıcıya "Cariler" sayfası önerilirdi.

   TEK UÇ: `/search` hepsini tek bağlamda sorgular ve türlere göre gruplar.
   İstemciden altı ayrı liste ucuna paralel istek atmak da işe yarardı ama her
   tuş vuruşunda altı istek demekti.
   ========================================================================= */

interface Satir { id: string; baslik: string; alt: string | null; yol: string }
interface Grup { etiket: string; satirlar: Satir[] }

/** Gecikme: her tuşta istek atmak ucu boğar, beklemek de aramayı yavaşlatır. */
const GECIKME_MS = 250;

export function GlobalSearch() {
  const nav = useNavigate();
  const [q, setQ] = useState('');
  const [gruplar, setGruplar] = useState<Grup[]>([]);
  const [yukleniyor, setYukleniyor] = useState(false);
  const [acik, setAcik] = useState(false);
  const [imlec, setImlec] = useState(0);
  const kutuRef = useRef<HTMLDivElement>(null);
  const girdiRef = useRef<HTMLInputElement>(null);
  /** Yarışı kesmek için: geç dönen eski istek yenisini ezmesin. */
  const istekRef = useRef(0);

  const duzSatirlar = gruplar.flatMap((g) => g.satirlar);

  useEffect(() => {
    const arama = q.trim();
    if (arama.length < 2) { setGruplar([]); setYukleniyor(false); return; }
    setYukleniyor(true);
    const id = window.setTimeout(async () => {
      const benim = ++istekRef.current;
      try {
        const res = await api.get<{ data: Grup[] }>(
          `/search?q=${encodeURIComponent(arama)}&limit=5`);
        // GEÇ DÖNEN İSTEK YOK SAYILIR: "ali" yazarken "al" sorgusu sonra
        // dönerse ekranda yanlış sonuçlar kalırdı.
        if (benim === istekRef.current) { setGruplar(res.data); setImlec(0); }
      } catch {
        if (benim === istekRef.current) setGruplar([]);
      } finally {
        if (benim === istekRef.current) setYukleniyor(false);
      }
    }, GECIKME_MS);
    return () => window.clearTimeout(id);
  }, [q]);

  const kapat = useCallback(() => setAcik(false), []);

  useEffect(() => {
    if (!acik) return;
    const disari = (e: MouseEvent) => {
      if (kutuRef.current && !kutuRef.current.contains(e.target as Node)) kapat();
    };
    window.addEventListener('mousedown', disari);
    return () => window.removeEventListener('mousedown', disari);
  }, [acik, kapat]);

  const git = (s: Satir) => {
    setAcik(false); setQ(''); setGruplar([]);
    girdiRef.current?.blur();
    nav(s.yol);
  };

  const tus = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Escape') { setAcik(false); girdiRef.current?.blur(); return; }
    if (duzSatirlar.length === 0) return;
    if (e.key === 'ArrowDown') {
      e.preventDefault(); setImlec((v) => (v + 1) % duzSatirlar.length);
    } else if (e.key === 'ArrowUp') {
      e.preventDefault(); setImlec((v) => (v - 1 + duzSatirlar.length) % duzSatirlar.length);
    } else if (e.key === 'Enter') {
      e.preventDefault();
      const s = duzSatirlar[imlec];
      if (s) git(s);
    }
  };

  const sonucVar = acik && q.trim().length >= 2;
  let sayac = -1;

  return (
    <div className="search" ref={kutuRef}>
      <Search size={16} className="search-icon" aria-hidden="true" />
      <input
        ref={girdiRef}
        type="search"
        value={q}
        placeholder="Firma, kişi, ürün, teklif, fatura ara…"
        aria-label="Firma, kişi, ürün, teklif, fatura ara"
        aria-expanded={sonucVar}
        aria-controls="arama-sonuc"
        autoComplete="off"
        onFocus={() => setAcik(true)}
        onChange={(e) => { setQ(e.target.value); setAcik(true); }}
        onKeyDown={tus}
      />
      {yukleniyor
        ? <Loader2 size={14} className="search-donen" aria-hidden="true" />
        : <kbd className="kbd">{KISAYOL}</kbd>}

      {sonucVar && (
        <div className="arama-panel" id="arama-sonuc" role="listbox" aria-label="Arama sonuçları">
          {gruplar.map((g) => (
            <div key={g.etiket}>
              <div className="arama-baslik">{g.etiket}</div>
              {g.satirlar.map((s) => {
                sayac += 1;
                const i = sayac;
                return (
                  <button
                    key={`${g.etiket}-${s.id}`}
                    className={`arama-satir${i === imlec ? ' imlec' : ''}`}
                    onMouseMove={() => setImlec(i)}
                    onClick={() => git(s)}
                  >
                    <span className="arama-ad">{s.baslik}</span>
                    {s.alt && <span className="arama-alt">{s.alt}</span>}
                  </button>
                );
              })}
            </div>
          ))}

          {!yukleniyor && gruplar.length === 0 && (
            <div className="arama-bos">
              <strong>Kayıt bulunamadı</strong>
              <span>
                “{q.trim()}” için firma, ürün ya da belge yok. Sayfa aramak
                için <kbd className="kbd">{KISAYOL}</kbd> ile komut paletini açın.
              </span>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

/** Komut paleti kısayolu; boş aramada oraya yönlendirmek için. */
const KISAYOL = typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform)
  ? '⌘ F' : 'Ctrl F';
