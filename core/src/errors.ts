/** Uygulama hatası — HTTP durumu ve makine tarafından okunabilir kod taşır. */
export class AppError extends Error {
  constructor(
    readonly statusCode: number,
    readonly code: string,
    message: string,
    readonly details?: unknown,
  ) {
    super(message);
    this.name = 'AppError';
  }
}

export const badRequest = (m: string, d?: unknown) => new AppError(400, 'bad_request', m, d);
export const unauthorized = (m = 'Kimlik doğrulanamadı') => new AppError(401, 'unauthorized', m);
export const forbidden = (m = 'Bu işlem için yetkiniz yok') => new AppError(403, 'forbidden', m);
export const notFound = (m = 'Kayıt bulunamadı') => new AppError(404, 'not_found', m);
export const conflict = (m: string) => new AppError(409, 'conflict', m);

interface PgError { code?: string; message?: string; constraint_name?: string; detail?: string }

/**
 * PostgreSQL hatalarını HTTP yanıtlarına çevirir.
 *
 * Kritik nokta: RLS bir satırı gizlediğinde sorgu HATA vermez, sadece 0 satır
 * döner. Dolayısıyla "yetkin yok" ile "kayıt yok" API seviyesinde ayrılamaz —
 * ve ayrılmamalıdır: 403 dönmek, kaydın var olduğunu sızdırır. Her ikisi de
 * 404 olur.
 */
export function translatePgError(err: unknown): AppError {
  if (err instanceof AppError) return err;
  const e = err as PgError;
  switch (e?.code) {
    case '23505':
      return conflict(`Bu kayıt zaten mevcut${e.constraint_name ? ` (${e.constraint_name})` : ''}`);
    case '23503': {
      // 23503 İKİ AYRI DURUMU kapsar ve ikisi birbirinin tersidir:
      //   - yazarken: gösterilen kayıt YOK ("İlişkili kayıt bulunamadı")
      //   - silerken: kayda BAŞKALARI bağlı ("hâlâ referans veriliyor")
      // İkisine aynı cümleyi yazmak, belgesi olduğu için silinemeyen bir
      // cariyi silmeye çalışan kullanıcıya "kayıt bulunamadı" dedirtiyordu.
      const bagli = /still referenced/i.test(e.detail ?? '');
      if (bagli) {
        const tablo = /from table "([^"]+)"/i.exec(e.detail ?? '')?.[1];
        return conflict(
          `Bu kayda bağlı ${tablo ? `${tablo} ` : ''}kayıtları var; silinemez.`
          + ' Önce bağlı kayıtları kaldırın ya da kaydı pasife alın.');
      }
      return new AppError(422, 'fk_violation', 'İlişkili kayıt bulunamadı', e.detail);
    }
    case '23514':
      return new AppError(422, 'check_violation', e.message ?? 'Geçersiz değer');
    case '23502':
      return new AppError(422, 'not_null_violation', e.message ?? 'Zorunlu alan boş');
    case '42501':
      return forbidden(e.message ?? 'Bu işlem için yetkiniz yok');
    case 'P0002':
      return notFound(e.message ?? 'Kayıt bulunamadı');
    case '22P02':
      return badRequest('Geçersiz kimlik ya da veri biçimi');
    default: {
      // İstemciye ayrıntı SIZDIRILMAZ ama sunucu günlüğünde kaybolmamalı:
      // özgün hata `cause` olarak taşınır, logger onu yazar. Bu olmadan
      // 500'ler "Beklenmeyen bir hata oluştu" diye tek satıra iner ve
      // hangi sorgunun neden düştüğü anlaşılamaz.
      const wrapped = new AppError(500, 'internal_error', 'Beklenmeyen bir hata oluştu');
      (wrapped as { cause?: unknown }).cause = err;
      return wrapped;
    }
  }
}
