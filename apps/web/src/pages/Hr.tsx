import { useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { api } from '../api/client';
import { useItem, useList } from '../ui/useResource';
import { Card, Empty, ErrorBox, PageFoot, PageHead, Stat, StatusBadge } from '../ui';
import {
  BookOpen, CalendarClock, IdCard, Landmark, Lock, Percent, Plane, ShieldCheck,
} from 'lucide-react';
import { ResourceList, type Kolon } from '../ui/ResourceList';
import { kolonAd, kolonBelgeNo, kolonPara, kolonSayi, kolonTarih } from '../ui/kolonlar';
import { money, date, num, sayi } from '../i18n';
import { useSession } from '../api/session';

interface Employee {
  id: string; employee_no: string; full_name: string; email?: string; phone?: string;
  hire_date: string; termination_date?: string; is_active: boolean;
  department_name?: string; position_name?: string; manager_name?: string;
  branch_name?: string; tenure_years?: string;
}

interface LeaveRequest {
  id: string; employee_name: string; leave_type_name: string; leave_type_code: string;
  date_from: string; date_to: string; days: string; reason?: string; status: string;
  approver_name?: string; branch_name?: string; is_paid: boolean;
}

interface PayrollRun {
  id: string; number?: string; period: string; period_year: number; period_month: number;
  status: string; employee_count: number; branch_name?: string;
  total_gross: string; total_net: string; total_employer_cost: string;
  parameter_set_code?: string; parameters_verified?: boolean;
}

interface Payslip {
  id: string; employee_no: string; employee_name: string; department_name?: string;
  sgk_days: string; gross: string; sgk_employee: string; unemployment_employee: string;
  income_tax: string; income_tax_exemption: string; stamp_tax: string; net: string;
  employer_cost: string;
}

// =============================================================================
// Personel
// =============================================================================
/**
 * Personel listesi.
 *
 * BAŞ RAKAM KADRO SAYISIDIR -- İK ekranına bakan kişinin ilk sorusu "kaç
 * kişiyiz". Yanındaki üç gösterge kadroyu okunur kılar: ortalama kıdem
 * (devir hızının dolaylı ölçüsü), bu yıl katılanlar ve ONAY BEKLEYEN İZİN.
 *
 * Onay bekleyen izin BU sayfada durur çünkü eylem gerektiren tek şey odur;
 * kendi ekranında beklerse kimse bakmaz. Sayı yalnızca kullanıcının RLS ile
 * görebildiği talepleri kapsar -- şube müdürü kendi şubesini görür.
 */
export function EmployeeList() {
  const bekleyenIzin = useList<{ id: string }>('/hr/leave-requests', {
    status: 'pending', limit: 100,
  });
  const buYil = new Date().getFullYear();

  const kolonlar: Kolon<Employee>[] = [
    {
      anahtar: 'employee_no', baslik: 'Sicil', sirala: true, suz: 'metin',
      govde: (e) => <span className="num badge-code">{e.employee_no}</span>,
      disa: (e) => e.employee_no,
    },
    {
      anahtar: 'full_name', baslik: 'Ad Soyad', sirala: true, suz: 'metin',
      govde: (e) => <strong>{e.full_name}</strong>, disa: (e) => e.full_name,
    },
    kolonAd<Employee>('department_name', 'Departman'),
    kolonAd<Employee>('position_name', 'Pozisyon'),
    kolonAd<Employee>('branch_name', 'Şube'),
    kolonTarih<Employee>('hire_date', 'İşe giriş'),
    kolonSayi<Employee>('tenure_years', 'Kıdem', { basamak: 1, sonek: ' yıl' }),
    kolonAd<Employee>('manager_name', 'Yönetici', { gizli: true }),
    {
      anahtar: 'email', baslik: 'E-posta', gizliBaslangic: true,
      govde: (e) => (e.email
        ? <a className="hucre-bag" href={`mailto:${e.email}`}>{e.email}</a>
        : <span className="muted">—</span>),
      disa: (e) => e.email ?? '',
    },
    {
      anahtar: 'is_active', baslik: 'Durum', suz: 'secim', gruplanir: true,
      secenekler: [{ deger: 'true', etiket: 'Çalışıyor' }, { deger: 'false', etiket: 'Ayrıldı' }],
      govde: (e) => (e.is_active
        ? <span className="badge badge-ok">Çalışıyor</span>
        : <span className="badge">Ayrıldı</span>),
      disa: (e) => (e.is_active ? 'Çalışıyor' : 'Ayrıldı'),
    },
  ];

  return (
    <ResourceList<Employee>
      kicker="İnsan Kaynakları · Personel"
      baslik="Personel"
      altBaslik="Kadro, kıdem ve şube dağılımı; bekleyen izin talepleri."
      yol="/hr/employees"
      aramaYer="Ad, sicil no, e-posta…"
      varsayilanSirala={{ kolon: 'employee_no', yon: 'asc' }}
      kolonlar={kolonlar}
      satirYolu={(e) => `/hr/employees/${e.id}`}
      yazmaIzni="hr.employee.create"
      silmeIzni="hr.employee.delete.all"
      yazilabilir={['employee_no', 'first_name', 'last_name', 'national_id', 'birth_date',
        'email', 'phone', 'address', 'iban', 'hire_date', 'sgk_no']}
      yetenekler={[
        { simge: IdCard, etiket: 'Sicil', deger: 'Departman ve pozisyon' },
        { simge: CalendarClock, etiket: 'Puantaj', deger: 'Vardiya ve devam' },
        { simge: Plane, etiket: 'İzin', deger: 'Hakediş ve bakiye' },
        { simge: Landmark, etiket: 'SGK', deger: 'Gün ve prim tabanı' },
        { simge: ShieldCheck, etiket: 'Ücret gizli', deger: 'Ayrı izne bağlı' },
      ]}
      sayimlar={(t, rows) => [
        { deger: t, etiket: 'personel' },
        { deger: rows.filter((e) => e.is_active).length, etiket: 'çalışan' },
      ]}
      gostergeler={(rows) => {
        if (rows.length === 0) return null;
        const kidemli = rows.filter((e) => e.tenure_years != null);
        const ortKidem = kidemli.length === 0 ? null
          : kidemli.reduce((t, e) => t + Number(e.tenure_years), 0) / kidemli.length;
        const yeni = rows.filter((e) => e.hire_date
          && new Date(e.hire_date).getFullYear() === buYil).length;
        const subeler = new Set(rows.map((e) => e.branch_name).filter(Boolean));
        return (
          <div className="grid grid-4">
            <Stat label="Listelenen kadro" value={rows.length}
                  hint={subeler.size > 0 ? `${subeler.size} şubede` : 'Şube ataması yok'} />
            <Stat label="Ortalama kıdem"
                  value={ortKidem === null ? '—' : `${num(ortKidem, 1)} yıl`}
                  hint={`${kidemli.length} kişide hesaplandı`} />
            <Stat label={`${buYil} katılan`} value={yeni}
                  hint={yeni === 0 ? 'Bu yıl işe giriş yok' : 'Bu yıl işe başladı'} />
            <Stat label="Onay bekleyen izin" value={bekleyenIzin.total}
                  hint={bekleyenIzin.total === 0 ? 'Bekleyen talep yok' : 'Yöneticinin onayını bekliyor'} />
          </div>
        );
      }}
      bosBaslik="Kadro henüz boş"
      bosMetin="Personel kaydı açtığınızda sicil no, departman ve pozisyonuyla burada listelenir. Sözleşme girildikten sonra bordro, izin hakedişi ve puantaj bu kayıt üzerinden işler."
      dipnot={<span>Ücret bilgisi ayrı bir izne bağlıdır ve bu listede yer almaz.</span>}
    />
  );
}

export function EmployeeDetail() {
  const { id } = useParams();
  const { can } = useSession();
  const emp = useItem<Employee & {
    national_id?: string; iban?: string; sgk_no?: string; address?: string;
    contracts: {
      id: string; valid_from: string; valid_to?: string; employment_type: string;
      wage_basis: string; wage_amount: string; wage_period: string; currency: string;
      weekly_hours: string; sgk_discount_5510: boolean; is_pensioner: boolean;
    }[];
    balances: {
      leave_type_name: string; year: number; entitled_days: string; carried_days: string;
      used_days: string; remaining_days: string; pending_days: string;
    }[];
  }>(id ? `/hr/employees/${id}/full` : null);

  const [sim, setSim] = useState<Record<string, string> | null>(null);
  const [simError, setSimError] = useState<unknown>(null);

  if (emp.loading) return <div className="empty">Yükleniyor…</div>;
  if (!emp.data) return <ErrorBox error={emp.error ?? 'Personel bulunamadı'} />;
  const e = emp.data;
  const current = e.contracts?.[0];

  const simulate = async () => {
    setSimError(null);
    try {
      const res = await api.post<{ data: Record<string, string> }>('/hr/payroll/simulate', {
        employee_id: e.id,
      });
      setSim(res.data);
    } catch (err) { setSimError(err); }
  };

  return (
    <>
      <PageHead kicker="İnsan Kaynakları"         title={e.full_name}
        subtitle={`${e.employee_no} · ${e.position_name ?? 'Pozisyon atanmamış'} · ${e.branch_name ?? '—'}`}
        actions={<Link className="btn" to="/hr/employees">Listeye dön</Link>}
      />
      <ErrorBox error={emp.error} />

      <div className="grid grid-2">
        <Card title="Kimlik ve iletişim">
          <table className="tbl">
            <tbody>
              <tr><td className="muted">İşe giriş</td><td>{date(e.hire_date)}</td></tr>
              <tr><td className="muted">Kıdem</td>
                  <td>{e.tenure_years ? `${num(e.tenure_years)} yıl` : '—'}</td></tr>
              <tr><td className="muted">Departman</td><td>{e.department_name ?? '—'}</td></tr>
              <tr><td className="muted">Yönetici</td><td>{e.manager_name ?? '—'}</td></tr>
              <tr><td className="muted">E-posta</td><td>{e.email ?? '—'}</td></tr>
              <tr><td className="muted">Telefon</td><td>{e.phone ?? '—'}</td></tr>
              <tr><td className="muted">TCKN</td><td>{e.national_id ?? '—'}</td></tr>
              <tr><td className="muted">SGK sicil</td><td>{e.sgk_no ?? '—'}</td></tr>
            </tbody>
          </table>
        </Card>

        {/* Sözleşme ayrı yetki alanıdır: yetkisiz kullanıcıda API boş dizi
            döndürür ve bu kart "görme yetkiniz yok" der — sayfa kırılmaz. */}
        <Card
          title="Yürürlükteki sözleşme"
          actions={current && can('hr.payroll.read.all') ? (
            <button className="btn btn-sm" onClick={simulate}>Bordro simülasyonu</button>
          ) : undefined}
        >
          {!current ? (
            <Empty>Ücret bilgisini görme yetkiniz yok ya da sözleşme tanımlı değil</Empty>
          ) : (
            <table className="tbl">
              <tbody>
                <tr>
                  <td className="muted">Geçerlilik</td>
                  <td>{date(current.valid_from)} – {current.valid_to ? date(current.valid_to) : 'süresiz'}</td>
                </tr>
                <tr>
                  <td className="muted">Ücret</td>
                  <td>
                    <strong>{money(current.wage_amount, current.currency)}</strong>{' '}
                    <span className="muted">
                      {current.wage_basis === 'net' ? 'net' : 'brüt'} /{' '}
                      {current.wage_period === 'month' ? 'ay' : current.wage_period}
                    </span>
                  </td>
                </tr>
                <tr>
                  <td className="muted">Çalışma</td>
                  <td>{num(current.weekly_hours)} saat/hafta · {current.employment_type}</td>
                </tr>
                <tr>
                  <td className="muted">5 puan indirimi</td>
                  <td>{current.sgk_discount_5510 ? 'Uygulanıyor' : 'Hayır'}</td>
                </tr>
                <tr><td className="muted">Emekli (SGDP)</td><td>{current.is_pensioner ? 'Evet' : 'Hayır'}</td></tr>
              </tbody>
            </table>
          )}
          <ErrorBox error={simError} />
          {sim && (
            <div className="tbl-wrap" style={{ marginTop: 12 }}>
              <table className="tbl">
                <tbody>
                  <tr><td>Brüt</td><td className="r">{money(sim.gross!)}</td></tr>
                  <tr><td>SGK işçi payı</td><td className="r">−{money(sim.sgk_employee!)}</td></tr>
                  <tr><td>İşsizlik işçi payı</td><td className="r">−{money(sim.unemployment_employee!)}</td></tr>
                  <tr><td>Gelir vergisi</td><td className="r">−{money(sim.income_tax!)}</td></tr>
                  <tr>
                    <td className="muted" style={{ paddingLeft: 20 }}>asgari ücret istisnası</td>
                    <td className="r muted">+{money(sim.income_tax_exemption!)}</td>
                  </tr>
                  <tr><td>Damga vergisi</td><td className="r">−{money(sim.stamp_tax!)}</td></tr>
                  <tr><td><strong>Net</strong></td><td className="r"><strong>{money(sim.net!)}</strong></td></tr>
                  <tr>
                    <td className="muted">İşverene maliyeti</td>
                    <td className="r muted">{money(sim.employer_cost!)}</td>
                  </tr>
                </tbody>
              </table>
            </div>
          )}
        </Card>
      </div>

      <Card title="İzin bakiyeleri" padded={false}>
        <div className="tbl-wrap">
          <table className="tbl">
            <thead>
              <tr>
                <th>İzin tipi</th><th className="r">Hak edilen</th><th className="r">Devreden</th>
                <th className="r">Kullanılan</th><th className="r">Onay bekleyen</th><th className="r">Kalan</th>
              </tr>
            </thead>
            <tbody>
              {(e.balances ?? []).map((b, i) => (
                <tr key={i}>
                  <td>{b.leave_type_name}</td>
                  <td className="r">{num(b.entitled_days)}</td>
                  <td className="r">{num(b.carried_days)}</td>
                  <td className="r">{num(b.used_days)}</td>
                  <td className="r">{Number(b.pending_days) > 0
                    ? <span className="badge badge-warn">{num(b.pending_days)}</span> : '—'}</td>
                  <td className="r"><strong>{num(b.remaining_days)}</strong></td>
                </tr>
              ))}
            </tbody>
          </table>
          {(e.balances ?? []).length === 0 && <Empty>Bakiye kaydı yok</Empty>}
        </div>
      </Card>
    </>
  );
}

// =============================================================================
// İzinler
// =============================================================================
/**
 * İzin talepleri.
 *
 * GÜN TOPLAMI ADET SAYISINDAN ANLAMLIDIR: bir kişinin on dört günlük izni
 * ile bir başkasının yarım günü aynı satırdır ama aynı yük değildir.
 *
 * Varsayılan süzgeç ONAY BEKLEYENLERDİR: bu ekranın işi kuyruğu eritmek.
 */
export function LeaveRequests() {
  const { can } = useSession();
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<unknown>(null);
  const canApprove = can('hr.leave.approve');

  const act = async (id: string, action: string, yenile: () => Promise<void>, body?: unknown) => {
    setBusy(id); setError(null);
    try {
      await api.post(`/hr/leave-requests/${id}/${action}`, body);
      await yenile();
    } catch (err) { setError(err); } finally { setBusy(null); }
  };

  const gun = (xs: LeaveRequest[]) => xs.reduce((t, r) => t + Number(r.days || 0), 0);

  const kolonlar: Kolon<LeaveRequest>[] = [
    {
      anahtar: 'employee_name', baslik: 'Personel', suz: 'metin', gruplanir: true,
      govde: (r) => <strong>{r.employee_name}</strong>, disa: (r) => r.employee_name,
    },
    {
      anahtar: 'leave_type_name', baslik: 'İzin tipi', gruplanir: true,
      govde: (r) => (
        <span className="row">
          {r.leave_type_name}
          {!r.is_paid && <span className="badge badge-warn">ücretsiz</span>}
        </span>
      ),
      disa: (r) => r.leave_type_name,
    },
    kolonTarih<LeaveRequest>('date_from', 'Başlangıç'),
    kolonTarih<LeaveRequest>('date_to', 'Bitiş'),
    kolonSayi<LeaveRequest>('days', 'Gün'),
    {
      anahtar: 'reason', baslik: 'Gerekçe', gizliBaslangic: true,
      govde: (r) => <span className="muted">{r.reason ?? '—'}</span>,
      disa: (r) => r.reason ?? '',
    },
    {
      anahtar: 'status', baslik: 'Durum', suz: 'secim', gruplanir: true,
      secenekler: [
        { deger: 'pending', etiket: 'Onay bekliyor' },
        { deger: 'approved', etiket: 'Onaylandı' },
        { deger: 'rejected', etiket: 'Reddedildi' },
        { deger: 'cancelled', etiket: 'İptal' },
      ],
      govde: (r) => <StatusBadge status={r.status} />, disa: (r) => r.status,
    },
    kolonAd<LeaveRequest>('approver_name', 'Onaylayan', { gizli: true }),
  ];

  return (
    <>
      <ErrorBox error={error} />
      <ResourceList<LeaveRequest>
        kicker="İnsan Kaynakları · İzin Talepleri"
        baslik="İzin Talepleri"
        altBaslik="Onay kuyruğu, kullanılan gün ve ücretli/ücretsiz ayrımı."
        yol="/hr/leave-requests"
        aramaYer="Personel, gerekçe…"
        varsayilanSirala={{ kolon: 'date_from', yon: 'desc' }}
        kolonlar={kolonlar}
        yazmaIzni="hr.leave.create"
        yetenekler={[
          { simge: Plane, etiket: 'Hakediş', deger: 'Yıllık bakiyeden düşer' },
          { simge: ShieldCheck, etiket: 'Onay', deger: 'Yönetici zinciri' },
          { simge: Landmark, etiket: 'SGK', deger: 'Ücretsiz izin gün düşürür' },
          { simge: CalendarClock, etiket: 'Puantaj', deger: 'Devam kaydına işlenir' },
          { simge: IdCard, etiket: 'Kapsam', deger: 'Yalnızca yetkili olduğunuz' },
        ]}
        sayimlar={(t, rows) => [
          { deger: t, etiket: 'talep' },
          { deger: `${sayi(gun(rows))} gün`, etiket: 'listelenen' },
        ]}
        satirEylem={canApprove ? (r, yenile) => (
          <>
            {r.status === 'pending' && (
              <>
                <button className="btn btn-sm btn-primary" disabled={busy === r.id}
                        aria-busy={busy === r.id}
                        onClick={() => void act(r.id, 'approve', yenile)}>Onayla</button>
                <button className="btn btn-sm" disabled={busy === r.id}
                        onClick={() => {
                          const reason = window.prompt('Ret gerekçesi:');
                          if (reason !== null) void act(r.id, 'reject', yenile, { reason });
                        }}>Reddet</button>
              </>
            )}
            {r.status === 'approved' && (
              <button className="btn btn-sm" disabled={busy === r.id}
                      onClick={() => void act(r.id, 'cancel', yenile)}>İptal et</button>
            )}
          </>
        ) : undefined}
        gostergeler={(rows) => {
          if (rows.length === 0) return null;
          const bekleyen = rows.filter((r) => r.status === 'pending');
          const onaylanan = rows.filter((r) => r.status === 'approved');
          const ucretsiz = rows.filter((r) => !r.is_paid);
          return (
            <div className="grid grid-4">
              <Stat label="Onay bekleyen gün" value={sayi(gun(bekleyen))}
                    hint={bekleyen.length === 0 ? 'Onay kuyruğu boş' : `${bekleyen.length} talep`} />
              <Stat label="Onaylanan gün" value={sayi(gun(onaylanan))} hint={`${onaylanan.length} talep`} />
              <Stat label="Ücretsiz izin" value={sayi(gun(ucretsiz))}
                    hint={ucretsiz.length === 0 ? 'Ücretsiz izin yok' : 'SGK gün sayısını düşürür'} />
              <Stat label="Talep sahibi" value={new Set(rows.map((r) => r.employee_name)).size}
                    hint={`${rows.length} talep listeleniyor`} />
            </div>
          );
        }}
        bosBaslik="İzin talebi yok"
        bosMetin="Personel izin talebi açtığında burada onay kuyruğuna düşer. Onaylanan izin, izin bakiyesinden düşer ve puantaja işlenir."
        dipnot={canApprove ? undefined
          : <span>Onaylama yetkiniz yok; talepleri yalnızca izleyebilirsiniz.</span>}
      />
    </>
  );
}

// =============================================================================
// Bordro
// =============================================================================
/**
 * Bordro dönemleri.
 *
 * BAKILAN TEK RAKAM SON KAPANAN DÖNEMDİR: cari dönem hesaplanana kadar
 * boştur ve tüm dönemlerin toplamı hiçbir şey ifade etmez.
 *
 * PARAMETRE TEYİDİ LİSTENİN ÜSTÜNDE: mevzuat parametreleri (asgari ücret,
 * vergi dilimleri) teyit edilmeden bordro onaylanamaz. Kullanıcı bunu onay
 * anında bir hatayla değil, listeye bakar bakmaz görmeli.
 */
export function PayrollRuns() {
  const { can } = useSession();
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<unknown>(null);
  const now = new Date();
  const [year, setYear] = useState(now.getFullYear());
  const [month, setMonth] = useState(now.getMonth() + 1);
  const [tazele, setTazele] = useState(0);
  const [teyitsiz, setTeyitsiz] = useState(false);

  const create = async () => {
    setBusy('new'); setError(null);
    try {
      await api.post('/hr/payroll-runs', { period_year: year, period_month: month });
      setTazele((v) => v + 1);
    } catch (err) { setError(err); } finally { setBusy(null); }
  };

  const act = async (id: string, action: string, yenile: () => Promise<void>) => {
    setBusy(id); setError(null);
    try {
      await api.post(`/hr/payroll-runs/${id}/${action}`);
      await yenile();
    } catch (err) { setError(err); } finally { setBusy(null); }
  };

  const kolonlar: Kolon<PayrollRun>[] = [
    {
      anahtar: 'period', baslik: 'Dönem', sirala: false,
      govde: (r) => <strong>{r.period}</strong>, disa: (r) => r.period,
    },
    kolonBelgeNo<PayrollRun>('No'),
    {
      anahtar: 'branch_name', baslik: 'Şube', gruplanir: true,
      govde: (r) => r.branch_name ?? 'Tüm şubeler',
      disa: (r) => r.branch_name ?? 'Tüm şubeler',
    },
    {
      anahtar: 'status', baslik: 'Durum', suz: 'secim', gruplanir: true,
      secenekler: [
        { deger: 'draft', etiket: 'Taslak' },
        { deger: 'calculated', etiket: 'Hesaplandı' },
        { deger: 'approved', etiket: 'Onaylandı' },
        { deger: 'posted', etiket: 'Muhasebeleşti' },
      ],
      govde: (r) => (
        <span className="row">
          <StatusBadge status={r.status} />
          {r.parameters_verified === false && (
            <span className="badge badge-warn" title="Mevzuat parametreleri teyit edilmedi">
              teyitsiz
            </span>
          )}
        </span>
      ),
      disa: (r) => r.status,
    },
    kolonSayi<PayrollRun>('employee_count', 'Personel'),
    kolonPara<PayrollRun>('total_gross', 'Brüt'),
    kolonPara<PayrollRun>('total_net', 'Net', { kalin: true }),
    kolonPara<PayrollRun>('total_employer_cost', 'İşveren maliyeti'),
  ];

  return (
    <>
      {/* Teyitsiz parametre uyarısı listeden ÖNCE: onay anında çıkan bir hata,
          kullanıcının o ana kadar yaptığı işi boşa çıkarır. */}
      {teyitsiz && (
        <div className="error-box uyari-serit">
          Bu dönemlerin bordro parametreleri (asgari ücret, vergi dilimleri) <strong>teyit
          edilmemiş</strong>. Hesaplama yapılabilir ancak bordro onaylanamaz. Resmî Gazete ile
          karşılaştırıp İK ayarlarından parametre setini teyitli işaretleyin.
        </div>
      )}
      <ErrorBox error={error} />

      <ResourceList<PayrollRun>
        key={tazele}
        kicker="İnsan Kaynakları · Bordro"
        baslik="Bordro"
        altBaslik="Dönemler, hesaplama durumu ve işveren maliyeti."
        yol="/hr/payroll-runs"
        varsayilanSirala={{ kolon: 'date_from', yon: 'desc' }}
        kolonlar={kolonlar}
        satirYolu={(r) => `/hr/payroll/${r.id}`}
        yazmaIzni="hr.payroll.create"
        yetenekler={[
          { simge: Landmark, etiket: 'SGK', deger: 'Prim ve gün hesabı' },
          { simge: Percent, etiket: 'Gelir vergisi', deger: 'Dilimli ve istisnalı' },
          { simge: ShieldCheck, etiket: 'Parametre', deger: 'Resmî Gazete teyidi' },
          { simge: BookOpen, etiket: 'Muhasebe', deger: 'Onayda fiş üretir' },
          { simge: Lock, etiket: 'Kilit', deger: 'Onaylanan bordro donar' },
        ]}
        sayimlar={(t, rows) => [
          { deger: t, etiket: 'dönem' },
          { deger: rows.filter((r) => r.status === 'approved').length, etiket: 'onaylı' },
        ]}
        birincilEylem={can('hr.payroll.create') ? (
          <span className="row">
            <select aria-label="Ay" className="donem-ay" value={month}
                    onChange={(e) => setMonth(Number(e.target.value))}>
              {Array.from({ length: 12 }, (_, i) => i + 1).map((m) => (
                <option key={m} value={m}>{String(m).padStart(2, '0')}</option>
              ))}
            </select>
            <input type="number" aria-label="Yıl" className="donem-yil" value={year}
                   onChange={(e) => setYear(Number(e.target.value))} />
            <button className="btn btn-primary" disabled={busy === 'new'}
                    aria-busy={busy === 'new'} onClick={() => void create()}>
              Dönem aç
            </button>
          </span>
        ) : null}
        satirEylem={(r, yenile) => (
          <>
            {(r.status === 'draft' || r.status === 'calculated') && (
              <button className="btn btn-sm" disabled={busy === r.id} aria-busy={busy === r.id}
                      onClick={() => void act(r.id, 'calculate', yenile)}>Hesapla</button>
            )}
            {r.status === 'calculated' && can('hr.payroll.approve') && (
              <button className="btn btn-sm btn-primary" disabled={busy === r.id}
                      aria-busy={busy === r.id}
                      onClick={() => void act(r.id, 'approve', yenile)}>Onayla</button>
            )}
          </>
        )}
        onVeri={(rows) => setTeyitsiz(rows.some((r) => r.parameters_verified === false))}
        gostergeler={(rows) => {
          if (rows.length === 0) return null;
          const onayli = rows.filter((r) => r.status === 'approved');
          const sonKapanan = onayli[0];
          const bekleyen = rows.filter((r) => r.status === 'draft' || r.status === 'calculated');
          return (
            <div className="grid grid-4">
              <Stat label="Son kapanan dönem net"
                    value={sonKapanan ? money(sonKapanan.total_net) : '—'}
                    hint={sonKapanan ? `${sonKapanan.period} · ${sonKapanan.employee_count} personel`
                                     : 'Henüz onaylanmış dönem yok'} />
              <Stat label="İşveren maliyeti"
                    value={sonKapanan ? money(sonKapanan.total_employer_cost) : '—'}
                    hint={sonKapanan ? 'Aynı dönem, SGK işveren payı dahil' : 'Dönem onaylanınca hesaplanır'} />
              <Stat label="İşlem bekleyen dönem" value={bekleyen.length}
                    hint={bekleyen.length === 0 ? 'Bekleyen dönem yok' : 'Hesaplama ya da onay bekliyor'} />
              <Stat label="Onaylanan dönem" value={onayli.length}
                    hint={`${rows.length} dönem listeleniyor`} />
            </div>
          );
        }}
        bosBaslik="Bordro dönemi açılmadı"
        bosMetin="Bir ay seçip “Dönem aç” deyin. Personel sözleşmelerinden brüt, net ve SGK işveren payı dahil maliyet hesaplanır; dönem onaylandığında yevmiye kaydı kendiliğinden üretilir ve bordro bir daha değişmez."
        dipnot={<span>Onaylanan bordro değiştirilemez ve yevmiye kaydını kendiliğinden üretir.</span>}
      />
    </>
  );
}

export function PayrollDetail() {
  const { id } = useParams();
  const run = useItem<PayrollRun>(id ? `/hr/payroll-runs/${id}` : null);
  const slips = useList<Payslip>('/hr/payslips', { run_id: id, limit: 200 });

  if (run.loading) return <div className="empty">Yükleniyor…</div>;
  if (!run.data) return <ErrorBox error={run.error ?? 'Bordro bulunamadı'} />;
  const r = run.data;

  return (
    <>
      <PageHead kicker="İnsan Kaynakları"         title={`Bordro ${r.period}`}
        subtitle={<>{r.number ?? 'Numara verilmedi'} · <StatusBadge status={r.status} /></>}
        actions={<Link className="btn" to="/hr/payroll">Listeye dön</Link>}
      />

      <div className="grid grid-4">
        <Stat label="Personel" value={r.employee_count} />
        <Stat label="Brüt toplam" value={money(r.total_gross)} />
        <Stat label="Net ödenecek" value={money(r.total_net)} />
        <Stat label="İşveren maliyeti" value={money(r.total_employer_cost)}
              hint="Brüt + SGK ve işsizlik işveren payları" />
      </div>

      <ErrorBox error={slips.error} />
      <Card title="Bordro pusulaları" padded={false}>
        <div className="tbl-wrap">
          <table className="tbl">
            <thead>
              <tr>
                <th>Sicil</th><th>Personel</th><th>Departman</th><th className="r">SGK gün</th>
                <th className="r">Brüt</th><th className="r">SGK işçi</th><th className="r">İşsizlik</th>
                <th className="r">Gelir v.</th><th className="r">Damga v.</th>
                <th className="r">Net</th><th className="r">Maliyet</th>
              </tr>
            </thead>
            <tbody>
              {slips.data.map((s) => (
                <tr key={s.id}>
                  <td>{s.employee_no}</td>
                  <td><strong>{s.employee_name}</strong></td>
                  <td>{s.department_name ?? '—'}</td>
                  <td className="r">{num(s.sgk_days)}</td>
                  <td className="r">{money(s.gross)}</td>
                  <td className="r">{money(s.sgk_employee)}</td>
                  <td className="r">{money(s.unemployment_employee)}</td>
                  <td className="r">
                    {money(s.income_tax)}
                    {Number(s.income_tax_exemption) > 0 && (
                      <div className="muted" style={{ fontSize: 11 }}>
                        istisna {money(s.income_tax_exemption)}
                      </div>
                    )}
                  </td>
                  <td className="r">{money(s.stamp_tax)}</td>
                  <td className="r"><strong>{money(s.net)}</strong></td>
                  <td className="r muted">{money(s.employer_cost)}</td>
                </tr>
              ))}
            </tbody>
          </table>
          {!slips.loading && slips.data.length === 0 && (
            <Empty>Pusula yok — dönemi hesaplayın</Empty>
          )}
        </div>
      </Card>
    </>
  );
}

// =============================================================================
// Raporlar
// =============================================================================
export function HrReports() {
  const headcount = useList<{
    branch_name?: string; department_name: string; active_headcount: number;
    hired_this_year: number; left_this_year: number;
  }>('/hr/reports/headcount');

  const cost = useList<{
    period: string; branch_name?: string; employee_count: number;
    total_gross: string; total_net: string; total_taxes: string;
    total_employee_premiums: string; total_employer_premiums: string; total_employer_cost: string;
  }>('/hr/reports/payroll-cost');

  // LİDER İŞVEREN MALİYETİ: kadro sayısı bir envanter rakamıdır, karar
  // rakamı değil. İK raporuna bakan kişinin sorusu "kaç kişiyiz" değil
  // "bu kadro bize ne tutuyor"dur — brüt maaş da yanıltıcıdır, SGK işveren
  // payı dahil maliyet gerçek yüktür.
  const total = headcount.data.reduce((t, r) => t + Number(r.active_headcount || 0), 0);
  const giren = headcount.data.reduce((t, r) => t + Number(r.hired_this_year || 0), 0);
  const cikan = headcount.data.reduce((t, r) => t + Number(r.left_this_year || 0), 0);
  const sonDonem = cost.data[0];
  const devirPct = total === 0 ? null : Math.round((cikan / total) * 100);

  return (
    <>
      <PageHead kicker="İnsan Kaynakları" title="İK Raporları"
                subtitle="Kadro dağılımı, devir hızı ve bordro maliyeti." />
      <ErrorBox error={headcount.error ?? cost.error} />
      <div className="grid grid-4">
        <Stat label="İşveren maliyeti"
              value={sonDonem ? money(sonDonem.total_employer_cost) : '—'}
              hint={sonDonem ? `${sonDonem.period} · ${sonDonem.employee_count} personel`
                             : 'Onaylanmış bordro dönemi yok'} />
        <Stat label="Aktif kadro" value={total}
              hint={`${headcount.data.length} departman-şube kırılımı`} />
        <Stat label="Bu yıl işe alınan" value={giren}
              hint={giren === 0 ? 'Bu yıl işe giriş yok' : 'Yeni katılan'} />
        <Stat label="Bu yıl ayrılan" value={cikan}
              hint={devirPct === null ? 'Kadro yok'
                : cikan === 0 ? 'Ayrılan yok' : `Kadronun %${devirPct}'i`} />
      </div>

      <Card title="Departman ve şube bazlı kadro" padded={false}>
        <div className="tbl-wrap">
          <table className="tbl">
            <thead>
              <tr>
                <th>Şube</th><th>Departman</th><th className="r">Aktif</th>
                <th className="r">Bu yıl giren</th><th className="r">Bu yıl çıkan</th>
              </tr>
            </thead>
            <tbody>
              {headcount.data.map((r, i) => (
                <tr key={i}>
                  <td>{r.branch_name ?? '—'}</td>
                  <td>{r.department_name}</td>
                  <td className="r"><strong>{r.active_headcount}</strong></td>
                  <td className="r">{r.hired_this_year}</td>
                  <td className="r">{r.left_this_year}</td>
                </tr>
              ))}
            </tbody>
          </table>
          {!headcount.loading && headcount.data.length === 0 && <Empty />}
        </div>
      </Card>

      {/* Şube bazlı personel maliyeti: P&L'deki şube kırılımıyla yan yana
          okunmak üzere aynı kırılımda üretiliyor (Bölüm 4.2 bağlantısı). */}
      <Card title="Şube bazlı bordro maliyeti" padded={false}>
        <div className="tbl-wrap">
          <table className="tbl">
            <thead>
              <tr>
                <th>Dönem</th><th>Şube</th><th className="r">Personel</th>
                <th className="r">Brüt</th><th className="r">Net</th>
                <th className="r">Vergiler</th><th className="r">SGK (işçi)</th>
                <th className="r">SGK (işveren)</th><th className="r">Toplam maliyet</th>
              </tr>
            </thead>
            <tbody>
              {cost.data.map((r, i) => (
                <tr key={i}>
                  <td><strong>{r.period}</strong></td>
                  <td>{r.branch_name ?? 'Tüm şubeler'}</td>
                  <td className="r">{r.employee_count}</td>
                  <td className="r">{money(r.total_gross)}</td>
                  <td className="r">{money(r.total_net)}</td>
                  <td className="r">{money(r.total_taxes)}</td>
                  <td className="r">{money(r.total_employee_premiums)}</td>
                  <td className="r">{money(r.total_employer_premiums)}</td>
                  <td className="r"><strong>{money(r.total_employer_cost)}</strong></td>
                </tr>
              ))}
            </tbody>
          </table>
          {!cost.loading && cost.data.length === 0 && (
            <Empty title="Bordro yok">Onaylanmış bordro dönemi bulunmuyor.</Empty>
          )}
        </div>
      </Card>

      <PageFoot>
        <span><strong>{total}</strong> aktif personel, <strong>{headcount.data.length}</strong> kırılımda</span>
        <span>Ücret ve maliyet rakamları ayrı bir izne bağlıdır.</span>
        <span>Maliyet yalnızca onaylanmış bordro dönemlerinden hesaplanır.</span>
      </PageFoot>
    </>
  );
}
