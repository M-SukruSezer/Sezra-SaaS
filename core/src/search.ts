import type { FastifyInstance, FastifyRequest } from 'fastify';
import { contextFromRequest } from './auth.js';
import { withContext } from './db.js';
import { translatePgError } from './errors.js';
import type { Tx } from './db.js';

/* ===========================================================================
   Genel arama
   ===========================================================================
   Üst çubuktaki arama kutusu KAYIT arar: firma, kişi, ürün, teklif, sipariş,
   fatura. Sayfa aramak ayrı bir iştir ve komut paletine aittir; ikisini tek
   kutuda toplamak, "Ahmet" yazan kullanıcıya "Cariler" sayfasını önermek
   demek olurdu.

   TEK İSTEK, ÇOK KAYNAK: her modül kendi aranabilir kaydını buraya kaydeder,
   uç hepsini TEK bağlamda çalıştırır. İstemciden altı ayrı liste ucuna
   paralel istek atmak da işe yarardı ama her tuş vuruşunda altı istek
   demekti ve sıralama istemcide, yani yanlış yerde yapılırdı.

   YETKİ VERİTABANINDA: her kaynak kendi tablosunu normal RLS altında sorgular.
   Kullanıcının göremediği kayıt sonuçta da çıkmaz -- bu, uygulama katmanında
   bir süzgeçle değil, sorgunun kendisiyle sağlanır. Modül ve izin kontrolü
   yalnızca GEREKSİZ SORGUYU atlamak içindir, güvenlik sınırı değildir.
   ========================================================================= */

export interface AramaSatiri {
  id: string;
  baslik: string;
  /** İkinci satır: kod, tutar, tarih -- kaydı ayırt ettiren şey. */
  alt: string | null;
  /** Arayüzde gidilecek yol. */
  yol: string;
}

export interface AramaKaynagi {
  /** Sonuç rozetinde yazan tür adı. */
  etiket: string;
  /** Sıra: küçük olan üstte çıkar. Cari ve ürün en sık arananlar. */
  sira: number;
  /** Bu modül kapalıysa kaynak hiç sorgulanmaz. */
  modul?: string;
  /** Bu izin yoksa kaynak hiç sorgulanmaz. */
  izin?: string;
  ara(tx: Tx, desen: string, limit: number): Promise<AramaSatiri[]>;
}

const kaynaklar: AramaKaynagi[] = [];

/**
 * Bir arama kaynağı kaydeder.
 *
 * Modüller kendi kayıtlarını kendileri tanıtır: core'un finance tablolarını
 * bilmesi gerekseydi modüler yapı adı üstünde kalırdı.
 */
export function registerSearchSource(kaynak: AramaKaynagi): void {
  kaynaklar.push(kaynak);
}

/** Testlerin kaynak listesini sıfırlayabilmesi için. */
export function _aramaKaynaklariniTemizle(): void {
  kaynaklar.length = 0;
}

/**
 * `ilike` deseni.
 *
 * Kullanıcının yazdığı `%` ve `_` kaçırılır; yoksa tek bir `%` tüm tabloyu
 * getirir ve arama anlamını yitirir.
 */
function desenYap(q: string): string {
  return `%${q.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
}

export function registerSearch(app: FastifyInstance): void {
  app.get('/search', async (req) => {
    const { q, limit } = req.query as { q?: string; limit?: string };
    const arama = (q ?? '').trim();
    const kaynakBasi = Math.min(Math.max(Number(limit) || 5, 1), 20);

    // İKİ HARFTEN KISA ARAMA YAPILMAZ: tek harf neredeyse her kaydı
    // eşleştirir ve kullanıcıya sonuç değil gürültü döner.
    if (arama.length < 2) return { data: [], meta: { q: arama, kisa: true } };

    const ctx = contextFromRequest(req);
    const desen = desenYap(arama);

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
          try {
            return { etiket: k.etiket, sira: k.sira, satirlar: await k.ara(tx, desen, kaynakBasi) };
          } catch {
            // BİR KAYNAK DÜŞERSE ARAMA DÜŞMEZ. Bir modülün görünümü
            // bozuksa kullanıcı diğer sonuçları yine de görmeli; tüm
            // aramayı hataya çevirmek, çalışan kısmı da yok eder.
            return { etiket: k.etiket, sira: k.sira, satirlar: [] as AramaSatiri[] };
          }
        }));

        const data = gruplar
          .filter((g) => g.satirlar.length > 0)
          .sort((a, b) => a.sira - b.sira)
          .map((g) => ({ etiket: g.etiket, satirlar: g.satirlar }));

        return {
          data,
          meta: { q: arama, toplam: data.reduce((t, g) => t + g.satirlar.length, 0) },
        };
      });
    } catch (err) {
      throw translatePgError(err);
    }
  });
}

/** Modüllerin kendi kaynaklarını tanıtırken kullandığı kısayol tipi. */
export type { Tx, FastifyRequest };
