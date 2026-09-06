import { useEffect, useState } from 'react';

/**
 * Tema seçimi.
 *
 * Üç durum vardır: 'light', 'dark' ve seçim yapılmamış hâli ('system').
 * Seçim yapılmadığında CSS `prefers-color-scheme` ile işletim sistemini izler;
 * bir seçim yapıldığında `data-theme` özniteliği onu ezer. Karar tek yerde:
 * sayfalar tema bilmez, yalnızca token kullanır.
 */
export type Theme = 'light' | 'dark' | 'system';

const KEY = 'sezra.theme';

export function readTheme(): Theme {
  try {
    const v = localStorage.getItem(KEY);
    return v === 'light' || v === 'dark' ? v : 'system';
  } catch {
    return 'system';
  }
}

export function applyTheme(theme: Theme): void {
  const root = document.documentElement;
  if (theme === 'system') root.removeAttribute('data-theme');
  else root.setAttribute('data-theme', theme);
  try {
    if (theme === 'system') localStorage.removeItem(KEY);
    else localStorage.setItem(KEY, theme);
  } catch {
    // Depolama kapalıysa tema yine de uygulanır, sadece kalıcı olmaz.
  }
}

/** Kullanıcının o an gördüğü tema (sistem tercihi çözülmüş hâliyle). */
export function resolvedTheme(theme: Theme): 'light' | 'dark' {
  if (theme !== 'system') return theme;
  return window.matchMedia?.('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
}

/**
 * İlk boyamadan ÖNCE çağrılır. Aksi hâlde koyu tema seçili bir kullanıcı,
 * React kurulana kadar bir kare boyunca aydınlık ekran görür.
 */
export function initTheme(): void {
  applyTheme(readTheme());
}

/**
 * O an GÖRÜNEN temayı tepkisel olarak verir.
 *
 * KAYNAK DOM'DUR, DEPOLAMA DEĞİL: CSS neye bakıyorsa bu kanca da ona bakar --
 * kök öğedeki `data-theme`, yoksa `prefers-color-scheme`. localStorage'dan
 * türetmek yanlış cevap verir, çünkü depolanan değer "system" olabilir ya da
 * öznitelik başka bir yoldan değişmiş olabilir; o zaman logo ile arka plan
 * farklı temalarda kalır.
 *
 * İki kaynak da dinlenir: kullanıcı temayı elle değiştirdiğinde öznitelik
 * değişir, seçim "sistem"deyken ise işletim sisteminin tercihi değişebilir.
 */
function domTemasi(): 'light' | 'dark' {
  const secilen = document.documentElement.getAttribute('data-theme');
  if (secilen === 'light' || secilen === 'dark') return secilen;
  return window.matchMedia?.('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
}

export function useResolvedTheme(): 'light' | 'dark' {
  const [theme, setTheme] = useState<'light' | 'dark'>(domTemasi);

  useEffect(() => {
    const guncelle = () => setTheme(domTemasi());

    // 1) Elle yapılan seçim: kök öğedeki data-theme özniteliği.
    const gozlemci = new MutationObserver(guncelle);
    gozlemci.observe(document.documentElement, {
      attributes: true, attributeFilter: ['data-theme'],
    });

    // 2) Sistem tercihi (yalnızca seçim "sistem"deyken etkili olur).
    const mq = window.matchMedia?.('(prefers-color-scheme: dark)');
    mq?.addEventListener('change', guncelle);

    guncelle();
    return () => { gozlemci.disconnect(); mq?.removeEventListener('change', guncelle); };
  }, []);

  return theme;
}
