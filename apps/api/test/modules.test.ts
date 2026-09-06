/**
 * Faz 2-4 modüllerinin HTTP kapsaması.
 *
 * README'nin dokuz modül satırı "testli (veri + API + UI)" diyor ama yalnızca
 * SQL veri katmanı testleri vardı; API katmanı tel üzerinden hiç doğrulanmamıştı.
 * Bu dosya her modül için (1) ana yazma yolunu uçtan uca HTTP üzerinden ve
 * (2) izin sınırını — yetkisi olmayan kullanıcının reddedilmesini — kapatır.
 *
 * api.test.ts ve finance.test.ts'in bıraktığı durumun ÜZERİNE çalışır; dosya
 * adı alfabetik olarak sonra geldiği için en son koşar ve önceki testlerin
 * beklediği durumu bozmaz.
 */
process.env.AUTH_MODE ??= 'dev';
process.env.NODE_ENV = 'test';

import '../src/env.ts';
import { test, before, after, describe } from 'node:test';
import assert from 'node:assert/strict';
import type { FastifyInstance } from 'fastify';

const USERS = {
  merve: '22222222-2222-2222-2222-222222222222', // tenant_admin — tüm modüller
  ali:   '33333333-3333-3333-3333-333333333333', // sales — Faz 2-4 modüllerinde yazma yetkisi yok
} as const;

let app: FastifyInstance;
let closeDb: () => Promise<void>;

const as = (user: string) => ({ 'x-user-id': user });
const json = (res: { body: string }) => JSON.parse(res.body);
const get = async (url: string, user: string) =>
  json(await app.inject({ method: 'GET', url, headers: as(user) }));
const post = (url: string, user: string, payload: unknown = {}) =>
  app.inject({ method: 'POST', url, headers: as(user), payload });
const patch = (url: string, user: string, payload: unknown = {}) =>
  app.inject({ method: 'PATCH', url, headers: as(user), payload });

/** İzin sınırı: yetkisiz istek 2xx DÖNMEZ. 500 gelirse bu bir bulgudur (test kırılır). */
const assertRefused = (res: { statusCode: number; body: string }, ctx: string) => {
  assert.ok(
    [401, 403, 404, 422].includes(res.statusCode),
    `${ctx}: beklenen 401/403/404/422, gelen ${res.statusCode} — ${res.body.slice(0, 160)}`,
  );
};

before(async () => {
  const core = await import('@sezra/core');
  const { modules } = await import('../src/modules.ts');
  closeDb = core.closeDb;
  app = await core.createApp({ modules, logger: false });
  await app.ready();
});

after(async () => {
  await app.close();
  await closeDb();
});

// ===========================================================================
// İK & Bordro
// ===========================================================================
describe('İK & Bordro (HTTP)', () => {
  test('ana yazma yolu: bekleyen izin talebi onaylanır', async () => {
    const list = await get('/hr/leave-requests?limit=100', USERS.merve);
    const pending = (list.data as { id: string; status: string }[])
      .find((r) => r.status === 'pending');
    assert.ok(pending, 'demo veride bekleyen izin talebi olmalı');

    const res = await post(`/hr/leave-requests/${pending!.id}/approve`, USERS.merve);
    assert.equal(res.statusCode, 200, res.body);
    assert.equal(json(res).data.status, 'approved');

    const after = await get(`/hr/leave-requests/${pending!.id}`, USERS.merve);
    assert.equal(after.data.status, 'approved');
  });

  test('yetkisiz kullanıcı izin onaylayamaz', async () => {
    const list = await get('/hr/leave-requests?limit=100', USERS.merve);
    const any = (list.data as { id: string }[])[0];
    assert.ok(any, 'onay denemesi için bir izin talebi gerekli');
    assertRefused(await post(`/hr/leave-requests/${any.id}/approve`, USERS.ali), 'hr.leave.approve');
  });
});

// ===========================================================================
// Satın Alma
// ===========================================================================
describe('Satın Alma (HTTP)', () => {
  test('ana yazma yolu: taslak talep gönderilip onaylanır', async () => {
    const list = await get('/purchasing/requisitions?limit=100', USERS.merve);
    const draft = (list.data as { id: string; status: string }[])
      .find((r) => r.status === 'draft');
    assert.ok(draft, 'demo veride taslak satın alma talebi olmalı');

    const submitted = await post(`/purchasing/requisitions/${draft!.id}/submit`, USERS.merve);
    assert.equal(submitted.statusCode, 200, submitted.body);

    const approved = await post(`/purchasing/requisitions/${draft!.id}/approve`, USERS.merve);
    assert.equal(approved.statusCode, 200, approved.body);
    assert.equal(json(approved).data.status, 'approved');
    assert.match(json(approved).data.number, /^STL-/);
  });

  test('yetkisiz kullanıcı talep onaylayamaz', async () => {
    const list = await get('/purchasing/requisitions?limit=100', USERS.merve);
    const any = (list.data as { id: string }[])[0];
    assert.ok(any);
    assertRefused(
      await post(`/purchasing/requisitions/${any.id}/approve`, USERS.ali),
      'purchasing.requisition.approve',
    );
  });
});

