import type { CompanyLookupOutcome, CompanyProvider } from './types.js';

/**
 * Ucretli firma-bilgisi saglayicisi icin HAZIR SLOT.
 *
 * Mail kartindaki desen: kimlik bilgisi (COMPANY_LOOKUP_PAID_URL +
 * COMPANY_LOOKUP_PAID_KEY) ortam degiskeninde tanimliysa devreye girer,
 * yoksa isConfigured() false doner ve panelde "yapilandirilmamis" gorunur.
 * Anahtar ASLA istemciye donmez -- yalnizca "configured" bool.
 *
 * SOZLESME (varsayilan): GET <URL>?vkn=<VKN>, Authorization: Bearer <KEY>,
 * yanit JSON: { unvan, vergiDairesi, vergiDairesiKodu, mersisNo, mukellefiyet,
 *               adres, il, ilce, postaKodu } -- alan adlari saglayiciya gore
 * degisebilir; asil saglayici secildiginde bu esleme netlestirilir.
 */

const CFG = () => ({
  url: process.env.COMPANY_LOOKUP_PAID_URL?.trim() || '',
  key: process.env.COMPANY_LOOKUP_PAID_KEY?.trim() || '',
});

const TIMEOUT_MS = 8_000;

const str = (v: unknown) => (typeof v === 'string' && v.trim() ? v.trim() : null);

export function paidParse(body: unknown): CompanyLookupOutcome {
  if (!body || typeof body !== 'object') return { status: 'error', detail: 'Beklenmedik yanit' };
  const b = body as Record<string, unknown>;
  const title = str(b.unvan) ?? str(b.title) ?? str(b.name);
  if (!title) return { status: 'not_found' };
  return {
    status: 'found',
    info: {
      title,
      taxOffice: str(b.vergiDairesi) ?? str(b.taxOffice),
      taxOfficeCode: str(b.vergiDairesiKodu) ?? str(b.taxOfficeCode),
      mersisNo: str(b.mersisNo) ?? str(b.mersis),
      taxLiabilityType: str(b.mukellefiyet) ?? str(b.taxLiabilityType),
      address: str(b.adres) ?? str(b.address),
      city: str(b.il) ?? str(b.city),
      district: str(b.ilce) ?? str(b.district),
      postalCode: str(b.postaKodu) ?? str(b.postalCode),
    },
  };
}

export const paidProvider: CompanyProvider = {
  code: 'paid',
  ad: 'Ucretli firma bilgisi saglayici',
  isConfigured: () => {
    const { url, key } = CFG();
    return Boolean(url && key);
  },
  async lookup(vkn: string): Promise<CompanyLookupOutcome> {
    const { url, key } = CFG();
    if (!url || !key) return { status: 'error', detail: 'yapilandirilmamis' };
    const iptal = new AbortController();
    const zamanlayici = setTimeout(() => iptal.abort(), TIMEOUT_MS);
    try {
      const u = new URL(url);
      u.searchParams.set('vkn', vkn);
      const res = await fetch(u, {
        headers: { authorization: `Bearer ${key}`, accept: 'application/json' },
        signal: iptal.signal,
      });
      if (res.status === 404) return { status: 'not_found' };
      if (!res.ok) return { status: 'error', detail: `Saglayici HTTP ${res.status}` };
      return paidParse(await res.json().catch(() => null));
    } catch (err) {
      return {
        status: 'error',
        detail: err instanceof Error && err.name === 'AbortError'
          ? 'Saglayici zaman asimi' : 'Saglayici baglanti hatasi',
      };
    } finally {
      clearTimeout(zamanlayici);
    }
  },
};
