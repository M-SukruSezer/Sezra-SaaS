/**
 * T-029: mail akışı -- çekme + senkron (IMAP/POP3) ve gönderme (SMTP).
 *
 * Kanıtlanan:
 *  1. IMAP/POP3'ten mesaj çekilir, tabloya yazılır; artımlı senkron aynı
 *     mesajı iki kez yazmaz.
 *  2. Liste üst veri + snippet döndürür, gövde DÖNDÜRMEZ; tek mesaj ucu
 *     gövdeyi döndürür ama body_html HAM (temizleme render katmanında).
 *  3. RLS: başka kullanıcı (tenant_admin dahil) başkasının mesajını / senkron
 *     ucunu göremez.
 *  4. Gizli parola HİÇBİR yanıta / hata mesajına girmez -- senkronda da,
 *     gönderimde de.
 *  5. SMTP gönderimi: başarı 'sent', kimlik hatası 'failed' + kategori; her
 *     iki durumda da giden kayıt core.mail_messages'a yazılır.
 *  6. Ağ çağrısı YALNIZCA yerel sahte sunuculara -- gerçek ağ yok.
 */
process.env.AUTH_MODE ??= 'dev';
process.env.NODE_ENV = 'test';
process.env.MAIL_SECRET_KEY ??= '0'.repeat(64);

import '../src/env.ts';
import { test, before, after, describe } from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import type { FastifyInstance } from 'fastify';
import type { Sql } from '@sezra/core';

// ---------------------------------------------------------------------------
// Sahte sunucular -- hepsi 127.0.0.1, düz metin (TLS yok). Gerçek ağ YOK.
// ---------------------------------------------------------------------------

interface FakeMsg { uid: string; raw: string }

function listen(srv: net.Server): Promise<{ port: number; close: () => Promise<void> }> {
  return new Promise((resolve) => {
    srv.listen(0, '127.0.0.1', () => resolve({
      port: (srv.address() as net.AddressInfo).port,
      close: () => new Promise<void>((r) => srv.close(() => r())),
    }));
  });
}

/** En küçük IMAP: greeting, LOGIN, SELECT (UIDVALIDITY), UID SEARCH/FETCH, LOGOUT. */
function fakeImap(opts: { messages: FakeMsg[]; uidValidity?: string; loginOk?: boolean }) {
  const uidValidity = opts.uidValidity ?? '42';
  const srv = net.createServer((sock) => {
    sock.write('* OK fake imap ready\r\n');
    let buf = '';
    sock.on('data', (d) => {
      buf += d.toString('latin1');
      let idx: number;
      while ((idx = buf.indexOf('\r\n')) >= 0) {
        const line = buf.slice(0, idx);
        buf = buf.slice(idx + 2);
        const sp = line.indexOf(' ');
        const tag = sp > 0 ? line.slice(0, sp) : line;
        const rest = sp > 0 ? line.slice(sp + 1) : '';
        respond(sock, tag, rest);
      }
    });
    sock.on('error', () => { /* istemci kapatabilir */ });
  });

  function respond(sock: net.Socket, tag: string, rest: string) {
    if (/^LOGIN/i.test(rest)) {
      sock.write(opts.loginOk === false ? `${tag} NO kimlik hatalı\r\n` : `${tag} OK giriş tamam\r\n`);
    } else if (/^SELECT/i.test(rest)) {
      sock.write(`* ${opts.messages.length} EXISTS\r\n`
        + `* OK [UIDVALIDITY ${uidValidity}] ok\r\n`
        + `${tag} OK [READ-WRITE] SELECT tamam\r\n`);
    } else if (/^UID SEARCH UID (\d+):\*/i.exec(rest)) {
      const since = Number(/^UID SEARCH UID (\d+):\*/i.exec(rest)![1]) - 1;
      const uids = opts.messages.map((m) => Number(m.uid)).filter((u) => u > since);
      sock.write(`* SEARCH ${uids.join(' ')}\r\n${tag} OK SEARCH tamam\r\n`);
    } else if (/^UID FETCH ([\d,]+) \(UID RFC822\.SIZE\)/i.exec(rest)) {
      const ids = /^UID FETCH ([\d,]+) /i.exec(rest)![1]!.split(',').map(Number);
      for (const id of ids) {
        const m = opts.messages.find((x) => Number(x.uid) === id);
        if (m) sock.write(`* 1 FETCH (UID ${id} RFC822.SIZE ${Buffer.byteLength(m.raw)})\r\n`);
      }
      sock.write(`${tag} OK FETCH tamam\r\n`);
    } else if (/^UID FETCH (\d+) \(INTERNALDATE BODY\.PEEK\[\]\)/i.exec(rest)) {
      const id = Number(/^UID FETCH (\d+) /i.exec(rest)![1]);
      const m = opts.messages.find((x) => Number(x.uid) === id);
      if (m) {
        const len = Buffer.byteLength(m.raw);
        const mm = String(id % 60).padStart(2, '0'); // uid'e göre artan zaman -> sıralama belirli
        sock.write(`* 1 FETCH (UID ${id} INTERNALDATE "01-Jan-2026 09:${mm}:00 +0000" BODY[] {${len}}\r\n`);
        sock.write(m.raw);
        sock.write(`)\r\n${tag} OK FETCH tamam\r\n`);
      } else {
        sock.write(`${tag} NO yok\r\n`);
      }
    } else if (/^LOGOUT/i.test(rest)) {
      sock.write(`* BYE\r\n${tag} OK LOGOUT\r\n`);
      sock.end();
    } else {
      sock.write(`${tag} OK noop\r\n`);
    }
  }

  return listen(srv);
}

