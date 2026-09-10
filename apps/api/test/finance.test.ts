/**
 * Muhasebe API testleri.
 *
 * api.test.ts'in bıraktığı durumdan devam eder: onaylanmış bir satış siparişi
 * ve kuyrukta bekleyen sales.order.confirmed olayı vardır. Bu dosya gerçek
 * EventWorker'ı çalıştırır — olayın faturaya dönüşmesi taklit edilmez.
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

const USERS = {
  merve: '22222222-2222-2222-2222-222222222222',
  ali:   '33333333-3333-3333-3333-333333333333',
  deniz: '44444444-4444-4444-4444-444444444444',
  rakip: '55555555-5555-5555-5555-555555555555',
} as const;

let app: FastifyInstance;
let closeDb: () => Promise<void>;
let invoiceId: string;

const as = (user: string) => ({ 'x-user-id': user });
const json = (res: { body: string }) => JSON.parse(res.body);
const get = async (url: string, user: string) =>
  json(await app.inject({ method: 'GET', url, headers: as(user) }));

before(async () => {
  const core = await import('@sezra/core');
  const { modules } = await import('../src/modules.ts');
  closeDb = core.closeDb;
  app = await core.createApp({ modules, logger: false });
  await app.ready();

  // Kuyruktaki olayları gerçek worker ile işle.
  //
  // İŞLENEN SAYISINA BAKILMAZ: geliştirici `npm run dev` ile API'yi açık
  // bırakmışsa oradaki EventWorker kuyruğu çoktan tüketmiş olur ve sayı sıfır
  // gelir. Önemli olan kuyruğun BOŞALMASI, bu çalıştırmada kaç olay işlendiği
  // değil — olayların sonucu zaten aşağıdaki testlerde doğrulanıyor
  // (03_finance.sql'deki aynı not).
  const worker = new core.EventWorker();
  await worker.drain();
});

after(async () => {
  await app.close();
  await closeDb();
});

describe('hesap planı', () => {
  test('Tekdüzen Hesap Planı kurulmuş', async () => {
    const res = await get('/finance/accounts?limit=500', USERS.merve);
    assert.equal(res.meta.total, 63);
    const codes = res.data.map((a: { code: string }) => a.code);
    for (const expected of ['100', '120', '191', '320', '360', '391', '600', '621', '770']) {
      assert.ok(codes.includes(expected), `${expected} hesabı olmalı`);
    }
  });

  test('grup hesapları is_leaf = false', async () => {
    const res = await get('/finance/accounts?code=12', USERS.merve);
    assert.equal(res.data[0].is_leaf, false);
  });

  test('hesap eşlemeleri tanımlı', async () => {
    const res = await get('/finance/settings/account-mappings', USERS.merve);
    const byKey = Object.fromEntries(res.data.map((m: { key: string; code: string }) => [m.key, m.code]));
    assert.equal(byKey.receivable, '120');
    assert.equal(byKey.vat_output, '391');
    assert.equal(byKey.sales_income, '600');
  });
});

describe('olay -> fatura', () => {
  test('onaylanan siparişten fatura taslağı üretildi', async () => {
    const res = await get('/finance/invoices?source_module=crm', USERS.merve);
    assert.equal(res.meta.total, 1);
    const inv = res.data[0];
    invoiceId = inv.id;
    assert.equal(inv.status, 'draft');
    assert.equal(inv.kind, 'sale');
    assert.equal(Number(inv.total), 140183);
    assert.equal(inv.partner_name, 'Alfa Sanayi Ltd. Şti.');
    assert.equal(Number(inv.line_count), 2);
  });

  test('CRM modülü Muhasebe tablolarına hiç dokunmadı — bağ yalnızca olay', async () => {
    const inv = (await get(`/finance/invoices/${invoiceId}/full`, USERS.merve)).data;
    assert.equal(inv.source_module, 'crm');
    assert.equal(inv.source_table, 'sale_orders');
    assert.ok(inv.source_id);
  });
});

describe('faturanın muhasebeleşmesi', () => {
  test('muhasebeleştir -> numara ve dengeli yevmiye kaydı', async () => {
    const res = await app.inject({
      method: 'POST', url: `/finance/invoices/${invoiceId}/post`, headers: as(USERS.merve) });
    assert.equal(res.statusCode, 200);
    const inv = json(res).data;
    assert.match(inv.number, /^SFT-\d{4}-\d{6}$/);
    assert.equal(inv.status, 'posted');

    const entry = (await get(`/finance/entries/${inv.journal_entry_id}/full`, USERS.merve)).data;
    assert.equal(Number(entry.total_debit), 140183);
    assert.equal(Number(entry.total_credit), 140183);
    assert.equal(entry.status, 'posted');

    const byAccount = Object.fromEntries(
      entry.lines.map((l: { account_code: string; debit: string; credit: string }) =>
        [l.account_code, { debit: Number(l.debit), credit: Number(l.credit) }]),
    );
    assert.equal(byAccount['120'].debit, 140183);   // ALICILAR
    assert.equal(byAccount['600'].credit, 136300);  // YURTİÇİ SATIŞLAR
    assert.equal(byAccount['391'].credit, 3883);    // HESAPLANAN KDV
  });

  test('muhasebeleşmiş faturanın satırı değiştirilemez', async () => {
    const inv = (await get(`/finance/invoices/${invoiceId}/full`, USERS.merve)).data;
    const res = await app.inject({
      method: 'PATCH', url: `/finance/invoice-lines/${inv.lines[0].id}`,
      headers: as(USERS.merve), payload: { quantity: 5 },
    });
    assert.equal(res.statusCode, 422);
  });

  test('yetkisiz kullanıcı muhasebeleştiremez', async () => {
    const res = await app.inject({
      method: 'POST', url: `/finance/invoices/${invoiceId}/post`, headers: as(USERS.ali) });
    assert.ok([403, 404].includes(res.statusCode), `beklenen 403/404, gelen ${res.statusCode}`);
  });
});

describe('tahsilat', () => {
  test('kısmi ve tam tahsilat fatura durumunu ilerletir', async () => {
    const partial = await app.inject({
      method: 'POST', url: `/finance/invoices/${invoiceId}/pay`,
      headers: as(USERS.merve), payload: { amount: 40183, method: 'bank' },
    });
    assert.equal(partial.statusCode, 200);
    assert.match(json(partial).data.number, /^TAH-/);

    let inv = (await get(`/finance/invoices/${invoiceId}`, USERS.merve)).data;
    assert.equal(inv.status, 'partially_paid');
    assert.equal(Number(inv.balance_due), 100000);

    const rest = await app.inject({
      method: 'POST', url: `/finance/invoices/${invoiceId}/pay`,
      headers: as(USERS.merve), payload: {},
    });
    assert.equal(rest.statusCode, 200);

    inv = (await get(`/finance/invoices/${invoiceId}`, USERS.merve)).data;
    assert.equal(inv.status, 'paid');
    assert.equal(Number(inv.balance_due), 0);
  });

  test('fazla tahsilat reddedilir', async () => {
    const res = await app.inject({
      method: 'POST', url: `/finance/invoices/${invoiceId}/pay`,
      headers: as(USERS.merve), payload: { amount: 1 },
    });
    assert.notEqual(res.statusCode, 200);
  });
});

describe('raporlar', () => {
  test('mizan dengeli', async () => {
    const res = await get('/finance/reports/trial-balance', USERS.merve);
    const debit = res.data.reduce((s: number, r: { debit_total: string }) => s + Number(r.debit_total), 0);
    const credit = res.data.reduce((s: number, r: { credit_total: string }) => s + Number(r.credit_total), 0);
    assert.equal(Math.round((debit - credit) * 100), 0);
  });

  test('kâr/zarar tablosu', async () => {
    const res = await get('/finance/reports/profit-loss?detail=1', USERS.merve);
    assert.equal(Number(res.data.summary.gross_revenue), 136300);
    assert.equal(Number(res.data.summary.net_profit), 136300);
    assert.ok(res.data.accounts.some((a: { code: string }) => a.code === '600'));
    assert.ok(res.data.by_branch.length >= 1);
  });

  test('KDV özeti', async () => {
    const res = await get('/finance/reports/vat', USERS.merve);
    const sale = res.data.filter((r: { kind: string }) => r.kind === 'sale');
    const total = sale.reduce((s: number, r: { tax_amount: string }) => s + Number(r.tax_amount), 0);
    assert.equal(total, 3883);
  });

  test('defter-i kebir 120 hesabında hareketleri gösterir', async () => {
    const accounts = await get('/finance/accounts?code=120', USERS.merve);
    const res = await get(
      `/finance/reports/general-ledger?account_id=${accounts.data[0].id}`, USERS.merve);
    assert.ok(res.data.length >= 3);   // fatura + iki tahsilat
    const last = res.data[res.data.length - 1];
    assert.equal(Math.round(Number(last.running_balance) * 100), 0);  // cari kapandı
  });

  test('ödenmiş fatura açık faturalardan çıkar', async () => {
    const res = await get('/finance/reports/open-invoices?kind=sale', USERS.merve);
    assert.equal(res.data.length, 0);
  });
});

describe('e-Fatura', () => {
  test('fatura entegratöre gönderilir ve durumu izlenir', async () => {
    const res = await app.inject({
      method: 'POST', url: `/finance/invoices/${invoiceId}/einvoice`,
      headers: as(USERS.merve), payload: {},
    });
    assert.equal(res.statusCode, 201);
    const doc = json(res).data;
    assert.equal(doc.provider, 'stub');
    assert.ok(doc.ettn, 'ETTN üretilmeli');
    // Müşterinin VKN'si 10 hane -> e-Fatura mükellefi -> TEMELFATURA
    assert.equal(doc.profile, 'TEMELFATURA');

    const list = await get(`/finance/invoices/${invoiceId}/einvoice`, USERS.merve);
    assert.equal(list.data.length, 1);
    assert.equal(list.data[0].status, 'sent');
  });

  test('alış faturası gönderilemez', async () => {
    const purchases = await get('/finance/invoices?kind=purchase', USERS.merve);
    if (purchases.data.length === 0) return;
    const res = await app.inject({
      method: 'POST', url: `/finance/invoices/${purchases.data[0].id}/einvoice`,
      headers: as(USERS.merve), payload: {},
    });
    assert.equal(res.statusCode, 400);
  });
});

describe('virman (hesaplar arası transfer)', () => {
  let transferId: string;
  let acc100: string;
  let acc102: string;

  before(async () => {
    const a = await get('/finance/accounts?limit=500', USERS.merve);
    acc100 = a.data.find((x: { code: string }) => x.code === '100').id;
    acc102 = a.data.find((x: { code: string }) => x.code === '102').id;
  });

  test('kasa -> banka virmanı tek adımda oluşur ve dengeli yevmiye kaydı üretir', async () => {
    const res = await app.inject({
      method: 'POST', url: '/finance/transfers/execute', headers: as(USERS.merve),
      payload: { source_account_id: acc100, dest_account_id: acc102, amount: 5000 },
    });
    assert.equal(res.statusCode, 201);
    const tr = json(res).data;
    transferId = tr.id;
    assert.match(tr.number, /^VIR-\d{4}-\d{6}$/);
    assert.equal(tr.status, 'posted');
    assert.equal(Number(tr.source_amount), 5000);
    assert.equal(Number(tr.dest_amount), 5000);

    const entry = (await get(`/finance/entries/${tr.journal_entry_id}/full`, USERS.merve)).data;
    assert.equal(Number(entry.total_debit), 5000);
    assert.equal(Number(entry.total_credit), 5000);
    const byAccount = Object.fromEntries(
      entry.lines.map((l: { account_code: string; debit: string; credit: string }) =>
        [l.account_code, { debit: Number(l.debit), credit: Number(l.credit) }]),
    );
    assert.equal(byAccount['102'].debit, 5000);   // BANKALAR giriş
    assert.equal(byAccount['100'].credit, 5000);  // KASA çıkış
  });

  test('mizan virmandan sonra hâlâ dengeli', async () => {
    const res = await get('/finance/reports/trial-balance', USERS.merve);
    const debit = res.data.reduce((s: number, r: { debit_total: string }) => s + Number(r.debit_total), 0);
    const credit = res.data.reduce((s: number, r: { credit_total: string }) => s + Number(r.credit_total), 0);
    assert.equal(Math.round((debit - credit) * 100), 0);
  });

  test('aynı hesaba virman reddedilir', async () => {
    const res = await app.inject({
      method: 'POST', url: '/finance/transfers/execute', headers: as(USERS.merve),
      payload: { source_account_id: acc100, dest_account_id: acc100, amount: 100 },
    });
    assert.notEqual(res.statusCode, 201);
  });

  test('yetkisiz kullanıcı virman yapamaz', async () => {
    const res = await app.inject({
      method: 'POST', url: '/finance/transfers/execute', headers: as(USERS.ali),
      payload: { source_account_id: acc100, dest_account_id: acc102, amount: 100 },
    });
    assert.ok([403, 404].includes(res.statusCode), `beklenen 403/404, gelen ${res.statusCode}`);
  });

  test('muhasebeleşmiş virman silinemez', async () => {
    const res = await app.inject({
      method: 'DELETE', url: `/finance/transfers/${transferId}`, headers: as(USERS.merve),
    });
    assert.ok([403, 404, 422].includes(res.statusCode), `beklenen 4xx, gelen ${res.statusCode}`);
  });

  test('iptal ters kayıt üretir, belge cancelled olur, mizan dengeli kalır', async () => {
    const res = await app.inject({
      method: 'POST', url: `/finance/transfers/${transferId}/cancel`,
      headers: as(USERS.merve), payload: { reason: 'yanlış hesap' },
    });
    assert.equal(res.statusCode, 200);
    assert.equal(json(res).data.status, 'cancelled');

    const tr = (await get(`/finance/transfers/${transferId}`, USERS.merve)).data;
    assert.equal(tr.status, 'cancelled');

    const tb = await get('/finance/reports/trial-balance', USERS.merve);
    const debit = tb.data.reduce((s: number, r: { debit_total: string }) => s + Number(r.debit_total), 0);
    const credit = tb.data.reduce((s: number, r: { credit_total: string }) => s + Number(r.credit_total), 0);
    assert.equal(Math.round((debit - credit) * 100), 0);
  });

  describe('çok para birimli virman', () => {
    let usdBankId: string;

    before(async () => {
      const res = await app.inject({
        method: 'POST', url: '/finance/bank-accounts', headers: as(USERS.merve),
        payload: { name: 'Döviz Kasa Bankası', currency: 'USD', account_id: acc102 },
      });
      assert.equal(res.statusCode, 201, `banka hesabı açılmalı, gelen ${res.statusCode}`);
      usdBankId = json(res).data.id;
    });

    test('kur ve hedef tutar ayrı kolonlarda saklanır, kayıt ana para biriminde dengeli', async () => {
      const res = await app.inject({
        method: 'POST', url: '/finance/transfers/execute', headers: as(USERS.merve),
        payload: {
          source_bank_account_id: usdBankId, dest_account_id: acc100,
          amount: 1000, exchange_rate: 40, dest_amount: 40000,
        },
      });
      assert.equal(res.statusCode, 201);
      const tr = json(res).data;
      assert.equal(tr.source_currency, 'USD');
      assert.equal(tr.dest_currency, 'TRY');
      assert.equal(Number(tr.source_amount), 1000);
      assert.equal(Number(tr.dest_amount), 40000);
      assert.equal(Number(tr.exchange_rate), 40);
      assert.equal(tr.status, 'posted');

      const entry = (await get(`/finance/entries/${tr.journal_entry_id}/full`, USERS.merve)).data;
      assert.equal(entry.currency, 'TRY');
      assert.equal(Number(entry.total_debit), 40000);
      assert.equal(Number(entry.total_credit), 40000);
      const byAccount = Object.fromEntries(
        entry.lines.map((l: { account_code: string; debit: string; credit: string }) =>
          [l.account_code, { debit: Number(l.debit), credit: Number(l.credit) }]),
      );
      assert.equal(byAccount['100'].debit, 40000);
      assert.equal(byAccount['102'].credit, 40000);
    });

    test('kur olmadan çok para birimli virman reddedilir', async () => {
      const res = await app.inject({
        method: 'POST', url: '/finance/transfers/execute', headers: as(USERS.merve),
        payload: { source_bank_account_id: usdBankId, dest_account_id: acc100, amount: 500 },
      });
      assert.equal(res.statusCode, 422);
    });

    test('kur ile tutarsız hedef tutar reddedilir', async () => {
      const res = await app.inject({
        method: 'POST', url: '/finance/transfers/execute', headers: as(USERS.merve),
        payload: {
          source_bank_account_id: usdBankId, dest_account_id: acc100,
          amount: 1000, exchange_rate: 40, dest_amount: 12345,
        },
      });
      assert.equal(res.statusCode, 422);
    });

    test('mizan çok para birimli virmandan sonra dengeli', async () => {
      const res = await get('/finance/reports/trial-balance', USERS.merve);
      const debit = res.data.reduce((s: number, r: { debit_total: string }) => s + Number(r.debit_total), 0);
      const credit = res.data.reduce((s: number, r: { credit_total: string }) => s + Number(r.credit_total), 0);
      assert.equal(Math.round((debit - credit) * 100), 0);
    });
  });
});

describe('izolasyon', () => {
  test('başka kiracı Örnek Ticaret muhasebesini göremez', async () => {
    const inv = await get('/finance/invoices', USERS.rakip);
    assert.equal(inv.meta.total, 0);
    const tb = await get('/finance/reports/trial-balance', USERS.rakip);
    assert.equal(tb.data.length, 0);
  });

  test('başka kiracı KENDİ hesap planını görür', async () => {
    const res = await get('/finance/accounts?limit=500', USERS.rakip);
    assert.equal(res.meta.total, 63);
  });

  test('satış temsilcisi muhasebe raporlarını göremez', async () => {
    const me = await get('/me', USERS.ali);
    assert.ok(!me.permissions.includes('finance.report.pl'));
    const pl = await get('/finance/reports/profit-loss', USERS.ali);
    assert.equal(pl.data.summary?.gross_revenue ?? null, null);
  });

  test('şube müdürü kendi şubesinin faturalarını görür, muhasebeleştiremez', async () => {
    const me = await get('/me', USERS.deniz);
    assert.ok(me.permissions.includes('finance.report.pl'));
    assert.ok(!me.permissions.includes('finance.invoice.post'));

    const inv = await get('/finance/invoices?limit=100', USERS.deniz);
    const withBranch = inv.data.filter((i: { branch_id: string | null }) => i.branch_id !== null);
    assert.equal(withBranch.length, 0, 'Düzce faturaları Zonguldak müdürüne görünmemeli');
  });
});
