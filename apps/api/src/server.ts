// ÖNCE ortam değişkenleri: core/db.ts modül seviyesinde DATABASE_URL okuyor.
import './env.js';

import { createApp, EventWorker, closeDb } from '@sezra/core';
import { modules } from './modules.js';

const port = Number(process.env.PORT ?? 3000);

/**
 * Başlangıçta veritabanına ulaşılamamasının nedeni neredeyse her zaman kurulumun
 * eksik olmasıdır. Ham yığın izi yerine ne yapılacağını söyleyen bir mesaj
 * basıyoruz — sunucu ayağa kalkmayınca arayüz tarafında bunun karşılığı,
 * teşhis etmesi çok daha zor olan bir proxy hatasıdır.
 */
function startupHint(err: unknown): string | null {
  const code = (err as { code?: string })?.code;
  switch (code) {
    case '28P01': // invalid_password
      return 'Veritabanı parolası reddedildi.\n' +
        '  .env içindeki DATABASE_URL ile PostgreSQL rolünün parolası uyuşmuyor.\n' +
        '  Rolleri .env ile aynı hâle getirmek için:\n' +
        '    sudo -u postgres bash scripts/dev-db-setup.sh';
    case '3D000': // invalid_catalog_name
      return 'Veritabanı bulunamadı.\n' +
        '  Oluşturmak için:  sudo -u postgres bash scripts/dev-db-setup.sh\n' +
        '  Ardından şema ve demo veri için:  bash scripts/db-reset.sh';
    case '42P01': // undefined_table
      return 'Şema kurulu değil (tablolar yok).\n' +
        '  Migration ve demo veri için:  bash scripts/db-reset.sh';
    case 'ECONNREFUSED':
      return 'PostgreSQL sunucusuna bağlanılamadı.\n' +
        '  Servis çalışıyor mu?  pg_isready';
    default:
      return null;
  }
}

let app: Awaited<ReturnType<typeof createApp>>;
try {
  app = await createApp({ modules });
} catch (err) {
  const hint = startupHint(err);
  if (hint) {
    console.error(`\nAPI başlatılamadı — ${hint}\n`);
    process.exit(1);
  }
  throw err;
}

// Olay işleyici API süreciyle birlikte çalışır. Ölçek büyüdüğünde ayrı bir
// sürece taşınabilir; kuyruk veritabanında olduğu için kod değişmez.
const worker = new EventWorker({ onError: (err) => app.log.error({ err }, 'olay işleyici') });
await worker.start();

const shutdown = async (signal: string) => {
  app.log.info({ signal }, 'kapatılıyor');
  await worker.stop();
  await app.close();
  await closeDb();
  process.exit(0);
};
process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('SIGINT', () => void shutdown('SIGINT'));

await app.listen({ port, host: '0.0.0.0' });
