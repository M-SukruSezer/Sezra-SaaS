import { useState } from 'react';
import { useParams } from 'react-router-dom';
import { api } from '../api/client';
import { useItem, useList } from '../ui/useResource';
import {
  BookOpen, CalendarRange, Coins, Landmark, Lock, Network, TrendingUp, Undo2, UserRound,
} from 'lucide-react';
import { Card, Empty, ErrorBox, PageFoot, PageHead, StatusBadge, Stat, Toolbar } from '../ui';
import { ResourceList, type Kolon } from '../ui/ResourceList';
import { kolonAd, kolonAktif, kolonBelgeNo, kolonPara, kolonTarih } from '../ui/kolonlar';
import { money, date } from '../i18n';
import { useSession } from '../api/session';
import type { Account, AgingRow, JournalEntry, ProfitLoss, TrialBalanceRow, VatRow } from '../api/types';

/** Ayın ilk günü — rapor filtrelerinin varsayılanı. */
const monthStart = () => new Date(new Date().getFullYear(), new Date().getMonth(), 1)
  .toISOString().slice(0, 10);

/**
 * Hesap planı.
 *
 * BAŞ RAKAM KAYIT ATILABİLİR hesap sayısıdır. Plandaki toplam satır sayısı
 * yanıltıcıdır: grup hesapları yalnızca ağacı taşır, onlara fiş kesilemez.
 * Muhasebeciyi ilgilendiren, fiilen kullanılabilir uçlardır.
 *
 * "Cari zorunlu" ayrı bir gösterge: 120/320 gibi hesaplara cari bilgisi
 * olmadan kayıt atılamaz ve bu, muhasebeleştirmede en sık alınan hatadır.
 */
