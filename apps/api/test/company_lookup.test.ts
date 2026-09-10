/**
 * T-028: VKN'den firma bilgisi getirme -- HTTP + saglayici + guvenlik.
 *
 * Kanitlanan:
 *  1. Gecersiz VKN'de HIC istek atilmaz (saglayici cagrilmaz).
 *  2. 11 haneli TCKN -> ozel mesaj, sorgu yok.
 *  3. Bulunan bilgi TEMIZLENIR (HTML soyulur), forma yazilabilir alanlara cevrilir.
 *  4. Saglayici hatasi KULLANICIYA sizmaz (status kodu / saglayici adi / detail yok).
 *  5. Cache: ayni VKN kisa surede tekrar sorgulaninca saglayici bir kez cagrilir.
 *  6. Rate limit: pencerede N+1 sorgu -> 429.
 *  7. /core/company/providers configured bool doner, ANAHTAR donmez.
 *
 * SAHTE SAGLAYICI: gercek ag cagrisi YOK.
 */
process.env.AUTH_MODE ??= 'dev';
process.env.NODE_ENV = 'test';
process.env.COMPANY_LOOKUP_PROVIDER = 'fake';

import '../src/env.ts';
import { test, before, after, describe } from 'node:test';
import assert from 'node:assert/strict';
import type { FastifyInstance } from 'fastify';
import type { CompanyLookupOutcome } from '@sezra/core';

const USERS = { merve: '22222222-2222-2222-2222-222222222222' } as const;

// GIB sağlama toplamı tutan gerçek-gecerli VKN'ler (birim testte de dogrulaniyor).
const VKN_A = '1000000000';
const VKN_B = '1234560004';
const VKN_BAD = '1000000001';   // son hane bozuk
const TCKN_OK = '10000000146';

let app: FastifyInstance;
let closeDb: () => Promise<void>;
let core: typeof import('@sezra/core');

let fakeCalls = 0;
let fakeQueue: CompanyLookupOutcome[] = [];

const as = (user: string) => ({ 'x-user-id': user });
const json = (res: { body: string }) => JSON.parse(res.body);
const lookup = (taxNo: string, user = USERS.merve) =>
  app.inject({ method: 'GET', url: `/core/company/lookup?tax_no=${encodeURIComponent(taxNo)}`, headers: as(user) });

before(async () => {
  core = await import('@sezra/core');
  const { modules } = await import('../src/modules.ts');
  closeDb = core.closeDb;
  core.registerCompanyProvider({
    code: 'fake', ad: 'Sahte saglayici',
    isConfigured: () => true,
    async lookup() { fakeCalls++; return fakeQueue.shift() ?? { status: 'not_found' }; },
  });
  app = await core.createApp({ modules, logger: false });
  await app.ready();
});

after(async () => { await app.close(); await closeDb(); });

describe('saglayici ayristirma (birim)', () => {
  test('gibParse: unvan / bulunamadi / fault', async () => {
    const c = await import('@sezra/core');
    const found = c.gibParse('<r><userInfo><title>ABC A.S.</title></userInfo></r>');
    assert.equal(found.status, 'found');
    assert.equal(found.status === 'found' && found.info.title, 'ABC A.S.');
    assert.equal(c.gibParse('<r></r>').status, 'not_found');
    assert.equal(c.gibParse('<soapenv:Fault><faultstring>x</faultstring></soapenv:Fault>').status, 'error');
    assert.equal(c.gibParse('').status, 'error');
  });
  test('paidParse: unvan alan esleme / bulunamadi', async () => {
    const c = await import('@sezra/core');
    const r = c.paidParse({ unvan: 'XYZ LTD', vergiDairesi: 'Sisli', mersisNo: '1' });
    assert.equal(r.status, 'found');
    assert.equal(r.status === 'found' && r.info.taxOffice, 'Sisli');
    assert.equal(c.paidParse({}).status, 'not_found');
    assert.equal(c.paidParse(null).status, 'error');
  });
});

describe('VKN dogrulama (birim)', () => {
  test('classifyTaxNo ve isValidVkn/isValidTckn', () => {
    assert.equal(core.isValidVkn(VKN_A), true);
    assert.equal(core.isValidVkn(VKN_B), true);
    assert.equal(core.isValidVkn(VKN_BAD), false, 'son hane bozuk');
    assert.equal(core.isValidVkn('100000000'), false, '9 hane');
    assert.equal(core.isValidVkn('abcdefghij'), false);
    assert.equal(core.isValidTckn(TCKN_OK), true);
    assert.equal(core.isValidTckn('10000000140'), false);
    assert.equal(core.classifyTaxNo(VKN_A), 'vkn');
    assert.equal(core.classifyTaxNo(TCKN_OK), 'tckn');
    assert.equal(core.classifyTaxNo(VKN_BAD), 'invalid');
    assert.equal(core.classifyTaxNo('123'), 'invalid');
  });
});

