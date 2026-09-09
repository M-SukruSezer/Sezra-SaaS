import type { FastifyInstance } from 'fastify';
import { contextFromRequest } from './auth.js';
import { withContext } from './db.js';
import { badRequest, translatePgError } from './errors.js';
import { encryptSecret, isSecretStoreConfigured } from './mail/crypto.js';
import { MAIL_PROVIDERS, type MailAccountConfig, type MailProvider, type MailSecret } from './mail/types.js';

/* ===========================================================================
   Bağlı mail hesabı uçları -- T-025
   ===========================================================================
   KAPSAM: yalnızca BAĞLANTI KURULUMU (ekle / listele / test et / sil). Posta
   çekme, senkron, gelen kutusu, gönderme bu karta dahil değil.

   GÜVENLİK:
   - Yetki sınırı veritabanında: core.mail_account_* fonksiyonları
     owner_id = current_user_id() ile kendini sınırlar, RLS ikinci katman.
     Bir kullanıcı yalnızca KENDİ hesaplarını görür/yönetir.
   - Gizli kimlik bilgisi (parola / token) HİÇBİR yanıtta dönmez. Yazarken
     uygulama katmanında şifrelenir (mail/crypto.ts), okurken
     core.mail_account_list yalnızca has_secret döndürür.
   ========================================================================= */

const PORTS: Record<string, Record<string, number>> = {
  imap: { ssl: 993, starttls: 143, none: 143 },
  pop3: { ssl: 995, starttls: 110, none: 110 },
};

/** OAuth sağlayıcıları ortam değişkeninden yapılandırılır; yoksa "yapılandırılmamış". */
function providerConfigured(p: MailProvider): boolean {
  if (p === 'imap' || p === 'pop3') return true;
  if (p === 'ms_graph') return Boolean(process.env.MS_GRAPH_CLIENT_ID && process.env.MS_GRAPH_CLIENT_SECRET);
  if (p === 'gmail') return Boolean(process.env.GMAIL_CLIENT_ID && process.env.GMAIL_CLIENT_SECRET);
  return false;
}

function normalizeConfig(provider: MailProvider, raw: unknown): MailAccountConfig {
  const c = (raw ?? {}) as Record<string, unknown>;
  const out: MailAccountConfig = {};
  if (provider === 'imap' || provider === 'pop3') {
    const host = typeof c.host === 'string' ? c.host.trim() : '';
    if (!host) throw badRequest('host zorunlu (IMAP/POP3)');
    out.host = host;
    const security = c.security === 'starttls' || c.security === 'none' ? c.security : 'ssl';
    out.security = security;
    const port = Number(c.port);
    out.port = Number.isFinite(port) && port > 0 && port < 65536
      ? port
      : (PORTS[provider]?.[security] ?? 993);
    if (typeof c.username === 'string' && c.username.trim()) out.username = c.username.trim();
  } else {
    if (Array.isArray(c.scopes)) out.scopes = c.scopes.filter((s): s is string => typeof s === 'string');
    if (typeof c.username === 'string' && c.username.trim()) out.username = c.username.trim();
  }
  return out;
}

/** İstek gövdesinden gizli demeti çıkarır (varsa). Boş -> undefined. */
function extractSecret(body: Record<string, unknown>): MailSecret | undefined {
  const s = (body.secret ?? {}) as Record<string, unknown>;
  const password = typeof s.password === 'string' && s.password !== '' ? s.password : undefined;
  const access_token = typeof s.access_token === 'string' && s.access_token !== '' ? s.access_token : undefined;
  const refresh_token = typeof s.refresh_token === 'string' && s.refresh_token !== '' ? s.refresh_token : undefined;
  if (!password && !access_token && !refresh_token) return undefined;
  return { ...(password && { password }), ...(access_token && { access_token }), ...(refresh_token && { refresh_token }) };
}

export function registerMailRoutes(app: FastifyInstance): void {
  /** Sağlayıcı listesi + yapılandırma durumu (panel ekranının seçenekleri). */
  app.get('/core/mail/providers', async () => ({
    data: MAIL_PROVIDERS.map((code) => ({ code, configured: providerConfigured(code) })),
    meta: { secret_store: isSecretStoreConfigured() },
  }));

  /** Kullanıcının KENDİ bağlı mail hesapları. Gizli alan dönmez. */
  app.get('/core/mail/accounts', async (req) => {
    const ctx = contextFromRequest(req);
    try {
      return await withContext(ctx, async (tx) => {
        const rows = await tx`select * from core.mail_account_list()`;
        // postgres.js, RETURNS TABLE'daki jsonb kolonu bazen ham metin olarak
        // dondurur; istemciye daima nesne verelim.
        return {
          data: rows.map((r) => ({
            ...r,
            config: typeof r.config === 'string'
              ? JSON.parse(r.config || '{}') as MailAccountConfig
              : (r.config ?? {}),
          })),
        };
      });
    } catch (err) { throw translatePgError(err); }
  });

  /**
   * Hesap ekler ya da günceller.
   *
   * `secret` verilmemişse mevcut kimlik bilgisi KORUNUR (kullanıcı parolayı
   * geri okuyamadığı için düzenlemede boş bırakır). `secret.clear === true`
   * ise silinir.
   */
  app.post('/core/mail/accounts', async (req, reply) => {
    const b = (req.body ?? {}) as Record<string, unknown>;
    const provider = b.provider as MailProvider;
    if (!MAIL_PROVIDERS.includes(provider)) {
      throw badRequest(`provider şunlardan biri olmalı: ${MAIL_PROVIDERS.join(', ')}`);
    }
    const displayName = typeof b.display_name === 'string' ? b.display_name.trim() : '';
    if (!displayName) throw badRequest('display_name zorunlu');
    const email = typeof b.email === 'string' ? b.email.trim() : '';
    if (!/^[^@\s]+@[^@\s]+$/.test(email)) throw badRequest('Geçerli bir e-posta adresi gerekli');

    const id = typeof b.id === 'string' && b.id ? b.id : null;
    const config = normalizeConfig(provider, b.config);

    // Gizli demet: verildiyse ŞİFRELE. clear -> '' (SQL bunu "sil" sayar).
    const secretObj = extractSecret(b);
    const secretIsCleared = (b.secret as Record<string, unknown> | undefined)?.clear === true;
    let cipher: string | null = null;
    if (secretObj) cipher = encryptSecret(secretObj);
    else if (secretIsCleared) cipher = '';
    // else: cipher = null -> SQL mevcut değeri korur

    // IMAP/POP3 yeni hesap kimlik bilgisi olmadan doğrulanamaz; erken uyar.
    if (id === null && (provider === 'imap' || provider === 'pop3') && !secretObj) {
      throw badRequest('IMAP/POP3 için parola gerekli (secret.password)');
    }

    try {
      const row = await withContext(contextFromRequest(req), async (tx) => {
        const [r] = await tx`
          select core.mail_account_save(
            ${id}, ${provider}, ${displayName}, ${email},
            ${JSON.stringify(config)}::jsonb, ${cipher}) as id`;
        return r as { id: string };
      });
      if (id === null) reply.code(201);
      return { data: { id: row.id } };
    } catch (err) { throw translatePgError(err); }
  });

  /** Hesabı siler. Yalnızca kendi hesabı. */
  app.delete('/core/mail/accounts/:id', async (req, reply) => {
    const { id } = req.params as { id: string };
    try {
      await withContext(contextFromRequest(req), async (tx) => {
        await tx`select core.mail_account_delete(${id})`;
      });
      reply.code(204);
      return null;
    } catch (err) { throw translatePgError(err); }
  });
}