export function ChartOfAccounts() {
  const kolonlar: Kolon<Account>[] = [
    {
      anahtar: 'code', baslik: 'Kod', sirala: true, suz: 'metin',
      // GİRİNTİ kod uzunluğundan gelir: hesap planı bir ağaçtır ve derinlik
      // düz bir listede yalnızca girintiyle okunur.
      govde: (a) => (
        <span className="num hesap-kod" style={{ '--derinlik': a.code.length - 1 } as React.CSSProperties}>
          <strong>{a.code}</strong>
        </span>
      ),
      disa: (a) => a.code,
    },
    {
      anahtar: 'name', baslik: 'Hesap', sirala: true, suz: 'metin',
      govde: (a) => (a.is_leaf ? a.name : <strong>{a.name}</strong>),
      disa: (a) => a.name,
    },
    {
      anahtar: 'type', baslik: 'Tür', sirala: true, suz: 'secim', gruplanir: true,
      secenekler: Object.entries(ACCOUNT_TYPE).map(([deger, etiket]) => ({ deger, etiket })),
      govde: (a) => <span className="muted">{ACCOUNT_TYPE[a.type] ?? a.type}</span>,
      disa: (a) => ACCOUNT_TYPE[a.type] ?? a.type,
    },
    {
      anahtar: 'is_leaf', baslik: 'Nitelik', suz: 'secim',
      secenekler: [{ deger: 'true', etiket: 'Uç hesap' }, { deger: 'false', etiket: 'Grup' }],
      govde: (a) => (
        <span className="row">
          {!a.is_leaf && <span className="badge">Grup</span>}
          {a.requires_partner && <span className="badge badge-info">Cari zorunlu</span>}
          {a.is_pl && <span className="badge badge-warn">Gelir tablosu</span>}
          {a.is_leaf && !a.requires_partner && !a.is_pl && <span className="muted">—</span>}
        </span>
      ),
      disa: (a) => [!a.is_leaf && 'Grup', a.requires_partner && 'Cari zorunlu',
        a.is_pl && 'Gelir tablosu'].filter(Boolean).join(' / '),
    },
    kolonAktif<Account>(),
  ];

  return (
    <ResourceList<Account>
      kicker="Muhasebe · Hesap Planı"
      baslik="Hesap Planı"
      altBaslik="Tekdüzen Hesap Planı — kiracıya özel olarak genişletilebilir."
      yol="/finance/accounts"
      aramaYer="Kod ya da hesap adı…"
      varsayilanSirala={{ kolon: 'code', yon: 'asc' }}
      kolonlar={kolonlar}
      yazmaIzni="finance.account.create"
      silmeIzni="finance.account.delete.all"
      yazilabilir={['code', 'name', 'type', 'is_pl', 'is_leaf', 'currency',
        'requires_partner', 'is_active']}
      yetenekler={[
        { simge: Landmark, etiket: 'THP', deger: 'Tekdüzen Hesap Planı' },
        { simge: Network, etiket: 'Ağaç', deger: 'Kod kırılımına göre' },
        { simge: UserRound, etiket: 'Cari', deger: '120 / 320 zorunlu' },
        { simge: TrendingUp, etiket: 'Gelir tablosu', deger: 'Dönem sonu kapanır' },
        { simge: Coins, etiket: 'Para', deger: 'Hesap bazında birim' },
      ]}
      sayimlar={(t, rows) => [
        { deger: t, etiket: 'hesap' },
        { deger: rows.filter((a) => a.is_leaf).length, etiket: 'uç hesap' },
      ]}
      gostergeler={(rows) => {
        if (rows.length === 0) return null;
        return (
          <div className="grid grid-4">
            <Stat label="Kayıt atılabilir hesap" value={rows.filter((a) => a.is_leaf).length}
                  hint={`${rows.filter((a) => !a.is_leaf).length} grup hesabı ağacı taşır`} />
            <Stat label="Cari zorunlu" value={rows.filter((a) => a.requires_partner).length}
                  hint="Cari bilgisi olmadan fiş kesilemez" />
            <Stat label="Gelir tablosu hesabı" value={rows.filter((a) => a.is_pl).length}
                  hint="Dönem sonunda kapanır" />
            <Stat label="Listelenen satır" value={rows.length}
                  hint="Grup ve uç hesaplar birlikte" />
          </div>
        );
      }}
      bosBaslik="Hesap planı kurulmamış"
      bosMetin="Muhasebe modülü açıldığında Tekdüzen Hesap Planı kiracıya kendiliğinden kurulur. Bu ekran boşsa modül henüz sağlanmamıştır."
      dipnot={<span>Girinti hesap kodunun kırılım derinliğini gösterir.</span>}
    />
  );
}

const ACCOUNT_TYPE: Record<string, string> = {
  asset: 'Varlık', liability: 'Yabancı kaynak', equity: 'Özkaynak',
  income: 'Gelir', expense: 'Gider', cost: 'Maliyet', offbalance: 'Nazım',
};

/**
 * Yevmiye defteri.
 *
 * BAŞ RAKAM MUHASEBELEŞMEYİ BEKLEYEN taslak sayısıdır -- defterin toplamı
 * değil. Muhasebeciyi ilgilendiren, deftere henüz işlenmemiş ve dönem
 * kapanışını bloke edebilecek kayıtlardır; muhasebeleşmiş fiş zaten
 * değiştirilemez.
 *
 * BORÇ VE ALACAK YAN YANA durur: eşit olmadıkları an dengesizlik gözle
 * görülür.
 */