describe('firma sorgusu (HTTP)', () => {
  test('gecersiz VKN -> 400, saglayici cagrilmaz', async () => {
    core._resetCompanyLookupState();
    const b = fakeCalls;
    const res = await lookup(VKN_BAD);
    assert.equal(res.statusCode, 400, res.body);
    assert.equal(fakeCalls, b, 'gecersiz VKN aga cikmaz');
  });

  test('TCKN -> found:false / status:tckn, saglayici cagrilmaz', async () => {
    core._resetCompanyLookupState();
    const b = fakeCalls;
    const body = json(await lookup(TCKN_OK)).data;
    assert.equal(body.found, false);
    assert.equal(body.status, 'tckn');
    assert.match(body.message, /TC kimlik/i);
    assert.equal(fakeCalls, b);
  });

  test('bulundu -> temizlenmis alanlar, HTML soyulmus', async () => {
    core._resetCompanyLookupState();
    fakeQueue = [{
      status: 'found',
      info: {
        title: '  <b>ABC</b> TICARET <script>alert(1)</script> A.S.  ',
        taxOffice: 'Kadikoy',
        taxOfficeCode: 'VD-034261',
        mersisNo: '0000012345678901',
        address: 'Bagdat Cad. No 1',
        city: 'Istanbul', district: 'Kadikoy', postalCode: '34710',
      },
    }];
    const res = await lookup(VKN_A);
    const b = json(res).data;
    assert.equal(b.found, true);
    assert.equal(b.status, 'found');
    assert.equal(b.message, 'Firma bilgileri başarıyla getirildi.');
    assert.equal(b.company.name, 'ABC TICARET alert(1) A.S.', 'HTML etiketleri soyuldu');
    assert.ok(!res.body.includes('<script'), 'yanit govdesinde <script yok');
    assert.equal(b.company.tax_office_code, '034261', 'sadece rakam');
    assert.equal(b.company.mersis_no, '0000012345678901');
    assert.equal(b.company.postal_code, '34710');
    assert.equal(b.company.city, 'Istanbul');
  });

  test('bulunamadi -> found:false / status:not_found, insan metni', async () => {
    core._resetCompanyLookupState();
    fakeQueue = [{ status: 'not_found' }];
    const b = json(await lookup(VKN_B)).data;
    assert.equal(b.found, false);
    assert.equal(b.status, 'not_found');
    assert.match(b.message, /manuel olarak girebilirsiniz/);
  });

  test('saglayici hatasi -> teknik detay SIZMAZ', async () => {
    core._resetCompanyLookupState();
    fakeQueue = [{ status: 'error', detail: 'GIB HTTP 503 boom stacktrace secret-endpoint' }];
    const res = await lookup(VKN_A);
    const b = json(res).data;
    assert.equal(res.statusCode, 200, 'hata olsa da manuel girise izin -> 200');
    assert.equal(b.found, false);
    assert.equal(b.status, 'error');
    assert.match(b.message, /sorgulanamadı/);
    for (const leak of ['503', 'HTTP', 'stacktrace', 'secret-endpoint', 'boom']) {
      assert.ok(!res.body.includes(leak), `yanitta "${leak}" olmamali`);
    }
  });

  test('cache: ayni VKN 3 kez -> saglayici 1 kez', async () => {
    core._resetCompanyLookupState();
    fakeQueue = [{ status: 'found', info: { title: 'Cache Test A.S.' } }];
    const b0 = fakeCalls;
    await lookup(VKN_A);
    await lookup(VKN_A);
    await lookup(VKN_A);
    assert.equal(fakeCalls, b0 + 1, 'ilk sorgu saglayiciya gitti, sonrakiler cache');
  });

  test('rate limit: pencerede cok sorgu -> 429', async () => {
    core._resetCompanyLookupState();
    fakeQueue = [{ status: 'found', info: { title: 'RL A.S.' } }];
    let got429 = false;
    for (let i = 0; i < 25; i++) {
      const r = await lookup(VKN_A);
      if (r.statusCode === 429) { got429 = true; break; }
    }
    assert.ok(got429, '25 sorgu icinde 429 gelmeli');
  });

  test('/core/company/providers: configured bool, ANAHTAR yok', async () => {
    const r = json(await app.inject({ method: 'GET', url: '/core/company/providers', headers: as(USERS.merve) }));
    const byCode = Object.fromEntries((r.data as { code: string; configured: boolean }[]).map((p) => [p.code, p]));
    assert.equal(byCode.gib.configured, true, 'GIB daima acik');
    assert.equal(byCode.paid.configured, false, 'ucretli env yoksa yapilandirilmamis');
    for (const p of r.data as Record<string, unknown>[]) {
      for (const k of Object.keys(p)) {
        assert.ok(!/key|secret|token|password|url/i.test(k), `provider alanlarinda "${k}" olmamali`);
      }
    }
  });
});
