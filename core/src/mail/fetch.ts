/**
 * IMAP / POP3'ten gelen posta cekme -- harici kutuphane yok, node:net + node:tls.
 *
 * verify.ts'teki yaklasimin (en kucuk el sikisma, ag/TLS/kimlik hatasi
 * siniflandirmasi) devami; ortak soket ilkelleri ./net.ts'te. Bu dosya
 * yalnizca OKUR: hicbir mesaji sunucuda silmez ya da isaretlemez (IMAP'te
 * BODY.PEEK, POP3'te DELE yok).
 *
 * ARTIMLI: IMAP'te en son cekilen UID'den sonrasi (UID SEARCH), POP3'te
 * bilinen UIDL kumesinde olmayanlar cekilir. Her kosuda `limit` mesaj ve
 * mesaj basina `maxBytes` ust siniri var -- bir hesap on binlerce mesajla
 * paneli ve veritabanini bogamaz.
 *
 * ASLA exception firlatmaz: sonuc her zaman bir FetchResult (verify.ts gibi).
 */
import type net from 'node:net';
import {
  connect, upgradeTls, writeLine, classifyMailError,
  MAIL_DETAIL, MAIL_TIMEOUT_MS, type MailErrorCategory,
} from './net.js';
import { parseMail, makeSnippet, type ParsedMail } from './mime.js';
import type { MailAccountConfig, MailSecurity } from './types.js';

export interface FetchOptions {
  provider: 'imap' | 'pop3';
  config: MailAccountConfig;
  user: string;
  pass: string;
  /** IMAP: en son cekilen UID (bundan sonrasi cekilir). */
  sinceUid?: number;
  /** IMAP: daha once gorulen UIDVALIDITY. Degistiyse result.uidValidityChanged. */
  uidValidity?: string;
  /** POP3: veritabaninda zaten olan UIDL'ler. */
  knownUids?: Set<string>;
  /** Bu kosuda cekilecek en fazla mesaj (varsayilan 30, ust sinir 100). */
  limit?: number;
  /** Mesaj basina ham bayt ust siniri (varsayilan 512 KB). */
  maxBytes?: number;
}

export interface FetchedMessage extends ParsedMail {
  uid: string;
  folder: string;
  snippet?: string;
  sizeBytes?: number;
  receivedAt?: Date;
}

export interface FetchResult {
  ok: boolean;
  category?: MailErrorCategory;
  detail?: string;
  messages: FetchedMessage[];
  /** IMAP: bu kosudan sonraki en yuksek UID (yeni last_uid). */
  highestUid?: number;
  uidValidity?: string;
  uidValidityChanged?: boolean;
  /** Boyut siniri asildigi icin atlanan mesaj sayisi. */
  skipped: number;
}

const DEFAULT_LIMIT = 30;
const MAX_LIMIT = 100;
const DEFAULT_MAX_BYTES = 512 * 1024;

/** Bir soketten Buffer biriktirir; `done` true olunca ya da baglanti kapaninca cozer. */
function converse(sock: net.Socket, done: (buf: Buffer) => boolean): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let total = Buffer.alloc(0);
    const onData = (d: Buffer) => {
      chunks.push(d);
      total = Buffer.concat(chunks);
      if (done(total)) { cleanup(); resolve(total); }
    };
    const onErr = (e: Error) => { cleanup(); reject(e); };
    const onEnd = () => { cleanup(); resolve(total); };
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

function fail(category: MailErrorCategory): FetchResult {
  return { ok: false, category, detail: MAIL_DETAIL[category], messages: [], skipped: 0 };
}

function toMessage(uid: string, folder: string, raw: string, sizeBytes: number | undefined,
                   internalDate: Date | undefined): FetchedMessage {
  const parsed = parseMail(raw);
  return {
    ...parsed,
    uid,
    folder,
    snippet: makeSnippet(parsed.bodyText),
    sizeBytes,
    receivedAt: internalDate ?? parsed.date,
  };
}

/* ===========================================================================
   IMAP
   =========================================================================== */