export function JournalEntryList() {
  const kolonlar: Kolon<JournalEntry>[] = [
    kolonBelgeNo<JournalEntry>('Fiş no'),
    kolonTarih<JournalEntry>('entry_date', 'Tarih'),
    kolonAd<JournalEntry>('journal_code', 'Yevmiye'),
    {
      anahtar: 'description', baslik: 'Açıklama', suz: 'metin',
      govde: (e) => e.description ?? <span className="muted">—</span>,
      disa: (e) => e.description ?? '',
    },
    {
      anahtar: 'status', baslik: 'Durum', suz: 'secim', gruplanir: true,
      secenekler: [
        { deger: 'draft', etiket: 'Taslak' },
        { deger: 'posted', etiket: 'Muhasebeleşti' },
        { deger: 'reversed', etiket: 'Ters kayıt alındı' },
      ],
      govde: (e) => (
        <span className="row">
          <StatusBadge status={e.status} />
          {e.reversal_of_id && <span className="badge badge-warn">Ters kayıt</span>}
        </span>
      ),
      disa: (e) => e.status,
    },
    kolonPara<JournalEntry>('total_debit', 'Borç'),
    kolonPara<JournalEntry>('total_credit', 'Alacak'),
    {
      anahtar: 'reference', baslik: 'Referans', gizliBaslangic: true,
      govde: (e) => e.reference ?? <span className="muted">—</span>,
      disa: (e) => e.reference ?? '',
    },
  ];

  return (
    <ResourceList<JournalEntry>
      kicker="Muhasebe · Yevmiye Defteri"
      baslik="Yevmiye Defteri"
      altBaslik="Fişler, muhasebeleşme durumu ve borç/alacak dengesi."
      yol="/finance/entries"
      aramaYer="Fiş no, açıklama, referans…"
      varsayilanSirala={{ kolon: 'entry_date', yon: 'desc' }}
      kolonlar={kolonlar}
      satirYolu={(e) => `/finance/entries/${e.id}`}
      yazmaIzni="finance.entry.create"
      silmeIzni="finance.entry.delete.all"
      yetenekler={[
        { simge: BookOpen, etiket: 'Çift taraflı', deger: 'Borç = alacak' },
        { simge: Lock, etiket: 'Kilit', deger: 'Muhasebeleşen fiş donar' },
        { simge: Undo2, etiket: 'Düzeltme', deger: 'Ters kayıtla' },
        { simge: Landmark, etiket: 'Kaynak', deger: 'Fatura · bordro · kasa' },
        { simge: CalendarRange, etiket: 'Dönem', deger: 'Kapanışta kilitlenir' },
      ]}
      sayimlar={(t, rows) => [
        { deger: t, etiket: 'fiş' },
        { deger: rows.filter((e) => e.status === 'draft').length, etiket: 'taslak' },
      ]}
      gostergeler={(rows) => {
        if (rows.length === 0) return null;
        const borc = rows.reduce((t, e) => t + Number(e.total_debit || 0), 0);
        const alacak = rows.reduce((t, e) => t + Number(e.total_credit || 0), 0);
        const dengeli = Math.abs(borc - alacak) < 0.005;
        const taslak = rows.filter((e) => e.status === 'draft');
        const ters = rows.filter((e) => e.reversal_of_id);
        return (
          <div className="grid grid-4">
            <Stat label="Muhasebeleşmeyi bekleyen" value={taslak.length}
                  hint={taslak.length === 0 ? 'Bekleyen taslak yok' : 'Dönem kapanışını bloke eder'} />
            <Stat label="Listelenen borç" value={money(borc)}
                  hint={dengeli ? 'Alacakla dengeli' : 'Alacakla EŞİT DEĞİL'} />
            <Stat label="Listelenen alacak" value={money(alacak)} hint={`${rows.length} fiş`} />
            <Stat label="Ters kayıt" value={ters.length}
                  hint={ters.length === 0 ? 'Düzeltme kaydı yok' : 'Muhasebeleşmiş fişin düzeltmesi'} />
          </div>
        );
      }}
      bosBaslik="Defter henüz boş"
      bosMetin="Yevmiye fişi elle açılabilir; ama çoğu kayıt kendiliğinden doğar: muhasebeleşen bir fatura, onaylanan bir bordro ya da kapanan bir kasa oturumu kendi fişini üretir. Muhasebeleşen fiş bir daha değişmez -- düzeltme ters kayıtla yapılır."
      dipnot={<span>Borç ve alacak yalnızca listelenen fişler için toplanır.</span>}
    />
  );
}