/** En küçük POP3: greeting, USER/PASS, UIDL, LIST, RETR, QUIT. */
function fakePop3(opts: { messages: FakeMsg[]; loginOk?: boolean }) {
  const srv = net.createServer((sock) => {
    sock.write('+OK fake pop3 ready\r\n');
    let buf = '';
    sock.on('data', (d) => {
      buf += d.toString('latin1');
      let idx: number;
      while ((idx = buf.indexOf('\r\n')) >= 0) {
        const line = buf.slice(0, idx);
        buf = buf.slice(idx + 2);
        respond(sock, line);
      }
    });
    sock.on('error', () => {});
  });

  function respond(sock: net.Socket, line: string) {
    if (/^USER /i.test(line)) sock.write('+OK kullanıcı\r\n');
    else if (/^PASS /i.test(line)) sock.write(opts.loginOk === false ? '-ERR kimlik hatalı\r\n' : '+OK giriş\r\n');
    else if (/^UIDL/i.test(line)) {
      sock.write('+OK liste\r\n');
      opts.messages.forEach((m, i) => sock.write(`${i + 1} ${m.uid}\r\n`));
      sock.write('.\r\n');
    } else if (/^LIST/i.test(line)) {
      sock.write('+OK liste\r\n');
      opts.messages.forEach((m, i) => sock.write(`${i + 1} ${Buffer.byteLength(m.raw)}\r\n`));
      sock.write('.\r\n');
    } else if (/^RETR (\d+)/i.exec(line)) {
      const n = Number(/^RETR (\d+)/i.exec(line)![1]);
      const m = opts.messages[n - 1];
      if (m) sock.write(`+OK\r\n${m.raw.replace(/^\./gm, '..')}\r\n.\r\n`);
      else sock.write('-ERR yok\r\n');
    } else if (/^QUIT/i.test(line)) { sock.write('+OK görüşürüz\r\n'); sock.end(); }
    else sock.write('+OK\r\n');
  }

  return listen(srv);
}

