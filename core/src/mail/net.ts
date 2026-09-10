/**
 * IMAP / POP3 / SMTP icin en kucuk soket katmani -- node:net + node:tls.
 *
 * Harici kutuphane yok. verify.ts (baglanti dogrulama) bu ilkelleri kullaniyordu;
 * cekme (fetch.ts) ve gonderme (send.ts) de ayni el sikismayi yapmak zorunda,
 * o yuzden ortak yer burasi. Davranis verify.ts'ten AYNEN tasindi.
 *
 * Hata siniflandirmasi kullaniciya anlamli dort kategoriye iner:
 *   - auth     : kullanici adi / parola yanlis
 *   - network  : sunucuya ulasilamiyor (yanlis sunucu / port / kapali)
 *   - tls      : TLS/SSL el sikismasi basarisiz
 *   - protocol : sunucu beklenmedik yanit verdi
 */
import net from 'node:net';
import tls from 'node:tls';

export type MailErrorCategory = 'auth' | 'network' | 'tls' | 'protocol';

export const MAIL_DETAIL: Record<MailErrorCategory, string> = {
  auth: 'Kimlik doğrulama başarısız: kullanıcı adı ya da parola yanlış.',
  network: 'Sunucuya ulaşılamadı. Sunucu adını ve portu kontrol edin.',
  tls: 'TLS/SSL el sıkışması başarısız. Genellikle yanlış port ya da güvenlik ayarı.',
  protocol: 'Sunucu beklenmedik bir yanıt verdi.',
};

export const MAIL_TIMEOUT_MS = 15_000;

/** Bir ag/TLS hatasini kullaniciya anlamli kategoriye indirger. */
export function classifyMailError(err: NodeJS.ErrnoException): MailErrorCategory {
  const code = err.code ?? '';
  if (['ECONNREFUSED', 'ENOTFOUND', 'EAI_AGAIN', 'ETIMEDOUT', 'EHOSTUNREACH', 'ENETUNREACH', 'ECONNRESET']
    .includes(code)) return 'network';
  if (code.startsWith('ERR_TLS') || code.startsWith('ERR_SSL') || code === 'EPROTO'
    || /certificate|self-signed|SSL|TLS|wrong version number/i.test(err.message)) return 'tls';
  return 'protocol';
}

/** Tasiyan hata: kategoriyi ustte yakalayabilmek icin. */
export class MailNetError extends Error {
  constructor(readonly category: MailErrorCategory, message?: string) {
    super(message ?? MAIL_DETAIL[category]);
    this.name = 'MailNetError';
  }
}

/** Bir soketi satir satir okur; kalip gelene / kapanana / sure bitene kadar. */
export function readUntil(sock: net.Socket, test: (buf: string) => boolean): Promise<string> {
  return new Promise((resolve, reject) => {
    let buf = '';
    const onData = (d: Buffer) => {
      buf += d.toString('utf8');
      if (test(buf)) { cleanup(); resolve(buf); }
    };
    const onErr = (e: Error) => { cleanup(); reject(e); };
    const onEnd = () => { cleanup(); resolve(buf); };
    const t = setTimeout(() => {
      cleanup();
      reject(Object.assign(new Error('timeout'), { code: 'ETIMEDOUT' }));
    }, MAIL_TIMEOUT_MS);
    function cleanup() {
      clearTimeout(t);
      sock.off('data', onData); sock.off('error', onErr); sock.off('end', onEnd);
    }
    sock.on('data', onData); sock.on('error', onErr); sock.on('end', onEnd);
  });
}

/** TCP (ve istege bagli TLS) baglantisi acar. */
export function connect(host: string, port: number, secure: boolean): Promise<net.Socket> {
  return new Promise((resolve, reject) => {
    const opts = { host, port, servername: host };
    const sock: net.Socket = secure
      ? tls.connect({ ...opts, rejectUnauthorized: false }, () => resolve(sock))
      : net.connect(opts, () => resolve(sock));
    sock.setTimeout(MAIL_TIMEOUT_MS);
    sock.once('timeout', () => {
      sock.destroy();
      reject(Object.assign(new Error('timeout'), { code: 'ETIMEDOUT' }));
    });
    sock.once('error', reject);
  });
}

/** Duz bir soketi STARTTLS sonrasi TLS'e yukseltir. */
export function upgradeTls(sock: net.Socket, host: string): Promise<tls.TLSSocket> {
  return new Promise((resolve, reject) => {
    const up = tls.connect(
      { socket: sock, servername: host, rejectUnauthorized: false },
      () => resolve(up),
    );
    up.once('error', reject);
  });
}

/** Sokete bir satir yazar (CRLF eklenir). */
export function writeLine(sock: net.Socket, line: string): void {
  sock.write(line + '\r\n');
}