export function JournalEntryDetail() {
  const { id } = useParams();
  const { can } = useSession();
  const doc = useItem<JournalEntry>(`/finance/entries/${id}/full`);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);

  const act = async (action: string, body?: unknown) => {
    setBusy(true); setError(null);
    try {
      await api.post(`/finance/entries/${id}/${action}`, body);
      await doc.reload();
    } catch (err) { setError(err); } finally { setBusy(false); }
  };

  if (doc.loading) return <p className="muted">Yükleniyor…</p>;
  if (!doc.data) return <ErrorBox error={doc.error} />;
  const e = doc.data;

  return (
    <>
      <PageHead
        title={`Yevmiye Fişi ${e.number ?? '(taslak)'}`}
        subtitle={<><StatusBadge status={e.status} />
          {' · '}{e.journal_name} · {date(e.entry_date)}</>}
        actions={can('finance.entry.post') ? (
          <div className="row">
            {e.status === 'draft' && (
              <button className="btn btn-primary" disabled={busy}
                      onClick={() => void act('post')}>Muhasebeleştir</button>
            )}
            {e.status === 'posted' && (
              <button className="btn btn-danger" disabled={busy}
                      onClick={() => void act('reverse', { reason: 'kullanıcı düzeltmesi' })}>
                Ters kaydını al
              </button>
            )}
          </div>
        ) : null}
      />
      <ErrorBox error={error} />

      {e.status === 'posted' && (
        <p className="muted" style={{ fontSize: 13, marginTop: -8, marginBottom: 16 }}>
          Muhasebeleşmiş fiş değiştirilemez. Düzeltme yalnızca ters kayıtla yapılır.
        </p>
      )}

      <Card padded={false}>
        <div className="tbl-wrap">
          <table className="tbl">
            <thead>
              <tr><th>Hesap</th><th>Açıklama</th><th>Cari</th>
                  <th className="r">Borç</th><th className="r">Alacak</th></tr>
            </thead>
            <tbody>
              {(e.lines ?? []).map((l) => (
                <tr key={l.id}>
                  <td><span className="num"><strong>{l.account_code}</strong></span>{' '}
                      <span className="muted">{l.account_name}</span></td>
                  <td>{l.description ?? '—'}</td>
                  <td className="muted">{l.partner_name ?? '—'}</td>
                  <td className="r">{Number(l.debit) > 0 ? money(l.debit) : '—'}</td>
                  <td className="r">{Number(l.credit) > 0 ? money(l.credit) : '—'}</td>
                </tr>
              ))}
            </tbody>
            <tfoot>
              <tr style={{ borderTop: '2px solid var(--c-border)' }}>
                <td colSpan={3}><strong>Toplam</strong></td>
                <td className="r"><strong>{money(e.total_debit)}</strong></td>
                <td className="r"><strong>{money(e.total_credit)}</strong></td>
              </tr>
            </tfoot>
          </table>
        </div>
      </Card>
    </>
  );
}

// ---------------------------------------------------------------------------
// Raporlar
// ---------------------------------------------------------------------------
type Tab = 'pl' | 'trial' | 'vat' | 'aging';

