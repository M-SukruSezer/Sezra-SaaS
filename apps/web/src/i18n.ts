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
export function money(value: string | number | null | undefined, currency = 'TRY'): string {
  const n = Number(value ?? 0);
  return new Intl.NumberFormat(locale === 'tr' ? 'tr-TR' : 'en-US', {
    style: 'currency', currency, minimumFractionDigits: 2,
  }).format(n);
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
