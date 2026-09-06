import type { FastifyInstance } from 'fastify';
import { withSystemContext } from './db.js';

/**
 * TCMB döviz kurları.
 *
 * NEDEN SUNUCUDAN ÇEKİLİYOR:
 *   TCMB'nin XML'i tarayıcıdan CORS ile okunamaz. Ayrıca her sekmenin ayrı
 *   ayrı TCMB'ye gitmesi hem gereksiz hem de kaba olurdu; sunucu bir kez
 *   çeker, veritabanına yazar, herkes oradan okur.
 *
 * NEDEN VERİTABANINA YAZILIYOR, BELLEKTE TUTULMUYOR:
 *   Bellekteki önbellek her yeniden başlatmada boşalır ve birden çok API
 *   örneği çalıştığında her biri ayrı TCMB isteği yapar. Kur zaten geçmişi
 *   saklanmaya değer bir veri; kalıcı olması değişim yüzdesini de mümkün
 *   kılıyor.
 *
 * TCMB HAFTA SONU VE TATİLDE YENİ BÜLTEN YAYINLAMAZ; `today.xml` o günlerde
 * son iş gününün bültenini döndürür. Bu yüzden "bugünün kuru yok" diye bir
 * durum yoktur, "son bültenin kuru" vardır ve arayüz de öyle yazar.
 */

const TCMB_URL = 'https://www.tcmb.gov.tr/kurlar/today.xml';

/** Geçmiş bülten adresi: /kurlar/YYYYMM/DDMMYYYY.xml */
const tcmbGecmisUrl = (d: Date): string => {
  const gg = String(d.getDate()).padStart(2, '0');
  const aa = String(d.getMonth() + 1).padStart(2, '0');
  const yyyy = String(d.getFullYear());
  return `https://www.tcmb.gov.tr/kurlar/${yyyy}${aa}/${gg}${aa}${yyyy}.xml`;
};

/**
 * Geriye kaç gün bakılacağı.
 *
 * Değişim yüzdesi iki bülten ister. Yalnızca `today.xml` çekilseydi yüzde,
 * bir sonraki iş gününe kadar "bilinmiyor" kalırdı. Hafta sonu ve resmî
 * tatiller yüzünden bir önceki bülten üç dört gün geride olabilir; bu sayı
 * uzun bir bayram tatilini de kapsar. Bulunan İLK bülten yeter, gerisine
 * bakılmaz.
 */
const GERIYE_GUN = 10;

/** İzlenen para birimleri. Kiracıların kullandığı üç birimden TRY yereldir. */
export const FX_CURRENCIES = ['USD', 'EUR'] as const;

/**
 * Aynı bülten için tekrar tekrar TCMB'ye gidilmez.
 *
 * TCMB bülteni iş günlerinde bir kez (öğleden sonra) yayınlar. Bu aralık,
 * "yeni bülten çıkmış olabilir mi" sorusunu makul sıklıkta sorar; daha
 * kısası TCMB'yi boşuna yorar, daha uzunu yeni kuru saatlerce geciktirir.
 */
const TAZELEME_ARALIGI_MS = 30 * 60 * 1000;

/** Ağ takılırsa istek sonsuza kadar beklemesin: durum çubuğu bir sayfayı bloke etmemeli. */
const ZAMAN_ASIMI_MS = 8000;

interface TcmbKur {
  currency: string;
  unit: number;
  forexBuying: number | null;
  forexSelling: number | null;
  banknoteBuying: number | null;
  banknoteSelling: number | null;
}

interface TcmbBulten {
  bulletinDate: string;   // ISO (yyyy-mm-dd)
  bulletinNo: string | null;
  rates: TcmbKur[];
}

const sayi = (s: string | undefined): number | null => {
  if (!s) return null;
  const n = Number(s.trim());
  return Number.isFinite(n) ? n : null;
};

