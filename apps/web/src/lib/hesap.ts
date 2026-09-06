/**
 * Hesap makinesi mantığı.
 *
 * BİLEŞENDEN AYRI BİR DOSYADA ve SAF: JSX taşımadığı için Node doğrudan
 * çalıştırabiliyor, böylece aritmetik tarayıcı olmadan sınanabiliyor.
 * Hesap makinesinin doğruluğu göz kararı onaylanacak bir şey değil.
 */
import { num } from '../i18n.ts';

export const GENEL_ORAN = 20;

/**
 * Ondalık ayırıcı Türkçe: virgül. Girdi de görüntü de aynı dili konuşur.
 *
 * ONDALIK KARARI YUVARLANMIŞ DEĞERE GÖRE VERİLİR. Ham değere bakılırsa
 * kayan nokta artığı sonucu bozuyor: 100 × 1,1 bellekte 110,00000000000001
 * olduğu için "110,00" yazılıyor, oysa 100 × 1,2 tam çıktığı için "120".
 * Aynı işlemin iki farklı biçimde görünmesi, hesap makinesine duyulan
 * güveni bitirir.
 */
const bicimle = (v: number): string => {
  if (!Number.isFinite(v)) return 'Hata';
  const yuvarlanmis = Number(v.toFixed(6));
  return num(yuvarlanmis, Math.abs(yuvarlanmis % 1) > 0 ? 2 : 0);
};

type Islem = '+' | '-' | '*' | '/' | null;

export interface HesapDurumu {
  ekran: string;
  birikim: number | null;
  islem: Islem;
  yeniGiris: boolean;
}

export type HesapEylemi =
  | { tur: 'rakam'; d: string }
  | { tur: 'islem'; op: Islem }
  | { tur: 'esittir' }
  | { tur: 'temizle' }
  | { tur: 'isaret' }
  | { tur: 'yuzde' }
  | { tur: 'geriSil' }
  | { tur: 'kdvEkle'; oran: number }
  | { tur: 'kdvAyir'; oran: number };

export const BASLANGIC: HesapDurumu = {
  ekran: '0', birikim: null, islem: null, yeniGiris: true,
};

const sayiya = (ekran: string): number =>
  Number(ekran.replace(/\./g, '').replace(',', '.')) || 0;

const uygula = (a: number, b: number, op: Islem): number => {
  switch (op) {
    case '+': return a + b;
    case '-': return a - b;
    case '*': return a * b;
    case '/': return b === 0 ? NaN : a / b;
    default: return b;
  }
};

/**
 * Hesap makinesinin tüm mantığı burada, SAF bir işlevde.
 *
 * Önceden her tuş kendi `setState`'ini çağırıyordu ve bunlar durumu
 * DOĞRUDAN okuyordu. React güncellemeleri toplu işlediği için arka arkaya
 * gelen tuşlar birbirinin sonucunu görmüyor, hızlı yazımda basamak
 * düşüyordu. Tek indirgeyici bunu yapısal olarak imkânsız kılar; ayrıca
 * mantık DOM'suz sınanabilir hâle gelir.
 */
export function hesapIndirge(d: HesapDurumu, e: HesapEylemi): HesapDurumu {
  const yaz = (v: number): HesapDurumu =>
    ({ ...d, ekran: bicimle(v), yeniGiris: true });

  switch (e.tur) {
    case 'temizle':
      return BASLANGIC;

    case 'rakam': {
      if (d.yeniGiris) return { ...d, ekran: e.d === ',' ? '0,' : e.d, yeniGiris: false };
      if (e.d === ',' && d.ekran.includes(',')) return d;
      return { ...d, ekran: d.ekran === '0' && e.d !== ',' ? e.d : d.ekran + e.d };
    }

    case 'islem': {
      const mevcut = sayiya(d.ekran);
      if (d.birikim !== null && d.islem && !d.yeniGiris) {
        const sonuc = uygula(d.birikim, mevcut, d.islem);
        return { ekran: bicimle(sonuc), birikim: sonuc, islem: e.op, yeniGiris: true };
      }
      return { ...d, birikim: mevcut, islem: e.op, yeniGiris: true };
    }

    case 'esittir': {
      if (d.birikim === null || !d.islem) return d;
      const sonuc = uygula(d.birikim, sayiya(d.ekran), d.islem);
      return { ekran: bicimle(sonuc), birikim: null, islem: null, yeniGiris: true };
    }

    case 'isaret':  return yaz(-sayiya(d.ekran));
    case 'yuzde':   return yaz(sayiya(d.ekran) / 100);
    case 'kdvEkle': return yaz(sayiya(d.ekran) * (1 + e.oran / 100));
    // KDV Ayır: BRÜT tutardan matrahı çıkarır (içinden ayrıştırma).
    case 'kdvAyir': return yaz(sayiya(d.ekran) / (1 + e.oran / 100));

    case 'geriSil':
      return { ...d, ekran: d.ekran.length > 1 ? d.ekran.slice(0, -1) : '0', yeniGiris: false };

    default:
      return d;
  }
}

