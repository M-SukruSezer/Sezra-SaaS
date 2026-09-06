import type { ReactNode } from 'react';

/**
 * Gösterge kartı.
 *
 * Değer ve para birimi AYRI yazılır: rakam okunurken göz simgeye takılmasın,
 * ama birim de kaybolmasın. Kartın altındaki cümle rakamın ne olduğunu
 * söyler; başlık tek başına yeterli değil ("bu ayki satış" neyi kapsıyor?).
 */
export function KPICard({ label, value, unit, hint, tone }: {
  label: string;
  value: ReactNode;
  unit?: string;
  hint?: string;
  tone?: 'ok' | 'warn' | 'danger';
}) {
  return (
    <article className="kpi">
      <div className="kpi-label">{label}</div>
      <div className={`kpi-value${tone ? ` kpi-${tone}` : ''}`}>
        <span>{value}</span>
        {unit && <span className="kpi-unit">{unit}</span>}
      </div>
      {hint && <div className="kpi-hint">{hint}</div>}
    </article>
  );
}

export function KPIGrid({ children }: { children: ReactNode }) {
  return <div className="kpi-grid">{children}</div>;
}

/** Veri gelene kadar düzeni sabit tutan iskelet. */
export function KPISkeleton({ count = 8 }: { count?: number }) {
  return (
    <div className="kpi-grid">
      {Array.from({ length: count }, (_, i) => (
        <article className="kpi" key={i} aria-hidden="true">
          <div className="skeleton skeleton-label" />
          <div className="skeleton skeleton-value" />
          <div className="skeleton skeleton-hint" />
        </article>
      ))}
    </div>
  );
}
