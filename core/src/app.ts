import Fastify, { type FastifyInstance } from 'fastify';
import { withContext, sql, assertSafeDbRole } from './db.js';
import { contextFromRequest } from './auth.js';
import { AppError, translatePgError } from './errors.js';
import type { SezraModule } from './module.js';

export interface CreateAppOptions {
  modules: SezraModule[];
  logger?: boolean;
}

export async function createApp(opts: CreateAppOptions): Promise<FastifyInstance> {
  // İZOLASYON SINIRINI ÖNCE DOĞRULA: etkin DB rolü BYPASSRLS/superuser ise
  // RLS bir güvenlik sınırı değildir ve sunucu bu hâlde açılmamalıdır.
  await assertSafeDbRole();

  const app = Fastify({
    logger: opts.logger ?? process.env.NODE_ENV !== 'test',
    genReqId: () => crypto.randomUUID(),
  });

  // İçeriksiz POST'lar (durum geçişi uçları) 400 değil, boş gövdeyle geçmeli
  app.addContentTypeParser(
    'application/json', { parseAs: 'string' },
    (_req, body, done) => {
      const raw = (body as string).trim();
      if (raw === '') { done(null, {}); return; }
      try { done(null, JSON.parse(raw)); } catch (err) { done(err as Error, undefined); }
    },
  );

  app.setErrorHandler((err, req, reply) => {
    // Fastify'ın kendi doğrulama/yönlendirme hataları anlamlı bir durum kodu
    // taşır; onu 500'e yuvarlamak hata mesajını kaybettirir.
    const framework = (err as { statusCode?: number }).statusCode;
    const appErr = err instanceof AppError
      ? err
      : (framework && framework < 500
          ? new AppError(framework, (err as { code?: string }).code ?? 'bad_request', (err as Error).message)
          : translatePgError(err));
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
      // PROFİL SATIRI OLMAYABİLİR: kimlik sağlayıcısında hesabını açmış ama
      // henüz hiçbir kiracıya bağlanmamış kişi (portal daveti bekleyen
      // müşteri) bu durumdadır. Satır bulunamadığında alanı hiç yazmamak,
      // `user` anahtarını yanıttan sessizce düşürüyordu: istemci tipe göre
      // `user.email` okuyup çöküyordu. Eksikliği AÇIKÇA söylemek gerekir.
      const [user] = await tx`
        select id, email, full_name, phone, avatar_url, locale, timezone, is_platform_admin
        from core.users where id = ${ctx.userId}`;

      // Destek oturumunda platform yöneticisinin ÜYELİĞİ yoktur, dolayısıyla
      // current_tenant_id() null döner. Bu durumda erişilen kiracıyı
      // support_tenant_id() söyler. Aksi hâlde arayüz kiracı verisini gösterir
      // ama kimin verisi olduğunu yazamaz; destek modunun en tehlikeli hâli budur.
      const [tenant] = await tx`
        select t.id, t.name, t.slug, t.currency, t.locale, t.timezone
        from core.tenants t
        where t.id = coalesce(core.current_tenant_id(), core.support_tenant_id())`;

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
        where tm.tenant_id = coalesce(core.current_tenant_id(), core.support_tenant_id())
          and tm.enabled
        order by m.phase, m.name`;

      const roles = await tx`
        select r.code, r.name from core.membership_roles mr
        join core.roles r on r.id = mr.role_id
        where mr.membership_id = core.current_membership_id()`;

      const [support] = await tx`select core.support_tenant_id() is not null as active`;

      // PORTAL OTURUMU AYRI BİR ARAYÜZDÜR. Portal kullanıcısının hiçbir izni
      // ve hiçbir modülü yoktur; personel kabuğu ona boş bir menü ve her
      // yerde "yetkiniz yok" gösterirdi. Kimin adına girildiğini de sunucu
      // söyler: firma adını istemcinin çıkarmasına bırakmak, yanlış firmanın
      // başlıkta yazması riskini taşır.
      const [portal] = await tx`
        select p.id as partner_id, p.name as partner_name, p.code as partner_code
        from core.partners p
        where p.id = core.current_portal_partner_id()`;

      // PORTAL OTURUMUNA İŞLETME YAPISI GİTMEZ. Şube adları ve açık modül
      // listesi müşterinin işine yaramaz ama satıcının iç yapısını anlatır:
      // kaç şubesi var, hangi modülleri kullanıyor. Portal kabuğu ikisini de
      // kullanmıyor; göndermemek hem doğru hem bedava.
      const portalOturumu = portal != null;

      return {
        user: user ?? null,
        tenant: tenant ?? null,
        support_session: (support as { active: boolean } | undefined)?.active ?? false,
        memberships,
        branches: portalOturumu ? [] : branches,
        roles,
        modules: portalOturumu ? [] : modules,
        permissions: (perms?.codes as string[] | null) ?? [],
        supportMode: ctx.supportMode === true,
        portal: portal ?? null,
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
