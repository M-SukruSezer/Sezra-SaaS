/**
 * SMS sağlayıcı soyutlaması.
 *
 * Ürünün geri kalanı somut bir operatöre değil bu arayüze bağlanır; yeni bir
 * operatör eklemek = yeni bir adapter yazmak. e-Fatura tarafındaki kalıbın
 * aynısı, çünkü sorun da aynı: entegrasyon sağlayıcısı sonradan değişir ve
 * değiştiğinde ürünün tamamı yeniden yazılamaz.
 */

export interface SmsAyar {
  /** Gönderen adı / başlık. Operatörde tanımlı olmayan başlıkla mesaj gitmez. */
  sender: string | null;
  username: string | null;
  password: string | null;
  apiKey: string | null;
}

export interface SmsGonderim {
  /** E.164 biçiminde numara (+905321234567). Normalizasyon veritabanında. */
  phone: string;
  body: string;
}

export interface SmsSonuc {
  ok: boolean;
  /** Operatörün verdiği mesaj kimliği; teslim raporu için gerekir. */
  ref?: string;
  hata?: string;
}

export interface SmsSaglayici {
  code: string;
  ad: string;
  /** Ayarlarda hangi alanların dolu olması gerektiğini söyler. */
  gerekliAlanlar: (keyof SmsAyar)[];
  gonder(mesaj: SmsGonderim, ayar: SmsAyar): Promise<SmsSonuc>;
}
