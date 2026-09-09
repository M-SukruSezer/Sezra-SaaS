/**
 * Mail kimlik bilgisi şifreleme -- UYGULAMA KATMANINDA.
 *
 * Neden burada, veritabanında değil: anahtar veritabanına HİÇ girmez. Bir
 * yedek dökümü ya da sızan bir bağlantı, şifreli blob'u ele geçirse bile
 * anahtar olmadan işe yaramaz. Veritabanı `secret_cipher` için bir opak metin
 * deposundan ibarettir.
 *
 * ANAHTAR: `MAIL_SECRET_KEY` ortam değişkeni. 32 bayt; 64 hex karakter ya da
 * base64 olarak verilir. Yoksa/geçersizse kimlik bilgisi SAKLANAMAZ -- çağıran
 * açık bir hata alır, sessizce düz metne düşülmez.
 *
 * ŞİFRE: AES-256-GCM (kimliği doğrulanmış şifreleme; kurcalama tespit edilir).
 * Blob biçimi:  v1:<iv_b64>:<tag_b64>:<ciphertext_b64>
 */
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { AppError } from '../errors.js';
import type { MailSecret } from './types.js';

const ENV_KEY = 'MAIL_SECRET_KEY';

function loadKey(): Buffer | null {
  const raw = process.env[ENV_KEY]?.trim();
  if (!raw) return null;
  const buf = /^[0-9a-fA-F]{64}$/.test(raw)
    ? Buffer.from(raw, 'hex')
    : Buffer.from(raw, 'base64');
  return buf.length === 32 ? buf : null;
}

/** Anahtar tanımlı ve geçerli mi. Panelde "kimlik bilgisi saklanamıyor" uyarısı için. */
export function isSecretStoreConfigured(): boolean {
  return loadKey() !== null;
}

function requireKey(): Buffer {
  const key = loadKey();
  if (!key) {
    throw new AppError(
      503, 'mail_secret_unconfigured',
      'Mail kimlik bilgisi saklama yapılandırılmamış: MAIL_SECRET_KEY eksik ya da ' +
      'geçersiz (32 bayt; 64 hex ya da base64 bekleniyor).',
    );
  }
  return key;
}

/** Gizli demeti şifreler. Sonuç veritabanına yazılabilir opak bir metindir. */
export function encryptSecret(secret: MailSecret): string {
  const key = requireKey();
  const iv = randomBytes(12);
  const c = createCipheriv('aes-256-gcm', key, iv);
  const pt = Buffer.from(JSON.stringify(secret), 'utf8');
  const ct = Buffer.concat([c.update(pt), c.final()]);
  const tag = c.getAuthTag();
  return `v1:${iv.toString('base64')}:${tag.toString('base64')}:${ct.toString('base64')}`;
}

/**
 * Şifreli blob'u çözer. YALNIZCA uygulamanın kendi kullanımı için (bağlantı
 * doğrulama, ileride posta çekme). Sonuç bir HTTP yanıtına ASLA konmaz.
 */
export function decryptSecret(cipher: string): MailSecret {
  const key = requireKey();
  const parts = cipher.split(':');
  if (parts.length !== 4 || parts[0] !== 'v1') {
    throw new AppError(500, 'mail_secret_corrupt', 'Saklanan kimlik bilgisi biçimi tanınmadı.');
  }
  const [, ivb, tagb, ctb] = parts as [string, string, string, string];
  try {
    const d = createDecipheriv('aes-256-gcm', key, Buffer.from(ivb, 'base64'));
    d.setAuthTag(Buffer.from(tagb, 'base64'));
    const pt = Buffer.concat([d.update(Buffer.from(ctb, 'base64')), d.final()]);
    return JSON.parse(pt.toString('utf8')) as MailSecret;
  } catch {
    // Yanlış anahtar ya da kurcalanmış blob.
    throw new AppError(500, 'mail_secret_corrupt', 'Saklanan kimlik bilgisi çözülemedi.');
  }
}
