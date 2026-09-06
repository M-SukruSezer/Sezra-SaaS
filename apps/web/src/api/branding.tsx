import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from 'react';
import { api } from './client';
import { useResolvedTheme } from '../ui/theme';

/**
 * Ürün markası (Sezra logosu).
 *
 * OTURUMDAN AYRI TUTULUR: logo giriş ekranında, yani `/me` çağrılabilmeden
 * önce gerekir. Oturum bağlamına bağlansaydı marka yalnızca oturum açtıktan
 * sonra görünür, giriş sayfası hep yazı işaretiyle kalırdı.
 *
 * Logoyu YALNIZCA platform yöneticisi değiştirebilir; bu kontrol burada
 * değil, veritabanındaki `core.platform_guard()` içinde uygulanır. Buradaki
 * `canEdit` sadece görünürlük içindir.
 */
export interface BrandingContact {
  note: string | null;
  phone1: string | null;
  phone1_label: string | null;
  phone2: string | null;
  phone2_label: string | null;
  whatsapp: string | null;
}

export interface Branding {
  /** Açık zemin logosu; koyu varyant yoksa iki temada da bu kullanılır. */
  logo: string | null;
  mime: string | null;
  /** Koyu zemin logosu. Zorunlu değildir. */
  logo_dark: string | null;
  mime_dark: string | null;
  updated_at: string | null;
  /** Üst çubuktaki "Bize ulaşın" kutusunun içeriği. */
  contact: BrandingContact;
}

interface BrandingContext {
  branding: Branding;
  /**
   * O anki temada GÖSTERİLECEK logo. Koyu temada koyu varyant varsa o,
   * yoksa açık varyant döner — tek dosya yükleyen bir kurulum da çalışsın
   * diye. Bileşenler tema mantığı taşımaz, yalnızca bunu okur.
   */
  logo: string | null;
  loading: boolean;
  reload: () => Promise<void>;
}

const BOS_ILETISIM: BrandingContact = {
  note: null, phone1: null, phone1_label: null,
  phone2: null, phone2_label: null, whatsapp: null,
};

const EMPTY: Branding = {
  logo: null, mime: null, logo_dark: null, mime_dark: null, updated_at: null,
  contact: BOS_ILETISIM,
};

const Ctx = createContext<BrandingContext>({
  branding: EMPTY, logo: null, loading: true, reload: async () => {},
});

export function BrandingProvider({ children }: { children: ReactNode }) {
  const [branding, setBranding] = useState<Branding>(EMPTY);
  const [loading, setLoading] = useState(true);

  const reload = useCallback(async () => {
    try {
      const res = await api.get<{ data: Branding }>('/branding');
      // İletişim alanı eski bir sunucudan gelmeyebilir; eksikse boş kabul
      // edilir, böylece üst çubuk çökmez.
      setBranding({ ...EMPTY, ...res.data, contact: { ...BOS_ILETISIM, ...res.data?.contact } });
    } catch {
      // Marka bir süs değil ama zorunlu da değil: uç ulaşılamazsa uygulama
      // yazı işaretiyle çalışmaya devam eder. Burada hata göstermek, giriş
      // ekranını logo yüzünden bloke etmek olurdu.
      setBranding(EMPTY);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void reload(); }, [reload]);

  // Devralma İKİ YÖNLÜ: eksik olan varyant diğerine düşer. Tek yönlü olsaydı,
  // yalnızca koyu logo yükleyen bir kurulum açık temada hiç logo göstermezdi.
  const tema = useResolvedTheme();
  const logo = tema === 'dark'
    ? (branding.logo_dark ?? branding.logo)
    : (branding.logo ?? branding.logo_dark);

  return (
    <Ctx.Provider value={{ branding, logo, loading, reload }}>{children}</Ctx.Provider>
  );
}

export const useBranding = (): BrandingContext => useContext(Ctx);
