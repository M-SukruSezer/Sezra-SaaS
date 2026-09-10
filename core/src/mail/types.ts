/**
 * Bağlı mail hesabı -- sağlayıcı-bağımsız tipler.
 *
 * Dört sağlayıcı (IMAP, POP3, Microsoft Graph, Gmail) tek bir model arkasında:
 * gizli olmayan bağlantı ayarları `config`'te, gizli olan her şey uygulama
 * katmanında şifrelenmiş tek bir blob'ta (bkz. ./crypto.ts).
 */
export type MailProvider = 'imap' | 'pop3' | 'ms_graph' | 'gmail';

export const MAIL_PROVIDERS: readonly MailProvider[] = ['imap', 'pop3', 'ms_graph', 'gmail'];

export type MailSecurity = 'ssl' | 'starttls' | 'none';

/** Gizli OLMAYAN bağlantı ayarları. Veritabanında düz metin `config` jsonb. */
export interface MailAccountConfig {
  /** IMAP/POP3 sunucu adı. */
  host?: string;
  /** IMAP/POP3 port (993/995/143/110). */
  port?: number;
  security?: MailSecurity;
  /** Oturum açma adı (çoğu zaman e-posta adresinin kendisi). Gizli değil. */
  username?: string;
  /** OAuth kapsamları (Graph/Gmail). Bilgi amaçlı. */
  scopes?: string[];
  /**
   * SMTP gönderim ayarları (IMAP/POP3 hesapları için). Gizli DEĞİL: parola
   * yine secret_cipher'da. Verilmezse host'tan makul varsayılan türetilir
   * (imap.x -> smtp.x, ssl -> 465, starttls -> 587). Bunun için migration yok.
   */
  smtp_host?: string;
  smtp_port?: number;
  smtp_security?: MailSecurity;
}

/**
 * Şifrelenerek saklanan gizli demet. HİÇBİR okuma ucundan dönmez.
 * IMAP/POP3 -> password. OAuth -> access/refresh token.
 */
export interface MailSecret {
  password?: string;
  access_token?: string;
  refresh_token?: string;
}

export type MailStatus = 'pending' | 'verified' | 'error' | 'expired';

/** `core.mail_account_list()` satırı -- gizli alan İÇERMEZ. */
export interface MailAccountRow {
  id: string;
  provider: MailProvider;
  display_name: string;
  email_address: string;
  config: MailAccountConfig;
  status: MailStatus;
  status_detail: string | null;
  last_verified_at: string | null;
  token_expires_at: string | null;
  has_secret: boolean;
  created_at: string;
  updated_at: string;
}
