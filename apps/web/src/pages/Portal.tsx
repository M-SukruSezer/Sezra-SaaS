import { useEffect, useState } from 'react';
import { Link, Navigate, Route, Routes, useNavigate, useParams } from 'react-router-dom';
import { FileText, LogOut, Receipt, ShoppingCart } from 'lucide-react';
import { api } from '../api/client';
import { useSession } from '../api/session';
import { useList } from '../ui/useResource';
import { Card, Empty, ErrorBox, Field, StatusBadge } from '../ui';
import { date, money } from '../i18n';

/* ===========================================================================
   Müşteri portalı
   ===========================================================================
   AYRI BİR KABUK, personel arayüzünün kısıtlanmış hâli değil. Portal
   kullanıcısının hiçbir izni yoktur; personel kabuğunu ona göstermek boş bir
   menü ve her yerde "yetkiniz yok" demek olurdu. Burada yalnızca onun gerçekten
   görebildiği üç şey var: faturaları, teklifleri, siparişleri.

   GÖRÜNÜRLÜK SINIRI BU DOSYADA DEĞİL. Ne görüleceğine RLS politikaları karar
   veriyor (`core.attach_portal_policy`); buradaki uçlar süzgeçsiz çağrılır ve
   veritabanı zaten yalnızca o cariye ait satırları döndürür. Süzgeci arayüze
   koymak, unutulabilecek bir kontrol demek olurdu.
   ========================================================================= */

/** Kabul ekranının gösterdiği davet özeti. Jeton kabul edilmeden okunur. */
interface Ozet {
  partner_name: string;
  email: string;
  expires_at: string;
}

interface PortalBelge {
  id: string; number: string | null; status: string;
  issue_date?: string; order_date?: string; valid_until?: string;
  total: string; currency: string;
}