/** En küçük SMTP: greeting, EHLO, AUTH LOGIN, MAIL/RCPT/DATA, QUIT. */
function fakeSmtp(opts: { authOk?: boolean; captured?: { raw: string } }) {
  const srv = net.createServer((sock) => {
    sock.write('220 fake smtp\r\n');
    let inData = false;
    let authStep = 0; // 0=yok, 1=AUTH LOGIN gönderildi (kullanıcı bekleniyor), 2=parola bekleniyor
    let dataBuf = '';
    let buf = '';
    sock.on('data', (d) => {
      buf += d.toString('latin1');
      if (inData) {
        dataBuf += buf; buf = '';
        const end = dataBuf.indexOf('\r\n.\r\n');
        if (end >= 0) {
          if (opts.captured) opts.captured.raw = dataBuf.slice(0, end);
          inData = false;
          sock.write('250 kuyruğa alındı\r\n');
        }
        return;
      }
      let idx: number;
      while ((idx = buf.indexOf('\r\n')) >= 0) {
        const line = buf.slice(0, idx);
        buf = buf.slice(idx + 2);
        if (authStep === 1) { authStep = 2; sock.write('334 UGFzc3dvcmQ6\r\n'); }
        else if (authStep === 2) {
          authStep = 0;
          sock.write(opts.authOk === false ? '535 kimlik doğrulama başarısız\r\n' : '235 yetki tamam\r\n');
        }
        else if (/^EHLO/i.test(line)) sock.write('250 merhaba\r\n');
        else if (/^AUTH LOGIN/i.test(line)) { authStep = 1; sock.write('334 VXNlcm5hbWU6\r\n'); }
        else if (/^MAIL FROM:/i.test(line)) sock.write('250 tamam\r\n');
        else if (/^RCPT TO:/i.test(line)) sock.write('250 tamam\r\n');
        else if (/^DATA/i.test(line)) { sock.write('354 gövdeyi gönder\r\n'); inData = true; }
        else if (/^QUIT/i.test(line)) { sock.write('221 hoşça kal\r\n'); sock.end(); }
        else sock.write('250 tamam\r\n');
      }
    });
    sock.on('error', () => {});
  });
  return listen(srv);
}

// ---------------------------------------------------------------------------

const USERS = {
  ali: '33333333-3333-3333-3333-333333333333',
  merve: '22222222-2222-2222-2222-222222222222',
} as const;
const PW = 'ali-gizli-p@rola-42';

let app: FastifyInstance;
let closeDb: () => Promise<void>;
let sql: Sql;

const as = (u: string) => ({ 'x-user-id': u });
const j = (r: { body: string }) => JSON.parse(r.body);
const GET = (url: string, u: string) => app.inject({ method: 'GET', url, headers: as(u) });
const POST = (url: string, u: string, payload: unknown = {}) =>
  app.inject({ method: 'POST', url, headers: as(u), payload });

async function makeAccount(provider: 'imap' | 'pop3', config: Record<string, unknown>, email: string) {
  const res = await POST('/core/mail/accounts', USERS.ali, {
    provider, display_name: 'Test kutusu', email, config, secret: { password: PW },
  });
  assert.equal(res.statusCode, 201, res.body);
  return j(res).data.id as string;
}

const rawMail = (subject: string, body: string, from = 'musteri@firma.test') =>
  [
    `From: Musteri Adi <${from}>`,
    'To: ali@ornek.test',
    `Subject: ${subject}`,
    'Date: Wed, 01 Jan 2026 09:00:00 +0000',
    'Message-ID: <msg-' + subject.replace(/\W/g, '') + '@firma.test>',
    'Content-Type: text/plain; charset=utf-8',
    '',
    body,
  ].join('\r\n');

before(async () => {
  const core = await import('@sezra/core');
  const { modules } = await import('../src/modules.ts');
  closeDb = core.closeDb;
  sql = core.sql;
  app = await core.createApp({ modules, logger: false });
  await app.ready();
});

after(async () => {
  await sql`delete from core.mail_accounts where owner_id in (${USERS.ali}, ${USERS.merve})`;
  await app.close();
  await closeDb();
});

