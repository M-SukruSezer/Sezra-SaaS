/**
 * Kasa istemcisinin çevrimdışı katmanı.
 *
 * TEMEL KURAL: kasa, sunucuya ulaşamadığı için satış yapmayı BIRAKMAZ.
 * Fiş yerelde tamamlanır, kuyruğa alınır ve bağlantı gelince gönderilir.
 * Fiş kimliğini cihaz ürettiği için (sunucu tarafındaki 0800/karar 1) aynı
 * fişin iki kez gönderilmesi tehlikeli değildir — /pos/sync idempotenttir.
 * Bu yüzden kuyruk "gönderdim mi?" sorusunu kesin çözmek zorunda değil:
 * emin olamadığında tekrar gönderir.
 */

const CATALOG_KEY = 'sezra.pos.catalog';
const QUEUE_KEY = 'sezra.pos.queue';
const SESSION_KEY = 'sezra.pos.session';

export interface CatalogProduct {
  id: string;
  sku: string;
  name: string;
  sale_price: string;
  sale_tax_id: string | null;
  tax_rate: number;
  barcodes: string[];
}

export interface CatalogSnapshot {
  fetched_at: string;
  terminal_id: string;
  prices_include_tax: boolean;
  products: CatalogProduct[];
}

export interface QueuedLine {
  product_id: string;
  sku: string;
  name: string;
  quantity: number;
  unit_price: number;
  tax_id: string | null;
  tax_rate: number;
}

export interface QueuedPayment {
  method: 'cash' | 'card' | 'meal_card' | 'other';
  amount: number;
}

export interface QueuedOrder {
  id: string;
  branch_id: string | null;
  session_id: string;
  terminal_id: string;
  client_seq: number;
  ordered_at: string;
  status: 'paid';
  lines: QueuedLine[];
  payments: QueuedPayment[];
  /** Kaç kez gönderilmeye çalışıldı — teşhis için. */
  attempts?: number;
}

export interface PosSessionRef {
  id: string;
  number: string | null;
  terminal_id: string;
  branch_id: string | null;
  opened_at: string;
}

function read<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(key);
    return raw ? (JSON.parse(raw) as T) : fallback;
  } catch {
    // Bozuk yerel veri satışı durdurmaz; boş kabul edilir.
    return fallback;
  }
}

function write(key: string, value: unknown): void {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    // Kota dolduysa sessizce geç: kuyruk yazılamasa bile ekran çalışmalı.
  }
}

// ---- Katalog ----------------------------------------------------------------
export const loadCatalog = (): CatalogSnapshot | null =>
  read<CatalogSnapshot | null>(CATALOG_KEY, null);
export const saveCatalog = (c: CatalogSnapshot): void => write(CATALOG_KEY, c);

// ---- Oturum -----------------------------------------------------------------
export const loadSession = (): PosSessionRef | null =>
  read<PosSessionRef | null>(SESSION_KEY, null);
export const saveSession = (s: PosSessionRef | null): void => {
  if (s) write(SESSION_KEY, s);
  else localStorage.removeItem(SESSION_KEY);
};

// ---- Kuyruk -----------------------------------------------------------------
export const loadQueue = (): QueuedOrder[] => read<QueuedOrder[]>(QUEUE_KEY, []);

export function enqueue(order: QueuedOrder): void {
  const q = loadQueue();
  q.push(order);
  write(QUEUE_KEY, q);
}

export function removeFromQueue(ids: string[]): void {
  const drop = new Set(ids);
  write(QUEUE_KEY, loadQueue().filter((o) => !drop.has(o.id)));
}

export function bumpAttempts(ids: string[]): void {
  const drop = new Set(ids);
  write(QUEUE_KEY, loadQueue().map((o) =>
    drop.has(o.id) ? { ...o, attempts: (o.attempts ?? 0) + 1 } : o));
}

/** Cihazın kendi artan fiş sayacı — sunucu sıra atlamasını buradan görebilir. */
export function nextClientSeq(): number {
  const key = 'sezra.pos.seq';
  const next = Number(localStorage.getItem(key) ?? '0') + 1;
  localStorage.setItem(key, String(next));
  return next;
}

// ---- Tutar hesabı -----------------------------------------------------------
/**
 * Fiş toplamını YEREL olarak hesaplar.
 *
 * DİKKAT: bu hesap yalnızca EKRANDA GÖSTERMEK içindir. Kaydın doğrusu her zaman
 * sunucunun hesabıdır (pos.fn_calc_order_line); senkronizasyonda sunucu satırları
 * yeniden hesaplar. İki uygulamanın zamanla ayrışma riski gerçektir, o yüzden
 * yerel sonuç hiçbir yere yazılmaz — müşteriye söylenen tutarla kasaya düşen
 * tutar arasında fark çıkarsa kaynak sunucudur.
 */
export function computeTotals(
  lines: QueuedLine[], pricesIncludeTax: boolean,
): { subtotal: number; tax: number; total: number } {
  let subtotal = 0;
  let tax = 0;
  let total = 0;

  for (const l of lines) {
    const gross = round2(l.quantity * l.unit_price);
    if (pricesIncludeTax) {
      const sub = round2(gross / (1 + l.tax_rate / 100));
      subtotal += sub;
      tax += round2(gross - sub);
      total += gross;
    } else {
      const t = round2(gross * l.tax_rate / 100);
      subtotal += gross;
      tax += t;
      total += gross + t;
    }
  }
  return { subtotal: round2(subtotal), tax: round2(tax), total: round2(total) };
}

export const round2 = (n: number): number => Math.round((n + Number.EPSILON) * 100) / 100;

export const money = (n: number): string =>
  new Intl.NumberFormat('tr-TR', { style: 'currency', currency: 'TRY' }).format(n);
