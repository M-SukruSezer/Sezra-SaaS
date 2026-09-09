/**
 * T-025: bağlı mail hesabı -- HTTP + şifreleme.
 *
 * Kanıtlanan:
 *  1. Gizli kimlik bilgisi (parola/token) HİÇBİR okuma yanıtında dönmez.
 *  2. Veritabanında saklanan değer DÜZ METİN DEĞİL; şifreli blob, ve doğru
 *     anahtarla geri çözülüyor. Yanlış anahtar / kurcalama tespit ediliyor.
 *  3. RLS: bir kullanıcı yalnızca kendi hesaplarını görür/siler; tenant_admin
 *     bile başkasının satırına dokunamaz.
 *  4. Denetim izinde parola / cipher yok.
 *
 * KAPSAM: yalnızca bağlantı kurulumu. Posta çekme/gönderme yok.
 */
process.env.AUTH_MODE ??= 'dev';
process.env.NODE_ENV = 'test';
// Şifreleme anahtarı testte sabit ve SAHTE. Gerçek anahtar repoda yok.
process.env.MAIL_SECRET_KEY ??= '0'.repeat(64);

import '../src/env.ts';
import { test, before, after, describe } from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import type { FastifyInstance } from 'fastify';
import type { Sql } from '@sezra/core';

/** Sahte, düz metin IMAP sunucusu -- STARTTLS/LOGIN'e sabit yanıt verir. */
function fakeImap(loginOk: boolean): Promise<{ port: number; close: () => Promise<void> }> {
  return new Promise((resolve) => {
    const srv = net.createServer((sock) => {
      sock.write('* OK fake imap ready\r\n');
      sock.on('data', (d) => {
        const line = d.toString();
        if (/STARTTLS/i.test(line)) sock.write('S1 NO STARTTLS yok\r\n');
        else if (/LOGIN/i.test(line)) sock.write(loginOk ? 'A1 OK giris tamam\r\n' : 'A1 NO kimlik hatali\r\n');
        else if (/LOGOUT/i.test(line)) { sock.write('A9 OK gorusuruz\r\n'); sock.end(); }
      });
      sock.on('error', () => { /* istemci soketi kapatabilir */ });
    });
    srv.listen(0, '127.0.0.1', () => resolve({
      port: (srv.address() as net.AddressInfo).port,
      close: () => new Promise<void>((r) => srv.close(() => r())),
    }));
  });
}

const USERS = {
  ali:   '33333333-3333-3333-3333-333333333333', // ornek üyesi (sahip)
  merve: '22222222-2222-2222-2222-222222222222', // ornek tenant_admin (başkası)
  deniz: '44444444-4444-4444-4444-444444444444', // ornek üyesi (başkası)
} as const;
const PAROLA = 'sup3r-s3cret-p@ss-ali';

let app: FastifyInstance;
let closeDb: () => Promise<void>;
let sql: Sql;
let core: typeof import('@sezra/core');

const as = (user: string) => ({ 'x-user-id': user });
const json = (res: { body: string }) => JSON.parse(res.body);
const get = (url: string, user: string) =>
  app.inject({ method: 'GET', url, headers: as(user) });
const post = (url: string, user: string, payload: unknown = {}) =>
  app.inject({ method: 'POST', url, headers: as(user), payload });
const del = (url: string, user: string) =>
  app.inject({ method: 'DELETE', url, headers: as(user) });

before(async () => {
  core = await import('@sezra/core');
  const { modules } = await import('../src/modules.ts');
  closeDb = core.closeDb;
  sql = core.sql;
  app = await core.createApp({ modules, logger: false });
  await app.ready();
});

after(async () => {
  await sql`delete from core.mail_accounts where owner_id in (${USERS.ali}, ${USERS.merve}, ${USERS.deniz})`;
  await app.close();
  await closeDb();
});

