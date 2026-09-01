import { useState } from 'react';
import { useSession } from '../api/session';
import { Card, ErrorBox, Field } from '../ui';

/**
 * Geliştirme oturumu.
 *
 * Üretimde burası Supabase Auth ekranı olur ve alınan access token
 * `session.accessToken` olarak saklanır; API istemcisinin geri kalanı değişmez.
 */
const DEMO_USERS = [
  { id: '22222222-2222-2222-2222-222222222222', label: 'Merve Yıldız — Şirket Yöneticisi' },
  { id: '33333333-3333-3333-3333-333333333333', label: 'Ali Kaya — Satış (Düzce, sadece kendi fırsatları)' },
  { id: '44444444-4444-4444-4444-444444444444', label: 'Deniz Aras — Şube Müdürü (Zonguldak)' },
  { id: '11111111-1111-1111-1111-111111111111', label: 'Sezra — Platform Yöneticisi' },
];

export function SignIn() {
  const { signIn, error } = useSession();
  const [userId, setUserId] = useState(DEMO_USERS[0]!.id);

  return (
    <div style={{ display: 'grid', placeItems: 'center', height: '100%', padding: 24 }}>
      <div style={{ width: 460 }}>
        <div className="brand" style={{ border: 0, justifyContent: 'center', marginBottom: 16 }}>
          <span className="brand-mark">S</span><span>Sezra</span>
        </div>
        <Card title="Oturum aç">
          <ErrorBox error={error} />
          <Field label="Kullanıcı" hint="Yerel geliştirme modu — üretimde Supabase Auth kullanılır">
            <select value={userId} onChange={(e) => setUserId(e.target.value)}>
              {DEMO_USERS.map((u) => <option key={u.id} value={u.id}>{u.label}</option>)}
            </select>
          </Field>
          <button className="btn btn-primary" onClick={() => signIn({ userId })}>Giriş yap</button>
        </Card>
        <p className="muted" style={{ fontSize: 12, marginTop: 12, textAlign: 'center' }}>
          Farklı kullanıcılarla girip aynı ekranların nasıl değiştiğini görebilirsiniz —
          menü, kayıt sayısı ve buton görünürlükleri rolden gelir.
        </p>
      </div>
    </div>
  );
}
