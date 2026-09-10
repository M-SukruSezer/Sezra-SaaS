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

// Ortam degiskenlerini core'dan ONCE yukle: core/db.ts modul seviyesinde
// DATABASE_URL okur. Gercek ortam degiskeni .env'i ezdigi icin test
// betiklerinin satir ici DATABASE_URL'i gecerli kalir.
import '../src/env.ts';
import { test, before, after, describe } from 'node:test';
import assert from 'node:assert/strict';
import type { FastifyInstance } from 'fastify';
import type { Sql } from '@sezra/core';

const USERS = {
  sezra:   '11111111-1111-1111-1111-111111111111',
  merve:   '22222222-2222-2222-2222-222222222222',  // tenant_admin
  ali:     '33333333-3333-3333-3333-333333333333',  // sales, Düzce, .own
  deniz:   '44444444-4444-4444-4444-444444444444',  // branch_manager, Zonguldak
  rakip:   '55555555-5555-5555-5555-555555555555',  // başka kiracı
} as const;

let app: FastifyInstance;
let closeDb: () => Promise<void>;
let sql: Sql;

const as = (user: string, extra: Record<string, string> = {}) => ({
  'x-user-id': user, ...extra,
});

const json = (res: { body: string }) => JSON.parse(res.body);

before(async () => {
  const core = await import('@sezra/core');
  const { modules } = await import('../src/modules.ts');
  closeDb = core.closeDb;
  sql = core.sql;
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
    assert.equal(me.tenant.slug, 'ornek-ticaret');
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
    assert.equal(full.data.partner_name, 'Alfa Sanayi Ltd. Şti.');
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

describe('boolean filtreler', () => {
  // REGRESYON: sürücü, metin 'true' değerini boolean kolonda false'a çeviriyordu;
  // `?is_customer=true` sessizce TERS sonuç döndürüyordu (hata değil, yanlış veri).
  test('is_customer=true yalnızca müşterileri döndürür', async () => {
    const res = json(await app.inject({
      method: 'GET', url: '/core/partners?is_customer=true&limit=100', headers: as(USERS.merve) }));
    assert.ok(res.meta.total > 0, 'müşteri bulunmalı');
    for (const p of res.data as { name: string; is_customer: boolean }[]) {
      assert.equal(p.is_customer, true, `${p.name} müşteri olmalı`);
    }
  });

  test('is_customer=false yalnızca müşteri OLMAYANLARI döndürür', async () => {
    const res = json(await app.inject({
      method: 'GET', url: '/core/partners?is_customer=false&limit=100', headers: as(USERS.merve) }));
    for (const p of res.data as { name: string; is_customer: boolean }[]) {
      assert.equal(p.is_customer, false, `${p.name} müşteri olmamalı`);
    }
  });

  test('true ve false birbirini tamamlar', async () => {
    const all = json(await app.inject({ method: 'GET', url: '/core/partners?limit=100', headers: as(USERS.merve) }));
    const yes = json(await app.inject({ method: 'GET', url: '/core/partners?is_customer=true&limit=100', headers: as(USERS.merve) }));
    const no  = json(await app.inject({ method: 'GET', url: '/core/partners?is_customer=false&limit=100', headers: as(USERS.merve) }));
    assert.equal(yes.meta.total + no.meta.total, all.meta.total);
  });
});

describe('liste uçlarının varsayılan sıralaması', () => {
  // REGRESYON: `defaultSort` kolon beyaz listesinde YOKSA uç her istekte
  // "Sıralanamayan alan" ile 400 döner -- yani liste hiç okunamaz. Bu tam
  // olarak /inventory/count-lines'ta olmuştu: sayım satırları arayüzde sessizce
  // BOŞ görünüyordu, çünkü liste hatası bir tabloyu boş göstermekten
  // ayırt edilemiyordu. Kayıt olmaması normaldir; 400 dönmesi değildir.
  const UCLAR = [
    '/inventory/count-lines',
    '/inventory/counts',
    '/inventory/moves',
    '/inventory/barcodes',
    '/crm/leads',
    '/finance/invoices',
  ];

  for (const yol of UCLAR) {
    test(`${yol} parametresiz 200 döner`, async () => {
      const res = await app.inject({ method: 'GET', url: yol, headers: as(USERS.merve) });
      assert.equal(res.statusCode, 200,
        `${yol} -> ${res.statusCode}: ${res.body.slice(0, 120)}`);
    });
  }
});

describe('genel arama', () => {
  test('kayıt tipine göre gruplanır', async () => {
    const res = json(await app.inject({
      method: 'GET', url: '/search?q=ham', headers: as(USERS.merve) }));
    const etiketler = (res.data as { etiket: string }[]).map((g) => g.etiket);
    assert.ok(etiketler.includes('Cari'), 'cari sonucu olmalı');
    assert.ok(etiketler.includes('Ürün'), 'ürün sonucu olmalı');
  });

  // TEK HARF ARANMAZ: neredeyse her kaydı eşleştirir ve sonuç değil
  // gürültü döner; uç bunu en baştan keser.
  test('tek harflik sorgu boş döner', async () => {
    const res = json(await app.inject({
      method: 'GET', url: '/search?q=a', headers: as(USERS.merve) }));
    assert.equal(res.data.length, 0);
    assert.equal(res.meta.kisa, true);
  });

  // REGRESYON: `%` kaçırılmazsa tek karakterlik bir sorgu tüm tabloyu
  // getirir ve arama anlamını yitirir.
  test('joker karakter kaçırılır', async () => {
    const res = json(await app.inject({
      method: 'GET', url: '/search?q=%25%25', headers: as(USERS.merve) }));
    assert.equal(res.data.length, 0, 'yüzde işareti harfi harfine aranmalı');
  });

  test("arama da RLS'e tabidir", async () => {
    const res = json(await app.inject({
      method: 'GET', url: '/search?q=alfa', headers: as(USERS.rakip) }));
    assert.equal(res.data.length, 0, 'başka kiracının carisi görünmemeli');
  });
});

describe('kullanıcı ve rol yönetimi', () => {
  const ALI = '33333333-3333-3333-3333-333333333333';
  const MERVE = '22222222-2222-2222-2222-222222222222';

  test('rol DEĞİŞTİRİLİR, eklenmez', async () => {
    // REGRESYON: `invite_user` rolü yalnızca EKLER; rolü daraltmak
    // imkânsızdı. `set_member_roles` listeyi değiştirir.
    const once = json(await app.inject({
      method: 'GET', url: '/core/users', headers: as(USERS.merve) }));
    const ali = (once.data as { id: string; roles: string[] }[]).find((u) => u.id === ALI);
    assert.ok(ali, 'Ali Kaya bulunmalı');

    const res = await app.inject({
      method: 'POST', url: `/core/users/${ALI}/roles`, headers: as(USERS.merve),
      payload: { role_codes: ['accounting'] } });
    assert.equal(res.statusCode, 200);

    const sonra = json(await app.inject({
      method: 'GET', url: '/core/users', headers: as(USERS.merve) }));
    const yeni = (sonra.data as { id: string; roles: string[] }[]).find((u) => u.id === ALI)!;
    assert.deepEqual(yeni.roles, ['accounting'], 'eski rol kalmamalı');

    // Testin bıraktığı durumu geri al.
    await app.inject({
      method: 'POST', url: `/core/users/${ALI}/roles`, headers: as(USERS.merve),
      payload: { role_codes: ['sales'] } });
  });

  // KİLİTLENME KORUMASI: son yöneticinin yöneticiliği alınırsa kiracıyı
  // kimse yönetemez ve geri dönüşü yalnızca destek modundan mümkündür.
  test('son yöneticinin rolü değiştirilemez', async () => {
    // Tohum, Örnek Ticaret'e ikinci bir tenant_admin koyabilir (gerçek
    // operatör hesabı, m.sukrusezer@gmail.com). Bu test "SON yönetici"
    // senaryosunu sınar; önce Merve'yi tek yönetici bırak, doğrula, geri al.
    // Doğrudan SQL: guard'ı atlar, kurulum içindir.
    const digerAdminler = await sql<{ membership_id: string; role_id: string }[]>`
      select mr.membership_id, mr.role_id
      from core.membership_roles mr
      join core.memberships m on m.id = mr.membership_id
      join core.roles r on r.id = mr.role_id
      join core.tenants t on t.id = m.tenant_id
      where t.slug = 'ornek-ticaret' and r.code = 'tenant_admin'
        and m.user_id <> ${MERVE}`;
    for (const r of digerAdminler) {
      await sql`delete from core.membership_roles
        where membership_id = ${r.membership_id} and role_id = ${r.role_id}`;
    }
    try {
      const res = await app.inject({
        method: 'POST', url: `/core/users/${MERVE}/roles`, headers: as(USERS.merve),
        payload: { role_codes: ['sales'] } });
      // check_violation -> 422: istek biçimsel olarak doğru ama iş kuralı
      // reddediyor. 409 (çakışma) değil, çünkü çakışan bir şey yok.
      assert.equal(res.statusCode, 422);
      assert.match(json(res).error.message, /en az bir yönetici/i);
    } finally {
      for (const r of digerAdminler) {
        await sql`insert into core.membership_roles (membership_id, role_id)
          values (${r.membership_id}, ${r.role_id}) on conflict do nothing`;
      }
    }
  });

  test('kullanıcı kendi erişimini kapatamaz', async () => {
    const res = await app.inject({
      method: 'POST', url: `/core/users/${MERVE}/active`, headers: as(USERS.merve),
      payload: { active: false } });
    assert.equal(res.statusCode, 422);
    assert.match(json(res).error.message, /kendi erişiminizi/i);
  });

  test('yetkisiz kullanıcı rol değiştiremez', async () => {
    const res = await app.inject({
      method: 'POST', url: `/core/users/${ALI}/roles`, headers: as(USERS.ali),
      payload: { role_codes: ['tenant_admin'] } });
    assert.equal(res.statusCode, 403);
  });

  test('boş rol listesi reddedilir', async () => {
    const res = await app.inject({
      method: 'POST', url: `/core/users/${ALI}/roles`, headers: as(USERS.merve),
      payload: { role_codes: [] } });
    assert.equal(res.statusCode, 400);
  });
});

describe('bildirimler', () => {
  test('okunmamış sayısı ve okundu işareti', async () => {
    const once = json(await app.inject({
      method: 'GET', url: '/notifications', headers: as(USERS.merve) }));
    if (once.data.length === 0) return;   // Demo veride bildirim yoksa geç

    const key = (once.data as { key: string }[])[0]!.key;
    const isaret = await app.inject({
      method: 'POST', url: '/notifications/read', headers: as(USERS.merve),
      payload: { keys: [key] } });
    assert.equal(isaret.statusCode, 200);

    const sonra = json(await app.inject({
      method: 'GET', url: '/notifications', headers: as(USERS.merve) }));
    const b = (sonra.data as { key: string; okundu: boolean }[]).find((x) => x.key === key)!;
    assert.equal(b.okundu, true, 'işaretlenen bildirim okundu görünmeli');
    // OKUNAN LİSTEDEN ATILMAZ: "az önce ne okumuştum" sorusu cevapsız kalmasın.
    assert.ok(sonra.data.length === once.data.length, 'okunan bildirim listede kalmalı');
  });

  test('okundu işareti KULLANICIYA özeldir', async () => {
    const ali = json(await app.inject({
      method: 'GET', url: '/notifications', headers: as(USERS.ali) }));
    for (const b of ali.data as { okundu: boolean }[]) {
      assert.equal(b.okundu, false, "başkasının okuması Ali'yi etkilememeli");
    }
  });
});

describe('cari kartı', () => {
  let cariId = '';

  test('kart ilişki ağıyla birlikte döner', async () => {
    const liste = json(await app.inject({
      method: 'GET', url: '/core/partners?q=Alfa&limit=1', headers: as(USERS.merve) }));
    cariId = (liste.data as { id: string }[])[0]!.id;

    const res = json(await app.inject({
      method: 'GET', url: `/core/partners/${cariId}/detail`, headers: as(USERS.merve) }));
    assert.ok(res.data.partner, 'cari kaydı olmalı');
    assert.ok(Array.isArray(res.data.iliskiler), 'ilişki ağı olmalı');
    const etiketler = (res.data.iliskiler as { etiket: string }[]).map((i) => i.etiket);
    assert.ok(etiketler.includes('Fatura'), 'fatura ilişkisi olmalı');
    assert.ok(etiketler.includes('Teklif'), 'teklif ilişkisi olmalı');
  });

  // SIFIR KAYITLI İLİŞKİ DE DÖNER: "hiç faturası yok" bir bilgidir ve
  // çipi tamamen gizlemek onu görünmez yapardı.
  test('kaydı olmayan ilişki de listelenir', async () => {
    const res = json(await app.inject({
      method: 'GET', url: `/core/partners/${cariId}/detail`, headers: as(USERS.merve) }));
    const sifirlar = (res.data.iliskiler as { adet: number }[]).filter((i) => i.adet === 0);
    assert.ok(sifirlar.length > 0, 'sıfır kayıtlı ilişki de dönmeli');
  });

  test('ilişki satırları ayrı uçtan gelir', async () => {
    const res = json(await app.inject({
      method: 'GET', url: `/core/partners/${cariId}/relations/fatura`, headers: as(USERS.merve) }));
    assert.ok(Array.isArray(res.data));
    for (const f of res.data as { number?: string }[]) assert.ok('id' in f);
  });

  test('bilinmeyen ilişki 404 döner', async () => {
    const res = await app.inject({
      method: 'GET', url: `/core/partners/${cariId}/relations/yokboyle`, headers: as(USERS.merve) });
    assert.equal(res.statusCode, 404);
  });

  test("cari kartı da RLS'e tabidir", async () => {
    const res = await app.inject({
      method: 'GET', url: `/core/partners/${cariId}/detail`, headers: as(USERS.rakip) });
    assert.equal(res.statusCode, 404, 'başka kiracının carisi görünmemeli');
  });
});

describe('mükerrer cari birleştirme', () => {
  const yeniCari = async (govde: Record<string, unknown>) => {
    const r = await app.inject({
      method: 'POST', url: '/core/partners', headers: as(USERS.merve), payload: govde });
    return (json(r).data as { id: string }).id;
  };

  test('kaynağın belgeleri hedefe taşınır, kaynak pasife alınır', async () => {
    const a = await yeniCari({ name: 'TEST Birleşme A', is_customer: true, city: 'Bursa' });
    const b = await yeniCari({ name: 'TEST Birleşme B', is_supplier: true });
    const teklif = await app.inject({
      method: 'POST', url: '/crm/quotations', headers: as(USERS.merve),
      payload: { partner_id: a, issue_date: '2026-01-15', currency: 'TRY' } });
    const teklifId = (json(teklif).data as { id: string }).id;

    const res = await app.inject({
      method: 'POST', url: `/core/partners/${b}/merge`, headers: as(USERS.merve),
      payload: { source_id: a } });
    assert.equal(res.statusCode, 200);
    assert.equal(json(res).data.tasinan, 1, 'bir belge taşınmalı');

    const t = json(await app.inject({
      method: 'GET', url: `/crm/quotations/${teklifId}`, headers: as(USERS.merve) }));
    assert.equal(t.data.partner_id, b, 'teklif hedefe geçmeli');

    // KAYNAK SİLİNMEZ: denetim izi ve geçmiş raporlar ona bakıyor olabilir.
    const kaynak = json(await app.inject({
      method: 'GET', url: `/core/partners/${a}`, headers: as(USERS.merve) }));
    assert.equal(kaynak.data.is_active, false, 'kaynak pasife alınmalı');
    assert.match(kaynak.data.name, /birleştirildi/);

    // ROLLER BİRLEŞİR, boş alanlar kaynaktan tamamlanır.
    const hedef = json(await app.inject({
      method: 'GET', url: `/core/partners/${b}`, headers: as(USERS.merve) }));
    assert.equal(hedef.data.is_customer, true, 'kaynağın müşteri rolü hedefe geçmeli');
    assert.equal(hedef.data.is_supplier, true, 'hedefin kendi rolü korunmalı');
    assert.equal(hedef.data.city, 'Bursa', 'boş alan kaynaktan dolmalı');

    await app.inject({ method: 'DELETE', url: `/crm/quotations/${teklifId}`, headers: as(USERS.merve) });
    await app.inject({ method: 'DELETE', url: `/core/partners/${a}`, headers: as(USERS.merve) });
    await app.inject({ method: 'DELETE', url: `/core/partners/${b}`, headers: as(USERS.merve) });
  });

  test('cari kendisiyle birleştirilemez', async () => {
    const a = await yeniCari({ name: 'TEST Birleşme Kendi' });
    const res = await app.inject({
      method: 'POST', url: `/core/partners/${a}/merge`, headers: as(USERS.merve),
      payload: { source_id: a } });
    assert.equal(res.statusCode, 422);
    await app.inject({ method: 'DELETE', url: `/core/partners/${a}`, headers: as(USERS.merve) });
  });

  test('yetkisiz kullanıcı birleştiremez', async () => {
    const liste = json(await app.inject({
      method: 'GET', url: '/core/partners?limit=2', headers: as(USERS.merve) }));
    const [x, y] = liste.data as { id: string }[];
    const res = await app.inject({
      method: 'POST', url: `/core/partners/${y!.id}/merge`, headers: as(USERS.ali),
      payload: { source_id: x!.id } });
    assert.equal(res.statusCode, 403);
  });
});

describe('yabancı anahtar hataları', () => {
  // REGRESYON: 23503 iki zıt durumu kapsıyor ve ikisine de "İlişkili kayıt
  // bulunamadı" deniyordu. Belgesi olduğu için silinemeyen bir cariyi
  // silmeye çalışan kullanıcı "kayıt bulunamadı" cevabı alıyordu.
  test('bağlı kaydı olan cari silinemez ve sebebi doğru yazar', async () => {
    const liste = json(await app.inject({
      method: 'GET', url: '/core/partners?q=Alfa&limit=1', headers: as(USERS.merve) }));
    const id = (liste.data as { id: string }[])[0]!.id;
    const res = await app.inject({
      method: 'DELETE', url: `/core/partners/${id}`, headers: as(USERS.merve) });
    assert.equal(res.statusCode, 409);
    assert.match(json(res).error.message, /bağlı .*kayıtları var/i);
    assert.doesNotMatch(json(res).error.message, /bulunamadı/i);
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

  // Destek erişimi KİRACIYA DARALTILMIŞTIR. Yalnızca destek modunu açmak
  // yetmez; hangi kiracıya bakıldığı da seçilmelidir. Seçilmemişse hiçbir şey
  // görünmez: yanlışlıkla tüm müşterilerin verisini açmanın önündeki engel bu.
  test('destek modu açık ama kiracı seçilmemişse veri görünmez', async () => {
    const res = json(await app.inject({
      method: 'GET', url: '/crm/leads?limit=100',
      headers: as(USERS.sezra, { 'x-support-mode': 'on' }) }));
    assert.equal(res.meta.total, 0);
  });

  // TEK FAKTÖR YETMEZ (T-009): platform admini token'ı + destek başlıkları +
  // kiracı seçimi, tek başına o kiracının verisini AÇMAZ. Canlı bir
  // core.support_grants kaydı gerekir; yoksa erişim reddedilir.
  test('canlı destek izni yoksa kiracı seçili olsa da veri görünmez', async () => {
    const me = json(await app.inject({
      method: 'GET', url: '/me', headers: as(USERS.merve) }));
    const tenantId = me.tenant.id as string;

    await sql`delete from core.support_grants where admin_user_id = ${USERS.sezra}`;

    const res = json(await app.inject({
      method: 'GET', url: '/crm/leads?limit=100',
      headers: as(USERS.sezra, { 'x-support-mode': 'on', 'x-tenant-id': tenantId }) }));
    assert.equal(res.meta.total, 0, 'izin yokken destek yolu erişim vermemeli');

    const acc = json(await app.inject({
      method: 'GET', url: '/finance/accounts?limit=500',
      headers: as(USERS.sezra, { 'x-support-mode': 'on', 'x-tenant-id': tenantId }) }));
    assert.equal(acc.meta.total, 0, 'izin yokken hesap planı da görünmemeli');
  });

  test('kiracı seçilince VE canlı izin varken YALNIZCA o kiracının verisi görünür', async () => {
    const me = json(await app.inject({
      method: 'GET', url: '/me', headers: as(USERS.merve) }));
    const tenantId = me.tenant.id as string;

    await sql`
      insert into core.support_grants (admin_user_id, tenant_id, reason, granted_by, expires_at)
      values (${USERS.sezra}, ${tenantId}, 'DESTEK-API uctan uca testi', ${USERS.sezra},
              now() + interval '1 hour')`;

    try {
      const res = json(await app.inject({
        method: 'GET', url: '/crm/leads?limit=100',
        headers: as(USERS.sezra, { 'x-support-mode': 'on', 'x-tenant-id': tenantId }) }));
      assert.ok(res.meta.total >= 5, `fırsat bekleniyordu, gelen: ${res.meta.total}`);

      // Her iki kiracıda da hesap planı var; kapsam daralmasaydı iki kiracının
      // hesapları birden gelirdi.
      const acc = json(await app.inject({
        method: 'GET', url: '/finance/accounts?limit=500',
        headers: as(USERS.sezra, { 'x-support-mode': 'on', 'x-tenant-id': tenantId }) }));
      assert.equal(acc.meta.total, 63, 'destek oturumu tek kiracıyla sınırlı olmalı');
    } finally {
      await sql`delete from core.support_grants where admin_user_id = ${USERS.sezra}`;
    }
  });
});

// =============================================================================
// TCMB kur ayrıştırıcısı
//
// Durum çubuğundaki kur dışarıdan gelen bir belgeden okunuyor. Belgenin biçimi
// değişirse ya da TCMB bir hata sayfası döndürürse, ayrıştırıcı SESSİZCE
// yanlış sayı üretmemeli: `null` dönmeli ki çağıran taraf veriyi hiç yazmasın.
// Testler ağ ERİŞİMİ İSTEMEZ; girdi elle verilir.
// =============================================================================
describe('TCMB kur ayrıştırıcısı', () => {
  const ORNEK = `<?xml version="1.0" encoding="UTF-8"?>
<Tarih_Date Tarih="03.09.2026" Date="09/03/2026"  Bulten_No="2026/165" >
  <Currency CrossOrder="0" Kod="USD" CurrencyCode="USD">
    <Unit>1</Unit><Isim>ABD DOLARI</Isim>
    <ForexBuying>48.2238</ForexBuying><ForexSelling>48.3107</ForexSelling>
    <BanknoteBuying>48.1900</BanknoteBuying><BanknoteSelling>48.3831</BanknoteSelling>
  </Currency>
  <Currency CrossOrder="9" Kod="EUR" CurrencyCode="EUR">
    <Unit>1</Unit><Isim>EURO</Isim>
    <ForexBuying>55.9800</ForexBuying><ForexSelling>56.0722</ForexSelling>
    <BanknoteBuying>55.9400</BanknoteBuying><BanknoteSelling>56.1563</BanknoteSelling>
  </Currency>
</Tarih_Date>`;

  test('bülten tarihini ISO biçimine çevirir', async () => {
    const { parseTcmb } = await import('@sezra/core');
    assert.equal(parseTcmb(ORNEK)?.bulletinDate, '2026-09-03');
    assert.equal(parseTcmb(ORNEK)?.bulletinNo, '2026/165');
  });

  test('satış kurlarını doğru okur', async () => {
    const { parseTcmb } = await import('@sezra/core');
    const usd = parseTcmb(ORNEK)?.rates.find((r) => r.currency === 'USD');
    const eur = parseTcmb(ORNEK)?.rates.find((r) => r.currency === 'EUR');
    assert.equal(usd?.forexSelling, 48.3107);
    assert.equal(eur?.forexSelling, 56.0722);
    assert.equal(usd?.unit, 1);
  });

  test('bozuk ya da beklenmedik girdide null döner — asla uydurma sayı', async () => {
    const { parseTcmb } = await import('@sezra/core');
    for (const girdi of [
      '',
      '<html><body>Sayfa bulunamadı</body></html>',
      '<Tarih_Date><Currency Kod="USD"><ForexSelling>1</ForexSelling></Currency></Tarih_Date>', // tarih yok
      '<Tarih_Date Tarih="03.09.2026"></Tarih_Date>',                                          // kur yok
    ]) {
      assert.equal(parseTcmb(girdi), null, `girdi reddedilmeliydi: ${girdi.slice(0, 40)}`);
    }
  });

  test('sayısal olmayan alan null olur, sıfır DEĞİL', async () => {
    const { parseTcmb } = await import('@sezra/core');
    const bozuk = ORNEK.replace('<ForexSelling>48.3107</ForexSelling>', '<ForexSelling></ForexSelling>');
    const usd = parseTcmb(bozuk)?.rates.find((r) => r.currency === 'USD');
    assert.equal(usd?.forexSelling, null);
  });
});

// =============================================================================
// Hesap makinesi aritmetiği
//
// Üst çubuktaki hesap makinesinin mantığı SAF bir indirgeyicidir ve arayüzden
// bağımsız sınanır: bir hesap makinesinin doğruluğu göz kararı onaylanacak
// bir şey değildir. KDV senaryoları özellikle önemli — kullanıcı bu sayıyı
// faturaya yazacak.
// =============================================================================
describe('hesap makinesi', () => {
  const yukle = () => import('../../web/src/lib/hesap.ts');
  type Eylem = Parameters<Awaited<ReturnType<typeof yukle>>['hesapIndirge']>[1];

  const calistir = async (...eylemler: Eylem[]) => {
    const { hesapIndirge, BASLANGIC } = await yukle();
    return eylemler.reduce((d, e) => hesapIndirge(d, e), BASLANGIC).ekran;
  };
  const r = (d: string) => ({ tur: 'rakam', d }) as Eylem;
  const op = (o: '+' | '-' | '*' | '/') => ({ tur: 'islem', op: o }) as Eylem;
  const esit = { tur: 'esittir' } as Eylem;

  test('dört işlem', async () => {
    assert.equal(await calistir(r('1'), r('2'), op('+'), r('3'), r('4'), esit), '46');
    assert.equal(await calistir(r('9'), op('*'), r('8'), esit), '72');
    assert.equal(await calistir(r('1'), r('0'), r('0'), op('/'), r('4'), esit), '25');
    assert.equal(await calistir(r('5'), r('0'), op('-'), r('7'), r('5'), esit), '-25');
  });

  test('zincirleme işlem ara sonucu biriktirir', async () => {
    assert.equal(await calistir(r('2'), op('+'), r('3'), op('+'), r('4'), esit), '9');
  });

  test('sıfıra bölme sayı değil HATA döner', async () => {
    assert.equal(await calistir(r('1'), r('0'), op('/'), r('0'), esit), 'Hata');
  });

  test('KDV ekleme ve ayırma birbirinin tersidir', async () => {
    for (const oran of [1, 10, 18, 20]) {
      const brut = await calistir(r('1'), r('0'), r('0'), { tur: 'kdvEkle', oran } as Eylem);
      const matrah = await calistir(
        ...[...brut.replace(',', '.')].map((c) => r(c === '.' ? ',' : c)),
        { tur: 'kdvAyir', oran } as Eylem,
      );
      assert.equal(matrah, '100', `oran %${oran}: ${brut} -> ${matrah}`);
    }
  });

  /**
   * Kayan nokta artığı biçimi bozmamalı: 100 × 1,1 bellekte tam 110 değildir
   * ve ham değere bakılırsa "110,00", 100 × 1,2 için "120" yazılır. Aynı
   * işlemin iki farklı biçimde görünmesi hesap makinesine güveni bitirir.
   */
  test('ondalık biçimi tutarlı', async () => {
    assert.equal(await calistir(r('1'), r('0'), r('0'), { tur: 'kdvEkle', oran: 10 } as Eylem), '110');
    assert.equal(await calistir(r('1'), r('0'), r('0'), { tur: 'kdvEkle', oran: 20 } as Eylem), '120');
    assert.equal(await calistir(r('1'), r(','), r('5'), op('+'), r('2'), r(','), r('5'), esit), '4');
  });

  test('ikinci ondalık ayırıcı yok sayılır', async () => {
    assert.equal(await calistir(r('1'), r(','), r('5'), r(','), r('7')), '1,57');
  });
});

// =============================================================================
// Profil görseli
//
// Bu ucu HER kullanıcı çağırabilir; istemcideki kontrol bir kolaylık, sınır
// değildir. Doğrulanmasaydı bir kullanıcı buraya belge türü ya da megabaytlarca
// veri yazabilirdi -- ve o değer `/me` ile her istekte taşınır.
// =============================================================================
describe('profil görseli', () => {
  const PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJ'
    + 'AAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

  const yaz = (avatar: unknown) => app.inject({
    method: 'PATCH', url: '/core/profile',
    headers: { ...as(USERS.merve), 'content-type': 'application/json' },
    payload: { avatar_url: avatar },
  });

  test('geçerli PNG kabul edilir', async () => {
    const res = await yaz(PNG);
    assert.equal(res.statusCode, 200);
    assert.equal(json(res).data.avatar_url, PNG);
  });

  test('SVG reddedilir — belge türüdür ve buraya herkes yazabilir', async () => {
    const res = await yaz('data:image/svg+xml;base64,PHN2Zz48L3N2Zz4=');
    assert.equal(res.statusCode, 400);
  });

  test('HTML belgesi reddedilir', async () => {
    assert.equal((await yaz('data:text/html;base64,PGgxPng8L2gxPg==')).statusCode, 400);
  });

  test('dış bağlantı reddedilir', async () => {
    assert.equal((await yaz('https://ornek.test/a.png')).statusCode, 400);
  });

  test('boyut sınırı uygulanır', async () => {
    const buyuk = `data:image/png;base64,${Buffer.alloc(300 * 1024, 'x').toString('base64')}`;
    assert.equal((await yaz(buyuk)).statusCode, 400);
  });

  test('null görseli kaldırır', async () => {
    const res = await yaz(null);
    assert.equal(res.statusCode, 200);
    assert.equal(json(res).data.avatar_url, null);
  });

  /**
   * Doğrulama YALNIZCA profil ucunda olmalı: aynı kod kalıbı şirket ayarları
   * ucunda da var ve doğrulama bir ara sürümde yanlışlıkla oraya konmuştu.
   * O hâlde profil görseli hiç denetlenmiyor, şirket ayarları ise avatar
   * alanı yokken bile kontrol ediliyordu.
   */
  test('şirket ayarları profil doğrulamasından etkilenmez', async () => {
    const res = await app.inject({
      method: 'PATCH', url: '/core/tenant',
      headers: { ...as(USERS.merve), 'content-type': 'application/json' },
      payload: { name: 'Örnek Ticaret A.Ş.' },
    });
    assert.equal(res.statusCode, 200);
  });
});

// =============================================================================
// ÇEK / SENET, SMS ve MÜŞTERİ PORTALI — HTTP katmanı
//
// Kuralların KENDİSİ veritabanında sınanıyor (supabase/tests/01_rls_isolation).
// Buradaki testler HTTP katmanının o kuralları doğru TAŞIDIĞINI gösterir:
// doğru durum kodu, sızmayan alan, tek seferlik jeton. İkisi ayrı sorular ve
// ayrı ayrı bozulabilirler.
// =============================================================================
describe('çek / senet', () => {
  let cari: string;
  let cek: string;

  before(async () => {
    const liste = json(await app.inject({
      method: 'GET', url: '/core/partners?limit=1', headers: as(USERS.merve),
    }));
    cari = liste.data[0].id;
  });

  test('çek oluşturulur ve portföyde açılır', async () => {
    const res = await app.inject({
      method: 'POST', url: '/finance/notes',
      headers: { ...as(USERS.merve), 'content-type': 'application/json' },
      payload: {
        direction: 'in', kind: 'cek', partner_id: cari,
        issue_date: '2026-01-05', due_date: '2026-03-05',
        amount: 12500, currency: 'TRY', bank_name: 'Ziraat Bankası',
      },
    });
    assert.equal(res.statusCode, 201);
    const d = json(res).data;
    assert.equal(d.status, 'portfoy');
    // NUMARA SUNUCUDA VERİLİR: istemciden gelen bir numara mükerrer olabilir.
    assert.match(d.number, /^CEK-/);
    cek = d.id;
  });

  test('durum istemciden YAZILAMAZ — alan açıkça reddedilir', async () => {
    const res = await app.inject({
      method: 'POST', url: '/finance/notes',
      headers: { ...as(USERS.merve), 'content-type': 'application/json' },
      payload: {
        direction: 'in', kind: 'senet', partner_id: cari,
        issue_date: '2026-01-05', due_date: '2026-02-05',
        amount: 1000, currency: 'TRY', status: 'tahsil_edildi',
      },
    });
    // SESSİZCE YOK SAYMAK DEĞİL, REDDETMEK: istemci gönderdiği alanın
    // uygulanmadığını öğrenmeli. Yok sayılsaydı, arayüz durumu yazdığını
    // sanıp yanlış ekran gösterirdi.
    assert.equal(res.statusCode, 400);
    assert.match(json(res).error.message, /status/);
  });

  test('geçersiz geçiş 422 döner, 500 değil', async () => {
    await app.inject({
      method: 'POST', url: `/finance/notes/${cek}/status`,
      headers: { ...as(USERS.merve), 'content-type': 'application/json' },
      payload: { status: 'tahsil_edildi' },
    });
    const res = await app.inject({
      method: 'POST', url: `/finance/notes/${cek}/status`,
      headers: { ...as(USERS.merve), 'content-type': 'application/json' },
      payload: { status: 'ciro_edildi', endorsed_to_id: cari },
    });
    assert.equal(res.statusCode, 422);
    assert.match(json(res).error.message, /geçilemez/);
  });

  test('başka kiracı bu çeki göremez', async () => {
    const res = await app.inject({
      method: 'GET', url: `/finance/notes/${cek}`, headers: as(USERS.rakip),
    });
    assert.equal(res.statusCode, 404);
  });
});

describe('SMS', () => {
  let cari: string;

  before(async () => {
    const liste = json(await app.inject({
      method: 'GET', url: '/core/partners?limit=1', headers: as(USERS.merve),
    }));
    cari = liste.data[0].id;
  });

  test('ayar ucu parolayı GERİ VERMEZ, yalnızca tanımlı olduğunu söyler', async () => {
    const yaz = await app.inject({
      method: 'POST', url: '/core/sms/settings',
      headers: { ...as(USERS.merve), 'content-type': 'application/json' },
      payload: { provider: 'log', sender: 'SEZRA', username: 'u', password: 'gizli' },
    });
    assert.equal(yaz.statusCode, 200);

    const oku = json(await app.inject({
      method: 'GET', url: '/core/sms/settings', headers: as(USERS.merve),
    })).data;
    assert.equal(oku.password_set, true);
    assert.equal(oku.password, undefined);
    assert.equal(JSON.stringify(oku).includes('gizli'), false);
  });

  test('boş parola mevcudu SİLMEZ — kaydet düğmesi parolayı kaybettiremez', async () => {
    await app.inject({
      method: 'POST', url: '/core/sms/settings',
      headers: { ...as(USERS.merve), 'content-type': 'application/json' },
      payload: { provider: 'log', sender: 'YENI', username: 'u', password: '' },
    });
    const oku = json(await app.inject({
      method: 'GET', url: '/core/sms/settings', headers: as(USERS.merve),
    })).data;
    assert.equal(oku.sender, 'YENI');
    assert.equal(oku.password_set, true);
  });

  test('izinsiz ticari ileti 422 döner ve kaydı durur', async () => {
    await app.inject({
      method: 'PATCH', url: `/core/partners/${cari}`,
      headers: { ...as(USERS.merve), 'content-type': 'application/json' },
      payload: { phone: '05321234567', consent_sms: false },
    });
    const res = await app.inject({
      method: 'POST', url: '/core/sms/send',
      headers: { ...as(USERS.merve), 'content-type': 'application/json' },
      payload: { partner_id: cari, body: 'kampanya', is_commercial: true },
    });
    // 200 DÖNMEZ: arayüz "gönderildi" diye kapanırsa kullanıcı mesajın
    // gitmediğini hiç öğrenmez.
    assert.equal(res.statusCode, 422);
    assert.equal(json(res).data.status, 'blocked');
    assert.match(json(res).data.error, /İYS/);
  });

  test('izin verilince gönderilir ve sağlayıcı kayda yazılır', async () => {
    await app.inject({
      method: 'PATCH', url: `/core/partners/${cari}`,
      headers: { ...as(USERS.merve), 'content-type': 'application/json' },
      payload: { consent_sms: true },
    });
    const res = await app.inject({
      method: 'POST', url: '/core/sms/send',
      headers: { ...as(USERS.merve), 'content-type': 'application/json' },
      payload: { partner_id: cari, body: 'kampanya', is_commercial: true },
    });
    assert.equal(res.statusCode, 200);
    const d = json(res).data;
    assert.equal(d.status, 'sent');
    // Yanıt `sms_mark` sonrası YENİDEN OKUNUR: elde birleştirilen yanıt
    // sağlayıcıyı null gösterirken kayıtta 'log' yazıyordu.
    assert.equal(d.provider, 'log');
    assert.equal(d.phone, '+905321234567');
  });

  test('gövdesiz istek 400 döner', async () => {
    const res = await app.inject({
      method: 'POST', url: '/core/sms/send',
      headers: { ...as(USERS.merve), 'content-type': 'application/json' },
      payload: { partner_id: cari, body: '   ' },
    });
    assert.equal(res.statusCode, 400);
  });
});

describe('müşteri portalı', () => {
  let cari: string;
  let davet: string;
  let jeton: string;

  before(async () => {
    const liste = json(await app.inject({
      method: 'GET', url: '/core/partners?limit=1', headers: as(USERS.merve),
    }));
    cari = liste.data[0].id;
  });

  test('davet oluşturulur ve jeton BİR KEZ döner', async () => {
    const res = await app.inject({
      method: 'POST', url: `/core/partners/${cari}/portal-invitations`,
      headers: { ...as(USERS.merve), 'content-type': 'application/json' },
      payload: { email: 'portal-api@ornek.test', days: 14 },
    });
    assert.equal(res.statusCode, 201);
    const d = json(res).data;
    assert.ok(typeof d.token === 'string' && d.token.length > 30);
    davet = d.id;
    jeton = d.token;
  });

  test('listeleme jetonu GERİ VERMEZ', async () => {
    const res = await app.inject({
      method: 'GET', url: `/core/partners/${cari}/portal-invitations`,
      headers: as(USERS.merve),
    });
    assert.equal(res.statusCode, 200);
    const govde = res.body;
    assert.equal(govde.includes(jeton), false);
    assert.equal(govde.includes('token_hash'), false);
    const satir = json(res).data.find((r: { id: string }) => r.id === davet);
    assert.equal(satir.status, 'pending');
  });

  test('süre sınırı dışındaki gün reddedilir', async () => {
    const res = await app.inject({
      method: 'POST', url: `/core/partners/${cari}/portal-invitations`,
      headers: { ...as(USERS.merve), 'content-type': 'application/json' },
      payload: { email: 'uzun@ornek.test', days: 365 },
    });
    assert.equal(res.statusCode, 400);
  });

  test('personel adresine portal daveti gönderilemez', async () => {
    // Bu adres kiracıda zaten bir kullanıcıya ait; kabul edilseydi o kişinin
    // personel üyeliği portal üyeliğine dönerdi.
    const me = json(await app.inject({
      method: 'GET', url: '/me', headers: as(USERS.merve),
    }));
    const res = await app.inject({
      method: 'POST', url: `/core/partners/${cari}/portal-invitations`,
      headers: { ...as(USERS.merve), 'content-type': 'application/json' },
      payload: { email: me.user.email },
    });
    assert.equal(res.statusCode, 409);
  });

  test('başka kiracı bu daveti iptal edemez', async () => {
    const res = await app.inject({
      method: 'POST', url: `/core/portal/invitations/${davet}/revoke`,
      headers: as(USERS.rakip),
    });
    assert.equal(res.statusCode, 404);
  });

  test('davet iptal edilir', async () => {
    const res = await app.inject({
      method: 'POST', url: `/core/portal/invitations/${davet}/revoke`,
      headers: as(USERS.merve),
    });
    assert.equal(res.statusCode, 200);
    assert.equal(json(res).data.status, 'revoked');
  });

  test('iptal edilmiş davet kabul edilemez', async () => {
    const res = await app.inject({
      method: 'POST', url: '/portal/accept',
      headers: { ...as(USERS.rakip), 'content-type': 'application/json' },
      payload: { token: jeton },
    });
    // 422: kural ihlali (check_violation). 409 mükerrer kayıt içindir --
    // "bu adrese açık davet zaten var" gibi.
    assert.equal(res.statusCode, 422);
    assert.match(json(res).error.message, /iptal/);
  });

  test('geçersiz jeton 404 döner', async () => {
    const res = await app.inject({
      method: 'POST', url: '/portal/accept',
      headers: { ...as(USERS.rakip), 'content-type': 'application/json' },
      payload: { token: 'olmayan-jeton' },
    });
    assert.equal(res.statusCode, 404);
  });

  /* --- Kabul akışının tamamı: davet -> özet -> kabul -> portal oturumu --- */
  test('davet kabul edilir ve kullanıcı portal oturumuna geçer', async () => {
    const yeni = await app.inject({
      method: 'POST', url: `/core/partners/${cari}/portal-invitations`,
      headers: { ...as(USERS.merve), 'content-type': 'application/json' },
      payload: { email: 'kabul-testi@ornek.test' },
    });
    const tok = json(yeni).data.token as string;

    // ÖZET KABUL ETMEDEN OKUNUR: kabul ekranı hangi firmaya bağlanılacağını
    // yazabilmeli, yoksa kullanıcı çıplak bir jetonu onaylar.
    const yeniKullanici = '99999999-9999-4999-8999-999999999901';
    const ozet = await app.inject({
      method: 'GET', url: `/portal/invitations/${tok}`, headers: as(yeniKullanici),
    });
    assert.equal(ozet.statusCode, 200);
    assert.equal(typeof json(ozet).data.partner_name, 'string');

    const kabul = await app.inject({
      method: 'POST', url: '/portal/accept',
      headers: { ...as(yeniKullanici), 'content-type': 'application/json' },
      payload: { token: tok, full_name: 'Portal Kullanıcısı' },
    });
    assert.equal(kabul.statusCode, 200);
    // KİMLİK OTURUMDAN ALINIR, gövdeden değil: bağlantıyı ele geçiren biri
    // daveti başka bir hesaba bağlayamamalı.
    assert.equal(json(kabul).data.portal_user_id, yeniKullanici);

    const me = json(await app.inject({
      method: 'GET', url: '/me', headers: as(yeniKullanici),
    }));
    assert.equal(me.portal.partner_id, cari);
    assert.equal(me.permissions.length, 0);
    // Şube ve modül listesi müşteriye GİTMEZ: satıcının iç yapısını anlatır.
    assert.deepEqual(me.branches, []);
    assert.deepEqual(me.modules, []);

    // Kabul edilmiş davetin özeti artık okunamaz.
    const tekrar = await app.inject({
      method: 'GET', url: `/portal/invitations/${tok}`, headers: as(yeniKullanici),
    });
    assert.equal(tekrar.statusCode, 404);
  });

  test('portal kullanıcısı yalnızca kendi belgelerini görür, yazamaz', async () => {
    const pu = '99999999-9999-4999-8999-999999999901';
    const cariler = json(await app.inject({
      method: 'GET', url: '/core/partners?limit=50', headers: as(pu),
    }));
    assert.equal(cariler.data.length, 1);
    assert.equal(cariler.data[0].id, cari);

    // Personel verisi görünmez.
    const personel = json(await app.inject({
      method: 'GET', url: '/hr/employees?limit=50', headers: as(pu),
    }));
    assert.equal(personel.data.length, 0);

    // YAZMA HER YERDE KAPALI: politikalar yalnızca SELECT içindir.
    const yaz = await app.inject({
      method: 'PATCH', url: `/core/partners/${cari}`,
      headers: { ...as(pu), 'content-type': 'application/json' },
      payload: { notes: 'portal yazdi' },
    });
    assert.ok(yaz.statusCode >= 400, `yazma engellenmedi: ${yaz.statusCode}`);
  });

  test('profilsiz kimliğe /me yarım nesne DÖNMEZ, user null der', async () => {
    // Kimlik sağlayıcısında hesabı olan ama hiçbir kiracıya bağlanmamış kişi.
    // Alanı hiç yazmamak `user` anahtarını yanıttan sessizce düşürüyordu ve
    // istemci `user.email` okuyup çöküyordu.
    const res = await app.inject({
      method: 'GET', url: '/me',
      headers: as('99999999-9999-4999-8999-999999999902'),
    });
    assert.equal(res.statusCode, 200);
    assert.ok('user' in json(res));
    assert.equal(json(res).user, null);
  });

  test('/me portal oturumunda firmayı söyler, personelde null', async () => {
    const me = json(await app.inject({
      method: 'GET', url: '/me', headers: as(USERS.merve),
    }));
    assert.equal(me.portal, null);
  });
});

// ===========================================================================
// T-033 — ürün/cari kart alanları (1.1) + pasif cari/ürün seçim engeli (1.2)
// ===========================================================================
describe('T-033 kart 1.1: ürün/cari eksik kart alanları', () => {
  let cariId = '';
  let urunId = '';

  test('cari currency yazılır ve hem kayıtta hem listede döner', async () => {
    const c = json(await app.inject({
      method: 'POST', url: '/core/partners', headers: as(USERS.merve),
      payload: { name: 'T033 Kart Cari', is_customer: true, currency: 'EUR' } }));
    cariId = (c.data as { id: string }).id;
    assert.equal(c.data.currency, 'EUR', 'oluşturma yanıtı currency döndürmeli');

    const tekil = json(await app.inject({
      method: 'GET', url: `/core/partners/${cariId}`, headers: as(USERS.merve) }));
    assert.equal(tekil.data.currency, 'EUR', 'v_partner_list currency kolonunu taşımalı');
  });

  test('ürün artikel_no ve shelf_location yazılıp okunur', async () => {
    const p = json(await app.inject({
      method: 'POST', url: '/core/products', headers: as(USERS.merve),
      payload: { sku: 'T033-KART-1', name: 'T033 Kart Ürün', kind: 'stockable',
                 artikel_no: 'ART-9001', shelf_location: 'A-12-3' } }));
    urunId = (p.data as { id: string }).id;
    assert.equal(p.data.artikel_no, 'ART-9001');
    assert.equal(p.data.shelf_location, 'A-12-3');
  });

  test('temizlik', async () => {
    await app.inject({ method: 'DELETE', url: `/core/products/${urunId}`, headers: as(USERS.merve) });
    await app.inject({ method: 'DELETE', url: `/core/partners/${cariId}`, headers: as(USERS.merve) });
  });
});

describe('T-033 kart 1.2: pasif cari/ürün yeni işlemde seçilemez', () => {
  let cariId = '';
  let urunId = '';
  let teklifId = '';
  let satirId = '';

  test('hazırlık: aktif cari + ürün + onlarla bir taslak teklif', async () => {
    const c = json(await app.inject({
      method: 'POST', url: '/core/partners', headers: as(USERS.merve),
      payload: { name: 'T033 Pasif Cari', is_customer: true } }));
    cariId = (c.data as { id: string }).id;

    const p = json(await app.inject({
      method: 'POST', url: '/core/products', headers: as(USERS.merve),
      payload: { sku: 'T033-PASIF-1', name: 'T033 Pasif Ürün', kind: 'stockable' } }));
    urunId = (p.data as { id: string }).id;

    const q = json(await app.inject({
      method: 'POST', url: '/crm/quotations', headers: as(USERS.merve),
      payload: { partner_id: cariId, issue_date: '2026-02-01', currency: 'TRY' } }));
    teklifId = (q.data as { id: string }).id;

    const l = await app.inject({
      method: 'POST', url: '/crm/quotation-lines', headers: as(USERS.merve),
      payload: { quotation_id: teklifId, sequence: 10, product_id: urunId,
                 description: 'aktifken eklenen satır', quantity: 2 } });
    assert.equal(l.statusCode, 201, 'aktif ürünle satır eklenebilmeli');
    satirId = (json(l).data as { id: string }).id;
  });

  test('pasif ürün YENİ satırda seçilemez (422 check_violation)', async () => {
    const d = await app.inject({
      method: 'PATCH', url: `/core/products/${urunId}`, headers: as(USERS.merve),
      payload: { is_active: false } });
    assert.equal(d.statusCode, 200);

    const res = await app.inject({
      method: 'POST', url: '/crm/quotation-lines', headers: as(USERS.merve),
      payload: { quotation_id: teklifId, sequence: 20, product_id: urunId,
                 description: 'pasif ürün', quantity: 1 } });
    assert.equal(res.statusCode, 422);
    assert.equal(json(res).error.code, 'check_violation');
    assert.match(json(res).error.message, /[Pp]asif ürün/);
  });

  test('pasif cariyle YENİ teklif açılamaz (422)', async () => {
    const d = await app.inject({
      method: 'PATCH', url: `/core/partners/${cariId}`, headers: as(USERS.merve),
      payload: { is_active: false } });
    assert.equal(d.statusCode, 200);

    const res = await app.inject({
      method: 'POST', url: '/crm/quotations', headers: as(USERS.merve),
      payload: { partner_id: cariId, issue_date: '2026-02-05', currency: 'TRY' } });
    assert.equal(res.statusCode, 422);
    assert.match(json(res).error.message, /[Pp]asif cari/);
  });

  test('GEÇMİŞ belge pasifleştirmeden etkilenmez: okunur ve ref-dışı alan güncellenir', async () => {
    const q = await app.inject({
      method: 'GET', url: `/crm/quotations/${teklifId}`, headers: as(USERS.merve) });
    assert.equal(q.statusCode, 200, 'geçmiş teklif hâlâ okunmalı');

    const notUpd = await app.inject({
      method: 'PATCH', url: `/crm/quotations/${teklifId}`, headers: as(USERS.merve),
      payload: { notes: 'pasifleştirme sonrası düzenleme' } });
    assert.equal(notUpd.statusCode, 200, 'geçmiş belgede not güncellenebilmeli');

    const satirUpd = await app.inject({
      method: 'PATCH', url: `/crm/quotation-lines/${satirId}`, headers: as(USERS.merve),
      payload: { quantity: 5 } });
    assert.equal(satirUpd.statusCode, 200, 'pasif ürünlü geçmiş satırda miktar güncellenebilmeli');
  });

  test('pasif cari ve ürün raporlarda/listede görünmeye devam eder', async () => {
    const cariler = json(await app.inject({
      method: 'GET', url: '/core/partners?is_active=false&limit=200', headers: as(USERS.merve) }));
    assert.ok((cariler.data as { id: string }[]).some((x) => x.id === cariId),
      'pasif cari is_active=false raporunda görünmeli');

    const urunler = json(await app.inject({
      method: 'GET', url: '/core/products?is_active=false&limit=200', headers: as(USERS.merve) }));
    assert.ok((urunler.data as { id: string }[]).some((x) => x.id === urunId),
      'pasif ürün is_active=false raporunda görünmeli');
  });

  test('temizlik', async () => {
    await app.inject({ method: 'DELETE', url: `/crm/quotations/${teklifId}`, headers: as(USERS.merve) });
    await app.inject({ method: 'DELETE', url: `/core/products/${urunId}`, headers: as(USERS.merve) });
    await app.inject({ method: 'DELETE', url: `/core/partners/${cariId}`, headers: as(USERS.merve) });
  });
});
