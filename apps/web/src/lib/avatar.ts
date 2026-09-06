/**
 * Profil görseli.
 *
 * NEDEN EMOJİ DEĞİL: emoji her platformda başka çizilir (Windows, macOS,
 * Android aynı karakteri farklı gösterir), kurumsal bir ekranda oyuncak
 * etkisi yapar ve projenin kendi kuralı onu yasaklıyor -- `check_no_emoji.py`
 * derlemeyi düşürüyor. Aynı işi bozmadan yapan yol, kullanıcıya ÖZEL ama
 * ÜRETİLMİŞ bir görsel.
 *
 * DETERMİNİSTİK: aynı kullanıcı her cihazda, her oturumda aynı avatarı alır.
 * Rastgele seçilseydi kullanıcı kendini tanıyamaz, listede aradığı kişiyi
 * renkten bulamazdı; avatarın işe yaraması tam da sabit olmasına bağlı.
 */

/** Küçük, hızlı ve kararlı bir karma (FNV-1a). Şifreleme için değil. */
function karma(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/**
 * Palet BOYUTU. Renklerin kendisi tema katmanında (`--c-avatar-0..7`):
 * burada tutulsaydı marka değiştiğinde iki yerde birden düzenlemek
 * gerekirdi ve renk sistemi ikiye bölünürdü. Burada yalnızca "kaç renk var"
 * bilgisi durur; seçim indeks üzerinden yapılır.
 *
 * Paletteki her ton beyaz metinle en az 4,5:1 verir (WCAG AA, normal metin).
 * Rastgele renk üretmek yerine sınanmış bir listeden seçilmesinin sebebi
 * budur: üretilen bir renk kontrastı garanti etmez.
 */
const PALET_BOYU = 8;

export interface UretilmisAvatar {
  bas: string;
  /** Tema katmanındaki `--c-avatar-N` renginin indeksi. */
  renk: number;
}

/** Ad ya da e-postadan baş harf(ler)i çıkarır. */
function basHarf(ad: string): string {
  const kelimeler = ad.trim().split(/\s+/).filter(Boolean);
  if (kelimeler.length === 0) return '?';
  if (kelimeler.length === 1) return kelimeler[0]!.charAt(0).toLocaleUpperCase('tr');
  // İki kelimeden fazlaysa ilk ve SON kelime alınır: "Ali Rıza Yılmaz" -> AY.
  const ilk = kelimeler[0]!.charAt(0);
  const son = kelimeler[kelimeler.length - 1]!.charAt(0);
  return `${ilk}${son}`.toLocaleUpperCase('tr');
}

/**
 * Kullanıcı için avatar üretir.
 *
 * `anahtar` kullanıcı kimliğidir: ad değişse de avatar sabit kalır. Ada göre
 * üretilseydi, bir kullanıcı adını düzelttiğinde rengi de değişir ve
 * meslektaşları onu tanımakta zorlanırdı.
 */
export function uretilmisAvatar(anahtar: string, ad: string | null): UretilmisAvatar {
  return {
    bas: basHarf(ad ?? '?'),
    renk: karma(anahtar) % PALET_BOYU,
  };
}