async function fetchImap(o: FetchOptions): Promise<FetchResult> {
  const host = (o.config.host ?? '').trim();
  const port = Number(o.config.port);
  const security: MailSecurity = o.config.security ?? 'ssl';
  const limit = Math.min(Math.max(o.limit ?? DEFAULT_LIMIT, 1), MAX_LIMIT);
  const maxBytes = o.maxBytes ?? DEFAULT_MAX_BYTES;
  if (!host || !Number.isFinite(port) || port <= 0) return fail('network');

  let sock: net.Socket = await connect(host, port, security === 'ssl');
  let tag = 0;
  const nextTag = () => `a${++tag}`;

  const cmd = async (line: string): Promise<{ ok: boolean; text: string; tagName: string }> => {
    const tn = nextTag();
    writeLine(sock, `${tn} ${line}`);
    const re = new RegExp(`^${tn} (OK|NO|BAD)`, 'm');
    const buf = await converse(sock, (b) => {
      const s = b.toString('latin1');
      const litRe = /\{(\d+)\}\r\n/g;
      let m: RegExpExecArray | null;
      let last: RegExpExecArray | null = null;
      while ((m = litRe.exec(s)) !== null) last = m;
      if (last) {
        const need = last.index + last[0].length + Number(last[1]);
        if (b.length < need) return false;
      }
      return re.test(s);
    });
    const text = buf.toString('utf8');
    return { ok: new RegExp(`^${tn} OK`, 'm').test(text), text, tagName: tn };
  };

  try {
    await converse(sock, (b) => /\r\n/.test(b.toString('latin1'))); // greeting

    if (security === 'starttls') {
      const r = await cmd('STARTTLS');
      if (!r.ok) return fail('tls');
      sock = await upgradeTls(sock, host);
    }

    const q = (s: string) => '"' + s.replace(/([\\"])/g, '\\$1') + '"';
    const login = await cmd(`LOGIN ${q(o.user)} ${q(o.pass)}`);
    if (!login.ok) return fail('auth');

    const sel = await cmd('SELECT INBOX');
    if (!sel.ok) return fail('protocol');
    const uidValidity = /\[UIDVALIDITY (\d+)\]/i.exec(sel.text)?.[1];
    const uidValidityChanged = Boolean(
      o.uidValidity && uidValidity && o.uidValidity !== uidValidity,
    );
    const since = uidValidityChanged ? 0 : (o.sinceUid ?? 0);

    const search = await cmd(`UID SEARCH UID ${since + 1}:*`);
    if (!search.ok) return fail('protocol');
    const uids = (search.text.match(/^\*\s+SEARCH([^\r\n]*)/mi)?.[1] ?? '')
      .trim().split(/\s+/).map(Number)
      .filter((n) => Number.isFinite(n) && n > since);
    uids.sort((a, b) => a - b);
    const pick = uids.slice(-limit); // en yeni `limit` tanesi

    const messages: FetchedMessage[] = [];
    let skipped = 0;
    let highestUid = since;

    // Boyutlari topluca al -> buyukleri atla.
    const sizes = new Map<number, number>();
    if (pick.length) {
      const sz = await cmd(`UID FETCH ${pick.join(',')} (UID RFC822.SIZE)`);
      for (const m of sz.text.matchAll(/UID (\d+) RFC822\.SIZE (\d+)/gi)) {
        sizes.set(Number(m[1]), Number(m[2]));
      }
    }

    for (const uid of pick) {
      const size = sizes.get(uid);
      if (size !== undefined && size > maxBytes) {
        skipped++;
        highestUid = Math.max(highestUid, uid);
        continue;
      }
      const r = await cmd(`UID FETCH ${uid} (INTERNALDATE BODY.PEEK[])`);
      if (!r.ok) continue;
      const litM = /\{(\d+)\}\r\n/.exec(r.text);
      let raw = '';
      if (litM && litM.index !== undefined) {
        const start = litM.index + litM[0].length;
        raw = r.text.slice(start, start + Number(litM[1]));
      }
      const idM = /INTERNALDATE "([^"]+)"/i.exec(r.text);
      const internalDate = idM?.[1] ? new Date(idM[1]) : undefined;
      messages.push(toMessage(String(uid), 'INBOX', raw, size,
        internalDate && !Number.isNaN(internalDate.getTime()) ? internalDate : undefined));
      highestUid = Math.max(highestUid, uid);
    }

    await cmd('LOGOUT').catch(() => undefined);
    sock.destroy();

    return {
      ok: true, messages, skipped, highestUid,
      uidValidity, uidValidityChanged,
    };
  } catch (err) {
    const cat = classifyMailError(err as NodeJS.ErrnoException);
    return fail(cat);
  } finally {
    // Her yoldan kapat: erken `return fail(...)` (auth/tls/protocol) da soketi
    // acik birakmasin -- yoksa FD sunucu zaman asimina kadar sizar.
    sock.destroy();
  }
}

/* ===========================================================================
   POP3
   =========================================================================== */

async function fetchPop3(o: FetchOptions): Promise<FetchResult> {
  const host = (o.config.host ?? '').trim();
  const port = Number(o.config.port);
  const security: MailSecurity = o.config.security ?? 'ssl';
  const limit = Math.min(Math.max(o.limit ?? DEFAULT_LIMIT, 1), MAX_LIMIT);
  const maxBytes = o.maxBytes ?? DEFAULT_MAX_BYTES;
  const known = o.knownUids ?? new Set<string>();
  if (!host || !Number.isFinite(port) || port <= 0) return fail('network');

  let sock: net.Socket = await connect(host, port, security === 'ssl');

  const line = async (command: string): Promise<string> => {
    writeLine(sock, command);
    const buf = await converse(sock, (b) => /\r\n/.test(b.toString('latin1')));
    return buf.toString('utf8');
  };
  const multi = async (command: string): Promise<string> => {
    writeLine(sock, command);
    const buf = await converse(sock, (b) => {
      const s = b.toString('latin1');
      return /^-ERR/i.test(s) || /\r\n\.\r\n$/.test(s) || s === '.\r\n';
    });
    return buf.toString('utf8');
  };

  try {
    await converse(sock, (b) => /\r\n/.test(b.toString('latin1'))); // +OK greeting

    if (security === 'starttls') {
      const r = await line('STLS');
      if (!/^\+OK/i.test(r)) return fail('tls');
      sock = await upgradeTls(sock, host);
    }

    const u = await line(`USER ${o.user}`);
    if (!/^\+OK/i.test(u)) return fail('auth');
    const p = await line(`PASS ${o.pass}`);
    if (!/^\+OK/i.test(p)) return fail('auth');

    const uidlRaw = await multi('UIDL');
    if (/^-ERR/i.test(uidlRaw)) return fail('protocol');
    // "num uid" satirlari
    const entries: { num: number; uid: string }[] = [];
    for (const ln of uidlRaw.split(/\r?\n/)) {
      const m = /^(\d+)\s+(\S+)$/.exec(ln.trim());
      if (m?.[1] && m[2]) entries.push({ num: Number(m[1]), uid: m[2] });
    }

    const sizes = new Map<number, number>();
    const listRaw = await multi('LIST').catch(() => '');
    for (const ln of listRaw.split(/\r?\n/)) {
      const m = /^(\d+)\s+(\d+)$/.exec(ln.trim());
      if (m) sizes.set(Number(m[1]), Number(m[2]));
    }

    // Bilinmeyenler, en yeni (yuksek num) once, `limit` tane.
    const pick = entries
      .filter((e) => !known.has(e.uid))
      .sort((a, b) => b.num - a.num)
      .slice(0, limit);

    const messages: FetchedMessage[] = [];
    let skipped = 0;

    for (const e of pick) {
      const size = sizes.get(e.num);
      if (size !== undefined && size > maxBytes) { skipped++; continue; }
      const body = await multi(`RETR ${e.num}`);
      if (/^-ERR/i.test(body)) continue;
      // "+OK ...\r\n" basligini at, sondaki "\r\n.\r\n"i kirp, nokta-kacisini coz.
      const nl = body.indexOf('\r\n');
      let raw = nl >= 0 ? body.slice(nl + 2) : body;
      raw = raw.replace(/\r\n\.\r\n$/, '').replace(/^\.\./gm, '.');
      messages.push(toMessage(e.uid, 'INBOX', raw, size ?? Buffer.byteLength(raw), undefined));
    }

    await line('QUIT').catch(() => undefined);
    sock.destroy();

    return { ok: true, messages, skipped };
  } catch (err) {
    return fail(classifyMailError(err as NodeJS.ErrnoException));
  } finally {
    sock.destroy();
  }
}

/**
 * Bir IMAP/POP3 hesabindan gelen postayi ceker. Artimli; her kosuda sinirli.
 * Asla exception firlatmaz.
 */
export async function fetchMail(o: FetchOptions): Promise<FetchResult> {
  try {
    return o.provider === 'imap' ? await fetchImap(o) : await fetchPop3(o);
  } catch (err) {
    return fail(classifyMailError(err as NodeJS.ErrnoException));
  }
}

export { MAIL_TIMEOUT_MS };
