import Fastify, { type FastifyInstance } from 'fastify';
import { withContext, sql } from './db.js';
import { contextFromRequest } from './auth.js';
import { AppError, translatePgError } from './errors.js';
import type { SezraModule } from './module.js';

export interface CreateAppOptions {
  modules: SezraModule[];
  logger?: boolean;
}

export async function createApp(opts: CreateAppOptions): Promise<FastifyInstance> {
  const app = Fastify({
    logger: opts.logger ?? process.env.NODE_ENV !== 'test',
    genReqId: () => crypto.randomUUID(),
  });

  app.setErrorHandler((err, req, reply) => {
    const appErr = err instanceof AppError ? err : translatePgError(err);
    if (appErr.statusCode >= 500) req.log.error({ err }, 'işlenmemiş hata');
    reply.code(appErr.statusCode).send({
      error: { code: appErr.code, message: appErr.message, details: appErr.details },
      requestId: req.id,
    });
  });

  app.get('/health', async () => {
    const [row] = await sql`select 1 as ok`;
    return { status: 'ok', db: row?.ok === 1 };
  });

  /**
   * Oturum özeti — UI'ın menüyü, şube seçicisini ve buton görünürlüklerini
   * kurabilmesi için tek çağrı. İzinler veritabanından okunur; UI onları
   * yalnızca GÖRÜNÜRLÜK için kullanır, güvenlik sınırı yine RLS'tir.
   */
  app.get('/me', async (req) => {
    const ctx = contextFromRequest(req);
    return withContext(ctx, async (tx) => {
      const [user] = await tx`
        select id, email, full_name, locale, timezone, is_platform_admin
        from core.users where id = ${ctx.userId}`;

      const [tenant] = await tx`
        select t.id, t.name, t.slug, t.currency, t.locale, t.timezone
        from core.tenants t where t.id = core.current_tenant_id()`;

      const memberships = await tx`
        select t.id as tenant_id, t.name, t.slug, m.is_default
        from core.memberships m
        join core.tenants t on t.id = m.tenant_id
        where m.user_id = ${ctx.userId} and m.is_active
        order by m.is_default desc, t.name`;

      const branches = await tx`
        select id, code, name, is_headquarter from core.branches order by is_headquarter desc, name`;

      const [perms] = await tx`select core.permission_codes() as codes`;
      const modules = await tx`
        select m.code, m.name from core.modules m
        join core.tenant_modules tm on tm.module_code = m.code
        where tm.tenant_id = core.current_tenant_id() and tm.enabled
        order by m.phase, m.name`;

      const roles = await tx`
        select r.code, r.name from core.membership_roles mr
        join core.roles r on r.id = mr.role_id
        where mr.membership_id = core.current_membership_id()`;

      return {
        user,
        tenant: tenant ?? null,
        memberships,
        branches,
        roles,
        modules,
        permissions: (perms?.codes as string[] | null) ?? [],
        supportMode: ctx.supportMode === true,
      };
    });
  });

  // Modülleri yükle — veritabanında kayıtlı olmayan modül reddedilir
  const registered = await sql<{ code: string }[]>`select code from core.modules`;
  const known = new Set(registered.map((r) => r.code));
  for (const mod of opts.modules) {
    if (!known.has(mod.code)) {
      throw new Error(
        `"${mod.code}" modülü core.modules'ta kayıtlı değil — migration'ı çalıştırılmamış olabilir`,
      );
    }
    await mod.register(app);
    app.log.info({ module: mod.code }, 'modül yüklendi');
  }

  return app;
}
