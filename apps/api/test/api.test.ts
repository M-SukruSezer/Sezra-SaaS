/**
 * API uçtan uca testleri.
 *
 * Önemli olan tek şey: RLS'in HTTP katmanından da aynen geçerli olduğunu
 * göstermek. Uygulama kodunda tek bir "where tenant_id = ?" yok; izolasyon
 * tamamen veritabanından geliyor.
 *
 * Çalıştırma:  bash scripts/test-api.sh
 */
process.env.AUTH_MODE ??= 'dev';
process.env.NODE_ENV = 'test';

import { test, before, after, describe } from 'node:test';
import assert from 'node:assert/strict';
import type { FastifyInstance } from 'fastify';

const USERS = {
  sezra:   '11111111-1111-1111-1111-111111111111',
  merve:   '22222222-2222-2222-2222-222222222222',  // tenant_admin
  ali:     '33333333-3333-3333-3333-333333333333',  // sales, Düzce, .own
  deniz:   '44444444-4444-4444-4444-444444444444',  // branch_manager, Zonguldak
  rakip:   '55555555-5555-5555-5555-555555555555',  // başka kiracı
} as const;

let app: FastifyInstance;
let closeDb: () => Promise<void>;

const as = (user: string, extra: Record<string, string> = {}) => ({
  'x-user-id': user, ...extra,
});

const json = (res: { body: string }) => JSON.parse(res.body);

before(async () => {
  const core = await import('@sezra/core');
  const { modules } = await import('../src/modules.js');
  closeDb = core.closeDb;
  app = await core.createApp({ modules, logger: false });
  await app.ready();
});

after(async () => {
  await app.close();
  await closeDb();
});

describe('sağlık ve oturum', () => {
  test('GET /health', async () => {
    const res = await app.inject({ method: 'GET', url: '/health' });
    assert.equal(res.statusCode, 200);
    assert.equal(json(res).db, true);
  });

  test('kimliksiz istek 401 döner', async () => {
    const res = await app.inject({ method: 'GET', url: '/crm/leads' });
    assert.equal(res.statusCode, 401);
  });

  test('GET /me satış temsilcisinin izinlerini doğru döndürür', async () => {
    const res = await app.inject({ method: 'GET', url: '/me', headers: as(USERS.ali) });
    assert.equal(res.statusCode, 200);
    const me = json(res);
    assert.equal(me.tenant.slug, 'colombia-coffee');
    assert.ok(me.permissions.includes('crm.lead.read.own'));
    assert.ok(!me.permissions.includes('crm.lead.read.all'));
    assert.deepEqual(me.roles.map((r: { code: string }) => r.code), ['sales']);
    // Şubeye kilitli: yalnızca Düzce'yi görür
    assert.equal(me.branches.length, 1);
  });

  test('GET /me şirket yöneticisine iki şubeyi de gösterir', async () => {
    const me = json(await app.inject({ method: 'GET', url: '/me', headers: as(USERS.merve) }));
    assert.equal(me.branches.length, 2);
    assert.ok(me.modules.some((m: { code: string }) => m.code === 'crm'));
  });
});

