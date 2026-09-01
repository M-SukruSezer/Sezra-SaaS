/**
 * e-Fatura / e-Arşiv sağlayıcı soyutlaması (Bölüm 6 ve 8).
 *
 * Sağlayıcı seçimi henüz yapılmadı (Bölüm 11 açık sorusu: BizimHesap, Logo,
 * Foriba…). Bu yüzden ürünün geri kalanı somut bir entegratöre değil, bu
 * arayüze bağlanır. Yeni bir entegratör eklemek = yeni bir adapter yazmak.
 *
 * Kanonik yük (CanonicalInvoice) UBL-TR'ye BİREBİR karşılık gelmez; her
 * sağlayıcının kendi şemasına çevirmesi gereken, iş anlamı taşıyan ara
 * temsildir. UBL XML üretimini adapter'a bırakmak bilinçli: entegratörlerin
 * çoğu zaten JSON alıp UBL'yi kendisi üretiyor, üretenler için de dönüşüm
 * adapter'ın işi.
 */

export type EInvoiceProfile =
  | 'TEMELFATURA'        // alıcı e-Fatura mükellefi, yanıt beklenmez
  | 'TICARIFATURA'       // alıcı kabul/ret yanıtı verir
  | 'EARSIVFATURA'       // alıcı e-Fatura mükellefi değil
  | 'IHRACAT'
  | 'YOLCUBERABERFATURA';

export interface CanonicalParty {
  name: string;
  taxNumber: string | null;      // VKN (10) / TCKN (11)
  taxOffice: string | null;
  address: string | null;
  district: string | null;
  city: string | null;
  country: string;
  email: string | null;
  phone: string | null;
}

export interface CanonicalLine {
  sequence: number;
  name: string;
  quantity: string;
  unitCode: string;              // UN/ECE birim kodu: C62, KGM, LTR…
  unitPrice: string;
  discountPct: string;
  taxRate: string;
  taxAmount: string;
  withholdingAmount: string;
  lineTotal: string;
}

export interface CanonicalInvoice {
  invoiceId: string;
  number: string | null;
  issueDate: string;             // ISO tarih
  currency: string;
  profile: EInvoiceProfile;
  supplier: CanonicalParty;
  customer: CanonicalParty;
  lines: CanonicalLine[];
  subtotal: string;
  discountTotal: string;
  taxTotal: string;
  withholdingTotal: string;
  payableAmount: string;
  notes: string | null;
}

export interface SendResult {
  ettn: string;
  gibNumber?: string | null;
  status: 'sent' | 'delivered' | 'accepted' | 'error';
  raw: unknown;
}

export interface StatusResult {
  status: 'sent' | 'delivered' | 'accepted' | 'rejected' | 'error' | 'cancelled';
  gibNumber?: string | null;
  message?: string;
  raw: unknown;
}

export interface EInvoiceProvider {
  readonly code: string;
  /** Alıcının e-Fatura mükellefi olup olmadığını sorar; profil seçimi buna bağlı. */
  isRegistered(taxNumber: string): Promise<boolean>;
  send(invoice: CanonicalInvoice): Promise<SendResult>;
  status(ettn: string): Promise<StatusResult>;
  cancel(ettn: string, reason: string): Promise<void>;
}
