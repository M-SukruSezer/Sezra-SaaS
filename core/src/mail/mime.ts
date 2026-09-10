/**
 * En kucuk MIME cozumleyici -- cekilen ham RFC 5322 iletisini panelde
 * gosterilebilir alanlara indirger. Harici kutuphane yok.
 *
 * KAPSAM (bilincli olarak dar):
 *   - Baslik blogu: From/To/Cc/Subject/Date/Message-ID/In-Reply-To.
 *   - RFC 2047 kodlu-sozcuk cozumu (=?utf-8?B?..?= / =?..?Q?..?=).
 *   - Govde: multipart agacinda text/plain ve text/html; Content-Transfer-Encoding
 *     (base64 / quoted-printable / 7bit / 8bit) cozumu; charset en iyi caba.
 *   - Ek TESPITI (Content-Disposition: attachment ya da text disi yaprak) --
 *     ek INDIRME bu kartta yok, yalnizca "eki var" bayragi.
 *
 * body_html HAM doner; guvenli render (temizleme / duz metne dusme) cagiranin
 * ve arayuzun sorumlulugu. Bu dosya HTML'i degistirmez, yalnizca ayiklar.
 */

export interface ParsedMail {
  messageId?: string;
  inReplyTo?: string;
  subject?: string;
  fromAddr?: string;
  fromName?: string;
  toAddrs: string[];
  ccAddrs: string[];
  date?: Date;
  bodyText?: string;
  bodyHtml?: string;
  hasAttachments: boolean;
}

interface Part {
  headers: Map<string, string>;
  body: string;      // ham (satir sonlari korunur)
  raw: Buffer;
}

/** "Key: value" basliklarini ayristirir; katlanmis satirlari (LWS) birlestirir. */
function parseHeaders(block: string): Map<string, string> {
  const out = new Map<string, string>();
  const lines = block.split(/\r?\n/);
  let cur = '';
  const flush = () => {
    const idx = cur.indexOf(':');
    if (idx > 0) {
      const k = cur.slice(0, idx).trim().toLowerCase();
      const v = cur.slice(idx + 1).trim();
      out.set(k, out.has(k) ? `${out.get(k)}, ${v}` : v);
    }
    cur = '';
  };
  for (const ln of lines) {
    if (/^[ \t]/.test(ln) && cur) cur += ' ' + ln.trim();
    else { if (cur) flush(); cur = ln; }
  }
  if (cur) flush();
  return out;
}

/** Ham iletiyi baslik blogu + govdeye ayirir. */
function splitHeaderBody(raw: string): { head: string; body: string } {
  const m = raw.match(/\r?\n\r?\n/);
  if (!m || m.index === undefined) return { head: raw, body: '' };
  return { head: raw.slice(0, m.index), body: raw.slice(m.index + m[0].length) };
}

/** RFC 2047 kodlu-sozcuk: =?charset?B|Q?text?= */
export function decodeWords(input?: string): string {
  if (!input) return '';
  return input.replace(/=\?([^?]+)\?([bBqQ])\?([^?]*)\?=/g, (_all, charset: string, enc: string, text: string) => {
    try {
      let bytes: Buffer;
      if (enc.toUpperCase() === 'B') {
        bytes = Buffer.from(text, 'base64');
      } else {
        const q = text.replace(/_/g, ' ').replace(/=([0-9A-Fa-f]{2})/g, (_m, h) => String.fromCharCode(parseInt(h, 16)));
        bytes = Buffer.from(q, 'binary');
      }
      return decodeBuffer(bytes, charset);
    } catch { return text; }
  }).replace(/\?=\s+=\?/g, ''); // bitisik kodlu-sozcukler arasi bosluk
}

/** Bir Buffer'i charset'e gore metne cevirir (utf-8 disi icin en iyi caba). */
export function decodeBuffer(buf: Buffer, charset?: string): string {
  const cs = (charset ?? 'utf-8').toLowerCase().replace(/["']/g, '').trim();
  try {
    if (cs === 'utf-8' || cs === 'utf8' || cs === 'us-ascii' || cs === 'ascii') {
      return buf.toString('utf8');
    }
    if (cs === 'iso-8859-9' || cs === 'latin5' || cs === 'iso-8859-1' || cs === 'latin1'
      || cs === 'windows-1254' || cs === 'windows-1252' || cs === 'cp1254' || cs === 'cp1252') {
      // TextDecoder bu etiketleri (ozellikle Turkce windows-1254) tanir.
      return new TextDecoder(cs === 'latin5' ? 'iso-8859-9' : cs).decode(buf);
    }
    return new TextDecoder(cs).decode(buf);
  } catch {
    return buf.toString('utf8');
  }
}

function decodeCte(body: string, cte?: string, charset?: string): string {
  const enc = (cte ?? '7bit').toLowerCase().trim();
  if (enc === 'base64') {
    return decodeBuffer(Buffer.from(body.replace(/\s+/g, ''), 'base64'), charset);
  }
  if (enc === 'quoted-printable') {
    const qp = body
      .replace(/=\r?\n/g, '')
      .replace(/=([0-9A-Fa-f]{2})/g, (_m, h) => String.fromCharCode(parseInt(h, 16)));
    return decodeBuffer(Buffer.from(qp, 'binary'), charset);
  }
  return decodeBuffer(Buffer.from(body, 'binary'), charset);
}

function contentType(headers: Map<string, string>): { type: string; boundary?: string; charset?: string; name?: string } {
  const raw = headers.get('content-type') ?? 'text/plain';
  const type = raw.split(';')[0]!.trim().toLowerCase();
  const boundary = /boundary="?([^";]+)"?/i.exec(raw)?.[1];
  const charset = /charset="?([^";]+)"?/i.exec(raw)?.[1];
  const name = /name="?([^";]+)"?/i.exec(raw)?.[1];
  return { type, boundary, charset, name };
}