describe('kiracı ve şube izolasyonu (HTTP üzerinden)', () => {
  const leadCount = async (user: string) => {
    const res = await app.inject({ method: 'GET', url: '/crm/leads?limit=100', headers: as(user) });
    assert.equal(res.statusCode, 200);
    return json(res).meta.total as number;
  };

  test('başka kiracının yöneticisi hiçbir fırsat göremez', async () => {
    assert.equal(await leadCount(USERS.rakip), 0);
  });

  test('satış temsilcisi yalnızca kendi fırsatlarını görür', async () => {
    assert.equal(await leadCount(USERS.ali), 3);
  });

  test('şube müdürü yalnızca kendi şubesini görür', async () => {
    assert.equal(await leadCount(USERS.deniz), 2);
  });

  test('şirket yöneticisi tümünü görür', async () => {
    assert.equal(await leadCount(USERS.merve), 5);
  });

  test('x-tenant-id ile başka kiracıya geçilemez', async () => {
    const meMerve = json(await app.inject({ method: 'GET', url: '/me', headers: as(USERS.merve) }));
    const res = await app.inject({
      method: 'GET', url: '/crm/leads',
      headers: as(USERS.rakip, { 'x-tenant-id': meMerve.tenant.id }),
    });
    assert.equal(json(res).meta.total, 0);
  });

  test('görünmeyen kaydın tekil erişimi 404 (403 değil — varlığını sızdırmaz)', async () => {
    const list = json(await app.inject({
      method: 'GET', url: '/crm/leads?limit=100', headers: as(USERS.merve) }));
    // Zonguldak şubesindeki bir fırsat: Ali'nin ne şubesi ne de sahipliği
    const deniz = json(await app.inject({
      method: 'GET', url: '/crm/leads?limit=100', headers: as(USERS.deniz) }));
    const zonguldakLead = deniz.data[0];
    const res = await app.inject({
      method: 'GET', url: `/crm/leads/${zonguldakLead.id}`, headers: as(USERS.ali) });
    assert.equal(res.statusCode, 404);
  });
});

describe('yazma ve yetki', () => {
  test('yeni fırsatın sahibi otomatik atanır', async () => {
    const me = json(await app.inject({ method: 'GET', url: '/me', headers: as(USERS.ali) }));
    const board = json(await app.inject({ method: 'GET', url: '/crm/board', headers: as(USERS.ali) }));
    const stage = board.data.stages[0];

    const res = await app.inject({
      method: 'POST', url: '/crm/leads', headers: as(USERS.ali),
      payload: {
        pipeline_id: board.data.pipeline.id,
        stage_id: stage.id,
        name: 'API üzerinden açılan fırsat',
        expected_revenue: 12500,
      },
    });
    assert.equal(res.statusCode, 201);
    const lead = json(res).data;
    assert.equal(lead.owner_id, USERS.ali);
    assert.equal(lead.status, 'open');
    assert.equal(lead.probability, stage.probability);   // aşamadan senkronize edildi
  });

  test('beyaz listede olmayan alan reddedilir', async () => {
    const res = await app.inject({
      method: 'POST', url: '/crm/leads', headers: as(USERS.ali),
      payload: { name: 'x', tenant_id: '00000000-0000-0000-0000-000000000001' },
    });
    assert.equal(res.statusCode, 400);
    assert.match(json(res).error.message, /Yazılamayan alan/);
  });

  test('satış temsilcisi başkasının fırsatını güncelleyemez', async () => {
    const list = json(await app.inject({
      method: 'GET', url: '/crm/leads?limit=100', headers: as(USERS.deniz) }));
    const foreign = list.data.find((l: { owner_id: string }) => l.owner_id === USERS.deniz);
    assert.ok(foreign, 'Zonguldak müdürüne ait bir fırsat olmalı');
    const res = await app.inject({
      method: 'PATCH', url: `/crm/leads/${foreign.id}`,
      headers: as(USERS.ali), payload: { notes: 'sızıntı' },
    });
    assert.equal(res.statusCode, 404);
  });

  test('şubeye kilitli kullanıcının açtığı kayda şubesi otomatik atanır', async () => {
    const me = json(await app.inject({ method: 'GET', url: '/me', headers: as(USERS.ali) }));
    const board = json(await app.inject({ method: 'GET', url: '/crm/board', headers: as(USERS.ali) }));
    const res = await app.inject({
      method: 'POST', url: '/crm/leads', headers: as(USERS.ali),
      payload: {
        pipeline_id: board.data.pipeline.id,
        stage_id: board.data.stages[0].id,
        name: 'Şube ataması testi',
      },
    });
    // branch_id gönderilmedi ama Ali tek şubeye kilitli: kayıt o şubeye bağlanır,
    // yani kazara tüm şubelere görünür hâle gelmez.
    assert.equal(json(res).data.branch_id, me.branches[0].id);
  });

  test('sipariş onaylama yetkisi olmayan kullanıcı 403 alır', async () => {
    const orders = json(await app.inject({
      method: 'GET', url: '/crm/sale-orders', headers: as(USERS.merve) }));
    if (orders.data.length === 0) return;   // akış testi henüz sipariş üretmediyse
    const res = await app.inject({
      method: 'POST', url: `/crm/sale-orders/${orders.data[0].id}/confirm`,
      headers: as(USERS.ali),
    });
    assert.ok([403, 404].includes(res.statusCode), `beklenen 403/404, gelen ${res.statusCode}`);
  });
});

