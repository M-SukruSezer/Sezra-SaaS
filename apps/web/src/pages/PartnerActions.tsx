import { useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  ArrowRight, Banknote, Copy, FileText, MapPin, Merge, MessageSquare, Pencil,
  Receipt, ShoppingCart, Star, Trash2, Truck, UserPlus, X,
} from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import { api } from '../api/client';
import { useSession } from '../api/session';
import { ErrorBox, Field } from '../ui';
import { date } from '../i18n';

/* ===========================================================================
   Cari aksiyonları
   ===========================================================================
   Sağdan açılan bir panel. Kartın üstüne bir açılır menü koymak, on iki
   satırlık bir listeyi başlığın altına sıkıştırmak olurdu; panel hem yer
   verir hem her satıra bir AÇIKLAMA yazacak alan bırakır.

   HER SATIR GERÇEKTEN ÇALIŞIR. "Yakında" diye duran bir eylem, paneli açan
   kişiye çalışmayan bir söz verir ve bir kez tıklandıktan sonra panelin
   tamamına olan güveni bitirir. Karşılığı olmayan eylem hiç çizilmez.
   ========================================================================= */

interface Partner {
  id: string; name: string; code: string | null;
  is_customer: boolean; is_supplier: boolean; is_active: boolean;
  email: string | null; phone: string | null;
  address: string | null; district: string | null; city: string | null;
  postal_code: string | null; tax_no: string | null; tax_office: string | null;
  consent_sms: boolean;
}

interface Eylem {
  anahtar: string;
  ad: string;
  aciklama?: string;
  simge: LucideIcon;
  grup: 'olustur' | 'gonder' | 'belge' | 'yonet';
  gorunur: boolean;
  calistir(): void | Promise<void>;
}

const GRUP_ADI: Record<Eylem['grup'], string> = {
  olustur: 'Oluştur', gonder: 'Gönder', belge: 'Belge', yonet: 'Yönet',
};

