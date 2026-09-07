/**
 * T-021: platform yöneticisi yönetimi (HTTP).
 *
 * Bu, platformun en tehlikeli yüzeyi: is_platform_admin bayrağını vermek/almak.
 * Testler kanıtlar ki (1) platform yöneticisi olmayan HER yeni uçta reddedilir,
 * (2) kimse kendi yöneticiliğini kaldıramaz ve sistem her zaman >= 1 yönetici
 * tutar, (3) her değişiklik denetim izine (kim, kime, ne zaman) yazılır.
 *
 * Dosya adı alfabetik olarak en sonda; platform yöneticisi durumunu değiştirir
 * ve after() kancasında seed durumuna geri alır.
 */
process.env.AUTH_MODE ??= 'dev';
process.env.NODE_ENV = 'test';

import '../src/env.ts';
import { test, before, after, describe } from 'node:test';
import assert from 'node:assert/strict';
import type { FastifyInstance } from 'fastify';
import type { Sql } from '@sezra/core';

const USERS = {
  sukru: '66666666-6666-6666-6666-666666666666', // seed platform admin (gerçek kişi)
  sezra: '11111111-1111-1111-1111-111111111111', // seed platform admin (demo)
  merve: '22222222-2222-2222-2222-222222222222', // platform admin DEĞİL
  ali:   '33333333-3333-3333-3333-333333333333', // platform admin DEĞİL
} as const;

let app: FastifyInstance;
let closeDb: () => Promise<void>;
let sql: Sql;

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
});

after(async () => {
  // Seed durumuna dön: 1111 + 6666 yönetici, 2222 + 3333 değil.
  await sql`update core.users set is_platform_admin = true
            where id in (${USERS.sukru}, ${USERS.sezra})`;
  await sql`update core.users set is_platform_admin = false
            where id in (${USERS.merve}, ${USERS.ali})`;
  await app.close();
  await closeDb();
});

describe('platform yöneticisi yönetimi (HTTP)', () => {
  test('platform yöneticisi olmayan her yeni uçta reddedilir', async () => {
    assert.equal((await get('/platform/admins', USERS.merve)).statusCode, 403);
    assert.equal((await get('/platform/admin-events', USERS.merve)).statusCode, 403);
    assert.equal(
      (await post('/platform/admins', USERS.merve, { email: 'duzce.satis@ornek.test' })).statusCode,
      403,
    );
    assert.equal((await del(`/platform/admins/${USERS.sezra}`, USERS.merve)).statusCode, 403);
  });

  test('e-postayla yükseltir, listeler, sonra indirir', async () => {
    // Seed: 1111 + 6666.
    const once = json(await get('/platform/admins', USERS.sukru));
    assert.equal(once.data.length, 2);

    const grant = await post('/platform/admins', USERS.sukru, { email: 'admin@ornek.test' });
    assert.equal(grant.statusCode, 200, grant.body);
    assert.equal(json(grant).data.user_id, USERS.merve);

    const list = json(await get('/platform/admins', USERS.sukru));
    assert.ok(list.data.some((a: { id: string }) => a.id === USERS.merve), 'merve listede olmalı');

    // Yükseltilen kullanıcı artık konsolu görebilir.
    const me = json(await get('/me', USERS.merve));
    assert.equal(me.user.is_platform_admin, true);
    assert.equal((await get('/platform/admins', USERS.merve)).statusCode, 200);

    // Geri indir.
    const revoke = await del(`/platform/admins/${USERS.merve}`, USERS.sukru);
    assert.equal(revoke.statusCode, 200, revoke.body);

    const after2 = json(await get('/platform/admins', USERS.sukru));
    assert.ok(!after2.data.some((a: { id: string }) => a.id === USERS.merve), 'merve listede olmamalı');
    assert.equal((await get('/platform/admins', USERS.merve)).statusCode, 403, 'bayrak gerçekten kalktı');
  });

  test('her değişiklik denetim izine yazılır (kim, kime, ne zaman)', async () => {
    const events = json(await get('/platform/admin-events?limit=10', USERS.sukru)).data as Array<{
      actor_id: string; target_id: string; target_email: string; granted: boolean;
      occurred_at: string;
    }>;
    const merveOlaylari = events.filter((e) => e.target_id === USERS.merve);
    assert.ok(merveOlaylari.length >= 2, 'merve için en az iki olay (yükselt + indir)');
    assert.equal(merveOlaylari[0]!.granted, false, 'en yeni olay: indirme');
    assert.equal(merveOlaylari[1]!.granted, true, 'ondan önceki: yükseltme');
    assert.ok(merveOlaylari.every((e) => e.actor_id === USERS.sukru), 'eylemi yapan 6666');
    assert.ok(merveOlaylari.every((e) => e.target_email === 'admin@ornek.test'));
    assert.ok(merveOlaylari.every((e) => typeof e.occurred_at === 'string'));
  });

  test('KILITLENME: kimse kendi yöneticiliğini kaldıramaz', async () => {
    const res = await del(`/platform/admins/${USERS.sukru}`, USERS.sukru);
    assert.equal(res.statusCode, 403, res.body);
    assert.match(json(res).error.message, /kendi/i);
    // Hâlâ yönetici.
    assert.equal((await get('/platform/admins', USERS.sukru)).statusCode, 200);
  });

  test('KILITLENME: son yönetici kalınca bile kendini indiremez -> platformda daima >= 1 yönetici', async () => {
    // 6666, 1111'i indirir; artık tek yönetici 6666.
    assert.equal((await del(`/platform/admins/${USERS.sezra}`, USERS.sukru)).statusCode, 200);
    const solo = json(await get('/platform/admins', USERS.sukru));
    assert.equal(solo.data.length, 1);
    assert.equal(solo.data[0].id, USERS.sukru);

    // Tek yönetici kendini indiremez (R1). 1111 artık yönetici olmadığı için
    // 6666'yı indiremez. Sistem sıfır yöneticiye düşemez.
    const self = await del(`/platform/admins/${USERS.sukru}`, USERS.sukru);
    assert.equal(self.statusCode, 403, self.body);
    const byExAdmin = await del(`/platform/admins/${USERS.sukru}`, USERS.sezra);
    assert.equal(byExAdmin.statusCode, 403, byExAdmin.body);

    // 1111'i geri yükselt (temizliğe yardım).
    assert.equal((await post('/platform/admins', USERS.sukru, { email: 'sezra@sezra.dev' })).statusCode, 200);
  });

  test('bilinmeyen e-posta 404, tekrar yükseltme idempotent 200', async () => {
    assert.equal(
      (await post('/platform/admins', USERS.sukru, { email: 'yok@hicbiryer.test' })).statusCode, 404);
    assert.equal(
      (await post('/platform/admins', USERS.sukru, { email: 'sezra@sezra.dev' })).statusCode, 200);
    assert.equal((await post('/platform/admins', USERS.sukru, {})).statusCode, 400);
  });
});
