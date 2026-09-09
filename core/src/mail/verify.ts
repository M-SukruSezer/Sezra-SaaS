/**
 * IMAP / POP3 bağlantı doğrulama -- "Bağlantıyı test et".
 *
 * Harici kütüphane yok: node:net + node:tls ile en küçük el sıkışma. Amaç
 * posta çekmek DEĞİL, yalnızca "bu ayarlarla giriş yapılabiliyor mu" sorusuna
 * KULLANICIYA ANLAMLI bir cevap vermek:
 *   - auth     : kullanıcı adı / parola yanlış
 *   - network  : sunucuya ulaşılamıyor (yanlış sunucu adı / port / kapalı)
 *   - tls      : TLS/SSL el sıkışması başarısız (yanlış port ya da sertifika)
 *   - protocol : sunucu beklenmedik yanıt verdi
 */
import net from 'node:net';
import tls from 'node:tls';
import type { MailAccountConfig, MailSecurity } from './types.js';

export type VerifyCategory = 'auth' | 'network' | 'tls' | 'protocol' | 'ok';

export interface VerifyResult {
  ok: boolean;
  status: 'verified' | 'error';
  category: VerifyCategory;
  detail: string;
}

const TIMEOUT_MS = 12_000;

const DETAIL: Record<Exclude<VerifyCategory, 'ok'>, string> = {
  auth: 'Kimlik doğrulama başarısız: kullanıcı adı ya da parola yanlış.',
  network: 'Sunucuya ulaşılamadı. Sunucu adını ve portu kontrol edin.',
  tls: 'TLS/SSL el sıkışması başarısız. Genellikle yanlış port ya da güvenlik ayarı.',
  protocol: 'Sunucu beklenmedik bir yanıt verdi.',
};

function classifyError(err: NodeJS.ErrnoException): VerifyCategory {
  const code = err.code ?? '';
  if (['ECONNREFUSED', 'ENOTFOUND', 'EAI_AGAIN', 'ETIMEDOUT', 'EHOSTUNREACH', 'ENETUNREACH', 'ECONNRESET']
    .includes(code)) return 'network';
  if (code.startsWith('ERR_TLS') || code.startsWith('ERR_SSL') || code === 'EPROTO'
    || /certificate|self-signed|SSL|TLS|wrong version number/i.test(err.message)) return 'tls';
  return 'protocol';
}

/** Bir soket satır satır okur; verilen kalıp gelene / kapanana / süre bitene kadar bekler. */
function readUntil(sock: net.Socket, test: (buf: string) => boolean): Promise<string> {
  return new Promise((resolve, reject) => {
    let buf = '';
    const onData = (d: Buffer) => {
      buf += d.toString('utf8');
      if (test(buf)) { cleanup(); resolve(buf); }
    };
    const onErr = (e: Error) => { cleanup(); reject(e); };
    const onEnd = () => { cleanup(); resolve(buf); };
    const t = setTimeout(() => { cleanup(); reject(Object.assign(new Error('timeout'), { code: 'ETIMEDOUT' })); }, TIMEOUT_MS);
    function cleanup() {
      clearTimeout(t);
      sock.off('data', onData); sock.off('error', onErr); sock.off('end', onEnd);
    }
    sock.on('data', onData); sock.on('error', onErr); sock.on('end', onEnd);
  });
}

function connect(host: string, port: number, secure: boolean): Promise<net.Socket> {
  return new Promise((resolve, reject) => {
    const opts = { host, port, servername: host };
    const sock = secure
      ? tls.connect({ ...opts, rejectUnauthorized: false }, () => resolve(sock))
      : net.connect(opts, () => resolve(sock));
    sock.setTimeout(TIMEOUT_MS);
    sock.once('timeout', () => { sock.destroy(); reject(Object.assign(new Error('timeout'), { code: 'ETIMEDOUT' })); });
    sock.once('error', reject);
  });
}

