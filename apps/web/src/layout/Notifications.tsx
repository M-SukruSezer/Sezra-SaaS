import { useCallback, useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Bell, CheckCheck, CircleAlert, Info, TriangleAlert } from 'lucide-react';
import { api } from '../api/client';
import { gecenSure, tamZaman } from '../i18n';

/* ===========================================================================
   Bildirimler
   ===========================================================================
   İçerik TÜRETİLİR: vadesi geçen fatura, kritik stok, onay bekleyen izin,
   SLA ihlali. Hiçbiri ayrı bir tabloda saklanmıyor -- saklansaydı fatura
   tahsil edildikten sonra bildirim orada kalırdı. Saklanan tek şey
   kullanıcının neyi gördüğü.

   SAYAÇ YALNIZCA OKUNMAMIŞLARI SAYAR ve sıfırsa hiç çizilmez: her zaman
   görünen bir rozet, sayı sıfır bile olsa dikkat çalar.
   ========================================================================= */

type Ton = 'bilgi' | 'uyari' | 'tehlike';

interface Bildirim {
  key: string; baslik: string; metin: string;
  ton: Ton; yol: string; zaman: string | null; okundu: boolean;
}

const SIMGE: Record<Ton, typeof Info> = {
  bilgi: Info, uyari: TriangleAlert, tehlike: CircleAlert,
};

/** Bildirim listesi arka planda tazelenir; panel kapalıyken de sayaç yaşar. */
const TAZELEME_MS = 2 * 60 * 1000;

export function Notifications() {
  const nav = useNavigate();
  const [acik, setAcik] = useState(false);
  const [liste, setListe] = useState<Bildirim[]>([]);
  const [okunmamis, setOkunmamis] = useState(0);
  const [yukleniyor, setYukleniyor] = useState(false);
  const kutuRef = useRef<HTMLDivElement>(null);

  const cek = useCallback(async () => {
    setYukleniyor(true);
    try {
      const res = await api.get<{ data: Bildirim[]; meta: { okunmamis: number } }>(
        '/notifications?limit=10');
      setListe(res.data);
      setOkunmamis(res.meta.okunmamis);
    } catch {
      // Bildirim alınamazsa çubuk sessiz kalır. Zil bir hata yüzeyi değil;
      // "bildirimler yüklenemedi" uyarısı, bildirimin kendisinden daha
      // fazla dikkat çeker ve hiçbir işe yaramaz.
      setListe([]); setOkunmamis(0);
    } finally { setYukleniyor(false); }
  }, []);

  useEffect(() => {
    void cek();
    const id = window.setInterval(() => void cek(), TAZELEME_MS);
    return () => window.clearInterval(id);
  }, [cek]);

  useEffect(() => {
    if (!acik) return;
    const esc = (e: KeyboardEvent) => { if (e.key === 'Escape') setAcik(false); };
    const disari = (e: MouseEvent) => {
      if (kutuRef.current && !kutuRef.current.contains(e.target as Node)) setAcik(false);
    };
    window.addEventListener('keydown', esc);
    window.addEventListener('mousedown', disari);
    return () => {
      window.removeEventListener('keydown', esc);
      window.removeEventListener('mousedown', disari);
    };
  }, [acik]);

  const okunduIsaretle = async (keys: string[]) => {
    if (keys.length === 0) return;
    // İyimser güncelleme: sunucu yanıtı beklenmeden liste soluklaşır.
    // Okundu işareti geri alınabilir bir şey değil ve gecikmesi kullanıcıya
    // "tıklamam işe yaramadı" hissi verirdi.
    setListe((l) => l.map((b) => (keys.includes(b.key) ? { ...b, okundu: true } : b)));
    setOkunmamis((v) => Math.max(0, v - keys.length));
    try { await api.post('/notifications/read', { keys }); } catch { await cek(); }
  };

  const git = (b: Bildirim) => {
    setAcik(false);
    void okunduIsaretle(b.okundu ? [] : [b.key]);
    nav(b.yol);
  };

  const hepsiniOku = () => {
    void okunduIsaretle(liste.filter((b) => !b.okundu).map((b) => b.key));
  };

  return (
    <div className="bildirim" ref={kutuRef}>
      <button
        className={`icon-btn${acik ? ' acik' : ''}`}
        onClick={() => setAcik((v) => !v)}
        aria-expanded={acik}
        aria-haspopup="dialog"
        title={okunmamis > 0 ? `${okunmamis} okunmamış bildirim` : 'Bildirimler'}
        aria-label={okunmamis > 0 ? `Bildirimler, ${okunmamis} okunmamış` : 'Bildirimler'}
      >
        <Bell size={16} />
        {/* Sayı SIFIRSA rozet yok: her zaman duran bir rozet dikkat çalar. */}
        {okunmamis > 0 && <span className="bildirim-sayi">{okunmamis > 9 ? '9+' : okunmamis}</span>}
      </button>

      {acik && (
        <div className="bildirim-panel" role="dialog" aria-label="Bildirimler">
          <div className="bildirim-baslik">
            <strong>Bildirimler</strong>
            {okunmamis > 0 && (
              <button className="btn btn-sm" onClick={hepsiniOku}>
                <CheckCheck size={14} aria-hidden="true" /> Tümünü okundu say
              </button>
            )}
          </div>

          <div className="bildirim-liste">
            {liste.map((b) => {
              const Simge = SIMGE[b.ton];
              return (
                <button
                  key={b.key}
                  className={`bildirim-satir bildirim-${b.ton}${b.okundu ? ' okundu' : ''}`}
                  onClick={() => git(b)}
                >
                  <Simge size={16} className="bildirim-simge" aria-hidden="true" />
                  <span className="bildirim-metin">
                    <span className="bildirim-ad">{b.baslik}</span>
                    <span className="bildirim-alt">{b.metin}</span>
                    {b.zaman && (
                      <span className="bildirim-zaman" title={tamZaman(b.zaman)}>
                        {gecenSure(b.zaman)}
                      </span>
                    )}
                  </span>
                  {/* Okunmamışlık renkle DEĞİL, ayrı bir işaretle söylenir:
                      soluk/koyu ayrımı tek başına renk körlüğünde kaybolur. */}
                  {!b.okundu && <span className="bildirim-yeni" aria-label="Okunmamış" />}
                </button>
              );
            })}

            {!yukleniyor && liste.length === 0 && (
              <div className="bildirim-bos">
                <strong>Bekleyen iş yok</strong>
                <span>
                  Vadesi geçen fatura, kritik stok, onay bekleyen izin ya da
                  aşılmış bir destek süresi olduğunda burada görürsünüz.
                </span>
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
