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
  // İK
  pending: 'badge-warn', calculated: 'badge-info',
  // Satın Alma
  ordered: 'badge-info', partially_received: 'badge-warn', received: 'badge-ok',
  // Abonelik
  trial: 'badge-info', active: 'badge-ok', past_due: 'badge-warn', suspended: 'badge-danger',
  // Destek
  new: 'badge-info', pending_customer: 'badge-warn', resolved: 'badge-ok', closed: '',
  // Bakım ve kalite
  scheduled: 'badge-info', in_progress: 'badge-warn', done: 'badge-ok',
  passed: 'badge-ok', failed: 'badge-danger',
  // Projeler
  on_hold: 'badge-warn', completed: 'badge-ok',
  // Satın alma / sayım
  applied: 'badge-ok',
};

const STATUS_LABEL: Record<string, string> = {
  draft: 'Taslak', sent: 'Gönderildi', accepted: 'Onaylandı', rejected: 'Reddedildi',
  expired: 'Süresi doldu', cancelled: 'İptal', confirmed: 'Onaylandı',
  delivered: 'Teslim edildi', invoiced: 'Faturalandı',
  open: 'Açık', won: 'Kazanıldı', lost: 'Kaybedildi',
  approved: 'Onaylandı', posted: 'Muhasebeleşti', partially_paid: 'Kısmen ödendi',
  paid: 'Ödendi', reversed: 'Ters kayıt alındı',
  queued: 'Kuyrukta', error: 'Hata',
  pending: 'Onay bekliyor', calculated: 'Hesaplandı',
  ordered: 'Sipariş edildi', partially_received: 'Kısmen teslim alındı',
  received: 'Teslim alındı',
  trial: 'Deneme', active: 'Etkin', past_due: 'Ödeme gecikti', suspended: 'Askıya alındı',
  // Destek: bu kodlar zaman tünelinde de görünüyor ve ham İngilizce
  // basıldıklarında arayüzün tek yerinde yabancı kelime bırakıyorlardı.
  new: 'Yeni', pending_customer: 'Müşteri bekleniyor',
  resolved: 'Çözüldü', closed: 'Kapandı',
  // Bakım ve kalite
  scheduled: 'Planlandı', in_progress: 'Devam ediyor', done: 'Tamamlandı',
  passed: 'Geçti', failed: 'Kaldı',
  // Projeler
  on_hold: 'Beklemede', completed: 'Tamamlandı',
  // Sayım
  applied: 'Uygulandı',
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

/**
 * Boş durum.
 *
 * Tek satır gri metin "yüklenemedi" gibi okunur. Burada iki katman var:
 * mono bir etiket (durumun adı) ve bir cümle (ne yapılacağı ya da neden boş
 * olduğu). Çağıran taraf yalnızca cümleyi verir; etiket sistemden gelir.
 */
export function Empty({ title = 'Boş', children }: { title?: string; children?: ReactNode }) {
  return (
    <div className="empty">
      <span className="empty-title">{title}</span>
      <span>{children ?? 'Gösterilecek kayıt yok.'}</span>
    </div>
  );
}

/**
 * Sayfayı sahiplenen boş durum.
 *
 * Kart içindeki `Empty` küçük bir satırdır ve bir tablonun sonunda doğrudur.
 * Ama tüm sayfa boşken aynı blok, başlığın altına sıkışmış ve altında yüzlerce
 * piksel hiçlik bırakan bir "yüklenemedi" görüntüsü verir. Bu sürüm alanı
 * doldurur, ne olduğunu söyler ve ilk eylemi gösterir.
 */
export function EmptyPage({ title, children, action }: {
  title: string; children: ReactNode; action?: ReactNode;
}) {
  return (
    <div className="empty-page">
      <span className="empty-title">{title}</span>
      <p>{children}</p>
      {action}
    </div>
  );
}

/**
 * Yatay kayabilen tablo sarmalayıcısı.
 *
 * `tbl-wrap`ten farkı: kaydırma varken kenarda GÖRÜNÜR bir tükenme gölgesi
 * bırakır. `aria-label` ile "sağa kaydırılabilir" demek yalnızca ekran
 * okuyucuya ulaşır; gören kullanıcı sütunların devam ettiğini fark etmezse
 * onları sessizce kaybeder.
 */
export function TableScroll({ children, label }: { children: ReactNode; label: string }) {
  return (
    <div className="tbl-scroll" tabIndex={0} role="region" aria-label={label}>
      {children}
    </div>
  );
}

/**
 * Sayfa kapanış satırı.
 *
 * Liste sayfaları bir tablonun son satırında biter ve bu, içeriğin bittiğini
 * değil eksik kaldığını düşündürür. Kapanış satırı toplamı ve kapsamı
 * söyleyerek sayfayı bilerek bitirir.
 */
export function PageFoot({ children }: { children: ReactNode }) {
  return <div className="page-foot">{children}</div>;
}

export function ErrorBox({ error }: { error: unknown }) {
  if (!error) return null;
  const message = error instanceof Error ? error.message : String(error);
  return <div className="error-box">{message}</div>;
}

/** Gecikmeli arama kutusu. Her tuşta istek atmaz. */
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

export function PageHead({ kicker, title, subtitle, actions }: {
  /** Başlığın üstündeki mono modül etiketi. Sayfanın hangi bölümde
   *  olduğunu başlığı uzatmadan söyler. */
  kicker?: string;
  title: string; subtitle?: ReactNode; actions?: ReactNode;
}) {
  return (
    <div className="page-head">
      <div style={{ flex: 1 }}>
        {kicker && <div className="page-kicker">{kicker}</div>}
        <h1 className="page-title">{title}</h1>
        {subtitle && <p className="page-sub">{subtitle}</p>}
      </div>
      {actions}
    </div>
  );
}
