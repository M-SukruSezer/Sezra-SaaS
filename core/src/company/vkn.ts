/**
 * VKN / TCKN dogrulama -- UYGULAMA KATMANINDA.
 *
 * NEDEN BURADA DA: veritabaninda `core.tax_no_valid` zaten var ama firma
 * sorgusu, gecersiz numarada HIC aga cikmamali. Kontrol istekten once,
 * backend'de yapilir. Ayni GIB sağlama-toplamı algoritmasi.
 */

export type TaxNoKind = 'vkn' | 'tckn' | 'invalid';

/** Sadece rakamlari birak. */
export function normalizeTaxNo(raw: string): string {
  return (raw ?? '').replace(/\D/g, '');
}

/**
 * 10 haneli VKN sağlama toplamı (GIB resmi algoritmasi).
 *
 * Her hane icin: (hane + (10 - konum)) mod 10 = tmp; tmp != 0 ise
 * (tmp * 2^(10-konum)) mod 9, sonuc 0 ise 9. Toplamin 10'a tumleyeni son hane.
 */
export function isValidVkn(value: string): boolean {
  const v = normalizeTaxNo(value);
  if (!/^\d{10}$/.test(v)) return false;
  const d = v.split('').map(Number);
  let sum = 0;
  for (let i = 0; i < 9; i++) {
    const tmp = (d[i]! + (10 - (i + 1))) % 10;
    let val = 0;
    if (tmp !== 0) {
      val = (tmp * 2 ** (10 - (i + 1))) % 9;
      if (val === 0) val = 9;
    }
    sum += val;
  }
  const check = (10 - (sum % 10)) % 10;
  return d[9] === check;
}

/** 11 haneli TCKN sağlama toplamı. */
export function isValidTckn(value: string): boolean {
  const v = normalizeTaxNo(value);
  if (!/^\d{11}$/.test(v)) return false;
  const d = v.split('').map(Number);
  if (d[0] === 0) return false;
  const odd = d[0]! + d[2]! + d[4]! + d[6]! + d[8]!;
  const even = d[1]! + d[3]! + d[5]! + d[7]!;
  if (((odd * 7) - even) % 10 !== d[9]) return false;
  const total10 = d.slice(0, 10).reduce((a, b) => a + b, 0);
  return total10 % 10 === d[10];
}

/** Girdi ne: gecerli VKN, gecerli TCKN, yoksa gecersiz. */
export function classifyTaxNo(value: string): TaxNoKind {
  const v = normalizeTaxNo(value);
  if (v.length === 10) return isValidVkn(v) ? 'vkn' : 'invalid';
  if (v.length === 11) return isValidTckn(v) ? 'tckn' : 'invalid';
  return 'invalid';
}
