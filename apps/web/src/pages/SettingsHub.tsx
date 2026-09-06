import { Link } from 'react-router-dom';
import { useItem, useList } from '../ui/useResource';
import { Card, ErrorBox, PageFoot, PageHead } from '../ui';
import { Icon, type IconName } from '../ui/icons';
import { useSession } from '../api/session';

/**
 * Ayarlar merkezi.
 *
 * Ayarlar tek bir listeye sığmıyor: altı kategori hem grupluyor hem de her
 * grubun kaç ekranı olduğunu söylüyor.
 *
 * ÇALIŞAN VE PLANLANAN AYRI GÖSTERİLİR. Ürün yol haritasındaki ekranlar
 * burada duruyor çünkü bilgi mimarisi onlarla birlikte anlamlı; ama
 * tıklanabilir DEĞİLLER ve "yakında" etiketi taşıyorlar. Kart rozetindeki
 * sayı yalnızca AÇILAN ekranları sayar — planlananları da saysaydı rozet,
 * olmayan bir şeyi vaat ederdi.
 */

interface HubOge {
  ad: string;
  alt?: string;
  /** Yol varsa madde çalışır; yoksa planlanandır. */
  to?: string;
  /** Gerekli izin. Kullanıcıda yoksa madde hiç listelenmez. */
  permission?: string;
  /** Yalnızca platform yöneticisine görünür. */
  platform?: boolean;
}

interface HubKategori {
  anahtar: string;
  ikon: IconName;
  baslik: string;
  alt: string;
  ogeler: HubOge[];
}

const KATEGORILER: HubKategori[] = [
  {
    anahtar: 'genel',
    ikon: 'settings',
    baslik: 'Genel Ayarlar',
    alt: 'Firma, sistem ve servis tercihleri',
    ogeler: [
      { ad: 'Firma Genel Ayarları', alt: 'künye · vergi · para birimi · mali yıl', to: '/settings/company' },
      { ad: 'Tanımlar', alt: 'vergi · ölçü birimi · belge numaralandırma', to: '/settings/definitions' },
      { ad: 'Hesap', alt: 'profil · tema · kendi yetkileriniz', to: '/settings/account' },
      { ad: 'Marka', alt: 'ürün logosu (Sezra yönetimi)', to: '/settings/branding', platform: true },
      { ad: 'Servis Maliyet Ayarları' },
    ],
  },
  {
    anahtar: 'erisim',
    ikon: 'people',
    baslik: 'Kullanıcı & Erişim',
    alt: 'Kim neyi görür, hangi modül açık',
    ogeler: [
      { ad: 'Kullanıcılar ve Roller', alt: 'kullanıcı · rol · şube kapsamı', to: '/settings/system', permission: 'core.user.read.all' },
      { ad: 'Modül Erişimi', alt: 'kiracıda hangi modüller açık', to: '/settings/modules' },
      { ad: 'Destek Erişimi', alt: 'Sezra destek oturumu', to: '/platform/tenants', platform: true },
      { ad: 'Müşteri Portalı', alt: 'davetler cari kartındaki Aksiyonlar panelinden gönderilir', to: '/partners', permission: 'core.portal.invite' },
      { ad: 'Yetki Talepleri' },
    ],
  },
  {
    anahtar: 'veri',
    ikon: 'database',
    baslik: 'Veri Yönetimi',
    alt: 'Denetim izi, yedek ve taşıma',
    ogeler: [
      { ad: 'Denetim Günlüğü', alt: 'kim, neyi, ne zaman değiştirdi', to: '/settings/audit', permission: 'core.audit.read.all' },
      { ad: 'Yedek ve Dışa Aktarma' },
      { ad: 'Veri Taşıma Merkezi' },
      { ad: 'Çöp Kutusu' },
    ],
  },
  {
    anahtar: 'entegrasyon',
    ikon: 'panel',
    baslik: 'Entegrasyon',
    alt: 'Pazaryeri, muhasebe, banka ve API bağlantıları',
    ogeler: [
      { ad: 'SMS Sağlayıcısı', alt: 'operatör · gönderen adı · deneme mesajı', to: '/settings/sms', permission: 'core.sms.configure' },
      { ad: 'Entegrasyon Merkezi' },
      { ad: 'Pazaryeri Bağlantıları' },
      { ad: 'Kargo Entegrasyonları' },
      { ad: 'Kurulum Sihirbazı' },
    ],
  },
  {
    anahtar: 'abonelik',
    ikon: 'finance',
    baslik: 'Abonelik & Ödeme',
    alt: 'Paket, kontör ve satın alma',
    ogeler: [
      { ad: 'Abonelik Durumu', alt: 'plan · koltuk · şube kotası', to: '/settings/company' },
      { ad: 'Paket Satın Al' },
      { ad: 'Faturalar' },
      { ad: 'Kontör' },
    ],
  },
  {
    anahtar: 'bakim',
    ikon: 'support',
    baslik: 'Belgeler & Bakım',
    alt: 'Senkron, mutabakat ve belge şablonları',
    ogeler: [
      { ad: 'Senkronizasyon Hataları', alt: 'işlenemeyen modül olayları', to: '/platform', platform: true },
      { ad: 'PDF Tasarımı' },
      { ad: 'Göç Mutabakatı' },
    ],
  },
];