/**
 * TCMB XML'ini ayrıştırır.
 *
 * Tam bir XML ayrıştırıcı yerine hedefli düzenli ifade kullanılıyor: belge
 * sabit şemalı, küçük ve tek kaynaktan geliyor. Yeni bir bağımlılık eklemek
 * bu kadarlık iş için orantısız olurdu. Beklenmedik bir biçim gelirse
 * ayrıştırma boş döner ve çağıran taraf bunu hata olarak ele alır — sessizce
 * yanlış sayı yazmaktansa hiç yazmamak doğrudur.
 */
export function parseTcmb(xml: string): TcmbBulten | null {
  // Tarih_Date Tarih="03.09.2026" -> gg.aa.yyyy
  const tarih = /Tarih="(\d{2})\.(\d{2})\.(\d{4})"/.exec(xml);
  if (!tarih) return null;
  const [, gun, ay, yil] = tarih as unknown as [string, string, string, string];

  const bultenNo = /Bulten_No="([^"]+)"/.exec(xml)?.[1]?.trim() ?? null;

  const rates: TcmbKur[] = [];
  const bloklar = xml.matchAll(/<Currency\b[^>]*Kod="([A-Z]{3})"[\s\S]*?<\/Currency>/g);
  for (const blok of bloklar) {
    const kod = blok[1]!;
    const govde = blok[0];
    const al = (etiket: string) =>
      sayi(new RegExp(`<${etiket}>([^<]*)</${etiket}>`).exec(govde)?.[1]);
    rates.push({
      currency: kod,
      unit: al('Unit') ?? 1,
      forexBuying: al('ForexBuying'),
      forexSelling: al('ForexSelling'),
      banknoteBuying: al('BanknoteBuying'),
      banknoteSelling: al('BanknoteSelling'),
    });
  }
  if (rates.length === 0) return null;

  return { bulletinDate: `${yil}-${ay}-${gun}`, bulletinNo: bultenNo, rates };
}

async function tcmbdenCek(): Promise<TcmbBulten | null> {
  const iptal = AbortSignal.timeout(ZAMAN_ASIMI_MS);
  const res = await fetch(TCMB_URL, { signal: iptal });
  if (!res.ok) return null;
  return parseTcmb(await res.text());
}

/**
 * Gerekiyorsa TCMB'den çeker ve veritabanına yazar.
 *
 * Yazma SİSTEM BAĞLAMINDA yapılır: kur, kullanıcı isteğinden gelen bir veri
 * değildir. İstek yalnızca "bakmanın zamanı geldi mi" sorusunu tetikler;
 * içeriği TCMB belirler.
 */
/** Bir bülteni veritabanına yazar (izlenen para birimleri için). */
async function bulteniYaz(bulten: TcmbBulten): Promise<void> {
  const izlenen = bulten.rates.filter((r) =>
    (FX_CURRENCIES as readonly string[]).includes(r.currency));
  if (izlenen.length === 0) return;

  await withSystemContext(async (tx) => {
    for (const r of izlenen) {
      await tx`
        insert into core.fx_rates
          (currency, bulletin_date, unit, forex_buying, forex_selling,
           banknote_buying, banknote_selling, bulletin_no, fetched_at)
        values (${r.currency}, ${bulten.bulletinDate}, ${r.unit},
                ${r.forexBuying}, ${r.forexSelling},
                ${r.banknoteBuying}, ${r.banknoteSelling},
                ${bulten.bulletinNo}, now())
        on conflict (currency, bulletin_date) do update
          set unit = excluded.unit,
              forex_buying = excluded.forex_buying,
              forex_selling = excluded.forex_selling,
              banknote_buying = excluded.banknote_buying,
              banknote_selling = excluded.banknote_selling,
              bulletin_no = excluded.bulletin_no,
              fetched_at = excluded.fetched_at`;
    }
  });
}