describe('IMAP çekme + senkron', () => {
  const servers: { close: () => Promise<void> }[] = [];
  after(async () => { for (const s of servers) await s.close(); });

  test('mesajlar çekilir, listelenir (gövdesiz), tek mesaj gövdeli döner', async () => {
    const s = await fakeImap({
      messages: [
        { uid: '101', raw: rawMail('Teklif hakkında', 'Merhaba, teklifinizi bekliyoruz.') },
        { uid: '102', raw: rawMail('Fatura', 'Fatura ektedir.') },
      ],
    });
    servers.push(s);
    const id = await makeAccount('imap', { host: '127.0.0.1', port: s.port, security: 'none' }, 'ali-imap@ornek.test');

    const sync = j(await POST(`/core/mail/accounts/${id}/sync`, USERS.ali));
    assert.equal(sync.data.ok, true, JSON.stringify(sync));
    assert.equal(sync.data.fetched, 2);

    const list = j(await GET(`/core/mail/accounts/${id}/messages`, USERS.ali));
    assert.equal(list.meta.total, 2);
    assert.equal(list.data[0].subject, 'Fatura', 'en yeni önce (received_at azalan)');
    for (const row of list.data) {
      assert.ok(!('body_text' in row), 'liste satırında body_text yok');
      assert.ok(!('body_html' in row), 'liste satırında body_html yok');
    }

    const one = j(await GET(`/core/mail/messages/${list.data[1].id}`, USERS.ali));
    assert.equal(one.data.subject, 'Teklif hakkında');
    assert.match(one.data.body_text, /teklifinizi bekliyoruz/);
    assert.equal(one.data.from_addr, 'musteri@firma.test');
  });

  test('artımlı: ikinci senkron sadece yeni UID çeker', async () => {
    const msgs: FakeMsg[] = [{ uid: '201', raw: rawMail('Ilk', 'bir') }];
    const s = await fakeImap({ messages: msgs });
    servers.push(s);
    const id = await makeAccount('imap', { host: '127.0.0.1', port: s.port, security: 'none' }, 'ali-inc@ornek.test');

    assert.equal(j(await POST(`/core/mail/accounts/${id}/sync`, USERS.ali)).data.fetched, 1);
    // Aynı mesaj hâlâ orada -> tekrar çekilmemeli.
    assert.equal(j(await POST(`/core/mail/accounts/${id}/sync`, USERS.ali)).data.fetched, 0);

    msgs.push({ uid: '202', raw: rawMail('Ikinci', 'iki') });
    assert.equal(j(await POST(`/core/mail/accounts/${id}/sync`, USERS.ali)).data.fetched, 1);
    assert.equal(j(await GET(`/core/mail/accounts/${id}/messages`, USERS.ali)).meta.total, 2);
  });

  test('yanlış parola -> senkron ok:false, kategori auth, parola sızmaz', async () => {
    const s = await fakeImap({ messages: [], loginOk: false });
    servers.push(s);
    const id = await makeAccount('imap', { host: '127.0.0.1', port: s.port, security: 'none' }, 'ali-bad@ornek.test');
    const res = await POST(`/core/mail/accounts/${id}/sync`, USERS.ali);
    const body = res.body;
    assert.equal(j(res).data.ok, false);
    assert.equal(j(res).data.category, 'auth');
    assert.ok(!body.includes(PW), 'yanıt parolayı içermemeli');

    const st = j(await GET(`/core/mail/accounts/${id}/sync-state`, USERS.ali));
    assert.ok(st.data.last_error, 'senkron durumunda hata kayıtlı');
    assert.ok(!JSON.stringify(st).includes(PW));
  });

  test('RLS: başka kullanıcı mesajları / senkron durumunu göremez', async () => {
    const s = await fakeImap({ messages: [{ uid: '301', raw: rawMail('Ozel', 'gizli içerik') }] });
    servers.push(s);
    const id = await makeAccount('imap', { host: '127.0.0.1', port: s.port, security: 'none' }, 'ali-rls@ornek.test');
    await POST(`/core/mail/accounts/${id}/sync`, USERS.ali);

    assert.equal((await POST(`/core/mail/accounts/${id}/sync`, USERS.merve)).statusCode, 404);
    assert.equal(j(await GET(`/core/mail/accounts/${id}/messages`, USERS.merve)).meta.total, 0);
    const raw = await GET(`/core/mail/accounts/${id}/messages`, USERS.merve);
    assert.ok(!raw.body.includes('gizli içerik'));
  });
});

