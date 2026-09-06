import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5174,
    proxy: {
      '/api': {
        target: 'http://localhost:3000',
        rewrite: (p) => p.replace(/^\/api/, ''),
        // Kasa istemcisi için proxy hatası NORMAL bir durumdur (internet yok).
        // 502 döndürüyoruz; uygulama bunu "çevrimdışı" olarak yorumlayıp
        // fişi kuyruğa alıyor — hata ekranı göstermiyor.
        configure: (proxy) => {
          proxy.on('error', (_err, _req, res) => {
            const r = res as import('node:http').ServerResponse;
            if (!('writeHead' in res) || r.writableEnded) return;
            r.writeHead(502, { 'content-type': 'application/json; charset=utf-8' });
            r.end(JSON.stringify({ error: { code: 'offline', message: "API'ye ulaşılamıyor" } }));
          });
        },
      },
    },
  },
});
