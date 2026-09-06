import type { FastifyInstance } from 'fastify';
import { contextFromRequest } from './auth.js';
import { withContext } from './db.js';
import { badRequest, translatePgError } from './errors.js';
import { getSmsProvider, listSmsProviders } from './sms/registry.js';
import type { SmsAyar } from './sms/types.js';

/* ===========================================================================
   SMS uçları
   ===========================================================================
   GÖNDERİM İKİ ADIM: önce veritabanına kayıt (`sms_enqueue`, izin ve numara
   kontrolüyle), sonra sağlayıcıya HTTP. Veritabanının dışarıya istek atmasını
   istemiyoruz -- atarsa işlem süresi ağın insafına kalır ve kilitler uzar.

   PAROLA HİÇBİR YANITTA DÖNMEZ. Ayar ucu kimlik alanlarını yalnızca YAZAR;
   okuma tarafında "tanımlı mı" bilgisi döner, değerin kendisi değil. Bir kez
   sızan operatör parolası, o kiracının adına mesaj atılabilmesi demektir.
   ========================================================================= */

/** Kimlik alanının dolu olup olmadığını söyler; değerini değil. */
const doluMu = (v: unknown) => typeof v === 'string' && v.trim() !== '';

export function registerSmsRoutes(app: FastifyInstance): void {
  /** Sağlayıcı listesi: ayar ekranının seçenekleri. */
  app.get('/core/sms/providers', async () => ({ data: listSmsProviders() }));

  /** Kiracının SMS ayarı. Parola ve api anahtarı DÖNMEZ. */
  app.get('/core/sms/settings', async (req) => {
    const ctx = contextFromRequest(req);
    try {
      return await withContext(ctx, async (tx) => {
        const [row] = await tx`
          select provider, sender, username, is_active,
                 password is not null and password <> '' as password_set,
                 api_key is not null and api_key <> ''  as api_key_set,
                 updated_at
          from core.sms_settings
          where tenant_id = core.current_tenant_id()`;
        return {
          data: row ?? {
            provider: 'log', sender: null, username: null, is_active: false,
            password_set: false, api_key_set: false,
          },
        };
      });
    } catch (err) { throw translatePgError(err); }
  });

  /**
   * Ayarı yazar.
   *
   * BOŞ PAROLA MEVCUDU SİLMEZ: ayar ekranı parolayı geri okuyamadığı için
   * kaydet düğmesine her basışta alanı boş gönderir. Boşu "sil" saymak,
   * kullanıcının gönderen adını değiştirdiğinde parolasını kaybetmesi
   * demekti. Silmek için açıkça `clear_password` gönderilir.
   */
  app.post('/core/sms/settings', async (req) => {
    const b = (req.body ?? {}) as Record<string, unknown>;
    const provider = typeof b.provider === 'string' ? b.provider : 'log';
    // Bilinmeyen sağlayıcı burada reddedilir: yazım hatası yüzünden
    // mesajların hiç gitmediğini aylar sonra fark etmek istemiyoruz.
    getSmsProvider(provider);

    const ctx = contextFromRequest(req);
    try {
      return await withContext(ctx, async (tx) => {
        await tx`
          insert into core.sms_settings (
            tenant_id, provider, sender, username, password, api_key, is_active)
          values (
            core.current_tenant_id(), ${provider},
            ${(b.sender as string) ?? null}, ${(b.username as string) ?? null},
            ${doluMu(b.password) ? (b.password as string) : null},
            ${doluMu(b.api_key) ? (b.api_key as string) : null},
            ${b.is_active === true})
          on conflict (tenant_id) do update set
            provider  = excluded.provider,
            sender    = excluded.sender,
            username  = excluded.username,
            password  = case when ${b.clear_password === true} then null
                             else coalesce(excluded.password, core.sms_settings.password) end,
            api_key   = case when ${b.clear_api_key === true} then null
                             else coalesce(excluded.api_key, core.sms_settings.api_key) end,
            is_active = excluded.is_active`;
        return { data: { ok: true } };
      });
    } catch (err) { throw translatePgError(err); }
  });

  /**
   * SMS gönderir.
   *
   * İzin, numara ve İYS kontrolü `core.sms_enqueue` içinde; burada yalnızca
   * ağ tarafı var. Engellenen mesaj sağlayıcıya HİÇ gitmez ama kaydı durur.
   */
  app.post('/core/sms/send', async (req, reply) => {
    const b = (req.body ?? {}) as Record<string, unknown>;
    if (typeof b.body !== 'string' || b.body.trim() === '') {
      throw badRequest('body zorunlu');
    }
    if (b.partner_id === undefined && typeof b.phone !== 'string') {
      throw badRequest('partner_id ya da phone verilmeli');
    }

    const ctx = contextFromRequest(req);
    try {
      const sonuc = await withContext(ctx, async (tx) => {
        const [msg] = await tx`
          select * from core.sms_enqueue(
            ${(b.partner_id as string) ?? null},
            ${(b.phone as string) ?? null},
            ${b.body as string},
            ${b.is_commercial !== false},
            ${(b.contact_id as string) ?? null})`;
        const m = msg as {
          id: string; phone: string; body: string; status: string; error: string | null;
        };
        if (m.status === 'blocked') return { msg: m, gonderildi: false };

        const [ayarSat] = await tx`
          select provider, sender, username, password, api_key, is_active
          from core.sms_settings where tenant_id = core.current_tenant_id()`;
        const ayarRow = ayarSat as {
          provider?: string; sender?: string; username?: string;
          password?: string; api_key?: string; is_active?: boolean;
        } | undefined;

        // AYAR YOKSA `log`: kurulum yapılmamış bir kiracıda gerçek bir
        // sağlayıcı varsaymak, yanlış hesaptan mesaj gitmesi demek olurdu.
        const kod = ayarRow?.is_active ? (ayarRow.provider ?? 'log') : 'log';
        const saglayici = getSmsProvider(kod);
        const ayar: SmsAyar = {
          sender: ayarRow?.sender ?? null,
          username: ayarRow?.username ?? null,
          password: ayarRow?.password ?? null,
          apiKey: ayarRow?.api_key ?? null,
        };

        const r = await saglayici.gonder({ phone: m.phone, body: m.body }, ayar);
        await tx`
          select core.sms_mark(${m.id}, ${r.ok ? 'sent' : 'failed'},
                               ${saglayici.code}, ${r.ref ?? null}, ${r.hata ?? null})`;
        // KAYIT YENİDEN OKUNUR, elde birleştirilmez: `sms_mark` sağlayıcı
        // kodunu, referansı ve gönderim zamanını yazıyor. Yanıtı istemcide
        // kurmak, veritabanında olan ile istemcinin gördüğünü ayırıyordu --
        // yanıt "provider: null" derken kayıtta "log" yazıyordu.
        const [son] = await tx`select * from core.sms_messages where id = ${m.id}`;
        return { msg: son, gonderildi: r.ok };
      });

      // ENGELLENEN VE BAŞARISIZ MESAJ 200 DÖNMEZ: arayüz "gönderildi" diye
      // kapanırsa kullanıcı mesajın gitmediğini hiç öğrenmez.
      if (!sonuc.gonderildi) reply.code(422);
      return { data: sonuc.msg };
    } catch (err) { throw translatePgError(err); }
  });
}
