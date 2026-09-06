import { useState } from 'react';
import { useSession } from '../api/session';
import { useBranding } from '../api/branding';
import { ErrorBox } from '../ui';

/**
 * Giriş ekranı.
 *
 * ÜRETİM YOLU: burası Supabase Auth ekranı olur; alınan access token
 * `session.accessToken` olarak saklanır ve API istemcisinin geri kalanı
 * değişmez. Sahte bir e-posta/parola formu KOYMUYORUZ: çalışmayan bir form,
 * olmayan bir formdan daha kötüdür.
 *
 * Şu anki yol yerel geliştirme (AUTH_MODE=dev): kullanıcı bir demo hesabı
 * seçer ve `x-user-id` başlığıyla girer. Seçim açılır liste değil, radyo
 * grubu: her satır o rolün NE GÖRDÜĞÜNÜ yazıyor, çünkü bu ekranın asıl işi
 * yetki modelinin nasıl davrandığını göstermek.
 */
interface DemoUser {
  id: string;
  name: string;
  role: string;
  sees: string;
}

const DEMO_USERS: DemoUser[] = [
  {
    id: '22222222-2222-2222-2222-222222222222',
    name: 'Merve Yıldız',
    role: 'Şirket Yöneticisi',
    sees: 'Tüm modüller, tüm şubeler, ücret ve maliyet dahil.',
  },
  {
    id: '44444444-4444-4444-4444-444444444444',
    name: 'Deniz Aras',
    role: 'Şube Müdürü · Zonguldak',
    sees: 'Yalnızca Zonguldak. Personeli görür, ücretleri göremez.',
  },
  {
    id: '33333333-3333-3333-3333-333333333333',
    name: 'Ali Kaya',
    role: 'Satış · Düzce',
    sees: 'Yalnızca kendi fırsatları. Muhasebe ve bordro menüde yok.',
  },
  {
    id: '11111111-1111-1111-1111-111111111111',
    name: 'Sezra',
    role: 'Platform Yöneticisi',
    sees: 'Hiçbir kiracıya üye değil. Platform konsolu açılır.',
  },
];

const SPEC: [string, string][] = [
  ['Kiracı modeli', 'Paylaşılan şema, satır düzeyi güvenlik'],
  ['Modüller', 'CRM, Muhasebe, İK, Satın Alma, Envanter'],
  ['Mevzuat', 'KDV ve tevkifat, Tekdüzen Hesap Planı, SGK'],
  ['Sürüm', '0.1.0'],
];

export function SignIn() {
  const { signIn, error } = useSession();
  const { logo } = useBranding();
  const [userId, setUserId] = useState(DEMO_USERS[0]!.id);

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    signIn({ userId });
  };

  return (
    <div className="auth">
      {/* Kimlik paneli: cihazın ön plakası. Her iki temada da mürekkep kalır. */}
      <section className="auth-brand">
        <div>
          {/* Logo yüklüyse yazı işaretinin yerini alır. Alternatif metin yine
              ürün adıdır: görsel yüklenmezse ekran adsız kalmasın. */}
          {logo
            ? <img className="auth-logo" src={logo} alt="Sezra" />
            : <h1 className="auth-wordmark">Sezra</h1>}
          <p className="auth-tagline">
            Çok kiracılı işletme yönetimi. Kiracı izolasyonu uygulama kodunda
            değil, veritabanında.
          </p>
        </div>

        <dl className="auth-spec">
          {SPEC.map(([term, value]) => (
            <div key={term} style={{ display: 'contents' }}>
              <dt>{term}</dt>
              <dd>{value}</dd>
            </div>
          ))}
        </dl>
      </section>

      <section className="auth-panel">
        <form className="auth-form" onSubmit={submit}>
          <div className="page-head">
            <div style={{ flex: 1 }}>
              <div className="page-kicker">Oturum</div>
              <h2 className="page-title">Giriş yap</h2>
              <p className="page-sub">
                Yerel geliştirme modu. Farklı hesaplarla girip aynı ekranın role
                göre nasıl değiştiğini görebilirsiniz.
              </p>
            </div>
          </div>

          <ErrorBox error={error} />

          <fieldset className="auth-accounts">
            <legend>Demo hesap</legend>
            {DEMO_USERS.map((u) => (
              <label className="auth-account" key={u.id}>
                <input
                  type="radio" name="demo-user" value={u.id}
                  checked={userId === u.id}
                  onChange={() => setUserId(u.id)}
                />
                <span>
                  <span className="auth-account-name">{u.name}</span>
                  <span className="auth-account-role">{u.role}</span>
                  <span className="auth-account-sees">{u.sees}</span>
                </span>
              </label>
            ))}
          </fieldset>

          <button className="btn btn-primary auth-submit" type="submit">
            Giriş yap
          </button>

          <p className="auth-foot">
            Menü, kayıt sayısı ve buton görünürlükleri rolden gelir. Bu yalnızca
            görünürlüktür: kullanıcı adresi elle yazsa bile API ve veritabanı
            onu durdurur.
          </p>
        </form>
      </section>
    </div>
  );
}
