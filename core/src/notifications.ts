import type { FastifyInstance } from 'fastify';
import { contextFromRequest } from './auth.js';
import { withContext } from './db.js';
import { badRequest, translatePgError } from './errors.js';
import type { Tx } from './db.js';

/* ===========================================================================
   Bildirimler
   ===========================================================================
   BİLDİRİM SAKLANMAZ, TÜRETİLİR. Vadesi geçen fatura, kritik seviyeye düşen
   stok, onay bekleyen izin: hepsi zaten veritabanında duran gerçekler. Bunları
   ayrı bir tabloya kopyalamak iki doğruluk kaynağı yaratır ve ikisi mutlaka
   ayrışır -- fatura tahsil edilir ama bildirim orada durur.

   Saklanan tek şey kullanıcının neyi GÖRDÜĞÜ (`core.notification_reads`).

   HER KAYNAK KENDİ MODÜLÜNDE: core'un fatura tablosunu bilmesi gerekseydi
   modüler yapı adı üstünde kalırdı. Arama kaynaklarıyla aynı kalıp.
   ========================================================================= */

export type BildirimTonu = 'bilgi' | 'uyari' | 'tehlike';

export interface Bildirim {
  /** Kararlı anahtar: kaynak + kayıt kimliği. Okundu işareti buna bağlanır. */
  key: string;
  baslik: string;
  /** Ne yapılması gerektiğini söyleyen satır. */
  metin: string;
  ton: BildirimTonu;
  /** Tıklanınca gidilecek ekran. */
  yol: string;
  /** Sıralama için: olayın zamanı ya da vadenin geçtiği tarih. */
  zaman: string | null;
}

export interface BildirimKaynagi {
  /** Kaynağın adı; gruplama ve hata ayıklama için. */
  ad: string;
  modul?: string;
  izin?: string;
  uret(tx: Tx, limit: number): Promise<Bildirim[]>;
}

const kaynaklar: BildirimKaynagi[] = [];

export function registerNotificationSource(kaynak: BildirimKaynagi): void {
  kaynaklar.push(kaynak);
}

export function registerNotifications(app: FastifyInstance): void {
  /**
   * Bildirim listesi.
   *
   * OKUNMUŞLAR DA DÖNER, işaretli olarak. Okunanı listeden tamamen atmak,
   * kullanıcının "az önce ne okumuştum" sorusunu cevapsız bırakır; sayaç
   * yalnızca okunmamışları sayar.
   */
  app.get('/notifications', async (req) => {
    const { limit } = req.query as { limit?: string };
    const kaynakBasi = Math.min(Math.max(Number(limit) || 10, 1), 50);
    const ctx = contextFromRequest(req);

    try {
      return await withContext(ctx, async (tx) => {
        const [modSat] = await tx`
          select coalesce(array_agg(tm.module_code), '{}') as kodlar
          from core.tenant_modules tm
          where tm.tenant_id = coalesce(core.current_tenant_id(), core.support_tenant_id())
            and tm.enabled`;
        const acikModuller = new Set((modSat?.kodlar as string[] | null) ?? []);

        const [izinSat] = await tx`select core.permission_codes() as codes`;
        const izinler = new Set((izinSat?.codes as string[] | null) ?? []);

        const secilen = kaynaklar.filter((k) =>
          (!k.modul || acikModuller.has(k.modul))
          && (!k.izin || izinler.has(k.izin)));

        const gruplar = await Promise.all(secilen.map(async (k) => {
          try { return await k.uret(tx, kaynakBasi); } catch { return [] as Bildirim[]; }
        }));

        const hepsi = gruplar.flat();

        const okunanlar = await tx<{ key: string }[]>`
          select key from core.notification_reads
          where tenant_id = core.current_tenant_id()
            and user_id = core.current_user_id()`;
        const okundu = new Set(okunanlar.map((r) => r.key));

        // TEHLİKE ÖNCE, sonra en yeni. Bir bildirim listesinde sıralama
        // kronolojik olsaydı, üç gün önce gecikmiş bir fatura bugünkü
        // bilgilendirmelerin altında kalırdı.
        const agirlik: Record<BildirimTonu, number> = { tehlike: 0, uyari: 1, bilgi: 2 };
        const data = hepsi
          .map((b) => ({ ...b, okundu: okundu.has(b.key) }))
          .sort((a, b) => (agirlik[a.ton] - agirlik[b.ton])
            || String(b.zaman ?? '').localeCompare(String(a.zaman ?? '')));

        return {
          data,
          meta: { toplam: data.length, okunmamis: data.filter((b) => !b.okundu).length },
        };
      });
    } catch (err) {
      throw translatePgError(err);
    }
  });

  /** Okundu işaretleme. Anahtar listesi boşsa hiçbir şey yapılmaz. */
  app.post('/notifications/read', async (req) => {
    const b = (req.body ?? {}) as { keys?: unknown };
    if (!Array.isArray(b.keys)) throw badRequest('keys bir dizi olmalı');
    const keys = b.keys.filter((k): k is string => typeof k === 'string');
    const ctx = contextFromRequest(req);
    try {
      return await withContext(ctx, async (tx) => {
        const [row] = await tx`select core.notification_mark_read(${keys}) as eklendi`;
        return { data: { eklendi: Number((row as { eklendi: number }).eklendi) } };
      });
    } catch (err) {
      throw translatePgError(err);
    }
  });
}