// ===========================================================================
// Envanter & Stok  (mal kabul haricindeki elle stok girişi)
// ===========================================================================
describe('Envanter & Stok (HTTP)', () => {
  let productId: string;

  test('ana yazma yolu: elle stok girişi hareket üretir', async () => {
    const products = await get('/core/products?sku=HAM-201', USERS.merve);
    productId = products.data[0].id;
    assert.ok(productId);

    const before = await get(
      `/inventory/stock?product_id=${productId}`, USERS.merve);
    const beforeQty = (before.data as { quantity: string }[])
      .reduce((s, r) => s + Number(r.quantity), 0);

    const res = await post('/inventory/receive', USERS.merve, {
      product_id: productId, quantity: 12, unit_cost: 100,
      reference: 'DWIGHT HTTP testi',
    });
    assert.equal(res.statusCode, 200, res.body);
    assert.ok(json(res).data.move_id, 'move_id dönmeli');

    const moves = await get(
      '/inventory/moves?source_module=manual&limit=50', USERS.merve);
    const mine = (moves.data as { reference: string; state: string; quantity: string }[])
      .find((m) => m.reference === 'DWIGHT HTTP testi');
    assert.ok(mine, 'elle giriş hareketi listelenmeli');
    assert.equal(mine!.state, 'done');
    assert.equal(Number(mine!.quantity), 12);

    const after = await get(
      `/inventory/stock?product_id=${productId}`, USERS.merve);
    const afterQty = (after.data as { quantity: string }[])
      .reduce((s, r) => s + Number(r.quantity), 0);
    assert.equal(afterQty, beforeQty + 12);
  });

  test('yetkisiz kullanıcı stok hareketi oluşturamaz', async () => {
    assertRefused(
      await post('/inventory/moves', USERS.ali, {
        product_id: productId, quantity: 1, move_date: '2026-01-01',
      }),
      'inventory.move.create',
    );
  });
});

// ===========================================================================
// Barkod
// ===========================================================================
describe('Barkod (HTTP)', () => {
  let productId: string;
  const CODE = 'DWIGHT-IC-0001';

  test('ana yazma yolu: barkod eklenip çözümlenir', async () => {
    const products = await get('/core/products?sku=HAM-201', USERS.merve);
    productId = products.data[0].id;

    const res = await post('/inventory/barcodes', USERS.merve, {
      product_id: productId, code: CODE, quantity: 1, kind: 'internal',
    });
    assert.equal(res.statusCode, 201, res.body);

    const resolved = await get(`/inventory/barcode/${CODE}`, USERS.merve);
    assert.equal(resolved.data.product_id, productId);
    assert.equal(Number(resolved.data.multiplier), 1);
  });

  test('yetkisiz kullanıcı barkod ekleyemez', async () => {
    assertRefused(
      await post('/inventory/barcodes', USERS.ali, {
        product_id: productId, code: 'DWIGHT-IC-0002', quantity: 1, kind: 'internal',
      }),
      'inventory.barcode.create',
    );
  });
});

// ===========================================================================
// Kalite Kontrol
// ===========================================================================
describe('Kalite Kontrol (HTTP)', () => {
  let productId: string;

  test('ana yazma yolu: elle muayene açılır ve ölçütler kopyalanır', async () => {
    const products = await get('/core/products?sku=HAM-201', USERS.merve);
    productId = products.data[0].id;

    const res = await post('/quality/inspections/open', USERS.merve, {
      product_id: productId, quantity: 100, stage: 'incoming',
    });
    assert.equal(res.statusCode, 200, res.body);
    const inspectionId = json(res).data.inspection_id;
    assert.ok(inspectionId, 'muayene kimliği dönmeli');

    const full = await get(`/quality/inspections/${inspectionId}/full`, USERS.merve);
    assert.equal(full.data.status, 'draft');
    assert.equal(full.data.results.length, 5, 'plandaki 5 ölçüt kopyalanmalı');
  });

  test('yetkisiz kullanıcı muayene oluşturamaz', async () => {
    assertRefused(
      await post('/quality/inspections', USERS.ali, {
        product_id: productId, quantity: 10, stage: 'incoming',
      }),
      'quality.inspection.create',
    );
  });
});

