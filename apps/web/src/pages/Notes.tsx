import { useCallback, useEffect, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { Banknote, CalendarClock, CircleSlash, Landmark, Undo2 } from 'lucide-react';
import { api } from '../api/client';
import { useSession } from '../api/session';
import { useList } from '../ui/useResource';
import { Card, ErrorBox, Field, Stat } from '../ui';
import { ResourceList, type Kolon } from '../ui/ResourceList';
import { kolonAd, kolonBelgeNo, kolonPara, kolonTarih } from '../ui/kolonlar';
import { date, money, num } from '../i18n';

/* ===========================================================================
   Çek / Senet portföyü
   ===========================================================================
   ELDE DURAN BİR ÇEK HENÜZ PARA DEĞİLDİR. Bu ekranın varlık sebebi o: kasa
   bakiyesi ile portföydeki evrak ayrı şeylerdir ve nakit planı ikisini birden
   bilmeden yapılamaz.

   BAŞ RAKAM VADESİ GEÇEN EVRAKTIR, portföyün toplamı değil. Toplam bir
   büyüklük ölçüsüdür; vadesi geçmiş evrak ise bugün yapılacak iştir.
   ========================================================================= */

interface Note {
  id: string; number: string | null; serial_no: string | null;
  kind: 'cek' | 'senet'; direction: 'in' | 'out'; status: string;
  partner_id: string | null; partner_name: string | null; drawer_name: string | null;
  bank_name: string | null; bank_branch: string | null;
  issue_date: string; due_date: string;
  amount: string; currency: string;
  bank_account_id: string | null; bank_account_name: string | null;
  endorsed_to_name: string | null;
  kalan_gun: number; vadesi_gecti: boolean;
  notes: string | null;
}

/** Durum sözlüğü: tek yerde, hem rozet hem eylem adları buradan. */
const DURUM: Record<string, { ad: string; ton: string }> = {
  portfoy: { ad: 'Portföyde', ton: 'badge-info' },
  tahsile_verildi: { ad: 'Tahsile verildi', ton: 'badge-warn' },
  ciro_edildi: { ad: 'Ciro edildi', ton: '' },
  tahsil_edildi: { ad: 'Tahsil edildi', ton: 'badge-ok' },
  karsiliksiz: { ad: 'Karşılıksız', ton: 'badge-danger' },
  iade: { ad: 'İade edildi', ton: '' },
};

/**
 * İzin verilen geçişler — ARAYÜZ KOPYASI.
 *
 * Kuralın kendisi veritabanında (`finance.note_gecis_gecerli`); buradaki
 * liste yalnızca hangi düğmenin çizileceğini bilmek için. İkisi ayrışırsa
 * arayüz olmayan bir düğme gösterir ve sunucu reddeder -- kullanıcı hata
 * mesajı görür ama veri bozulmaz. Tersi (arayüzde kural, sunucuda yok)
 * kabul edilemezdi.
 */
const GECISLER: Record<string, Record<string, string[]>> = {
  in: {
    portfoy: ['tahsile_verildi', 'ciro_edildi', 'tahsil_edildi', 'iade'],
    tahsile_verildi: ['tahsil_edildi', 'karsiliksiz', 'portfoy'],
    karsiliksiz: ['portfoy', 'iade', 'tahsil_edildi'],
  },
  out: {
    portfoy: ['tahsil_edildi', 'karsiliksiz', 'iade'],
    karsiliksiz: ['portfoy', 'tahsil_edildi'],
  },
};

const EYLEM_ADI: Record<string, string> = {
  tahsile_verildi: 'Tahsile ver',
  ciro_edildi: 'Ciro et',
  tahsil_edildi: 'Tahsil edildi',
  karsiliksiz: 'Karşılıksız',
  portfoy: 'Portföye al',
  iade: 'İade et',
};

export function NoteList({ direction }: { direction: 'in' | 'out' }) {
  const { can, me } = useSession();
  const alinan = direction === 'in';
  const paraBirimi = me?.tenant?.currency ?? 'TRY';
  const [taslak, setTaslak] = useState<Record<string, unknown> | null>(null);
  const [hata, setHata] = useState<unknown>(null);
  const [kaydediyor, setKaydediyor] = useState(false);
  const [tazele, setTazele] = useState(0);
  const [gecis, setGecis] = useState<{ note: Note; hedef: string } | null>(null);

  /**
   * `?cari=` ile gelen istek formu AÇAR ve cariyi seçer.
   *
   * Cari kartındaki "Tedarikçiye Senet Ver" buraya yönlendiriyor; parametre
   * okunmasaydı kullanıcı listeye düşer ve eylem hiçbir şey yapmamış olurdu.
   * Parametre okunur okunmaz URL'den silinir: yenilemede formun tekrar
   * açılması, kullanıcının bıraktığı yeri değil komutu hatırlamak olurdu.
   */
  const [arama, setArama] = useSearchParams();
  useEffect(() => {
    const cari = arama.get('cari');
    if (!cari) return;
    setTaslak({
      kind: 'senet', partner_id: cari, currency: paraBirimi,
      issue_date: new Date().toISOString().slice(0, 10),
    });
    arama.delete('cari');
    setArama(arama, { replace: true });
  }, [arama, setArama, paraBirimi]);

  const bankalar = useList<{ id: string; name: string }>('/finance/bank-accounts', { limit: 50 });
  const cariler = useList<{ id: string; name: string }>('/core/partners', { limit: 200 });

  const kaydet = async () => {
    setKaydediyor(true); setHata(null);
    try {
      await api.post('/finance/notes', { ...taslak, direction });
      setTaslak(null);
      setTazele((v) => v + 1);
    } catch (err) { setHata(err); } finally { setKaydediyor(false); }
  };

  const alan = (k: string) => String(taslak?.[k] ?? '');
  const yaz = (k: string, v: unknown) => setTaslak((t) => ({ ...(t ?? {}), [k]: v }));

  const kolonlar: Kolon<Note>[] = [
    kolonBelgeNo<Note>('No'),
    {
      anahtar: 'kind', baslik: 'Tür', suz: 'secim', gruplanir: true,
      secenekler: [{ deger: 'cek', etiket: 'Çek' }, { deger: 'senet', etiket: 'Senet' }],
      govde: (n) => <span className="badge">{n.kind === 'cek' ? 'Çek' : 'Senet'}</span>,
      disa: (n) => (n.kind === 'cek' ? 'Çek' : 'Senet'),
    },
    {
      anahtar: 'serial_no', baslik: 'Seri no', suz: 'metin',
      govde: (n) => (n.serial_no
        ? <span className="num">{n.serial_no}</span>
        : <span className="muted">—</span>),
      disa: (n) => n.serial_no ?? '',
    },
    {
      anahtar: 'partner_name', baslik: alinan ? 'Veren cari' : 'Alan cari',
      suz: 'metin', gruplanir: true,
      govde: (n) => (
        <>
          <strong>{n.partner_name ?? '—'}</strong>
          {/* KEŞİDECİ CARİDEN FARKLIYSA gösterilir: ciro edilmiş bir çekte
              asıl borçlu, çeki veren cari değildir. */}
          {n.drawer_name && n.drawer_name !== n.partner_name && (
            <div className="muted micro">keşideci: {n.drawer_name}</div>
          )}
        </>
      ),
      disa: (n) => n.partner_name ?? '',
    },
    kolonAd<Note>('bank_name', 'Banka'),
    kolonTarih<Note>('issue_date', 'Düzenleme', true),
    {
      anahtar: 'due_date', baslik: 'Vade', sirala: true,
      // VADESİ GEÇMİŞ EVRAK renkle DEĞİL, kelimeyle de işaretlenir.
      govde: (n) => (n.vadesi_gecti
        ? <span className="badge badge-danger">{date(n.due_date)} · {Math.abs(n.kalan_gun)} gün geçti</span>
        : (
          <>
            {date(n.due_date)}
            {n.kalan_gun >= 0 && n.kalan_gun <= 7
              && <span className="badge badge-warn">{n.kalan_gun} gün</span>}
          </>
        )),
      disa: (n) => n.due_date,
    },
    {
      anahtar: 'status', baslik: 'Durum', suz: 'secim', gruplanir: true,
      secenekler: Object.entries(DURUM).map(([deger, v]) => ({ deger, etiket: v.ad })),
      govde: (n) => {
        const d = DURUM[n.status];
        return (
          <>
            <span className={`badge ${d?.ton ?? ''}`}>{d?.ad ?? n.status}</span>
            {n.status === 'tahsile_verildi' && n.bank_account_name && (
              <div className="muted micro">{n.bank_account_name}</div>
            )}
            {n.status === 'ciro_edildi' && n.endorsed_to_name && (
              <div className="muted micro">→ {n.endorsed_to_name}</div>
            )}
          </>
        );
      },
      disa: (n) => DURUM[n.status]?.ad ?? n.status,
    },
    kolonPara<Note>('amount', 'Tutar', { kalin: true, sirala: true }),
  ];

  return (
    <>
      <ErrorBox error={hata} />

      {gecis && (
        <GecisFormu
          note={gecis.note} hedef={gecis.hedef}
          bankalar={bankalar.data} cariler={cariler.data}
          vazgec={() => setGecis(null)}
          bitti={() => { setGecis(null); setTazele((v) => v + 1); }}
          setHata={setHata}
        />
      )}

      {taslak && (
        <Card title={alinan ? 'Alınan çek / senet' : 'Verilen çek / senet'} actions={
          <div className="row">
            <button className="btn btn-sm" onClick={() => setTaslak(null)}>Vazgeç</button>
            <button className="btn btn-sm btn-primary" disabled={kaydediyor}
                    aria-busy={kaydediyor} onClick={() => void kaydet()}>
              {kaydediyor ? 'Kaydediliyor…' : 'Kaydet'}
            </button>
          </div>
        }>
          <div className="form-grid">
            <Field label="Tür">
              <select value={alan('kind')} onChange={(e) => yaz('kind', e.target.value)}>
                <option value="cek">Çek</option>
                <option value="senet">Senet</option>
              </select>
            </Field>
            <Field label={alinan ? 'Veren cari' : 'Alan cari'}>
              <select value={alan('partner_id')}
                      onChange={(e) => yaz('partner_id', e.target.value || null)}>
                <option value="">Seçiniz</option>
                {cariler.data.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
              </select>
            </Field>
            <Field label="Seri / evrak no">
              <input value={alan('serial_no')} onChange={(e) => yaz('serial_no', e.target.value)} />
            </Field>
            <Field label="Keşideci" hint="Cariden farklıysa doldurun">
              <input value={alan('drawer_name')} onChange={(e) => yaz('drawer_name', e.target.value)} />
            </Field>
            {/* ÇEKTE BANKA ZORUNLU: kural veritabanında da var, form da
                sormalı ki kullanıcı hatayı kaydettikten sonra öğrenmesin. */}
            {alan('kind') !== 'senet' && (
              <>
                <Field label="Banka" hint="Çekte zorunlu">
                  <input value={alan('bank_name')} onChange={(e) => yaz('bank_name', e.target.value)} />
                </Field>
                <Field label="Şube">
                  <input value={alan('bank_branch')} onChange={(e) => yaz('bank_branch', e.target.value)} />
                </Field>
              </>
            )}
            <Field label="Düzenleme tarihi">
              <input type="date" value={alan('issue_date')}
                     onChange={(e) => yaz('issue_date', e.target.value)} />
            </Field>
            <Field label="Vade" hint="Düzenleme tarihinden önce olamaz">
              <input type="date" value={alan('due_date')}
                     onChange={(e) => yaz('due_date', e.target.value)} />
            </Field>
            <Field label="Tutar">
              <input type="number" min={0} step="0.01" value={alan('amount')}
                     onChange={(e) => yaz('amount', e.target.value)} />
            </Field>
          </div>
        </Card>
      )}

      <ResourceList<Note>
        key={tazele}
        kicker={alinan ? 'Muhasebe · Alınan Çek / Senet' : 'Muhasebe · Verilen Çek / Senet'}
        baslik={alinan ? 'Alınan Çek / Senet' : 'Verilen Çek / Senet'}
        altBaslik={alinan
          ? 'Müşteriden alınan kıymetli evrak: portföy, tahsil ve karşılıksız takibi.'
          : 'Tedarikçiye verilen kıymetli evrak: vade ve ödeme takibi.'}
        yol="/finance/notes"
        sabitSuzgec={{ direction }}
        aramaYer="Evrak no, seri no, keşideci, banka, cari…"
        varsayilanSirala={{ kolon: 'due_date', yon: 'asc' }}
        kolonlar={kolonlar}
        yazmaIzni="finance.note.create"
        silmeIzni="finance.note.delete.all"
        yazilabilir={['kind', 'serial_no', 'drawer_name', 'bank_name', 'bank_branch',
          'issue_place', 'issue_date', 'due_date', 'amount', 'currency', 'notes']}
        yetenekler={[
          { simge: Banknote, etiket: 'Portföy', deger: 'Elde duran evrak' },
          { simge: Landmark, etiket: 'Tahsile ver', deger: 'Banka takibi' },
          { simge: Undo2, etiket: 'Ciro', deger: 'Üçüncü tarafa devir' },
          { simge: CircleSlash, etiket: 'Karşılıksız', deger: 'Takibe alınır' },
          { simge: CalendarClock, etiket: 'Vade', deger: 'Yaklaşanı bildirir' },
        ]}
        sayimlar={(t, rows) => [
          { deger: t, etiket: 'evrak' },
          { deger: rows.filter((n) => n.vadesi_gecti).length, etiket: 'vadesi geçen' },
        ]}
        birincilEylem={can('finance.note.create')
          ? (
            <button className="btn btn-primary"
                    onClick={() => setTaslak({
                      kind: 'cek', issue_date: new Date().toISOString().slice(0, 10),
                      currency: paraBirimi,
                    })}>
              {alinan ? 'Çek / senet al' : 'Çek / senet ver'}
            </button>
          )
          : null}
        satirEylem={can('finance.note.write.all')
          ? (n) => {
            const hedefler = GECISLER[n.direction]?.[n.status] ?? [];
            if (hedefler.length === 0) return null;
            return (
              <select
                className="satir-secim" defaultValue=""
                aria-label={`${n.number ?? 'Evrak'} için işlem`}
                onChange={(e) => {
                  if (e.target.value) { setGecis({ note: n, hedef: e.target.value }); }
                  e.target.value = '';
                }}
              >
                <option value="">İşlem…</option>
                {hedefler.map((h) => (
                  <option key={h} value={h}>{EYLEM_ADI[h] ?? h}</option>
                ))}
              </select>
            );
          }
          : undefined}
        gostergeler={(rows) => {
          if (rows.length === 0) return null;
          const portfoyde = rows.filter((n) => n.status === 'portfoy' || n.status === 'tahsile_verildi');
          const topla = (xs: Note[]) => xs.reduce((t, n) => t + Number(n.amount || 0), 0);
          const gecen = portfoyde.filter((n) => n.vadesi_gecti);
          const yaklasan = portfoyde.filter((n) => !n.vadesi_gecti && n.kalan_gun <= 30);
          const karsiliksiz = rows.filter((n) => n.status === 'karsiliksiz');
          return (
            <div className="grid grid-4">
              {/* BAŞ RAKAM VADESİ GEÇEN: portföyün toplamı bir büyüklük
                  ölçüsüdür, vadesi geçmiş evrak ise bugün yapılacak iş. */}
              <Stat label="Vadesi geçen" value={money(topla(gecen), paraBirimi)}
                    hint={gecen.length === 0 ? 'Gecikmiş evrak yok' : `${gecen.length} evrak`} />
              <Stat label="30 gün içinde" value={money(topla(yaklasan), paraBirimi)}
                    hint={`${yaklasan.length} evrak vadesi yaklaşıyor`} />
              <Stat label="Portföy toplamı" value={money(topla(portfoyde), paraBirimi)}
                    hint={`${portfoyde.length} evrak elde`} />
              <Stat label="Karşılıksız" value={karsiliksiz.length}
                    hint={karsiliksiz.length === 0 ? 'Karşılıksız evrak yok'
                      : money(topla(karsiliksiz), paraBirimi)} />
            </div>
          );
        }}
        bosBaslik={alinan ? 'Portföyde evrak yok' : 'Verilen evrak yok'}
        bosMetin={alinan
          ? 'Müşteriden çek ya da senet aldığınızda buraya kaydedin. Elde duran evrak henüz para değildir; vadesi, tahsil durumu ve karşılıksız riski buradan izlenir.'
          : 'Tedarikçiye çek ya da senet verdiğinizde buraya kaydedin. Vadesi geldiğinde ödenmesi gereken tutar buradan görünür.'}
        dipnot={<span>Durum değişiklikleri kural denetiminden geçer; geçersiz geçiş reddedilir.</span>}
      />
    </>
  );
}

/* --------------------------------------------------------------------------
   Durum geçiş formu
   --------------------------------------------------------------------------
   TAHSİLE VERME BANKA, CİRO CARİ İSTER. İkisini de aynı forma koymak yerine
   hedefe göre yalnızca gerekli alan sorulur; gereksiz bir alan, kullanıcıya
   doldurulması gerekiyormuş gibi görünür.
   ------------------------------------------------------------------------ */
function GecisFormu({ note, hedef, bankalar, cariler, vazgec, bitti, setHata }: {
  note: Note; hedef: string;
  bankalar: { id: string; name: string }[];
  cariler: { id: string; name: string }[];
  vazgec: () => void; bitti: () => void; setHata: (e: unknown) => void;
}) {
  const [banka, setBanka] = useState('');
  const [cari, setCari] = useState('');
  const [not, setNot] = useState('');
  const [calisiyor, setCalisiyor] = useState(false);

  const bankaGerek = hedef === 'tahsile_verildi';
  const cariGerek = hedef === 'ciro_edildi';
  const eksik = (bankaGerek && !banka) || (cariGerek && !cari);

  const gonder = async () => {
    setCalisiyor(true); setHata(null);
    try {
      await api.post(`/finance/notes/${note.id}/status`, {
        status: hedef,
        bank_account_id: bankaGerek ? banka : undefined,
        endorsed_to_id: cariGerek ? cari : undefined,
        note: not || undefined,
      });
      bitti();
    } catch (err) { setHata(err); } finally { setCalisiyor(false); }
  };

  return (
    <Card title={`${note.number ?? 'Evrak'} — ${EYLEM_ADI[hedef] ?? hedef}`} actions={
      <div className="row">
        <button className="btn btn-sm" onClick={vazgec}>Vazgeç</button>
        <button className="btn btn-sm btn-primary" disabled={eksik || calisiyor}
                aria-busy={calisiyor} onClick={() => void gonder()}>
          {calisiyor ? 'İşleniyor…' : 'Uygula'}
        </button>
      </div>
    }>
      <div className="form-grid">
        {bankaGerek && (
          <Field label="Tahsile verilen banka hesabı"
                 hint={bankalar.length === 0
                   ? 'Tanımlı banka hesabı yok. Önce Ayarlar > Banka hesapları.'
                   : undefined}>
            <select value={banka} onChange={(e) => setBanka(e.target.value)}>
              <option value="">Seçiniz</option>
              {bankalar.map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}
            </select>
          </Field>
        )}
        {cariGerek && (
          <Field label="Ciro edilen cari" hint="Evrak geldiği cariye ciro edilemez">
            <select value={cari} onChange={(e) => setCari(e.target.value)}>
              <option value="">Seçiniz</option>
              {cariler.filter((c) => c.id !== note.partner_id)
                .map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
            </select>
          </Field>
        )}
        <Field label="Not" hint="Evrakın geçmişine eklenir">
          <input value={not} onChange={(e) => setNot(e.target.value)} />
        </Field>
      </div>
      <p className="muted micro">
        {note.kind === 'cek' ? 'Çek' : 'Senet'} · {money(note.amount, note.currency)} ·
        vade {date(note.due_date)}
        {note.partner_name ? ` · ${note.partner_name}` : ''}
      </p>
    </Card>
  );
}

/** Portföy raporu: nakit planının çek/senet ayağı. */
export function NoteReport() {
  const { me } = useSession();
  const paraBirimi = me?.tenant?.currency ?? 'TRY';
  const [satirlar, setSatirlar] = useState<Record<string, string>[]>([]);
  const [hata, setHata] = useState<unknown>(null);

  const cek = useCallback(async () => {
    try {
      const r = await api.get<{ data: Record<string, string>[] }>(
        '/finance/reports/note-portfolio');
      setSatirlar(r.data);
    } catch (err) { setHata(err); }
  }, []);
  useEffect(() => { void cek(); }, [cek]);

  const topla = (alan: string, yon?: string) => satirlar
    .filter((s) => !yon || s.direction === yon)
    .reduce((t, s) => t + Number(s[alan] || 0), 0);

  return (
    <>
      <ErrorBox error={hata} />
      <div className="grid grid-4">
        <Stat label="Alınan portföy" value={money(topla('toplam', 'in'), paraBirimi)}
              hint="Tahsil edilecek kıymetli evrak" />
        <Stat label="Verilen portföy" value={money(topla('toplam', 'out'), paraBirimi)}
              hint="Ödenecek kıymetli evrak" />
        <Stat label="Vadesi geçen" value={money(topla('vadesi_gecen'), paraBirimi)}
              hint="Alınan ve verilen birlikte" />
        <Stat label="30 gün içinde" value={money(topla('gun_30'), paraBirimi)}
              hint="Nakit planına giren tutar" />
      </div>
      <Card title="Vade dilimleri" padded={false}>
        <div className="tbl-wrap">
          <table className="tbl">
            <thead>
              <tr>
                <th>Yön</th><th>Tür</th><th className="r">Adet</th>
                <th className="r">Vadesi geçen</th><th className="r">30 gün</th>
                <th className="r">Sonrası</th><th className="r">Toplam</th>
              </tr>
            </thead>
            <tbody>
              {satirlar.map((s, i) => (
                <tr key={i}>
                  <td>{s.direction === 'in' ? 'Alınan' : 'Verilen'}</td>
                  <td>{s.kind === 'cek' ? 'Çek' : 'Senet'}</td>
                  <td className="r">{num(s.adet, 0)}</td>
                  <td className="r">{money(s.vadesi_gecen, paraBirimi)}</td>
                  <td className="r">{money(s.gun_30, paraBirimi)}</td>
                  <td className="r">{money(s.sonra, paraBirimi)}</td>
                  <td className="r"><strong>{money(s.toplam, paraBirimi)}</strong></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Card>
    </>
  );
}

/** Cari kartındaki çek/senet sekmesi de aynı durum sözlüğünü kullanır. */
export { DURUM as NOTE_DURUM };
