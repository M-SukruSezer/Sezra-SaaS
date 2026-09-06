import type { SmsSaglayici } from './types.js';

/**
 * Günlük sağlayıcısı: mesajı GÖNDERMEZ, kaydeder.
 *
 * Varsayılan budur ve bilinçli: operatör bilgisi girilmemiş bir kurulumda
 * gerçek bir sağlayıcıyı varsaymak, ilk denemede sessiz bir hataya ya da
 * daha kötüsü yanlış bir hesaptan mesaj gitmesine yol açardı.
 *
 * Boru hattının tamamı bu sağlayıcıyla gerçektir: izin kontrolü, numara
 * normalizasyonu, kayıt ve durum yazımı aynen çalışır. Eksik olan tek şey
 * mesajın operatöre çıkması.
 */
export const logSaglayici: SmsSaglayici = {
  code: 'log',
  ad: 'Günlüğe yaz (gönderim yok)',
  gerekliAlanlar: [],
  async gonder(mesaj) {
    // Kayıt zaten `core.sms_messages` tablosunda; burada yalnızca sunucu
    // günlüğüne düşürülür ki geliştirme sırasında görünsün.
    process.stdout.write(
      `[sms:log] ${mesaj.phone} <- ${JSON.stringify(mesaj.body)}\n`);
    return { ok: true, ref: `log-${Date.now()}` };
  },
};