/** Portal listelerinin ortak gövdesi: üçü de aynı şekli taşıyor. */
function BelgeListesi({ baslik, aciklama, yol, tarihAlani, bosMetin }: {
  baslik: string; aciklama: string; yol: string;
  tarihAlani: 'issue_date' | 'order_date'; bosMetin: string;
}) {
  const { data, error, loading } = useList<PortalBelge>(yol, { limit: 100 });

  return (
    <>
      {/* BÖLÜM ADI SAYFANIN h1'İ. `Card` başlığını `span` olarak çiziyor
          (proje geneli kalıp); yalnızca ona güvenilseydi portal sayfasında
          hiçbir başlık düzeyi olmazdı ve ekran okuyucu için sayfa tek bir
          yapısız blok olurdu. */}
      <header className="page-head">
        <div style={{ flex: 1 }}>
          <h1 className="page-title">{baslik}</h1>
          <p className="page-sub">{aciklama}</p>
        </div>
      </header>
      <Card>
      <ErrorBox error={error} />
      {loading && data.length === 0 && <p className="muted">Yükleniyor…</p>}
      {!loading && data.length === 0 && <Empty title="Kayıt yok">{bosMetin}</Empty>}
      {data.length > 0 && (
        <div className="tbl-wrap">
          <table className="tbl">
            <thead>
              <tr>
                <th scope="col">Belge no</th>
                <th scope="col">Tarih</th>
                <th scope="col">Durum</th>
                <th scope="col" className="r">Tutar</th>
              </tr>
            </thead>
            <tbody>
              {data.map((b) => (
                <tr key={b.id}>
                  <td className="num">{b.number ?? '—'}</td>
                  <td>{date(b[tarihAlani] ?? null)}</td>
                  <td><StatusBadge status={b.status} /></td>
                  <td className="r">{money(b.total, b.currency)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      </Card>
    </>
  );
}

const SEKMELER = [
  { yol: 'faturalar', ad: 'Faturalarım', simge: Receipt },
  { yol: 'teklifler', ad: 'Tekliflerim', simge: FileText },
  { yol: 'siparisler', ad: 'Siparişlerim', simge: ShoppingCart },
] as const;

/** Portal kabuğu. */
export function PortalShell() {
  const { me, signOut } = useSession();
  const firma = me?.portal?.partner_name ?? '';

  return (
    <div className="portal">
      <header className="portal-bar">
        <div className="portal-kimlik">
          <span className="portal-etiket">Müşteri portalı</span>
          {/* FİRMA ADI SUNUCUDAN: kimin adına girildiği en üstte ve tek
              kaynaktan yazılır. */}
          <span className="portal-firma">{firma}</span>
        </div>
        <button className="btn btn-sm" onClick={signOut}>
          <LogOut size={14} aria-hidden="true" /> Çıkış
        </button>
      </header>

      <nav className="portal-menu" aria-label="Portal bölümleri">
        {SEKMELER.map((s) => (
          <Link key={s.yol} to={`/${s.yol}`} className="portal-sekme">
            <s.simge size={16} aria-hidden="true" />
            {s.ad}
          </Link>
        ))}
      </nav>

      <main className="portal-govde">
        <Routes>
          <Route path="faturalar" element={
            <BelgeListesi
              baslik="Faturalarım"
              aciklama="Adınıza kesilen faturalar ve ödeme durumları."
              yol="/finance/invoices" tarihAlani="issue_date"
              bosMetin="Adınıza kesilmiş bir fatura göründüğünde burada listelenir."
            />
          } />
          <Route path="teklifler" element={
            <BelgeListesi
              baslik="Tekliflerim"
              aciklama="Size gönderilen fiyat teklifleri ve geçerlilik durumları."
              yol="/crm/quotations" tarihAlani="issue_date"
              bosMetin="Size gönderilen teklifler burada listelenir."
            />
          } />
          <Route path="siparisler" element={
            <BelgeListesi
              baslik="Siparişlerim"
              aciklama="Verdiğiniz siparişler ve karşılanma durumları."
              yol="/crm/sale-orders" tarihAlani="order_date"
              bosMetin="Verdiğiniz siparişler burada listelenir."
            />
          } />
          <Route path="*" element={<Navigate to="/faturalar" replace />} />
        </Routes>
      </main>

      <footer className="portal-dip">
        <span className="muted micro">
          Bu ekranda yalnızca {firma} kayıtları görünür ve değişiklik yapılamaz.
        </span>
      </footer>
    </div>
  );
}

/* --------------------------------------------------------------------------
   Davet kabul ekranı
   ------------------------------------------------------------------------ */
/**
 * Davet bağlantısının açtığı ekran.
 *
 * KABUL AÇIK BİR EYLEMDİR, sayfa açılır açılmaz çalışan bir yan etki değil.
 * Otomatik kabul, bağlantıya yanlışlıkla tıklayan birinin hesabını sessizce
 * bir firmaya bağlardı; üstelik önizleme yapan e-posta istemcileri de
 * bağlantıları açar.
 */
export function PortalDavet() {
  const { token } = useParams();
  const { me, refresh, signOut } = useSession();
  const nav = useNavigate();
  const [calisiyor, setCalisiyor] = useState(false);
  const [hata, setHata] = useState<unknown>(null);
  const [ad, setAd] = useState('');
  const [ozet, setOzet] = useState<Ozet | null>(null);
  const [ozetHata, setOzetHata] = useState<unknown>(null);
  const [yukleniyor, setYukleniyor] = useState(true);

  // ÖZET ÖNCE: kullanıcı neyi kabul ettiğini görmeden onaylamamalı.
  useEffect(() => {
    let iptal = false;
    (async () => {
      try {
        const r = await api.get<{ data: Ozet }>(`/portal/invitations/${token}`);
        if (!iptal) setOzet(r.data);
      } catch (err) {
        if (!iptal) setOzetHata(err);
      } finally {
        if (!iptal) setYukleniyor(false);
      }
    })();
    return () => { iptal = true; };
  }, [token]);

  const kabulEt = async () => {
    setCalisiyor(true); setHata(null);
    try {
      await api.post('/portal/accept', { token, full_name: ad.trim() || null });
      // OTURUM TAZELENİR: kabul, kullanıcıyı portal oturumuna çevirir ve
      // tazelenmezse arayüz eski profilsiz hâlinde kilitli kalır.
      await refresh();
      nav('/faturalar', { replace: true });
    } catch (err) { setHata(err); } finally { setCalisiyor(false); }
  };

  if (me?.portal) return <Navigate to="/faturalar" replace />;

  return (
    <div className="portal-davet">
      <Card title="Portal daveti">
        {yukleniyor && <p className="muted">Davet kontrol ediliyor…</p>}

        {/* GEÇERSİZ DAVET AYRI BİR EKRAN, hata kutusu değil: kullanıcının
            burada yapabileceği tek şey yeni davet istemek. Form açık
            bırakılsaydı çalışmayacağı belli bir düğmeye basardı. */}
        {!yukleniyor && ozetHata != null && (
          <>
            <ErrorBox error={ozetHata} />
            <p>
              Bu davet bağlantısı geçersiz, süresi dolmuş ya da daha önce
              kullanılmış. Firmanızla iletişime geçip yeni bir davet isteyin.
            </p>
            <div className="row" style={{ justifyContent: 'flex-end' }}>
              <button className="btn btn-sm" onClick={signOut}>Oturumu kapat</button>
            </div>
          </>
        )}

        {!yukleniyor && ozet && (
          <>
            <ErrorBox error={hata} />
            <p>
              <strong>{ozet.partner_name}</strong> sizi müşteri portalına davet etti.
              Kabul ettiğinizde bu firmaya ait faturalarınızı, tekliflerinizi ve
              siparişlerinizi görüntüleyebilirsiniz.
            </p>
            <p className="muted">
              Davet <strong>{ozet.email}</strong> adresine gönderildi ·
              son gün {date(ozet.expires_at)}
            </p>
            <Field label="Ad soyad" hint="Firmanızın kayıtlarında görünecek adınız">
              <input value={ad} autoFocus placeholder="Ad soyad"
                     onChange={(e) => setAd(e.target.value)} />
            </Field>
            <div className="row" style={{ justifyContent: 'flex-end' }}>
              <button className="btn btn-sm" onClick={signOut}>Başka hesapla gir</button>
              <button className="btn btn-sm btn-primary" disabled={calisiyor}
                      aria-busy={calisiyor} onClick={() => void kabulEt()}>
                {calisiyor ? 'Bağlanıyor…' : 'Daveti kabul et'}
              </button>
            </div>
          </>
        )}
      </Card>
    </div>
  );
}
