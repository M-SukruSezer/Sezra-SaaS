import { useEffect, useRef, useState, type FormEvent } from 'react';
import { UserPlus } from 'lucide-react';
import { api } from '../api/client';
import { useItem, useList } from '../ui/useResource';
import {
  Card, Empty, EmptyPage, ErrorBox, Field, PageFoot, PageHead, Stat, StatusBadge,
  TableScroll, Toolbar,
} from '../ui';
import { date, num } from '../i18n';
import { useSession } from '../api/session';
import { Avatar } from '../ui/Avatar';
import type { Me } from '../api/types';
import { useBranding } from '../api/branding';
import type { BrandingContact } from '../api/branding';
import { applyTheme, readTheme, type Theme } from '../ui/theme';

/**
 * Ayarlar.
 *
 * Dört ekran, dört farklı yetki alanı:
 *   Şirket          core.tenant.write.all
 *   Tanımlar        core.tax.write.all / core.uom.write.all
 *   Hesap           herkes (yalnızca KENDİ kaydı)
 *   Sistem Yönetimi core.user.read.all, denetim izi için core.audit.read.all
 *
 * Yetkisi olmayan kullanıcı formu göremez; alanları pasifleştirip göstermek
 * "yapabilirsin ama olmuyor" hissi verir. RLS zaten engelliyor, arayüz de
 * baştan söylüyor.
 */
/**
 * Cekirdek tablolar tanimlayicilarini ingilizce tutar; ekranda okunur ad
 * gosterilir, kod ikinci satirda kalir ki destek konusmasinda eslesme kopmasin.
 * Eslesmeyen bir kod gelirse kodun kendisi gosterilir: bir modul eklendiginde
 * ekran bos deger yerine ham kodu gostererek calismaya devam eder.
 */
const UOM_CATEGORY: Record<string, string> = {
  unit: 'Adet', weight: 'Ağırlık', volume: 'Hacim',
  length: 'Uzunluk', area: 'Alan', time: 'Zaman',
};

const SEQUENCE_LABEL: Record<string, string> = {
  crm_quotation: 'Teklif',
  crm_sale_order: 'Satış siparişi',
  finance_journal: 'Yevmiye fişi',
  finance_payment: 'Tahsilat / ödeme',
  finance_purchase_invoice: 'Alış faturası',
  finance_sale_invoice: 'Satış faturası',
  helpdesk_ticket: 'Destek talebi',
  hr_payroll: 'Bordro',
  inventory_count: 'Sayım',
  inventory_move: 'Stok hareketi',
  maintenance_work_order: 'Bakım iş emri',
  pos_receipt: 'Satış fişi',
  pos_session: 'Kasa oturumu',
  project_code: 'Proje',
  purchase_order: 'Satın alma siparişi',
  purchase_receipt: 'Mal kabul',
  purchase_requisition: 'Satın alma talebi',
  quality_inspection: 'Kalite kontrol',
  quality_nonconformity: 'Uygunsuzluk',
};

function useSaver<T>(save: (patch: Partial<T>) => Promise<unknown>) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [saved, setSaved] = useState(false);

  const run = async (patch: Partial<T>) => {
    setBusy(true); setError(null); setSaved(false);
    try {
      await save(patch);
      setSaved(true);
      window.setTimeout(() => setSaved(false), 2500);
    } catch (err) { setError(err); } finally { setBusy(false); }
  };
  return { run, busy, error, saved };
}

function SaveRow({ busy, saved, label = 'Kaydet' }: {
  busy: boolean; saved: boolean; label?: string;
}) {
  return (
    <div className="row" style={{ marginTop: 16 }}>
      <button className="btn btn-primary" type="submit" disabled={busy}>
        {busy ? 'Kaydediliyor…' : label}
      </button>
      {/* Kaydedildi bilgisi renk DEĞİL metin taşır ve kendiliğinden kaybolur. */}
      {saved && <span className="badge badge-ok">Kaydedildi</span>}
    </div>
  );
}

// =============================================================================
// SMS sağlayıcısı
// =============================================================================
// PAROLA GERİ OKUNAMAZ. Sunucu kimlik alanlarını yalnızca yazar; okumada
// "tanımlı mı" bilgisi döner. Bu yüzden form parolayı boş açar ve boş
// gönderildiğinde sunucu MEVCUDU KORUR -- aksi hâlde gönderen adını
// değiştiren kullanıcı parolasını kaybederdi. Silmek ayrı bir eylemdir.
interface SmsAyar {
  provider: string;
  sender: string | null;
  username: string | null;
  is_active: boolean;
  password_set: boolean;
  api_key_set: boolean;
}

interface Saglayici { code: string; ad: string; gerekliAlanlar: string[] }

export function SmsSettings() {
  const ayar = useItem<SmsAyar>('/core/sms/settings');
  const saglayicilar = useList<Saglayici>('/core/sms/providers');
  const [form, setForm] = useState<{
    provider: string; sender: string; username: string; password: string;
    api_key: string; is_active: boolean;
  } | null>(null);
  const [deneme, setDeneme] = useState('');
  const [denemeSonuc, setDenemeSonuc] = useState<string | null>(null);
  const [deniyor, setDeniyor] = useState(false);

  useEffect(() => {
    if (!ayar.data || form) return;
    setForm({
      provider: ayar.data.provider,
      sender: ayar.data.sender ?? '',
      username: ayar.data.username ?? '',
      password: '',
      api_key: '',
      is_active: ayar.data.is_active,
    });
  }, [ayar.data, form]);

  const saver = useSaver<Record<string, unknown>>(async (patch) => {
    await api.post('/core/sms/settings', patch);
    await ayar.reload();
  });

  /**
   * Deneme mesajı.
   *
   * KENDİ NUMARANIZA: ayarın gerçekten çalıştığını görmenin tek yolu bir
   * mesaj göndermek, ve bunu bir müşteri numarasıyla denemek müşteriye
   * anlamsız bir mesaj atmak olurdu. `is_commercial: false` -- deneme
   * bilgilendirmedir, İYS izni aranmaz.
   */
  const denemeGonder = async () => {
    setDeniyor(true); setDenemeSonuc(null);
    try {
      const r = await api.post<{ data: { status: string; error: string | null } }>(
        '/core/sms/send',
        { phone: deneme, body: 'Sezra deneme mesajı.', is_commercial: false });
      setDenemeSonuc(r.data.status === 'sent'
        ? 'Gönderildi.'
        : (r.data.error ?? 'Gönderilemedi.'));
    } catch (err) {
      setDenemeSonuc(err instanceof Error ? err.message : 'Gönderilemedi.');
    } finally { setDeniyor(false); }
  };

  if (!form) return null;
  const secili = saglayicilar.data.find((p) => p.code === form.provider);
  const gerekli = (alan: string) => secili?.gerekliAlanlar.includes(alan) ?? false;

  return (
    <>
      <PageHead
        kicker="Ayarlar"
        title="SMS Sağlayıcısı"
        subtitle="Operatör bilgileri ve gönderen adı. Ayar yapılmadan mesajlar yalnızca kayda yazılır."
      />
      <ErrorBox error={ayar.error ?? saver.error} />

      <Card title="Sağlayıcı">
        <form onSubmit={(e) => { e.preventDefault(); saver.run(form); }}>
          <div className="form-grid">
            <Field label="Sağlayıcı"
                   hint="Kayıt sağlayıcısı (log) mesajı göndermez, yalnızca kaydeder">
              <select value={form.provider}
                      onChange={(e) => setForm({ ...form, provider: e.target.value })}>
                {saglayicilar.data.map((p) => (
                  <option key={p.code} value={p.code}>{p.ad}</option>
                ))}
              </select>
            </Field>
            <Field label="Gönderen adı"
                   hint="Operatörde tanımlı başlık. Tanımsız başlıkla mesaj gitmez.">
              <input value={form.sender}
                     onChange={(e) => setForm({ ...form, sender: e.target.value })} />
            </Field>
            {gerekli('username') && (
              <Field label="Kullanıcı adı">
                <input value={form.username} autoComplete="off"
                       onChange={(e) => setForm({ ...form, username: e.target.value })} />
              </Field>
            )}
            {gerekli('password') && (
              <Field
                label="Parola"
                hint={ayar.data?.password_set
                  ? 'Kayıtlı. Boş bırakırsanız değişmez.'
                  : 'Henüz tanımlı değil.'}
              >
                <input type="password" value={form.password} autoComplete="new-password"
                       placeholder={ayar.data?.password_set ? '••••••••' : ''}
                       onChange={(e) => setForm({ ...form, password: e.target.value })} />
              </Field>
            )}
            {gerekli('api_key') && (
              <Field
                label="API anahtarı"
                hint={ayar.data?.api_key_set
                  ? 'Kayıtlı. Boş bırakırsanız değişmez.'
                  : 'Henüz tanımlı değil.'}
              >
                <input type="password" value={form.api_key} autoComplete="off"
                       placeholder={ayar.data?.api_key_set ? '••••••••' : ''}
                       onChange={(e) => setForm({ ...form, api_key: e.target.value })} />
              </Field>
            )}
          </div>

          <label className="onay-satir">
            <input type="checkbox" checked={form.is_active}
                   onChange={(e) => setForm({ ...form, is_active: e.target.checked })} />
            Bu sağlayıcı etkin
          </label>
          {/* KAPALIYKEN NE OLDUĞUNU SÖYLE: "etkin değil" tek başına, mesajların
              sessizce kaybolduğu izlenimi verir. Kaybolmuyorlar, kaydediliyorlar. */}
          <p className="muted micro">
            Etkin değilken mesajlar operatöre gitmez, yalnızca kayda yazılır.
          </p>

          <SaveRow busy={saver.busy} saved={saver.saved} />
        </form>
      </Card>

      <Card title="Deneme mesajı">
        <p className="muted">
          Ayarın çalıştığını görmenin tek yolu bir mesaj göndermektir. Kendi cep
          numaranızı yazın; deneme bilgilendirme iletisi olarak gider.
        </p>
        <div className="form-grid">
          <Field label="Cep telefonu">
            <input value={deneme} inputMode="tel" placeholder="0532 123 45 67"
                   onChange={(e) => setDeneme(e.target.value)} />
          </Field>
        </div>
        <div className="row" style={{ marginTop: 16 }}>
          <button className="btn" disabled={deneme.trim() === '' || deniyor}
                  aria-busy={deniyor} onClick={() => void denemeGonder()}>
            {deniyor ? 'Gönderiliyor…' : 'Deneme gönder'}
          </button>
          {denemeSonuc && <span className="muted">{denemeSonuc}</span>}
        </div>
      </Card>

      <PageFoot>
        <span>Parola ve API anahtarı yazıldıktan sonra bir daha okunamaz.</span>
        <span>Gönderilen ve engellenen tüm mesajlar kayıtta saklanır.</span>
      </PageFoot>
    </>
  );
}