/**
 * Önceki bülteni bir kez geriye doldurur.
 *
 * Yalnızca elde tek bülten varken çalışır ve ilk bulduğunda durur; her
 * istekte geçmişi taramaz. TCMB tatil günleri için 404 döndürür, bu bir
 * hata değil "o gün bülten yok" demektir ve sessizce bir önceki güne
 * geçilir.
 */
async function gecmisiDoldur(): Promise<void> {
  const bultenSayisi = await withSystemContext(async (tx) => {
    const [row] = await tx<{ n: number }[]>`
      select count(distinct bulletin_date)::int as n from core.fx_rates`;
    return row?.n ?? 0;
  });
  if (bultenSayisi >= 2) return;

  const enSon = await withSystemContext(async (tx) => {
    const [row] = await tx<{ d: string | null }[]>`
      select max(bulletin_date)::text as d from core.fx_rates`;
    return row?.d ?? null;
  });
  if (!enSon) return;

  for (let i = 1; i <= GERIYE_GUN; i++) {
    const gun = new Date(`${enSon}T00:00:00Z`);
    gun.setUTCDate(gun.getUTCDate() - i);
    try {
      const res = await fetch(tcmbGecmisUrl(gun), { signal: AbortSignal.timeout(ZAMAN_ASIMI_MS) });
      if (!res.ok) continue;                    // 404: o gün bülten yok
      const bulten = parseTcmb(await res.text());
      if (!bulten) continue;
      await bulteniYaz(bulten);
      return;                                    // İlk bulunan yeter
    } catch {
      // Ağ hatası: geriye doldurma isteğe bağlıdır, sessizce vazgeçilir.
      return;
    }
  }
}

async function tazeleGerekiyorsa(): Promise<void> {
  const taze = await withSystemContext(async (tx) => {
    const [row] = await tx<{ yeterince_taze: boolean }[]>`
      select coalesce(max(fetched_at) > now() - ${`${TAZELEME_ARALIGI_MS} milliseconds`}::interval, false)
             as yeterince_taze
      from core.fx_rates`;
    return row?.yeterince_taze ?? false;
  });
  if (taze) return;

  const bulten = await tcmbdenCek();
  if (!bulten) return;
  await bulteniYaz(bulten);
  await gecmisiDoldur();
}

export function registerFxRoutes(app: FastifyInstance): void {
  /**
   * Kur okuma — KİMLİK İSTEMEZ.
   *
   * Kur herkese açık bir piyasa verisidir ve durum çubuğu giriş ekranında da
   * görünebilir. TCMB'ye ulaşılamazsa uç HATA VERMEZ: elindeki son bülteni
   * döndürür ve `stale` bayrağıyla bunun tazelenemediğini söyler. Durum
   * çubuğu yüzünden bir sayfanın açılmaması kabul edilebilir değil.
   */
  app.get('/fx/rates', async (req) => {
    let tazelemeHatasi: string | null = null;
    try {
      await tazeleGerekiyorsa();
    } catch (err) {
      tazelemeHatasi = err instanceof Error ? err.message : String(err);
      req.log.warn({ err }, 'TCMB kur tazeleme başarısız');
    }

    return withSystemContext(async (tx) => {
      const rows = await tx<{
        currency: string; bulletin_date: string; bulletin_no: string | null;
        unit: number; forex_selling: string | null; previous: string | null;
        change_pct: string | null; fetched_at: string;
      }[]>`select * from core.fx_snapshot(${[...FX_CURRENCIES]}::text[])`;

      return {
        data: {
          rates: rows.map((r) => ({
            currency: r.currency,
            unit: r.unit,
            selling: r.forex_selling,
            change_pct: r.change_pct,
            bulletin_date: r.bulletin_date,
            bulletin_no: r.bulletin_no,
          })),
          source: 'TCMB',
          fetched_at: rows[0]?.fetched_at ?? null,
          // Tazeleme denendi ve başarısız olduysa arayüz bunu söyleyebilsin.
          stale: tazelemeHatasi !== null,
        },
      };
    });
  });
}
