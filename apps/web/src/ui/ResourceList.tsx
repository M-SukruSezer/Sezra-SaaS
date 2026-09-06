import {
  useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode,
} from 'react';
import { Link } from 'react-router-dom';
import {
  ChevronDown, Columns3, Download, Filter, FileDown, FileUp, ListFilter,
  RotateCw, Search, Trash2, X,
} from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import { api, ApiError, type ListResponse } from '../api/client';
import { useSession } from '../api/session';
import { Empty, EmptyPage, ErrorBox, PageFoot } from './index';

/* ===========================================================================
   MODÜL LİSTESİ -- her modülün liste ekranının TEK kaynağı.
   ===========================================================================

   NEDEN TEK BİLEŞEN: yirmi beş liste ekranını tek tek yazmak, yirmi beş
   farklı "seçili kayıt" davranışı, yirmi beş farklı boş durum ve yirmi beş
   yerde düzeltilecek bir hata demektir. Bir kolon şartnamesi verilir, ekranın
   geri kalanı buradan gelir: arama, sıralama, kolon süzgeci, yoğunluk,
   gruplama, seçim, dışa/içe aktarma, toplu silme.

   SUNUCU TARAFI GERÇEK: sıralama, süzgeç, arama ve sayfalama uca gider
   (`?sort= &order= &kolon__op= &q= &limit= &offset=`). İstemcide sıralamak,
   yalnızca ilk sayfayı sıralar ve kullanıcıya TÜM kaydı sıraladığını
   söyler -- sessiz bir yalan. Yalnızca gruplama istemcidedir ve bu, arayüzde
   "görünen kayıtlar" diye yazılıdır.

   YOK OLAN DÜĞME YOK: bir eylem ancak gerçekten çalışıyorsa çizilir. Toplu
   silme yalnızca silme izni varken, arama yalnızca uç `q` destekliyorsa,
   içe aktarma yalnızca yazma izni varken görünür.
   ========================================================================= */

/** Bir kolonun şartnamesi. */
export interface Kolon<T> {
  /** Veri alanı adı. Sıralama ve süzgeç bu adla uca gider. */
  anahtar: string;
  baslik: string;
  /** Hücre içeriği. Rozet, bağlantı, ölçü -- ne gerekiyorsa. */
  govde: (satir: T) => ReactNode;
  /**
   * Dışa aktarımın DÜZ METİN karşılığı. Verilmezse `govde` bir React
   * düğümü döndürdüğü için CSV'ye "[object Object]" yazılırdı.
   */
  disa?: (satir: T) => string | number;
  hizala?: 'sag';
  /** Uç bu kolonla sıralayabiliyor mu (kolon beyaz listesinde mi). */
  sirala?: boolean;
  /** Kolon süzgeci: serbest metin (ilike) ya da sabit seçenekler (eşitlik). */
  suz?: 'metin' | 'secim';
  secenekler?: { deger: string; etiket: string }[];
  /** Kolon seçicide kapalı başlar. Yer kaplayan ikincil alanlar için. */
  gizliBaslangic?: boolean;
  /** Gruplama açılır listesinde çıksın mı. */
  gruplanir?: boolean;
}

/** Üst şeritteki modül yeteneği. Metni DOĞRU olmalı: burada yazan şey ürünün
 *  gerçekten yaptığı iştir, pazarlama cümlesi değil. */
export interface Yetenek {
  simge: LucideIcon;
  etiket: string;
  deger: string;
}

export interface ResourceListProps<T> {
  /** Başlığın üstündeki mono şerit: "SATIŞ · TEKLİFLER". */
  kicker: string;
  baslik: string;
  altBaslik?: ReactNode;
  /** Başlığın altındaki sayaçlar. İlki ana sayıdır. */
  sayimlar?: (toplam: number, satirlar: T[]) => { deger: ReactNode; etiket: string }[];
  yetenekler?: Yetenek[];

  /** Liste ucu, ör. '/core/partners'. */
  yol: string;
  /** Değişmeyen süzgeçler (ör. fatura türü). Kullanıcı bunları kaldıramaz. */
  sabitSuzgec?: Record<string, string | number | undefined>;
  varsayilanSirala?: { kolon: string; yon: 'asc' | 'desc' };
  /** Verilirse arama kutusu çıkar. Uç `searchable` tanımlamıyorsa VERİLMEZ. */
  aramaYer?: string;

  kolonlar: Kolon<T>[];
  /** Satır kimliği. Varsayılan `id`. */
  anahtarAl?: (satir: T) => string;
  /** Verilirse bir kolon detay sayfasına bağlantı olur. */
  satirYolu?: (satir: T) => string;
  /**
   * Bağlantının hangi kolona konacağı. Varsayılan ilk görünür kolon.
   *
   * NEDEN AYARLANABİLİR: ilk kolon çoğu belgede numaradır ve tıklanacak
   * doğru yerdir; ama caride ilk kolon KODDUR ve kod çoğu zaman boştur.
   * Boş bir hücreye ("—") bağlantı koymak, bağlantıyı bulunamaz yapar.
   */
  baglantiAnahtari?: string;

  /** Sağ üstteki ana eylem. */
  birincilEylem?: ReactNode;
  /** Toplu silme yalnızca bu izin varken çıkar. */
  silmeIzni?: string;
  /** İçe aktarma yalnızca bu izin varken çıkar. */
  yazmaIzni?: string;
  /** İçe aktarımda gönderilebilecek alanlar (ucun `writable` listesi). */
  yazilabilir?: string[];