// =============================================================================
// Bağlı mail hesapları (T-025)
// =============================================================================
// KİŞİSEL: her kullanıcı KENDİ mail hesaplarını bağlar. Kiracı yöneticisi bile
// başkasının kimlik bilgisini göremez (sunucuda RLS). Parola/token uygulama
// katmanında şifreli saklanır ve HİÇBİR okuma yanıtında dönmez; bu yüzden form
// parolayı boş açar, boş gönderilince mevcut korunur.
interface MailAccount {
  id: string;
  provider: 'imap' | 'pop3' | 'ms_graph' | 'gmail';
  display_name: string;
  email_address: string;
  config: { host?: string; port?: number; security?: string; username?: string };
  status: 'pending' | 'verified' | 'error' | 'expired';
  status_detail: string | null;
  last_verified_at: string | null;
  has_secret: boolean;
}

const MAIL_PROVIDER_AD: Record<string, string> = {
  imap: 'IMAP', pop3: 'POP3', ms_graph: 'Microsoft Graph', gmail: 'Gmail',
};
const MAIL_STATUS: Record<string, { ad: string; ton: string }> = {
  verified: { ad: 'Doğrulandı', ton: 'badge-ok' },
  pending: { ad: 'Beklemede', ton: 'badge-warn' },
  error: { ad: 'Hata', ton: 'badge-danger' },
  expired: { ad: 'Süresi doldu', ton: 'badge-warn' },
};

