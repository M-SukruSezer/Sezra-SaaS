import type { FastifyInstance } from 'fastify';
import { contextFromRequest } from './auth.js';
import { withContext } from './db.js';
import { badRequest, notFound, translatePgError } from './errors.js';
import { decryptSecret, encryptSecret, isSecretStoreConfigured } from './mail/crypto.js';
import { verifyMailConnection } from './mail/verify.js';
import { isBlockedLiteralIp } from './mail/ssrfGuard.js';
import { fetchMail } from './mail/fetch.js';
import { sendMail, isEmail } from './mail/send.js';
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
    // SSRF sinir katmani: apacik ozel/loopback/link-local literal IP'yi reddet.
    // Ad tabanli (DNS) hedefler baglanti aninda ssrfGuard ile dogrulanir.
    if (isBlockedLiteralIp(host)) throw badRequest('Bu sunucu adresine izin verilmiyor (ic ag / ozel adres)');
    out.host = host;
    const security = c.security === 'starttls' || c.security === 'none' ? c.security : 'ssl';
    out.security = security;
    const port = Number(c.port);
    out.port = Number.isFinite(port) && port > 0 && port < 65536
      ? port
      : (PORTS[provider]?.[security] ?? 993);
    if (typeof c.username === 'string' && c.username.trim()) out.username = c.username.trim();
    // SMTP gönderim ayarları (gizli değil). Verilmezse send.ts host'tan türetir.
    if (typeof c.smtp_host === 'string' && c.smtp_host.trim()) out.smtp_host = c.smtp_host.trim();
    const smtpPort = Number(c.smtp_port);
    if (Number.isFinite(smtpPort) && smtpPort > 0 && smtpPort < 65536) out.smtp_port = smtpPort;
    if (c.smtp_security === 'ssl' || c.smtp_security === 'starttls' || c.smtp_security === 'none') {
      out.smtp_security = c.smtp_security;
    }
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

  /**
   * "Bağlantıyı test et" -- IMAP/POP3.
   *
   * Hesabı RLS altında okur (yalnızca sahip), gizli demeti uygulama katmanında
   * çözer, gerçek bir bağlantı dener ve sonucu core.mail_account_set_status ile
   * yazar. Yanıt HER ZAMAN 200: test KOŞTU. Sonuç gövdede -- status ve
   * kullanıcıya anlamlı detail (auth / network / tls). Gizli asla dönmez.
   * Graph/Gmail doğrulaması 4. adımda (OAuth).
   */
  app.post('/core/mail/accounts/:id/verify', async (req) => {
    const { id } = req.params as { id: string };
    try {
      const acc = await withContext(contextFromRequest(req), async (tx) => {
        const [row] = await tx`
          select provider, email_address, config, secret_cipher
          from core.mail_accounts where id = ${id} and owner_id = core.current_user_id()`;
        return row as {
          provider: MailProvider; email_address: string;
          config: unknown; secret_cipher: string | null;
        } | undefined;
      });
      if (!acc) throw notFound('Mail hesabı bulunamadı');
      if (acc.provider !== 'imap' && acc.provider !== 'pop3') {
        throw badRequest('Bu sağlayıcı için bağlantı testi OAuth ile yapılır');
      }
      if (!acc.secret_cipher) throw badRequest('Önce parolayı girin');

      const cfg = (typeof acc.config === 'string'
        ? JSON.parse(acc.config || '{}') : (acc.config ?? {})) as MailAccountConfig;
      const secret = decryptSecret(acc.secret_cipher);
      const user = cfg.username?.trim() || acc.email_address;

      const result = await verifyMailConnection(acc.provider, cfg, user, secret.password ?? '');

      await withContext(contextFromRequest(req), async (tx) => {
        await tx`select core.mail_account_set_status(${id}, ${result.status}, ${result.detail})`;
      });

      return { data: { status: result.status, category: result.category, detail: result.detail } };
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

  /* =========================================================================
     T-029 -- gelen kutusu akışı: çekme + senkron, okuma, gönderme

     GÜVENLİK: her uç RLS altında çalışır (owner_id = current_user_id()).
     Gizli parola YALNIZCA senkron/gönderim anında çözülür; hiçbir yanıta,
     loga ya da hata mesajına girmez. body_html HAM döner -- arayüz temizler.
     ========================================================================= */

  /**
   * Bağlı hesabın gelen postasını çeker ve tabloya yazar (artımlı).
   *
   * verify gibi HER ZAMAN 200: senkron KOŞTU. Sonuç gövdede -- kaç mesaj
   * alındı, kaç atlandı, hata varsa kategorisi + kullanıcıya anlamlı detay.
   * Ağ çağrısı DB bağlantısı tutulmadan yapılır (önce oku, sonra çek, sonra yaz).
   */
  app.post('/core/mail/accounts/:id/sync', async (req) => {
    const { id } = req.params as { id: string };
    const ctx = contextFromRequest(req);
    try {
      const prep = await withContext(ctx, async (tx) => {
        const [acc] = await tx`
          select provider, email_address, config, secret_cipher
          from core.mail_accounts where id = ${id} and owner_id = core.current_user_id()`;
        if (!acc) return null;
        const [state] = await tx`select * from core.mail_sync_state_get(${id})`;
        let known: string[] = [];
        if (acc.provider === 'pop3') {
          const rows = await tx`
            select uid from core.mail_messages
            where account_id = ${id} and direction = 'incoming'`;
          known = rows.map((r) => r.uid as string);
        }
        return { acc, state, known };
      });
      if (!prep) throw notFound('Mail hesabı bulunamadı');

      const { acc, state, known } = prep as {
        acc: { provider: MailProvider; email_address: string; config: unknown; secret_cipher: string | null };
        state: { last_uid: string | number; uid_validity: string | null } | undefined;
        known: string[];
      };
      if (acc.provider !== 'imap' && acc.provider !== 'pop3') {
        throw badRequest('Bu sağlayıcıdan çekme OAuth ile yapılır (bu sürümde yok)');
      }
      if (!acc.secret_cipher) throw badRequest('Önce parolayı girin');

      const cfg = readConfig(acc.config);
      const secret = decryptSecret(acc.secret_cipher);
      const user = cfg.username?.trim() || acc.email_address;

      const res = await fetchMail({
        provider: acc.provider,
        config: cfg,
        user,
        pass: secret.password ?? '',
        sinceUid: state ? Number(state.last_uid) : 0,
        uidValidity: state?.uid_validity ?? undefined,
        knownUids: new Set(known),
      });

      const outcome = await withContext(ctx, async (tx) => {
        if (!res.ok) {
          await tx`select core.mail_sync_state_set(
            ${id}, ${res.uidValidity ?? state?.uid_validity ?? null},
            ${Number(state?.last_uid ?? 0)}, ${res.detail ?? 'Senkron başarısız'})`;
          return { ok: false, fetched: 0, skipped: res.skipped, trimmed: 0,
            category: res.category, detail: res.detail };
        }
        if (res.uidValidityChanged) await tx`select core.mail_sync_reset(${id})`;

        let fetched = 0;
        for (const m of res.messages) {
          const [row] = await tx`
            select core.mail_message_ingest(
              ${id}, ${m.uid}, ${res.uidValidity ?? null}, ${m.folder},
              ${m.messageId ?? null}, ${m.inReplyTo ?? null}, ${m.subject ?? null},
              ${m.fromAddr ?? null}, ${m.fromName ?? null},
              ${m.toAddrs}, ${m.ccAddrs},
              ${m.date ?? null}, ${m.receivedAt ?? null}, ${m.snippet ?? null},
              ${m.bodyText ?? null}, ${m.bodyHtml ?? null},
              ${m.hasAttachments}, ${m.sizeBytes ?? null}) as id`;
          if (row?.id) fetched++;
        }
        await tx`select core.mail_sync_state_set(
          ${id}, ${res.uidValidity ?? null},
          ${Number(res.highestUid ?? state?.last_uid ?? 0)}, ${null})`;
        const [t] = await tx`select core.mail_messages_trim(${id}) as n`;
        return { ok: true, fetched, skipped: res.skipped, trimmed: Number(t?.n ?? 0) };
      });

      return { data: outcome };
    } catch (err) { throw translatePgError(err); }
  });

  /** Hesabın senkron durumu (son senkron zamanı, son hata, mesaj sayısı). */
  app.get('/core/mail/accounts/:id/sync-state', async (req) => {
    const { id } = req.params as { id: string };
    try {
      return await withContext(contextFromRequest(req), async (tx) => {
        const [row] = await tx`select * from core.mail_sync_state_get(${id})`;
        return { data: row ?? null };
      });
    } catch (err) { throw translatePgError(err); }
  });

  /** Bir hesaptaki mesaj listesi (üst veri + snippet). Gövde DÖNMEZ. */
  app.get('/core/mail/accounts/:id/messages', async (req) => {
    const { id } = req.params as { id: string };
    const qs = req.query as Record<string, string | undefined>;
    const direction = qs.direction === 'outgoing' ? 'outgoing' : 'incoming';
    const limit = Math.min(Math.max(Number(qs.limit) || 50, 1), 100);
    const offset = Math.max(Number(qs.offset) || 0, 0);
    try {
      return await withContext(contextFromRequest(req), async (tx) => {
        const rows = await tx`
          select * from core.mail_message_list(${id}, ${direction}, ${limit}, ${offset})`;
        const total = rows.length ? Number(rows[0]!.total_count) : 0;
        return {
          data: rows.map(({ total_count, ...r }) => r),
          meta: { total, limit, offset },
        };
      });
    } catch (err) { throw translatePgError(err); }
  });

  /**
   * Tek mesaj, gövde dahil. Yalnızca sahibi.
   *
   * body_html HAM döner (bilerek): sunucudan geldiği gibi. Arayüz onu ASLA
   * ham render etmez -- düz metne düşer ya da temizler. XSS sınırı render
   * katmanında; saklama ve taşıma güvenli.
   */
  app.get('/core/mail/messages/:id', async (req) => {
    const { id } = req.params as { id: string };
    try {
      return await withContext(contextFromRequest(req), async (tx) => {
        const [row] = await tx`select * from core.mail_message_get(${id})`;
        if (!row) throw notFound('Mesaj bulunamadı');
        return { data: row };
      });
    } catch (err) { throw translatePgError(err); }
  });

  /** Mesajı okundu/okunmadı işaretler (yerel; sunucuya geri yazılmaz). */
  app.post('/core/mail/messages/:id/seen', async (req) => {
    const { id } = req.params as { id: string };
    const b = (req.body ?? {}) as Record<string, unknown>;
    const seen = b.seen === undefined ? true : Boolean(b.seen);
    try {
      await withContext(contextFromRequest(req), async (tx) => {
        await tx`select core.mail_message_mark_seen(${id}, ${seen})`;
      });
      return { data: { id, seen } };
    } catch (err) { throw translatePgError(err); }
  });

  /**
   * Panelden mail gönderir (SMTP). Kimlik bilgisi secret_cipher'dan yalnızca
   * burada çözülür. Başarılı da başarısız da core.mail_messages'a giden kayıt
   * olarak yazılır -- denetimde "neden gitmedi" cevabı kalsın. Gizli hiçbir
   * yanıta girmez.
   */
  app.post('/core/mail/accounts/:id/send', async (req) => {
    const { id } = req.params as { id: string };
    const ctx = contextFromRequest(req);
    const b = (req.body ?? {}) as Record<string, unknown>;

    const toAddrs = toStringArray(b.to);
    const ccAddrs = toStringArray(b.cc);
    const subject = typeof b.subject === 'string' ? b.subject.trim() : '';
    const bodyText = typeof b.body_text === 'string' ? b.body_text : '';
    const inReplyTo = typeof b.in_reply_to === 'string' && b.in_reply_to ? b.in_reply_to : null;

    if (!toAddrs.length) throw badRequest('En az bir alıcı gerekli (to)');
    for (const a of [...toAddrs, ...ccAddrs]) {
      if (!isEmail(a)) throw badRequest(`Geçersiz e-posta adresi: ${a}`);
    }
    if (!subject) throw badRequest('Konu gerekli');
    if (!bodyText.trim()) throw badRequest('Mesaj gövdesi boş olamaz');

    try {
      const acc = await withContext(ctx, async (tx) => {
        const [row] = await tx`
          select provider, email_address, display_name, config, secret_cipher
          from core.mail_accounts where id = ${id} and owner_id = core.current_user_id()`;
        return row as {
          provider: MailProvider; email_address: string; display_name: string;
          config: unknown; secret_cipher: string | null;
        } | undefined;
      });
      if (!acc) throw notFound('Mail hesabı bulunamadı');
      if (acc.provider !== 'imap' && acc.provider !== 'pop3') {
        throw badRequest('Bu sağlayıcıdan gönderim OAuth ile yapılır (bu sürümde yok)');
      }
      if (!acc.secret_cipher) throw badRequest('Önce parolayı girin');

      const cfg = readConfig(acc.config);
      const secret = decryptSecret(acc.secret_cipher);
      const authUser = cfg.username?.trim() || acc.email_address;

      const result = await sendMail(cfg, authUser, secret.password ?? '', {
        fromAddr: acc.email_address,
        fromName: acc.display_name,
        to: toAddrs,
        cc: ccAddrs,
        subject,
        bodyText,
        inReplyTo: inReplyTo ?? undefined,
      });

      const [rec] = await withContext(ctx, async (tx) => tx`
        select core.mail_message_record_sent(
          ${id}, ${toAddrs}, ${ccAddrs}, ${subject}, ${bodyText}, ${inReplyTo},
          ${result.ok ? 'sent' : 'failed'}, ${result.ok ? null : (result.detail ?? 'Gönderilemedi')}) as id`);

      return {
        data: {
          id: rec?.id ?? null,
          status: result.ok ? 'sent' : 'failed',
          ...(result.ok ? {} : { category: result.category, detail: result.detail }),
        },
      };
    } catch (err) { throw translatePgError(err); }
  });
}

/** postgres.js jsonb kolonunu bazen ham metin döndürür; daima nesneye çevir. */
function readConfig(raw: unknown): MailAccountConfig {
  if (typeof raw === 'string') {
    try { return JSON.parse(raw || '{}') as MailAccountConfig; } catch { return {}; }
  }
  return (raw ?? {}) as MailAccountConfig;
}

/** İstek gövdesinden temizlenmiş string dizisi (adres listeleri için). */
function toStringArray(v: unknown): string[] {
  if (typeof v === 'string') return v.split(',').map((s) => s.trim()).filter(Boolean);
  if (Array.isArray(v)) return v.filter((s): s is string => typeof s === 'string').map((s) => s.trim()).filter(Boolean);
  return [];
}