export function PartnerActions({ partner, kapat, yenile, duzenlemeyiAc }: {
  partner: Partner;
  kapat: () => void;
  yenile: () => Promise<void>;
  duzenlemeyiAc: () => void;
}) {
  const nav = useNavigate();
  const { can, me } = useSession();
  const [hata, setHata] = useState<unknown>(null);
  const [calisan, setCalisan] = useState<string | null>(null);
  const [birlestir, setBirlestir] = useState(false);
  const [sms, setSms] = useState(false);
  const [portal, setPortal] = useState(false);
  const [silOnay, setSilOnay] = useState(false);
  const panelRef = useRef<HTMLDivElement>(null);
  const kapatRef = useRef<HTMLButtonElement>(null);

  // Panel açıldığında odak içeri alınır ve Escape ile çıkılır: klavyeyle
  // gelen kullanıcı, açılan katmanın içine düşmeli ve çıkabilmeli.
  useEffect(() => {
    kapatRef.current?.focus();
    const esc = (e: KeyboardEvent) => { if (e.key === 'Escape') kapat(); };
    window.addEventListener('keydown', esc);
    return () => window.removeEventListener('keydown', esc);
  }, [kapat]);

  const yazabilir = can('core.partner.write.all');

  /**
   * Belge taslağı açar.
   *
   * ÖNCE KAYIT, SONRA GEZİNME: boş bir "yeni belge" ekranına gidip cariyi
   * orada seçtirmek, kullanıcının zaten verdiği bilgiyi ikinci kez sormaktır.
   * Taslak bu cariyle açılır ve doğrudan detayına gidilir.
   */
  const taslakAc = async (
    anahtar: string, yol: string, uc: string, govde: Record<string, unknown>,
  ) => {
    setCalisan(anahtar); setHata(null);
    try {
      const res = await api.post<{ data: { id: string } }>(uc, govde);
      kapat();
      nav(`${yol}/${res.data.id}`);
    } catch (err) { setHata(err); } finally { setCalisan(null); }
  };

  const bugun = new Date().toISOString().slice(0, 10);
  const paraBirimi = me?.tenant?.currency ?? 'TRY';

  const eylemler: Eylem[] = useMemo(() => [
    {
      anahtar: 'teklif', ad: 'Yeni Teklif', simge: FileText, grup: 'olustur',
      aciklama: 'Bu cariye taslak teklif açar',
      gorunur: can('crm.quotation.create'),
      calistir: () => taslakAc('teklif', '/crm/quotations', '/crm/quotations', {
        partner_id: partner.id, issue_date: bugun, currency: paraBirimi,
      }),
    },
    {
      anahtar: 'siparis', ad: 'Yeni Sipariş', simge: ShoppingCart, grup: 'olustur',
      aciklama: 'Bu cariye taslak satış siparişi açar',
      gorunur: can('crm.order.create'),
      calistir: () => taslakAc('siparis', '/crm/orders', '/crm/sale-orders', {
        partner_id: partner.id, order_date: bugun, currency: paraBirimi,
      }),
    },
    {
      anahtar: 'fatura', ad: 'Yeni Fatura', simge: Receipt, grup: 'olustur',
      aciklama: 'Bu cariye taslak satış faturası keser',
      gorunur: can('finance.invoice.create'),
      calistir: () => taslakAc('fatura', '/finance/sales', '/finance/invoices', {
        kind: 'sale', partner_id: partner.id, issue_date: bugun, currency: paraBirimi,
      }),
    },
    {
      anahtar: 'firsat', ad: 'Yeni Fırsat', simge: Star, grup: 'olustur',
      aciklama: 'Cari seçili olarak fırsat formunu açar',
      gorunur: can('crm.lead.create'),
      calistir: () => { kapat(); nav(`/crm/leads/yeni?cari=${partner.id}`); },
    },
    {
      anahtar: 'satinalma', ad: 'Alış Yap (Satın Alma)', simge: Truck, grup: 'olustur',
      aciklama: 'Bu firmadan ürün/hizmet almak için talep açar',
      gorunur: can('purchasing.requisition.create') && partner.is_supplier,
      calistir: () => taslakAc('satinalma', '/purchasing/requisitions',
        '/purchasing/requisitions', {
          suggested_partner_id: partner.id, request_date: bugun, currency: paraBirimi,
        }),
    },
    {
      anahtar: 'senet', ad: 'Tedarikçiye Senet Ver', simge: Banknote, grup: 'olustur',
      aciklama: 'Verilen çek/senet kaydını bu firma seçili açar',
      // YALNIZCA TEDARİKÇİDE: müşteriye senet vermek olağan değil ve eylemi
      // her caride göstermek, listeyi anlamsız uzatırdı.
      gorunur: can('finance.note.create') && partner.is_supplier,
      calistir: () => { kapat(); nav(`/finance/notes-out?cari=${partner.id}`); },
    },
    {
      anahtar: 'sms', ad: 'SMS Gönder', simge: MessageSquare, grup: 'gonder',
      aciklama: partner.consent_sms
        ? 'Firmanın cep telefonuna kısa mesaj at'
        : 'İYS ticari ileti izni yok — yalnızca bilgilendirme gönderilebilir',
      // NUMARASIZ CARİDE GÖSTERİLMEZ: gönderilemeyecek bir eylem sunmak,
      // kullanıcıyı bir hata mesajına götürmekten başka işe yaramaz.
      gorunur: can('core.sms.send') && Boolean(partner.phone),
      calistir: () => setSms(true),
    },
    {
      anahtar: 'portal', ad: 'Portala Davet Et', simge: UserPlus, grup: 'gonder',
      aciklama: 'Firma kendi faturalarını ve tekliflerini görebilsin',
      gorunur: can('core.portal.invite'),
      calistir: () => setPortal(true),
    },
    {
      anahtar: 'etiket', ad: 'Adres Etiketi Yazdır', simge: MapPin, grup: 'belge',
      aciklama: 'Zarf / koli için adres etiketi — yazıcıya gönderir',
      // ADRESSİZ CARİDE GÖSTERİLMEZ: boş bir etiket basmak kâğıt israfıdır.
      gorunur: Boolean(partner.address || partner.city),
      calistir: () => { setCalisan('etiket'); yazdir(partner); setCalisan(null); },
    },
    {
      anahtar: 'duzenle', ad: 'Düzenle', simge: Pencil, grup: 'yonet',
      aciklama: 'Kart alanlarını düzenlemeye açar',
      gorunur: yazabilir,
      calistir: () => { kapat(); duzenlemeyiAc(); },
    },
    {
      anahtar: 'birlestir', ad: 'Mükerrer Firmayı Buna Birleştir', simge: Merge, grup: 'yonet',
      aciklama: 'Diğer kaydın belgeleri buraya taşınır, o kayıt pasife alınır',
      gorunur: yazabilir,
      calistir: () => setBirlestir(true),
    },
  ], [partner, yazabilir, bugun, paraBirimi]); // eslint-disable-line react-hooks/exhaustive-deps

  const gorunurler = eylemler.filter((e) => e.gorunur);
  const gruplar: Eylem['grup'][] = ['olustur', 'gonder', 'belge', 'yonet'];

  return (
    <div className="cekmece-ortu" onMouseDown={(e) => { if (e.target === e.currentTarget) kapat(); }}>
      <div className="cekmece" role="dialog" aria-modal="true" aria-label="Aksiyonlar"
           ref={panelRef}>
        <div className="cekmece-bas">
          <div>
            <h2 className="cekmece-baslik">Aksiyonlar</h2>
            <p className="cekmece-alt">{partner.name}</p>
          </div>
          <button className="icon-btn" onClick={kapat} aria-label="Paneli kapat" ref={kapatRef}>
            <X size={18} />
          </button>
        </div>

        <div className="cekmece-govde">
          <ErrorBox error={hata} />

          {portal ? (
            <PortalFormu
              partner={partner}
              vazgec={() => setPortal(false)}
              setHata={setHata}
            />
          ) : sms ? (
            <SmsFormu
              partner={partner}
              vazgec={() => setSms(false)}
              bitti={() => setSms(false)}
              setHata={setHata}
            />
          ) : birlestir ? (
            <BirlestirmeFormu
              hedef={partner}
              vazgec={() => setBirlestir(false)}
              bitti={async () => { setBirlestir(false); kapat(); await yenile(); }}
              setHata={setHata}
            />
          ) : (
            <>
              {gruplar.map((g) => {
                const grupEylemleri = gorunurler.filter((e) => e.grup === g);
                if (grupEylemleri.length === 0) return null;
                return (
                  <section className="cekmece-grup" key={g}>
                    <h3 className="cekmece-grup-ad">{GRUP_ADI[g]}</h3>
                    <ul className="eylem-liste">
                      {grupEylemleri.map((e) => (
                        <li key={e.anahtar}>
                          <button
                            className="eylem"
                            disabled={calisan !== null}
                            aria-busy={calisan === e.anahtar}
                            onClick={() => void e.calistir()}
                          >
                            <span className="eylem-simge"><e.simge size={16} aria-hidden="true" /></span>
                            <span className="eylem-metin">
                              <span className="eylem-ad">{e.ad}</span>
                              {e.aciklama && <span className="eylem-aciklama">{e.aciklama}</span>}
                            </span>
                            <ArrowRight size={15} className="eylem-ok" aria-hidden="true" />
                          </button>
                        </li>
                      ))}
                    </ul>
                  </section>
                );
              })}
            </>
          )}
        </div>

        {/* Silme panelin DİBİNDE ve ayrı: yıkıcı eylem, sıradan eylemlerin
            arasında durduğunda yanlışlıkla tıklanır. */}
        {!birlestir && !sms && !portal && can('core.partner.delete.all') && (
          <div className="cekmece-dip">
            {silOnay ? (
              <div className="cekmece-sil-onay">
                <strong>Bu cari kalıcı olarak silinecek.</strong>
                <span>
                  Belgesi olan bir cari silinemez; o durumda “Pasife al” kullanın.
                </span>
                <div className="row">
                  <button className="btn btn-sm" onClick={() => setSilOnay(false)}>Vazgeç</button>
                  <button className="btn btn-sm btn-danger" disabled={calisan === 'sil'}
                          aria-busy={calisan === 'sil'}
                          onClick={async () => {
                            setCalisan('sil'); setHata(null);
                            try {
                              await api.delete(`/core/partners/${partner.id}`);
                              kapat(); nav('/partners');
                            } catch (err) {
                              // Sunucu "bağlı kayıt var" durumunu artık kendi
                              // cümlesiyle söylüyor; burada yeniden yazmak
                              // iki ayrı metin bakımı demek olurdu.
                              setHata(err);
                              setSilOnay(false);
                            } finally { setCalisan(null); }
                          }}>
                    Evet, sil
                  </button>
                </div>
              </div>
            ) : (
              <button className="cekmece-sil" onClick={() => setSilOnay(true)}>
                <Trash2 size={14} aria-hidden="true" /> Firmayı Sil
              </button>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

/* --------------------------------------------------------------------------
   Portal daveti
   ------------------------------------------------------------------------ */
/** Davet satırının sunucudan gelen hâli. Jeton YOK: sunucu da saklamıyor. */
interface Davet {
  id: string;
  email: string;
  expires_at: string;
  accepted_at: string | null;
  revoked_at: string | null;
  status: 'pending' | 'accepted' | 'revoked' | 'expired';
}

const DURUM_ADI: Record<Davet['status'], string> = {
  pending:  'Bekliyor',
  accepted: 'Kabul edildi',
  revoked:  'İptal edildi',
  expired:  'Süresi doldu',
};

/**
 * Satırda gösterilecek tarih, DURUMA GÖRE değişir.
 *
 * Her satırda son kullanma tarihini göstermek yanlış okunuyordu: kabul
 * edilmiş bir davetin yanında gelecek bir tarih durunca satır "20.09'da kabul
 * edildi" gibi okunuyor -- oysa o tarih davetin artık geçersiz olan son
 * kullanma tarihi. Her durumun kendi tarihi var; gösterilecek olan odur.
 */
function davetTarihi(d: Davet): string {
  if (d.status === 'accepted' && d.accepted_at) return `Kabul: ${date(d.accepted_at)}`;
  if (d.status === 'revoked' && d.revoked_at)   return `İptal: ${date(d.revoked_at)}`;
  if (d.status === 'expired')                   return `Doldu: ${date(d.expires_at)}`;
  return `Son gün: ${date(d.expires_at)}`;
}

/**
 * Portala davet formu.
 *
 * BAĞLANTI YALNIZCA BİR KEZ GÖSTERİLİR. Sunucu jetonun sha256 özetini
 * saklıyor, kendisini değil; panel kapandıktan sonra aynı bağlantıyı bir daha
 * kimse -- biz de dahil -- üretemez. Bunu kullanıcıya söylemek şart, yoksa
 * "sonra kopyalarım" deyip kapatır ve daveti baştan oluşturmak zorunda kalır.
 */
function PortalFormu({ partner, vazgec, setHata }: {
  partner: Partner; vazgec: () => void; setHata: (e: unknown) => void;
}) {
  const [eposta, setEposta] = useState('');
  const [gun, setGun] = useState(14);
  const [calisiyor, setCalisiyor] = useState(false);
  const [bag, setBag] = useState<string | null>(null);
  const [kopyalandi, setKopyalandi] = useState(false);
  const [davetler, setDavetler] = useState<Davet[]>([]);

  const uc = `/core/partners/${partner.id}/portal-invitations`;

  const yenile = async () => {
    try {
      const r = await api.get<{ data: Davet[] }>(uc);
      setDavetler(r.data);
    } catch { setDavetler([]); }
  };

  useEffect(() => { void yenile(); }, [partner.id]); // eslint-disable-line react-hooks/exhaustive-deps

  const olustur = async () => {
    setCalisiyor(true); setHata(null); setKopyalandi(false);
    try {
      const r = await api.post<{ data: { token: string } }>(uc, {
        email: eposta.trim(), days: gun,
      });
      // BAĞLANTIYI İSTEMCİ KURAR: portal adresi dağıtıma göre değişir ve
      // sunucuda sabitlenmiş yanlış bir alan adı sessizce çalışmayan bir
      // davet üretirdi.
      setBag(`${window.location.origin}/portal/davet/${r.data.token}`);
      setEposta('');
      await yenile();
    } catch (err) { setHata(err); } finally { setCalisiyor(false); }
  };

  const iptalEt = async (id: string) => {
    setHata(null);
    try {
      await api.post(`/core/portal/invitations/${id}/revoke`, {});
      await yenile();
    } catch (err) { setHata(err); }
  };

  const kopyala = async () => {
    if (!bag) return;
    try {
      await navigator.clipboard.writeText(bag);
      setKopyalandi(true);
      window.setTimeout(() => setKopyalandi(false), 2000);
    } catch { /* pano kapalıysa kullanıcı metni elle seçebilir */ }
  };

  return (
    <section className="cekmece-grup">
      <h3 className="cekmece-grup-ad">Portala davet et</h3>
      <p className="birlestir-not">
        <strong>{partner.name}</strong> kendi faturalarını, tekliflerini ve
        siparişlerini görebilir. Portal kullanıcısı <strong>hiçbir şey
        yazamaz</strong>; personel ekranlarına ve diğer carilere erişemez.
      </p>

      {bag ? (
        <div className="davet-bag">
          <p className="davet-bag-not">
            Bağlantı bir daha gösterilemez. Kopyalayıp firmaya iletin; kaybolursa
            daveti iptal edip yenisini oluşturun.
          </p>
          <div className="davet-bag-satir">
            <input readOnly value={bag} aria-label="Davet bağlantısı"
                   onFocus={(e) => e.currentTarget.select()} />
            <button className="btn btn-sm" onClick={() => void kopyala()}>
              <Copy size={14} aria-hidden="true" />
              {kopyalandi ? 'Kopyalandı' : 'Kopyala'}
            </button>
          </div>
        </div>
      ) : (
        <>
          <Field label="E-posta" hint="Davet bağlantısı bu adrese iletilecek">
            <input
              autoFocus type="email" value={eposta} placeholder="muhasebe@firma.com"
              onChange={(e) => setEposta(e.target.value)}
            />
          </Field>
          <Field label="Geçerlilik">
            <select value={gun} onChange={(e) => setGun(Number(e.target.value))}>
              <option value={7}>7 gün</option>
              <option value={14}>14 gün</option>
              <option value={30}>30 gün</option>
            </select>
          </Field>
        </>
      )}

      {davetler.length > 0 && (
        <ul className="davet-liste">
          {davetler.map((d) => (
            <li key={d.id} className={`davet-satir davet-${d.status}`}>
              <span className="davet-eposta">{d.email}</span>
              <span className="davet-durum">{DURUM_ADI[d.status]}</span>
              <span className="muted micro">{davetTarihi(d)}</span>
              {/* İPTAL YALNIZCA BEKLEYENDE: kabul edilmiş daveti iptal etmek
                  erişimi kesmez, kullanıcı zaten üye olmuştur. */}
              {d.status === 'pending' && (
                <button className="btn btn-sm" onClick={() => void iptalEt(d.id)}>
                  İptal et
                </button>
              )}
            </li>
          ))}
        </ul>
      )}

      <div className="row birlestir-eylem">
        <button className="btn btn-sm" onClick={vazgec}>
          {bag ? 'Kapat' : 'Vazgeç'}
        </button>
        {!bag && (
          <button className="btn btn-sm btn-primary"
                  disabled={!eposta.includes('@') || calisiyor}
                  aria-busy={calisiyor} onClick={() => void olustur()}>
            {calisiyor ? 'Oluşturuluyor…' : 'Davet oluştur'}
          </button>
        )}
      </div>
    </section>
  );
}

/* --------------------------------------------------------------------------
   Birleştirme
   ------------------------------------------------------------------------ */
function BirlestirmeFormu({ hedef, vazgec, bitti, setHata }: {
  hedef: Partner; vazgec: () => void; bitti: () => Promise<void>;
  setHata: (e: unknown) => void;
}) {
  const [q, setQ] = useState('');
  const [adaylar, setAdaylar] = useState<{ id: string; name: string; tax_no: string | null }[]>([]);
  const [secilen, setSecilen] = useState<{ id: string; name: string } | null>(null);
  const [calisiyor, setCalisiyor] = useState(false);

  useEffect(() => {
    if (q.trim().length < 2) { setAdaylar([]); return; }
    let iptal = false;
    const id = window.setTimeout(async () => {
      try {
        const res = await api.list<{ id: string; name: string; tax_no: string | null }>(
          '/core/partners', { q: q.trim(), limit: 8 });
        // HEDEF KENDİ LİSTESİNDE ÇIKMAZ: bir cariyi kendisiyle birleştirmek
        // anlamsız ve veritabanı da reddediyor; seçtirmemek daha dürüst.
        if (!iptal) setAdaylar(res.data.filter((p) => p.id !== hedef.id));
      } catch { if (!iptal) setAdaylar([]); }
    }, 250);
    return () => { iptal = true; window.clearTimeout(id); };
  }, [q, hedef.id]);

  const birlestir = async () => {
    if (!secilen) return;
    setCalisiyor(true); setHata(null);
    try {
      await api.post(`/core/partners/${hedef.id}/merge`, { source_id: secilen.id });
      await bitti();
    } catch (err) { setHata(err); } finally { setCalisiyor(false); }
  };

  return (
    <section className="cekmece-grup">
      <h3 className="cekmece-grup-ad">Mükerrer firmayı birleştir</h3>
      <p className="birlestir-not">
        Seçtiğiniz firmanın <strong>tüm belgeleri</strong> {hedef.name} kaydına taşınır.
        Kaynak kayıt silinmez, pasife alınır. İşlem geri alınamaz.
      </p>

      {secilen ? (
        <div className="birlestir-secim">
          <span><strong>{secilen.name}</strong> → {hedef.name}</span>
          <button className="btn btn-sm" onClick={() => setSecilen(null)}>Değiştir</button>
        </div>
      ) : (
        <>
          <input
            autoFocus type="search" value={q}
            placeholder="Birleştirilecek firmayı ara…"
            aria-label="Birleştirilecek firmayı ara"
            onChange={(e) => setQ(e.target.value)}
          />
          <ul className="birlestir-liste">
            {adaylar.map((a) => (
              <li key={a.id}>
                <button onClick={() => setSecilen(a)}>
                  <strong>{a.name}</strong>
                  {a.tax_no && <span className="muted num">{a.tax_no}</span>}
                </button>
              </li>
            ))}
            {q.trim().length >= 2 && adaylar.length === 0 && (
              <li className="muted birlestir-bos">Eşleşen firma yok.</li>
            )}
          </ul>
        </>
      )}

      <div className="row birlestir-eylem">
        <button className="btn btn-sm" onClick={vazgec}>Vazgeç</button>
        <button className="btn btn-sm btn-danger" disabled={!secilen || calisiyor}
                aria-busy={calisiyor} onClick={() => void birlestir()}>
          {calisiyor ? 'Birleştiriliyor…' : 'Birleştir'}
        </button>
      </div>
    </section>
  );
}

/* --------------------------------------------------------------------------
   Adres etiketi
   --------------------------------------------------------------------------
   AYRI PENCEREYE YAZILIR, sayfaya değil. Uygulamanın kendi stilleri etikete
   karışmasın ve kullanıcı yazdırdıktan sonra bulunduğu ekranı kaybetmesin
   diye; `@media print` ile sayfayı gizlemek de olurdu ama o yol, yazdırma
   iptal edildiğinde ekranı bozuk bırakabiliyor.
   ------------------------------------------------------------------------ */
function yazdir(p: Partner): void {
  const kacir = (s: string) => s
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

  const satirlar = [
    p.address,
    [p.postal_code, p.district, p.city].filter(Boolean).join(' '),
  ].filter((x): x is string => Boolean(x && x.trim()));

  const w = window.open('', '_blank', 'width=620,height=760');
  if (!w) return;   // Açılır pencere engellendi; sessizce geçilir.

  w.document.write(`<!doctype html><html lang="tr"><head><meta charset="utf-8">
<title>Adres etiketi — ${kacir(p.name)}</title>
<style>
  /* AYRI BELGE, AYRI KURALLAR: bu stiller uygulamanın değil, yazdırma
     penceresinin belgesine yazılıyor -- tema değişkenleri orada yok ve
     olsaydı bile yanlış olurdu. Kâğıda basılan bir etiket, kullanıcının
     koyu tema seçmesinden bağımsız olarak SİYAH-BEYAZ olmalı; ölçüler de
     ekran değil kâğıt birimlerinde (mm, pt).
     ds-allow-hardcode: yazdırma belgesi tema katmanının dışındadır */
  @page { margin: 12mm; }
  body { font: 12pt/1.5 system-ui, sans-serif; color: #000; background: #fff; margin: 0; } /* ds-allow-hardcode */
  .etiket {
    border: 1px dashed #999; border-radius: 4px; /* ds-allow-hardcode */
    padding: 10mm; margin-bottom: 6mm;
    min-height: 34mm;
    break-inside: avoid;
  }
  .ad { font-size: 14pt; font-weight: 700; margin-bottom: 3mm; }
  .satir { margin: 0 0 1mm; }
  .kunye { margin-top: 4mm; font-size: 9pt; color: #444; } /* ds-allow-hardcode */
  .not { font-size: 9pt; color: #666; margin-bottom: 6mm; } /* ds-allow-hardcode */
  @media print { .not { display: none; } }
</style></head><body>
<p class="not">Yazdırma penceresi açıldı. Ctrl+P ile yazdırabilirsiniz.</p>
<div class="etiket">
  <div class="ad">${kacir(p.name)}</div>
  ${satirlar.map((s) => `<p class="satir">${kacir(s)}</p>`).join('')}
  ${p.tax_no ? `<p class="kunye">VKN/TCKN: ${kacir(p.tax_no)}${
    p.tax_office ? ` · ${kacir(p.tax_office)}` : ''}</p>` : ''}
  ${p.phone ? `<p class="kunye">Tel: ${kacir(p.phone)}</p>` : ''}
</div>
</body></html>`);
  w.document.close();
  w.focus();
  w.print();
}

/** Etiket üstündeki tarih damgası testte de kullanılabilsin diye dışa açık. */
export const etiketTarihi = () => date(new Date().toISOString());

/* --------------------------------------------------------------------------
   SMS gönderimi
   --------------------------------------------------------------------------
   İYS AYRIMI EKRANDA GÖRÜNÜR: ticari ileti izin ister, bilgilendirme
   istemez. Kullanıcı hangi tür mesaj attığını seçer ve izin yoksa ticari
   seçenek kilitli gelir. Kuralı uygulayan taraf yine veritabanı; buradaki
   ayrım, kullanıcının reddedilmeyi kaydettikten sonra öğrenmemesi için.
   ------------------------------------------------------------------------ */
function SmsFormu({ partner, vazgec, bitti, setHata }: {
  partner: Partner; vazgec: () => void; bitti: () => void;
  setHata: (e: unknown) => void;
}) {
  const [metin, setMetin] = useState('');
  const [ticari, setTicari] = useState(false);
  const [calisiyor, setCalisiyor] = useState(false);
  const [sonuc, setSonuc] = useState<string | null>(null);

  /**
   * Karakter sayacı.
   *
   * Türkçe karakter içeren mesaj GSM-7 tablosuna sığmaz ve 70 karakterlik
   * UCS-2 parçalara bölünür; kullanıcı 160 karakter sanıp üç katı ücret
   * ödemesin diye sayaç bunu hesaba katar.
   */
  const turkce = /[ğüşıöçĞÜŞİÖÇ]/.test(metin);
  const parcaBoyu = turkce ? 70 : 160;
  const parca = metin.length === 0 ? 0 : Math.ceil(metin.length / parcaBoyu);

  const gonder = async () => {
    setCalisiyor(true); setHata(null); setSonuc(null);
    try {
      const r = await api.post<{ data: { status: string; error: string | null } }>(
        '/core/sms/send',
        { partner_id: partner.id, body: metin, is_commercial: ticari });
      setSonuc(r.data.status === 'sent' ? 'Mesaj gönderildi.' : (r.data.error ?? 'Gönderilemedi'));
      if (r.data.status === 'sent') { setMetin(''); window.setTimeout(bitti, 1200); }
    } catch (err) { setHata(err); } finally { setCalisiyor(false); }
  };

  return (
    <section className="cekmece-grup">
      <h3 className="cekmece-grup-ad">SMS gönder</h3>
      <p className="birlestir-not">
        Alıcı: <strong>{partner.name}</strong> · <span className="num">{partner.phone}</span>
      </p>

      <div className="sms-tur">
        <label className="onay-satir">
          <input type="radio" name="sms-tur" checked={!ticari}
                 onChange={() => setTicari(false)} />
          Bilgilendirme
        </label>
        <label className={`onay-satir${partner.consent_sms ? '' : ' pasif'}`}>
          <input type="radio" name="sms-tur" checked={ticari}
                 disabled={!partner.consent_sms}
                 onChange={() => setTicari(true)} />
          Ticari ileti
        </label>
      </div>
      <p className="muted micro">
        {partner.consent_sms
          ? 'Bu cari SMS ile ticari ileti iznini vermiş.'
          : 'İYS ticari ileti izni yok; yalnızca bilgilendirme gönderilebilir. '
            + 'İzin, cari kartındaki İYS bölümünden işaretlenir.'}
      </p>

      <textarea
        className="sms-metin" rows={4} autoFocus value={metin}
        placeholder="Mesaj metni"
        aria-label="Mesaj metni"
        onChange={(e) => setMetin(e.target.value)}
      />
      <p className="muted micro">
        {metin.length} karakter · {parca} SMS
        {turkce && ' · Türkçe karakter var, parça 70 karakter'}
      </p>

      {sonuc && <p className="sms-sonuc">{sonuc}</p>}

      <div className="row birlestir-eylem">
        <button className="btn btn-sm" onClick={vazgec}>Vazgeç</button>
        <button className="btn btn-sm btn-primary"
                disabled={metin.trim() === '' || calisiyor}
                aria-busy={calisiyor} onClick={() => void gonder()}>
          {calisiyor ? 'Gönderiliyor…' : 'Gönder'}
        </button>
      </div>
    </section>
  );
}
