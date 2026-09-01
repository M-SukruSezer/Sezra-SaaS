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