  /**
   * Satır sonu eylemleri (onayla, hesapla, muhasebeleştir).
   *
   * `yenile` VERİLİYOR: eylem kaydı değiştirdiğinde liste kendini yeniden
   * çekmeli. Çağıran tarafın kendi yenileme mekanizmasını kurması, iki ayrı
   * doğruluk kaynağı demek olurdu -- ekranda eski satır, sunucuda yeni kayıt.
   */
  satirEylem?: (satir: T, yenile: () => Promise<void>) => ReactNode;
  /** Satır eylem sütununun başlığı. Görsel olarak boş bırakılır. */
  /**
   * Veri geldiğinde çağrılır.
   *
   * Sayfanın listeden TÜREYEN ama listenin DIŞINDA duran bir şeyi varsa
   * (bordronun "teyitsiz parametre" uyarısı gibi) buradan öğrenir. Aynı şeyi
   * `gostergeler` içinde yapmak, çizim sırasında üst bileşenin durumunu
   * değiştirmek olurdu -- React bunu hata sayar ve haklıdır.
   */
  onVeri?: (satirlar: T[], toplam: number) => void;

  /** Tablonun üstündeki gösterge bandı. */
  gostergeler?: (satirlar: T[], toplam: number) => ReactNode;
  bosBaslik: string;
  bosMetin: ReactNode;
  dipnot?: ReactNode;
}

type Yogunluk = 'sikisik' | 'normal' | 'ferah';
const SAYFA_BOYU = 50;

/** Kalıcı tercihler kaynak başına saklanır: kullanıcı her ekranı kendi
 *  düzeninde bırakır ve ertesi gün aynı düzende bulur. */
function tercihOku<V>(anahtar: string, varsayilan: V): V {
  try {
    const ham = localStorage.getItem(anahtar);
    return ham ? (JSON.parse(ham) as V) : varsayilan;
  } catch { return varsayilan; }
}
function tercihYaz(anahtar: string, deger: unknown): void {
  try { localStorage.setItem(anahtar, JSON.stringify(deger)); } catch { /* kota dolu */ }
}

/**
 * CSV üretimi.
 *
 * AYIRICI NOKTALI VİRGÜL: Türkçe yerelde Excel ondalık ayırıcı olarak virgül
 * kullanır, dolayısıyla virgülle ayrılmış bir dosyayı tek sütuna yükler.
 * BOM da şart -- onsuz Excel dosyayı Latin-1 sanır ve Türkçe harfleri bozar.
 */
function csvUret(basliklar: string[], satirlar: (string | number)[][]): Blob {
  const kacir = (v: string | number) => {
    const s = String(v ?? '');
    return /[";\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const govde = [basliklar, ...satirlar].map((r) => r.map(kacir).join(';')).join('\r\n');
  return new Blob([`﻿${govde}`], { type: 'text/csv;charset=utf-8' });
}

function dosyaIndir(blob: Blob, ad: string): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = ad;
  document.body.appendChild(a); a.click(); a.remove();
  URL.revokeObjectURL(url);
}

/**
 * CSV ayrıştırma. Tırnak içindeki ayırıcıyı ve çift tırnak kaçışını tanır;
 * `split(';')` bunu tanımaz ve tırnaklı bir adres alanı tabloyu kaydırır.
 */
function csvAyristir(metin: string): string[][] {
  const out: string[][] = [];
  let satir: string[] = [];
  let hucre = '';
  let tirnakta = false;
  const t = metin.replace(/^﻿/, '');
  for (let i = 0; i < t.length; i++) {
    const c = t[i]!;
    if (tirnakta) {
      if (c === '"') {
        if (t[i + 1] === '"') { hucre += '"'; i++; } else { tirnakta = false; }
      } else { hucre += c; }
    } else if (c === '"') { tirnakta = true; }
    else if (c === ';') { satir.push(hucre); hucre = ''; }
    else if (c === '\n') { satir.push(hucre); out.push(satir); satir = []; hucre = ''; }
    else if (c !== '\r') { hucre += c; }
  }
  if (hucre !== '' || satir.length > 0) { satir.push(hucre); out.push(satir); }
  return out.filter((r) => r.some((h) => h.trim() !== ''));
}

/** Dışarı tıklama ve Escape ile kapanan açılır katman. */
function useKapanir(acik: boolean, kapat: () => void) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!acik) return;
    const esc = (e: KeyboardEvent) => { if (e.key === 'Escape') kapat(); };
    const disari = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) kapat();
    };
    window.addEventListener('keydown', esc);
    window.addEventListener('mousedown', disari);
    return () => {
      window.removeEventListener('keydown', esc);
      window.removeEventListener('mousedown', disari);
    };
  }, [acik, kapat]);
  return ref;
}

/* --------------------------------------------------------------------------
   Kolon süzgeci
   --------------------------------------------------------------------------
   KONUM SABİT (`position: fixed`) ve koordinatlar JS'ten geliyor. Sebebi
   ölçüldü: süzgeç paneli tablo başlığının içinde duruyor ve tablo
   `overflow-x: auto` ile kayabiliyor -- normal akışta panel o taşmaya
   takılıp KIRPILIYOR. Aynı hata daraltılmış yan menünün uçan panelinde de
   yaşandı; çözüm oradaki ile aynı.
   ------------------------------------------------------------------------ */
