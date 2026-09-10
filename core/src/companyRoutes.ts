import type { FastifyInstance, FastifyRequest } from 'fastify';
import { contextFromRequest } from './auth.js';
import { withContext } from './db.js';
import { AppError, badRequest, forbidden, translatePgError } from './errors.js';
import { classifyTaxNo, normalizeTaxNo } from './company/vkn.js';
import { listCompanyProviders, lookupCompany } from './company/registry.js';
import type { CompanyInfoRaw } from './company/types.js';

/* ===========================================================================
   Firma bilgisi sorgulama uclari -- T-028
   ===========================================================================
   AKIS: Frontend -> BU BACKEND -> saglayici -> backend -> frontend.
   Frontend ucuncu tarafa ASLA dogrudan gitmez; API anahtari istemciye SIZMAZ.

   - GET /core/company/providers : kod + ad + configured. Anahtar DONMEZ.
   - GET /core/company/lookup?tax_no=<VKN> : dogrula -> (cache) -> (rate limit)
     -> saglayici -> TEMIZLE -> forma yazilabilir alanlar.

   Kullaniciya HER DURUMDA elle girme izni; teknik detay (status, saglayici,
   stack, ham govde) yanita KONMAZ. VKN loglanmaz (gerekirse maskeli).
   ========================================================================= */

// -- Kullaniciya gosterilecek metinler (insanin verdigi, aynen) ---------------
const MSG = {
  found: 'Firma bilgileri başarıyla getirildi.',
  not_found: 'Bu vergi numarasına ait firma bilgisi bulunamadı. Bilgileri manuel olarak girebilirsiniz.',
  error: 'Firma bilgisi şu an sorgulanamadı. Bilgileri manuel olarak girebilirsiniz.',
  tckn: 'Bu bir TC kimlik numarası; firma sorgusu yalnızca 10 haneli VKN için yapılır.',
  invalid: 'Geçerli bir 10 haneli vergi numarası girin.',
  rate: 'Çok fazla sorgu yapıldı, lütfen biraz bekleyin.',
} as const;

// -- Cache: VKN -> sonuc. Firma unvani/adresi nadiren degisir; ayni formu
//    birkac kez acan kullanici GIB'e tekrar gitmesin. Bulunan 1 saat, bulunamadi
//    / hata 10 dk (yeni kayit ya da gecici kesinti daha cabuk toparlansin). ----
type Cached = { at: number; body: LookupBody };
const cache = new Map<string, Cached>();
const TTL_FOUND = 60 * 60_000;
const TTL_MISS = 10 * 60_000;

// -- Rate limit: kullanici basina 60 sn'de 20 sorgu. Elle form dolduran kimse
//    asamaz; betik asar. Bellek ici; tek surec varsayimi (SMS/mail ile ayni). --
const RL_WINDOW = 60_000;
const RL_MAX = 20;
const hits = new Map<string, number[]>();

function rateLimited(userId: string): boolean {
  const now = Date.now();
  const arr = (hits.get(userId) ?? []).filter((t) => now - t < RL_WINDOW);
  arr.push(now);
  hits.set(userId, arr);
  return arr.length > RL_MAX;
}

interface CompanyFields {
  name?: string;
  tax_office?: string;
  tax_office_code?: string;
  mersis_no?: string;
  tax_liability_type?: string;
  address?: string;
  city?: string;
  district?: string;
  postal_code?: string;
}
type LookupBody =
  | { found: true; status: 'found'; message: string; company: CompanyFields }
  | { found: false; status: 'not_found' | 'error' | 'tckn'; message: string };

/** Saglayicidan gelen HAM metni forma yazilabilir hale getirir: HTML/kontrol
 *  karakterlerini sil, kirp, uzunluk sinirla, bicimi dogrula. */
