/**
 * SMTP ile mail gonderme -- harici kutuphane yok, node:net + node:tls.
 *
 * verify.ts/fetch.ts ile ayni yaklasim: en kucuk el sikisma, ortak soket
 * ilkelleri ./net.ts'te, hata dort kategoriye iner (auth/network/tls/protocol).
 * Asla exception firlatmaz -- sonuc her zaman bir SendResult.
 *
 * SMTP sunucu/port/guvenlik bilgisi hesabin `config` jsonb'sindedir
 * (smtp_host / smtp_port / smtp_security); gizli parola secret_cipher'dan
 * yalnizca gonderim aninda cozulur ve hicbir yanit/log/hata mesajina girmez.
 *
 * KAPSAM: duz metin govde. Ek EKLEME bu kartta yok.
 */
import type net from 'node:net';
import {
  connect, upgradeTls, readUntil, writeLine, classifyMailError,
  MAIL_DETAIL, type MailErrorCategory,
} from './net.js';
import { decodeWords } from './mime.js';
import type { MailAccountConfig, MailSecurity } from './types.js';

export interface SendMessage {
  fromAddr: string;
  fromName?: string;
  to: string[];
  cc?: string[];
  subject: string;
  bodyText: string;
  inReplyTo?: string;
}

export interface SendResult {
  ok: boolean;
  category?: MailErrorCategory;
  detail?: string;
  messageId?: string;
}

/** config'ten SMTP ayarlarini cikarir. IMAP host'undan makul bir varsayilan turetir. */
export function smtpSettingsFromConfig(config: MailAccountConfig): {
  host: string; port: number; security: MailSecurity;
} {
  const c = config as Record<string, unknown>;
  const host = typeof c.smtp_host === 'string' && c.smtp_host.trim()
    ? c.smtp_host.trim()
    : (config.host ?? '').replace(/^(imap|pop3?)\./i, 'smtp.');
  const security: MailSecurity = c.smtp_security === 'starttls' || c.smtp_security === 'none'
    ? c.smtp_security : 'ssl';
  const rawPort = Number(c.smtp_port);
  const port = Number.isFinite(rawPort) && rawPort > 0 && rawPort < 65536
    ? rawPort
    : (security === 'ssl' ? 465 : 587);
  return { host, port, security };
}

const fail = (category: MailErrorCategory): SendResult =>
  ({ ok: false, category, detail: MAIL_DETAIL[category] });

/** ASCII disi basligi RFC 2047 (=?utf-8?B?..?=) ile kodlar. */
function encodeHeader(value: string): string {
  // eslint-disable-next-line no-control-regex
  if (/^[\x00-\x7F]*$/.test(value)) return value;
  return `=?utf-8?B?${Buffer.from(value, 'utf8').toString('base64')}?=`;
}

function buildMime(m: SendMessage, messageId: string): string {
  const h: string[] = [];
  h.push(`From: ${m.fromName ? `${encodeHeader(m.fromName)} <${m.fromAddr}>` : m.fromAddr}`);
  h.push(`To: ${m.to.join(', ')}`);
  if (m.cc?.length) h.push(`Cc: ${m.cc.join(', ')}`);
  h.push(`Subject: ${encodeHeader(m.subject)}`);
  h.push(`Date: ${new Date().toUTCString().replace(/GMT$/, '+0000')}`);
  h.push(`Message-ID: <${messageId}>`);
  if (m.inReplyTo) {
    const ref = m.inReplyTo.replace(/[<>]/g, '');
    h.push(`In-Reply-To: <${ref}>`);
    h.push(`References: <${ref}>`);
  }
  h.push('MIME-Version: 1.0');
  h.push('Content-Type: text/plain; charset=utf-8');
  h.push('Content-Transfer-Encoding: base64');
  const body = Buffer.from(m.bodyText, 'utf8').toString('base64').replace(/(.{76})/g, '$1\r\n');
  return h.join('\r\n') + '\r\n\r\n' + body + '\r\n';
}

/** Bir mail adresini kaba dogrular (RFC'nin tamami degil; enjeksiyonu keser). */
export function isEmail(a: string): boolean {
  return /^[^@\s<>",;]+@[^@\s<>",;]+\.[^@\s<>",;]+$/.test(a.trim());
}

export async function sendMail(
  config: MailAccountConfig,
  authUser: string,
  authPass: string,
  message: SendMessage,
): Promise<SendResult> {
  const { host, port, security } = smtpSettingsFromConfig(config);
  if (!host) return fail('network');

  const recipients = [...message.to, ...(message.cc ?? [])].map((s) => s.trim()).filter(Boolean);
  if (!recipients.length || !recipients.every(isEmail) || !isEmail(message.fromAddr)) {
    return fail('protocol');
  }

  let sock: net.Socket;
  try {
    sock = await connect(host, port, security === 'ssl');
  } catch (err) {
    return fail(classifyMailError(err as NodeJS.ErrnoException));
  }

  const expect = async (codes: number[], send?: string): Promise<string> => {
    if (send !== undefined) writeLine(sock, send);
    // SMTP: son satir "NNN <SP> ..." (tire degil) ile biter.
    const buf = await readUntil(sock, (b) => /^\d{3} [^\r\n]*\r\n/m.test(b) || /^\d{3}\r\n/m.test(b));
    const code = Number(/^(\d{3})[ \r]/m.exec(buf.split(/\r?\n/).filter(Boolean).pop() ?? buf)?.[1] ?? 0);
    if (!codes.includes(code)) {
      const e = new Error(`SMTP ${code}`);
      (e as { smtpCode?: number }).smtpCode = code;
      throw e;
    }
    return buf;
  };

  const b64 = (s: string) => Buffer.from(s, 'utf8').toString('base64');
  const messageId = `${Date.now()}.${Math.random().toString(36).slice(2)}@${host}`;

  try {
    await expect([220]);
    const ehloName = (message.fromAddr.split('@')[1] ?? 'localhost').trim();
    await expect([250], `EHLO ${ehloName}`);

    if (security === 'starttls') {
      await expect([220], 'STARTTLS');
      sock = await upgradeTls(sock, host);
      await expect([250], `EHLO ${ehloName}`);
    }

    // AUTH LOGIN
    try {
      await expect([334], 'AUTH LOGIN');
      await expect([334], b64(authUser));
      await expect([235], b64(authPass));
    } catch {
      sock.destroy();
      return fail('auth');
    }

    await expect([250], `MAIL FROM:<${message.fromAddr}>`);
    for (const rcpt of recipients) {
      await expect([250, 251], `RCPT TO:<${rcpt}>`);
    }
    await expect([354], 'DATA');

    const mime = buildMime(message, messageId)
      .split('\r\n')
      .map((ln) => (ln.startsWith('.') ? '.' + ln : ln))
      .join('\r\n');
    sock.write(mime);
    await expect([250], '\r\n.');

    await expect([221], 'QUIT').catch(() => undefined);
    sock.destroy();
    return { ok: true, messageId };
  } catch (err) {
    sock.destroy();
    const smtpCode = (err as { smtpCode?: number }).smtpCode;
    if (smtpCode && [535, 530, 534, 454].includes(smtpCode)) return fail('auth');
    if (smtpCode && smtpCode >= 500) {
      return { ok: false, category: 'protocol', detail: `Sunucu reddetti (SMTP ${smtpCode}).` };
    }
    return fail(classifyMailError(err as NodeJS.ErrnoException));
  }
}

export { decodeWords };
