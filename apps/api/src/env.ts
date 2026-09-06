/**
 * Kök dizindeki .env dosyasını process.env'e yükler.
 *
 * server.ts'te @sezra/core'dan ÖNCE import edilir: ESM modülleri bildirim
 * sırasına göre değerlendirdiği için, core/db.ts'teki modül seviyesindeki
 * `postgres(process.env.DATABASE_URL)` çağrısı gerçekleştiğinde değişkenler
 * çoktan yerindedir.
 *
 * PRECEDENCE: gerçek ortam değişkenleri .env'i EZER. Test betikleri
 * DATABASE_URL'i satır içinde verdiği için bu şart — aksi halde testler
 * geliştirme veritabanına bağlanırdı.
 */
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ENV_PATH = resolve(dirname(fileURLToPath(import.meta.url)), '../../../.env');

function parse(content: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const rawLine of content.split('\n')) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq === -1) continue;
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    if (key) out[key] = value;
  }
  return out;
}

try {
  for (const [key, value] of Object.entries(parse(readFileSync(ENV_PATH, 'utf8')))) {
    if (process.env[key] === undefined) process.env[key] = value;
  }
} catch (err) {
  if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
  // .env yoksa sessizce geç: üretimde değişkenler ortamdan gelir.
}

if (!process.env.DATABASE_URL) {
  throw new Error(
    'DATABASE_URL tanımlı değil.\n' +
      `  .env dosyası bekleniyordu: ${ENV_PATH}\n` +
      '  Kurulum:  cp .env.example .env\n' +
      '  Veritabanı henüz yoksa:  sudo -u postgres bash scripts/dev-db-setup.sh',
  );
}