function sanitize(raw: CompanyInfoRaw): CompanyFields {
  const clean = (v: string | null | undefined, max: number): string | undefined => {
    if (typeof v !== 'string') return undefined;
    const s = v
      .replace(/<[^>]*>/g, ' ')          // HTML etiketi -> bosluk (asla render edilmez)
      .replace(/[\x00-\x1F\x7F]/g, ' ')  // kontrol karakterleri
      .replace(/[<>]/g, '')              // kalan aci parantez
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, max);
    return s || undefined;
  };
  const out: CompanyFields = {};
  const name = clean(raw.title, 200); if (name) out.name = name;
  const to = clean(raw.taxOffice, 100); if (to) out.tax_office = to;
  const mersis = normalizeTaxNo(raw.mersisNo ?? '');
  if (/^\d{16}$/.test(mersis)) out.mersis_no = mersis;
  const toc = normalizeTaxNo(raw.taxOfficeCode ?? '');
  if (toc && toc.length <= 10) out.tax_office_code = toc;
  const lt = clean(raw.taxLiabilityType, 60); if (lt) out.tax_liability_type = lt;
  const addr = clean(raw.address, 300); if (addr) out.address = addr;
  const city = clean(raw.city, 60); if (city) out.city = city;
  const dist = clean(raw.district, 60); if (dist) out.district = dist;
  const pc = normalizeTaxNo(raw.postalCode ?? '');
  if (/^\d{5}$/.test(pc)) out.postal_code = pc;
  return out;
}

const maskVkn = (v: string) => (v.length >= 4 ? `******${v.slice(-4)}` : '****');

export function registerCompanyRoutes(app: FastifyInstance): void {
  /** Saglayicilar + yapilandirma durumu. ANAHTAR ASLA DONMEZ. */
  app.get('/core/company/providers', async () => ({ data: listCompanyProviders() }));

  /** VKN -> firma bilgisi. */
  app.get('/core/company/lookup', async (req: FastifyRequest, reply) => {
    const ctx = contextFromRequest(req);
    const q = req.query as { tax_no?: string };
    const value = normalizeTaxNo((q.tax_no ?? '').toString());

    // Yetki: yalnizca cari acabilen kullanici sorgular (kotuye kullanim yuzeyi).
    try {
      await withContext(ctx, async (tx) => {
        const [row] = await tx`select core.has_perm('core.partner.create') as ok`;
        if (!(row as { ok: boolean })?.ok) throw forbidden('Cari oluşturma yetkiniz yok');
      });
    } catch (err) { throw translatePgError(err); }

    const kind = classifyTaxNo(value);
    if (kind === 'tckn') {
      return { data: { found: false, status: 'tckn', message: MSG.tckn } satisfies LookupBody };
    }
    if (kind === 'invalid') {
      // Gecersiz VKN -> HIC istek atma.
      throw badRequest(MSG.invalid);
    }

    if (rateLimited(ctx.userId)) throw new AppError(429, 'rate_limited', MSG.rate);

    const now = Date.now();
    const hit = cache.get(value);
    if (hit && now - hit.at < (hit.body.found ? TTL_FOUND : TTL_MISS)) {
      return { data: hit.body };
    }

    let body: LookupBody;
    try {
      const outcome = await lookupCompany(value);
      if (outcome.status === 'found') {
        body = { found: true, status: 'found', message: MSG.found, company: sanitize(outcome.info) };
      } else if (outcome.status === 'not_found') {
        body = { found: false, status: 'not_found', message: MSG.not_found };
      } else {
        // Teknik detay SUNUCU LOGUNA, kullaniciya DEGIL.
        req.log.warn({ vkn: maskVkn(value), detail: outcome.detail }, 'firma sorgusu hatasi');
        body = { found: false, status: 'error', message: MSG.error };
      }
    } catch (err) {
      req.log.error({ vkn: maskVkn(value), err }, 'firma sorgusu beklenmedik hata');
      body = { found: false, status: 'error', message: MSG.error };
    }

    cache.set(value, { at: now, body });
    reply.code(200);
    return { data: body };
  });
}

/** Test icin: cache ve rate-limit sayaclarini sifirla. */
export function _resetCompanyLookupState(): void {
  cache.clear();
  hits.clear();
}
