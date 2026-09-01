import type { ReactNode, ChangeEvent } from 'react';
import { useEffect, useState } from 'react';

export function Card({ title, actions, children, padded = true }: {
  title?: ReactNode; actions?: ReactNode; children: ReactNode; padded?: boolean;
}) {
  return (
    <section className="card">
      {(title || actions) && (
        <header className="card-head">
          <span style={{ flex: 1 }}>{title}</span>
          {actions}
        </header>
      )}
      <div className={padded ? 'card-body' : undefined}>{children}</div>
    </section>
  );
}

export function Stat({ label, value, hint }: { label: string; value: ReactNode; hint?: ReactNode }) {
  return (
    <div className="card stat">
      <div className="stat-label">{label}</div>
      <div className="stat-value">{value}</div>
      {hint && <div className="stat-label" style={{ marginTop: 4 }}>{hint}</div>}
    </div>
  );
}

// Tüm modüllerin durum kodları tek sözlükte: bir modül kendi rozet rengini
// ya da Türkçe karşılığını yeniden uydurmaz.
const STATUS_TONE: Record<string, string> = {
  // CRM
  draft: '', sent: 'badge-info', accepted: 'badge-ok', rejected: 'badge-danger',
  expired: 'badge-warn', cancelled: 'badge-danger', confirmed: 'badge-ok',
  delivered: 'badge-ok', invoiced: 'badge-ok',
  open: 'badge-info', won: 'badge-ok', lost: 'badge-danger',
  // Muhasebe
  approved: 'badge-info', posted: 'badge-ok', partially_paid: 'badge-warn',
  paid: 'badge-ok', reversed: 'badge-danger',
  // e-Fatura
  queued: 'badge-warn', error: 'badge-danger',
};

const STATUS_LABEL: Record<string, string> = {
  draft: 'Taslak', sent: 'Gönderildi', accepted: 'Onaylandı', rejected: 'Reddedildi',
  expired: 'Süresi doldu', cancelled: 'İptal', confirmed: 'Onaylandı',
  delivered: 'Teslim edildi', invoiced: 'Faturalandı',
  open: 'Açık', won: 'Kazanıldı', lost: 'Kaybedildi',
  approved: 'Onaylandı', posted: 'Muhasebeleşti', partially_paid: 'Kısmen ödendi',
  paid: 'Ödendi', reversed: 'Ters kayıt alındı',
  queued: 'Kuyrukta', error: 'Hata',
};

export function StatusBadge({ status }: { status: string }) {
  return <span className={`badge ${STATUS_TONE[status] ?? ''}`}>{STATUS_LABEL[status] ?? status}</span>;
}

export function Field({ label, hint, children }: { label: string; hint?: string; children: ReactNode }) {
  return (
    <div className="field">
      <label>{label}</label>
      {children}
      {hint && <span className="hint">{hint}</span>}
    </div>
  );
}

export function Empty({ children = 'Kayıt yok' }: { children?: ReactNode }) {
  return <div className="empty">{children}</div>;
}

export function ErrorBox({ error }: { error: unknown }) {
  if (!error) return null;
  const message = error instanceof Error ? error.message : String(error);
  return <div className="error-box">{message}</div>;
}

/** Gecikmeli arama kutusu — her tuşta istek atmaz. */
export function SearchInput({ value, onChange, placeholder = 'Ara…' }: {
  value: string; onChange: (v: string) => void; placeholder?: string;
}) {
  const [local, setLocal] = useState(value);
  useEffect(() => { setLocal(value); }, [value]);
  useEffect(() => {
    const id = setTimeout(() => { if (local !== value) onChange(local); }, 300);
    return () => clearTimeout(id);
  }, [local]); // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <input
      type="search" value={local} placeholder={placeholder}
      onChange={(e: ChangeEvent<HTMLInputElement>) => setLocal(e.target.value)}
    />
  );
}

export function Toolbar({ children }: { children: ReactNode }) {
  return <div className="toolbar">{children}</div>;
}

export function PageHead({ title, subtitle, actions }: {
  title: string; subtitle?: ReactNode; actions?: ReactNode;
}) {
  return (
    <div className="page-head">
      <div style={{ flex: 1 }}>
        <h1 className="page-title">{title}</h1>
        {subtitle && <p className="page-sub">{subtitle}</p>}
      </div>
      {actions}
    </div>
  );
}
