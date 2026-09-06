import { readFileSync } from 'node:fs';
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// Sürüm TEK KAYNAKTAN gelir: package.json. Arayüze elle yazılan bir sürüm
// numarası, yayınlanan sürümden sessizce ayrışır ve destek konuşmasında
// yanlış bilgi verir.
const pkg = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8')) as
  { version: string };

export default defineConfig({
  plugins: [react()],
  define: {
    __APP_VERSION__: JSON.stringify(pkg.version),
  },
  server: {
    port: 5173,
    // API'yi aynı origin altından sun: CORS yapılandırmasına gerek kalmaz
    proxy: {
      '/api': {
        target: 'http://localhost:3000',
        rewrite: (p) => p.replace(/^\/api/, ''),
        // API ayakta değilken Vite ham bir 500 döndürür ve hata "sunucu hatası"
        // gibi görünür. Gerçek sebebi (bağlantı reddedildi) istemciye API'nin
        // kendi hata biçiminde iletiyoruz ki arayüz doğru mesajı gösterebilsin.
        configure: (proxy) => {
          proxy.on('error', (err, _req, res) => {
            const socket = res as unknown as { writableEnded?: boolean };
            if (!('writeHead' in res) || socket.writableEnded) return;
            const refused = (err as NodeJS.ErrnoException).code === 'ECONNREFUSED';
            (res as import('node:http').ServerResponse).writeHead(502, {
              'content-type': 'application/json; charset=utf-8',
            });
            (res as import('node:http').ServerResponse).end(
              JSON.stringify({
                error: {
                  code: refused ? 'api_unreachable' : 'proxy_error',
                  message: refused
                    ? 'API sunucusuna ulaşılamıyor (localhost:3000). Ayrı bir terminalde `npm run dev:api` ile başlatın.'
                    : `API proxy hatası: ${err.message}`,
                },
              }),
            );
          });
        },
      },
    },
  },
});
