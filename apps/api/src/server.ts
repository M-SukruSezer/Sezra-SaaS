import { createApp, EventWorker, closeDb } from '@sezra/core';
import { modules } from './modules.js';

const port = Number(process.env.PORT ?? 3000);

const app = await createApp({ modules });

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