describe('teklif -> sipariş akışı (HTTP)', () => {
  test('gönder, onayla, siparişi onayla', async () => {
    const quotes = json(await app.inject({
      method: 'GET', url: '/crm/quotations', headers: as(USERS.merve) }));
    const q = quotes.data[0];
    assert.ok(q, 'demo veride teklif olmalı');
    assert.equal(q.status, 'draft');
    assert.equal(Number(q.total), 140183);

    const sent = json(await app.inject({
      method: 'POST', url: `/crm/quotations/${q.id}/send`, headers: as(USERS.merve) }));
    assert.match(sent.data.number, /^TKL-\d{4}-00001$/);

    const accepted = json(await app.inject({
      method: 'POST', url: `/crm/quotations/${q.id}/accept`, headers: as(USERS.merve) }));
    const orderId = accepted.data.id;
    assert.equal(accepted.data.status, 'draft');
    assert.equal(Number(accepted.data.total), 140183);

    const confirmed = json(await app.inject({
      method: 'POST', url: `/crm/sale-orders/${orderId}/confirm`, headers: as(USERS.merve) }));
    assert.equal(confirmed.data.status, 'confirmed');
    assert.match(confirmed.data.number, /^SIP-\d{4}-00001$/);

    const full = json(await app.inject({
      method: 'GET', url: `/crm/sale-orders/${orderId}/full`, headers: as(USERS.merve) }));
    assert.equal(full.data.lines.length, 2);
    assert.equal(full.data.partner_name, 'Düzce Üniversitesi Kantin İşl.');
  });

  test('onaylanmış teklifin satırı değiştirilemez', async () => {
    const quotes = json(await app.inject({
      method: 'GET', url: '/crm/quotations?status=accepted', headers: as(USERS.merve) }));
    const lines = json(await app.inject({
      method: 'GET', url: `/crm/quotation-lines?quotation_id=${quotes.data[0].id}`,
      headers: as(USERS.merve) }));
    const res = await app.inject({
      method: 'PATCH', url: `/crm/quotation-lines/${lines.data[0].id}`,
      headers: as(USERS.merve), payload: { quantity: 999 },
    });
    assert.equal(res.statusCode, 422);
  });
});

describe('raporlar', () => {
  test('huni özeti', async () => {
    const res = await app.inject({
      method: 'GET', url: '/crm/reports/pipeline', headers: as(USERS.merve) });
    assert.equal(res.statusCode, 200);
    assert.ok(json(res).data.length > 0);
  });

  test('kayıp sebebi analizi', async () => {
    const rep = json(await app.inject({
      method: 'GET', url: '/crm/reports/lost-reasons', headers: as(USERS.merve) }));
    assert.ok(rep.data.some((r: { lost_reason: string }) => r.lost_reason === 'Fiyat yüksek'));
  });

  test("raporlar da RLS'e tabidir", async () => {
    const rep = json(await app.inject({
      method: 'GET', url: '/crm/reports/lost-reasons', headers: as(USERS.rakip) }));
    assert.equal(rep.data.length, 0);
  });
});

describe('destek oturumu', () => {
  test('platform admini destek modu olmadan veri göremez', async () => {
    const res = json(await app.inject({
      method: 'GET', url: '/crm/leads', headers: as(USERS.sezra) }));
    assert.equal(res.meta.total, 0);
  });

  test('destek modu açıkken görebilir', async () => {
    const res = json(await app.inject({
      method: 'GET', url: '/crm/leads?limit=100',
      headers: as(USERS.sezra, { 'x-support-mode': 'on' }) }));
    assert.ok(res.meta.total >= 5);
  });
});
