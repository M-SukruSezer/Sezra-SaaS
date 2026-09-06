import { StatusBadge } from './index';
import type { Kolon } from './ResourceList';
import { date, gecenSure, money, num, tamZaman } from '../i18n';

/**
 * Dinamik alan okuma.
 *
 * Kolon hazırları alan adını METİN olarak alır (aynı kavram modülden modüle
 * başka adla geliyor), dolayısıyla erişim tipe bakılarak yapılamaz. Tek
 * noktaya toplandı ki her hazırda ayrı bir `as` dağılmasın.
 */
const al = (d: unknown, anahtar: string): unknown =>
  (d as Record<string, unknown>)[anahtar];

/* ===========================================================================
   Kolon hazırları
   ===========================================================================
   Aynı kolon dokuz ekranda tekrar ediyor: belge numarası, cari, durum rozeti,
   tutar, tarih. Her ekranda yeniden yazılırsa biri "Tarih", biri "Tarihi"
   olur; biri parayı sağa yaslar, biri yaslamaz. Buradaki hazırlar o kararı
   bir kez verir.

   Hepsi ÜRETEÇ: kolon adı ve başlık dışarıdan gelir, çünkü aynı kavramın
   alan adı modülden modüle değişiyor (`issue_date`, `order_date`,
   `request_date`) ama davranışı değişmiyor.
   ========================================================================= */

/** Belge numarası. Numarasız kayıt "Taslak"tır -- numara onaylanınca verilir. */
export function kolonBelgeNo<T extends { number?: string | null }>(
  baslik = 'Belge no', sirala = false,
): Kolon<T> {
  return {
    anahtar: 'number', baslik, sirala, suz: 'metin',
    govde: (d) => (d.number
      ? <span className="num badge-code">{d.number}</span>
      : <span className="badge">Taslak</span>),
    disa: (d) => d.number ?? 'Taslak',
  };
}

/** Çözümlenmiş cari adı. Kimlik değil AD gösterilir; kimliği kimse okuyamaz. */
export function kolonCari<T>(
  anahtar = 'partner_name', baslik = 'Cari',
): Kolon<T> {
  return {
    anahtar, baslik, suz: 'metin', gruplanir: true,
    govde: (d) => (al(d, anahtar) as string) ?? <span className="muted">—</span>,
    disa: (d) => ((al(d, anahtar) as string) ?? ''),
  };
}

/** Durum rozeti. Etiket ve ton tek sözlükten gelir (`StatusBadge`). */
export function kolonDurum<T extends { status: string }>(
  secenekler: { deger: string; etiket: string }[], baslik = 'Durum',
): Kolon<T> {
  return {
    anahtar: 'status', baslik, suz: 'secim', secenekler, gruplanir: true,
    govde: (d) => <StatusBadge status={d.status} />,
    disa: (d) => d.status,
  };
}

/** Tarih. Mutlak biçim: bir belgenin tarihi kimlik bilgisidir, "3 gün önce"
 *  değil -- kullanıcı onu evrakla karşılaştırır. */
export function kolonTarih<T>(
  anahtar: string, baslik: string, sirala = true,
): Kolon<T> {
  return {
    anahtar, baslik, sirala,
    govde: (d) => date(al(d, anahtar) as string | null),
    disa: (d) => ((al(d, anahtar) as string) ?? ''),
  };
}

/** Göreli zaman. Kayıt zamanı için: sorulan şey "yeni mi", "ne zaman" değil. */
export function kolonGecen<T>(
  anahtar = 'created_at', baslik = 'Eklenme', sirala = true,
): Kolon<T> {
  return {
    anahtar, baslik, sirala, hizala: 'sag',
    govde: (d) => (
      <span className="muted" title={tamZaman(al(d, anahtar) as string)}>
        {gecenSure(al(d, anahtar) as string)}
      </span>
    ),
    // Dışa aktarımda GÖRELİ ZAMAN DEĞİL, tam zaman yazılır: "3 gün önce"
    // dosyanın açıldığı gün yanlış olur. Ham ISO damgası da yazılmaz --
    // Excel "2026-09-05T00:24:46.876Z" ifadesini tarih olarak tanımaz ve
    // hücreyi metin bırakır, dolayısıyla sıralanamaz.
    disa: (d) => tamZaman(al(d, anahtar) as string),
  };
}

/** Para. Belgenin KENDİ para biriminde biçimlenir; kiracının varsayılanıyla
 *  değil -- döviz bir belgede tutarın anlamını değiştirir. */
export function kolonPara<T>(
  anahtar: string, baslik: string,
  { kalin = false, sirala = false, gizli = false, paraAlani = 'currency' } = {},
): Kolon<T> {
  return {
    anahtar, baslik, hizala: 'sag', sirala, gizliBaslangic: gizli,
    govde: (d) => {
      const m = money(al(d, anahtar) as string, (al(d, paraAlani) as string) ?? 'TRY');
      return kalin ? <strong>{m}</strong> : <>{m}</>;
    },
    disa: (d) => ((al(d, anahtar) as string) ?? ''),
  };
}

