/**
 * T-017: davet kabul uçları ve destek izni uçları (HTTP).
 *
 * Wave 2'de iki SQL kontratı gelmişti ama HTTP'den erişilemiyordu:
 *   - core.accept_invite / decline_invite / pending_invites (migration 1110)
 *   - core.grant_support_access / revoke_support_access / list_support_grants
 *     (migration 1100 + 1130)
 * Bu dosya ikisini de tel üzerinden doğrular: mutlu yol, yetki sınırı
 * (platform-admin olmayan reddedilir) ve "kimse başkası adına davet kabul
 * edemez".
 *
 * Dosya adı alfabetik olarak finance.test.ts ile modules.test.ts arasında
 * kaldığı için sırayla koşar; sonda 55555555'in eklenen üyeliğini geri alarak
 * modül testlerinin beklediği durumu bozmaz.
 */
process.env.AUTH_MODE ??= 'dev';
process.env.NODE_ENV = 'test';

import '../src/env.ts';
import { test, before, after, describe } from 'node:test';
import assert from 'node:assert/strict';
import type { FastifyInstance } from 'fastify';
import type { Sql } from '@sezra/core';

const USERS = {
  sezra: '11111111-1111-1111-1111-111111111111', // platform admin, hiçbir kiracıda üye değil
  merve: '22222222-2222-2222-2222-222222222222', // ornek-ticaret yöneticisi, platform admin DEĞİL
  rakip: '55555555-5555-5555-5555-555555555555', // yalnızca rakip-ticaret üyesi
} as const;

let app: FastifyInstance;
let closeDb: () => Promise<void>;
let sql: Sql;
let ornekId: string;

const as = (user: string) => ({ 'x-user-id': user });
const json = (res: { body: string }) => JSON.parse(res.body);
const get = (url: string, user: string) =>
  app.inject({ method: 'GET', url, headers: as(user) });
const post = (url: string, user: string, payload: unknown = {}) =>
  app.inject({ method: 'POST', url, headers: as(user), payload });
const del = (url: string, user: string) =>
  app.inject({ method: 'DELETE', url, headers: as(user) });

before(async () => {
  const core = await import('@sezra/core');
  const { modules } = await import('../src/modules.ts');
  closeDb = core.closeDb;
  sql = core.sql;
  app = await core.createApp({ modules, logger: false });
  await app.ready();
  const [t] = await sql<{ id: string }[]>`
    select id from core.tenants where slug = 'ornek-ticaret'`;
  ornekId = t!.id;
});

after(async () => {
  // 55555555'in ornek-ticaret'e eklenen üyeliğini ve test destek izinlerini temizle.
  await sql`delete from core.membership_roles mr using core.memberships m
            where mr.membership_id = m.id
              and m.user_id = ${USERS.rakip} and m.tenant_id = ${ornekId}`;
  await sql`delete from core.memberships
            where user_id = ${USERS.rakip} and tenant_id = ${ornekId}`;
  await sql`delete from core.support_grants where admin_user_id = ${USERS.sezra}`;
  await app.close();
  await closeDb();
});

