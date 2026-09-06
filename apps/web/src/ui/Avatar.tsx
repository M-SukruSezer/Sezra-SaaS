import { uretilmisAvatar } from '../lib/avatar';

/**
 * Profil görseli.
 *
 * İKİ KAYNAK, TEK BİLEŞEN: kullanıcı fotoğraf yüklediyse o, yüklemediyse
 * sistemin ürettiği renkli baş harf. Her iki durumda da aynı ölçü ve aynı
 * yuvarlaklık; avatarın olup olmaması hizayı bozmaz.
 *
 * `alt` BOŞ: avatar her zaman adın yanında duruyor ve tek başına bir bilgi
 * taşımıyor. Ekran okuyucuya adı iki kez okutmak, listeyi gezmeyi yavaşlatır.
 */
export function Avatar({ id, ad, gorsel, olcu = 'md' }: {
  /** Kullanıcı kimliği: üretilen rengin sabit kalmasını sağlar. */
  id: string;
  ad: string | null;
  gorsel: string | null;
  olcu?: 'sm' | 'md' | 'lg';
}) {
  const sinif = `avatar avatar-${olcu}`;

  if (gorsel) {
    return <img className={sinif} src={gorsel} alt="" />;
  }

  const { bas, renk } = uretilmisAvatar(id, ad);
  return (
    <span className={`${sinif} avatar-renk-${renk}`} aria-hidden="true">
      {bas}
    </span>
  );
}