export function SettingsHub() {
  const { me, can } = useSession();
  const roller = useList<{ id: string }>('/core/roles', { limit: 100 });
  const kullanicilar = useList<{ id: string }>('/core/users', { limit: 1 });
  const tenant = useItem<{ plan_code?: string; subscription_status?: string; seats?: number }>(
    '/core/tenant');

  const platformAdmin = me?.user.is_platform_admin === true;
  const gorunur = (o: HubOge) =>
    (!o.platform || platformAdmin) && (!o.permission || can(o.permission));

  // Şerit CANLI OKUMADIR, süs değil: her rozet gerçek bir sayıya bağlı.
  // Ekran görüntüsündeki şerit sabit etiketler taşıyordu; sabit etiket
  // durum çubuğunda yer kaplar ama hiçbir şey söylemez.
  const acikModul = me?.modules.length ?? 0;
  const serit: [string, string][] = [
    ['Erişim', `${roller.total} rol · ${kullanicilar.total} kullanıcı`],
    ['Modül', `${acikModul} açık`],
    // Etiket "Abonelik" ise değer de abonelik olmalı: kiracı adı yazmak
    // rozeti yanlış etiketler ve şerit güvenilirliğini kaybeder.
    ['Abonelik', tenant.data?.plan_code
      ? `${tenant.data.plan_code}${tenant.data.seats ? ` · ${tenant.data.seats} koltuk` : ''}`
      : (me?.tenant ? 'Tanımlı değil' : 'Platform konsolu')],
    ['Denetim günlüğü', can('core.audit.read.all') ? 'Erişiminiz var' : 'Yetkiniz yok'],
  ];

  return (
    <>
      <PageHead
        kicker="Ayarlar"
        title="Yönetim Paneli"
        subtitle="Firma, erişim, veri ve entegrasyon ayarları tek ekrandan."
      />
      <ErrorBox error={roller.error ?? kullanicilar.error ?? tenant.error} />

      <div className="hub-serit">
        {serit.map(([etiket, deger]) => (
          <span className="hub-serit-oge" key={etiket}>
            <span className="hub-serit-etiket">{etiket}</span>
            <span className="hub-serit-deger">{deger}</span>
          </span>
        ))}
      </div>

      <div className="hub-grid">
        {KATEGORILER.map((k) => {
          const listelenen = k.ogeler.filter(gorunur);
          const acik = listelenen.filter((o) => o.to);
          const planlanan = listelenen.filter((o) => !o.to);
          if (listelenen.length === 0) return null;

          // Hiç açık ekranı olmayan kategori solgun durur ve rozetinde SIFIR
          // DEĞİL TİRE gösterir: "0" bir hata gibi okunuyordu, oysa doğru
          // anlam "henüz yok".
          const bosKategori = acik.length === 0;

          return (
            <Card key={k.anahtar}>
              <div className={`hub-card${bosKategori ? ' hub-card-plan' : ''}`}>
                <div className="hub-head">
                  <span className="hub-ikon"><Icon name={k.ikon} /></span>
                  <span className="hub-baslik">
                    <h2>{k.baslik}</h2>
                    <p>{k.alt}</p>
                  </span>
                  {/* Rozet yalnızca AÇILAN ekranı sayar. */}
                  <span className="hub-sayi"
                        title={bosKategori
                          ? 'Bu bölümde henüz açık ekran yok'
                          : `${acik.length} ekran kullanılabilir`}>
                    {bosKategori ? '—' : acik.length}
                  </span>
                </div>

                <ul className="hub-liste">
                  {acik.map((o) => (
                    <li className="hub-oge" key={o.ad}>
                      <Link to={o.to!}>
                        <span className="hub-oge-ad">{o.ad}</span>
                        {o.alt && <span className="hub-oge-alt">{o.alt}</span>}
                      </Link>
                    </li>
                  ))}

                  {planlanan.length > 0 && (
                    <>
                      <li className="hub-planlanan-basligi" aria-hidden="true">Planlanan</li>
                      {planlanan.map((o) => (
                        <li className="hub-oge" key={o.ad}>
                          {/* Tıklanabilir DEĞİL: bağlantı gibi görünen ama hiçbir
                              yere gitmeyen bir madde, kullanıcıyı boşuna tıklatır. */}
                          <span className="hub-oge-pasif">
                            <span className="hub-oge-ad">
                              {o.ad}
                              <span className="hub-yakinda">yakında</span>
                            </span>
                          </span>
                        </li>
                      ))}
                    </>
                  )}
                </ul>
              </div>
            </Card>
          );
        })}
      </div>

      <PageFoot>
        <span>“Yakında” işaretli ekranlar henüz açılmadı; tıklanamazlar.</span>
        <span>Kart rozetindeki sayı yalnızca kullanılabilir ekranları gösterir.</span>
        <span>Bazı ekranlar yetkinize göre listelenmez.</span>
      </PageFoot>
    </>
  );
}
