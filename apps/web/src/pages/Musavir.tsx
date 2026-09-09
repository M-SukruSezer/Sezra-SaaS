import { useState, type FormEvent } from 'react';
import { useNavigate } from 'react-router-dom';
import { api } from '../api/client';
import { useItem, useList } from '../ui/useResource';
import { Card, Empty, ErrorBox, Field, PageFoot, PageHead } from '../ui';
import { tamZaman } from '../i18n';
import { useSession } from '../api/session';
import { Building2, Eye, LogOut } from 'lucide-react';

/**
 * Mali müşavir paneli.
 *
 * Müşavir, yetkili olduğu şirketleri buradan görür ve birine geçtiğinde
 * uygulamanın geri kalanı SALT OKUNUR açılır — sınırı sunucu çizer
 * (`core.accountant_tenant_id()` yalnızca for-select politikalarında). Bu
 * ekran yalnızca listeler ve moda girer/çıkar; hiçbir yazma yolu taşımaz.
 */

interface Invite {
  token: string; tenant_id: string; tenant_name: string;
  invited_by_name: string | null; invited_at: string;
}
interface AccessRow {
  tenant_id: string; tenant_name: string; tenant_slug: string; accepted_at: string | null;
}

export function MusavirPanel() {
  const { me, session, enterAccountantMode, exitAccountantMode, refresh } = useSession();
  const navigate = useNavigate();
  const invites = useList<Invite>('/accountant/invites');
  const tenants = useList<AccessRow>('/accountant/tenants');
  const [busy, setBusy] = useState<string | null>(null);
  const [err, setErr] = useState<unknown>(null);

  const aktifKiraci = session?.accountantMode ? me?.tenant : null;

  async function davetYanit(token: string, kabul: boolean) {
    setBusy(token); setErr(null);
    try {
      await api.post(`/accountant/invites/${kabul ? 'accept' : 'decline'}`, { token });
      await Promise.all([invites.reload(), tenants.reload(), refresh()]);
    } catch (e) { setErr(e); } finally { setBusy(null); }
  }

  function goruntule(tenantId: string) {
    enterAccountantMode(tenantId);
    // /me yeniden okunur (yeni kiracı adı, salt-okunur bayrağı), sonra
    // faturalara gidilir: müşavirin bakmak istediği ilk yer odur.
    void refresh().then(() => navigate('/finance/sales'));
  }

  function cik() {
    exitAccountantMode();
    void refresh();
  }

  return (
    <>
      <PageHead
        kicker="Mali Müşavir"
        title="Yetkili olduğum şirketler"
        subtitle="Bir şirkete geçtiğinizde verileri yalnızca görüntüleyebilirsiniz; hiçbir kayıt değiştirilemez."
      />

      {aktifKiraci && (
        <Card>
          <div className="row" style={{ justifyContent: 'space-between', alignItems: 'center' }}>
            <span>
              <strong>{aktifKiraci.name}</strong> verilerini salt okunur görüyorsunuz.
            </span>
            <button className="btn btn-sm" onClick={cik}>
              <LogOut size={15} /> Panele dön
            </button>
          </div>
        </Card>
      )}

      <ErrorBox error={err} />

      {invites.data.length > 0 && (
        <Card title="Bekleyen davetler">
          {invites.data.map((d) => (
            <div key={d.token} className="row"
                 style={{ justifyContent: 'space-between', alignItems: 'center', gap: 12, padding: '8px 0' }}>
              <span>
                <strong>{d.tenant_name}</strong>
                <span className="muted"> — {d.invited_by_name ?? 'bilinmiyor'} davet etti, {tamZaman(d.invited_at)}</span>
              </span>
              <span className="row" style={{ gap: 8 }}>
                <button className="btn btn-sm btn-primary" disabled={busy === d.token}
                        onClick={() => davetYanit(d.token, true)}>Kabul et</button>
                <button className="btn btn-sm" disabled={busy === d.token}
                        onClick={() => davetYanit(d.token, false)}>Reddet</button>
              </span>
            </div>
          ))}
        </Card>
      )}

      <Card title="Erişim yetkim olan şirketler">
        <ErrorBox error={tenants.error} />
        {!tenants.loading && tenants.data.length === 0 ? (
          <Empty title="Henüz yok">
            Bir şirket sizi mali müşavir olarak davet ettiğinde burada listelenir.
          </Empty>
        ) : (
          tenants.data.map((t) => (
            <div key={t.tenant_id} className="row"
                 style={{ justifyContent: 'space-between', alignItems: 'center', gap: 12, padding: '10px 0' }}>
              <span className="row" style={{ gap: 10, alignItems: 'center' }}>
                <Building2 size={16} aria-hidden="true" />
                <strong>{t.tenant_name}</strong>
              </span>
              <button className="btn btn-sm" onClick={() => goruntule(t.tenant_id)}
                      disabled={Boolean(session?.accountantMode) && me?.tenant?.id === t.tenant_id}>
                <Eye size={15} /> Görüntüle
              </button>
            </div>
          ))
        )}
      </Card>

      <PageFoot>
        {tenants.data.length} şirket. Erişim, ilgili şirketin yöneticisi tarafından her an kaldırılabilir.
      </PageFoot>
    </>
  );
}

