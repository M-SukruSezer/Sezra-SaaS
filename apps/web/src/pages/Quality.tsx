import { useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { api } from '../api/client';
import { useItem, useList } from '../ui/useResource';
import { Card, Empty, ErrorBox, PageFoot, PageHead, Stat, StatusBadge } from '../ui';
import { Boxes, ClipboardCheck, FileClock, Percent, Ruler, TriangleAlert, Undo2 } from 'lucide-react';
import { ResourceList, type Kolon } from '../ui/ResourceList';
import { kolonAd, kolonBelgeNo, kolonCari, kolonDurum, kolonGecen, kolonSayi } from '../ui/kolonlar';
import { date, num, sayi } from '../i18n';
import { useSession } from '../api/session';

interface Inspection {
  id: string; number?: string; status: string; stage: string;
  sku: string; product_name: string; partner_name?: string;
  quantity: string; sampled_quantity: string;
  plan_name?: string; inspector_name?: string; inspected_at?: string;
  branch_name?: string; check_count: number; failed_count: number; pending_count: number;
}

interface Result {
  id: string; sequence: number; code: string; name: string; kind: string; unit?: string;
  min_value?: string; max_value?: string; expected_bool?: boolean; expected_choice?: string;
  is_critical: boolean;
  numeric_value?: string; bool_value?: boolean; text_value?: string;
  passed?: boolean | null; note?: string;
}

interface Nonconformity {
  id: string; number?: string; inspection_number?: string;
  sku: string; product_name: string; partner_name?: string;
  quantity: string; severity: string; description: string;
  disposition: string; disposition_note?: string; corrective_action?: string;
  decided_by_name?: string; decided_at?: string; is_open: boolean; created_at: string;
}

const SEVERITY_TONE: Record<string, string> = {
  minor: '', major: 'badge-warn', critical: 'badge-danger',
};
const SEVERITY_LABEL: Record<string, string> = {
  minor: 'Düşük', major: 'Yüksek', critical: 'Kritik',
};
const DISPOSITION_LABEL: Record<string, string> = {
  pending: 'Beklemede', accept: 'Kabul', accept_with_deviation: 'Sapmayla kabul',
  rework: 'Yeniden işleme', reject: 'Ret', return_to_supplier: 'Tedarikçiye iade',
};

// =============================================================================
// Muayeneler
// =============================================================================
/**
 * Kalite muayeneleri.
 *
 * BAŞ RAKAM ÖLÇÜM BEKLEYEN MUAYENEDİR: kalite ekranına bakan kişinin
 * yapacağı iş odur. Geçme oranı yanında durur çünkü tek başına bekleyen
 * sayısı, sürecin sağlıklı işleyip işlemediğini söylemez.
 */
export function InspectionList() {
  const kolonlar: Kolon<Inspection>[] = [
    kolonBelgeNo<Inspection>('No'),
    {
      anahtar: 'product_name', baslik: 'Ürün', suz: 'metin',
      govde: (i) => (
        <>
          <strong>{i.product_name}</strong>
          <div className="muted micro num">{i.sku}</div>
        </>
      ),
      disa: (i) => `${i.product_name} (${i.sku})`,
    },
    kolonCari<Inspection>('partner_name', 'Tedarikçi'),
    kolonAd<Inspection>('plan_name', 'Plan'),
    {
      anahtar: 'stage', baslik: 'Aşama', suz: 'secim', gruplanir: true,
      secenekler: [
        { deger: 'incoming', etiket: 'Mal kabul' },
        { deger: 'in_process', etiket: 'Süreç içi' },
        { deger: 'final', etiket: 'Nihai' },
      ],
      govde: (i) => <span className="muted">{AŞAMA[i.stage] ?? i.stage}</span>,
      disa: (i) => AŞAMA[i.stage] ?? i.stage,
    },
    kolonSayi<Inspection>('quantity', 'Miktar'),
    kolonSayi<Inspection>('sampled_quantity', 'Örneklem'),
    kolonDurum<Inspection>([
      { deger: 'draft', etiket: 'Taslak' },
      { deger: 'passed', etiket: 'Geçti' },
      { deger: 'failed', etiket: 'Kaldı' },
    ]),
    {
      anahtar: 'check_count', baslik: 'Ölçüt', hizala: 'sag',
      // ÜÇ SAYI TEK HÜCREDE: toplam, kalan, bekleyen. Ayrı kolonlara
      // bölünseydi tablo genişler ve üçünün BİRLİKTE okunması gereken
      // ilişki dağılırdı.
      govde: (i) => (
        <span className="row olcut">
          <span>{i.check_count}</span>
          {i.failed_count > 0 && <span className="badge badge-danger">{i.failed_count} kaldı</span>}
          {i.pending_count > 0 && <span className="badge badge-warn">{i.pending_count} bekliyor</span>}
        </span>
      ),
      disa: (i) => `${i.check_count} ölçüt / ${i.failed_count} kaldı / ${i.pending_count} bekliyor`,
    },
    kolonAd<Inspection>('inspector_name', 'Denetçi'),
    kolonGecen<Inspection>('created_at', 'Açılma', false),
  ];

  return (
    <ResourceList<Inspection>
      kicker="Kalite · Muayeneler"
      baslik="Kalite Muayeneleri"
      altBaslik="Mal kabulünde açılan muayeneler ve ölçüm sonuçları."
      yol="/quality/inspections"
      aramaYer="Muayene no, ürün, tedarikçi…"
      kolonlar={kolonlar}
      satirYolu={(i) => `/quality/inspections/${i.id}`}
      yazmaIzni="quality.inspection.create"
      silmeIzni="quality.inspection.delete.all"
      yetenekler={[
        { simge: ClipboardCheck, etiket: 'Plan', deger: 'Ürün ve kategori bazlı' },
        { simge: Ruler, etiket: 'Ölçüt', deger: 'Sayısal · seçim · evet/hayır' },
        { simge: Percent, etiket: 'Örneklem', deger: 'Yüzdeye göre' },
        { simge: TriangleAlert, etiket: 'Uygunsuzluk', deger: 'Kalan muayeneden doğar' },
        { simge: Boxes, etiket: 'Stok', deger: 'Karar verilene dek bloke' },
      ]}
      sayimlar={(t, rows) => [
        { deger: t, etiket: 'muayene' },
        { deger: rows.filter((i) => i.pending_count > 0).length, etiket: 'ölçüm bekliyor' },
      ]}
      gostergeler={(rows) => {
        if (rows.length === 0) return null;
        const eksik = rows.filter((i) => i.pending_count > 0);
        const kalan = rows.filter((i) => i.status === 'failed');
        const gecen = rows.filter((i) => i.status === 'passed');
        const sonuclanan = gecen.length + kalan.length;
        const oran = sonuclanan === 0 ? null : Math.round((gecen.length / sonuclanan) * 100);
        return (
          <div className="grid grid-4">
            <Stat label="Ölçüm bekleyen" value={eksik.length}
                  hint={eksik.length === 0 ? 'Bekleyen ölçüm yok' : 'Sonuç girilmesi gerekiyor'} />
            <Stat label="Geçme oranı" value={oran === null ? '—' : `%${oran}`}
                  hint={sonuclanan === 0 ? 'Sonuçlanan muayene yok' : `${sonuclanan} sonuçlanan`} />
            <Stat label="Kalan muayene" value={kalan.length}
                  hint={kalan.length === 0 ? 'Kalan yok' : 'Uygunsuzluk kaydı doğurdu'} />
            <Stat label="Muayene edilen miktar"
                  value={sayi(rows.reduce((t, i) => t + Number(i.quantity || 0), 0))}
                  hint={`${sayi(rows.reduce((t, i) => t + Number(i.sampled_quantity || 0), 0))} örneklem`} />
          </div>
        );
      }}
      bosBaslik="Muayene kaydı yok"
      bosMetin="Muayene, mal kabulü onaylandığında kalite planı olan ürünler için kendiliğinden açılır. Ölçütler girildiğinde muayene geçer ya da kalır; kalan muayene bir uygunsuzluk kaydı doğurur."
      dipnot={<span>Örneklem, kalite planındaki yüzdeye göre hesaplanır.</span>}
    />
  );
}

const AŞAMA: Record<string, string> = {
  incoming: 'Mal kabul', in_process: 'Süreç içi', final: 'Nihai',
};

export function InspectionDetail() {
  const { id } = useParams();
  const { can } = useSession();
  const doc = useItem<Inspection & { results: Result[] }>(
    id ? `/quality/inspections/${id}/full` : null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);

  const save = async (r: Result, patch: Record<string, unknown>) => {
    setError(null);
    try {
      await api.patch(`/quality/results/${r.id}`, patch);
      await doc.reload();
    } catch (err) { setError(err); }
  };

  const complete = async () => {
    setBusy(true); setError(null);
    try {
      await api.post(`/quality/inspections/${id}/complete`);
      await doc.reload();
    } catch (err) { setError(err); } finally { setBusy(false); }
  };

  if (doc.loading) return <div className="empty">Yükleniyor…</div>;
  if (!doc.data) return <ErrorBox error={doc.error ?? 'Muayene bulunamadı'} />;
  const d = doc.data;
  const editable = d.status === 'draft';

  return (
    <>
      <PageHead
        title={`Muayene ${d.number ?? '(taslak)'}`}
        subtitle={<>
          <StatusBadge status={d.status} /> · {d.product_name} · {num(d.quantity)} adet
          {d.partner_name && <> · {d.partner_name}</>}
        </>}
        actions={
          <span className="row" style={{ gap: 8 }}>
            {editable && can('quality.inspection.complete') && (
              <button className="btn btn-primary" disabled={busy || d.pending_count > 0}
                      title={d.pending_count > 0 ? 'Önce tüm ölçütleri doldurun' : undefined}
                      onClick={complete}>
                Muayeneyi tamamla
              </button>
            )}
            <Link className="btn" to="/quality/inspections">Listeye dön</Link>
          </span>
        }
      />
      <ErrorBox error={error} />

      {/* Ölçütler tabloda doğrudan doldurulur: denetçi tablet başında satır satır
          girer, her satır için ayrı forma girip çıkmak akışı kırardı. */}
      <Card title={`Ölçütler — örneklem ${num(d.sampled_quantity)} adet`} padded={false}>
        <div className="tbl-wrap">
          <table className="tbl">
            <thead>
              <tr>
                <th>#</th><th>Ölçüt</th><th>Beklenen</th><th>Ölçüm</th><th>Sonuç</th>
              </tr>
            </thead>
            <tbody>
              {(d.results ?? []).map((r) => (
                <tr key={r.id}>
                  <td>{r.sequence}</td>
                  <td>
                    {r.name}
                    {r.is_critical && (
                      <span className="badge badge-danger" style={{ marginLeft: 6 }}>kritik</span>
                    )}
                    <div className="muted" style={{ fontSize: 11 }}>{r.code}</div>
                  </td>
                  <td className="muted">
                    {r.kind === 'numeric' && (
                      <>{r.min_value ? num(r.min_value) : '−∞'} … {r.max_value ? num(r.max_value) : '+∞'} {r.unit}</>
                    )}
                    {r.kind === 'boolean' && (r.expected_bool ? 'Evet' : 'Hayır')}
                    {r.kind === 'choice' && r.expected_choice}
                    {r.kind === 'text' && 'serbest metin'}
                  </td>
                  <td>
                    {r.kind === 'numeric' && (
                      <input
                        type="number" step="0.0001" style={{ width: 120 }}
                        defaultValue={r.numeric_value ?? ''} disabled={!editable}
                        onBlur={(e) => {
                          const v = e.target.value === '' ? null : Number(e.target.value);
                          if (String(v) !== String(r.numeric_value ?? null)) {
                            void save(r, { numeric_value: v });
                          }
                        }}
                      />
                    )}
                    {r.kind === 'boolean' && (
                      <input
                        type="checkbox" style={{ width: 'auto' }}
                        defaultChecked={r.bool_value ?? false} disabled={!editable}
                        onChange={(e) => void save(r, { bool_value: e.target.checked })}
                      />
                    )}
                    {(r.kind === 'choice' || r.kind === 'text') && (
                      <input
                        type="text" defaultValue={r.text_value ?? ''} disabled={!editable}
                        placeholder={r.kind === 'choice' ? r.expected_choice : ''}
                        onBlur={(e) => {
                          if (e.target.value !== (r.text_value ?? '')) {
                            void save(r, { text_value: e.target.value || null });
                          }
                        }}
                      />
                    )}
                  </td>
                  <td>
                    {r.passed === null || r.passed === undefined
                      ? <span className="muted">ölçülmedi</span>
                      : r.passed
                        ? <span className="badge badge-ok">geçti</span>
                        : <span className="badge badge-danger">kaldı</span>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Card>
    </>
  );
}

// =============================================================================
// Uygunsuzluklar
// =============================================================================
/**
 * Uygunsuzluklar.
 *
 * BAŞ RAKAM KARAR BEKLEYEN KAYITTIR: uygunsuzluk kapanana kadar malın ne
 * olacağı belirsizdir ve stok o sırada bloke durur. Kritik ağırlık ayrı
 * gösterge, çünkü karar sırasını o belirler.
 */
export function NonconformityList() {
  const { can } = useSession();
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<unknown>(null);
  const canDecide = can('quality.nonconformity.decide');

  const decide = async (nc: Nonconformity, disposition: string, yenile: () => Promise<void>) => {
    const note = window.prompt(
      disposition === 'accept_with_deviation'
        ? 'Sapmayla kabul GEREKÇESİ (zorunlu):'
        : 'Karar notu (opsiyonel):');
    if (note === null) return;
    setBusy(nc.id); setError(null);
    try {
      await api.post(`/quality/nonconformities/${nc.id}/decide`, { disposition, note });
      await yenile();
    } catch (err) { setError(err); } finally { setBusy(null); }
  };

  const kolonlar: Kolon<Nonconformity>[] = [
    kolonBelgeNo<Nonconformity>('No'),
    {
      anahtar: 'product_name', baslik: 'Ürün', suz: 'metin',
      govde: (n) => (
        <>
          <strong>{n.product_name}</strong>
          <div className="muted micro num">{n.sku}</div>
        </>
      ),
      disa: (n) => `${n.product_name} (${n.sku})`,
    },
    kolonCari<Nonconformity>('partner_name', 'Tedarikçi'),
    {
      anahtar: 'severity', baslik: 'Ağırlık', suz: 'secim', gruplanir: true,
      secenekler: Object.entries(SEVERITY_LABEL).map(([deger, etiket]) => ({ deger, etiket })),
      govde: (n) => (
        <span className={`badge ${SEVERITY_TONE[n.severity] ?? ''}`}>
          {SEVERITY_LABEL[n.severity] ?? n.severity}
        </span>
      ),
      disa: (n) => SEVERITY_LABEL[n.severity] ?? n.severity,
    },
    {
      anahtar: 'description', baslik: 'Açıklama', suz: 'metin',
      govde: (n) => <span className="muted">{n.description}</span>,
      disa: (n) => n.description,
    },
    kolonSayi<Nonconformity>('quantity', 'Miktar'),
    {
      anahtar: 'disposition', baslik: 'Tasarruf', suz: 'secim', gruplanir: true,
      secenekler: Object.entries(DISPOSITION_LABEL).map(([deger, etiket]) => ({ deger, etiket })),
      govde: (n) => (n.is_open
        ? <span className="badge badge-warn">Beklemede</span>
        : (
          <>
            <span className="badge badge-ok">
              {DISPOSITION_LABEL[n.disposition] ?? n.disposition}
            </span>
            {n.disposition_note && <div className="muted micro">{n.disposition_note}</div>}
          </>
        )),
      disa: (n) => (n.is_open ? 'Beklemede' : DISPOSITION_LABEL[n.disposition] ?? n.disposition),
    },
    kolonAd<Nonconformity>('decided_by_name', 'Karar veren', { gizli: true }),
    kolonGecen<Nonconformity>('created_at', 'Açılma', false),
  ];

  return (
    <>
      <ErrorBox error={error} />
      <ResourceList<Nonconformity>
        kicker="Kalite · Uygunsuzluklar"
        baslik="Uygunsuzluklar"
        altBaslik="Kalan muayenelerden doğan kayıtlar ve verilen tasarruf kararları."
        yol="/quality/nonconformities"
        aramaYer="Kayıt no, açıklama, ürün, tedarikçi…"
        kolonlar={kolonlar}
        yazmaIzni="quality.nonconformity.create"
        silmeIzni="quality.nonconformity.delete.all"
        yetenekler={[
          { simge: TriangleAlert, etiket: 'Ağırlık', deger: 'Düşük · yüksek · kritik' },
          { simge: ClipboardCheck, etiket: 'Tasarruf', deger: 'Altı karar seçeneği' },
          { simge: Boxes, etiket: 'Stok', deger: 'Karara kadar bloke' },
          { simge: Undo2, etiket: 'İade', deger: 'Tedarikçiye dönüş' },
          { simge: FileClock, etiket: 'İz', deger: 'Karar ve gerekçe saklanır' },
        ]}
        sayimlar={(t, rows) => [
          { deger: t, etiket: 'uygunsuzluk' },
          { deger: rows.filter((n) => n.is_open).length, etiket: 'karar bekliyor' },
        ]}
        satirEylem={canDecide ? (n, yenile) => (n.is_open ? (
          <select className="satir-secim" defaultValue="" disabled={busy === n.id}
                  aria-label={`${n.number ?? 'Kayıt'} için tasarruf kararı`}
                  onChange={(e) => { if (e.target.value) void decide(n, e.target.value, yenile); }}>
            <option value="">Karar ver…</option>
            <option value="accept">Kabul</option>
            <option value="accept_with_deviation">Sapmayla kabul</option>
            <option value="rework">Yeniden işleme</option>
            <option value="reject">Ret</option>
            <option value="return_to_supplier">Tedarikçiye iade</option>
          </select>
        ) : null) : undefined}
        gostergeler={(rows) => {
          if (rows.length === 0) return null;
          const acik = rows.filter((n) => n.is_open);
          const kritik = rows.filter((n) => n.severity === 'critical');
          const iade = rows.filter((n) => n.disposition === 'return_to_supplier');
          const tedarikciler = new Set(rows.map((n) => n.partner_name).filter(Boolean));
          return (
            <div className="grid grid-4">
              <Stat label="Karar bekleyen" value={acik.length}
                    hint={acik.length === 0 ? 'Bekleyen kayıt yok'
                      : `${sayi(acik.reduce((t, n) => t + Number(n.quantity || 0), 0))} birim bloke`} />
              <Stat label="Kritik" value={kritik.length}
                    hint={kritik.length === 0 ? 'Kritik uygunsuzluk yok' : 'Önce bunlara karar verin'} />
              <Stat label="Tedarikçiye iade" value={iade.length}
                    hint={iade.length === 0 ? 'İade kararı yok' : 'Tedarikçi karnesine işler'} />
              <Stat label="İlgili tedarikçi" value={tedarikciler.size}
                    hint={`${rows.length} kayıt listeleniyor`} />
            </div>
          );
        }}
        bosBaslik="Uygunsuzluk yok"
        bosMetin="Uygunsuzluk, bir muayene kaldığında kendiliğinden açılır. Karar verilene kadar (kabul, sapmayla kabul, yeniden işleme, ret, iade) ilgili miktar stokta bloke kalır."
        dipnot={canDecide ? undefined
          : <span>Karar verme yetkiniz yok; kayıtları yalnızca izleyebilirsiniz.</span>}
      />
    </>
  );
}

export function QualityReports() {
  const supplier = useList<{
    partner_id: string; partner_name: string; inspection_count: number;
    passed_count: number; failed_count: number; pass_rate_pct?: string;
    critical_nc_count: number; open_nc_count: number; last_inspected_at?: string;
  }>('/quality/reports/supplier-quality');

  const failed = useList<{
    code: string; name: string; unit?: string; is_critical: boolean;
    sku: string; product_name: string; fail_count: number;
    avg_measured?: string; spec_min?: string; spec_max?: string;
  }>('/quality/reports/failed-checks');

  // Baş rakam GEÇME ORANI: kalite raporunun tek özet cümlesi budur.
  // Açık uygunsuzluk hemen yanında durur çünkü oran iyi görünürken
  // karara bağlanmamış kayıt birikmiş olabilir.
  const muayene = supplier.data.reduce((t, r) => t + Number(r.inspection_count || 0), 0);
  const gecen   = supplier.data.reduce((t, r) => t + Number(r.passed_count || 0), 0);
  const oran = muayene === 0 ? null : Math.round((gecen / muayene) * 100);
  const acikNc = supplier.data.reduce((t, r) => t + Number(r.open_nc_count || 0), 0);
  const kritikNc = supplier.data.reduce((t, r) => t + Number(r.critical_nc_count || 0), 0);

  return (
    <>
      <PageHead kicker="Kalite" title="Kalite Raporları"
                subtitle="Tedarikçi karnesi ve en çok kalan ölçütler." />
      <ErrorBox error={supplier.error ?? failed.error} />

      <div className="grid grid-4">
        <Stat label="Geçme oranı" value={oran === null ? '—' : `%${oran}`}
              hint={muayene === 0 ? 'Muayene kaydı yok' : `${muayene} muayenede`} />
        <Stat label="Açık uygunsuzluk" value={acikNc}
              hint={acikNc === 0 ? 'Karar bekleyen yok' : 'Karara bağlanmadı'} />
        <Stat label="Kritik uygunsuzluk" value={kritikNc}
              hint={kritikNc === 0 ? 'Kritik kayıt yok' : 'Öncelikli'} />
        <Stat label="İzlenen tedarikçi" value={supplier.data.length}
              hint={`${failed.data.length} ölçüt kalıyor`} />
      </div>

      {/* Tedarikçi karnesi, satın almadaki teslimat performansının yanına
          konmak üzere aynı kırılımda: zamanında gelen ama sürekli kalan mal
          iyi tedarikçi değildir. */}
      <Card title="Tedarikçi kalite karnesi" padded={false}>
        <div className="tbl-wrap">
          <table className="tbl">
            <thead>
              <tr>
                <th>Tedarikçi</th><th className="r">Muayene</th><th className="r">Geçen</th>
                <th className="r">Kalan</th><th className="r">Geçme oranı</th>
                <th className="r">Kritik uygunsuzluk</th><th className="r">Açık kayıt</th>
                <th>Son muayene</th>
              </tr>
            </thead>
            <tbody>
              {supplier.data.map((r) => (
                <tr key={r.partner_id}>
                  <td><strong>{r.partner_name}</strong></td>
                  <td className="r">{r.inspection_count}</td>
                  <td className="r">{r.passed_count}</td>
                  <td className="r">{r.failed_count}</td>
                  <td className="r">
                    {r.pass_rate_pct === null || r.pass_rate_pct === undefined ? '—' : (
                      <span className={`badge ${Number(r.pass_rate_pct) >= 95 ? 'badge-ok'
                        : Number(r.pass_rate_pct) >= 80 ? 'badge-warn' : 'badge-danger'}`}>
                        %{num(r.pass_rate_pct)}
                      </span>
                    )}
                  </td>
                  <td className="r">
                    {r.critical_nc_count > 0
                      ? <span className="badge badge-danger">{r.critical_nc_count}</span> : '—'}
                  </td>
                  <td className="r">{r.open_nc_count || '—'}</td>
                  <td>{r.last_inspected_at ? date(r.last_inspected_at) : '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
          {!supplier.loading && supplier.data.length === 0 && <Empty>Henüz muayene yok</Empty>}
        </div>
      </Card>

      {/* Hangi ölçüt sürekli sorun çıkarıyor: spesifikasyon mu gerçekçi değil,
          tedarikçi mi tutturamıyor — cevabı ölçülen ortalama veriyor. */}
      <Card title="En çok kalan ölçütler" padded={false}>
        <div className="tbl-wrap">
          <table className="tbl">
            <thead>
              <tr>
                <th>Ölçüt</th><th>Ürün</th><th className="r">Kalma sayısı</th>
                <th className="r">Ölçülen ortalama</th><th className="r">Spesifikasyon</th>
              </tr>
            </thead>
            <tbody>
              {failed.data.map((f, i) => (
                <tr key={i}>
                  <td>
                    {f.name}
                    {f.is_critical && (
                      <span className="badge badge-danger" style={{ marginLeft: 6 }}>kritik</span>
                    )}
                  </td>
                  <td>{f.product_name}<span className="muted"> · {f.sku}</span></td>
                  <td className="r"><strong>{f.fail_count}</strong></td>
                  <td className="r">{f.avg_measured ? `${num(f.avg_measured)} ${f.unit ?? ''}` : '—'}</td>
                  <td className="r muted">
                    {f.spec_min ? num(f.spec_min) : '−∞'} … {f.spec_max ? num(f.spec_max) : '+∞'}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          {!failed.loading && failed.data.length === 0 && (
            <Empty title="Kalan ölçüt yok">Hiçbir ölçüt tekrar eden şekilde kalmıyor.</Empty>
          )}
        </div>
      </Card>

      <PageFoot>
        <span><strong>{supplier.data.length}</strong> tedarikçi, <strong>{muayene}</strong> muayene</span>
        <span>Zamanında gelen ama sürekli kalan mal, iyi tedarikçi değildir.</span>
      </PageFoot>
    </>
  );
}