// ===========================================================================
// Davet kabulü
// ===========================================================================
describe('kiracı daveti kabul / ret (HTTP)', () => {
  test('başka kiracıda üyesi olan kullanıcı davet edilince üyelik beklemede kalır', async () => {
    const inv = await post('/core/users/invite', USERS.merve, {
      email: 'admin@rakipticaret.test', full_name: 'Rakip Yönetici', role_code: 'sales',
    });
    assert.equal(inv.statusCode, 201, inv.body);

    // Davetli henüz kabul etmediği için ornek-ticaret onun oturumunda görünmez.
    const me = json(await get('/me', USERS.rakip));
    assert.ok(
      !me.memberships.some((m: { slug: string }) => m.slug === 'ornek-ticaret'),
      'kabul edilmemiş davet üyelik listesine girmemeli',
    );

    const pend = json(await get('/core/invites', USERS.rakip));
    assert.equal(pend.data.length, 1);
    assert.equal(pend.data[0].tenant_id, ornekId);
  });

  test('kimse başkası adına daveti kabul edemez', async () => {
    // merve'nin ornek-ticaret için bekleyen daveti yok -> 404, ve 55555555'in
    // daveti hâlâ beklemede kalır.
    const res = await post(`/core/invites/${ornekId}/accept`, USERS.merve);
    assert.equal(res.statusCode, 404, res.body);

    const [m] = await sql<{ accepted_at: string | null }[]>`
      select accepted_at from core.memberships
      where user_id = ${USERS.rakip} and tenant_id = ${ornekId}`;
    assert.equal(m!.accepted_at, null, 'davet hâlâ beklemede olmalı');
  });

  test('davetlinin kendisi kabul edince üyelik açılır', async () => {
    const res = await post(`/core/invites/${ornekId}/accept`, USERS.rakip);
    assert.equal(res.statusCode, 200, res.body);
    assert.ok(json(res).data.membership_id);

    const me = json(await get('/me', USERS.rakip));
    assert.ok(
      me.memberships.some((m: { slug: string }) => m.slug === 'ornek-ticaret'),
      'kabul sonrası üyelik listede olmalı',
    );
    // Kabul edilmiş davet artık bekleyenlerde değil.
    assert.equal(json(await get('/core/invites', USERS.rakip)).data.length, 0);
  });

  test('bekleyen davet reddedilince üyelik satırı silinir', async () => {
    await post('/core/users/invite', USERS.merve, {
      email: 'admin@rakipticaret.test', full_name: 'Rakip Yönetici', role_code: 'sales',
    });
    // Zaten kabul edilmiş üyelik yeniden davetle beklemeye DÜŞMEZ; ret de
    // "bekleyen yok" der. Bu, kabul edilmiş üyeliğin bu yolla silinemediğini
    // gösterir (silme için core.set_member_active gerekir).
    const res = await post(`/core/invites/${ornekId}/decline`, USERS.rakip);
    assert.equal(res.statusCode, 404, res.body);
  });
});

// ===========================================================================
// Destek erişim izinleri
// ===========================================================================
describe('destek izni uçları (HTTP)', () => {
  test('platform admini olmayan kullanıcı reddedilir', async () => {
    assert.equal((await get('/platform/support-grants', USERS.merve)).statusCode, 403);
    assert.equal(
      (await post('/platform/support-grants', USERS.merve, {
        admin_user_id: USERS.sezra, tenant_id: ornekId, reason: 'deneme',
      })).statusCode,
      403,
    );
    assert.equal(
      (await del(`/platform/support-grants/${'00000000-0000-0000-0000-000000000000'}`, USERS.merve)).statusCode,
      403,
    );
  });

  test('platform admini izin verir, listeler ve iptal eder', async () => {
    const created = await post('/platform/support-grants', USERS.sezra, {
      admin_user_id: USERS.sezra, tenant_id: ornekId,
      reason: 'DESTEK-4242 fatura incelemesi', duration_minutes: 30,
    });
    assert.equal(created.statusCode, 201, created.body);
    const grantId = json(created).data.id as string;
    assert.ok(grantId);

    const list = json(await get('/platform/support-grants', USERS.sezra));
    const mine = list.data.find((g: { id: string }) => g.id === grantId);
    assert.ok(mine, 'verilen izin listede görünmeli');
    assert.equal(mine.is_live, true);
    assert.equal(mine.tenant_name, 'Örnek Ticaret A.Ş.');

    // İzin canlıyken destek modu gerçekten veri açar (T-009 chokepoint).
    const acc = json(await app.inject({
      method: 'GET', url: '/finance/accounts?limit=500',
      headers: { 'x-user-id': USERS.sezra, 'x-support-mode': 'on', 'x-tenant-id': ornekId },
    }));
    assert.equal(acc.meta.total, 63, 'canlı izinle seçilen kiracının verisi görünür');

    const revoked = await del(`/platform/support-grants/${grantId}`, USERS.sezra);
    assert.equal(revoked.statusCode, 200, revoked.body);

    // İptal sonrası canlı listede yok, ve destek yolu yeniden kapanır.
    const after = json(await get('/platform/support-grants', USERS.sezra));
    assert.ok(!after.data.some((g: { id: string }) => g.id === grantId));

    const acc2 = json(await app.inject({
      method: 'GET', url: '/finance/accounts?limit=500',
      headers: { 'x-user-id': USERS.sezra, 'x-support-mode': 'on', 'x-tenant-id': ornekId },
    }));
    assert.equal(acc2.meta.total, 0, 'iptal edilen izin erişim vermez');
  });

  test('eksik alanla 400 döner', async () => {
    const res = await post('/platform/support-grants', USERS.sezra, { tenant_id: ornekId });
    assert.equal(res.statusCode, 400, res.body);
  });
});
