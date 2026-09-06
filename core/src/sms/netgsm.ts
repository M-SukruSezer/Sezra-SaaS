import type { SmsSaglayici } from './types.js';

/**
 * Netgsm HTTP API adapteri.
 *
 * SÖZLEŞME: `https://api.netgsm.com.tr/sms/send/get` uç noktası
 * `usercode`, `password`, `gsmno`, `message`, `msgheader` parametrelerini
 * alır ve gövdesinde boşlukla ayrılmış bir kod döner: "00 <jobid>" başarı,
 * tek başına "20", "30", "40"… hata kodudur.
 *
 * DOĞRULAMA NOTU: bu adapter operatörün belgelenmiş HTTP sözleşmesine göre
 * yazıldı ama CANLI SERVİSE KARŞI ÇALIŞTIRILMADI -- bu ortamda hesap yok.
 * Kodun kendi mantığı (yanıt ayrıştırma, hata eşlemesi, zaman aşımı)
 * sınandı; ağ ucundaki davranış ilk gerçek kurulumda doğrulanmalı.
 */

/** Netgsm hata kodları. Ham kod kullanıcıya gösterilmez; anlamı gösterilir. */
const HATA: Record<string, string> = {
  '20': 'Mesaj metni çok uzun ya da standart dışı karakter içeriyor',
  '30': 'Kullanıcı adı, parola hatalı ya da API erişim izni yok',
  '40': 'Mesaj başlığı (gönderen adı) sistemde tanımlı değil',
  '50': 'Abone hesabı IYS kontrollü gönderime uygun değil',
  '51': 'Aboneliğe tanımlı IYS marka bilgisi bulunamadı',
  '70': 'Gönderilen parametrelerden biri hatalı ya da eksik',
  '80': 'Gönderim sınırı aşıldı',
  '85': 'Aynı numaraya arka arkaya çok fazla gönderim yapıldı',
};

/** Ağ ucu yanıt vermezse istek sonsuza kadar beklemez. */
const ZAMAN_ASIMI_MS = 10_000;

/** Yanıt gövdesini sonuca çevirir. Ayrı fonksiyon: sınanabilir olsun diye. */
export function netgsmYanitCoz(govde: string): { ok: boolean; ref?: string; hata?: string } {
  const t = govde.trim();
  if (t === '') return { ok: false, hata: 'Operatör boş yanıt döndü' };
  const [kod, ref] = t.split(/\s+/);
  // "00" ve "01" başarı kodlarıdır; ikisi de iş kimliğiyle birlikte döner.
  if (kod === '00' || kod === '01') return { ok: true, ref: ref ?? kod };
  return { ok: false, hata: HATA[kod ?? ''] ?? `Operatör hata kodu: ${t}` };
}

export const netgsmSaglayici: SmsSaglayici = {
  code: 'netgsm',
  ad: 'Netgsm',
  gerekliAlanlar: ['username', 'password', 'sender'],
  async gonder(mesaj, ayar) {
    if (!ayar.username || !ayar.password || !ayar.sender) {
      return { ok: false, hata: 'Netgsm için kullanıcı adı, parola ve gönderen adı gerekli' };
    }
    // Operatör numarayı ülke kodsuz ve sıfırsız ister: 5321234567.
    const gsm = mesaj.phone.replace(/^\+90/, '');
    const params = new URLSearchParams({
      usercode: ayar.username,
      password: ayar.password,
      gsmno: gsm,
      message: mesaj.body,
      msgheader: ayar.sender,
      dil: 'TR',
    });

    const iptal = new AbortController();
    const zamanlayici = setTimeout(() => iptal.abort(), ZAMAN_ASIMI_MS);
    try {
      const res = await fetch('https://api.netgsm.com.tr/sms/send/get', {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: params.toString(),
        signal: iptal.signal,
      });
      if (!res.ok) return { ok: false, hata: `Operatör HTTP ${res.status}` };
      return netgsmYanitCoz(await res.text());
    } catch (err) {
      return {
        ok: false,
        hata: err instanceof Error && err.name === 'AbortError'
          ? 'Operatöre ulaşılamadı (zaman aşımı)'
          : 'Operatöre ulaşılamadı',
      };
    } finally {
      clearTimeout(zamanlayici);
    }
  },
};