export function FinanceReports() {
  const { me } = useSession();
  const [tab, setTab] = useState<Tab>('pl');
  const [from, setFrom] = useState(monthStart());
  const [to, setTo] = useState('');
  const currency = me?.tenant?.currency ?? 'TRY';

  const TABS: { key: Tab; label: string }[] = [
    { key: 'pl', label: 'Kâr / Zarar' },
    { key: 'trial', label: 'Mizan' },
    { key: 'vat', label: 'KDV Özeti' },
    { key: 'aging', label: 'Cari Yaşlandırma' },
  ];

  return (
    <>
      <PageHead title="Muhasebe Raporları"
                subtitle="Yalnızca erişebildiğiniz şubelerin rakamları" />
      <Toolbar>
        {TABS.map((t) => (
          <button key={t.key}
                  className={`btn btn-sm${tab === t.key ? ' btn-primary' : ''}`}
                  onClick={() => setTab(t.key)}>{t.label}</button>
        ))}
        <span style={{ flex: 1 }} />
        <label className="muted" style={{ fontSize: 12 }}>Dönem</label>
        <input type="date" style={{ width: 'auto' }} value={from} onChange={(e) => setFrom(e.target.value)} />
        <input type="date" style={{ width: 'auto' }} value={to} onChange={(e) => setTo(e.target.value)} />
      </Toolbar>

      {tab === 'pl' && <ProfitLossReport from={from} to={to} currency={currency} />}
      {tab === 'trial' && <TrialBalanceReport from={from} to={to} currency={currency} />}
      {tab === 'vat' && <VatReport from={from} to={to} currency={currency} />}
      {tab === 'aging' && <AgingReport currency={currency} />}

      <PageFoot>
        <span>Dönem: <strong>{from || 'başlangıçtan'}</strong> — <strong>{to || 'bugüne'}</strong></span>
        <span>Rakamlar yalnızca erişebildiğiniz şubeleri kapsar (RLS).</span>
        <span>Kapalı dönemlere kayıt atılamaz; düzeltme ters kayıtla yapılır.</span>
      </PageFoot>
    </>
  );
}

