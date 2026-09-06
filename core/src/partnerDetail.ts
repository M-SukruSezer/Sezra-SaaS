import type { FastifyInstance } from 'fastify';
import { contextFromRequest } from './auth.js';
import { withContext } from './db.js';
import { badRequest, notFound, translatePgError } from './errors.js';
import type { Tx } from './db.js';

/* ===========================================================================
   Cari kartı — ilişki ağı
   ===========================================================================
   Bir cariye bakan kişinin asıl sorusu "bu firmayla aramızda ne var". Cevap
   tek bir tabloda değil: teklifte, siparişte, faturada, tahsilatta, destek
   biletinde. İlişki ağı bunları TEK bakışta sayar ve tutarlarını gösterir.

   HER MODÜL KENDİ İLİŞKİSİNİ TANITIR: core'un finance ya da helpdesk
   tablolarını bilmesi gerekseydi modüler yapı adı üstünde kalırdı. Arama ve
   bildirim kayıtlarıyla aynı kalıp.

   ÖZET VE SATIRLAR AYRI SORGULAR: üst banttaki çipler her açılışta gerekli
   (ucuz sayım), satırlar yalnızca o sekme açıldığında (pahalı liste). İkisi
   tek sorguda toplansaydı, kart açılışında hiç bakılmayacak yüzlerce satır
   çekilirdi.
   ========================================================================= */

export interface CariOzet {
  adet: number;
  /** Tutar toplamı; ilişkinin parası yoksa null (ör. ilgili kişi). */
  toplam: string | null;
  paraBirimi?: string | null;
}

export interface CariBaglantisi {
  /** URL ve sekme anahtarı: 'teklif', 'fatura'… */
  anahtar: string;
  etiket: string;
  sira: number;
  modul?: string;
  izin?: string;
  ozet(tx: Tx, partnerId: string): Promise<CariOzet>;
  satirlar(tx: Tx, partnerId: string, limit: number): PromiseLike<readonly unknown[]>;
}

const baglantilar: CariBaglantisi[] = [];

export function registerPartnerRelation(b: CariBaglantisi): void {
  baglantilar.push(b);
}

/** Modül ve izin süzgeci. Güvenlik sınırı değil, gereksiz sorguyu atlar. */
async function gorunurler(tx: Tx): Promise<CariBaglantisi[]> {
  const [modSat] = await tx`
    select coalesce(array_agg(tm.module_code), '{}') as kodlar
    from core.tenant_modules tm
    where tm.tenant_id = coalesce(core.current_tenant_id(), core.support_tenant_id())
      and tm.enabled`;
  const moduller = new Set((modSat?.kodlar as string[] | null) ?? []);
  const [izinSat] = await tx`select core.permission_codes() as codes`;
  const izinler = new Set((izinSat?.codes as string[] | null) ?? []);
  return baglantilar
    .filter((b) => (!b.modul || moduller.has(b.modul)) && (!b.izin || izinler.has(b.izin)))
    .sort((a, b) => a.sira - b.sira);
}

export function registerPartnerDetail(app: FastifyInstance): void {
  /** Cari kartının tamamı: kayıt, özet bandı ve ilişki çipleri. */
  app.get('/core/partners/:id/detail', async (req) => {
    const { id } = req.params as { id: string };
    const ctx = contextFromRequest(req);
    try {
      return await withContext(ctx, async (tx) => {
        const [partner] = await tx`
          select p.*, u.full_name as owner_name, b.name as branch_name
          from core.partners p
          left join core.users u on u.id = p.owner_id
          left join core.branches b on b.id = p.branch_id
          where p.id = ${id}`;
        if (!partner) throw notFound('Cari bulunamadı');

        const [ozet] = await tx`
          select tax_no_valid, acik_bakiye, acik_fatura_sayisi, ortalama_vade, kisi_sayisi
          from core.v_partner_summary where partner_id = ${id}`;

        const secilen = await gorunurler(tx);
        const iliskiler = await Promise.all(secilen.map(async (b) => {
          try {
            const o = await b.ozet(tx, id);
            return { anahtar: b.anahtar, etiket: b.etiket, ...o };
          } catch {
            // BİR İLİŞKİ DÜŞERSE KART DÜŞMEZ: bir modülün görünümü bozuksa
            // kullanıcı carinin geri kalanını yine de görmeli.
            return { anahtar: b.anahtar, etiket: b.etiket, adet: 0, toplam: null };
          }
        }));

        const kisiler = await tx`
          select id, name, title, email, phone, is_primary
          from core.partner_contacts where partner_id = ${id}
          order by is_primary desc, name`;

        return {
          data: {
            partner,
            ozet: ozet ?? null,
            // Sıfır kayıtlı ilişki de DÖNER: "hiç faturası yok" bir bilgidir
            // ve çipi tamamen gizlemek onu görünmez yapardı. Arayüz sıfırı
            // soluk çizer.
            iliskiler,
            kisiler,
          },
        };
      });
    } catch (err) { throw translatePgError(err); }
  });

  /**
   * Mükerrer cariyi bu cariye birleştirir.
   *
   * KURAL VERİTABANINDA: `core.merge_partners` hem izni hem "kendisiyle
   * birleşemez" kuralını kendisi uygular ve yabancı anahtarları katalogdan
   * bulur. Burada tekrar kontrol etmek iki doğruluk kaynağı yaratırdı.
   */
  app.post('/core/partners/:id/merge', async (req) => {
    const { id } = req.params as { id: string };
    const b = (req.body ?? {}) as { source_id?: unknown };
    if (typeof b.source_id !== 'string') throw badRequest('source_id zorunlu');
    const ctx = contextFromRequest(req);
    try {
      return await withContext(ctx, async (tx) => {
        const [row] = await tx`
          select core.merge_partners(${b.source_id as string}, ${id}) as rapor`;
        return { data: (row as { rapor: unknown }).rapor };
      });
    } catch (err) { throw translatePgError(err); }
  });

  /** Bir ilişkinin satırları. Sekme açıldığında istenir. */
  app.get('/core/partners/:id/relations/:anahtar', async (req) => {
    const { id, anahtar } = req.params as { id: string; anahtar: string };
    const { limit } = req.query as { limit?: string };
    const n = Math.min(Math.max(Number(limit) || 50, 1), 200);
    const ctx = contextFromRequest(req);
    try {
      return await withContext(ctx, async (tx) => {
        const secilen = await gorunurler(tx);
        const b = secilen.find((x) => x.anahtar === anahtar);
        if (!b) throw notFound(`Bilinmeyen ilişki: ${anahtar}`);
        return { data: await b.satirlar(tx, id, n) };
      });
    } catch (err) { throw translatePgError(err); }
  });
}
