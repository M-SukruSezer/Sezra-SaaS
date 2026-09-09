import type { FastifyInstance, FastifyRequest } from 'fastify';
import { withContext, type Tx } from './db.js';
import { contextFromRequest } from './auth.js';
import { badRequest, translatePgError } from './errors.js';

/**
 * Mali müşavir erişimi uçları.
 *
 * İki taraf var:
 *   - KİRACI tarafı (`/core/accountant*`): kiracı yöneticisi müşavirini davet
 *     eder / iptal eder / mevcut müşaviri görür.
 *   - MÜŞAVİR tarafı (`/accountant/*`): müşavir kendi panelinden bekleyen
 *     davetlerini görür, kabul/ret eder ve yetkili olduğu kiracıları listeler.
 *
 * Yetki kontrolü uygulama katmanında DEĞİL, çağrılan SQL fonksiyonlarının
 * içindedir (`core.has_perm` / `core.current_user_id` ile sabitlenir). Buradaki
 * doğrulamalar yalnızca erken ve anlaşılır hata vermek içindir.
 *
 * Müşavirin bir kiracının verisini OKUMASI bu uçlardan geçmez: panel, normal
 * API isteğini `x-tenant-id: <kiracı>` + `x-accountant-mode: on` başlıklarıyla
 * yapar; sınırı `core.accountant_tenant_id()` (yalnızca for-select politikası)
 * çizer.
 */
async function run<T>(req: FastifyRequest, fn: (tx: Tx) => Promise<T>): Promise<T> {
  const ctx = contextFromRequest(req);
  try {
    return await withContext(ctx, fn);
  } catch (err) {
    throw translatePgError(err);
  }
}

export function registerAccountantRoutes(app: FastifyInstance): void {
  // -------------------------------------------------------------------------
  // Kiracı tarafı
  // -------------------------------------------------------------------------

  /** Aktif kiracının canlı müşavir kaydı (bekleyen ya da aktif). */
  app.get('/core/accountant', async (req) =>
    run(req, async (tx) => ({
      data: (await tx`select * from core.current_tenant_accountant()`)[0] ?? null,
    })));

  /** Müşaviri e-postayla davet eder. Kiracıda zaten canlı müşavir varsa 409. */
  app.post('/core/accountant/invite', async (req, reply) => {
    const b = (req.body ?? {}) as { email?: string; full_name?: string };
    const email = b.email?.trim();
    if (!email) throw badRequest('email zorunlu');
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) throw badRequest('Geçerli bir e-posta girin');

    const row = await run(req, async (tx) => {
      const [r] = await tx`
        select id, email, invited_at, invite_token
        from core.invite_accountant(${email}, ${b.full_name?.trim() ?? null})`;
      return r;
    });
    reply.code(201);
    return { data: row };
  });

  /** Müşavir erişimini iptal eder (kayıt silinmez, revoked_at damgalanır). */
  app.delete('/core/accountant/:grantId', async (req) => {
    const { grantId } = req.params as { grantId: string };
    return run(req, async (tx) => {
      await tx`select core.revoke_accountant(${grantId})`;
      return { data: { id: grantId, revoked: true } };
    });
  });

  // -------------------------------------------------------------------------
  // Müşavir tarafı (panel)
  // -------------------------------------------------------------------------

  /** Panelin ana listesi: müşavirin salt-okunur erişimi olan kiracılar. */
  app.get('/accountant/tenants', async (req) =>
    run(req, async (tx) => ({
      data: await tx`select * from core.accountant_tenants()`,
    })));

  /** Müşavirin henüz kabul etmediği davetler. */
  app.get('/accountant/invites', async (req) =>
    run(req, async (tx) => ({
      data: await tx`select * from core.pending_accountant_invites()`,
    })));

  /** Bir daveti kabul eder: erişim bundan sonra açık. */
  app.post('/accountant/invites/accept', async (req) => {
    const b = (req.body ?? {}) as { token?: string };
    const token = b.token?.trim();
    if (!token) throw badRequest('token zorunlu');
    return run(req, async (tx) => {
      const [r] = await tx`
        select tenant_id, accepted_at from core.accept_accountant_invite(${token})`;
      return { data: r };
    });
  });

  /** Bir daveti reddeder. */
  app.post('/accountant/invites/decline', async (req) => {
    const b = (req.body ?? {}) as { token?: string };
    const token = b.token?.trim();
    if (!token) throw badRequest('token zorunlu');
    return run(req, async (tx) => {
      await tx`select core.decline_accountant_invite(${token})`;
      return { data: { declined: true } };
    });
  });
}