describe('bağlı mail hesabı (HTTP + şifreleme)', () => {
  let accId = '';

  test('şifreleme yardımcıları: gidiş-dönüş, kurcalama, kurcalanmış anahtar', () => {
    assert.equal(core.isSecretStoreConfigured(), true);
    const c = core.encryptSecret({ password: PAROLA });
    assert.ok(c.startsWith('v1:'), 'blob v1: ile başlamalı');
    assert.ok(!c.includes(PAROLA), 'blob düz parolayı içermemeli');
    assert.deepEqual(core.decryptSecret(c), { password: PAROLA });
    // Kurcalanmış ciphertext -> çözüm hatası.
    assert.throws(() => core.decryptSecret(c.slice(0, -4) + 'AAAA'));
  });

  test('IMAP hesabı eklenir (201), gizli girdi yanıtta yok', async () => {
    const res = await post('/core/mail/accounts', USERS.ali, {
      provider: 'imap',
      display_name: 'Is e-postam',
      email: 'ali@ornek.test',
      config: { host: 'imap.ornek.test', security: 'ssl', username: 'ali@ornek.test' },
      secret: { password: PAROLA },
    });
    assert.equal(res.statusCode, 201, res.body);
    accId = json(res).data.id;
    assert.ok(accId);
    assert.ok(!res.body.includes(PAROLA), 'kaydetme yanıtı parolayı yansıtmamalı');
  });

  test('liste: gizli alan yok, has_secret true, port türetildi', async () => {
    const rows = json(await get('/core/mail/accounts', USERS.ali)).data as Record<string, unknown>[];
    assert.equal(rows.length, 1);
    const r = rows[0]!;
    assert.equal(r.has_secret, true);
    assert.equal(r.status, 'pending');
    assert.equal((r.config as { port: number }).port, 993, 'ssl -> 993');
    for (const bad of ['secret_cipher', 'password', 'secret', 'access_token', 'refresh_token']) {
      assert.ok(!(bad in r), `liste satırında "${bad}" olmamalı`);
    }
    const raw = await get('/core/mail/accounts', USERS.ali);
    assert.ok(!raw.body.includes(PAROLA), 'liste gövdesi parolayı içermemeli');
  });

  test('veritabanında saklanan değer şifreli, düz metin değil', async () => {
    const [row] = await sql<{ secret_cipher: string }[]>`
      select secret_cipher from core.mail_accounts where id = ${accId}`;
    assert.ok(row, 'satır DB’de olmalı');
    assert.ok(row.secret_cipher.startsWith('v1:'), 'şifreli blob biçiminde');
    assert.ok(!row.secret_cipher.includes(PAROLA), 'DB’de düz parola YOK');
    assert.deepEqual(core.decryptSecret(row.secret_cipher), { password: PAROLA },
      'doğru anahtarla geri çözülür');
  });

  test('denetim izinde parola / cipher yok', async () => {
    const rows = await sql<{ old_data: unknown; new_data: unknown }[]>`
      select old_data, new_data from core.audit_log where entity_table = 'mail_accounts'`;
    assert.ok(rows.length >= 1);
    for (const r of rows) {
      const blob = JSON.stringify(r.old_data) + JSON.stringify(r.new_data);
      assert.ok(!blob.includes(PAROLA), 'audit’te düz parola yok');
      assert.ok(!blob.includes('v1:'), 'audit’te cipher blob yok');
      assert.ok(!blob.includes('secret_cipher'), 'audit’te secret_cipher anahtarı yok');
    }
  });

  test('RLS: tenant_admin başkasının hesabını göremez / silemez', async () => {
    assert.equal(json(await get('/core/mail/accounts', USERS.merve)).data.length, 0);
    assert.equal(json(await get('/core/mail/accounts', USERS.deniz)).data.length, 0);
    assert.equal((await del(`/core/mail/accounts/${accId}`, USERS.merve)).statusCode, 404);
    // Ali'nin hesabı hâlâ duruyor.
    assert.equal(json(await get('/core/mail/accounts', USERS.ali)).data.length, 1);
  });

  test('parola tekrar verilmeden düzenleme mevcut gizliyi korur', async () => {
    const res = await post('/core/mail/accounts', USERS.ali, {
      id: accId, provider: 'imap', display_name: 'Yeni etiket', email: 'ali@ornek.test',
      config: { host: 'imap.ornek.test', security: 'ssl' },
    });
    assert.equal(res.statusCode, 200, res.body);
    const [row] = await sql<{ secret_cipher: string }[]>`
      select secret_cipher from core.mail_accounts where id = ${accId}`;
    assert.deepEqual(core.decryptSecret(row!.secret_cipher), { password: PAROLA });
    assert.equal(json(await get('/core/mail/accounts', USERS.ali)).data[0].display_name, 'Yeni etiket');
  });

  test('IMAP parolasız yeni hesap 400', async () => {
    const res = await post('/core/mail/accounts', USERS.ali, {
      provider: 'imap', display_name: 'X', email: 'x@ornek.test',
      config: { host: 'imap.x.test' },
    });
    assert.equal(res.statusCode, 400, res.body);
  });

  test('sağlayıcı listesi: imap/pop3 yapılandırılmış, graph/gmail değil', async () => {
    const r = json(await get('/core/mail/providers', USERS.ali));
    const byCode = Object.fromEntries((r.data as { code: string; configured: boolean }[])
      .map((p) => [p.code, p.configured]));
    assert.equal(byCode.imap, true);
    assert.equal(byCode.pop3, true);
    assert.equal(byCode.ms_graph, false);
    assert.equal(byCode.gmail, false);
    assert.equal(r.meta.secret_store, true);
  });

  test('sahip siler (204), liste boşalır', async () => {
    assert.equal((await del(`/core/mail/accounts/${accId}`, USERS.ali)).statusCode, 204);
    assert.equal(json(await get('/core/mail/accounts', USERS.ali)).data.length, 0);
  });
});