function ProfitLossReport({ from, to, currency }: { from: string; to: string; currency: string }) {
  const pl = useItem<ProfitLoss>(
    `/finance/reports/profit-loss?detail=1${from ? `&from=${from}` : ''}${to ? `&to=${to}` : ''}`);
  if (pl.loading) return <p className="muted">Yükleniyor…</p>;
  const s = pl.data?.summary;
  if (!s) return <><ErrorBox error={pl.error} /><Empty>Bu dönemde muhasebe kaydı yok</Empty></>;

  return (
    <div className="grid-sections">
      {/* LİDER NET KÂR: gelir tablosuna bakan kişi ciroyu değil, dönemin
          sonuçta ne bıraktığını arar. Ciro hemen yanında ikinci sırada. */}
      <div className="grid grid-4">
        <Stat label="Net kâr" value={money(s.net_profit, currency)}
              hint={Number(s.net_revenue) === 0 ? 'Dönemde satış yok'
                : `Net satışların %${Math.round((Number(s.net_profit) / Number(s.net_revenue)) * 100)}'i`} />
        <Stat label="Net satışlar" value={money(s.net_revenue, currency)}
              hint={`Brüt ${money(s.gross_revenue, currency)}`} />
        <Stat label="Brüt kâr" value={money(s.gross_profit, currency)}
              hint={`SMM ${money(s.cogs, currency)}`} />
        <Stat label="Faaliyet giderleri" value={money(s.operating_expenses, currency)}
              hint="Genel yönetim ve pazarlama" />
      </div>

      <Card title="Gelir tablosu" padded={false}>
        <table className="tbl">
          <tbody>
            <tr><td>Brüt satışlar</td><td className="r">{money(s.gross_revenue, currency)}</td></tr>
            <tr><td className="muted">Satış indirimleri</td>
                <td className="r muted">−{money(s.sales_deductions, currency)}</td></tr>
            <tr><td><strong>Net satışlar</strong></td>
                <td className="r"><strong>{money(s.net_revenue, currency)}</strong></td></tr>
            <tr><td className="muted">Satılan malın maliyeti</td>
                <td className="r muted">−{money(s.cogs, currency)}</td></tr>
            <tr><td><strong>Brüt kâr</strong></td>
                <td className="r"><strong>{money(s.gross_profit, currency)}</strong></td></tr>
            <tr><td className="muted">Faaliyet giderleri</td>
                <td className="r muted">−{money(s.operating_expenses, currency)}</td></tr>
            <tr><td className="muted">Diğer gelirler</td>
                <td className="r muted">{money(s.other_income, currency)}</td></tr>
            <tr><td className="muted">Finansman giderleri</td>
                <td className="r muted">−{money(s.financial_expenses, currency)}</td></tr>
            <tr style={{ borderTop: '2px solid var(--c-border)' }}>
              <td><strong>Net kâr / zarar</strong></td>
              <td className="r"><strong>{money(s.net_profit, currency)}</strong></td></tr>
          </tbody>
        </table>
      </Card>

      {pl.data!.by_branch.length > 1 && (
        <Card title="Şube bazında" padded={false}>
          <div className="tbl-wrap">
            <table className="tbl">
              <thead>
                <tr><th>Şube</th><th className="r">Net satış</th><th className="r">SMM</th>
                    <th className="r">Brüt kâr</th><th className="r">Gider</th><th className="r">Net kâr</th></tr>
              </thead>
              <tbody>
                {pl.data!.by_branch.map((b) => (
                  <tr key={b.branch_id ?? 'yok'}>
                    <td><strong>{b.branch_name ?? 'Şubesiz'}</strong></td>
                    <td className="r">{money(b.net_revenue, currency)}</td>
                    <td className="r">{money(b.cogs, currency)}</td>
                    <td className="r">{money(b.gross_profit, currency)}</td>
                    <td className="r">{money(b.operating_expenses, currency)}</td>
                    <td className="r"><strong>{money(b.net_profit, currency)}</strong></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Card>
      )}

      <Card title="Hesap detayı" padded={false}>
        <div className="tbl-wrap">
          <table className="tbl">
            <thead><tr><th>Kod</th><th>Hesap</th><th className="r">Tutar</th></tr></thead>
            <tbody>
              {pl.data!.accounts.map((a) => (
                <tr key={a.code}>
                  <td className="num">{a.code}</td>
                  <td>{a.name}</td>
                  <td className="r">{money(a.amount, currency)}</td>
                </tr>
              ))}
            </tbody>
          </table>
          {pl.data!.accounts.length === 0 && <Empty />}
        </div>
      </Card>
    </div>
  );
}

function TrialBalanceReport({ from, to, currency }: { from: string; to: string; currency: string }) {
  const rows = useList<TrialBalanceRow>('/finance/reports/trial-balance',
    { from: from || undefined, to: to || undefined });
  const totalDebit = rows.data.reduce((s, r) => s + Number(r.debit_total), 0);
  const totalCredit = rows.data.reduce((s, r) => s + Number(r.credit_total), 0);

  return (
    <Card title="Mizan" padded={false}
          actions={<span className={`badge ${Math.abs(totalDebit - totalCredit) < 0.01 ? 'badge-ok' : 'badge-danger'}`}>
            {Math.abs(totalDebit - totalCredit) < 0.01 ? 'Dengeli' : 'DENGESİZ'}</span>}>
      <div className="tbl-wrap">
        <table className="tbl">
          <thead>
            <tr><th>Kod</th><th>Hesap</th><th className="r">Borç</th>
                <th className="r">Alacak</th><th className="r">Bakiye</th></tr>
          </thead>
          <tbody>
            {rows.data.map((r) => (
              <tr key={r.account_id}>
                <td className="num"><strong>{r.code}</strong></td>
                <td>{r.name}</td>
                <td className="r">{money(r.debit_total, currency)}</td>
                <td className="r">{money(r.credit_total, currency)}</td>
                <td className="r">{money(r.balance, currency)}</td>
              </tr>
            ))}
          </tbody>
          <tfoot>
            <tr style={{ borderTop: '2px solid var(--c-border)' }}>
              <td colSpan={2}><strong>Toplam</strong></td>
              <td className="r"><strong>{money(totalDebit, currency)}</strong></td>
              <td className="r"><strong>{money(totalCredit, currency)}</strong></td>
              <td />
            </tr>
          </tfoot>
        </table>
        {!rows.loading && rows.data.length === 0 && <Empty />}
      </div>
    </Card>
  );
}

function VatReport({ from, to, currency }: { from: string; to: string; currency: string }) {
  const rows = useList<VatRow>('/finance/reports/vat', { from: from || undefined, to: to || undefined });
  const sum = (kind: string, field: keyof VatRow) =>
    rows.data.filter((r) => r.kind === kind).reduce((s, r) => s + Number(r[field] ?? 0), 0);
  const output = sum('sale', 'tax_amount');
  const input = sum('purchase', 'tax_amount');

  return (
    <div className="grid-sections">
      <div className="grid grid-4">
        <Stat label="Hesaplanan KDV" value={money(output, currency)} />
        <Stat label="İndirilecek KDV" value={money(input, currency)} />
        <Stat label={output - input >= 0 ? 'Ödenecek KDV' : 'Devreden KDV'}
              value={money(Math.abs(output - input), currency)} />
        <Stat label="Tevkifat" value={money(sum('sale', 'withholding_amount'), currency)} />
      </div>
      <Card title="Dönem ve orana göre" padded={false}>
        <div className="tbl-wrap">
          <table className="tbl">
            <thead>
              <tr><th>Dönem</th><th>Tür</th><th>Oran</th><th className="r">Matrah</th>
                  <th className="r">KDV</th><th className="r">Tevkifat</th><th className="r">Fatura</th></tr>
            </thead>
            <tbody>
              {rows.data.map((r, ix) => (
                <tr key={ix}>
                  <td>{date(r.period_start)}</td>
                  <td>{r.kind === 'sale' ? 'Satış' : 'Alış'}</td>
                  <td className="num">{r.tax_code ?? '—'}</td>
                  <td className="r">{money(r.tax_base, currency)}</td>
                  <td className="r">{money(r.tax_amount, currency)}</td>
                  <td className="r">{money(r.withholding_amount, currency)}</td>
                  <td className="r">{r.invoice_count}</td>
                </tr>
              ))}
            </tbody>
          </table>
          {!rows.loading && rows.data.length === 0 && <Empty />}
        </div>
      </Card>
    </div>
  );
}

function AgingReport({ currency }: { currency: string }) {
  const [kind, setKind] = useState('sale');
  const rows = useList<AgingRow>('/finance/reports/aging', { kind });

  return (
    <Card title="Cari Yaşlandırma" padded={false}
          actions={
            <select style={{ width: 'auto' }} value={kind} onChange={(e) => setKind(e.target.value)}>
              <option value="sale">Alacaklar</option>
              <option value="purchase">Borçlar</option>
            </select>
          }>
      <div className="tbl-wrap">
        <table className="tbl">
          <thead>
            <tr><th>Cari</th><th className="r">Toplam</th><th className="r">Vadesi gelmemiş</th>
                <th className="r">0-30</th><th className="r">31-60</th>
                <th className="r">61-90</th><th className="r">90+</th></tr>
          </thead>
          <tbody>
            {rows.data.map((r) => (
              <tr key={r.partner_id}>
                <td><strong>{r.partner_name}</strong></td>
                <td className="r"><strong>{money(r.open_amount, currency)}</strong></td>
                <td className="r">{money(r.not_due, currency)}</td>
                <td className="r">{money(r.overdue_0_30, currency)}</td>
                <td className="r">{money(r.overdue_31_60, currency)}</td>
                <td className="r">{money(r.overdue_61_90, currency)}</td>
                <td className="r">{Number(r.overdue_90_plus) > 0
                  ? <span className="badge badge-danger">{money(r.overdue_90_plus, currency)}</span>
                  : money(r.overdue_90_plus, currency)}</td>
              </tr>
            ))}
          </tbody>
        </table>
        {!rows.loading && rows.data.length === 0 && <Empty>Açık bakiye yok</Empty>}
      </div>
    </Card>
  );
}
