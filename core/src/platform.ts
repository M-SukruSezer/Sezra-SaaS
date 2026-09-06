import type { FastifyInstance, FastifyRequest } from 'fastify';
import { withContext, withSystemContext, type Tx } from './db.js';
import { contextFromRequest } from './auth.js';
import { badRequest, translatePgError } from './errors.js';

/**
 * Platform yönetim konsolu uçları.
 *
 * Bunlar KİRACI uçları değildir: hiçbiri `core.modules`'a kayıtlı bir modüle
 * ait değil ve hiçbiri müşterinin iş verisini döndürmez. Yetki kontrolü
 * uygulama katmanında DEĞİL, veritabanındaki `core.platform_guard()` içinde
 * yapılır — buradaki bir unutma güvenlik açığı üretmesin diye.
 *
 * Kiracı verisine bakmak isteyen platform yöneticisi bunları değil, destek
 * modunu kullanır (`x-support-mode: on`) ve o erişim denetim izine düşer.
 */
async function run<T>(req: FastifyRequest, fn: (tx: Tx) => Promise<T>): Promise<T> {
  const ctx = contextFromRequest(req);
  try {
    return await withContext(ctx, fn);
  } catch (err) {
    throw translatePgError(err);
  }
}

export function registerPlatformRoutes(app: FastifyInstance): void {
  app.get('/platform/overview', async (req) =>
    run(req, async (tx) => {
      const [row] = await tx`select * from core.platform_overview()`;
      return { data: row };
    }));

  app.get('/platform/tenants', async (req) => {
    const q = req.query as { q?: string; status?: string; limit?: string; offset?: string };
    const limit = Math.min(Number(q.limit ?? 50) || 50, 200);
    const offset = Math.max(Number(q.offset ?? 0) || 0, 0);
    return run(req, async (tx) => {
      const rows = await tx`
        select * from core.platform_tenants(
          ${q.q ?? null}, ${q.status ?? null}, ${limit}, ${offset})`;
      const total = rows.length > 0 ? Number((rows[0] as { total_count: string }).total_count) : 0;
      return {
        data: rows.map((r) => {
          const { total_count, ...rest } = r as Record<string, unknown>;
          return rest;
        }),
        meta: { total, limit, offset },
      };
    });
  });

  app.get('/platform/tenants/:id/modules', async (req) => {
    const { id } = req.params as { id: string };
    return run(req, async (tx) => ({
      data: await tx`select * from core.platform_tenant_modules(${id})`,
    }));
  });

  app.get('/platform/module-adoption', async (req) =>
    run(req, async (tx) => ({
      data: await tx`select * from core.platform_module_adoption()`,
    })));

  app.get('/platform/health', async (req) =>
    run(req, async (tx) => ({
      data: await tx`select * from core.platform_health()`,
    })));

  /** Plan listesi: kiracı planını değiştirirken seçenekleri doldurur. */
  app.get('/platform/plans', async (req) =>
    run(req, async (tx) => ({
      data: await tx`
        select code, name, monthly_price, currency, included_users, included_branches
        from core.plans order by sort_order, code`,
    })));

  app.post('/platform/tenants/:id/modules', async (req) => {
    const { id } = req.params as { id: string };
    const b = (req.body ?? {}) as { module_code?: string; enabled?: boolean };
    if (!b.module_code) throw badRequest('module_code zorunlu');
    return run(req, async (tx) => {
      const [row] = await tx`
        select core.platform_set_module(${id}, ${b.module_code!}, ${b.enabled ?? true}) as enabled`;
      return { data: row };
    });
  });

  app.post('/platform/tenants/:id/plan', async (req) => {
    const { id } = req.params as { id: string };
    const b = (req.body ?? {}) as { plan_code?: string };
    if (!b.plan_code) throw badRequest('plan_code zorunlu');
    return run(req, async (tx) => {
      const [row] = await tx`select * from core.platform_set_plan(${id}, ${b.plan_code!})`;
      return { data: row };
    });
  });

  // ---------------------------------------------------------------------------
  // Marka (ürün logosu)
  // ---------------------------------------------------------------------------

  /**
   * Logo okuma — KİMLİK İSTEMEZ.
   *
   * Giriş ekranı bu ucu kimlik doğrulamadan önce çağırır; kimlik zorunlu
   * olsaydı marka yalnızca oturum açtıktan sonra görünürdü. Uç yalnızca
   * logoyu döndürür: müşteri verisi de, onu kimin değiştirdiği de burada yok.
   */
  app.get('/branding', async () =>
    withSystemContext(async (tx) => {
      const [row] = await tx<{
        logo_data_uri: string | null; logo_mime: string | null;
        logo_dark_data_uri: string | null; logo_dark_mime: string | null;
        logo_updated_at: string | null;
        contact_note: string | null;
        contact_phone1: string | null; contact_phone1_label: string | null;
        contact_phone2: string | null; contact_phone2_label: string | null;
        contact_whatsapp: string | null;
      }[]>`select * from core.platform_branding()`;
      return {
        data: {
          logo: row?.logo_data_uri ?? null,
          mime: row?.logo_mime ?? null,
          logo_dark: row?.logo_dark_data_uri ?? null,
          mime_dark: row?.logo_dark_mime ?? null,
          updated_at: row?.logo_updated_at ?? null,
          contact: {
            note: row?.contact_note ?? null,
            phone1: row?.contact_phone1 ?? null,
            phone1_label: row?.contact_phone1_label ?? null,
            phone2: row?.contact_phone2 ?? null,
            phone2_label: row?.contact_phone2_label ?? null,
            whatsapp: row?.contact_whatsapp ?? null,
          },
        },
      };
    }));

  /**
   * Logo yükleme.
   *
   * Gövde bir data URI taşır. Yetki kontrolü BURADA DEĞİL, veritabanındaki
   * `core.platform_set_logo` içinde `platform_guard()` ile yapılır. Buradaki
   * doğrulamalar yalnızca erken ve anlaşılır hata vermek içindir; sınırı
   * uygulayan taraf veritabanıdır.
   */
  app.post('/platform/branding/logo', async (req) => {
    const b = (req.body ?? {}) as { data_uri?: string; variant?: string };
    const dataUri = b.data_uri?.trim();
    if (!dataUri) throw badRequest('data_uri zorunlu');

    // Varyant belirtilmezse açık zemin varsayılır: tek dosya yükleyen bir
    // yönetici varyant kavramıyla hiç uğraşmak zorunda kalmasın.
    const variant = b.variant ?? 'light';
    if (variant !== 'light' && variant !== 'dark') {
      throw badRequest("variant yalnızca 'light' ya da 'dark' olabilir");
    }

    const match = /^data:(image\/(?:png|jpeg|webp|svg\+xml));base64,([A-Za-z0-9+/=]+)$/.exec(dataUri);
    if (!match) {
      throw badRequest('Yalnızca base64 kodlanmış PNG, JPEG, WebP ya da SVG kabul edilir');
    }
    const [, mime, payload] = match as unknown as [string, string, string];

    let bytes: Buffer;
    try {
      bytes = Buffer.from(payload, 'base64');
    } catch {
      throw badRequest('Görsel içeriği çözülemedi');
    }
    if (bytes.length === 0) throw badRequest('Görsel içeriği boş');
    if (bytes.length > 512 * 1024) throw badRequest('Logo boyutu 512 KB\'ı aşamaz');

    // SVG bir belgedir, bir bitmap değil: içine script ve dış kaynak
    // gömülebilir. Logo yalnızca <img> ile çizildiği için tarayıcı bunları
    // zaten çalıştırmaz, ama dosya bir gün başka bir bağlamda satır içi
    // gömülürse kalıcı bir XSS'e dönüşür. Reddetmek, o günü beklemekten ucuz.
    if (mime === 'image/svg+xml') {
      const svg = bytes.toString('utf8').toLowerCase();
      const yasakli = ['<script', 'javascript:', 'onload=', 'onerror=', '<foreignobject', '<iframe'];
      const bulunan = yasakli.find((k) => svg.includes(k));
      if (bulunan) {
        throw badRequest(`SVG çalıştırılabilir içerik taşıyor (${bulunan}); temizlenmiş bir dosya yükleyin`);
      }
    }

    return run(req, async (tx) => {
      await tx`select core.platform_set_logo(${dataUri}, ${mime}, ${bytes.length}, ${variant})`;
      return { data: { mime, bytes: bytes.length, variant } };
    });
  });

  /**
   * İletişim bilgileri.
   *
   * Yetki kontrolü burada DEĞİL, `core.platform_set_contact` içindeki
   * `platform_guard()` ile yapılır. Buradaki doğrulama yalnızca erken ve
   * anlaşılır hata vermek içindir.
   */
  app.post('/platform/branding/contact', async (req) => {
    const b = (req.body ?? {}) as {
      note?: string; phone1?: string; phone1_label?: string;
      phone2?: string; phone2_label?: string; whatsapp?: string;
    };

    // Telefon biçimi ÜLKEYE GÖRE değişir ve katı bir kalıp dayatmak,
    // uluslararası ya da dahili numaraları reddederdi. Burada yalnızca
    // "makul uzunlukta ve telefonda bulunan karakterlerden oluşuyor mu"
    // diye bakılır; asıl doğrulama numarayı arayan kullanıcıdır.
    const telefonGecerli = (v: string) =>
      v.length <= 32 && /^[0-9+()\-\s.]+$/.test(v);

    for (const [ad, deger] of [
      ['phone1', b.phone1], ['phone2', b.phone2], ['whatsapp', b.whatsapp],
    ] as const) {
      const v = deger?.trim();
      if (v && !telefonGecerli(v)) {
        throw badRequest(`${ad} yalnızca rakam, boşluk ve + ( ) - . karakterlerini taşıyabilir`);
      }
    }
    if ((b.note ?? '').length > 240) throw badRequest('Açıklama 240 karakteri aşamaz');

    return run(req, async (tx) => {
      await tx`select core.platform_set_contact(
        ${b.note ?? null}, ${b.phone1 ?? null}, ${b.phone1_label ?? null},
        ${b.phone2 ?? null}, ${b.phone2_label ?? null}, ${b.whatsapp ?? null})`;
      return { data: { ok: true } };
    });
  });

  app.delete('/platform/branding/logo', async (req) => {
    const q = req.query as { variant?: string };
    const variant = q.variant ?? 'light';
    if (variant !== 'light' && variant !== 'dark') {
      throw badRequest("variant yalnızca 'light' ya da 'dark' olabilir");
    }
    return run(req, async (tx) => {
      await tx`select core.platform_clear_logo(${variant})`;
      return { data: { logo: null, variant } };
    });
  });

  app.post('/platform/tenants/:id/status', async (req) => {
    const { id } = req.params as { id: string };
    const b = (req.body ?? {}) as { status?: string };
    const allowed = ['trial', 'active', 'past_due', 'suspended', 'cancelled'];
    if (!b.status || !allowed.includes(b.status)) {
      throw badRequest(`status şunlardan biri olmalı: ${allowed.join(', ')}`);
    }
    return run(req, async (tx) => {
      const [row] = await tx`select * from core.platform_set_status(${id}, ${b.status!})`;
      return { data: row };
    });
  });
}