// ===========================================================================
// Adım 2: IMAP/POP3 bağlantı doğrulama
// ===========================================================================
describe('bağlantıyı test et (IMAP/POP3)', () => {
  let servers: { close: () => Promise<void> }[] = [];
  let seq = 0;

  const mkAccount = async (config: Record<string, unknown>) => {
    const res = await post('/core/mail/accounts', USERS.ali, {
      provider: 'imap', display_name: 'test', email: `ali+v${++seq}@ornek.test`,
      config, secret: { password: 'pw' },
    });
    assert.equal(res.statusCode, 201, res.body);
    return json(res).data.id as string;
  };
  const verify = (id: string) => post(`/core/mail/accounts/${id}/verify`, USERS.ali);

  after(async () => {
    for (const s of servers) await s.close();
    await sql`delete from core.mail_accounts where owner_id = ${USERS.ali}`;
  });

  test('doğru kimlik bilgisi -> verified, last_verified_at dolar', async () => {
    const s = await fakeImap(true); servers.push(s);
    const id = await mkAccount({ host: '127.0.0.1', port: s.port, security: 'none' });
    const r = json(await verify(id));
    assert.equal(r.data.status, 'verified');
    const row = json(await get('/core/mail/accounts', USERS.ali)).data.find((x: { id: string }) => x.id === id);
    assert.equal(row.status, 'verified');
    assert.ok(row.last_verified_at, 'last_verified_at set');
  });

  test('yanlış parola -> error/auth, detay parolayı işaret eder', async () => {
    const s = await fakeImap(false); servers.push(s);
    const id = await mkAccount({ host: '127.0.0.1', port: s.port, security: 'none' });
    const r = json(await verify(id));
    assert.equal(r.data.status, 'error');
    assert.equal(r.data.category, 'auth');
    assert.match(r.data.detail, /parola/i);
  });

  test('kapalı port -> error/network', async () => {
    const s = await fakeImap(true);
    const closedPort = (await new Promise<number>((res) => {
      const t = net.createServer();
      t.listen(0, '127.0.0.1', () => { const p = (t.address() as net.AddressInfo).port; t.close(() => res(p)); });
    }));
    await s.close();
    const id = await mkAccount({ host: '127.0.0.1', port: closedPort, security: 'none' });
    const r = json(await verify(id));
    assert.equal(r.data.status, 'error');
    assert.equal(r.data.category, 'network');
  });

  test('düz sunucuya SSL ile bağlanma -> error/tls', async () => {
    const s = await fakeImap(true); servers.push(s);
    const id = await mkAccount({ host: '127.0.0.1', port: s.port, security: 'ssl' });
    const r = json(await verify(id));
    assert.equal(r.data.status, 'error');
    assert.equal(r.data.category, 'tls');
  });

  test('parola yokken verify -> 400', async () => {
    // Gizli olmadan hesap: önce gizliyi sil.
    const s = await fakeImap(true); servers.push(s);
    const id = await mkAccount({ host: '127.0.0.1', port: s.port, security: 'none' });
    await post('/core/mail/accounts', USERS.ali, {
      id, provider: 'imap', display_name: 'test', email: 'ali@ornek.test',
      config: { host: '127.0.0.1', port: s.port, security: 'none' }, secret: { clear: true },
    });
    assert.equal((await verify(id)).statusCode, 400);
  });

  test('olmayan hesap -> 404, OAuth sağlayıcı -> 400', async () => {
    assert.equal((await verify('00000000-0000-0000-0000-000000000000')).statusCode, 404);
    const gid = await post('/core/mail/accounts', USERS.ali, {
      provider: 'gmail', display_name: 'g', email: 'ali@gmail.test', config: {},
    });
    assert.equal((await verify(json(gid).data.id)).statusCode, 400);
  });

  test('verify yanıtında gizli yok', async () => {
    const s = await fakeImap(true); servers.push(s);
    const id = await mkAccount({ host: '127.0.0.1', port: s.port, security: 'none' });
    const raw = await verify(id);
    assert.ok(!raw.body.includes('pw"'), 'yanıt gövdesinde parola yok');
    assert.ok(!raw.body.includes('secret'), 'yanıt gövdesinde secret alanı yok');
  });
});
