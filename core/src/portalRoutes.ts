import type { FastifyInstance } from 'fastify';
import { contextFromRequest } from './auth.js';
import { withContext } from './db.js';
import { badRequest, notFound, translatePgError } from './errors.js';

/* ===========================================================================
   Müşteri portalı uçları
   ===========================================================================
   JETON YALNIZCA BİR KEZ, OLUŞTURMA YANITINDA DÖNER. Veritabanında sha256
   özeti duruyor; listeleme ucu jetonu geri veremez çünkü elinde yok. Bu
   bilinçli: davet listesini okuyabilen biri, davetleri kabul edebilmemeli.
   Kaybolan jetonun yolu daveti iptal edip yenisini oluşturmaktır.

   KABUL UCU KİMLİK DOĞRULAMALIDIR. Portal kullanıcısı önce kimlik
   sağlayıcısında hesabını açar, sonra bu uca gelir; bağlanacak kimlik
   OTURUMDAN alınır, gövdeden değil. Gövdeden alınsaydı, davet bağlantısını
   ele geçiren biri daveti başka bir hesaba bağlayabilirdi.
   ========================================================================= */

/** Portal davetinin listede dönen alanları. Jeton özeti DIŞARIDA. */
const DAVET_ALANLARI = `
  pi.id, pi.partner_id, pi.contact_id, pi.email, pi.expires_at,
  pi.accepted_at, pi.revoked_at, pi.created_at,
  case
    when pi.revoked_at  is not null then 'revoked'
    when pi.accepted_at is not null then 'accepted'
    when pi.expires_at <= now()     then 'expired'
    else 'pending'
  end as status`;

export function registerPortalRoutes(app: FastifyInstance): void {
  /** Bir carinin portal davetleri. Durum SUNUCUDA hesaplanır: süre dolumunu
   *  istemcinin saatine bırakmak, yanlış saatli bir makinede geçerli daveti
   *  "süresi dolmuş" göstermek demekti. */
  app.get('/core/partners/:id/portal-invitations', async (req) => {
    const { id } = req.params as { id: string };
    const ctx = contextFromRequest(req);
    try {
      return await withContext(ctx, async (tx) => {
        const rows = await tx.unsafe(
          `select ${DAVET_ALANLARI}
             from core.portal_invitations pi
            where pi.partner_id = $1
            order by pi.created_at desc`,
          [id],
        );
        return { data: rows };
      });
    } catch (err) { throw translatePgError(err); }
  });

  /**
   * Davet oluşturur ve jetonu BİR KEZ döner.
   *
   * Bağlantıyı sunucu kurmaz: portal adresi dağıtıma göre değişir ve yanlış
   * alan adıyla üretilmiş bir davet bağlantısı sessizce çalışmaz. Arayüz
   * jetonu kendi kökeniyle birleştirir.
   */
  app.post('/core/partners/:id/portal-invitations', async (req, reply) => {
    const { id } = req.params as { id: string };
    const b = (req.body ?? {}) as Record<string, unknown>;
    const email = typeof b.email === 'string' ? b.email.trim() : '';
    if (email === '') throw badRequest('email zorunlu');

    const gun = Number(b.days ?? 14);
    if (!Number.isFinite(gun) || gun < 1 || gun > 90) {
      throw badRequest('days 1 ile 90 arasında olmalı');
    }

    const ctx = contextFromRequest(req);
    try {
      const sonuc = await withContext(ctx, async (tx) => {
        // TAKMA AD BURADA ÇÖZÜLÜR: fonksiyonun çıktı kolonları
        // (`invite_id`, `expires_until`) tablo kolonlarıyla ad çakışmasın
        // diye öyle adlandırıldı -- bu bir PL/pgSQL kısıtı, API sözleşmesi
        // değil. Uca sızarsa istemci iki farklı ad bilmek zorunda kalır:
        // listede `id`/`expires_at`, oluşturmada başka bir şey.
        const [row] = await tx`
          select invite_id as id, token, expires_until as expires_at
          from core.portal_invite(
            ${id}, ${email}, ${(b.contact_id as string) ?? null}, ${gun})`;
        return row as { id: string; token: string; expires_at: string };
      });
      reply.code(201);
      return { data: sonuc };
    } catch (err) { throw translatePgError(err); }
  });

  /** Daveti iptal eder. Kabul edilmiş davet iptal EDİLMEZ: erişimi kesmenin
   *  yolu üyeliği pasife almaktır, daveti geri almak değil. */
  app.post('/core/portal/invitations/:id/revoke', async (req) => {
    const { id } = req.params as { id: string };
    const ctx = contextFromRequest(req);
    try {
      return await withContext(ctx, async (tx) => {
        const [row] = await tx.unsafe(
          `select ${DAVET_ALANLARI} from core.portal_revoke_invite($1) as pi`,
          [id],
        );
        return { data: row };
      });
    } catch (err) { throw translatePgError(err); }
  });

  /**
   * Daveti kabul etmeden özetler: kabul ekranı hangi firmaya bağlanılacağını
   * yazabilsin. Geçersiz ya da kullanılmış jeton 404 döner.
   */
  app.get('/portal/invitations/:token', async (req) => {
    const { token } = req.params as { token: string };
    const ctx = contextFromRequest(req);
    try {
      return await withContext({ ...ctx, tenantId: undefined }, async (tx) => {
        const [row] = await tx`
          select partner_name, email, expires_until as expires_at
          from core.portal_invite_preview(${token})`;
        if (!row) throw notFound('Davet bağlantısı geçersiz ya da kullanılmış');
        return { data: row };
      });
    } catch (err) { throw translatePgError(err); }
  });

  /**
   * Daveti kabul eder.
   *
   * `x-tenant-id` GEREKMEZ ve kullanılmaz: kabul eden kişinin henüz üyeliği
   * yoktur, kiracıyı davetin kendisi söyler.
   */
  app.post('/portal/accept', async (req) => {
    const b = (req.body ?? {}) as Record<string, unknown>;
    const token = typeof b.token === 'string' ? b.token.trim() : '';
    if (token === '') throw badRequest('token zorunlu');

    const ctx = contextFromRequest(req);
    try {
      return await withContext({ ...ctx, tenantId: undefined }, async (tx) => {
        const [row] = await tx`
          select * from core.portal_accept(
            ${token}, ${(b.full_name as string) ?? null}, ${ctx.userId})`;
        return { data: row };
      });
    } catch (err) { throw translatePgError(err); }
  });
}
