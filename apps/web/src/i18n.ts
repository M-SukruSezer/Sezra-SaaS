/**
 * Asgari i18n katmanı.
 *
 * Ürün Türkçe-native; ama sözlük katmanı ilk günden var ki metinler bileşenlere
 * gömülmesin. Sonradan i18n eklemek, her bileşene tek tek dokunmak demektir —
 * prompt'un Bölüm 9'da işaret ettiği maliyet tam olarak budur.
 */
type Dict = Record<string, string>;

const tr: Dict = {
  'app.name': 'Sezra',
  'nav.dashboard': 'Panel',
  'nav.crm': 'CRM & Satış',
  'nav.board': 'Satış Hunisi',
  'nav.leads': 'Fırsatlar',
  'nav.quotations': 'Teklifler',
  'nav.orders': 'Siparişler',
  'nav.partners': 'Cariler',
  'nav.products': 'Ürünler',
  'nav.reports': 'Raporlar',
  'nav.settings': 'Ayarlar',
  'action.new': 'Yeni',
  'action.save': 'Kaydet',
  'action.cancel': 'Vazgeç',
  'action.send': 'Gönder',
  'action.accept': 'Onayla',
  'action.confirm': 'Siparişi Onayla',
  'common.search': 'Ara…',
  'common.empty': 'Kayıt yok',
  'common.loading': 'Yükleniyor…',
  'common.total': 'Toplam',
};

const en: Dict = {
  'app.name': 'Sezra',
  'nav.dashboard': 'Dashboard',
  'nav.crm': 'CRM & Sales',
  'nav.board': 'Pipeline',
  'nav.leads': 'Opportunities',
  'nav.quotations': 'Quotations',
  'nav.orders': 'Orders',
  'nav.partners': 'Contacts',
  'nav.products': 'Products',
  'nav.reports': 'Reports',
  'nav.settings': 'Settings',
};

const dictionaries: Record<string, Dict> = { tr, en };
let locale = 'tr';

export function setLocale(l: string): void { locale = l.split('-')[0] ?? 'tr'; }

export function t(key: string): string {
  return dictionaries[locale]?.[key] ?? tr[key] ?? key;
}

/** Para biçimlendirme — kiracının para birimine göre. */
/**
 * Para biçimi.
 *
 * SİMGE SAYIDAN SONRA: Türkçe muhasebe yazılımlarının yerleşik yazımı
 * "1.234,56 ₺" biçimindedir; `Intl`'in öne koyduğu "₺1.234,56" İngilizce
 * alışkanlığıdır ve bir mizanda yabancı durur. Ayrıştırma ve gruplama yine
 * `Intl`e bırakılır -- ondalık ayırıcıyı ve binlik noktasını elle yazmak,
 * dil değiştiğinde bozulur.
 *
 * Türkçe olmayan yerelde `Intl`in kendi düzeni korunur: orada simgenin önde
 * olması doğru olandır.
 */
export function money(value: string | number | null | undefined, currency = 'TRY'): string {
  const n = Number(value ?? 0);
  if (locale !== 'tr') {
    return new Intl.NumberFormat('en-US', {
      style: 'currency', currency, minimumFractionDigits: 2,
    }).format(n);
  }
  const bicimli = new Intl.NumberFormat('tr-TR', {
    style: 'currency', currency, minimumFractionDigits: 2,
  }).formatToParts(n);
  const simge = bicimli.find((p) => p.type === 'currency')?.value ?? currency;
  const sayilar = bicimli.filter((p) => p.type !== 'currency' && p.type !== 'literal')
    .map((p) => p.value).join('');
  // Eksi işareti simgeden önce kalır: "-1.234,56 ₺".
  return `${sayilar} ${simge}`;
}

export function date(value: string | null | undefined): string {
  if (!value) return '—';
  return new Intl.DateTimeFormat(locale === 'tr' ? 'tr-TR' : 'en-US', {
    day: '2-digit', month: '2-digit', year: 'numeric',
  }).format(new Date(value));
}

export function num(value: string | number | null | undefined, digits = 2): string {
  return new Intl.NumberFormat(locale === 'tr' ? 'tr-TR' : 'en-US', {
    minimumFractionDigits: digits, maximumFractionDigits: digits,
  }).format(Number(value ?? 0));
}

/**
 * Göreli zaman: "3 saat önce", "1 gün önce".
 *
 * NEDEN MUTLAK TARİH DEĞİL: liste ekranlarında sorulan soru "ne zaman
 * eklendi" değil, "YENİ Mİ". "05.09.2026" bunu cevaplamak için okuyucunun
 * kafadan çıkarma yapmasını ister; "1 gün önce" doğrudan söyler. Kesin tarih
 * kaybolmaz -- hücrenin `title` niteliğinde durur.
 *
 * Bir haftadan eskiler mutlak tarihe döner: "43 gün önce" artık bilgi değil,
 * okuyucunun tekrar hesaplaması gereken bir sayıdır.
 */
export function gecenSure(value: string | null | undefined): string {
  if (!value) return '—';
  const t = new Date(value).getTime();
  if (Number.isNaN(t)) return '—';
  const sn = Math.round((t - Date.now()) / 1000);
  const rtf = new Intl.RelativeTimeFormat(locale === 'tr' ? 'tr-TR' : 'en-US', { numeric: 'auto' });
  const mutlak = Math.abs(sn);
  if (mutlak < 60) return rtf.format(Math.round(sn), 'second');
  if (mutlak < 3600) return rtf.format(Math.round(sn / 60), 'minute');
  if (mutlak < 86400) return rtf.format(Math.round(sn / 3600), 'hour');
  if (mutlak < 86400 * 7) return rtf.format(Math.round(sn / 86400), 'day');
  return date(value);
}

/** Tam tarih ve saat -- göreli zamanın `title` karşılığı. */
export function tamZaman(value: string | null | undefined): string {
  if (!value) return '';
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return '';
  return new Intl.DateTimeFormat(locale === 'tr' ? 'tr-TR' : 'en-US', {
    day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit',
  }).format(d);
}

/**
 * Uyarlanır sayı: tam sayılar ondalıksız, kesirli olanlar iki basamakla.
 *
 * NEDEN: "143,00 gün" ve "5,00 personel" gürültüdür -- iki basamak bir şey
 * söylemez ama her sayıyı birbirine benzetir. Kesir GERÇEKTEN varsa
 * (yarım gün izin, 12,5 saat) gösterilmesi şart. Karar ham değere değil
 * yuvarlanmış değere bakılarak verilir; aksi hâlde 9,999 "10,00" yerine
 * "10" yazılırdı ama 10,001 "10,00" olurdu.
 */
export function sayi(value: string | number | null | undefined): string {
  const n = Number(value ?? 0);
  if (!Number.isFinite(n)) return '—';
  const yuvarlanmis = Number(n.toFixed(2));
  return num(yuvarlanmis, Number.isInteger(yuvarlanmis) ? 0 : 2);
}