export function MailAccounts() {
  const hesaplar = useList<MailAccount>('/core/mail/accounts');
  const saglayicilar = useList<{ code: string; configured: boolean }>('/core/mail/providers');
  const [form, setForm] = useState({
    provider: 'imap' as MailAccount['provider'],
    display_name: '', email: '',
    host: '', port: '', security: 'ssl', password: '',
  });
  const [ekleHata, setEkleHata] = useState<unknown>(null);
  const [ekliyor, setEkliyor] = useState(false);
  const [testSonuc, setTestSonuc] = useState<Record<string, string>>({});
  const [mesgul, setMesgul] = useState<string | null>(null);

  const sunuculuMu = form.provider === 'imap' || form.provider === 'pop3';

  const ekle = async (e: FormEvent) => {
    e.preventDefault();
    setEkliyor(true); setEkleHata(null);
    try {
      const govde: Record<string, unknown> = {
        provider: form.provider,
        display_name: form.display_name,
        email: form.email,
        config: sunuculuMu
          ? { host: form.host, port: form.port ? Number(form.port) : undefined, security: form.security, username: form.email }
          : {},
      };
      if (sunuculuMu && form.password) govde.secret = { password: form.password };
      await api.post('/core/mail/accounts', govde);
      setForm((f) => ({ ...f, display_name: '', email: '', host: '', port: '', password: '' }));
      await hesaplar.reload();
    } catch (err) { setEkleHata(err); } finally { setEkliyor(false); }
  };

  const testEt = async (h: MailAccount) => {
    setMesgul(h.id); setTestSonuc((s) => ({ ...s, [h.id]: '' }));
    try {
      const r = await api.post<{ data: { status: string; detail: string } }>(
        `/core/mail/accounts/${h.id}/verify`, {});
      setTestSonuc((s) => ({ ...s, [h.id]: r.data.detail }));
      await hesaplar.reload();
    } catch (err) {
      setTestSonuc((s) => ({ ...s, [h.id]: err instanceof Error ? err.message : 'Test başarısız' }));
    } finally { setMesgul(null); }
  };

  const sil = async (h: MailAccount) => {
    if (!window.confirm(`${h.display_name} (${h.email_address}) bağlantısı silinsin mi?`)) return;
    setMesgul(h.id);
    try { await api.delete(`/core/mail/accounts/${h.id}`); await hesaplar.reload(); }
    catch (err) { setEkleHata(err); } finally { setMesgul(null); }
  };

  return (
    <>
      <PageHead
        kicker="Ayarlar"
        title="Mail hesapları"
        subtitle="Kendi e-posta hesabınızı bağlayın. Kimlik bilgileriniz şifreli saklanır ve yalnızca size görünür."
      />
      <ErrorBox error={ekleHata} />

      <Card title="Yeni hesap">
        <form onSubmit={ekle}>
          <div className="form-grid">
            <Field label="Sağlayıcı">
              <select value={form.provider}
                      onChange={(e) => setForm((f) => ({ ...f, provider: e.target.value as MailAccount['provider'] }))}>
                {saglayicilar.data.map((p) => (
                  <option key={p.code} value={p.code} disabled={!p.configured}>
                    {MAIL_PROVIDER_AD[p.code] ?? p.code}{p.configured ? '' : ' (yapılandırılmamış)'}
                  </option>
                ))}
              </select>
            </Field>
            <Field label="Etiket" hint="Bu hesabı nasıl anacaksınız">
              <input value={form.display_name} required
                     onChange={(e) => setForm((f) => ({ ...f, display_name: e.target.value }))} />
            </Field>
            <Field label="E-posta adresi">
              <input type="email" value={form.email} required inputMode="email"
                     onChange={(e) => setForm((f) => ({ ...f, email: e.target.value }))} />
            </Field>
            {sunuculuMu && (
              <>
                <Field label="Sunucu">
                  <input value={form.host} required placeholder="imap.ornek.com"
                         onChange={(e) => setForm((f) => ({ ...f, host: e.target.value }))} />
                </Field>
                <Field label="Güvenlik">
                  <select value={form.security}
                          onChange={(e) => setForm((f) => ({ ...f, security: e.target.value }))}>
                    <option value="ssl">SSL/TLS</option>
                    <option value="starttls">STARTTLS</option>
                    <option value="none">Şifresiz</option>
                  </select>
                </Field>
                <Field label="Port" hint="Boş bırakılırsa güvenlik ayarına göre seçilir">
                  <input value={form.port} inputMode="numeric" placeholder="993"
                         onChange={(e) => setForm((f) => ({ ...f, port: e.target.value }))} />
                </Field>
                <Field label="Parola" hint="Şifreli saklanır, bir daha görüntülenmez">
                  <input type="password" value={form.password} required autoComplete="new-password"
                         onChange={(e) => setForm((f) => ({ ...f, password: e.target.value }))} />
                </Field>
              </>
            )}
          </div>
          <div className="row" style={{ marginTop: 16 }}>
            <button className="btn btn-primary" type="submit" disabled={ekliyor}>
              {ekliyor ? 'Ekleniyor…' : 'Hesabı ekle'}
            </button>
          </div>
        </form>
      </Card>

      <Card title="Bağlı hesaplar" padded={false}>
        <TableScroll label="Bağlı mail hesapları">
          <table className="tbl">
            <thead>
              <tr>
                <th>Etiket</th><th>Sağlayıcı</th><th>Adres</th><th>Durum</th>
                <th>Son doğrulama</th><th />
              </tr>
            </thead>
            <tbody>
              {hesaplar.data.map((h) => {
                const st = MAIL_STATUS[h.status] ?? { ad: h.status, ton: '' };
                return (
                  <tr key={h.id}>
                    <td>{h.display_name}</td>
                    <td>{MAIL_PROVIDER_AD[h.provider] ?? h.provider}</td>
                    <td className="num">{h.email_address}</td>
                    <td>
                      <span className={`badge ${st.ton}`}>{st.ad}</span>
                      {testSonuc[h.id] && <div className="hint">{testSonuc[h.id]}</div>}
                      {!testSonuc[h.id] && h.status_detail && <div className="hint">{h.status_detail}</div>}
                    </td>
                    <td>{h.last_verified_at ? date(h.last_verified_at) : '-'}</td>
                    <td className="row" style={{ gap: 8, justifyContent: 'flex-end' }}>
                      {(h.provider === 'imap' || h.provider === 'pop3') && (
                        <button className="btn" disabled={mesgul === h.id}
                                onClick={() => void testEt(h)}>
                          {mesgul === h.id ? 'Deneniyor…' : 'Bağlantıyı test et'}
                        </button>
                      )}
                      <button className="btn btn-ghost" disabled={mesgul === h.id}
                              onClick={() => void sil(h)}>Sil</button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </TableScroll>
        {!hesaplar.loading && hesaplar.data.length === 0 && (
          <Empty title="Bağlı hesap yok">
            Yukarıdaki formdan e-posta hesabınızı bağlayın.
          </Empty>
        )}
      </Card>

      <PageFoot>
        <span>Kimlik bilgileriniz şifreli saklanır ve yalnızca size görünür.</span>
        <span>Bu ekran yalnızca bağlantı kurar; posta çekme/gönderme kapsam dışıdır.</span>
      </PageFoot>
    </>
  );
}

// =============================================================================
// Şirket
// =============================================================================
interface Tenant {
  id: string; slug: string; name: string; legal_name?: string;
  tax_office?: string; tax_no?: string; sector?: string;
  country_code: string; currency: string; locale: string; timezone: string;
  fiscal_year_start_month: number;
  plan_code?: string; subscription_status?: string;
  seats?: number; branch_quota?: number;
}

export function CompanySettings() {
  const { can } = useSession();
  const tenant = useItem<Tenant>('/core/tenant');
  const branches = useList<{
    id: string; code: string; name: string; city?: string;
    is_headquarter: boolean; is_active: boolean;
  }>('/core/branches', { limit: 100 });

  const [form, setForm] = useState<Partial<Tenant>>({});
  useEffect(() => { if (tenant.data) setForm(tenant.data); }, [tenant.data]);

  const editable = can('core.tenant.write.all');
  const saver = useSaver<Tenant>(async (patch) => {
    await api.patch('/core/tenant', patch);
    await tenant.reload();
  });

  const set = (k: keyof Tenant) => (e: { target: { value: string } }) =>
    setForm((f) => ({ ...f, [k]: e.target.value }));

  if (tenant.loading && !tenant.data) return <div className="empty">Yükleniyor…</div>;

  return (
    <>
      <PageHead
        kicker="Ayarlar"
        title="Şirket"
        subtitle="Fatura başlığında ve resmî belgelerde görünen bilgiler."
      />
      <ErrorBox error={saver.error ?? tenant.error} />

      <div className="settings-split">
        <Card title="Şirket bilgileri">
          {!editable ? (
            <Empty title="Salt okunur">
              Şirket bilgilerini düzenleme yetkiniz yok. Şirket yöneticinize başvurun.
            </Empty>
          ) : (
            <form onSubmit={(e) => { e.preventDefault(); saver.run(form); }}>
              <div className="form-grid">
                <Field label="Ticari unvan">
                  <input value={form.name ?? ''} onChange={set('name')} required />
                </Field>
                <Field label="Yasal unvan" hint="Faturada görünen tam unvan">
                  <input value={form.legal_name ?? ''} onChange={set('legal_name')} />
                </Field>
                <Field label="Vergi dairesi">
                  <input value={form.tax_office ?? ''} onChange={set('tax_office')} />
                </Field>
                <Field label="VKN / TCKN">
                  <input value={form.tax_no ?? ''} onChange={set('tax_no')} inputMode="numeric" />
                </Field>
                <Field label="Sektör">
                  <input value={form.sector ?? ''} onChange={set('sector')} />
                </Field>
                <Field label="Para birimi" hint="Yeni belgelerde varsayılan">
                  <select value={form.currency ?? 'TRY'} onChange={set('currency')}>
                    <option value="TRY">TRY · Türk lirası</option>
                    <option value="USD">USD · Amerikan doları</option>
                    <option value="EUR">EUR · Euro</option>
                  </select>
                </Field>
                <Field label="Saat dilimi">
                  <input value={form.timezone ?? ''} onChange={set('timezone')} />
                </Field>
                <Field label="Mali yıl başlangıcı" hint="Raporlar bu aya göre kırılır">
                  <select
                    value={String(form.fiscal_year_start_month ?? 1)}
                    onChange={(e) => setForm((f) => ({
                      ...f, fiscal_year_start_month: Number(e.target.value),
                    }))}
                  >
                    {Array.from({ length: 12 }, (_, i) => i + 1).map((m) => (
                      <option key={m} value={m}>{String(m).padStart(2, '0')}. ay</option>
                    ))}
                  </select>
                </Field>
              </div>
              <SaveRow busy={saver.busy} saved={saver.saved} />
            </form>
          )}
        </Card>

        <div>
          <Card title="Abonelik">
            <table className="tbl">
              <tbody>
                <tr><td className="muted">Plan</td><td className="r">{tenant.data?.plan_code ?? '—'}</td></tr>
                <tr>
                  <td className="muted">Durum</td>
                  <td className="r">
                    {tenant.data?.subscription_status
                      ? <StatusBadge status={tenant.data.subscription_status} />
                      : '—'}
                  </td>
                </tr>
                <tr><td className="muted">Koltuk</td><td className="r">{tenant.data?.seats ?? '—'}</td></tr>
                <tr><td className="muted">Şube kotası</td><td className="r">{tenant.data?.branch_quota ?? '—'}</td></tr>
                <tr><td className="muted">Adres kodu</td><td className="r">{tenant.data?.slug}</td></tr>
              </tbody>
            </table>
            <p className="hint" style={{ marginTop: 12 }}>
              Plan ve koltuk sayısı Sezra tarafından yönetilir. Değişiklik için destek ile görüşün.
            </p>
          </Card>

          <Card title="Şubeler" padded={false}>
            <div className="tbl-wrap">
              <table className="tbl">
                <thead>
                  <tr><th>Kod</th><th>Ad</th><th>Şehir</th><th>Durum</th></tr>
                </thead>
                <tbody>
                  {branches.data.map((b) => (
                    <tr key={b.id}>
                      <td><strong>{b.code}</strong></td>
                      <td>
                        {b.name}
                        {b.is_headquarter && <span className="badge badge-info" style={{ marginLeft: 8 }}>Merkez</span>}
                      </td>
                      <td className="muted">{b.city ?? '—'}</td>
                      <td>{b.is_active
                        ? <span className="badge badge-ok">Aktif</span>
                        : <span className="badge">Kapalı</span>}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
              {!branches.loading && branches.data.length === 0 && (
                <Empty title="Boş">Tanımlı şube yok.</Empty>
              )}
            </div>
          </Card>
        </div>
      </div>
      <PageFoot>
        <span>Bu bilgiler fatura başlığında ve resmî belgelerde görünür.</span>
        <span>Plan, koltuk ve şube kotası Sezra tarafından yönetilir.</span>
      </PageFoot>
    </>
  );
}

// =============================================================================
// Tanımlar
// =============================================================================
export function Definitions() {
  const taxes = useList<{
    id: string; code: string; name: string; rate: string; kind: string;
    withholding_num?: number; withholding_den?: number; is_active: boolean;
  }>('/core/taxes', { limit: 100 });
  const uoms = useList<{ id: string; code: string; name: string; category: string; is_active: boolean }>(
    '/core/uoms', { limit: 100 });
  const cats = useList<{ id: string; code?: string; name: string; path?: string }>(
    '/core/product-categories', { limit: 100 });
  const seqs = useList<{
    id: string; code: string; prefix: string; padding: number;
    period: string; period_key: string; next_value: string;
  }>('/core/sequences', { limit: 100 });

  return (
    <>
      <PageHead
        kicker="Ayarlar"
        title="Tanımlar"
        subtitle="Vergi oranları, ölçü birimleri, ürün kategorileri ve belge numaralandırma."
      />

      <div className="settings-split">
        <Card title="Vergiler" padded={false}>
          <div className="tbl-wrap">
            <table className="tbl">
              <thead>
                <tr><th>Kod</th><th>Ad</th><th className="r">Oran</th><th>Tür</th></tr>
              </thead>
              <tbody>
                {taxes.data.map((t) => (
                  <tr key={t.id}>
                    <td><strong>{t.code}</strong></td>
                    <td>{t.name}</td>
                    <td className="r">
                      {t.kind === 'withholding' && t.withholding_num
                        ? `${t.withholding_num}/${t.withholding_den}`
                        : `%${num(t.rate)}`}
                    </td>
                    <td>
                      <span className="badge">
                        {t.kind === 'vat' ? 'KDV' : t.kind === 'withholding' ? 'Tevkifat' : 'İstisna'}
                      </span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            {!taxes.loading && taxes.data.length === 0 && <Empty />}
          </div>
        </Card>

        <Card title="Ölçü birimleri" padded={false}>
          <div className="tbl-wrap">
            <table className="tbl">
              <thead><tr><th>Kod</th><th>Ad</th><th>Kategori</th></tr></thead>
              <tbody>
                {uoms.data.map((u) => (
                  <tr key={u.id}>
                    <td><strong>{u.code}</strong></td>
                    <td>{u.name}</td>
                    <td className="muted">{UOM_CATEGORY[u.category] ?? u.category}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            {!uoms.loading && uoms.data.length === 0 && <Empty />}
          </div>
        </Card>
      </div>

      <div className="settings-split">
        <Card title="Belge numaralandırma" padded={false}>
          <div className="tbl-wrap">
            <table className="tbl">
              <thead>
                <tr><th>Belge</th><th>Ön ek</th><th>Dönem</th><th className="r">Sıradaki</th></tr>
              </thead>
              <tbody>
                {seqs.data.map((s) => (
                  <tr key={s.id}>
                    <td>
                      <strong>{SEQUENCE_LABEL[s.code] ?? s.code}</strong>
                      <div className="muted micro">{s.code}</div>
                    </td>
                    <td className="muted">{s.prefix || '—'}</td>
                    <td>
                      <span className="badge">
                        {s.period === 'year' ? 'Yıllık' : s.period === 'month' ? 'Aylık' : 'Sürekli'}
                      </span>
                      {s.period_key && <span className="muted micro"> {s.period_key}</span>}
                    </td>
                    <td className="r">
                      {String(s.next_value).padStart(s.padding, '0')}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            {!seqs.loading && seqs.data.length === 0 && (
              <Empty title="Boş">Bu kiracıda belge serisi tanımlı değil.</Empty>
            )}
          </div>
        </Card>

        <Card title="Ürün kategorileri" padded={false}>
          <div className="tbl-wrap">
            <table className="tbl">
              <thead><tr><th>Kod</th><th>Ad</th><th>Yol</th></tr></thead>
              <tbody>
                {cats.data.map((c) => (
                  <tr key={c.id}>
                    <td><strong>{c.code ?? '—'}</strong></td>
                    <td>{c.name}</td>
                    <td className="muted">{c.path ?? '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            {!cats.loading && cats.data.length === 0 && (
              <Empty title="Boş">Kategori tanımlanmamış.</Empty>
            )}
          </div>
        </Card>
      </div>
      <PageFoot>
        <span>Vergi oranları ve ölçü birimleri yeni belgelerde varsayılan olarak kullanılır.</span>
        <span>Belge numarası dönem başında sıfırlanır; verilmiş bir numara geri alınmaz.</span>
      </PageFoot>
    </>
  );
}

// =============================================================================
// Hesap
// =============================================================================
/** Profil görselinde kabul edilen türler ve üst sınır. */
const AVATAR_TURLERI = ['image/png', 'image/jpeg', 'image/webp'];
const AVATAR_AZAMI_BAYT = 256 * 1024;

/**
 * Profil görseli.
 *
 * İKİ SEÇENEK: kullanıcı kendi fotoğrafını yükler ya da sistemin ürettiği
 * renkli baş harfte kalır. Üretilen avatar bir "yer tutucu" değil geçerli
 * bir seçim -- fotoğraf yüklemek zorunlu değil.
 *
 * GÖRSEL VERİTABANINDA data URI olarak durur (`core.users.avatar_url`).
 * Nesne deposu olmadığı için en küçük sınır burada: 256 KB. Logo'dan daha
 * dar, çünkü avatar her kullanıcı satırında taşınır.
 *
 * SVG KABUL EDİLMEZ: logo'da SVG'yi içerik taraması yaparak alıyoruz, ama
 * orayı yalnızca platform yöneticisi yazabiliyor. Profil görselini HER
 * kullanıcı yazabildiği için burada belge türü hiç kabul edilmez.
 */
function ProfilGorseli({ me, onDegisti }: { me: Me; onDegisti: () => Promise<void> }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [saved, setSaved] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  const kaydet = async (deger: string | null) => {
    setBusy(true); setError(null); setSaved(false);
    try {
      await api.patch('/core/profile', { avatar_url: deger });
      await onDegisti();
      setSaved(true);
      window.setTimeout(() => setSaved(false), 2500);
    } catch (err) { setError(err); } finally {
      setBusy(false);
      if (inputRef.current) inputRef.current.value = '';
    }
  };

  const yukle = async (file: File) => {
    setError(null);
    if (!AVATAR_TURLERI.includes(file.type)) {
      setError(new Error(`Desteklenmeyen tür (${file.type || 'bilinmiyor'}). PNG, JPEG ya da WebP yükleyin.`));
      return;
    }
    if (file.size > AVATAR_AZAMI_BAYT) {
      setError(new Error(`Dosya ${Math.round(file.size / 1024)} KB; sınır 256 KB.`));
      return;
    }
    setBusy(true);
    try {
      const dataUri = await new Promise<string>((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(String(reader.result));
        reader.onerror = () => reject(new Error('Dosya okunamadı'));
        reader.readAsDataURL(file);
      });
      await kaydet(dataUri);
    } catch (err) { setError(err); setBusy(false); }
  };

  return (
    <Card
      title="Profil görseli"
      actions={me.user.avatar_url
        ? <button className="btn btn-sm" disabled={busy} aria-busy={busy}
                  onClick={() => void kaydet(null)}>
            {busy ? 'Kaldırılıyor…' : 'Fotoğrafı kaldır'}
          </button>
        : null}
    >
      <div className="profil-gorsel">
        <Avatar id={me.user.id} ad={me.user.full_name ?? me.user.email}
                gorsel={me.user.avatar_url ?? null} olcu="lg" />
        <p className="muted">
          {me.user.avatar_url
            ? 'Yüklediğiniz fotoğraf kullanılıyor.'
            : 'Sistem sizin için renkli bir baş harf üretti. Bu görsel adınıza ve kimliğinize bağlı; her cihazda aynı kalır.'}
        </p>
      </div>

      <Field label={me.user.avatar_url ? 'Fotoğrafı değiştir' : 'Fotoğraf yükle'}
             hint="PNG, JPEG ya da WebP · en fazla 256 KB · kare görseller daha iyi durur">
        <input
          ref={inputRef}
          type="file"
          accept={AVATAR_TURLERI.join(',')}
          disabled={busy}
          aria-busy={busy}
          onChange={(e) => { const f = e.target.files?.[0]; if (f) void yukle(f); }}
        />
      </Field>

      <ErrorBox error={error} />
      <div className="row">
        {busy && <span className="badge badge-info">Yükleniyor…</span>}
        {saved && <span className="badge badge-ok">Güncellendi</span>}
      </div>
    </Card>
  );
}

export function AccountSettings() {
  const { me, refresh } = useSession();
  const [form, setForm] = useState({
    full_name: me?.user.full_name ?? '',
    phone: me?.user.phone ?? '',
    locale: me?.user.locale ?? 'tr-TR',
    timezone: me?.user.timezone ?? 'Europe/Istanbul',
  });
  const [theme, setTheme] = useState<Theme>(() => readTheme());

  const saver = useSaver<typeof form>(async (patch) => {
    await api.patch('/core/profile', patch);
    await refresh();
  });

  if (!me) return null;

  return (
    <>
      <PageHead
        kicker="Ayarlar"
        title="Hesap"
        subtitle="Kişisel bilgileriniz ve bu tarayıcıya özel tercihler."
      />
      <ErrorBox error={saver.error} />

      <div className="settings-split">
        <ProfilGorseli me={me} onDegisti={refresh} />

        <Card title="Profil">
          <form onSubmit={(e) => { e.preventDefault(); saver.run(form); }}>
            <div className="form-grid">
              <Field label="Ad soyad">
                <input
                  value={form.full_name}
                  onChange={(e) => setForm((f) => ({ ...f, full_name: e.target.value }))}
                  required
                />
              </Field>
              <Field label="E-posta" hint="E-posta kimlik sağlayıcıdan gelir, buradan değişmez">
                <input value={me.user.email} disabled />
              </Field>
              <Field label="Telefon">
                <input
                  value={form.phone}
                  onChange={(e) => setForm((f) => ({ ...f, phone: e.target.value }))}
                  inputMode="tel"
                />
              </Field>
              <Field label="Saat dilimi" hint="Tarihler bu dilime göre gösterilir">
                <input
                  value={form.timezone}
                  onChange={(e) => setForm((f) => ({ ...f, timezone: e.target.value }))}
                />
              </Field>
            </div>
            <SaveRow busy={saver.busy} saved={saver.saved} />
          </form>
        </Card>

        <div>
          <Card title="Görünüm">
            <Field label="Tema" hint="Yalnızca bu tarayıcıda geçerlidir">
              <select
                value={theme}
                onChange={(e) => {
                  const next = e.target.value as Theme;
                  setTheme(next);
                  applyTheme(next);
                }}
              >
                <option value="system">Sistem ayarını izle</option>
                <option value="light">Aydınlık</option>
                <option value="dark">Karanlık</option>
              </select>
            </Field>
          </Card>

          {/* Yetkiler salt okunur: kullanıcı kendi rolünü değiştiremez.
              Ama NE görebildiğini bilmeli, "neden bu menü yok" sorusunun
              cevabı burada. */}
          <Card title="Yetkileriniz">
            <table className="tbl">
              <tbody>
                <tr>
                  <td className="muted">Şirket</td>
                  <td className="r">{me.tenant?.name ?? 'Platform konsolu'}</td>
                </tr>
                <tr>
                  <td className="muted">Roller</td>
                  <td className="r">
                    {me.roles.length > 0
                      ? me.roles.map((r) => (
                          <span className="badge" key={r.code} style={{ marginLeft: 4 }}>{r.name}</span>
                        ))
                      : '—'}
                  </td>
                </tr>
                <tr>
                  <td className="muted">Şubeler</td>
                  <td className="r">
                    {me.branches.length > 0
                      ? me.branches.map((b) => b.name).join(', ')
                      : 'Tümü'}
                  </td>
                </tr>
                <tr>
                  <td className="muted">Açık modül</td>
                  <td className="r">{me.modules.length}</td>
                </tr>
                <tr>
                  <td className="muted">İzin sayısı</td>
                  <td className="r">{me.permissions.length}</td>
                </tr>
              </tbody>
            </table>
          </Card>
        </div>
      </div>
      <PageFoot>
        <span>E-posta kimlik sağlayıcıdan gelir ve buradan değiştirilemez.</span>
        <span>Tema tercihi yalnızca bu tarayıcıda geçerlidir, hesabınıza yazılmaz.</span>
      </PageFoot>
    </>
  );
}

// =============================================================================
// Sistem Yönetimi
// =============================================================================
export function SystemSettings() {
  const { can } = useSession();
  const users = useList<{
    id: string; email: string; full_name?: string; last_seen_at?: string;
    is_active: boolean; roles: string[]; branches: string[];
  }>('/core/users');
  const roles = useList<{ id: string; code: string; name: string; description?: string; rank: number }>(
    '/core/roles');
  const [q, setQ] = useState('');
  const audit = useList<{
    id: number; action: string; entity_schema: string; entity_table: string;
    actor_name?: string; occurred_at: string; support_session: boolean;
  }>(can('core.audit.read.all') ? '/core/audit-log' : '', { limit: 20 });

  const branches = useList<{ id: string; name: string }>('/core/branches');
  const [davet, setDavet] = useState<Record<string, unknown> | null>(null);
  const [duzenlenen, setDuzenlenen] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [hata, setHata] = useState<unknown>(null);
  const yonetebilir = can('core.user.write.all');

  const filtered = users.data.filter((u) =>
    !q || (u.full_name ?? '').toLocaleLowerCase('tr').includes(q.toLocaleLowerCase('tr'))
       || u.email.toLocaleLowerCase('tr').includes(q.toLocaleLowerCase('tr')));

  const davetGonder = async () => {
    if (!davet) return;
    setBusy('davet'); setHata(null);
    try {
      await api.post('/core/users/invite', davet);
      setDavet(null);
      await users.reload();
    } catch (err) { setHata(err); } finally { setBusy(null); }
  };

  const rolYaz = async (userId: string, roller: string[], subeler: string[] | null) => {
    setBusy(userId); setHata(null);
    try {
      await api.post(`/core/users/${userId}/roles`, {
        role_codes: roller, branch_ids: subeler,
      });
      setDuzenlenen(null);
      await users.reload();
    } catch (err) { setHata(err); } finally { setBusy(null); }
  };

  const erisimDegistir = async (userId: string, active: boolean) => {
    setBusy(userId); setHata(null);
    try {
      await api.post(`/core/users/${userId}/active`, { active });
      await users.reload();
    } catch (err) { setHata(err); } finally { setBusy(null); }
  };

  return (
    <>
      <PageHead
        kicker="Ayarlar"
        title="Sistem Yönetimi"
        subtitle="Kullanıcılar, roller ve denetim izi."
        actions={yonetebilir
          ? (
            <button className="btn btn-primary"
                    onClick={() => setDavet({ email: '', full_name: '', role_code: 'sales' })}>
              <UserPlus size={15} aria-hidden="true" /> Kullanıcı ekle
            </button>
          )
          : null}
      />
      <ErrorBox error={hata ?? users.error} />

      {davet && (
        <Card title="Kullanıcı ekle" actions={
          <div className="row">
            <button className="btn btn-sm" onClick={() => setDavet(null)}>Vazgeç</button>
            <button className="btn btn-sm btn-primary" disabled={busy === 'davet'}
                    aria-busy={busy === 'davet'} onClick={() => void davetGonder()}>
              {busy === 'davet' ? 'Ekleniyor…' : 'Ekle ve rol ata'}
            </button>
          </div>
        }>
          <div className="grid grid-2">
            <Field label="E-posta" hint="Kullanıcı bu adresle giriş yapar">
              <input type="email" autoFocus value={String(davet.email ?? '')}
                     onChange={(e) => setDavet({ ...davet, email: e.target.value })} />
            </Field>
            <Field label="Ad Soyad">
              <input value={String(davet.full_name ?? '')}
                     onChange={(e) => setDavet({ ...davet, full_name: e.target.value })} />
            </Field>
            <Field label="Rol" hint="Yetkiler rolden gelir; sonradan değiştirilebilir">
              <select value={String(davet.role_code ?? '')}
                      onChange={(e) => setDavet({ ...davet, role_code: e.target.value })}>
                {roles.data.map((r) => (
                  <option key={r.code} value={r.code}>{r.name}</option>
                ))}
              </select>
            </Field>
            <Field label="Şube kapsamı"
                   hint="Hiçbiri seçilmezse kullanıcı tüm şubeleri görür">
              <SubeSecici
                secili={(davet.branch_ids as string[] | undefined) ?? []}
                subeler={branches.data}
                degisti={(v) => setDavet({ ...davet, branch_ids: v.length > 0 ? v : undefined })}
              />
            </Field>
          </div>
        </Card>
      )}

      <Toolbar>
        <input
          type="search" value={q} onChange={(e) => setQ(e.target.value)}
          placeholder="Kullanıcı adı ya da e-posta…"
        />
      </Toolbar>

      <Card title="Kullanıcılar" padded={false}>
        <div className="tbl-wrap">
          <table className="tbl">
            <thead>
              <tr>
                <th>Kullanıcı</th><th>Roller</th><th>Şube kapsamı</th>
                <th>Son görülme</th><th>Durum</th>
                {yonetebilir && <th className="tbl-eylem">Yönet</th>}
              </tr>
            </thead>
            <tbody>
              {filtered.map((u) => (
                <tr key={u.id}>
                  <td>
                    <strong>{u.full_name ?? 'İsimsiz'}</strong>
                    <div className="muted micro">{u.email}</div>
                  </td>
                  <td>
                    {u.roles.length > 0
                      ? u.roles.map((r) => <span className="badge badge-code" key={r} style={{ marginRight: 4 }}>{r}</span>)
                      : <span className="muted">Rol atanmamış</span>}
                  </td>
                  {/* Şube listesi boşsa kısıt YOK demektir, eksik değil. */}
                  <td className="muted">
                    {u.branches.length > 0 ? u.branches.join(', ') : 'Tüm şubeler'}
                  </td>
                  <td className="muted">{u.last_seen_at ? date(u.last_seen_at) : 'Hiç'}</td>
                  <td>{u.is_active
                    ? <span className="badge badge-ok">Aktif</span>
                    : <span className="badge">Pasif</span>}</td>
                  {yonetebilir && (
                    <td className="tbl-eylem">
                      <button className="btn btn-sm" disabled={busy === u.id}
                              onClick={() => setDuzenlenen(duzenlenen === u.id ? null : u.id)}
                              aria-expanded={duzenlenen === u.id}>
                        {duzenlenen === u.id ? 'Kapat' : 'Rolü değiştir'}
                      </button>
                      {/* SİLME YOK, ERİŞİM KAPATMA VAR: ayrılan kullanıcının
                          açtığı belgeler ve denetim izi ona bağlıdır. */}
                      <button className={`btn btn-sm${u.is_active ? ' btn-danger' : ''}`}
                              disabled={busy === u.id} aria-busy={busy === u.id}
                              onClick={() => void erisimDegistir(u.id, !u.is_active)}>
                        {u.is_active ? 'Erişimi kapat' : 'Erişimi aç'}
                      </button>
                    </td>
                  )}
                </tr>
              )).flatMap((satir, i) => {
                const u = filtered[i]!;
                if (!yonetebilir || duzenlenen !== u.id) return [satir];
                return [satir, (
                  <tr key={`${u.id}-duzenle`} className="rol-satir">
                    <td colSpan={6}>
                      <RolDuzenle
                        kullanici={u}
                        roller={roles.data}
                        subeler={branches.data}
                        calisiyor={busy === u.id}
                        vazgec={() => setDuzenlenen(null)}
                        kaydet={(r, sb) => void rolYaz(u.id, r, sb)}
                      />
                    </td>
                  </tr>
                )];
              })}
            </tbody>
          </table>
          {!users.loading && filtered.length === 0 && (
            <Empty title="Bulunamadı">Aramayla eşleşen kullanıcı yok.</Empty>
          )}
        </div>
      </Card>

      <div className="settings-split">
        <Card title="Roller" padded={false}>
          <div className="tbl-wrap">
            <table className="tbl">
              <thead><tr><th>Rol</th><th>Açıklama</th></tr></thead>
              <tbody>
                {roles.data.map((r) => (
                  <tr key={r.id}>
                    <td><strong>{r.name}</strong><div className="muted micro">{r.code}</div></td>
                    <td className="muted">{r.description ?? '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            {!roles.loading && roles.data.length === 0 && <Empty />}
          </div>
        </Card>

        <Card title="Son denetim kayıtları" padded={false}>
          {!can('core.audit.read.all') ? (
            <Empty title="Yetki yok">
              Denetim izini görüntüleme yetkiniz yok.
            </Empty>
          ) : (
            <div className="tbl-wrap">
              <table className="tbl">
                <thead><tr><th>Kayıt</th><th>İşlem</th><th>Zaman</th></tr></thead>
                <tbody>
                  {audit.data.map((a) => (
                    <tr key={a.id}>
                      <td>
                        <strong>{a.entity_table}</strong>
                        <div className="muted micro">{a.entity_schema}</div>
                      </td>
                      <td>
                        <span className="badge badge-code">{a.action}</span>
                        {a.support_session && (
                          <span className="badge badge-warn" style={{ marginLeft: 4 }}>destek</span>
                        )}
                      </td>
                      <td className="muted">{date(a.occurred_at)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
              {!audit.loading && audit.data.length === 0 && (
                <Empty title="Boş">Henüz denetim kaydı yok.</Empty>
              )}
            </div>
          )}
        </Card>
      </div>
      <PageFoot>
        <span>Roller ve izinler Sezra tarafından tanımlanır; kiracıya özel rol açılmaz.</span>
        <span>Denetim izi değiştirilemez ve silinemez.</span>
      </PageFoot>
    </>
  );
}

// =============================================================================
// Marka — yalnızca platform yöneticisi
// =============================================================================

/** Kabul edilen türler; sunucu da aynı listeyi uygular. */
const LOGO_TURLERI = ['image/png', 'image/jpeg', 'image/webp', 'image/svg+xml'];
const LOGO_AZAMI_BAYT = 512 * 1024;

/**
 * Ürün logosu yönetimi.
 *
 * NEDEN AYRI BİR SAYFA VE NEDEN BURADA:
 *   Bu logo Sezra'nın kendi markasıdır, kiracının değil. Şirket ayarlarına
 *   konsaydı her kiracı yöneticisi kendi kopyasını görürdü ve "neden
 *   değiştiremiyorum" sorusu doğardı. Ayrı bir sayfada durup menüde yalnızca
 *   platform yöneticisine görünmesi, yetkiyi ekranın kendisiyle anlatır.
 *
 * GÖRÜNÜRLÜK GÜVENLİK DEĞİLDİR: menüyü ve bu sayfayı gizlemek yalnızca
 * karışıklığı önler. Yazma yetkisini `core.platform_guard()` uygular; adres
 * çubuğuna elle yazarak buraya gelen bir kiracı yöneticisi de 403 alır ve
 * bunu aşağıdaki uyarı olarak görür.
 */type LogoVaryanti = 'light' | 'dark';

/**
 * Tek bir logo varyantının yükleme ve kaldırma yuvası.
 *
 * İKİ VARYANT NEDEN AYRI YUVA:
 *   Tek bir yükleme alanı olsaydı hangi dosyanın hangi zemine gittiği ancak
 *   yükledikten sonra anlaşılırdı. Yuvalar kendi zeminlerinde önizleme
 *   gösterir; dosyanın o zeminde okunup okunmadığı seçim anında görülür.
 */
function LogoYuvasi({ varyant, baslik, aciklama, logo, mime, onDegisti }: {
  varyant: LogoVaryanti;
  baslik: string;
  aciklama: string;
  logo: string | null;
  mime: string | null;
  onDegisti: () => Promise<void>;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [saved, setSaved] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  const yukle = async (file: File) => {
    setError(null); setSaved(false);

    // İki kontrol de istemcide TEKRAR yapılır: sunucu zaten reddediyor ama
    // yarım megabaytlık bir dosyayı ağa çıkarıp reddedilmesini beklemek,
    // sebebi anında söylemekten yavaştır.
    if (!LOGO_TURLERI.includes(file.type)) {
      setError(new Error(`Desteklenmeyen dosya türü (${file.type || 'bilinmiyor'}). PNG, JPEG, WebP ya da SVG yükleyin.`));
      return;
    }
    if (file.size > LOGO_AZAMI_BAYT) {
      setError(new Error(`Dosya ${Math.round(file.size / 1024)} KB; sınır 512 KB.`));
      return;
    }

    setBusy(true);
    try {
      const dataUri = await new Promise<string>((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(String(reader.result));
        reader.onerror = () => reject(new Error('Dosya okunamadı'));
        reader.readAsDataURL(file);
      });
      await api.post('/platform/branding/logo', { data_uri: dataUri, variant: varyant });
      await onDegisti();
      setSaved(true);
      window.setTimeout(() => setSaved(false), 2500);
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
      // Aynı dosya art arda seçilebilsin: input değeri sıfırlanmazsa ikinci
      // seçim `change` olayı üretmez.
      if (inputRef.current) inputRef.current.value = '';
    }
  };

  const kaldir = async () => {
    if (!window.confirm(`${baslik} kaldırılsın mı?`)) return;
    setBusy(true); setError(null); setSaved(false);
    try {
      await api.delete(`/platform/branding/logo?variant=${varyant}`);
      await onDegisti();
    } catch (err) { setError(err); } finally { setBusy(false); }
  };

  return (
    <Card
      title={baslik}
      actions={logo
        ? <button className="btn btn-sm btn-danger" onClick={() => void kaldir()}
                  disabled={busy} aria-busy={busy}>
            {busy ? 'Kaldırılıyor…' : 'Kaldır'}
          </button>
        : null}
    >
      {/* Önizleme kendi zemininde: dosyanın o temada okunup okunmadığı
          ancak doğru zeminin üstünde görülür. */}
      <div className={`logo-plate logo-plate-${varyant === 'dark' ? 'dark' : 'light'}`}>
        {logo
          ? <img src={logo} alt={`${baslik} önizlemesi`} />
          : <span className="brand-mark">S</span>}
        <span className="micro">{logo ? mime : 'Yüklenmedi'}</span>
      </div>

      <Field
        label={logo ? 'Dosyayı değiştir' : 'Dosya seç'}
        hint={aciklama}
      >
        <input
          ref={inputRef}
          type="file"
          accept={LOGO_TURLERI.join(',')}
          disabled={busy}
          aria-busy={busy}
          aria-label={`${baslik} dosyası`}
          onChange={(e) => {
            const file = e.target.files?.[0];
            if (file) void yukle(file);
          }}
        />
      </Field>

      <ErrorBox error={error} />
      <div className="row">
        {busy && <span className="badge badge-info">Yükleniyor…</span>}
        {saved && <span className="badge badge-ok">Güncellendi</span>}
      </div>
    </Card>
  );
}

/**
 * Ürün logosu yönetimi.
 *
 * NEDEN AYRI BİR SAYFA VE NEDEN BURADA:
 *   Bu logo Sezra'nın kendi markasıdır, kiracının değil. Şirket ayarlarına
 *   konsaydı her kiracı yöneticisi kendi kopyasını görürdü ve "neden
 *   değiştiremiyorum" sorusu doğardı. Ayrı bir sayfada durup menüde yalnızca
 *   platform yöneticisine görünmesi, yetkiyi ekranın kendisiyle anlatır.
 *
 * GÖRÜNÜRLÜK GÜVENLİK DEĞİLDİR: menüyü ve bu sayfayı gizlemek yalnızca
 * karışıklığı önler. Yazma yetkisini `core.platform_guard()` uygular; adres
 * çubuğuna elle yazarak buraya gelen bir kiracı yöneticisi de 403 alır ve
 * bunu aşağıdaki uyarı olarak görür.
 */
/**
 * İletişim bilgileri düzenleyicisi.
 *
 * Üst çubuktaki "Bize ulaşın" kutusunun içeriği. Marka sayfasında duruyor
 * çünkü ikisi de aynı şeyin parçası: kiracının değil, SEZRA'nın kendini
 * nasıl gösterdiği.
 */
function IletisimAyari({ contact, onKaydedildi }: {
  contact: BrandingContact;
  onKaydedildi: () => Promise<void>;
}) {
  const [form, setForm] = useState({
    note: contact.note ?? '',
    phone1: contact.phone1 ?? '',
    phone1_label: contact.phone1_label ?? '',
    phone2: contact.phone2 ?? '',
    phone2_label: contact.phone2_label ?? '',
    whatsapp: contact.whatsapp ?? '',
  });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [saved, setSaved] = useState(false);

  /**
   * Marka verisi EŞZAMANSIZ gelir. `useState` yalnızca ilk çizimde okuduğu
   * için form boş açılıyordu ve "Kaydet" denseydi kayıtlı numaraları boşla
   * ezecekti -- bir düzenleme ekranının yapabileceği en kötü şey.
   */
  useEffect(() => {
    setForm({
      note: contact.note ?? '',
      phone1: contact.phone1 ?? '',
      phone1_label: contact.phone1_label ?? '',
      phone2: contact.phone2 ?? '',
      phone2_label: contact.phone2_label ?? '',
      whatsapp: contact.whatsapp ?? '',
    });
  }, [contact]);

  const kaydet = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true); setError(null); setSaved(false);
    try {
      await api.post('/platform/branding/contact', form);
      await onKaydedildi();
      setSaved(true);
      window.setTimeout(() => setSaved(false), 2500);
    } catch (err) { setError(err); } finally { setBusy(false); }
  };

  const alan = (k: keyof typeof form) => ({
    value: form[k],
    onChange: (e: React.ChangeEvent<HTMLInputElement>) =>
      setForm({ ...form, [k]: e.target.value }),
  });

  return (
    <Card title="Bize ulaşın">
      <form onSubmit={kaydet}>
        <Field label="Açıklama" hint="Kutunun başında görünen kısa cümle">
          <input {...alan('note')} maxLength={240}
                 placeholder="Kurulumda ya da ilk faturanda takılırsan ara…" />
        </Field>

        <div className="form-grid">
          <Field label="Birinci numara" hint="Boş bırakılırsa gösterilmez">
            <input {...alan('phone1')} inputMode="tel" placeholder="0216 000 00 00" />
          </Field>
          <Field label="Etiketi" hint="sabit, cep, destek…">
            <input {...alan('phone1_label')} maxLength={16} placeholder="sabit" />
          </Field>
          <Field label="İkinci numara">
            <input {...alan('phone2')} inputMode="tel" placeholder="0530 000 00 00" />
          </Field>
          <Field label="Etiketi">
            <input {...alan('phone2_label')} maxLength={16} placeholder="cep" />
          </Field>
        </div>

        <Field label="WhatsApp numarası"
               hint="Boş bırakılırsa WhatsApp düğmesi hiç gösterilmez">
          <input {...alan('whatsapp')} inputMode="tel" placeholder="0530 000 00 00" />
        </Field>

        <ErrorBox error={error} />
        <SaveRow busy={busy} saved={saved} />
      </form>
    </Card>
  );
}

export function Branding() {
  const { me } = useSession();
  const { branding, reload } = useBranding();
  const platformAdmin = me?.user.is_platform_admin === true;

  if (!platformAdmin) {
    return (
      <>
        <PageHead kicker="Ayarlar" title="Marka"
                  subtitle="Giriş ekranında ve yan menüde görünen ürün logosu." />
        <EmptyPage title="Bu alan Sezra yönetimine ait">
          Ürün logosu tüm kiracılarda ortaktır ve yalnızca platform yöneticisi
          değiştirebilir. Şirketinizin kendi bilgileri için Şirket ayarlarına
          bakabilirsiniz.
        </EmptyPage>
      </>
    );
  }

  const koyuDevralindi = !branding.logo_dark && branding.logo !== null;
  const acikDevralindi = !branding.logo && branding.logo_dark !== null;

  return (
    <>
      <PageHead
        kicker="Ayarlar"
        title="Marka"
        subtitle="Giriş ekranında ve yan menüde görünen ürün logosu."
      />

      <div className="settings-split">
        <LogoYuvasi
          varyant="light"
          baslik="Açık tema logosu"
          aciklama="PNG, JPEG, WebP ya da SVG · en fazla 512 KB · koyu renkli çizim"
          logo={branding.logo}
          mime={branding.mime}
          onDegisti={reload}
        />
        <LogoYuvasi
          varyant="dark"
          baslik="Koyu tema logosu"
          aciklama="Zorunlu değil · yüklenmezse koyu temada açık tema logosu kullanılır"
          logo={branding.logo_dark}
          mime={branding.mime_dark}
          onDegisti={reload}
        />
      </div>

      <IletisimAyari contact={branding.contact} onKaydedildi={reload} />

      <Card title="Kapsam">
        <table className="tbl">
          <tbody>
            <tr>
              <td className="muted">Açık tema</td>
              <td className="r">{branding.logo
                ? <span className="badge badge-ok">Yüklü</span>
                : acikDevralindi
                  ? <span className="badge badge-info">Koyu temadan devralındı</span>
                  : <span className="badge">Yok</span>}</td>
            </tr>
            <tr>
              <td className="muted">Koyu tema</td>
              <td className="r">{branding.logo_dark
                ? <span className="badge badge-ok">Yüklü</span>
                : koyuDevralindi
                  ? <span className="badge badge-info">Açık temadan devralındı</span>
                  : <span className="badge">Yok</span>}</td>
            </tr>
            <tr>
              <td className="muted">Son değişiklik</td>
              <td className="r">{branding.updated_at ? date(branding.updated_at) : '—'}</td>
            </tr>
            <tr>
              <td className="muted">Görüldüğü yerler</td>
              <td className="r">Giriş ekranı, yan menü</td>
            </tr>
            <tr>
              <td className="muted">Etkilenen kiracı</td>
              <td className="r">Tümü</td>
            </tr>
          </tbody>
        </table>
      </Card>

      <PageFoot>
        <span>Logo tüm kiracılarda ortaktır; kiracıya özel logo desteklenmez.</span>
        <span>Yan menüde logo yüklüyken ürün adı yazısı gösterilmez.</span>
        <span>Değişiklikler denetim izine yazılır; çalıştırılabilir SVG reddedilir.</span>
      </PageFoot>
    </>
  );
}

// =============================================================================
// Denetim Günlüğü
// =============================================================================

/**
 * Denetim izi.
 *
 * NEDEN KENDİ SAYFASI:
 *   Sistem Yönetimi içindeki kart yalnızca son 20 kaydı gösteriyordu ve
 *   kullanıcı/rol tablolarının altında kalıyordu. Denetim izi bir yan bilgi
 *   değil; "bunu kim değiştirdi" sorusu sorulduğunda gidilecek yer burasıdır
 *   ve süzülebilmesi gerekir.
 *
 * DESTEK OTURUMU AYRICA İŞARETLENİR: Sezra personelinin kiracı verisine
 * eriştiği kayıtlar, kiracının kendi kullanıcılarının yaptıklarıyla aynı
 * listede durur ama karışmamalıdır.
 */
export function AuditLog() {
  const { can } = useSession();
  const yetkili = can('core.audit.read.all');
  const [tablo, setTablo] = useState('');
  const [islem, setIslem] = useState('');

  const audit = useList<{
    id: string; actor_name?: string; action: string;
    entity_schema: string; entity_table: string; entity_id?: string;
    occurred_at: string; support_session: boolean;
  }>(yetkili ? '/core/audit-log' : '', { limit: 200 });

  if (!yetkili) {
    return (
      <>
        <PageHead kicker="Ayarlar" title="Denetim Günlüğü"
                  subtitle="Kim, neyi, ne zaman değiştirdi." />
        <EmptyPage title="Bu kayıtlara erişiminiz yok">
          Denetim izi, kimin hangi kaydı ne zaman değiştirdiğini tutar ve
          `core.audit.read.all` iznine bağlıdır. İhtiyacınız varsa şirket
          yöneticinizden isteyebilirsiniz.
        </EmptyPage>
      </>
    );
  }

  // Süzme İSTEMCİDE yapılıyor: uç zaten en fazla 200 kayıt döndürüyor ve
  // denetim izinde aranan şey genellikle "şu tabloda ne oldu" gibi dar bir
  // soru. Sunucuya her tuşta gitmek burada kazanç değil, gecikme olurdu.
  const rows = audit.data.filter((a) =>
    (tablo === '' || a.entity_table === tablo)
    && (islem === '' || a.action === islem));

  const tablolar = [...new Set(audit.data.map((a) => a.entity_table))].sort();
  const islemler = [...new Set(audit.data.map((a) => a.action))].sort();
  const destekli = rows.filter((a) => a.support_session).length;
  const aktorler = new Set(rows.map((a) => a.actor_name).filter(Boolean));
  const suzgecVar = tablo !== '' || islem !== '';

  return (
    <>
      <PageHead kicker="Ayarlar" title="Denetim Günlüğü"
                subtitle="Kim, neyi, ne zaman değiştirdi. Kayıtlar silinemez." />
      <ErrorBox error={audit.error} />

      {!audit.loading && audit.data.length === 0 ? (
        <EmptyPage title="Henüz kayıt yok">
          Denetim izi, izlenen tablolarda bir kayıt oluşturulduğunda,
          değiştirildiğinde ya da silindiğinde kendiliğinden yazılır. İlk
          işlemden sonra burada kim, neyi, ne zaman sorusunun yanıtı durur.
        </EmptyPage>
      ) : (
        <>
          <div className="grid grid-4">
            <Stat label="Listelenen kayıt" value={rows.length}
                  hint={audit.total > audit.data.length
                    ? `son ${audit.data.length} kayıt içinde` : 'tüm kayıtlar'} />
            <Stat label="İşlem yapan" value={aktorler.size}
                  hint={aktorler.size === 0 ? 'Aktör bilgisi yok' : 'ayrı kullanıcı'} />
            <Stat label="Destek oturumu" value={destekli}
                  hint={destekli === 0 ? 'Sezra erişimi yok' : 'Sezra personeli erişti'} />
            <Stat label="İzlenen tablo" value={tablolar.length}
                  hint={`${islemler.length} farklı işlem türü`} />
          </div>

          <Toolbar>
            <select style={{ width: 'auto' }} value={tablo}
                    aria-label="Tabloya göre süz"
                    onChange={(e) => setTablo(e.target.value)}>
              <option value="">Tüm tablolar</option>
              {tablolar.map((t) => <option key={t} value={t}>{t}</option>)}
            </select>
            <select style={{ width: 'auto' }} value={islem}
                    aria-label="İşleme göre süz"
                    onChange={(e) => setIslem(e.target.value)}>
              <option value="">Tüm işlemler</option>
              {islemler.map((i) => <option key={i} value={i}>{i}</option>)}
            </select>
          </Toolbar>

          <Card padded={false}>
            <TableScroll label="Denetim günlüğü tablosu">
              <table className="tbl">
                <thead>
                  <tr>
                    <th>Zaman</th><th>Kullanıcı</th><th>İşlem</th>
                    <th>Kayıt</th><th>Kapsam</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((a) => (
                    <tr key={a.id}>
                      <td className="muted">{date(a.occurred_at)}</td>
                      <td>{a.actor_name ?? <span className="muted">sistem</span>}</td>
                      <td><span className="badge badge-code">{a.action}</span></td>
                      <td>
                        <strong>{a.entity_table}</strong>
                        <div className="muted micro">{a.entity_schema}</div>
                      </td>
                      <td>
                        {a.support_session
                          ? <span className="badge badge-warn">destek oturumu</span>
                          : <span className="muted">kiracı</span>}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </TableScroll>
            {!audit.loading && rows.length === 0 && (
              <Empty title="Eşleşme yok">Süzgeci genişletin.</Empty>
            )}
          </Card>

          <PageFoot>
            <span><strong>{rows.length}</strong> kayıt listeleniyor
              {suzgecVar ? ` (${audit.data.length} kayıt içinde süzüldü)` : ''}</span>
            <span>Denetim izi değiştirilemez ve silinemez.</span>
            <span>Yalnızca erişebildiğiniz kiracının kayıtları listelenir.</span>
          </PageFoot>
        </>
      )}
    </>
  );
}

// =============================================================================
// Modül Erişimi
// =============================================================================

/**
 * Kiracıda hangi modüller açık.
 *
 * SALT OKUNUR OLMASI BİLİNÇLİDİR: modül açıp kapatmak aboneliği ve faturayı
 * etkiler, bu yüzden yetki `core.platform_guard()` ile Sezra'ya bağlıdır.
 * Kiracı yöneticisinin görmesi gereken şey "neyim açık" ve "kapalı olan için
 * kime başvururum"; düğme koyup 403 aldırmak ikisini de yanıtlamaz.
 */
export function ModuleAccess() {
  const { me } = useSession();
  const tenant = useItem<{ plan_code?: string; subscription_status?: string; seats?: number }>(
    '/core/tenant');
  const acikKodlar = new Set((me?.modules ?? []).map((m) => m.code));

  return (
    <>
      <PageHead kicker="Ayarlar" title="Modül Erişimi"
                subtitle="Bu kiracıda açık olan modüller ve kapsamları." />

      <div className="grid grid-4">
        <Stat label="Açık modül" value={acikKodlar.size}
              hint={me?.tenant?.name ?? 'Platform konsolu'} />
        <Stat label="Plan" value={tenant.data?.plan_code ?? '—'}
              hint={tenant.data?.plan_code
                ? 'Paket, açık modül kümesini belirler'
                : 'Abonelik bilgisi okunamadı'} />
        <Stat label="Değiştirme yetkisi" value="Sezra"
              hint="Modül açma/kapama aboneliği etkiler" />
        <Stat label="Şube" value={me?.branches.length ?? 0}
              hint="Modüller tüm şubelerde geçerlidir" />
      </div>

      <Card title="Açık modüller" padded={false}>
        <TableScroll label="Modül tablosu">
          <table className="tbl">
            <thead><tr><th>Modül</th><th>Kod</th><th>Durum</th></tr></thead>
            <tbody>
              {(me?.modules ?? []).map((m) => (
                <tr key={m.code}>
                  <td><strong>{m.name ?? m.code}</strong></td>
                  <td><span className="badge badge-code">{m.code}</span></td>
                  <td><span className="badge badge-ok">Açık</span></td>
                </tr>
              ))}
            </tbody>
          </table>
        </TableScroll>
        {acikKodlar.size === 0 && (
          <Empty title="Açık modül yok">
            Bu oturumda bir kiracıya bağlı değilsiniz; modül listesi kiracıya özeldir.
          </Empty>
        )}
      </Card>

      <PageFoot>
        <span>Kapalı bir modüle ihtiyacınız varsa Sezra ile görüşün; değişiklik aboneliğe yansır.</span>
        <span>Modülü açık olsa bile bir ekranı görmek ayrıca izin gerektirir.</span>
      </PageFoot>
    </>
  );
}

/* ===========================================================================
   Kullanıcı yetkilendirme parçaları
   ========================================================================= */

/**
 * Şube kapsamı seçici.
 *
 * HİÇBİRİ SEÇİLİ DEĞİLSE "TÜM ŞUBELER" demektir, "hiçbir şube" değil. İkisi
 * karıştırılırsa yeni eklenen bir kullanıcı hiçbir şey göremez ve sebebi
 * hiçbir ekranda yazmaz. Bu yüzden durum, kutuların altında kelimeyle de
 * söyleniyor.
 */
function SubeSecici({ secili, subeler, degisti }: {
  secili: string[];
  subeler: { id: string; name: string }[];
  degisti: (v: string[]) => void;
}) {
  if (subeler.length === 0) {
    return <span className="muted micro">Şube tanımlı değil; kullanıcı tüm veriyi görür.</span>;
  }
  return (
    <div className="sube-secici">
      {subeler.map((b) => (
        <label className="onay-satir" key={b.id}>
          <input
            type="checkbox"
            checked={secili.includes(b.id)}
            onChange={(e) => degisti(e.target.checked
              ? [...secili, b.id]
              : secili.filter((x) => x !== b.id))}
          />
          {b.name}
        </label>
      ))}
      <span className="muted micro">
        {secili.length === 0
          ? 'Seçim yok — kullanıcı tüm şubeleri görür.'
          : `${secili.length} şubeyle sınırlı.`}
      </span>
    </div>
  );
}

/**
 * Satır içi rol düzenleme.
 *
 * ROL LİSTESİ BOŞ BIRAKILAMAZ: rolsüz bir üyelik, giriş yapabilen ama hiçbir
 * şey göremeyen bir kullanıcı demektir ve bu, bir yetki durumundan çok arıza
 * gibi görünür. Erişimi kaldırmak isteyen "Erişimi kapat" der.
 *
 * SON YÖNETİCİ KORUMASI VERİTABANINDA: burada da uyarı gösteriyoruz ama
 * kuralı uygulayan taraf `core.set_member_roles`. Yalnızca arayüzde dursaydı,
 * API'yi doğrudan çağıran biri şirketi yönetilemez hâle getirebilirdi.
 */
function RolDuzenle({ kullanici, roller, subeler, calisiyor, vazgec, kaydet }: {
  kullanici: { id: string; full_name?: string; roles: string[]; branches: string[] };
  roller: { code: string; name: string; description?: string }[];
  subeler: { id: string; name: string }[];
  calisiyor: boolean;
  vazgec: () => void;
  kaydet: (roller: string[], subeler: string[] | null) => void;
}) {
  const [secilenRoller, setSecilenRoller] = useState<string[]>(kullanici.roles);
  const [secilenSubeler, setSecilenSubeler] = useState<string[]>(
    () => subeler.filter((b) => kullanici.branches.includes(b.name)).map((b) => b.id));

  const bos = secilenRoller.length === 0;

  return (
    <div className="rol-duzenle">
      <div className="rol-alan">
        <span className="rol-etiket">Roller</span>
        <div className="rol-kutular">
          {roller.map((r) => (
            <label className="onay-satir" key={r.code} title={r.description ?? undefined}>
              <input
                type="checkbox"
                checked={secilenRoller.includes(r.code)}
                onChange={(e) => setSecilenRoller(e.target.checked
                  ? [...secilenRoller, r.code]
                  : secilenRoller.filter((x) => x !== r.code))}
              />
              {r.name}
            </label>
          ))}
        </div>
      </div>

      <div className="rol-alan">
        <span className="rol-etiket">Şube kapsamı</span>
        <SubeSecici secili={secilenSubeler} subeler={subeler} degisti={setSecilenSubeler} />
      </div>

      <div className="rol-eylem">
        {bos && <span className="rol-uyari">En az bir rol seçin.</span>}
        <button className="btn btn-sm" onClick={vazgec}>Vazgeç</button>
        <button className="btn btn-sm btn-primary" disabled={bos || calisiyor}
                aria-busy={calisiyor}
                onClick={() => kaydet(secilenRoller, secilenSubeler.length > 0 ? secilenSubeler : null)}>
          {calisiyor ? 'Kaydediliyor…' : 'Kaydet'}
        </button>
      </div>
    </div>
  );
}
