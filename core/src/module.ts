import type { FastifyInstance } from 'fastify';

/**
 * Bir modülün API katmanındaki sözleşmesi.
 *
 * `code`, core.modules tablosundaki kodla aynı olmalıdır: sunucu açılışta
 * veritabanına kayıtlı olmayan bir modülü yüklemeyi reddeder — böylece
 * "migration'ı unutulmuş modül" sessizce yarım çalışmaz.
 */
export interface SezraModule {
  code: string;
  register(app: FastifyInstance): void | Promise<void>;
}

/** `core.modules`'tan okunan kayıt satırı. */
export interface ModuleRegistryRow {
  code: string;
  depends_on: readonly string[];
}

/**
 * Yüklenecek modülleri bağımlılık sırasına dizer ve kapıda üç şeyi doğrular:
 * modül kayıtlı mı, bağımlılıkları yükleniyor mu, grafta döngü var mı.
 *
 * NEDEN GEREKLİ: `core.modules.depends_on` baştan beri doluydu (`purchasing`
 * -> `{core,finance}`) ama yalnızca `/core/modules` ucunda GÖSTERİLİYOR,
 * hiçbir yerde uygulanmıyordu. Sonuç sessizdi: `finance` olmadan `purchasing`
 * açılabiliyordu; mal kabul olayı yayınlanıyor, fan-out bu kiracıda açık bir
 * abone bulamıyor ve muhasebe kaydı HİÇ doğmuyordu. Hata da vermiyordu, çünkü
 * `core.emit_event` abonesi olmayan bir olayı sorun saymaz.
 *
 * Yükleme sırası da `apps/api/src/modules.ts` dizisindeki ELLE yazılmış sıraya
 * bağlıydı. Artık sıra buradan türetiliyor; dizi yalnızca "hangi modüller"
 * sorusunu yanıtlıyor, "hangi sırayla" sorusunu değil.
 *
 * Saf fonksiyon: veritabanına dokunmaz, böylece testi veritabanı gerektirmez.
 */
export function resolveModuleOrder(
  modules: readonly SezraModule[],
  registry: readonly ModuleRegistryRow[],
): SezraModule[] {
  const kayitli = new Map(registry.map((r) => [r.code, r.depends_on ?? []]));
  const verilen = new Map<string, SezraModule>();

  for (const mod of modules) {
    if (!kayitli.has(mod.code)) {
      throw new Error(
        `"${mod.code}" modülü core.modules'ta kayıtlı değil — migration'ı çalıştırılmamış olabilir`,
      );
    }
    if (verilen.has(mod.code)) {
      throw new Error(`"${mod.code}" modülü yükleme listesinde iki kez geçiyor`);
    }
    verilen.set(mod.code, mod);
  }

  // Eksik bağımlılıkları TEK SEFERDE bildir: üç modül eksikse üç kez sunucu
  // açıp kapatmak yerine listenin tamamı bir hatada görünsün.
  const eksikler: string[] = [];
  for (const mod of modules) {
    const eksik = (kayitli.get(mod.code) ?? []).filter((d) => !verilen.has(d));
    if (eksik.length > 0) eksikler.push(`"${mod.code}" -> ${eksik.join(', ')}`);
  }
  if (eksikler.length > 0) {
    throw new Error(
      `Modül bağımlılığı eksik (core.modules.depends_on): ${eksikler.join('; ')}. ` +
        'Eksik modülleri apps/api/src/modules.ts listesine ekleyin.',
    );
  }

  const sira: SezraModule[] = [];
  const bitti = new Set<string>();
  const yolda = new Set<string>();

  const gez = (code: string, zincir: readonly string[]): void => {
    if (bitti.has(code)) return;
    if (yolda.has(code)) {
      throw new Error(`Modül bağımlılık döngüsü: ${[...zincir, code].join(' -> ')}`);
    }
    yolda.add(code);
    // Alfabetik gezinti: aynı girdi her zaman aynı sırayı üretsin.
    for (const dep of [...(kayitli.get(code) ?? [])].sort()) {
      gez(dep, [...zincir, code]);
    }
    yolda.delete(code);
    bitti.add(code);
    const mod = verilen.get(code);
    if (mod) sira.push(mod);
  };

  for (const code of [...verilen.keys()].sort()) gez(code, []);
  return sira;
}
