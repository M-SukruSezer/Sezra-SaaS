import type { CompanyLookupOutcome, CompanyProvider } from './types.js';

/**
 * GIB e-Fatura "PublicUserService" adapteri -- HERKESE ACIK, UCRETSIZ, kimlik
 * gerektirmez, CAPTCHA/scraping/login YOK.
 *
 * SOZLESME: GIB e-Fatura merkezi, e-Fatura/e-Irsaliye kayitli kullanicilarini
 * sorgulayan bir SOAP servisi yayinlar. `checkUser` bir VKN alir ve o VKN
 * kayitliysa ticaret unvanini (<title>) doner; kayitli degilse bos liste.
 * Kucuk isletmeler e-Fatura kullanicisi olmayabilir -> o durumda "bulunamadi"
 * doner ve kullanici bilgileri elle girer.
 *
 * DOGRULAMA NOTU (netgsm.ts ile ayni durum): bu adapter GIB'in belgelenmis
 * SOAP sozlesmesine gore yazildi ama CANLI SERVISE KARSI CALISTIRILMADI --
 * bu ortamda cikis yok. Kodun kendi mantigi (istek kurma, yanit ayristirma,
 * zaman asimi, hata maskeleme) sinandi; ag ucundaki davranis ilk gercek
 * kurulumda dogrulanmalidir. Uc noktasi ortam degiskeniyle degistirilebilir:
 * GIB_EFATURA_WS_URL.
 */

const WS_URL = () => process.env.GIB_EFATURA_WS_URL
  ?? 'https://merkez.efatura.gov.tr/EFaturaMerkez/services/PublicUserService';

const TIMEOUT_MS = 8_000;

const escapeXml = (s: string) => s.replace(/[<>&'"]/g, (c) =>
  ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', "'": '&apos;', '"': '&quot;' }[c]!));

function buildEnvelope(vkn: string): string {
  return '<?xml version="1.0" encoding="UTF-8"?>'
    + '<soapenv:Envelope xmlns:soapenv="http://schemas.xmlsoap.org/soap/envelope/"'
    + ' xmlns:ser="http://gib.gov.tr/vedop3/entegrasyon">'
    + '<soapenv:Body><ser:checkUser>'
    + `<identifier>${escapeXml(vkn)}</identifier>`
    + '<documentType>INVOICE</documentType>'
    + '</ser:checkUser></soapenv:Body></soapenv:Envelope>';
}

/** Yaniti sonuca cevirir. Ayri fonksiyon: sinanabilir olsun diye. */
export function gibParse(xml: string): CompanyLookupOutcome {
  const t = (xml ?? '').trim();
  if (t === '') return { status: 'error', detail: 'GIB bos yanit dondu' };
  if (/<(soap(env)?:)?Fault>/i.test(t)) return { status: 'error', detail: 'GIB SOAP Fault' };

  // <title> ilk esilesme: kayitli kullanicinin ticaret unvani.
  const title = /<title>([^<]{1,300})<\/title>/i.exec(t)?.[1]?.trim();
  if (!title) return { status: 'not_found' };

  const alias = /<aliasName>([^<]{1,300})<\/aliasName>/i.exec(t)?.[1]?.trim() ?? null;
  return {
    status: 'found',
    info: {
      title,
      // GIB checkUser adres/VD dondurmez; yalnizca unvan (ve varsa etiket).
      taxLiabilityType: alias && /gb/i.test(alias) ? 'e-Fatura (GB)' : null,
    },
  };
}

export const gibProvider: CompanyProvider = {
  code: 'gib',
  ad: 'GIB e-Fatura kayitli kullanicilar (ucretsiz)',
  isConfigured: () => true,
  async lookup(vkn: string): Promise<CompanyLookupOutcome> {
    const iptal = new AbortController();
    const zamanlayici = setTimeout(() => iptal.abort(), TIMEOUT_MS);
    try {
      const res = await fetch(WS_URL(), {
        method: 'POST',
        headers: { 'content-type': 'text/xml; charset=utf-8', soapaction: '' },
        body: buildEnvelope(vkn),
        signal: iptal.signal,
      });
      if (!res.ok) return { status: 'error', detail: `GIB HTTP ${res.status}` };
      return gibParse(await res.text());
    } catch (err) {
      return {
        status: 'error',
        detail: err instanceof Error && err.name === 'AbortError'
          ? 'GIB zaman asimi' : 'GIB baglanti hatasi',
      };
    } finally {
      clearTimeout(zamanlayici);
    }
  },
};
