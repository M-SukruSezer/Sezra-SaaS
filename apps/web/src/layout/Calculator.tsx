import { useEffect, useReducer, useRef, useState } from 'react';
import { Calculator as CalcIcon, Check, Copy, Delete } from 'lucide-react';
import { useList } from '../ui/useResource';

/**
 * Hesap makinesi.
 *
 * BİR ERP'DE HESAP MAKİNESİNİN ASIL İŞİ KDV'DİR: kullanıcı zaten bir fatura
 * ekranındadır ve "bunun KDV'li hâli ne" ya da "bu tutarın içindeki KDV ne"
 * diye sorar. Bu yüzden dört işlemin yanında iki KDV düğmesi var.
 *
 * ORAN KİRACININ KENDİ VERGİ TANIMLARINDAN GELİR, koda yazılmaz: oran
 * mevzuatla değişir ve her kiracı aynı oranları kullanmaz. Tanım okunamazsa
 * genel orana düşülür ve bu, arayüzde görünür bir seçimdir -- sessiz bir
 * varsayım değil.
 */

import {
  BASLANGIC, GENEL_ORAN, hesapIndirge, type HesapEylemi,
} from '../lib/hesap';

export function Calculator() {
  const [acik, setAcik] = useState(false);
  const [durum, gonder] = useReducer(hesapIndirge, BASLANGIC);
  const ekran = durum.ekran;
  const [oran, setOran] = useState(GENEL_ORAN);
  const [kopyalandi, setKopyalandi] = useState(false);
  const kutuRef = useRef<HTMLDivElement>(null);

  // Kiracının KDV oranları. Yalnızca panel açıkken istenir: kapalı bir
  // hesap makinesi için her sayfada istek atmanın anlamı yok.
  const vergiler = useList<{ code: string; rate: string; kind: string }>(
    acik ? '/core/taxes' : '', { limit: 50 });
  const oranlar = [...new Set(
    vergiler.data.filter((v) => v.kind === 'vat').map((v) => Math.round(Number(v.rate))),
  )].filter((r) => r > 0).sort((a, b) => a - b);

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

  const kopyalandiSifirla = () => setKopyalandi(false);

  const kopyala = async () => {
    try {
      await navigator.clipboard.writeText(ekran);
      setKopyalandi(true);
      window.setTimeout(() => setKopyalandi(false), 2000);
    } catch {
      // Pano izni yoksa sessizce geçilir; ekrandaki sayı zaten seçilebilir.
    }
  };

  const tus = (e: HesapEylemi) => { kopyalandiSifirla(); gonder(e); };

  const tuslar: { etiket: string; sinif?: string; eylem: HesapEylemi; ad?: string }[] = [
    { etiket: 'C', sinif: 'hesap-islev', eylem: { tur: 'temizle' }, ad: 'Temizle' },
    { etiket: '±', sinif: 'hesap-islev', eylem: { tur: 'isaret' }, ad: 'İşaret değiştir' },
    { etiket: '%', sinif: 'hesap-islev', eylem: { tur: 'yuzde' }, ad: 'Yüzde' },
    { etiket: '÷', sinif: 'hesap-islem', eylem: { tur: 'islem', op: '/' }, ad: 'Böl' },
    { etiket: '7', eylem: { tur: 'rakam', d: '7' } },
    { etiket: '8', eylem: { tur: 'rakam', d: '8' } },
    { etiket: '9', eylem: { tur: 'rakam', d: '9' } },
    { etiket: '×', sinif: 'hesap-islem', eylem: { tur: 'islem', op: '*' }, ad: 'Çarp' },
    { etiket: '4', eylem: { tur: 'rakam', d: '4' } },
    { etiket: '5', eylem: { tur: 'rakam', d: '5' } },
    { etiket: '6', eylem: { tur: 'rakam', d: '6' } },
    { etiket: '−', sinif: 'hesap-islem', eylem: { tur: 'islem', op: '-' }, ad: 'Çıkar' },
    { etiket: '1', eylem: { tur: 'rakam', d: '1' } },
    { etiket: '2', eylem: { tur: 'rakam', d: '2' } },
    { etiket: '3', eylem: { tur: 'rakam', d: '3' } },
    { etiket: '+', sinif: 'hesap-islem', eylem: { tur: 'islem', op: '+' }, ad: 'Topla' },
    { etiket: '0', eylem: { tur: 'rakam', d: '0' } },
    { etiket: ',', eylem: { tur: 'rakam', d: ',' }, ad: 'Ondalık ayırıcı' },
  ];

  return (
    <div className="hesap" ref={kutuRef}>
      <button
        className={`icon-btn${acik ? ' acik' : ''}`}
        onClick={() => setAcik((v) => !v)}
        aria-expanded={acik}
        aria-haspopup="true"
        title="Hesap makinesi"
        aria-label="Hesap makinesi"
      >
        <CalcIcon size={16} />
      </button>

      {acik && (
        <div className="hesap-panel" role="dialog" aria-label="Hesap makinesi">
          {/* KOPYALAMA EKRANIN YANINDA: kopyalanan şey sonuçtur, KDV değil.
              Alt sıradayken üç düğmenin yanına sığmıyor ve tek başına ikinci
              bir satıra düşüp panelin yüksekliğini elli küsur piksel
              şişiriyordu. */}
          <div className="hesap-ust">
            {/* Ekran salt okunur bir ÇIKTI, girdi alanı değil: tuşlarla
                yazılıyor ve `output` bunu ekran okuyucuya da doğru anlatır. */}
            <output className="hesap-ekran" aria-live="polite">{ekran}</output>
            <button className="icon-btn hesap-kopyala" onClick={() => void kopyala()}
                    title={kopyalandi ? 'Kopyalandı' : 'Sonucu kopyala'}
                    aria-label={kopyalandi ? 'Kopyalandı' : 'Sonucu kopyala'}>
              {kopyalandi ? <Check size={14} /> : <Copy size={14} />}
            </button>
          </div>

          <div className="hesap-tuslar">
            {tuslar.map((t) => (
              <button
                key={t.etiket}
                className={`hesap-tus ${t.sinif ?? ''}`}
                onClick={() => tus(t.eylem)}
                aria-label={t.ad ?? t.etiket}
              >
                {t.etiket}
              </button>
            ))}
            <button className="hesap-tus hesap-islev"
                    onClick={() => tus({ tur: 'geriSil' })} aria-label="Son basamağı sil">
              <Delete size={16} aria-hidden="true" />
            </button>
            <button className="hesap-tus hesap-esittir" onClick={() => tus({ tur: 'esittir' })} aria-label="Eşittir">
              =
            </button>
          </div>

          <div className="hesap-kdv">
            <button className="btn btn-sm" onClick={() => tus({ tur: 'kdvEkle', oran })}>+KDV %{oran}</button>
            <button className="btn btn-sm" onClick={() => tus({ tur: 'kdvAyir', oran })}
                    title="Brüt tutardan matrahı bulur">
              KDV Ayır
            </button>
            {/* Oran kiracının vergi tanımlarından; tek oran varsa seçici
                gösterilmez, çünkü seçilecek bir şey yoktur. */}
            {oranlar.length > 1 && (
              <select
                value={oran} aria-label="KDV oranı"
                onChange={(e) => setOran(Number(e.target.value))}
              >
                {oranlar.map((r) => <option key={r} value={r}>%{r}</option>)}
              </select>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