/** Sayı. Tam sayılar ondalıksız görünür; "12,00 kalem" gürültüdür. */
export function kolonSayi<T>(
  anahtar: string, baslik: string,
  { basamak, sirala = false, gizli = false, sonek = '' } = {} as
    { basamak?: number; sirala?: boolean; gizli?: boolean; sonek?: string },
): Kolon<T> {
  return {
    anahtar, baslik, hizala: 'sag', sirala, gizliBaslangic: gizli,
    govde: (d) => {
      const v = al(d, anahtar);
      if (v === null || v === undefined || v === '') return <span className="muted">—</span>;
      const n = Number(v);
      return <>{num(n, basamak ?? (Number.isInteger(n) ? 0 : 2))}{sonek}</>;
    },
    disa: (d) => ((al(d, anahtar) as string) ?? ''),
  };
}

/** Çözümlenmiş ad (sahip, sorumlu, atanan, ekip). */
export function kolonAd<T>(
  anahtar: string, baslik: string, { gizli = false, grup = true } = {},
): Kolon<T> {
  return {
    anahtar, baslik, gizliBaslangic: gizli, gruplanir: grup,
    govde: (d) => (al(d, anahtar) as string) ?? <span className="muted">—</span>,
    disa: (d) => ((al(d, anahtar) as string) ?? ''),
  };
}

/** Aktif / pasif. */
export function kolonAktif<T>(
  anahtar = 'is_active', baslik = 'Durum',
): Kolon<T> {
  return {
    anahtar, baslik, suz: 'secim', gruplanir: true,
    secenekler: [{ deger: 'true', etiket: 'Aktif' }, { deger: 'false', etiket: 'Pasif' }],
    govde: (d) => (al(d, anahtar)
      ? <span className="badge badge-ok">Aktif</span>
      : <span className="badge">Pasif</span>),
    disa: (d) => (al(d, anahtar) ? 'Aktif' : 'Pasif'),
  };
}

/**
 * Öncelik.
 *
 * Renk TEK BAŞINA taşımaz: her rozetin yanında kelimesi yazar. Yalnızca
 * renkle kodlansaydı, renk körü bir kullanıcı "yüksek" ile "düşük"ü
 * ayırt edemezdi -- ve bu ekranlarda öncelik, işin sırasını belirleyen şey.
 */
const ONCELIK: Record<string, { etiket: string; ton: string }> = {
  '1': { etiket: 'Düşük', ton: '' },
  '2': { etiket: 'Normal', ton: 'badge-info' },
  '3': { etiket: 'Yüksek', ton: 'badge-warn' },
  '4': { etiket: 'Acil', ton: 'badge-danger' },
  low: { etiket: 'Düşük', ton: '' },
  normal: { etiket: 'Normal', ton: 'badge-info' },
  medium: { etiket: 'Orta', ton: 'badge-info' },
  high: { etiket: 'Yüksek', ton: 'badge-warn' },
  urgent: { etiket: 'Acil', ton: 'badge-danger' },
  critical: { etiket: 'Kritik', ton: 'badge-danger' },
};

export function kolonOncelik<T>(
  anahtar = 'priority', baslik = 'Öncelik',
  secenekler?: { deger: string; etiket: string }[],
): Kolon<T> {
  return {
    anahtar, baslik, suz: secenekler ? 'secim' : undefined, secenekler, gruplanir: true,
    govde: (d) => {
      const ham = String(al(d, anahtar) ?? '');
      const o = ONCELIK[ham];
      if (!o) return <span className="muted">—</span>;
      return <span className={`badge ${o.ton}`}>{o.etiket}</span>;
    },
    disa: (d) => ONCELIK[String(al(d, anahtar) ?? '')]?.etiket ?? '',
  };
}

/** Belge durumlarının ortak seçenek listeleri. */
export const DURUM_BELGE = [
  { deger: 'draft', etiket: 'Taslak' },
  { deger: 'sent', etiket: 'Gönderildi' },
  { deger: 'accepted', etiket: 'Onaylandı' },
  { deger: 'rejected', etiket: 'Reddedildi' },
  { deger: 'expired', etiket: 'Süresi doldu' },
  { deger: 'cancelled', etiket: 'İptal' },
];

export const DURUM_SIPARIS = [
  { deger: 'draft', etiket: 'Taslak' },
  { deger: 'confirmed', etiket: 'Onaylandı' },
  { deger: 'delivered', etiket: 'Teslim edildi' },
  { deger: 'invoiced', etiket: 'Faturalandı' },
  { deger: 'cancelled', etiket: 'İptal' },
];

export const DURUM_FATURA = [
  { deger: 'draft', etiket: 'Taslak' },
  { deger: 'posted', etiket: 'Muhasebeleşti' },
  { deger: 'partially_paid', etiket: 'Kısmen ödendi' },
  { deger: 'paid', etiket: 'Ödendi' },
  { deger: 'cancelled', etiket: 'İptal' },
];
