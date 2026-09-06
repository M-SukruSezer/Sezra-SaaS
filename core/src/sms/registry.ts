import type { SmsSaglayici } from './types.js';
import { logSaglayici } from './log.js';
import { netgsmSaglayici } from './netgsm.js';

const saglayicilar = new Map<string, SmsSaglayici>();

export function registerSmsProvider(s: SmsSaglayici): void {
  saglayicilar.set(s.code, s);
}

/**
 * Sağlayıcıyı koda göre verir.
 *
 * BİLİNMEYEN KOD SESSİZCE `log`'A DÜŞMEZ: ayarında "netgsm" yazan bir kiracı,
 * yazım hatası yüzünden mesajlarının hiç gitmediğini aylarca fark etmezdi.
 */
export function getSmsProvider(code?: string): SmsSaglayici {
  const istenen = code ?? 'log';
  const s = saglayicilar.get(istenen);
  if (!s) {
    throw new Error(
      `SMS sağlayıcısı bulunamadı: "${istenen}". Kayıtlı: ${[...saglayicilar.keys()].join(', ')}`);
  }
  return s;
}

/** Ayar ekranının listeleyeceği sağlayıcılar. */
export function listSmsProviders(): { code: string; ad: string; gerekliAlanlar: string[] }[] {
  return [...saglayicilar.values()].map((s) => ({
    code: s.code, ad: s.ad, gerekliAlanlar: s.gerekliAlanlar as string[],
  }));
}

registerSmsProvider(logSaglayici);
registerSmsProvider(netgsmSaglayici);