function SutunSuzgec({ kolon, deger, uygula }: {
  kolon: Kolon<unknown>; deger: string; uygula: (v: string) => void;
}) {
  const [acik, setAcik] = useState(false);
  const [taslak, setTaslak] = useState(deger);
  const [konum, setKonum] = useState<{ top: number; left: number } | null>(null);
  const dugmeRef = useRef<HTMLButtonElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const kapat = useCallback(() => setAcik(false), []);
  const sarmalRef = useKapanir(acik, kapat);

  useEffect(() => { setTaslak(deger); }, [deger]);

  const ac = () => {
    const r = dugmeRef.current?.getBoundingClientRect();
    if (r) setKonum({ top: r.bottom + 4, left: r.left });
    setAcik((v) => !v);
  };

  // Panel ekranın sağından ya da altından taşmasın.
  useLayoutEffect(() => {
    if (!acik || !panelRef.current || !konum) return;
    const r = panelRef.current.getBoundingClientRect();
    const yeni = { ...konum };
    if (r.right > window.innerWidth - 8) yeni.left = Math.max(8, window.innerWidth - r.width - 8);
    if (r.bottom > window.innerHeight - 8) yeni.top = Math.max(8, window.innerHeight - r.height - 8);
    if (yeni.left !== konum.left || yeni.top !== konum.top) setKonum(yeni);
  }, [acik, konum]);

  const gonder = (v: string) => { uygula(v); setAcik(false); };

  return (
    <div className="sutun-suz" ref={sarmalRef}>
      <button
        ref={dugmeRef}
        className={`sutun-suz-dugme${deger ? ' dolu' : ''}`}
        onClick={ac}
        aria-expanded={acik}
        aria-haspopup="dialog"
        aria-label={deger ? `${kolon.baslik} süzgeci etkin: ${deger}` : `${kolon.baslik} süz`}
        title={deger ? `Süzgeç: ${deger}` : 'Süz'}
      >
        <Filter size={12} aria-hidden="true" />
      </button>

      {acik && konum && (
        <div
          ref={panelRef}
          className="sutun-suz-panel"
          role="dialog"
          aria-label={`${kolon.baslik} süzgeci`}
          style={{ top: konum.top, left: konum.left }}
        >
          {kolon.suz === 'secim' ? (
            <ul className="sutun-suz-liste">
              <li>
                <button className={deger === '' ? 'secili' : ''} onClick={() => gonder('')}>
                  Tümü
                </button>
              </li>
              {(kolon.secenekler ?? []).map((s) => (
                <li key={s.deger}>
                  <button className={deger === s.deger ? 'secili' : ''}
                          onClick={() => gonder(s.deger)}>
                    {s.etiket}
                  </button>
                </li>
              ))}
            </ul>
          ) : (
            <form onSubmit={(e) => { e.preventDefault(); gonder(taslak.trim()); }}>
              <label className="sutun-suz-etiket" htmlFor={`suz-${kolon.anahtar}`}>
                {kolon.baslik} içinde ara
              </label>
              <input
                id={`suz-${kolon.anahtar}`}
                autoFocus
                value={taslak}
                onChange={(e) => setTaslak(e.target.value)}
                placeholder="İçeren…"
              />
              <div className="sutun-suz-eylem">
                <button type="button" className="btn btn-sm" onClick={() => gonder('')}>
                  Temizle
                </button>
                <button type="submit" className="btn btn-sm btn-primary">Uygula</button>
              </div>
            </form>
          )}
        </div>
      )}
    </div>
  );
}

/* ------------------------------------------------------------------------ */

