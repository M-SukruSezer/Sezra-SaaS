/**
 * Modül bağımlılığı uygulaması.
 *
 * `core.modules.depends_on` kolonu baştan beri doldurulmuş (`purchasing` ->
 * `{core,finance}`) ama yalnızca `/core/modules` listeleme ucunda GÖSTERİLİYOR;
 * hiçbir yerde UYGULANMIYORDU. Sonucu sessizdi: `finance` olmadan `purchasing`
 * yüklenebiliyor, mal kabul olayı yayınlanıyor, fan-out hiç abone bulamıyor ve
 * muhasebe kaydı hiç doğmuyordu — hata da vermiyordu.
 *
 * Ayrıca yükleme sırası `apps/api/src/modules.ts` dizisindeki ELLE yazılmış
 * sıraya bağlıydı; dizi yanlış sıralanırsa bir modül bağımlılığından önce
 * register oluyordu.
 */
process.env.AUTH_MODE ??= 'dev';
process.env.NODE_ENV = 'test';

import '../src/env.ts';
import { test, describe, after } from 'node:test';
import assert from 'node:assert/strict';
import {
  resolveModuleOrder, createApp, coreModule, closeDb,
  type SezraModule, type ModuleRegistryRow,
} from '@sezra/core';
import { financeModule } from '@sezra/finance';
import { purchasingModule } from '@sezra/purchasing';

/** Testlik boş modül: yalnızca kodu önemli. */
const mod = (code: string): SezraModule => ({ code, register: () => {} });

const registry = (...rows: [string, string[]][]): ModuleRegistryRow[] =>
  rows.map(([code, depends_on]) => ({ code, depends_on }));

describe('resolveModuleOrder', () => {
  test('bağımlılığı sağlanan modüller bağımlılık sırasına dizilir', () => {
    // Dizi KASTEN ters: purchasing önce, bağımlılığı finance sonra.
    const order = resolveModuleOrder(
      [mod('purchasing'), mod('finance'), mod('core')],
      registry(['core', []], ['finance', ['core']], ['purchasing', ['core', 'finance']]),
    ).map((m) => m.code);

    assert.deepEqual(order, ['core', 'finance', 'purchasing']);
  });

  test('eksik bağımlılık yüklemeyi reddeder', () => {
    assert.throws(
      () => resolveModuleOrder(
        [mod('core'), mod('purchasing')],
        registry(['core', []], ['finance', ['core']], ['purchasing', ['core', 'finance']]),
      ),
      /purchasing.*finance/s,
      'purchasing, finance olmadan yüklenebildi',
    );
  });

  test('core.modules\'ta kayıtlı olmayan modül reddedilir (mevcut davranış korunur)', () => {
    assert.throws(
      () => resolveModuleOrder([mod('core'), mod('hayalet')], registry(['core', []])),
      /hayalet/,
    );
  });

  test('bağımlılık döngüsü reddedilir', () => {
    assert.throws(
      () => resolveModuleOrder(
        [mod('a'), mod('b')],
        registry(['a', ['b']], ['b', ['a']]),
      ),
      /döngü/i,
      'döngü sessizce kabul edildi',
    );
  });

  test('kendine bağımlılık döngü sayılır', () => {
    assert.throws(
      () => resolveModuleOrder([mod('a')], registry(['a', ['a']])),
      /döngü/i,
    );
  });

  test('aynı bağımlılığı paylaşan modüller tek sefer yüklenir', () => {
    const order = resolveModuleOrder(
      [mod('crm'), mod('hr'), mod('core')],
      registry(['core', []], ['crm', ['core']], ['hr', ['core']]),
    ).map((m) => m.code);

    assert.equal(order.length, 3);
    assert.equal(order[0], 'core');
    assert.equal(new Set(order).size, 3, 'modül iki kez yüklendi');
  });
});

describe('createApp bağımlılık kapısı', () => {
  after(async () => { await closeDb(); });

  test('gerçek kayıt defterine göre purchasing, finance olmadan yüklenmez', async () => {
    // purchasing'in core.modules kaydı depends_on = {core,finance}
    await assert.rejects(
      () => createApp({ modules: [coreModule, purchasingModule], logger: false }),
      /finance/,
      'purchasing, finance olmadan açıldı',
    );
  });

  test('bağımlılığı sağlandığında açılır', async () => {
    const app = await createApp({
      modules: [purchasingModule, financeModule, coreModule],  // sıra kasten ters
      logger: false,
    });
    assert.ok(app, 'uygulama açılmadı');
    await app.close();
  });
});
