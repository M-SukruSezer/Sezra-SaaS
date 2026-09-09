import type { CompanyLookupOutcome, CompanyProvider } from './types.js';
import { gibProvider } from './gib.js';
import { paidProvider } from './paid.js';

const saglayicilar = new Map<string, CompanyProvider>();

export function registerCompanyProvider(p: CompanyProvider): void {
  saglayicilar.set(p.code, p);
}

/** Panel/ayar ekrani icin: kod + ad + yapilandirildi mi. ANAHTAR DONMEZ. */
export function listCompanyProviders(): { code: string; ad: string; configured: boolean }[] {
  return [...saglayicilar.values()].map((p) => ({
    code: p.code, ad: p.ad, configured: p.isConfigured(),
  }));
}

/**
 * VKN'yi saglayicilara SIRAYLA sorar, ilk "found" doneni kazanir.
 *
 * Sira:
 *   1. COMPANY_LOOKUP_PROVIDER env ile bir saglayici sabitlenmisse yalniz onu
 *      (testler sahte saglayiciyi boyle devreye alir).
 *   2. Ucretli saglayici yapilandirilmissa once o (daha zengin veri).
 *   3. GIB (daima acik).
 *
 * "not_found" sonraki saglayiciya gecirir; "error" da oyle -- ama hicbiri
 * bulamazsa VE en az biri error verdiyse sonuc 'error'dir (kullaniciya yine
 * "bulunamadi + elle gir" gosterilir ama sunucu logu farki bilir).
 */
export async function lookupCompany(vkn: string): Promise<CompanyLookupOutcome> {
  const pinned = process.env.COMPANY_LOOKUP_PROVIDER?.trim();
  const sira: CompanyProvider[] = pinned
    ? [saglayicilar.get(pinned)].filter((p): p is CompanyProvider => Boolean(p))
    : [...saglayicilar.values()]
        .filter((p) => p.code !== 'gib' && p.isConfigured())
        .concat(saglayicilar.get('gib') ? [saglayicilar.get('gib')!] : []);

  let hadError = false;
  for (const p of sira) {
    const r = await p.lookup(vkn);
    if (r.status === 'found') return r;
    if (r.status === 'error') hadError = true;
  }
  return hadError ? { status: 'error', detail: 'tum saglayicilar bulamadi/hata' } : { status: 'not_found' };
}

registerCompanyProvider(gibProvider);
registerCompanyProvider(paidProvider);
