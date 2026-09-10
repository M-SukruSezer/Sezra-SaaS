import { useCallback, useEffect, useMemo, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import {
  ArrowLeftRight, AtSign, Banknote, Building2, CalendarCheck, CalendarClock,
  Coins, CreditCard, FileText, Hash, Landmark, LifeBuoy, MapPin, MoreHorizontal,
  Network, PackageCheck, Paperclip, Pencil, Percent, Phone, Plus, Receipt,
  ShoppingCart, TrendingUp, Truck, UserRound, Users, Wrench,
} from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import { api } from '../api/client';
import { useSession } from '../api/session';
import { Card, Empty, ErrorBox, Field, PageFoot, StatusBadge, TableScroll } from '../ui';
import { PartnerActions } from './PartnerActions';
import { NOTE_DURUM } from './Notes';
import { date, gecenSure, money, num, sayi, tamZaman } from '../i18n';

/* ===========================================================================
   Cari kartı
   ===========================================================================
   Bir cariye bakan kişinin sorusu tek: "bu firmayla aramızda ne var". Cevap
   tek tabloda değil -- teklifte, siparişte, faturada, tahsilatta, sevkiyatta,
   serviste, destek biletinde.

   ÜST BANT BAKİYE VE VADEDİR, ciro değil. Ciro geçmiştir; kartı açan kişi
   "ne kadar alacağım var ve ne zaman" diye sorar.

   İLİŞKİ ŞERİDİ İLE SEKMELER AYRI ÇALIŞIR: şeritteki bir çipe basmak sayfayı
   değiştirmez, altında o türün son kayıtlarını AÇAR. Böylece "bu firmanın
   teklifleri ne durumda" sorusu, Genel Bilgi'den ayrılmadan cevaplanır.
   Sekmeler ise tam listeye gider.
   ========================================================================= */

interface Partner {
  id: string; code: string | null; name: string;
  is_company: boolean; is_customer: boolean; is_supplier: boolean; is_active: boolean;
  tax_office: string | null; tax_no: string | null;
  email: string | null; phone: string | null; website: string | null;
  address: string | null; district: string | null; city: string | null;
  postal_code: string | null; iban: string | null;
  payment_term_days: number; credit_limit: string | null;
  sector: string | null; discount_pct: string | null; currency: string | null;
  consent_sms: boolean; consent_email: boolean; consent_whatsapp: boolean;
  consent_at: string | null;
  notes: string | null; tags: string[];
  owner_id: string | null; owner_name: string | null; branch_name: string | null;
  created_at: string; updated_at: string;
}

interface Ozet {
  tax_no_valid: boolean | null;
  acik_bakiye: string; acik_fatura_sayisi: string; vadeli_fatura_sayisi: string;
  ortalama_vade: string | null; kisi_sayisi: string;
}

interface Iliski { anahtar: string; etiket: string; adet: number; toplam: string | null }
interface Detay { partner: Partner; ozet: Ozet | null; iliskiler: Iliski[] }
type Satir = Record<string, unknown>;

/** İlişki türünün simgesi. Şeritte etiketten önce, sekmede yok. */
const SIMGE: Record<string, LucideIcon> = {
  firsat: TrendingUp, teklif: FileText, siparis: ShoppingCart, fatura: Receipt,
  tahsilat: ArrowLeftRight, satinalma: PackageCheck, sevkiyat: Truck,
  destek: LifeBuoy, servis: Wrench, aktivite: CalendarCheck,
  kisi: Users, dosya: Paperclip,
};

/** Vade bitişine kalan gün. Geçmişse eksi döner. */
function kalanGun(iso: string): number {
  const bugun = new Date(); bugun.setHours(0, 0, 0, 0);
  const hedef = new Date(iso); hedef.setHours(0, 0, 0, 0);
  return Math.round((hedef.getTime() - bugun.getTime()) / 86_400_000);
}

export function PartnerDetail() {
  const { id } = useParams();
  const { can, me } = useSession();
  const [detay, setDetay] = useState<Detay | null>(null);
  const [hata, setHata] = useState<unknown>(null);
  const [yukleniyor, setYukleniyor] = useState(true);
  const [sekme, setSekme] = useState('genel');
  const [acikCip, setAcikCip] = useState<string | null>(null);
  const [aksiyon, setAksiyon] = useState(false);
  const [duzenle, setDuzenle] = useState(false);
  const [taslak, setTaslak] = useState<Record<string, unknown>>({});
  const [kaydediyor, setKaydediyor] = useState(false);
  const paraBirimi = me?.tenant?.currency ?? 'TRY';

  const cek = useCallback(async () => {
    if (!id) return;
    setYukleniyor(true); setHata(null);
    try {
      const res = await api.get<{ data: Detay }>(`/core/partners/${id}/detail`);
      setDetay(res.data);
    } catch (err) { setHata(err); } finally { setYukleniyor(false); }
  }, [id]);

  useEffect(() => { void cek(); }, [cek]);

  const p = detay?.partner;
  const ozet = detay?.ozet;

  const kaydet = async () => {
    if (!id) return;
    setKaydediyor(true); setHata(null);
    try {
      await api.patch(`/core/partners/${id}`, taslak);
      setDuzenle(false); setTaslak({});
      await cek();
    } catch (err) { setHata(err); } finally { setKaydediyor(false); }
  };

  const duzenlemeyiAc = () => {
    if (!p) return;
    setTaslak({
      name: p.name, code: p.code, tax_office: p.tax_office, tax_no: p.tax_no,
      email: p.email, phone: p.phone, website: p.website,
      address: p.address, district: p.district, city: p.city, postal_code: p.postal_code,
      iban: p.iban, payment_term_days: p.payment_term_days, credit_limit: p.credit_limit,
      sector: p.sector, discount_pct: p.discount_pct, currency: p.currency ?? 'TRY',
      notes: p.notes,
      consent_sms: p.consent_sms, consent_email: p.consent_email,
      consent_whatsapp: p.consent_whatsapp,
    });
    setDuzenle(true);
  };

  const alan = (k: string) => (taslak[k] ?? '') as string | number;
  const onay = (k: string) => taslak[k] === true;
  const yaz = (k: string, v: unknown) => setTaslak((t) => ({ ...t, [k]: v }));

  const iliskiler = detay?.iliskiler ?? [];
  const toplamKayit = iliskiler.reduce((t, i) => t + i.adet, 0);

  const sekmeler = useMemo(() => [
    { anahtar: 'genel', etiket: 'Genel Bilgi', adet: null as number | null },
    { anahtar: 'zaman', etiket: 'Zaman Tüneli', adet: null as number | null },
    ...iliskiler.map((i) => ({ anahtar: i.anahtar, etiket: i.etiket, adet: i.adet })),
  ], [iliskiler]);

  if (yukleniyor && !detay) return <p className="muted">Yükleniyor…</p>;
  if (!p) return <ErrorBox error={hata ?? new Error('Cari bulunamadı')} />;

  const vade = ozet?.ortalama_vade ? kalanGun(ozet.ortalama_vade) : null;
  const bakiye = Number(ozet?.acik_bakiye ?? 0);

  return (
    <div className="cari">
      {/* Şerit tam genişlikte ve başına bir nokta alır: sayfanın hangi
          bölümde olduğunu başlığı uzatmadan söyler. */}
      <div className="cari-kicker"><span className="cari-kicker-nokta" aria-hidden="true" />Satış · Firma Detay</div>

      {/* --- Başlık --- */}
      <div className="cari-bas">
        <div className="cari-bas-metin">
          <h1 className="cari-ad">{p.name}</h1>
          <div className="cari-rozetler">
            {p.is_active
              ? <span className="rozet rozet-ok">Aktif</span>
              : <span className="rozet">Pasif</span>}
            {p.is_customer && <span className="rozet rozet-info">Müşteri</span>}
            {p.is_supplier && <span className="rozet rozet-mor">Tedarikçi</span>}
            <span className="cari-kod num">
              {p.code ?? '—'} <span className="muted">eklendi {date(p.created_at)}</span>
            </span>
          </div>
        </div>

        <div className="cari-eylem">
          <Link className="btn" to="/finance/reports">
            <Landmark size={15} aria-hidden="true" /> Cari Hesabı
          </Link>
          {can('core.partner.write.all') && !duzenle && (
            <button className="btn" onClick={duzenlemeyiAc}>
              <Pencil size={15} aria-hidden="true" /> Düzenle
            </button>
          )}
          {duzenle && (
            <>
              <button className="btn" onClick={() => { setDuzenle(false); setTaslak({}); }}>
                Vazgeç
              </button>
              <button className="btn btn-primary" disabled={kaydediyor} aria-busy={kaydediyor}
                      onClick={() => void kaydet()}>
                {kaydediyor ? 'Kaydediliyor…' : 'Kaydet'}
              </button>
            </>
          )}
          {/* Aksiyonlar SAĞDAN AÇILAN PANELDE: on iki satırlık bir liste
              başlığın altına sıkışan bir açılır menüde okunmuyordu ve her
              satırın açıklamasına yer kalmıyordu. */}
          {/* ERİŞİLEBİLİR AD ETİKETTEN BAĞIMSIZ: dar ekranda `.btn-label`
              gizleniyor ve `aria-label` olmadan düğmenin adı tamamen
              kayboluyordu -- ekran okuyucu yalnızca "düğme" diyordu. */}
          <button className="btn" onClick={() => setAksiyon(true)}
                  title="Aksiyonlar" aria-label="Aksiyonlar"
                  aria-haspopup="dialog" aria-expanded={aksiyon}>
            <MoreHorizontal size={15} aria-hidden="true" />
            <span className="btn-label">Aksiyonlar</span>
          </button>
        </div>
      </div>

      <ErrorBox error={hata} />

      {/* --- Özet bandı --- */}
      <div className="cari-serit">
        <span className="cari-serit-simge"><CalendarClock size={16} aria-hidden="true" /></span>
        <span className="cari-serit-etiket">Ortalama Vade</span>
        {ozet?.ortalama_vade ? (
          <>
            <strong className="cari-serit-deger num">{date(ozet.ortalama_vade)}</strong>
            {/* Gecikme RENKLE DEĞİL kelimeyle de söylenir. */}
            <span className={vade !== null && vade < 0 ? 'rozet rozet-tehlike' : 'cari-serit-not'}>
              {vade !== null && vade < 0
                ? `${Math.abs(vade)} gün gecikti`
                : `${vade} gün kaldı`}
            </span>
            <span className="cari-serit-not">
              {sayi(ozet.acik_fatura_sayisi)} açık fatura
            </span>
          </>
        ) : (
          <span className="cari-serit-not">Açık fatura yok</span>
        )}
        <span className={`cari-bakiye${bakiye > 0 ? ' acik' : ''}`}>
          {money(bakiye, paraBirimi)}
        </span>
      </div>

      {/* --- İlişki ağı --- */}
      <div className="cari-ag">
        <div className="cari-ag-baslik">
          <Network size={14} aria-hidden="true" />
          <span className="cari-ag-ad">İlişki Ağı</span>
          <span className="cari-ag-not">
            firma neye bağlı · {iliskiler.length} tür · {toplamKayit} kayıt
          </span>
        </div>

        <div className="cari-cipler">
          {iliskiler.map((i) => {
            const Simge = SIMGE[i.anahtar] ?? Network;
            const acik = acikCip === i.anahtar;
            return (
              <button
                key={i.anahtar}
                className={`cari-cip${acik ? ' acik' : ''}${i.adet === 0 ? ' bos' : ''}`}
                aria-expanded={acik}
                onClick={() => setAcikCip(acik ? null : i.anahtar)}
              >
                <Simge size={14} aria-hidden="true" />
                <span className="cari-cip-ad">{i.etiket}</span>
                <span className="cari-cip-adet">{i.adet}</span>
                {i.toplam !== null && Number(i.toplam) > 0 && (
                  <span className="cari-cip-tutar">{money(i.toplam, paraBirimi)}</span>
                )}
              </button>
            );
          })}
        </div>

        {/* Seçili çipin son kayıtları: sayfadan ayrılmadan bir bakış. */}
        {acikCip && (
          <CipOnizleme
            partnerId={p.id} anahtar={acikCip} paraBirimi={paraBirimi}
            tumunuGor={() => { setSekme(acikCip); setAcikCip(null); }}
          />
        )}
      </div>

      {/* --- Etiketler --- */}
      <div className="cari-etiket-satiri">
        <EtiketDuzenle partner={p} yenile={cek} setHata={setHata}
                       yazabilir={can('core.partner.write.all')} />
      </div>

      {/* --- Sekmeler --- */}
      <div className="cari-sekmeler" role="tablist" aria-label="Cari bölümleri">
        {sekmeler.map((s) => (
          <button
            key={s.anahtar}
            role="tab"
            aria-selected={sekme === s.anahtar}
            className={`cari-sekme${sekme === s.anahtar ? ' secili' : ''}`}
            onClick={() => setSekme(s.anahtar)}
          >
            {s.etiket}
            {s.adet !== null && s.adet > 0 && <span className="cari-sekme-adet">{s.adet}</span>}
          </button>
        ))}
      </div>

      {sekme === 'genel' && (
        <GenelBilgi p={p} ozet={ozet} duzenle={duzenle} alan={alan} yaz={yaz} onay={onay}
                    paraBirimi={paraBirimi} />
      )}
      {sekme === 'zaman' && <ZamanTuneli partnerId={p.id} iliskiler={iliskiler} />}
      {sekme !== 'genel' && sekme !== 'zaman' && (
        <IliskiSekmesi partnerId={p.id} anahtar={sekme} paraBirimi={paraBirimi} />
      )}

      {aksiyon && (
        <PartnerActions
          partner={p}
          kapat={() => setAksiyon(false)}
          yenile={cek}
          duzenlemeyiAc={duzenlemeyiAc}
        />
      )}

      <PageFoot>
        <span>Kayıt <strong>{gecenSure(p.updated_at)}</strong> güncellendi</span>
        <span>Ortalama vade açık faturaların TUTARLA ağırlıklı ortalamasıdır.</span>
      </PageFoot>
    </div>
  );
}

/* --------------------------------------------------------------------------
   Etiketler
   ------------------------------------------------------------------------ */
function EtiketDuzenle({ partner, yenile, setHata, yazabilir }: {
  partner: Partner; yenile: () => Promise<void>;
  setHata: (e: unknown) => void; yazabilir: boolean;
}) {
  const [ekliyor, setEkliyor] = useState(false);
  const [metin, setMetin] = useState('');
  const [calisiyor, setCalisiyor] = useState(false);

  const yaz = async (etiketler: string[]) => {
    setCalisiyor(true); setHata(null);
    try {
      await api.patch(`/core/partners/${partner.id}`, { tags: etiketler });
      setMetin(''); setEkliyor(false);
      await yenile();
    } catch (err) { setHata(err); } finally { setCalisiyor(false); }
  };

  const ekle = () => {
    const t = metin.trim();
    // AYNI ETİKET İKİ KEZ EKLENMEZ: aynı adı taşıyan iki rozet, süzgeçte de
    // iki ayrı seçenek gibi görünür ve listeyi böler.
    if (!t || partner.tags.includes(t)) { setMetin(''); setEkliyor(false); return; }
    void yaz([...partner.tags, t]);
  };

  return (
    <div className="cari-etiketler">
      {partner.tags.map((t) => (
        <span className="rozet rozet-etiket" key={t}>
          {t}
          {yazabilir && (
            <button className="rozet-sil" disabled={calisiyor}
                    aria-label={`${t} etiketini kaldır`}
                    onClick={() => void yaz(partner.tags.filter((x) => x !== t))}>
              ×
            </button>
          )}
        </span>
      ))}

      {yazabilir && (ekliyor ? (
        <input
          className="etiket-girdi"
          autoFocus
          value={metin}
          placeholder="Etiket adı"
          onChange={(e) => setMetin(e.target.value)}
          onBlur={ekle}
          onKeyDown={(e) => {
            if (e.key === 'Enter') { e.preventDefault(); ekle(); }
            if (e.key === 'Escape') { setMetin(''); setEkliyor(false); }
          }}
        />
      ) : (
        <button className="etiket-ekle" onClick={() => setEkliyor(true)} disabled={calisiyor}>
          <Plus size={13} aria-hidden="true" /> Etiket
        </button>
      ))}
    </div>
  );
}

/* --------------------------------------------------------------------------
   Çip önizlemesi: seçili türün son kayıtları
   ------------------------------------------------------------------------ */
function CipOnizleme({ partnerId, anahtar, paraBirimi, tumunuGor }: {
  partnerId: string; anahtar: string; paraBirimi: string; tumunuGor: () => void;
}) {
  const [satirlar, setSatirlar] = useState<Satir[]>([]);
  const [yukleniyor, setYukleniyor] = useState(true);

  useEffect(() => {
    let iptal = false;
    setYukleniyor(true);
    api.get<{ data: Satir[] }>(`/core/partners/${partnerId}/relations/${anahtar}?limit=4`)
      .then((r) => { if (!iptal) setSatirlar(r.data); })
      .catch(() => { if (!iptal) setSatirlar([]); })
      .finally(() => { if (!iptal) setYukleniyor(false); });
    return () => { iptal = true; };
  }, [partnerId, anahtar]);

  if (yukleniyor) return <div className="cari-onizleme muted">Yükleniyor…</div>;
  if (satirlar.length === 0) {
    return <div className="cari-onizleme muted">Bu türde kayıt yok.</div>;
  }

  return (
    <div className="cari-onizleme">
      {satirlar.map((s, i) => (
        <span className="onizleme-oge" key={String(s.id ?? i)}>
          <span className="num onizleme-no">{ozetBaslik(anahtar, s)}</span>
          {ozetDurum(anahtar, s)}
          {ozetTutar(anahtar, s, paraBirimi)}
        </span>
      ))}
      <button className="onizleme-tumu" onClick={tumunuGor}>Tümünü gör</button>
    </div>
  );
}

/** Önizlemedeki birincil metin: belge numarası ya da kaydın adı. */
function ozetBaslik(anahtar: string, s: Satir): string {
  if (anahtar === 'kisi') return String(s.name ?? '');
  if (anahtar === 'dosya') return String(s.name ?? '');
  if (anahtar === 'firsat') return String(s.name ?? '');
  if (anahtar === 'aktivite') return String(s.subject ?? '');
  if (anahtar === 'servis' || anahtar === 'destek') return String(s.number ?? '');
  return String(s.number ?? 'Taslak');
}

function ozetDurum(anahtar: string, s: Satir) {
  if (s.status === undefined || s.status === null) return null;
  return <StatusBadge status={String(s.status)} />;
}

function ozetTutar(anahtar: string, s: Satir, pb: string) {
  const alan = anahtar === 'tahsilat' ? 'amount'
    : anahtar === 'firsat' ? 'expected_revenue'
    : anahtar === 'servis' ? 'total_cost' : 'total';
  const v = s[alan];
  if (v === undefined || v === null) return null;
  return <span className="onizleme-tutar">{money(v as string, String(s.currency ?? pb))}</span>;
}

/* --------------------------------------------------------------------------
   Zaman tüneli
   --------------------------------------------------------------------------
   SUNUCUDA BİRLEŞTİRİLMİYOR, İSTEMCİDE. Tek bir birleşik uç yazmak, her
   modülün olay şemasını core'un bilmesini gerektirirdi; oysa ilişki kayıtları
   zaten var ve tarihleri taşıyorlar. Sekme açıldığında paralel çekilip
   kronolojik sıraya diziliyorlar -- yalnızca bu sekme açıldığında.
   ------------------------------------------------------------------------ */
interface Olay { zaman: string; tur: string; etiket: string; baslik: string; alt: string | null }

const ZAMAN_ALANI: Record<string, string> = {
  teklif: 'issue_date', siparis: 'order_date', fatura: 'issue_date',
  tahsilat: 'payment_date', satinalma: 'order_date', sevkiyat: 'receipt_date',
  destek: 'created_at', servis: 'reported_at', aktivite: 'created_at',
  firsat: 'updated_at', dosya: 'created_at',
};

function ZamanTuneli({ partnerId, iliskiler }: { partnerId: string; iliskiler: Iliski[] }) {
  const [olaylar, setOlaylar] = useState<Olay[]>([]);
  const [yukleniyor, setYukleniyor] = useState(true);

  useEffect(() => {
    let iptal = false;
    setYukleniyor(true);
    const dolu = iliskiler.filter((i) => i.adet > 0 && ZAMAN_ALANI[i.anahtar]);
    Promise.all(dolu.map(async (i) => {
      try {
        const r = await api.get<{ data: Satir[] }>(
          `/core/partners/${partnerId}/relations/${i.anahtar}?limit=20`);
        return r.data.map((s) => ({
          zaman: String(s[ZAMAN_ALANI[i.anahtar]!] ?? s.created_at ?? ''),
          tur: i.anahtar,
          etiket: i.etiket,
          baslik: ozetBaslik(i.anahtar, s),
          alt: s.status ? String(s.status) : null,
        }));
      } catch { return [] as Olay[]; }
    })).then((gruplar) => {
      if (iptal) return;
      setOlaylar(gruplar.flat()
        .filter((o) => o.zaman)
        .sort((a, b) => b.zaman.localeCompare(a.zaman)));
    }).finally(() => { if (!iptal) setYukleniyor(false); });
    return () => { iptal = true; };
  }, [partnerId, iliskiler]);

  if (yukleniyor) return <Card><span className="muted">Yükleniyor…</span></Card>;
  if (olaylar.length === 0) {
    return (
      <Card>
        <Empty title="Hareket yok">
          Bu cariyle henüz bir belge, tahsilat ya da temas kaydı oluşmadı.
        </Empty>
      </Card>
    );
  }

  return (
    <Card padded={false}>
      <ol className="tunel">
        {olaylar.map((o, i) => {
          const Simge = SIMGE[o.tur] ?? Network;
          return (
            <li className="tunel-oge" key={`${o.tur}-${o.baslik}-${i}`}>
              <span className="tunel-simge"><Simge size={14} aria-hidden="true" /></span>
              <span className="tunel-metin">
                <span className="tunel-ad">
                  <span className="tunel-tur">{o.etiket}</span>
                  <strong>{o.baslik}</strong>
                  {o.alt && <StatusBadge status={o.alt} />}
                </span>
                <span className="tunel-zaman" title={tamZaman(o.zaman)}>
                  {gecenSure(o.zaman)}
                </span>
              </span>
            </li>
          );
        })}
      </ol>
    </Card>
  );
}

/* --------------------------------------------------------------------------
   Genel bilgi
   ------------------------------------------------------------------------ */
function GenelBilgi({ p, ozet, duzenle, alan, yaz, onay, paraBirimi }: {
  p: Partner; ozet: Ozet | null | undefined; duzenle: boolean;
  alan: (k: string) => string | number; yaz: (k: string, v: unknown) => void;
  onay: (k: string) => boolean; paraBirimi: string;
}) {
  return (
    <>
      <div className="cari-kartlar">
        <Card title="İletişim">
          {duzenle ? (
            <div className="form-grid">
              <Field label="E-posta">
                <input type="email" value={String(alan('email'))}
                       onChange={(e) => yaz('email', e.target.value || null)} />
              </Field>
              <Field label="Telefon">
                <input value={String(alan('phone'))}
                       onChange={(e) => yaz('phone', e.target.value || null)} />
              </Field>
              <Field label="Web sitesi">
                <input value={String(alan('website'))}
                       onChange={(e) => yaz('website', e.target.value || null)} />
              </Field>
              <Field label="Şehir">
                <input value={String(alan('city'))}
                       onChange={(e) => yaz('city', e.target.value || null)} />
              </Field>
              <Field label="İlçe">
                <input value={String(alan('district'))}
                       onChange={(e) => yaz('district', e.target.value || null)} />
              </Field>
              <Field label="Adres">
                <textarea rows={2} value={String(alan('address'))}
                          onChange={(e) => yaz('address', e.target.value || null)} />
              </Field>
            </div>
          ) : (
            <dl className="ozellik">
              <Ozellik simge={AtSign} etiket="E-posta">
                {p.email ? <a className="hucre-bag" href={`mailto:${p.email}`}>{p.email}</a> : null}
              </Ozellik>
              <Ozellik simge={Phone} etiket="Telefon">
                {p.phone
                  ? <a className="hucre-bag num" href={`tel:${p.phone.replace(/\s/g, '')}`}>{p.phone}</a>
                  : null}
              </Ozellik>
              <Ozellik simge={MapPin} etiket="Şehir / İlçe">
                {[p.city, p.district].filter(Boolean).join(' / ') || null}
              </Ozellik>
            </dl>
          )}
        </Card>

        <Card title="Vergi Bilgileri">
          {duzenle ? (
            <div className="form-grid">
              <Field label="Vergi no / TCKN" hint="10 hane VKN ya da 11 hane TCKN">
                <input value={String(alan('tax_no'))}
                       onChange={(e) => yaz('tax_no', e.target.value || null)} />
              </Field>
              <Field label="Vergi dairesi">
                <input value={String(alan('tax_office'))}
                       onChange={(e) => yaz('tax_office', e.target.value || null)} />
              </Field>
              <Field label="Tanımlanmış iskonto oranı (%)"
                     hint="Teklif/sipariş/faturada otomatik düşer">
                <input type="number" min={0} max={100} step="0.01"
                       value={String(alan('discount_pct'))}
                       onChange={(e) => yaz('discount_pct', e.target.value === '' ? null : e.target.value)} />
              </Field>
            </div>
          ) : (
            <>
              <div className="ozellik ozellik-ikili">
                <Ozellik simge={Hash} etiket="Vergi No">
                  {p.tax_no ? (
                    <span className="row">
                      <span className="num">{p.tax_no}</span>
                      {/* NULL "numara yok", false "numara yanlış". */}
                      {ozet?.tax_no_valid === false && (
                        <span className="rozet rozet-tehlike">Geçersiz</span>
                      )}
                      {ozet?.tax_no_valid === true && (
                        <span className="rozet rozet-ok">Doğrulandı</span>
                      )}
                    </span>
                  ) : null}
                </Ozellik>
                <Ozellik simge={Landmark} etiket="Vergi Dairesi">{p.tax_office}</Ozellik>
              </div>
              <div className="ozellik-ayrac" />
              <Ozellik simge={Percent} etiket="Tanımlanmış İskonto Oranı"
                       ipucu="Teklif/sipariş/faturada otomatik düşer" genis>
                {p.discount_pct ? `%${num(p.discount_pct, 2)}` : null}
              </Ozellik>
            </>
          )}
        </Card>

        <Card title="B2B &amp; Ticari">
          {duzenle ? (
            <div className="form-grid">
              <Field label="Sektör">
                <input value={String(alan('sector'))}
                       onChange={(e) => yaz('sector', e.target.value || null)} />
              </Field>
              <Field label="Vade (gün)">
                <input type="number" min={0} value={String(alan('payment_term_days'))}
                       onChange={(e) => yaz('payment_term_days', Number(e.target.value) || 0)} />
              </Field>
              <Field label="Kredi limiti">
                <input type="number" min={0} step="0.01" value={String(alan('credit_limit'))}
                       onChange={(e) => yaz('credit_limit', e.target.value === '' ? null : e.target.value)} />
              </Field>
              <Field label="IBAN">
                <input value={String(alan('iban'))}
                       onChange={(e) => yaz('iban', e.target.value || null)} />
              </Field>
              <Field label="Para birimi" hint="Teklif ve faturada ön değer">
                <input value={String(alan('currency'))} maxLength={3}
                       style={{ textTransform: 'uppercase' }}
                       onChange={(e) => yaz('currency', e.target.value.toUpperCase() || 'TRY')} />
              </Field>
            </div>
          ) : (
            <dl className="ozellik">
              <Ozellik simge={Building2} etiket="Sektör">{p.sector}</Ozellik>
              <Ozellik simge={CalendarClock} etiket="Vade (Gün)">
                {p.payment_term_days > 0 ? num(p.payment_term_days, 0) : null}
              </Ozellik>
              <Ozellik simge={CreditCard} etiket="Kredi Limiti">
                {p.credit_limit ? money(p.credit_limit, paraBirimi) : null}
              </Ozellik>
              <Ozellik simge={Banknote} etiket="IBAN">
                {p.iban ? <span className="num">{p.iban}</span> : null}
              </Ozellik>
              <Ozellik simge={Coins} etiket="Para Birimi">
                {p.currency ?? 'TRY'}
              </Ozellik>
            </dl>
          )}

          {/* İYS izni KANAL BAZINDA: 6563 sayılı kanun izni kanal kanal arar.
              Tek bayrak olsaydı SMS'e izin veren müşteriye e-posta giderdi. */}
          <div className="ozellik-ayrac" />
          <div className="ozellik-satir">
            <dt><Phone size={14} aria-hidden="true" /><span>İYS Pazarlama İzni</span></dt>
            <dd>
              <div className="iys">
                {([
                  ['consent_sms', 'SMS'],
                  ['consent_email', 'E-posta'],
                  ['consent_whatsapp', 'WhatsApp'],
                ] as const).map(([k, ad]) => (
                  <label className="onay-satir" key={k}>
                    <input type="checkbox" disabled={!duzenle}
                           checked={duzenle ? onay(k) : Boolean(p[k])}
                           onChange={(e) => yaz(k, e.target.checked)} />
                    {ad}
                  </label>
                ))}
              </div>
              <p className="muted micro iys-not">
                {p.consent_at
                  ? `İzin ${date(p.consent_at)} tarihinde alındı.`
                  : 'İzin tarihi kayıtlı değil.'}
              </p>
            </dd>
          </div>
        </Card>

        <Card title="Temsilci">
          <dl className="ozellik">
            <Ozellik simge={UserRound} etiket="Sorumlu">
              {p.owner_name ?? <span className="atanmadi">Atanmadı</span>}
            </Ozellik>
            <Ozellik simge={Building2} etiket="Şube">{p.branch_name}</Ozellik>
          </dl>
        </Card>

        <Card title="Sistem">
          <dl className="ozellik">
            <Ozellik simge={CalendarClock} etiket="Oluşturma">
              <span className="num">{tamZaman(p.created_at)}</span>
            </Ozellik>
            <Ozellik simge={CalendarClock} etiket="Güncelleme">
              <span className="num">{tamZaman(p.updated_at)}</span>
            </Ozellik>
            <Ozellik simge={Hash} etiket="ID">
              <span className="num micro">{p.id}</span>
            </Ozellik>
          </dl>
        </Card>
      </div>

      <Card title="Notlar">
        {duzenle ? (
          <textarea rows={4} value={String(alan('notes'))}
                    onChange={(e) => yaz('notes', e.target.value || null)} />
        ) : (
          p.notes ? <p className="cari-not">{p.notes}</p> : <span className="muted">Not yok.</span>
        )}
      </Card>
    </>
  );
}

/**
 * Etiket-değer satırı.
 *
 * ETİKET ÜSTTE, DEĞER ALTTA: uzun alan adları (İYS Pazarlama İzni, Tanımlanmış
 * İskonto Oranı) yan yana düzende değeri sıkıştırıyordu. Yığılmış düzen dar
 * kartta da bozulmaz.
 *
 * BOŞ DEĞER TİRE İLE geçilir, satır gizlenmez: alanın var olduğunu ama
 * doldurulmadığını göstermek, alanı yok saymaktan farklıdır.
 */
function Ozellik({ simge: Simge, etiket, ipucu, genis, children }: {
  simge: LucideIcon; etiket: string; ipucu?: string; genis?: boolean;
  children: React.ReactNode;
}) {
  return (
    <div className={`ozellik-satir${genis ? ' genis' : ''}`}>
      <dt>
        <Simge size={14} aria-hidden="true" />
        <span>{etiket}</span>
      </dt>
      {ipucu && <span className="ozellik-ipucu">{ipucu}</span>}
      <dd>{children ?? <span className="muted">—</span>}</dd>
    </div>
  );
}

/* --------------------------------------------------------------------------
   İlişki sekmesi
   ------------------------------------------------------------------------ */
function IliskiSekmesi({ partnerId, anahtar, paraBirimi }: {
  partnerId: string; anahtar: string; paraBirimi: string;
}) {
  const [satirlar, setSatirlar] = useState<Satir[]>([]);
  const [yukleniyor, setYukleniyor] = useState(true);
  const [hata, setHata] = useState<unknown>(null);

  useEffect(() => {
    let iptal = false;
    setYukleniyor(true); setHata(null);
    api.get<{ data: Satir[] }>(`/core/partners/${partnerId}/relations/${anahtar}`)
      .then((r) => { if (!iptal) setSatirlar(r.data); })
      .catch((e) => { if (!iptal) setHata(e); })
      .finally(() => { if (!iptal) setYukleniyor(false); });
    return () => { iptal = true; };
  }, [partnerId, anahtar]);

  const kolonlar = KOLONLAR[anahtar] ?? [];

  return (
    <Card padded={false}>
      <ErrorBox error={hata} />
      <TableScroll label={`${anahtar} listesi`}>
        <table className="tbl">
          <thead>
            <tr>{kolonlar.map((k) => (
              <th key={k.ad} className={k.sag ? 'r' : undefined}>{k.ad}</th>
            ))}</tr>
          </thead>
          <tbody>
            {satirlar.map((s, i) => (
              <tr key={String(s.id ?? i)}>
                {kolonlar.map((k) => (
                  <td key={k.ad} className={k.sag ? 'r' : undefined}>{k.ciz(s, paraBirimi)}</td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </TableScroll>
      {!yukleniyor && satirlar.length === 0 && (
        <Empty title="Kayıt yok">Bu cariyle ilişkili kayıt bulunmuyor.</Empty>
      )}
    </Card>
  );
}

interface RelKolon {
  ad: string; sag?: boolean;
  ciz(s: Satir, pb: string): React.ReactNode;
}

const metin = (v: unknown) => (v === null || v === undefined || v === ''
  ? <span className="muted">—</span> : String(v));
const belgeNo = (v: unknown) => (v
  ? <span className="num badge-code">{String(v)}</span>
  : <span className="badge">Taslak</span>);

/**
 * Sözlükten Türkçe karşılık.
 *
 * Veritabanı durumları İngilizce enum tutuyor. Arayüzün geri kalanı
 * Türkçeyken ham enum basmak, tablonun tek yerinde yabancı bir kelime
 * bırakır. Karşılığı olmayan değer ham hâliyle geçer.
 */
const sozluk = (harita: Record<string, string>) => (v: unknown) => {
  const ham = String(v ?? '');
  if (!ham) return <span className="muted">—</span>;
  return harita[ham] ?? ham;
};

const DESTEK_DURUM: Record<string, string> = {
  new: 'Yeni', open: 'Açık', pending_customer: 'Müşteri bekleniyor',
  resolved: 'Çözüldü', closed: 'Kapandı', cancelled: 'İptal',
};
const AKTIVITE_TUR: Record<string, string> = {
  call: 'Telefon', meeting: 'Toplantı', email: 'E-posta',
  task: 'Görev', note: 'Not', visit: 'Ziyaret',
};
const SERVIS_TUR: Record<string, string> = {
  preventive: 'Periyodik', corrective: 'Arıza', inspection: 'Kontrol',
};
/** Çek/senet durumları -- adlar Notes ekranındaki sözlükten türer. */
const NOTE_DURUM_ADI: Record<string, string> = Object.fromEntries(
  Object.entries(NOTE_DURUM).map(([k, v]) => [k, v.ad]));

/** Dosya boyutu: bayt sayısı okunmaz, KB/MB okunur. */
function boyut(bayt: unknown): string {
  const n = Number(bayt ?? 0);
  if (!n) return '—';
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${num(n / 1024, 0)} KB`;
  return `${num(n / (1024 * 1024), 1)} MB`;
}

const KOLONLAR: Record<string, RelKolon[]> = {
  firsat: [
    { ad: 'Fırsat', ciz: (s) => <strong>{String(s.name)}</strong> },
    { ad: 'Aşama', ciz: (s) => metin(s.stage_name) },
    { ad: 'Durum', ciz: (s) => <StatusBadge status={String(s.status)} /> },
    { ad: 'Beklenen ciro', sag: true, ciz: (s, pb) => money(s.expected_revenue as string, String(s.currency ?? pb)) },
    { ad: 'Kapanış', ciz: (s) => date(s.expected_close_date as string) },
    { ad: 'Sahibi', ciz: (s) => metin(s.owner_name) },
  ],
  teklif: [
    { ad: 'No', ciz: (s) => belgeNo(s.number) },
    { ad: 'Tarih', ciz: (s) => date(s.issue_date as string) },
    { ad: 'Geçerlilik', ciz: (s) => date(s.valid_until as string) },
    { ad: 'Durum', ciz: (s) => <StatusBadge status={String(s.status)} /> },
    { ad: 'Kalem', sag: true, ciz: (s) => sayi(s.line_count as string) },
    { ad: 'Tutar', sag: true, ciz: (s, pb) => <strong>{money(s.total as string, String(s.currency ?? pb))}</strong> },
  ],
  siparis: [
    { ad: 'No', ciz: (s) => belgeNo(s.number) },
    { ad: 'Tarih', ciz: (s) => date(s.order_date as string) },
    { ad: 'Teslim', ciz: (s) => date(s.delivery_date as string) },
    { ad: 'Durum', ciz: (s) => <StatusBadge status={String(s.status)} /> },
    { ad: 'Kalem', sag: true, ciz: (s) => sayi(s.line_count as string) },
    { ad: 'Tutar', sag: true, ciz: (s, pb) => <strong>{money(s.total as string, String(s.currency ?? pb))}</strong> },
  ],
  fatura: [
    { ad: 'No', ciz: (s) => belgeNo(s.number) },
    { ad: 'Tür', ciz: (s) => (s.kind === 'sale' ? 'Satış' : 'Alış') },
    { ad: 'Tarih', ciz: (s) => date(s.issue_date as string) },
    { ad: 'Vade', ciz: (s) => date(s.due_date as string) },
    { ad: 'Durum', ciz: (s) => <StatusBadge status={String(s.status)} /> },
    { ad: 'Tutar', sag: true, ciz: (s, pb) => money(s.total as string, String(s.currency ?? pb)) },
    {
      ad: 'Kalan', sag: true,
      ciz: (s, pb) => (Number(s.balance_due) > 0
        ? <strong>{money(s.balance_due as string, String(s.currency ?? pb))}</strong>
        : <span className="muted">—</span>),
    },
  ],
  tahsilat: [
    { ad: 'No', ciz: (s) => belgeNo(s.number) },
    { ad: 'Tarih', ciz: (s) => date(s.payment_date as string) },
    {
      ad: 'Yön',
      ciz: (s) => (s.direction === 'in'
        ? <span className="badge badge-ok">Tahsilat</span>
        : <span className="badge badge-warn">Ödeme</span>),
    },
    { ad: 'Yöntem', ciz: (s) => metin(s.method) },
    { ad: 'Tutar', sag: true, ciz: (s, pb) => <strong>{money(s.amount as string, String(s.currency ?? pb))}</strong> },
    { ad: 'Mahsup', sag: true, ciz: (s, pb) => money(s.allocated_total as string, String(s.currency ?? pb)) },
  ],
  satinalma: [
    { ad: 'No', ciz: (s) => belgeNo(s.number) },
    { ad: 'Tarih', ciz: (s) => date(s.order_date as string) },
    { ad: 'Söz verilen', ciz: (s) => date(s.promised_date as string) },
    { ad: 'Durum', ciz: (s) => <StatusBadge status={String(s.status)} /> },
    { ad: 'Teslim', sag: true, ciz: (s) => `%${num(Number(s.received_pct ?? 0), 0)}` },
    { ad: 'Tutar', sag: true, ciz: (s, pb) => <strong>{money(s.total as string, String(s.currency ?? pb))}</strong> },
  ],
  sevkiyat: [
    { ad: 'No', ciz: (s) => belgeNo(s.number) },
    { ad: 'İrsaliye', ciz: (s) => metin(s.waybill_no) },
    { ad: 'Tarih', ciz: (s) => date(s.receipt_date as string) },
    { ad: 'Sipariş', ciz: (s) => metin(s.order_number) },
    { ad: 'Durum', ciz: (s) => <StatusBadge status={String(s.status)} /> },
    { ad: 'Miktar', sag: true, ciz: (s) => sayi(s.total_quantity as string) },
    {
      ad: 'Ret', sag: true,
      // RET MİKTARI SIFIRSA TİRE: sıfır yazmak, ret olduğunu ama miktarının
      // sıfır olduğunu düşündürür.
      ciz: (s) => (Number(s.rejected_quantity) > 0
        ? <span className="badge badge-danger">{sayi(s.rejected_quantity as string)}</span>
        : <span className="muted">—</span>),
    },
  ],
  destek: [
    { ad: 'No', ciz: (s) => belgeNo(s.number) },
    { ad: 'Konu', ciz: (s) => <strong>{String(s.subject)}</strong> },
    { ad: 'Durum', ciz: (s) => sozluk(DESTEK_DURUM)(s.status) },
    {
      ad: 'SLA',
      ciz: (s) => (s.resolution_breached
        ? <span className="badge badge-danger">Aşıldı</span>
        : <span className="badge badge-ok">İçinde</span>),
    },
    { ad: 'Sorumlu', ciz: (s) => metin(s.assignee_name) },
    { ad: 'Açılma', sag: true, ciz: (s) => gecenSure(s.created_at as string) },
  ],
  servis: [
    { ad: 'No', ciz: (s) => belgeNo(s.number) },
    { ad: 'Konu', ciz: (s) => <strong>{String(s.title)}</strong> },
    { ad: 'Ekipman', ciz: (s) => metin(s.equipment_name) },
    { ad: 'Tür', ciz: (s) => sozluk(SERVIS_TUR)(s.kind) },
    { ad: 'Durum', ciz: (s) => <StatusBadge status={String(s.status)} /> },
    { ad: 'Maliyet', sag: true, ciz: (s, pb) => money(s.total_cost as string, pb) },
  ],
  aktivite: [
    { ad: 'Tür', ciz: (s) => sozluk(AKTIVITE_TUR)(s.kind) },
    { ad: 'Konu', ciz: (s) => <strong>{String(s.subject)}</strong> },
    { ad: 'Vade', ciz: (s) => date(s.due_at as string) },
    {
      ad: 'Durum',
      ciz: (s) => (s.done_at
        ? <span className="badge badge-ok">Tamamlandı</span>
        : <span className="badge badge-warn">Açık</span>),
    },
    { ad: 'Sonuç', ciz: (s) => metin(s.outcome) },
  ],
  kisi: [
    { ad: 'Ad', ciz: (s) => <strong>{String(s.name)}</strong> },
    { ad: 'Unvan', ciz: (s) => metin(s.title) },
    {
      ad: 'E-posta',
      ciz: (s) => (s.email
        ? <a className="hucre-bag" href={`mailto:${String(s.email)}`}>{String(s.email)}</a>
        : <span className="muted">—</span>),
    },
    {
      ad: 'Telefon',
      ciz: (s) => (s.phone
        ? <a className="hucre-bag num" href={`tel:${String(s.phone).replace(/\s/g, '')}`}>{String(s.phone)}</a>
        : <span className="muted">—</span>),
    },
    {
      ad: 'Birincil',
      ciz: (s) => (s.is_primary
        ? <span className="badge badge-info">Birincil</span>
        : <span className="muted">—</span>),
    },
  ],
  cek: [
    { ad: 'No', ciz: (s) => belgeNo(s.number) },
    { ad: 'Tür', ciz: (s) => (s.kind === 'cek' ? 'Çek' : 'Senet') },
    {
      ad: 'Yön',
      ciz: (s) => (s.direction === 'in'
        ? <span className="badge badge-ok">Alınan</span>
        : <span className="badge badge-warn">Verilen</span>),
    },
    { ad: 'Banka', ciz: (s) => metin(s.bank_name) },
    { ad: 'Vade', ciz: (s) => (s.vadesi_gecti
      ? <span className="badge badge-danger">{date(s.due_date as string)} · geçti</span>
      : date(s.due_date as string)) },
    { ad: 'Durum', ciz: (s) => sozluk(NOTE_DURUM_ADI)(s.status) },
    { ad: 'Tutar', sag: true, ciz: (s, pb) => <strong>{money(s.amount as string, String(s.currency ?? pb))}</strong> },
  ],
  dosya: [
    { ad: 'Dosya', ciz: (s) => <strong>{String(s.name)}</strong> },
    { ad: 'Tür', ciz: (s) => <span className="muted num">{String(s.mime_type ?? '—')}</span> },
    { ad: 'Boyut', sag: true, ciz: (s) => boyut(s.size_bytes) },
    { ad: 'Yükleyen', ciz: (s) => metin(s.owner_name) },
    { ad: 'Tarih', sag: true, ciz: (s) => gecenSure(s.created_at as string) },
  ],
};
