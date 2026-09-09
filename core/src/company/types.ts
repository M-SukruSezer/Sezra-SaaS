/**
 * Firma bilgisi sorgulama -- saglayici soyutlamasi.
 *
 * SMS / e-Fatura tarafindaki kalibin AYNISI: urunun geri kalani somut bir
 * kaynaga degil bu arayuze baglanir. Bugun GIB'in herkese acik listesi,
 * yarin ucretli bir entegrasyon -- adapter degisir, urun degismez.
 *
 * KAPSAM: yalnizca VKN -> firma sicil bilgisi. Vergi borcu, sicil gazetesi,
 * risk raporu vb. bu arayuzun isi degil.
 */

/** Saglayicidan donen HAM bilgi. Route bunu dogrular, temizler, forma cevirir. */
export interface CompanyInfoRaw {
  /** Ticaret unvani. Saglayicida farkli anahtarlarla gelebilir; adapter normalize eder. */
  title?: string | null;
  taxOffice?: string | null;
  taxOfficeCode?: string | null;
  mersisNo?: string | null;
  taxLiabilityType?: string | null;
  address?: string | null;
  city?: string | null;
  district?: string | null;
  postalCode?: string | null;
}

export type CompanyLookupOutcome =
  | { status: 'found'; info: CompanyInfoRaw }
  | { status: 'not_found' }
  /** Saglayiciya ulasilamadi / beklenmedik yanit. detail SUNUCU LOGU icin, kullaniciya gitmez. */
  | { status: 'error'; detail: string };

export interface CompanyProvider {
  code: string;
  ad: string;
  /** Kimlik bilgisi gerektiren (ucretli) saglayici env'de tanimli mi. GIB icin daima true. */
  isConfigured(): boolean;
  /** Gecerliligi DOGRULANMIS 10 haneli VKN ile cagrilir. Asla exception firlatmaz. */
  lookup(vkn: string): Promise<CompanyLookupOutcome>;
}