export function ResourceList<T>(p: ResourceListProps<T>) {
  const { can } = useSession();
  const anahtarAl = p.anahtarAl ?? ((s: T) => String((s as { id?: unknown }).id));
  const depoAnahtari = `sezra.liste.${p.yol}`;

  const [q, setQ] = useState('');
  const [aramaTaslak, setAramaTaslak] = useState('');
  const [sirala, setSirala] = useState(p.varsayilanSirala?.kolon ?? '');
  const [yon, setYon] = useState<'asc' | 'desc'>(p.varsayilanSirala?.yon ?? 'desc');
  const [suzgecler, setSuzgecler] = useState<Record<string, string>>({});
  const [sayfa, setSayfa] = useState(0);
  const [secili, setSecili] = useState<Set<string>>(new Set());
  const [grupla, setGrupla] = useState('');

  const [yogunluk, setYogunluk] = useState<Yogunluk>(
    () => tercihOku<Yogunluk>(`${depoAnahtari}.yogunluk`, 'normal'));
  const [gizli, setGizli] = useState<Set<string>>(() => new Set(
    tercihOku<string[]>(`${depoAnahtari}.gizli`,
      p.kolonlar.filter((k) => k.gizliBaslangic).map((k) => k.anahtar))));

  const [satirlar, setSatirlar] = useState<T[]>([]);
  const [toplam, setToplam] = useState(0);
  const [yukleniyor, setYukleniyor] = useState(true);
  const [hata, setHata] = useState<unknown>(null);
  const [islem, setIslem] = useState<string | null>(null);

  // Sorgu anahtarı: değiştiğinde liste yeniden çekilir VE seçim sıfırlanır.
  const sorgu = useMemo(() => {
    const par: Record<string, string | number | undefined> = {
      ...p.sabitSuzgec,
      limit: SAYFA_BOYU,
      offset: sayfa * SAYFA_BOYU,
    };
    if (sirala) { par.sort = sirala; par.order = yon; }
    if (q) par.q = q;
    for (const [k, v] of Object.entries(suzgecler)) {
      if (!v) continue;
      const kol = p.kolonlar.find((c) => c.anahtar === k);
      par[kol?.suz === 'secim' ? k : `${k}__like`] = v;
    }
    return par;
  }, [p.sabitSuzgec, p.kolonlar, sayfa, sirala, yon, q, suzgecler]);

  const sorguAnahtari = JSON.stringify(sorgu);

  const yukle = useCallback(async () => {
    setYukleniyor(true); setHata(null);
    try {
      const res: ListResponse<T> = await api.list<T>(p.yol, JSON.parse(sorguAnahtari));
      setSatirlar(res.data);
      setToplam(res.meta?.total ?? res.data.length);
    } catch (err) { setHata(err); setSatirlar([]); setToplam(0); }
    finally { setYukleniyor(false); }
  }, [p.yol, sorguAnahtari]);

  useEffect(() => { void yukle(); }, [yukle]);

  // Veri değiştiğinde sayfaya haber ver -- çizim sırasında değil, sonrasında.
  const onVeri = p.onVeri;
  useEffect(() => { onVeri?.(satirlar, toplam); }, [onVeri, satirlar, toplam]);

  /**
   * SORGU DEĞİŞİNCE SEÇİM SIFIRLANIR.
   *
   * Bu bir kolaylık değil, güvenlik önlemi: seçim süzgeç değişimine
   * dayansaydı kullanıcı üç kaydı seçip süzgeci değiştirir ve "Toplu Sil"
   * ile EKRANDA GÖRMEDİĞİ kayıtları silerdi. Seçim her zaman o an görünen
   * listeye aittir.
   */
  useEffect(() => { setSecili(new Set()); }, [sorguAnahtari]);

  useEffect(() => { tercihYaz(`${depoAnahtari}.yogunluk`, yogunluk); }, [depoAnahtari, yogunluk]);
  useEffect(() => { tercihYaz(`${depoAnahtari}.gizli`, [...gizli]); }, [depoAnahtari, gizli]);

  // Aramada gecikme: her tuşta istek atmak ucu boğar.
  useEffect(() => {
    const id = setTimeout(() => { if (aramaTaslak !== q) { setQ(aramaTaslak); setSayfa(0); } }, 300);
    return () => clearTimeout(id);
  }, [aramaTaslak]); // eslint-disable-line react-hooks/exhaustive-deps

  const gorunur = p.kolonlar.filter((k) => !gizli.has(k.anahtar));
  const suzgecSayisi = Object.values(suzgecler).filter(Boolean).length;
  const suzgecVar = suzgecSayisi > 0 || q !== '';
  const seciliSatirlar = satirlar.filter((s) => secili.has(anahtarAl(s)));

  const siralamayiDegistir = (kolon: string) => {
    if (sirala === kolon) setYon((v) => (v === 'asc' ? 'desc' : 'asc'));
    else { setSirala(kolon); setYon('asc'); }
    setSayfa(0);
  };

  const suzgeciAyarla = (kolon: string, deger: string) => {
    setSuzgecler((v) => ({ ...v, [kolon]: deger }));
    setSayfa(0);
  };

  const hepsiniSec = (acik: boolean) => {
    setSecili(acik ? new Set(satirlar.map(anahtarAl)) : new Set());
  };

  const satirSec = (id: string, acik: boolean) => {
    setSecili((v) => {
      const y = new Set(v);
      if (acik) y.add(id); else y.delete(id);
      return y;
    });
  };

  /* --- Dışa aktarma ------------------------------------------------------ */
  const duzMetin = (k: Kolon<T>, s: T): string | number => {
    if (k.disa) return k.disa(s);
    const v = (s as Record<string, unknown>)[k.anahtar];
    return v === null || v === undefined ? '' : String(v);
  };

  const disaAktar = (kume: T[], ad: string) => {
    const kol = gorunur;
    dosyaIndir(
      csvUret(kol.map((k) => k.baslik), kume.map((s) => kol.map((k) => duzMetin(k, s)))),
      `${ad}.csv`,
    );
  };

  /**
   * Tüm kayıtları dışa aktarır -- ekranda görünen sayfayı değil.
   *
   * Kullanıcının "Dışa Aktar"dan beklediği şey listenin TAMAMIDIR. Yalnızca
   * ilk elli satırı yazıp dosyayı "firmalar.csv" diye adlandırmak, eksikliği
   * kullanıcının ancak Excel'de fark edeceği bir yerde saklar.
   */
  const tumunuDisaAktar = async () => {
    setIslem('disa'); setHata(null);
    try {
      const par = JSON.parse(sorguAnahtari) as Record<string, unknown>;
      const hepsi: T[] = [];
      for (let ofs = 0; ofs < 10000; ofs += 200) {
        const res = await api.list<T>(p.yol, { ...par, limit: 200, offset: ofs });
        hepsi.push(...res.data);
        if (res.data.length < 200) break;
      }
      disaAktar(hepsi, p.baslik.toLocaleLowerCase('tr').replace(/\s+/g, '-'));
    } catch (err) { setHata(err); } finally { setIslem(null); }
  };

  const sablonIndir = () => {
    const alanlar = p.yazilabilir ?? [];
    dosyaIndir(csvUret(alanlar, []), `${p.baslik.toLocaleLowerCase('tr').replace(/\s+/g, '-')}-sablon.csv`);
  };

  /* --- İçe aktarma ------------------------------------------------------- */
  const [ithal, setIthal] = useState<{ basliklar: string[]; satirlar: string[][] } | null>(null);
  const [ithalRapor, setIthalRapor] = useState<{ ok: number; hata: string[] } | null>(null);

  const dosyaSec = async (dosya: File) => {
    setHata(null); setIthalRapor(null);
    try {
      const tablo = csvAyristir(await dosya.text());
      if (tablo.length < 2) { setHata(new Error('Dosyada başlık satırı ve en az bir kayıt olmalı.')); return; }
      setIthal({ basliklar: tablo[0]!.map((h) => h.trim()), satirlar: tablo.slice(1) });
    } catch (err) { setHata(err); }
  };

  /**
   * İçe aktarma satır satır POST eder.
   *
   * TOPLU UÇ YOK: kayıtlar tek tek yazılır. Bunun bedeli N istek, kazancı
   * ise HANGİ SATIRIN neden reddedildiğinin bilinmesi -- toplu bir uçta ilk
   * hata çoğunlukla tüm yüklemeyi düşürür ve kullanıcı hangi satırı
   * düzelteceğini bilemez. Rapor satır numarasıyla döner.
   */
  const ithalEt = async () => {
    if (!ithal) return;
    setIslem('ithal'); setHata(null);
    const izinli = new Set(p.yazilabilir ?? []);
    const hatalar: string[] = [];
    let ok = 0;
    for (let i = 0; i < ithal.satirlar.length; i++) {
      const govde: Record<string, string> = {};
      ithal.basliklar.forEach((h, j) => {
        const v = (ithal.satirlar[i]![j] ?? '').trim();
        if (v !== '' && izinli.has(h)) govde[h] = v;
      });
      if (Object.keys(govde).length === 0) { hatalar.push(`${i + 2}. satır: yazılabilir alan yok`); continue; }
      try { await api.post(p.yol, govde); ok++; }
      catch (err) {
        hatalar.push(`${i + 2}. satır: ${err instanceof ApiError ? err.message : 'yazılamadı'}`);
      }
    }
    setIthalRapor({ ok, hata: hatalar });
    setIthal(null);
    setIslem(null);
    await yukle();
  };

  /* --- Toplu silme ------------------------------------------------------- */
  const [silOnay, setSilOnay] = useState(false);
  const topluSil = async () => {
    setIslem('sil'); setHata(null);
    const hatalar: string[] = [];
    for (const s of seciliSatirlar) {
      try { await api.delete(`${p.yol}/${anahtarAl(s)}`); }
      catch (err) { hatalar.push(err instanceof ApiError ? err.message : 'silinemedi'); }
    }
    setSilOnay(false); setIslem(null); setSecili(new Set());
    if (hatalar.length > 0) setHata(new Error(`${hatalar.length} kayıt silinemedi: ${hatalar[0]}`));
    await yukle();
  };

  /* --- Gruplama ---------------------------------------------------------- */
  const gruplanabilir = p.kolonlar.filter((k) => k.gruplanir);
  const gruplar = useMemo(() => {
    if (!grupla) return [{ ad: '', satirlar }];
    const harita = new Map<string, T[]>();
    for (const s of satirlar) {
      const kol = p.kolonlar.find((k) => k.anahtar === grupla);
      const ad = kol ? String(duzMetin(kol, s) || '—') : '—';
      const mevcut = harita.get(ad);
      if (mevcut) mevcut.push(s); else harita.set(ad, [s]);
    }
    return [...harita.entries()].map(([ad, ss]) => ({ ad, satirlar: ss }));
  }, [grupla, satirlar, p.kolonlar]); // eslint-disable-line react-hooks/exhaustive-deps

  /* --- Açılır menüler ---------------------------------------------------- */
  const [aktarAcik, setAktarAcik] = useState(false);
  const [kolonAcik, setKolonAcik] = useState(false);
  const aktarRef = useKapanir(aktarAcik, useCallback(() => setAktarAcik(false), []));
  const kolonRef = useKapanir(kolonAcik, useCallback(() => setKolonAcik(false), []));
  const dosyaRef = useRef<HTMLInputElement>(null);

  const yazabilir = p.yazmaIzni ? can(p.yazmaIzni) : false;
  const silebilir = p.silmeIzni ? can(p.silmeIzni) : false;
  const sayimlar = p.sayimlar?.(toplam, satirlar) ?? [];

  /* --- Hiç kayıt yok: sayfayı sahiplenen boş durum ----------------------- */
  if (!yukleniyor && toplam === 0 && !suzgecVar && !hata) {
    return (
      <>
        <ListeBasligi kicker={p.kicker} baslik={p.baslik} altBaslik={p.altBaslik}
                      sayimlar={[]} eylem={p.birincilEylem} />
        {p.yetenekler && <YetenekSerit yetenekler={p.yetenekler} />}
        <EmptyPage title={p.bosBaslik} action={p.birincilEylem}>{p.bosMetin}</EmptyPage>
      </>
    );
  }

  return (
    <div className={`liste liste-${yogunluk}`}>
      <ListeBasligi
        kicker={p.kicker} baslik={p.baslik} altBaslik={p.altBaslik} sayimlar={sayimlar}
        eylem={
          <div className="liste-eylem">
            <div className="aktar" ref={aktarRef}>
              <button className="btn" onClick={() => setAktarAcik((v) => !v)}
                      aria-expanded={aktarAcik} aria-haspopup="menu" disabled={islem !== null}
                      aria-busy={islem === 'disa' || islem === 'ithal'}>
                <Download size={15} aria-hidden="true" />
                <span className="btn-label">Aktar</span>
                <ChevronDown size={14} aria-hidden="true"
                             className={aktarAcik ? 'aktar-ok acik' : 'aktar-ok'} />
              </button>
              {aktarAcik && (
                <div className="aktar-menu" role="menu">
                  <button role="menuitem" onClick={() => { setAktarAcik(false); void tumunuDisaAktar(); }}>
                    <FileDown size={15} aria-hidden="true" />
                    <span>
                      Dışa Aktar
                      {/* Excel'in açtığı biçim CSV'dir; "Excel" demek dosyayı
                          xlsx sanan kullanıcıyı yanıltırdı. */}
                      <em>Excel uyumlu CSV, tüm kayıtlar</em>
                    </span>
                  </button>
                  {yazabilir && (p.yazilabilir?.length ?? 0) > 0 && (
                    <>
                      <button role="menuitem" onClick={() => { setAktarAcik(false); sablonIndir(); }}>
                        <FileDown size={15} aria-hidden="true" />
                        <span>Şablon İndir<em>Boş başlık satırı</em></span>
                      </button>
                      <button role="menuitem" onClick={() => { setAktarAcik(false); dosyaRef.current?.click(); }}>
                        <FileUp size={15} aria-hidden="true" />
                        <span>İçe Aktar<em>CSV yükle, önizlemeli</em></span>
                      </button>
                    </>
                  )}
                </div>
              )}
            </div>
            {p.birincilEylem}
          </div>
        }
      />

      <input
        ref={dosyaRef} type="file" accept=".csv,text/csv" className="sr-only"
        onChange={(e) => {
          const f = e.target.files?.[0];
          if (f) void dosyaSec(f);
          e.target.value = '';
        }}
      />

      {p.yetenekler && <YetenekSerit yetenekler={p.yetenekler} />}

      <ErrorBox error={hata} />

      {ithalRapor && (
        <div className={ithalRapor.hata.length > 0 ? 'ithal-rapor uyari' : 'ithal-rapor'}>
          <strong>{ithalRapor.ok} kayıt eklendi.</strong>
          {ithalRapor.hata.length > 0 && (
            <>
              <span>{ithalRapor.hata.length} satır yazılamadı:</span>
              <ul>{ithalRapor.hata.slice(0, 5).map((h, i) => <li key={i}>{h}</li>)}</ul>
            </>
          )}
          <button className="btn btn-sm" onClick={() => setIthalRapor(null)}>Kapat</button>
        </div>
      )}

      {ithal && (
        <div className="ithal-onay" role="dialog" aria-label="İçe aktarma önizlemesi">
          <div className="ithal-baslik">
            <strong>{ithal.satirlar.length} satır içe aktarılacak</strong>
            <span className="muted">
              Eşleşen alanlar: {ithal.basliklar.filter((h) => (p.yazilabilir ?? []).includes(h)).join(', ') || 'yok'}
            </span>
          </div>
          {ithal.basliklar.every((h) => !(p.yazilabilir ?? []).includes(h)) && (
            <p className="ithal-uyari">
              Hiçbir başlık bu modülün alanlarıyla eşleşmiyor. Şablonu indirip
              başlık satırını ondan kopyalayın.
            </p>
          )}
          <div className="row">
            <button className="btn btn-sm" onClick={() => setIthal(null)}>Vazgeç</button>
            <button className="btn btn-sm btn-primary" onClick={() => void ithalEt()}
                    disabled={islem !== null} aria-busy={islem === 'ithal'}>
              {islem === 'ithal' ? 'Yazılıyor…' : 'İçe aktar'}
            </button>
          </div>
        </div>
      )}

      {/* --- Araç çubuğu --- */}
      <div className="liste-arac">
        <div className="liste-arac-sol">
          {p.aramaYer && (
            <div className="liste-ara">
              <Search size={15} aria-hidden="true" />
              <input type="search" value={aramaTaslak} placeholder={p.aramaYer}
                     aria-label={p.aramaYer}
                     onChange={(e) => setAramaTaslak(e.target.value)} />
            </div>
          )}
          {suzgecVar && (
            <button className="btn btn-sm" onClick={() => { setSuzgecler({}); setQ(''); setAramaTaslak(''); setSayfa(0); }}>
              <X size={14} aria-hidden="true" />
              Süzgeci temizle{suzgecSayisi > 0 ? ` (${suzgecSayisi})` : ''}
            </button>
          )}
          <button className="icon-btn" onClick={() => void yukle()} disabled={yukleniyor}
                  aria-busy={yukleniyor} title="Yenile" aria-label="Listeyi yenile">
            <RotateCw size={15} />
          </button>
        </div>

        <div className="liste-arac-sag">
          {gruplanabilir.length > 0 && (
            <label className="liste-grupla">
              <ListFilter size={14} aria-hidden="true" />
              <span>Grupla</span>
              <select value={grupla} onChange={(e) => setGrupla(e.target.value)}>
                <option value="">Yok</option>
                {gruplanabilir.map((k) => (
                  <option key={k.anahtar} value={k.anahtar}>{k.baslik}</option>
                ))}
              </select>
            </label>
          )}

          <div className="kolon-sec" ref={kolonRef}>
            <button className="btn btn-sm" onClick={() => setKolonAcik((v) => !v)}
                    aria-expanded={kolonAcik} aria-haspopup="menu">
              <Columns3 size={14} aria-hidden="true" />
              <span className="btn-label">Kolonlar</span>
            </button>
            {kolonAcik && (
              <div className="kolon-menu" role="menu">
                {p.kolonlar.map((k) => (
                  <label key={k.anahtar}>
                    <input
                      type="checkbox"
                      checked={!gizli.has(k.anahtar)}
                      // Son görünür kolon kapatılamaz: kolonu olmayan bir
                      // tablo, verinin gittiğini düşündüren boş bir kutudur.
                      disabled={!gizli.has(k.anahtar) && gorunur.length === 1}
                      onChange={(e) => setGizli((v) => {
                        const y = new Set(v);
                        if (e.target.checked) y.delete(k.anahtar); else y.add(k.anahtar);
                        return y;
                      })}
                    />
                    {k.baslik}
                  </label>
                ))}
              </div>
            )}
          </div>

          <div className="yogunluk" role="group" aria-label="Satır yoğunluğu">
            {([['sikisik', 'Sıkışık'], ['normal', 'Normal'], ['ferah', 'Ferah']] as const).map(([d, ad]) => (
              <button key={d} className={yogunluk === d ? 'secili' : ''}
                      aria-pressed={yogunluk === d}
                      onClick={() => setYogunluk(d)}>
                {ad}
              </button>
            ))}
          </div>
        </div>
      </div>

      {/* --- Toplu işlem şeridi --- */}
      {secili.size > 0 && (
        <div className="toplu" role="region" aria-label="Toplu işlemler">
          <span className="toplu-sayi">{secili.size}</span>
          <span className="toplu-metin">
            kayıt seçili <span className="muted">/ bu sayfadaki {satirlar.length} kayıttan</span>
          </span>
          <button className="btn btn-sm"
                  onClick={() => disaAktar(seciliSatirlar, `${p.baslik.toLocaleLowerCase('tr')}-secili`)}>
            <Download size={14} aria-hidden="true" /> Seçiliyi Dışa Aktar
          </button>
          {silebilir && (
            <button className="btn btn-sm btn-danger" onClick={() => setSilOnay(true)}>
              <Trash2 size={14} aria-hidden="true" /> Toplu Sil
            </button>
          )}
          <button className="btn btn-sm toplu-temizle" onClick={() => setSecili(new Set())}>
            <X size={14} aria-hidden="true" /> Seçimi Temizle
          </button>
        </div>
      )}

      {silOnay && (
        <div className="sil-onay" role="alertdialog" aria-label="Silmeyi onayla">
          <strong>{secili.size} kayıt kalıcı olarak silinecek.</strong>
          <span>Bu işlem geri alınamaz. Belgeye bağlı kayıtlar silinemez ve raporda görünür.</span>
          <div className="row">
            <button className="btn btn-sm" onClick={() => setSilOnay(false)}>Vazgeç</button>
            <button className="btn btn-sm btn-danger" onClick={() => void topluSil()}
                    disabled={islem !== null} aria-busy={islem === 'sil'}>
              {islem === 'sil' ? 'Siliniyor…' : `Evet, ${secili.size} kaydı sil`}
            </button>
          </div>
        </div>
      )}

      {p.gostergeler?.(satirlar, toplam)}

      {/* --- Tablo --- */}
      <div className="card" style={undefined}>
        <div className="tbl-scroll" tabIndex={0} role="region" aria-label={`${p.baslik} tablosu`}>
          <table className="tbl tbl-liste">
            <thead>
              <tr>
                <th className="tbl-sec">
                  {/* Kutu ETİKETLE sarılı: işaretleme kutusunun kendisi
                      görsel olarak küçük kalır ama tıklama alanı WCAG
                      2.5.8'in istediği ölçüye (24x24) çıkar. Ölçüldü:
                      sarmalanmadan önce hedef 13x13 idi. */}
                  <label className="sec-kutu">
                    <input
                      type="checkbox"
                      aria-label="Sayfadaki tüm kayıtları seç"
                      checked={satirlar.length > 0 && secili.size === satirlar.length}
                      ref={(el) => {
                        if (el) el.indeterminate = secili.size > 0 && secili.size < satirlar.length;
                      }}
                      onChange={(e) => hepsiniSec(e.target.checked)}
                    />
                  </label>
                </th>
                {gorunur.map((k) => (
                  <th key={k.anahtar} className={k.hizala === 'sag' ? 'r' : undefined}>
                    <span className="th-ic">
                      {k.sirala ? (
                        <button
                          className={`th-sirala${sirala === k.anahtar ? ' etkin' : ''}`}
                          onClick={() => siralamayiDegistir(k.anahtar)}
                          aria-label={`${k.baslik} sütununa göre sırala`}
                        >
                          {k.baslik}
                          <span className="th-ok" aria-hidden="true">
                            {sirala === k.anahtar ? (yon === 'asc' ? '↑' : '↓') : '↕'}
                          </span>
                        </button>
                      ) : k.baslik}
                      {k.suz && (
                        <SutunSuzgec
                          kolon={k as Kolon<unknown>}
                          deger={suzgecler[k.anahtar] ?? ''}
                          uygula={(v) => suzgeciAyarla(k.anahtar, v)}
                        />
                      )}
                    </span>
                  </th>
                ))}
                {p.satirEylem && <th className="tbl-eylem"><span className="sr-only">Eylemler</span></th>}
              </tr>
            </thead>
            <tbody>
              {gruplar.map((g) => (
                <Grup key={g.ad || 'tek'} ad={g.ad} sayi={g.satirlar.length}
                      kolon={gorunur.length + 1 + (p.satirEylem ? 1 : 0)}>
                  {g.satirlar.map((s) => {
                    const id = anahtarAl(s);
                    const sec = secili.has(id);
                    return (
                      <tr key={id} className={sec ? 'secili' : undefined}>
                        <td className="tbl-sec">
                          <label className="sec-kutu">
                            <input
                              type="checkbox" checked={sec}
                              aria-label="Bu kaydı seç"
                              onChange={(e) => satirSec(id, e.target.checked)}
                            />
                          </label>
                        </td>
                        {gorunur.map((k, i) => {
                          const bagli = p.satirYolu && (p.baglantiAnahtari
                            ? k.anahtar === p.baglantiAnahtari
                            : i === 0);
                          return (
                            <td key={k.anahtar} className={k.hizala === 'sag' ? 'r' : undefined}>
                              {bagli
                                ? <Link className="tbl-bag" to={p.satirYolu!(s)}>{k.govde(s)}</Link>
                                : k.govde(s)}
                            </td>
                          );
                        })}
                        {p.satirEylem && (
                          <td className="tbl-eylem">{p.satirEylem(s, yukle)}</td>
                        )}
                      </tr>
                    );
                  })}
                </Grup>
              ))}
            </tbody>
          </table>
        </div>

        {!yukleniyor && satirlar.length === 0 && (
          <Empty title="Eşleşme yok">
            Süzgeci genişletin ya da aramayı temizleyin.
          </Empty>
        )}
        {yukleniyor && satirlar.length === 0 && (
          <Empty title="Yükleniyor">Kayıtlar getiriliyor.</Empty>
        )}
      </div>

      {toplam > SAYFA_BOYU && (
        <div className="sayfalama">
          <button className="btn btn-sm" disabled={sayfa === 0}
                  onClick={() => { setSayfa((v) => v - 1); }}>
            Önceki
          </button>
          <span>
            <strong>{sayfa * SAYFA_BOYU + 1}</strong>–
            <strong>{Math.min((sayfa + 1) * SAYFA_BOYU, toplam)}</strong>
            {' / '}{toplam} kayıt
          </span>
          <button className="btn btn-sm" disabled={(sayfa + 1) * SAYFA_BOYU >= toplam}
                  onClick={() => { setSayfa((v) => v + 1); }}>
            Sonraki
          </button>
        </div>
      )}

      <PageFoot>
        <span><strong>{satirlar.length}</strong> kayıt görünüyor{toplam > satirlar.length ? ` / ${toplam} toplam` : ''}</span>
        {grupla && <span>Gruplama yalnızca bu sayfadaki kayıtlara uygulanır.</span>}
        {p.dipnot}
      </PageFoot>
    </div>
  );
}

