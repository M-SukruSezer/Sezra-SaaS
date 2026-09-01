import postgres from 'postgres';

/**
 * Veritabanı bağlantı havuzu.
 *
 * GÜVENLİK: Bu bağlantının kullandığı rol tabloların SAHİBİ olmamalı ve
 * BYPASSRLS taşımamalıdır. Yerel geliştirmede tek bir owner bağlantısı
 * kullanmak pratik olduğu için, DB_APP_ROLE ayarlıysa her istek kendi
 * transaction'ında `set local role` ile yetkisi daraltılmış role düşer.
 */
export const sql = postgres(process.env.DATABASE_URL ?? '', {
  max: Number(process.env.DB_POOL_MAX ?? 10),
  idle_timeout: 30,
  connect_timeout: 10,
  onnotice: () => {},
});

export type Sql = postgres.Sql;
/** Transaction bağlamındaki sorgu arayüzü — modüller bunu alır, havuzu değil. */
export type Tx = postgres.TransactionSql;

export interface RequestContext {
  /** core.users.id — Supabase'de auth.users.id ile aynı */
  userId: string;
  /** Aktif kiracı. İstemciden gelir ama veritabanı üyeliğe karşı doğrular. */
  tenantId?: string | undefined;
  /** Platform yöneticisinin bilinçli kiracılar-arası destek erişimi */
  supportMode?: boolean;
  /** İstek izleme kimliği (log ve denetim korelasyonu) */
  requestId?: string;
}

const APP_ROLE = process.env.DB_APP_ROLE?.trim();

/**
 * Verilen kullanıcı bağlamıyla bir transaction açar.
 *
 * Bağlam GUC'larla taşınır ve `set local` olduğu için transaction bitince
 * otomatik düşer — havuzdaki bir bağlantı bir sonraki isteğe asla önceki
 * kullanıcının kimliğiyle geçmez. Bu, çok kiracılı bir havuzda en kolay
 * yapılan hatadır; burada yapısal olarak imkânsız.
 */
export async function withContext<T>(
  ctx: RequestContext,
  fn: (tx: Tx) => Promise<T>,
): Promise<T> {
  return sql.begin(async (tx) => {
    if (APP_ROLE) {
      // set_config kullanılıyor: rol adı parametre olarak geçirilebilsin
      await tx`select set_config('role', ${APP_ROLE}, true)`;
    }
    await tx`select set_config('app.user_id', ${ctx.userId}, true)`;
    await tx`select set_config('app.tenant_id', ${ctx.tenantId ?? ''}, true)`;
    await tx`select set_config('app.support_mode', ${ctx.supportMode ? 'on' : 'off'}, true)`;
    return fn(tx);
  }) as unknown as Promise<T>;
}

/** Bağlam gerektirmeyen sistem işleri (olay işleyici, cron) için. */
export async function withSystemContext<T>(fn: (tx: Tx) => Promise<T>): Promise<T> {
  return sql.begin((tx) => fn(tx)) as unknown as Promise<T>;
}

export async function closeDb(): Promise<void> {
  await sql.end({ timeout: 5 });
}