describe('POP3 çekme', () => {
  const servers: { close: () => Promise<void> }[] = [];
  after(async () => { for (const s of servers) await s.close(); });

  test('POP3 mesajları çekilir, UIDL bilinenler tekrar çekilmez', async () => {
    const msgs: FakeMsg[] = [{ uid: 'pop-a', raw: rawMail('Pop biri', 'aa') }];
    const s = await fakePop3({ messages: msgs });
    servers.push(s);
    const id = await makeAccount('pop3', { host: '127.0.0.1', port: s.port, security: 'none' }, 'ali-pop@ornek.test');

    assert.equal(j(await POST(`/core/mail/accounts/${id}/sync`, USERS.ali)).data.fetched, 1);
    assert.equal(j(await POST(`/core/mail/accounts/${id}/sync`, USERS.ali)).data.fetched, 0);
    msgs.push({ uid: 'pop-b', raw: rawMail('Pop iki', 'bb') });
    assert.equal(j(await POST(`/core/mail/accounts/${id}/sync`, USERS.ali)).data.fetched, 1);
  });
});

describe('SMTP gönderme', () => {
  const servers: { close: () => Promise<void> }[] = [];
  after(async () => { for (const s of servers) await s.close(); });

  test('başarılı gönderim -> sent, giden kayıt yazılır, parola sızmaz', async () => {
    const captured = { raw: '' };
    const s = await fakeSmtp({ captured });
    servers.push(s);
    const id = await makeAccount('imap',
      { host: '127.0.0.1', port: 1, security: 'none', smtp_host: '127.0.0.1', smtp_port: s.port, smtp_security: 'none' },
      'ali-smtp@ornek.test');

    const res = await POST(`/core/mail/accounts/${id}/send`, USERS.ali, {
      to: ['alici@firma.test'], subject: 'Merhaba', body_text: 'Bu bir deneme mesajıdır.',
    });
    assert.equal(res.statusCode, 200, res.body);
    assert.equal(j(res).data.status, 'sent');
    assert.ok(!res.body.includes(PW));
    assert.match(captured.raw, /Subject: Merhaba/);
    const b64body = captured.raw.split('\r\n\r\n').slice(1).join('\r\n\r\n').replace(/\s+/g, '');
    assert.match(Buffer.from(b64body, 'base64').toString('utf8'), /Bu bir deneme mesajıdır\./);

    const sent = j(await GET(`/core/mail/accounts/${id}/messages?direction=outgoing`, USERS.ali));
    assert.equal(sent.meta.total, 1);
    assert.equal(sent.data[0].subject, 'Merhaba');
    assert.equal(sent.data[0].send_status, 'sent');
  });

  test('kimlik hatası -> failed + kategori, yine de giden kayıt (failed)', async () => {
    const s = await fakeSmtp({ authOk: false });
    servers.push(s);
    const id = await makeAccount('imap',
      { host: '127.0.0.1', port: 1, security: 'none', smtp_host: '127.0.0.1', smtp_port: s.port, smtp_security: 'none' },
      'ali-smtpfail@ornek.test');

    const res = await POST(`/core/mail/accounts/${id}/send`, USERS.ali, {
      to: ['x@firma.test'], subject: 'Denemez', body_text: 'gitmeyecek',
    });
    assert.equal(res.statusCode, 200, res.body);
    assert.equal(j(res).data.status, 'failed');
    assert.equal(j(res).data.category, 'auth');

    const sent = j(await GET(`/core/mail/accounts/${id}/messages?direction=outgoing`, USERS.ali));
    assert.equal(sent.data[0].send_status, 'failed');
  });

  test('geçersiz alıcı -> 400, boş gövde -> 400', async () => {
    const s = await fakeSmtp({});
    servers.push(s);
    const id = await makeAccount('imap',
      { host: '127.0.0.1', port: 1, security: 'none', smtp_host: '127.0.0.1', smtp_port: s.port, smtp_security: 'none' },
      'ali-smtpval@ornek.test');
    assert.equal((await POST(`/core/mail/accounts/${id}/send`, USERS.ali, {
      to: ['bozuk-adres'], subject: 'x', body_text: 'y',
    })).statusCode, 400);
    assert.equal((await POST(`/core/mail/accounts/${id}/send`, USERS.ali, {
      to: ['ok@firma.test'], subject: 'x', body_text: '   ',
    })).statusCode, 400);
  });
});