/* --------------------------------------------------------------------------
   Parçalar
   ------------------------------------------------------------------------ */

function ListeBasligi({ kicker, baslik, altBaslik, sayimlar, eylem }: {
  kicker: string; baslik: string; altBaslik?: ReactNode;
  sayimlar: { deger: ReactNode; etiket: string }[];
  eylem?: ReactNode;
}) {
  return (
    <>
      <div className="liste-kicker">{kicker}</div>
      <div className="liste-bas">
        <div className="liste-bas-metin">
          <h1 className="page-title">{baslik}</h1>
          {sayimlar.length > 0 && (
            <div className="liste-sayim">
              {sayimlar.map((s, i) => (
                <span key={s.etiket} className={i === 0 ? 'liste-sayim-ana' : undefined}>
                  <strong>{s.deger}</strong> {s.etiket}
                </span>
              ))}
            </div>
          )}
          {altBaslik && <p className="page-sub">{altBaslik}</p>}
        </div>
        {eylem}
      </div>
    </>
  );
}

/**
 * Yetenek şeridi.
 *
 * Buradaki her hücre modülün GERÇEKTEN yaptığı bir şeyi söyler. Şerit bir
 * pazarlama bandı değil: kullanıcı "bu ekran çoklu para biriyle çalışır mı"
 * diye sorduğunda cevabı ekranı deneyerek değil, bakarak bulsun diye var.
 * Doğru olmayan bir hücre eklemek, şeridin tamamını inanılmaz yapar.
 */
function YetenekSerit({ yetenekler }: { yetenekler: Yetenek[] }) {
  return (
    <div className="yetenek">
      {yetenekler.map((y) => (
        <div className="yetenek-hucre" key={y.etiket}>
          <y.simge size={15} aria-hidden="true" />
          <span className="yetenek-etiket">{y.etiket}</span>
          <span className="yetenek-deger">{y.deger}</span>
        </div>
      ))}
    </div>
  );
}

/** Grup başlığı satırı. Gruplama kapalıyken hiçbir şey sarmalamaz. */
function Grup({ ad, sayi, kolon, children }: {
  ad: string; sayi: number; kolon: number; children: ReactNode;
}) {
  if (!ad) return <>{children}</>;
  return (
    <>
      <tr className="tbl-grup">
        <td colSpan={kolon}>
          <span className="tbl-grup-ad">{ad}</span>
          <span className="tbl-grup-sayi">{sayi} kayıt</span>
        </td>
      </tr>
      {children}
    </>
  );
}
