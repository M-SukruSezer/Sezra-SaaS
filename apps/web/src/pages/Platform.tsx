import { useRef, useState, type FormEvent } from 'react';
import { api } from '../api/client';
import { useItem, useList } from '../ui/useResource';
import { Card, Empty, ErrorBox, Field, PageFoot, PageHead, Stat, TableScroll } from '../ui';
import { money, num, tamZaman } from '../i18n';
import { Activity, Building2, Package, ShieldCheck, Wallet } from 'lucide-react';
import { ResourceList, type Kolon } from '../ui/ResourceList';
import { kolonAd, kolonGecen, kolonSayi } from '../ui/kolonlar';
import { gecenSure } from '../i18n';
import { useSession } from '../api/session';

/**
 * Platform yönetim konsolu.
 *
 * Burada müşterinin İŞ VERİSİ yoktur: fırsat, fatura, bordro, stok hiçbir uçtan
 * gelmez. Kiracının içine bakmak ayrı bir eylemdir (destek modu) ve denetim
 * izine düşer. Bu ayrım bilinçlidir: "kaç kiracımız var" sorusunu yanıtlamak
 * için müşteri verisine erişim açmak gerekmesin.
 */
interface Overview {
  tenant_count: number; active_count: number; trial_count: number;
  past_due_count: number; suspended_count: number;
  user_count: number; branch_count: number;
  mrr: string; trials_expiring_7d: number; failed_deliveries: number;
}

interface TenantRow {
  id: string; slug: string; name: string; sector?: string;
  plan_code?: string; plan_name?: string; monthly_price?: string;
  status?: string; seats?: number;
  user_count: number; branch_count: number; module_count: number;
  trial_ends_at?: string; created_at: string; last_seen_at?: string;
}

interface ModuleRow {
  module_code: string; module_name: string; phase: number;
  is_core: boolean; enabled: boolean; in_plan: boolean; enabled_at?: string;
}

interface Plan { code: string; name: string; monthly_price: string; currency: string }

const STATUS_LABEL: Record<string, string> = {
  trial: 'Deneme', active: 'Etkin', past_due: 'Ödeme gecikti',
  suspended: 'Askıya alındı', cancelled: 'İptal',
};