// ===========================================================================
// Bakım Yönetimi
// ===========================================================================
describe('Bakım Yönetimi (HTTP)', () => {
  test('ana yazma yolu: arıza bildirimi iş emri açar ve ekipmanı durdurur', async () => {
    const equipment = await get('/maintenance/equipment?limit=10', USERS.merve);
    const eq = equipment.data[0];
    assert.ok(eq, 'demo veride ekipman olmalı');

    const res = await post(
      `/maintenance/equipment/${eq.id}/report-breakdown`, USERS.merve,
      { title: 'DWIGHT: rulman sesi', description: 'Titreşim arttı', priority: 1 });
    assert.equal(res.statusCode, 200, res.body);
    assert.equal(json(res).data.kind, 'corrective');
    assert.equal(json(res).data.status, 'scheduled');
    assert.equal(json(res).data.title, 'DWIGHT: rulman sesi');

    const afterEq = await get(`/maintenance/equipment/${eq.id}`, USERS.merve);
    assert.equal(afterEq.data.status, 'down');
  });

  test('yetkisiz kullanıcı iş emri oluşturamaz', async () => {
    assertRefused(
      await post('/maintenance/work-orders', USERS.ali, {
        kind: 'corrective', title: 'DWIGHT yetkisiz', priority: 3,
      }),
      'maintenance.workorder.create',
    );
  });
});

// ===========================================================================
// Satış Noktası (POS)
// ===========================================================================
describe('Satış Noktası (HTTP)', () => {
  test('ana yazma yolu: kasa açılıp kapatılır', async () => {
    const terminals = await get('/pos/terminals?limit=10', USERS.merve);
    const terminal = (terminals.data as { id: string; is_active: boolean }[])
      .find((t) => t.is_active);
    assert.ok(terminal, 'aktif kasa terminali olmalı');

    const opened = await post('/pos/sessions/open', USERS.merve, {
      terminal_id: terminal!.id, opening_cash: 0,
    });
    assert.equal(opened.statusCode, 200, opened.body);
    const session = json(opened).data;
    assert.equal(session.status, 'open');
    assert.ok(session.number, 'kasa numarası verilmeli');

    const closed = await post(`/pos/sessions/${session.id}/close`, USERS.merve, {
      counted_cash: 0, notes: 'DWIGHT testi',
    });
    assert.equal(closed.statusCode, 200, closed.body);
    assert.equal(json(closed).data.status, 'closed');
  });

  test('yetkisiz kullanıcı kasa açamaz', async () => {
    const terminals = await get('/pos/terminals?limit=10', USERS.merve);
    const terminal = (terminals.data as { id: string }[])[0];
    assert.ok(terminal);
    assertRefused(
      await post('/pos/sessions/open', USERS.ali, { terminal_id: terminal.id, opening_cash: 0 }),
      'pos.session.create',
    );
  });
});

// ===========================================================================
// Proje Yönetimi
// ===========================================================================
describe('Proje Yönetimi (HTTP)', () => {
  let projectId: string;

  test('ana yazma yolu: proje oluşturulup tamamlanır', async () => {
    const created = await post('/projects/projects', USERS.merve, {
      code: 'DWIGHT-PRJ-1', name: 'HTTP kapsama projesi', billing_type: 'internal',
    });
    assert.equal(created.statusCode, 201, created.body);
    projectId = json(created).data.id;
    assert.equal(json(created).data.status, 'draft');

    const done = await post(`/projects/projects/${projectId}/complete`, USERS.merve);
    assert.equal(done.statusCode, 200, done.body);
    assert.equal(json(done).data.status, 'completed');
  });

  test('yetkisiz kullanıcı proje kapatamaz', async () => {
    assert.ok(projectId);
    assertRefused(
      await post(`/projects/projects/${projectId}/complete`, USERS.ali),
      'projects.project.complete',
    );
  });
});

// ===========================================================================
// Destek Masası
// ===========================================================================
describe('Destek Masası (HTTP)', () => {
  let ticketId: string;

  test('ana yazma yolu: bilet açılır, yanıtlanır, çözülür', async () => {
    const me = await get('/me', USERS.merve);
    const partners = await get('/core/partners?is_customer=true&limit=1', USERS.merve);
    const partnerId = partners.data[0]?.id ?? null;

    const created = await post('/helpdesk/tickets', USERS.merve, {
      branch_id: me.branches[0].id,
      subject: 'DWIGHT: hat basınç vermiyor',
      description: 'Üretim hattı durdu',
      partner_id: partnerId,
      priority: 'urgent',
      channel: 'phone',
    });
    assert.equal(created.statusCode, 201, created.body);
    ticketId = json(created).data.id;
    assert.match(json(created).data.number, /^DST-/);
    assert.ok(json(created).data.first_response_due, 'SLA ilk yanıt vadesi dondurulmalı');

    const reply = await post(`/helpdesk/tickets/${ticketId}/reply`, USERS.merve, {
      body: 'Teknik ekip yola çıktı', is_internal: false,
    });
    assert.equal(reply.statusCode, 200, reply.body);

    const resolved = await post(`/helpdesk/tickets/${ticketId}/resolve`, USERS.merve, {
      resolution: 'Basınç regülatörü değişti',
    });
    assert.equal(resolved.statusCode, 200, resolved.body);
    assert.equal(json(resolved).data.status, 'resolved');
  });

  test('yetkisiz kullanıcı bilet çözemez', async () => {
    assert.ok(ticketId);
    assertRefused(
      await post(`/helpdesk/tickets/${ticketId}/resolve`, USERS.ali, { resolution: 'x' }),
      'helpdesk.ticket.resolve',
    );
  });
});