function upgradeTls(sock: net.Socket, host: string): Promise<tls.TLSSocket> {
  return new Promise((resolve, reject) => {
    const up = tls.connect({ socket: sock, servername: host, rejectUnauthorized: false }, () => resolve(up));
    up.once('error', reject);
  });
}

const q = (s: string) => '"' + s.replace(/([\\"])/g, '\\$1') + '"';

async function verifyImap(host: string, port: number, security: MailSecurity, user: string, pass: string): Promise<VerifyResult> {
  let sock: net.Socket = await connect(host, port, security === 'ssl');
  await readUntil(sock, (b) => /\r\n/.test(b));                       // * OK greeting

  if (security === 'starttls') {
    sock.write('S1 STARTTLS\r\n');
    const r = await readUntil(sock, (b) => /^S1 (OK|NO|BAD)/mi.test(b));
    if (!/^S1 OK/mi.test(r)) return { ok: false, status: 'error', category: 'tls', detail: DETAIL.tls };
    sock = await upgradeTls(sock, host);
  }

  sock.write(`A1 LOGIN ${q(user)} ${q(pass)}\r\n`);
  const r = await readUntil(sock, (b) => /^A1 (OK|NO|BAD)/mi.test(b));
  sock.write('A9 LOGOUT\r\n');
  sock.destroy();

  if (/^A1 OK/mi.test(r)) return { ok: true, status: 'verified', category: 'ok', detail: 'Bağlantı doğrulandı.' };
  if (/^A1 (NO|BAD)/mi.test(r)) return { ok: false, status: 'error', category: 'auth', detail: DETAIL.auth };
  return { ok: false, status: 'error', category: 'protocol', detail: DETAIL.protocol };
}

async function verifyPop3(host: string, port: number, security: MailSecurity, user: string, pass: string): Promise<VerifyResult> {
  let sock: net.Socket = await connect(host, port, security === 'ssl');
  await readUntil(sock, (b) => /\r\n/.test(b));                       // +OK greeting

  if (security === 'starttls') {
    sock.write('STLS\r\n');
    const r = await readUntil(sock, (b) => /\r\n/.test(b));
    if (!/^\+OK/i.test(r)) return { ok: false, status: 'error', category: 'tls', detail: DETAIL.tls };
    sock = await upgradeTls(sock, host);
  }

  sock.write(`USER ${user}\r\n`);
  const ru = await readUntil(sock, (b) => /\r\n/.test(b));
  if (!/^\+OK/i.test(ru)) { sock.destroy(); return { ok: false, status: 'error', category: 'auth', detail: DETAIL.auth }; }
  sock.write(`PASS ${pass}\r\n`);
  const rp = await readUntil(sock, (b) => /\r\n/.test(b));
  sock.write('QUIT\r\n');
  sock.destroy();

  if (/^\+OK/i.test(rp)) return { ok: true, status: 'verified', category: 'ok', detail: 'Bağlantı doğrulandı.' };
  return { ok: false, status: 'error', category: 'auth', detail: DETAIL.auth };
}

/**
 * IMAP/POP3 bağlantısını dener. Ağ/TLS/kimlik hataları ayrıştırılmış döner.
 * Asla exception fırlatmaz -- sonuç her zaman bir VerifyResult.
 */
export async function verifyMailConnection(
  provider: 'imap' | 'pop3',
  config: MailAccountConfig,
  user: string,
  pass: string,
): Promise<VerifyResult> {
  const host = (config.host ?? '').trim();
  const port = Number(config.port);
  const security: MailSecurity = config.security ?? 'ssl';
  if (!host || !Number.isFinite(port) || port <= 0) {
    return { ok: false, status: 'error', category: 'network', detail: DETAIL.network };
  }
  try {
    return provider === 'imap'
      ? await verifyImap(host, port, security, user, pass)
      : await verifyPop3(host, port, security, user, pass);
  } catch (err) {
    const cat = classifyError(err as NodeJS.ErrnoException);
    return { ok: false, status: 'error', category: cat === 'ok' ? 'protocol' : cat, detail: DETAIL[cat === 'ok' ? 'protocol' : cat] };
  }
}
