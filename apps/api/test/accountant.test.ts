/**
 * T-024: Mali müşavir erişimi uçları (HTTP).
 *
 * Veri katmanı (migration 1150) ve RLS salt-okunurluğu supabase/tests/
 * 15_accountant_access.sql'de kanıtlanır. Bu dosya HTTP yüzeyini doğrular:
 *   - kiracı yöneticisi müşaviri davet eder; ikinci davet 409 (tenant başına 1)
 *   - müşavir kendi panelinden daveti görür ve kabul eder
 *   - kabulden sonra `x-accountant-mode: on` + `x-tenant-id` ile kiracının
 *     faturalarını/hesaplarını OKUR ama yazamaz (POST -> 403)
 *   - iptalden sonra erişim biter
 *
 * Dosya adı alfabetik olarak ilk sırada koşar; sonda oluşturduğu grant'i
 * silerek diğer testlerin beklediği durumu bozmaz.
 */
process.env.AUTH_MODE ??= 'dev';
process.env.NODE_ENV = 'test';

import '../src/env.ts';
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import type { FastifyInstance } from 'fastify';
import type { Sql } from '@sezra/core';

const USERS = {
  merve: '22222222-2222-2222-2222-222222222222', // ornek-ticaret yöneticisi
  rakip: '55555555-5555-5555-5555-555555555555', // yalnızca rakip-ticaret üyesi -> MÜŞAVIR
} as const;

const ACCT_EMAIL = 'admin@rakipticaret.test';

let app: FastifyInstance;
let closeDb: () => Promise<void>;
let sql: Sql;
let ornekId: string;

const as = (user: string, extra: Record<string, string> = {}) => ({ 'x-user-id': user, ...extra });
const acct = { 'x-accountant-mode': 'on' } as Record<string, string>;
const json = (res: { body: string }) => JSON.parse(res.body);

before(async () => {
  const core = await import('@sezra/core');
  const { modules } = await import('../src/modules.ts');
  closeDb = core.closeDb;
  sql = core.sql;
  app = await core.createApp({ modules, logger: false });
  await app.ready();
  const [t] = await sql<{ id: string }[]>`select id from core.tenants where slug = 'ornek-ticaret'`;
  ornekId = t!.id;
  await sql`delete from core.accountant_grants where tenant_id = ${ornekId}`;
});

after(async () => {
  await sql`delete from core.accountant_grants where tenant_id = ${ornekId}`;
  await app.close();
  await closeDb();
});

let token = '';
let grantId = '';

test('kiracı yöneticisi müşaviri davet eder', async () => {
  const res = await app.inject({
    method: 'POST', url: '/core/accountant/invite',
    headers: as(USERS.merve, { 'x-tenant-id': ornekId }),
    payload: { email: ACCT_EMAIL, full_name: 'Mali Müşavir' },
  });
  assert.equal(res.statusCode, 201);
  const row = json(res).data;
  assert.ok(row.invite_token && row.invite_token.length > 20);
  token = row.invite_token;
  grantId = row.id;
});

test('ikinci davet 409 ile reddedilir (tenant başına en fazla 1)', async () => {
  const res = await app.inject({
    method: 'POST', url: '/core/accountant/invite',
    headers: as(USERS.merve, { 'x-tenant-id': ornekId }),
    payload: { email: 'baska@buro.test' },
  });
  assert.equal(res.statusCode, 409);
});

test('yetkisiz kullanıcı müşavir davet edemez', async () => {
  const res = await app.inject({
    method: 'POST', url: '/core/accountant/invite',
    headers: as(USERS.rakip, { 'x-tenant-id': ornekId }),
    payload: { email: 'x@y.test' },
  });
  // rakip'in ornek-ticaret'te üyeliği yok -> aktif kiracı yok -> 403
  assert.equal(res.statusCode, 403);
});

test('müşavir bekleyen daveti panelinden görür', async () => {
  const res = await app.inject({ method: 'GET', url: '/accountant/invites', headers: as(USERS.rakip) });
  assert.equal(res.statusCode, 200);
  const rows = json(res).data as Array<{ token: string; tenant_id: string }>;
  assert.ok(rows.some((r) => r.token === token && r.tenant_id === ornekId));
});

test('müşavir daveti kabul eder', async () => {
  const res = await app.inject({
    method: 'POST', url: '/accountant/invites/accept',
    headers: as(USERS.rakip), payload: { token },
  });
  assert.equal(res.statusCode, 200);
  assert.equal(json(res).data.tenant_id, ornekId);
});

test('/me müşavir oturumunu ve erişilen kiracıyı bildirir', async () => {
  const res = await app.inject({
    method: 'GET', url: '/me',
    headers: as(USERS.rakip, { 'x-tenant-id': ornekId, ...acct }),
  });
  assert.equal(res.statusCode, 200);
  const me = json(res);
  assert.equal(me.accountant_session, true);
  assert.equal(me.tenant?.id, ornekId);
});

test('müşavir kiracının hesap planını OKUYABİLİR', async () => {
  const res = await app.inject({
    method: 'GET', url: '/finance/accounts?limit=5',
    headers: as(USERS.rakip, { 'x-tenant-id': ornekId, ...acct }),
  });
  assert.equal(res.statusCode, 200);
  assert.ok(json(res).data.length > 0);
});

test('müşavir YAZAMAZ (POST -> 403, RLS seviyesinde)', async () => {
  const res = await app.inject({
    method: 'POST', url: '/finance/accounts',
    headers: as(USERS.rakip, { 'x-tenant-id': ornekId, ...acct }),
    payload: { code: '999.HACK', name: 'sahte', type: 'asset' },
  });
  assert.equal(res.statusCode, 403);
});

test('accountant_mode olmadan müşavir kiracı verisini göremez', async () => {
  const res = await app.inject({
    method: 'GET', url: '/finance/accounts?limit=5',
    headers: as(USERS.rakip, { 'x-tenant-id': ornekId }),
  });
  // Üyeliği yok -> aktif kiracı yok -> liste boş ya da yetki hatası; veri sızmaz.
  if (res.statusCode === 200) assert.equal(json(res).data.length, 0);
});

test('accountant_tenants panel listesi ornek-ticaret kaydini icerir', async () => {
  const res = await app.inject({ method: 'GET', url: '/accountant/tenants', headers: as(USERS.rakip) });
  assert.equal(res.statusCode, 200);
  const rows = json(res).data as Array<{ tenant_id: string }>;
  assert.ok(rows.some((r) => r.tenant_id === ornekId));
});

test('kiracı yöneticisi erişimi iptal eder; müşavir oturumu kapanır', async () => {
  const del = await app.inject({
    method: 'DELETE', url: `/core/accountant/${grantId}`,
    headers: as(USERS.merve, { 'x-tenant-id': ornekId }),
  });
  assert.equal(del.statusCode, 200);

  const me = await app.inject({
    method: 'GET', url: '/me',
    headers: as(USERS.rakip, { 'x-tenant-id': ornekId, ...acct }),
  });
  assert.equal(json(me).accountant_session, false);
});