export function PlatformOverview() {
  const ov = useItem<Overview>('/platform/overview');
  const adoption = useList<{
    module_code: string; module_name: string; phase: number;
    enabled_tenants: number; total_tenants: number; adoption_pct: string;
  }>('/platform/module-adoption');
  const health = useList<{
    tenant_id: string; tenant_name?: string; topic: string; module_code: string;
    status: string; delivery_count: number; attempts: number; last_error?: string;
  }>('/platform/health');

  const o = ov.data;

  return (
    <>
      <PageHead
        kicker="Sezra"
        title="Platform"
        subtitle="Sezra işletme konsolu. Müşteri iş verisi bu ekranlarda yer almaz."
      />
      <ErrorBox error={ov.error} />

      {/* LİDER MRR'dır, kiracı sayısı değil: bir SaaS konsolunda büyümenin
          ölçüsü kaç kiracı olduğu değil, kaçının ödediğidir. Kiracı sayısı
          hemen yanında ikinci sırada durur. */}
      {o && (
        <div className="grid grid-4">
          <Stat label="Aylık yinelenen gelir" value={money(o.mrr)}
                hint="Yalnızca ödeyen abonelikler" />
          <Stat label="Kiracı" value={o.tenant_count}
                hint={`${o.active_count} etkin · ${o.trial_count} deneme`} />
          <Stat label="Denemesi bitiyor" value={o.trials_expiring_7d}
                hint={o.trials_expiring_7d === 0 ? 'Önümüzdeki 7 günde yok' : 'Önümüzdeki 7 gün'} />
          <Stat label="Kullanıcı" value={o.user_count} hint={`${o.branch_count} şube`} />
        </div>
      )}

      {/* Kuyruk sağlığı en üstte ve sadece sorun varken görünür: modüller
          arası tek bağ olay teslimatı, sessizce düşerse fatura kesilmez. */}
      {health.data.length > 0 && (
        <Card title="İşlenemeyen olaylar" padded={false}>
          <TableScroll label="İşlenemeyen olaylar tablosu">
            <table className="tbl">
              <thead>
                <tr>
                  <th>Kiracı</th><th>Olay</th><th>Dinleyen modül</th><th>Durum</th>
                  <th className="r">Adet</th><th className="r">Deneme</th><th>Son hata</th>
                </tr>
              </thead>
              <tbody>
                {health.data.map((h, i) => (
                  <tr key={i}>
                    <td>{h.tenant_name ?? '—'}</td>
                    <td><code>{h.topic}</code></td>
                    <td>{h.module_code}</td>
                    <td>
                      <span className={`badge ${h.status === 'dead' ? 'badge-danger' : 'badge-warn'}`}>
                        {h.status === 'dead' ? 'Vazgeçildi' : 'Yeniden denenecek'}
                      </span>
                    </td>
                    <td className="r">{h.delivery_count}</td>
                    <td className="r">{h.attempts}</td>
                    <td className="muted">{h.last_error ?? '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </TableScroll>
        </Card>
      )}

      <Card title="Modül yaygınlığı" padded={false}>
        <TableScroll label="Modül yaygınlığı tablosu">
          <table className="tbl">
            <thead>
              <tr><th>Modül</th><th className="r">Faz</th><th className="r">Kiracı</th><th className="r">Yaygınlık</th></tr>
            </thead>
            <tbody>
              {adoption.data.map((m) => (
                <tr key={m.module_code}>
                  <td><strong>{m.module_name}</strong><span className="muted"> · {m.module_code}</span></td>
                  <td className="r">{m.phase}</td>
                  <td className="r">{m.enabled_tenants} / {m.total_tenants}</td>
                  <td className="r">
                    <span className={`badge ${Number(m.adoption_pct) >= 60 ? 'badge-ok'
                      : Number(m.adoption_pct) >= 25 ? 'badge-warn' : ''}`}>
                      %{num(m.adoption_pct)}
                    </span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </TableScroll>
        {!adoption.loading && adoption.data.length === 0 && (
          <Empty title="Veri yok">Kayıtlı modül bulunamadı.</Empty>
        )}
      </Card>
      <PageFoot>
        <span><strong>{adoption.data.length}</strong> modül izleniyor</span>
        <span>{health.data.length === 0
          ? 'Olay kuyruğunda işlenemeyen kayıt yok.'
          : <><strong>{health.data.length}</strong> olay teslimatı başarısız</>}</span>
        <span>Bu konsol müşteri iş verisi döndürmez; erişim denetim izine yazılır.</span>
      </PageFoot>
    </>
  );
}

/**
 * Kiracılar (platform konsolu).
 *
 * BAŞ RAKAM LİSTELENEN MRR: kiracı listesinde her satır bir gelir kalemidir
 * ve süzgeç daraldıkça bu rakam da daralır, böylece "deneme kiracılarının
 * toplam değeri ne" gibi sorular süzgeçle yanıtlanır.
 *
 * BU EKRANDA İŞ VERİSİ YOKTUR. Platform yöneticisi hiçbir kiracıya üye
 * değildir; kiracı verisine ancak destek modunu açarak ve denetim izine
 * yazılarak erişir.
 */
export function PlatformTenants() {
  const { switchTenant, setSupportMode } = useSession();
  const plans = useList<Plan>('/platform/plans');
  const [openTenant, setOpenTenant] = useState<TenantRow | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [tazele, setTazele] = useState(0);

  const act = async (id: string, path: string, body: unknown, yenile: () => Promise<void>) => {
    setBusy(id); setError(null);
    try {
      await api.post(`/platform/tenants/${id}/${path}`, body);
      await yenile();
    } catch (err) { setError(err); } finally { setBusy(null); }
  };

  /** Kiracının içine girmek: destek modu açılır ve bu erişim iz bırakır. */
  const enterTenant = (t: TenantRow) => {
    const ok = window.confirm(
      `${t.name} kiracısının verisine destek modunda erişeceksiniz.\n\n`
      + 'Bu erişim denetim izine yazılır ve kiracı tarafından görülebilir. Devam edilsin mi?',
    );
    if (!ok) return;
    switchTenant(t.id);
    setSupportMode(true);
  };

  // Satır içi eylemler listeyi yenilemek zorunda; `ResourceList` yenileyiciyi
  // satır eylemine veriyor ama kolon gövdesine vermiyor. Referans, ikisinin
  // arasında köprü kurar.
  const yenileRef = useRef<() => Promise<void>>(async () => { setTazele((v) => v + 1); });

  const kolonlar: Kolon<TenantRow>[] = [
    {
      anahtar: 'name', baslik: 'Şirket', sirala: true, suz: 'metin',
      govde: (t) => (
        <>
          <strong>{t.name}</strong>
          <div className="muted micro num">{t.slug}</div>
        </>
      ),
      disa: (t) => t.name,
    },
    kolonAd<TenantRow>('sector', 'Sektör'),
    {
      anahtar: 'plan_code', baslik: 'Plan', gruplanir: true,
      // PLAN SATIR İÇİNDE DEĞİŞTİRİLİR: plan değişikliği bu ekranın en sık
      // yapılan işi ve ayrı bir sayfaya gitmeyi gerektirmiyor.
      govde: (t) => (
        <select className="satir-secim" value={t.plan_code ?? ''} disabled={busy === t.id}
                onChange={(e) => void act(t.id, 'plan', { plan_code: e.target.value }, yenileRef.current)}
                aria-label={`${t.name} planı`}>
          {plans.data.map((pl) => (
            <option key={pl.code} value={pl.code}>
              {pl.name} · {money(pl.monthly_price, pl.currency)}
            </option>
          ))}
        </select>
      ),
      disa: (t) => t.plan_name ?? t.plan_code ?? '',
    },
    {
      anahtar: 'status', baslik: 'Durum', suz: 'secim', gruplanir: true,
      secenekler: Object.entries(STATUS_LABEL).map(([deger, etiket]) => ({ deger, etiket })),
      govde: (t) => (
        <select className="satir-secim" value={t.status ?? ''} disabled={busy === t.id}
                onChange={(e) => void act(t.id, 'status', { status: e.target.value }, yenileRef.current)}
                aria-label={`${t.name} abonelik durumu`}>
          {Object.entries(STATUS_LABEL).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
        </select>
      ),
      disa: (t) => STATUS_LABEL[t.status ?? ''] ?? t.status ?? '',
    },
    {
      anahtar: 'user_count', baslik: 'Kullanıcı', hizala: 'sag',
      govde: (t) => <>{t.user_count}{t.seats ? <span className="muted"> / {t.seats}</span> : null}</>,
      disa: (t) => t.user_count,
    },
    kolonSayi<TenantRow>('branch_count', 'Şube'),
    {
      anahtar: 'module_count', baslik: 'Modül', hizala: 'sag',
      govde: (t) => (
        <button className="btn btn-sm" onClick={() => setOpenTenant(t)}
                aria-label={`${t.name} modüllerini aç`}>
          {t.module_count}
        </button>
      ),
      disa: (t) => t.module_count,
    },
    {
      anahtar: 'last_seen_at', baslik: 'Son etkinlik', hizala: 'sag',
      govde: (t) => <span className="muted">{t.last_seen_at ? gecenSure(t.last_seen_at) : 'Hiç'}</span>,
      disa: (t) => t.last_seen_at ?? '',
    },
    kolonGecen<TenantRow>('created_at', 'Kayıt', false),
  ];

  return (
    <>
      <ErrorBox error={error} />
      <ResourceList<TenantRow>
        key={tazele}
        kicker="Platform · Kiracılar"
        baslik="Kiracılar"
        altBaslik="Abonelik durumu, plan ve kullanım. İş verisi burada görünmez."
        yol="/platform/tenants"
        aramaYer="Şirket adı ya da slug…"
        kolonlar={kolonlar}
        yetenekler={[
          { simge: Building2, etiket: 'İzolasyon', deger: 'Satır düzeyi güvenlik' },
          { simge: Package, etiket: 'Modül', deger: 'Plan ve ek modüller' },
          { simge: Wallet, etiket: 'Abonelik', deger: 'Plan · durum · koltuk' },
          { simge: ShieldCheck, etiket: 'Destek modu', deger: 'Denetim izine yazılır' },
          { simge: Activity, etiket: 'Kullanım', deger: 'Son etkinlik izlenir' },
        ]}
        sayimlar={(t, rows) => [
          { deger: t, etiket: 'kiracı' },
          { deger: rows.filter((r) => r.status === 'trial').length, etiket: 'deneme' },
        ]}
        satirEylem={(t, yenile) => {
          yenileRef.current = yenile;
          return (
            <button className="btn btn-sm" onClick={() => enterTenant(t)}>
              Destek modunda aç
            </button>
          );
        }}
        gostergeler={(rows) => {
          if (rows.length === 0) return null;
          const mrr = rows.reduce(
            (t, r) => t + (r.status === 'trial' ? 0 : Number(r.monthly_price || 0)), 0);
          const deneme = rows.filter((r) => r.status === 'trial');
          const askida = rows.filter((r) => r.status === 'suspended' || r.status === 'past_due');
          const kullanici = rows.reduce((t, r) => t + Number(r.user_count || 0), 0);
          return (
            <div className="grid grid-4">
              <Stat label="Listelenen MRR" value={money(mrr)} hint="Deneme abonelikleri sayılmaz" />
              <Stat label="Deneme" value={deneme.length}
                    hint={deneme.length === 0 ? 'Deneme kiracısı yok' : 'Henüz ödeme başlamadı'} />
              <Stat label="Askıda / gecikmiş" value={askida.length}
                    hint={askida.length === 0 ? 'Sorunlu abonelik yok' : 'Tahsilat sorunu'} />
              <Stat label="Kullanıcı" value={kullanici} hint={`${rows.length} kiracıda`} />
            </div>
          );
        }}
        bosBaslik="Kiracı yok"
        bosMetin="Henüz sağlanmış kiracı bulunmuyor. Yeni bir kiracı sağlandığında planı, modülleri ve kullanımıyla burada listelenir."
        dipnot={<span>Kiracıya girmek destek modu açar ve denetim izine yazılır.</span>}
      />

      {openTenant && (
        <TenantModules tenant={openTenant} onClose={() => setOpenTenant(null)}
                       onChanged={yenileRef.current} />
      )}
    </>
  );
}

function TenantModules({ tenant, onClose, onChanged }: {
  tenant: TenantRow; onClose: () => void; onChanged: () => Promise<void>;
}) {
  const mods = useList<ModuleRow>(`/platform/tenants/${tenant.id}/modules`);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<unknown>(null);

  const toggle = async (m: ModuleRow) => {
    setBusy(m.module_code); setError(null);
    try {
      await api.post(`/platform/tenants/${tenant.id}/modules`, {
        module_code: m.module_code, enabled: !m.enabled,
      });
      await mods.reload();
      await onChanged();
    } catch (err) { setError(err); } finally { setBusy(null); }
  };

  return (
    <Card
      title={`${tenant.name} · modüller`}
      actions={<button className="btn btn-sm" onClick={onClose}>Kapat</button>}
      padded={false}
    >
      <div className="card-body"><ErrorBox error={error} /></div>
      <div className="tbl-wrap">
        <table className="tbl">
          <thead>
            <tr><th>Modül</th><th className="r">Faz</th><th>Plan kapsamı</th><th>Durum</th><th /></tr>
          </thead>
          <tbody>
            {mods.data.map((m) => (
              <tr key={m.module_code}>
                <td>
                  <strong>{m.module_name}</strong>
                  <span className="muted"> · {m.module_code}</span>
                </td>
                <td className="r">{m.phase}</td>
                <td>
                  {/* Plan kapsamında olup kapalı olan modül satış fırsatıdır;
                      kapsam dışı olup açık olan faturalanmayan kullanımdır. */}
                  {m.in_plan
                    ? <span className="badge badge-info">Plana dahil</span>
                    : <span className="badge">Plan dışı</span>}
                </td>
                <td>
                  {m.enabled
                    ? <span className="badge badge-ok">Açık</span>
                    : <span className="badge">Kapalı</span>}
                </td>
                <td className="r">
                  {m.is_core ? (
                    <span className="muted">Çekirdek, kapatılamaz</span>
                  ) : (
                    <button className="btn btn-sm" disabled={busy === m.module_code}
                            onClick={() => toggle(m)}>
                      {m.enabled ? 'Kapat' : 'Aç'}
                    </button>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        {!mods.loading && mods.data.length === 0 && <Empty />}
      </div>
    </Card>
  );
}

// ===========================================================================
// Platform yöneticileri (T-021)
// ===========================================================================

interface AdminRow {
  id: string; email: string; full_name?: string;
  disabled_at?: string; last_seen_at?: string; is_self: boolean;
}
interface AdminEvent {
  occurred_at: string; actor_name?: string; actor_email?: string;
  target_email?: string; granted: boolean;
}

/**
 * Platform yöneticisi yönetimi.
 *
 * Bu ekran bir YETKİ YÜKSELTME yüzeyidir ve platformun en tehlikeli yeridir.
 * Sınırlar sunucuda: yalnızca bir platform yöneticisi bayrağı verebilir/alabilir
 * (SQL'de `platform_guard`), kimse kendi yöneticiliğini kaldıramaz ve sistem
 * her zaman en az bir etkin yönetici tutar (migration 1140). Buradaki
 * devre dışı bırakmalar yalnızca kolaylık; asıl kural veritabanında.
 */
export function PlatformAdmins() {
  const admins = useList<AdminRow>('/platform/admins');
  const events = useList<AdminEvent>('/platform/admin-events', { limit: 20 });
  const [email, setEmail] = useState('');
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<unknown>(null);

  const yenile = async () => { await admins.reload(); await events.reload(); };

  const yukselt = async (e: FormEvent) => {
    e.preventDefault();
    if (!email.trim()) return;
    setBusy('grant'); setError(null);
    try {
      await api.post('/platform/admins', { email: email.trim() });
      setEmail('');
      await yenile();
    } catch (err) { setError(err); } finally { setBusy(null); }
  };

  const indir = async (a: AdminRow) => {
    if (!window.confirm(
      `${a.email} kullanıcısının platform yöneticiliğini kaldırmak üzeresiniz.\n\n`
      + 'Bu erişim tüm kiracıları ve platform konsolunu kapsar. Devam edilsin mi?',
    )) return;
    setBusy(a.id); setError(null);
    try {
      await api.delete(`/platform/admins/${a.id}`);
      await yenile();
    } catch (err) { setError(err); } finally { setBusy(null); }
  };

  const etkinSayi = admins.data.filter((a) => !a.disabled_at).length;

  return (
    <>
      <PageHead
        kicker="Sezra · Platform"
        title="Platform yöneticileri"
        subtitle="Platformun en yetkili rolü: tüm kiracılara ve konsola erişir. Her değişiklik denetim izine yazılır."
      />
      <ErrorBox error={error} />

      <div className="grid grid-4">
        <Stat label="Etkin yönetici" value={etkinSayi}
              hint={etkinSayi === 1 ? 'Son yönetici indirilemez' : 'Sistemde daima en az bir tane'} />
        <Stat label="Tümü" value={admins.data.length}
              hint={`${admins.data.length - etkinSayi} devre dışı`} />
      </div>

      <Card title="Yönetici ekle">
        <form onSubmit={yukselt}>
          <Field label="E-posta"
                 hint="Kullanıcı önceden kayıtlı ve etkin olmalı. Bulunamazsa hiçbir şey değişmez.">
            <input type="email" value={email} autoComplete="off" inputMode="email"
                   placeholder="ad@ornek.com"
                   onChange={(e) => setEmail(e.target.value)} required />
          </Field>
          <button className="btn btn-primary" type="submit" disabled={busy === 'grant'}>
            {busy === 'grant' ? 'Ekleniyor…' : 'Platform yöneticisi yap'}
          </button>
        </form>
      </Card>

      <Card title="Yöneticiler" padded={false}>
        <TableScroll label="Platform yöneticileri tablosu">
          <table className="tbl">
            <thead>
              <tr><th>Kişi</th><th>Durum</th><th className="r">Son etkinlik</th><th /></tr>
            </thead>
            <tbody>
              {admins.data.map((a) => {
                const sonEtkin = etkinSayi === 1 && !a.disabled_at;
                return (
                  <tr key={a.id}>
                    <td>
                      <strong>{a.full_name ?? a.email}</strong>
                      <div className="muted micro num">{a.email}</div>
                    </td>
                    <td>
                      {a.disabled_at
                        ? <span className="badge badge-danger">Devre dışı</span>
                        : <span className="badge badge-ok">Etkin</span>}
                      {a.is_self && <span className="badge badge-info" style={{ marginInlineStart: 6 }}>Siz</span>}
                    </td>
                    <td className="r">
                      <span className="muted">{a.last_seen_at ? gecenSure(a.last_seen_at) : 'Hiç'}</span>
                    </td>
                    <td className="r">
                      {a.is_self ? (
                        <span className="muted">Kendinizi indiremezsiniz</span>
                      ) : sonEtkin ? (
                        <span className="muted">Son etkin yönetici</span>
                      ) : (
                        <button className="btn btn-sm" disabled={busy === a.id}
                                onClick={() => indir(a)}>
                          {busy === a.id ? 'Kaldırılıyor…' : 'Yöneticiliği kaldır'}
                        </button>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </TableScroll>
        {!admins.loading && admins.data.length === 0 && (
          <Empty title="Yönetici yok">Bu durum olmamalı; en az bir platform yöneticisi gerekir.</Empty>
        )}
      </Card>

      <Card title="Son değişiklikler" padded={false}>
        <TableScroll label="Yönetici değişiklikleri tablosu">
          <table className="tbl">
            <thead>
              <tr><th>Zaman</th><th>Eylem</th><th>Kime</th><th>Kim</th></tr>
            </thead>
            <tbody>
              {events.data.map((ev, i) => (
                <tr key={i}>
                  <td className="muted micro num">{tamZaman(ev.occurred_at)}</td>
                  <td>
                    {ev.granted
                      ? <span className="badge badge-ok">Yükseltildi</span>
                      : <span className="badge badge-warn">İndirildi</span>}
                  </td>
                  <td>{ev.target_email ?? '—'}</td>
                  <td className="muted">{ev.actor_name ?? ev.actor_email ?? '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </TableScroll>
        {!events.loading && events.data.length === 0 && (
          <Empty title="Kayıt yok">Henüz platform yöneticisi değişikliği yapılmadı.</Empty>
        )}
      </Card>

      <PageFoot>
        <span><strong>{etkinSayi}</strong> etkin platform yöneticisi</span>
        <span>Yükseltme ve indirme işlemleri denetim izine (core.audit_log) yazılır.</span>
      </PageFoot>
    </>
  );
}

// ===========================================================================
// Destek erişim izinleri (T-022)
// ===========================================================================

interface GrantRow {
  id: string;
  admin_user_id: string; admin_name?: string; admin_email?: string;
  tenant_id: string; tenant_name?: string;
  reason: string;
  granted_by_name?: string; granted_at: string;
  expires_at: string; revoked_at?: string; is_live: boolean;
}

/**
 * Destek erişim izinleri.
 *
 * Bir platform yöneticisine bir kiracının verisini destek modunda görme izni
 * SÜRELİ ve iptal edilebilir olarak verilir (T-009). Operatör o an hangi
 * erişimlerin açık olduğunu buradan görür; süresi dolmuş bir izin, etkin bir
 * izinden görünür biçimde ayrılır.
 */
export function PlatformSupportGrants() {
  const [gecmis, setGecmis] = useState(false);
  const grants = useList<GrantRow>('/platform/support-grants',
    gecmis ? { include_expired: 'true' } : {});
  const admins = useList<AdminRow>('/platform/admins');
  const tenants = useList<{ id: string; name: string; slug: string }>(
    '/platform/tenants', { limit: 200 });

  const [form, setForm] = useState({ admin_user_id: '', tenant_id: '', reason: '', duration_minutes: '60' });
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<unknown>(null);

  const ver = async (e: FormEvent) => {
    e.preventDefault();
    setBusy('grant'); setError(null);
    try {
      await api.post('/platform/support-grants', {
        admin_user_id: form.admin_user_id,
        tenant_id: form.tenant_id,
        reason: form.reason.trim(),
        duration_minutes: Number(form.duration_minutes) || 60,
      });
      setForm((f) => ({ ...f, reason: '' }));
      await grants.reload();
    } catch (err) { setError(err); } finally { setBusy(null); }
  };

  const iptal = async (g: GrantRow) => {
    if (!window.confirm(
      `${g.admin_name ?? g.admin_email} kullanıcısının ${g.tenant_name} erişimini şimdi kapat?`,
    )) return;
    setBusy(g.id); setError(null);
    try {
      await api.delete(`/platform/support-grants/${g.id}`);
      await grants.reload();
    } catch (err) { setError(err); } finally { setBusy(null); }
  };

  const etkinIzinler = grants.data.filter((g) => g.is_live).length;

  const durum = (g: GrantRow) => {
    if (g.is_live) return <span className="badge badge-ok">Etkin</span>;
    if (g.revoked_at) return <span className="badge badge-danger">İptal edildi</span>;
    return <span className="badge badge-warn">Süresi doldu</span>;
  };

  return (
    <>
      <PageHead
        kicker="Sezra · Platform"
        title="Destek erişim izinleri"
        subtitle="Bir yöneticiye bir kiracı için süreli destek erişimi verir. Süresi dolan izin etkisizdir."
        actions={
          <label className="muted" style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
            <input type="checkbox" checked={gecmis}
                   onChange={(e) => setGecmis(e.target.checked)} />
            Geçmişi de göster
          </label>
        }
      />
      <ErrorBox error={error} />

      <div className="grid grid-4">
        <Stat label="Etkin izin" value={etkinIzinler}
              hint={etkinIzinler === 0 ? 'Şu an açık erişim yok' : 'Şu an açık'} />
        <Stat label="Listelenen" value={grants.data.length}
              hint={gecmis ? 'Geçmiş dâhil' : 'Yalnızca etkin'} />
      </div>

      <Card title="Erişim ver">
        <form onSubmit={ver}>
          <div className="grid grid-2">
            <Field label="Yönetici">
              <select value={form.admin_user_id} required
                      onChange={(e) => setForm((f) => ({ ...f, admin_user_id: e.target.value }))}>
                <option value="">Seçin…</option>
                {admins.data.filter((a) => !a.disabled_at).map((a) => (
                  <option key={a.id} value={a.id}>{a.full_name ?? a.email} · {a.email}</option>
                ))}
              </select>
            </Field>
            <Field label="Kiracı">
              <select value={form.tenant_id} required
                      onChange={(e) => setForm((f) => ({ ...f, tenant_id: e.target.value }))}>
                <option value="">Seçin…</option>
                {tenants.data.map((t) => (
                  <option key={t.id} value={t.id}>{t.name}</option>
                ))}
              </select>
            </Field>
          </div>
          <Field label="Gerekçe" hint="Destek talebi no'su ya da olay kaydı. Denetim izine yazılır.">
            <input value={form.reason} required minLength={3}
                   placeholder="DESTEK-1234 fatura incelemesi"
                   onChange={(e) => setForm((f) => ({ ...f, reason: e.target.value }))} />
          </Field>
          <Field label="Süre (dakika)" hint="Varsayılan 60. En çok 30 gün (43200).">
            <input type="number" min={1} max={43200} value={form.duration_minutes}
                   onChange={(e) => setForm((f) => ({ ...f, duration_minutes: e.target.value }))} />
          </Field>
          <button className="btn btn-primary" type="submit"
                  disabled={busy === 'grant' || !form.admin_user_id || !form.tenant_id}>
            {busy === 'grant' ? 'Veriliyor…' : 'Erişim ver'}
          </button>
        </form>
      </Card>

      <Card title="İzinler" padded={false}>
        <TableScroll label="Destek erişim izinleri tablosu">
          <table className="tbl">
            <thead>
              <tr>
                <th>Kiracı</th><th>Yönetici</th><th>Gerekçe</th>
                <th>Durum</th><th className="r">Bitiş</th><th>Veren</th><th />
              </tr>
            </thead>
            <tbody>
              {grants.data.map((g) => (
                <tr key={g.id}>
                  <td><strong>{g.tenant_name ?? '—'}</strong></td>
                  <td>
                    {g.admin_name ?? g.admin_email}
                    <div className="muted micro num">{g.admin_email}</div>
                  </td>
                  <td className="muted">{g.reason}</td>
                  <td>{durum(g)}</td>
                  <td className={`r ${g.is_live ? '' : 'muted'}`}>{tamZaman(g.expires_at)}</td>
                  <td className="muted">{g.granted_by_name ?? '—'}</td>
                  <td className="r">
                    {g.is_live ? (
                      <button className="btn btn-sm" disabled={busy === g.id}
                              onClick={() => iptal(g)}>
                        {busy === g.id ? 'Kapatılıyor…' : 'İptal et'}
                      </button>
                    ) : (
                      <span className="muted">{g.revoked_at ? 'İptal edildi' : 'Süresi doldu'}</span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </TableScroll>
        {!grants.loading && grants.data.length === 0 && (
          <Empty title={gecmis ? 'İzin yok' : 'Etkin izin yok'}>
            {gecmis
              ? 'Hiç destek erişim izni verilmemiş.'
              : 'Şu an açık bir destek erişimi yok. Bir yöneticiye erişim vermek için yukarıdaki formu kullanın.'}
          </Empty>
        )}
      </Card>

      <PageFoot>
        <span><strong>{etkinIzinler}</strong> etkin destek erişimi</span>
        <span>Her izin ve iptal denetim izine yazılır; destek modu erişimi kiracı tarafından görülebilir.</span>
      </PageFoot>
    </>
  );
}