// ---------------------------------------------------------------------------
// Kiracı tarafı: "Mali müşavirim" ayar kartı
// ---------------------------------------------------------------------------

interface CurrentAccountant {
  id: string; email: string; full_name: string | null;
  invited_at: string; accepted_at: string | null; status: 'active' | 'pending';
}

export function AccountantAccess() {
  const { can } = useSession();
  const yetkili = can('core.user.write.all');
  const current = useItem<CurrentAccountant | null>(yetkili ? '/core/accountant' : null);
  const [email, setEmail] = useState('');
  const [ad, setAd] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<unknown>(null);

  if (!yetkili) {
    return (
      <>
        <PageHead kicker="Şirket" title="Mali Müşavir" />
        <Empty title="Yetki yok">Bu ayarı yalnızca kullanıcı yönetimi yetkisi olanlar düzenleyebilir.</Empty>
      </>
    );
  }

  async function davetEt(e: FormEvent) {
    e.preventDefault();
    setBusy(true); setErr(null);
    try {
      await api.post('/core/accountant/invite', { email: email.trim(), full_name: ad.trim() || undefined });
      setEmail(''); setAd('');
      await current.reload();
    } catch (e2) { setErr(e2); } finally { setBusy(false); }
  }

  async function iptal(id: string) {
    setBusy(true); setErr(null);
    try {
      await api.delete(`/core/accountant/${id}`);
      await current.reload();
    } catch (e2) { setErr(e2); } finally { setBusy(false); }
  }

  const a = current.data;

  return (
    <>
      <PageHead
        kicker="Şirket"
        title="Mali Müşavir"
        subtitle="Mali müşavirinizi davet edin; faturalarınızı ve muhasebe kayıtlarınızı yalnızca GÖRÜNTÜLER, hiçbirini değiştiremez. Şirket başına tek müşavir erişimi tutulur."
      />

      <ErrorBox error={err} />
      <ErrorBox error={current.error} />

      {a ? (
        <Card title="Tanımlı müşavir">
          <div className="form-grid">
            <Field label="E-posta"><span>{a.email}</span></Field>
            <Field label="Ad"><span>{a.full_name ?? '—'}</span></Field>
            <Field label="Durum">
              <span className={`badge ${a.status === 'active' ? 'badge-ok' : 'badge-warn'}`}>
                {a.status === 'active' ? 'Erişim açık' : 'Davet bekliyor'}
              </span>
            </Field>
            <Field label="Davet"><span>{tamZaman(a.invited_at)}</span></Field>
            {a.accepted_at && <Field label="Kabul"><span>{tamZaman(a.accepted_at)}</span></Field>}
          </div>
          <PageFoot>
            <button className="btn btn-sm btn-danger" disabled={busy} onClick={() => iptal(a.id)}>
              Erişimi kaldır
            </button>
          </PageFoot>
        </Card>
      ) : (
        <Card title="Müşavir davet et">
          <form onSubmit={davetEt}>
            <Field label="E-posta" hint="Müşavir bu adresle giriş yapıp daveti kabul eder.">
              <input type="email" required value={email} onChange={(e) => setEmail(e.target.value)}
                     placeholder="musavir@ornek.com" />
            </Field>
            <Field label="Ad (isteğe bağlı)">
              <input value={ad} onChange={(e) => setAd(e.target.value)} placeholder="Mali Müşavir" />
            </Field>
            <div>
              <button className="btn btn-primary" type="submit" disabled={busy || !email.trim()}>
                Davet gönder
              </button>
            </div>
          </form>
        </Card>
      )}
    </>
  );
}

/** Panel navigasyonda görünsün mü: yalnızca müşavir erişimi olanlara. */
export function musavirErisimiVar(me: { accountant_tenants?: unknown[] } | null): boolean {
  return (me?.accountant_tenants?.length ?? 0) > 0;
}