function isAttachment(headers: Map<string, string>): boolean {
  const disp = (headers.get('content-disposition') ?? '').toLowerCase();
  if (disp.startsWith('attachment')) return true;
  if (/filename=/i.test(disp)) return true;
  const ct = contentType(headers);
  if (ct.name && !ct.type.startsWith('text/')) return true;
  return false;
}

/** Bir multipart govdesini sinira gore parcalara boler. */
function splitParts(body: string, boundary: string): string[] {
  const marker = `--${boundary}`;
  const out: string[] = [];
  const lines = body.split(/\r?\n/);
  let cur: string[] | null = null;
  for (const ln of lines) {
    if (ln === marker || ln === `${marker}--`) {
      if (cur) out.push(cur.join('\r\n'));
      cur = ln === `${marker}--` ? null : [];
    } else if (cur) {
      cur.push(ln);
    }
  }
  return out;
}

interface Walked { text?: string; html?: string; hasAttachments: boolean }

function walk(headBlock: string, body: string, depth: number): Walked {
  const headers = parseHeaders(headBlock);
  const ct = contentType(headers);
  const result: Walked = { hasAttachments: false };
  if (depth > 8) return result;

  if (ct.type.startsWith('multipart/') && ct.boundary) {
    for (const part of splitParts(body, ct.boundary)) {
      const { head, body: pbody } = splitHeaderBody(part);
      const sub = walk(head, pbody, depth + 1);
      if (sub.text && !result.text) result.text = sub.text;
      if (sub.html && !result.html) result.html = sub.html;
      if (sub.hasAttachments) result.hasAttachments = true;
    }
    return result;
  }

  if (isAttachment(headers)) {
    result.hasAttachments = true;
    return result;
  }

  const cte = headers.get('content-transfer-encoding');
  if (ct.type === 'text/plain') {
    result.text = decodeCte(body, cte, ct.charset);
  } else if (ct.type === 'text/html') {
    result.html = decodeCte(body, cte, ct.charset);
  } else if (ct.type.startsWith('text/')) {
    result.text = decodeCte(body, cte, ct.charset);
  } else {
    // text disi tekil govde -> ektir.
    result.hasAttachments = true;
  }
  return result;
}

/** HTML'den kaba duz metin (yalnizca snippet/yedek icin; render icin degil). */
export function htmlToText(html: string): string {
  return html
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<\/(p|div|br|li|tr|h[1-6])>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ').replace(/&amp;/gi, '&').replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>').replace(/&quot;/gi, '"').replace(/&#39;/gi, "'")
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/** "Ad Soyad <a@b.c>" -> {name, addr}. */
export function parseAddress(raw?: string): { name?: string; addr?: string } {
  if (!raw) return {};
  const first = raw.split(',')[0]!.trim();
  const m = /^(.*?)<([^>]+)>\s*$/.exec(first);
  if (m?.[2]) {
    const name = decodeWords((m[1] ?? '').trim().replace(/^"|"$/g, '')).trim();
    return { name: name || undefined, addr: m[2].trim().toLowerCase() };
  }
  return { addr: first.replace(/[<>]/g, '').trim().toLowerCase() || undefined };
}

function parseAddressList(raw?: string): string[] {
  if (!raw) return [];
  return raw.split(',')
    .map((p) => parseAddress(p).addr)
    .filter((a): a is string => Boolean(a));
}

/** Ham iletiyi (baslik + govde) panelde gosterilebilir alanlara cozer. */
export function parseMail(raw: string): ParsedMail {
  const { head, body } = splitHeaderBody(raw);
  const headers = parseHeaders(head);
  const from = parseAddress(headers.get('from'));
  const walked = walk(head, body, 0);

  let bodyText = walked.text?.trim() || undefined;
  const bodyHtml = walked.html?.trim() || undefined;
  if (!bodyText && bodyHtml) bodyText = htmlToText(bodyHtml) || undefined;

  const dateRaw = headers.get('date');
  const date = dateRaw ? new Date(dateRaw) : undefined;

  return {
    messageId: headers.get('message-id')?.replace(/[<>]/g, '') || undefined,
    inReplyTo: headers.get('in-reply-to')?.replace(/[<>]/g, '') || undefined,
    subject: decodeWords(headers.get('subject')) || undefined,
    fromAddr: from.addr,
    fromName: from.name,
    toAddrs: parseAddressList(headers.get('to')),
    ccAddrs: parseAddressList(headers.get('cc')),
    date: date && !Number.isNaN(date.getTime()) ? date : undefined,
    bodyText,
    bodyHtml,
    hasAttachments: walked.hasAttachments,
  };
}

/** Liste onizlemesi icin kisa duz-metin (varsayilan 200 karakter). */
export function makeSnippet(text?: string, max = 200): string | undefined {
  if (!text) return undefined;
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length > max ? flat.slice(0, max - 1) + '…' : flat || undefined;
}
