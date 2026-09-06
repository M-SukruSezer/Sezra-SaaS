import { useEffect, useRef, useState } from 'react';
import { MessageCircle, Phone, X } from 'lucide-react';
import type { Branding } from '../api/branding';

/**
 * "Bize ulaşın" kutusu.
 *
 * NUMARALAR VERİDEN GELİR, koda yazılmaz: destek numarası değiştiğinde
 * sürüm çıkmak zorunda kalmak, en çok da tam değiştiği gün acıtır. Platform
 * yöneticisi Ayarlar > Marka'dan günceller, tüm kiracılarda anında değişir.
 *
 * NUMARA YOKSA DÜĞME DE YOKTUR. Boş bir "Bize ulaşın" kutusu, arayan
 * kullanıcıyı bir çıkmaza götürür; hiç göstermemek daha dürüsttür.
 */
export function ContactBox({ branding }: { branding: Branding }) {
  const [acik, setAcik] = useState(false);
  const kutuRef = useRef<HTMLDivElement>(null);
  const k = branding.contact;

  const numaralar = [
    { no: k.phone1, etiket: k.phone1_label },
    { no: k.phone2, etiket: k.phone2_label },
  ].filter((x): x is { no: string; etiket: string | null } => Boolean(x.no));

  useEffect(() => {
    if (!acik) return;
    const kapat = (e: KeyboardEvent) => { if (e.key === 'Escape') setAcik(false); };
    const disari = (e: MouseEvent) => {
      if (kutuRef.current && !kutuRef.current.contains(e.target as Node)) setAcik(false);
    };
    window.addEventListener('keydown', kapat);
    window.addEventListener('mousedown', disari);
    return () => {
      window.removeEventListener('keydown', kapat);
      window.removeEventListener('mousedown', disari);
    };
  }, [acik]);

  if (numaralar.length === 0 && !k.whatsapp) return null;

  /** WhatsApp bağlantısı için numara: yalnızca rakamlar, ülke kodu ile. */
  const waNumara = (k.whatsapp ?? '').replace(/\D/g, '').replace(/^0/, '90');

  return (
    <div className="iletisim" ref={kutuRef}>
      <button
        className={`iletisim-dugme${acik ? ' acik' : ''}`}
        onClick={() => setAcik((v) => !v)}
        aria-expanded={acik}
        aria-haspopup="true"
        title="Bize ulaşın"
        aria-label="Bize ulaşın"
      >
        {/* Referanstaki gibi: önce durum noktası, sonra telefon ikonu,
            sonra orta noktayla ayrılmış numaralar. */}
        <span className="iletisim-nokta" aria-hidden="true" />
        <Phone size={14} aria-hidden="true" />
        <span className="iletisim-numaralar">
          {numaralar.map((n) => <span key={n.no} className="num">{n.no}</span>)}
        </span>
      </button>

      {acik && (
        <div className="iletisim-panel" role="dialog" aria-label="Bize ulaşın">
          <div className="iletisim-baslik">
            <strong>Bize ulaşın</strong>
            <button className="icon-btn" onClick={() => setAcik(false)} aria-label="Kapat">
              <X size={16} />
            </button>
          </div>

          {k.note && <p className="iletisim-not">{k.note}</p>}

          <ul className="iletisim-liste">
            {numaralar.map((n) => (
              <li key={n.no}>
                {/* Numara TIKLANABİLİR: telefonda dokunup arayabilmek,
                    masaüstünde de yazılımla aramayı açar. */}
                <a className="iletisim-satir" href={`tel:${n.no.replace(/\s/g, '')}`}>
                  <Phone size={16} aria-hidden="true" />
                  <span className="iletisim-no num">{n.no}</span>
                  {n.etiket && <span className="iletisim-etiket">{n.etiket}</span>}
                </a>
              </li>
            ))}
          </ul>

          {waNumara && (
            <a
              className="btn btn-ok iletisim-wa"
              href={`https://wa.me/${waNumara}`}
              target="_blank"
              rel="noopener noreferrer"
            >
              <MessageCircle size={16} aria-hidden="true" /> WhatsApp&apos;tan yaz
            </a>
          )}
        </div>
      )}
    </div>
  );
}
