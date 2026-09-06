import { useRef, useState } from 'react';
import { api } from '../api/client';
import { useItem, useList } from '../ui/useResource';
import { Card, Empty, ErrorBox, PageFoot, PageHead, Stat, TableScroll } from '../ui';
import { money, num } from '../i18n';
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
