/**
 * İkon seti.
 *
 * Lucide çizim diliyle, satır içi SVG olarak. Paket bağımlılığı yok: menüde
 * on üç ikon kullanılıyor, bunun için bir kütüphane yüklemek her açılışta
 * bedelini ödeteceğimiz bir maliyet olurdu.
 *
 * Hepsi `currentColor` ile boyanır, yani renk token'dan gelir; boyut CSS'ten
 * gelir. Emoji KULLANILMAZ: platformlar arası tutarsızdır ve üründe oyuncak
 * etkisi yapar.
 */
import type { ReactElement } from 'react';

export type IconName =
  | 'dashboard' | 'pipeline' | 'finance' | 'support' | 'projects' | 'pos'
  | 'inventory' | 'maintenance' | 'quality' | 'purchasing' | 'people'
  | 'database' | 'chevron' | 'panel' | 'settings';

const PATHS: Record<IconName, ReactElement> = {
  dashboard: <><rect x="3" y="3" width="7" height="7" rx="1" /><rect x="14" y="3" width="7" height="7" rx="1" /><rect x="14" y="14" width="7" height="7" rx="1" /><rect x="3" y="14" width="7" height="7" rx="1" /></>,
  pipeline: <><path d="M3 3v16a2 2 0 0 0 2 2h16" /><path d="m7 15 4-4 3 3 5-6" /></>,
  finance: <><rect x="2" y="5" width="20" height="14" rx="2" /><path d="M2 10h20" /><path d="M6 15h4" /></>,
  support: <><circle cx="12" cy="12" r="9" /><circle cx="12" cy="12" r="3.5" /><path d="m5.7 5.7 3.9 3.9M14.4 14.4l3.9 3.9M18.3 5.7l-3.9 3.9M9.6 14.4l-3.9 3.9" /></>,
  projects: <><path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2Z" /><path d="M9 12v4M13 10v6M17 13v3" /></>,
  pos: <><circle cx="9" cy="20" r="1.4" /><circle cx="18" cy="20" r="1.4" /><path d="M2 3h2.2l2.6 12.1a1.8 1.8 0 0 0 1.8 1.4h9a1.8 1.8 0 0 0 1.8-1.4L21 7H5.4" /></>,
  inventory: <><path d="m12 2 9 5v10l-9 5-9-5V7Z" /><path d="m3 7 9 5 9-5" /><path d="M12 12v10" /></>,
  maintenance: <><path d="M14.5 3.5a4.6 4.6 0 0 0 5.9 5.9L21 10l-9 9-3 3-3-3 3-3 9-9Z" /><path d="m6.5 17.5 2 2" /></>,
  quality: <><path d="M12 2.5 20 6v6c0 5-3.4 8.4-8 9.5-4.6-1.1-8-4.5-8-9.5V6Z" /><path d="m9 12 2 2 4-4" /></>,
  purchasing: <><path d="M2 6h11v10H2Z" /><path d="M13 9h4l4 3.5V16h-8Z" /><circle cx="6.5" cy="18.5" r="1.6" /><circle cx="17" cy="18.5" r="1.6" /></>,
  people: <><circle cx="9" cy="8" r="3.5" /><path d="M2.5 20a6.5 6.5 0 0 1 13 0" /><path d="M16.5 5.2a3.5 3.5 0 0 1 0 6.6M18 20a6.4 6.4 0 0 0-1.8-4.5" /></>,
  database: <><ellipse cx="12" cy="5.5" rx="8" ry="3" /><path d="M4 5.5v6c0 1.7 3.6 3 8 3s8-1.3 8-3v-6" /><path d="M4 11.5v6c0 1.7 3.6 3 8 3s8-1.3 8-3v-6" /></>,
  chevron: <path d="m6 9 6 6 6-6" />,
  settings: <><circle cx="12" cy="12" r="3" /><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.9l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.9-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1A1.7 1.7 0 0 0 8.9 19a1.7 1.7 0 0 0-1.9.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.9 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1A1.7 1.7 0 0 0 4.7 8.4a1.7 1.7 0 0 0-.3-1.9l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.9.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.9-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.9V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1Z" /></>,
  panel: <><rect x="3" y="4" width="18" height="16" rx="2" /><path d="M9 4v16" /></>,
};

export function Icon({ name, className }: { name: IconName; className?: string }) {
  return (
    <svg
      className={className ?? 'icon'}
      viewBox="0 0 24 24" fill="none" stroke="currentColor"
      strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round"
      aria-hidden="true" focusable="false"
    >
      {PATHS[name]}
    </svg>
  );
}
