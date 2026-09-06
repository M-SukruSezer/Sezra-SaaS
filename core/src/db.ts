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
 * Transaction'ı yetkisi daraltılmış uygulama rolüne düşürür.
 *
 * DB_APP_ROLE ayarlıysa ona geçilir; ayarlı değilse ham bağlantı rolünde
 * kalınır (Supabase'de bağlantı zaten `authenticated` ile açılır). Her iki
 * durumda da `assertSafeDbRole()` başlangıçta etkin rolün BYPASSRLS/superuser
 * OLMADIĞINI doğrular — yani RLS gerçekten bir güvenlik sınırıdır.
 */
async function dropToAppRole(tx: Tx): Promise<void> {
  if (APP_ROLE) {
    // set_config kullanılıyor: rol adı parametre olarak geçirilebilsin
    await tx`select set_config('role', ${APP_ROLE}, true)`;
  }
}

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
    await dropToAppRole(tx);
    await tx`select set_config('app.user_id', ${ctx.userId}, true)`;
    await tx`select set_config('app.tenant_id', ${ctx.tenantId ?? ''}, true)`;
    await tx`select set_config('app.support_mode', ${ctx.supportMode ? 'on' : 'off'}, true)`;
    return fn(tx);
  }) as unknown as Promise<T>;
}

/**
 * Bağlam gerektirmeyen sistem işleri (olay işleyici, cron, giriş öncesi marka
 * okuması) için.
 *
 * GÜVENLİK: Sistem yolu da yetkisi daraltılmış rolde çalışır. Ham bağlantı
 * rolü owner + BYPASSRLS olabilir; o zaman bu yol kiracı izolasyonunu hiçbir
 * uyarı vermeden atlardı. `app.system_context = 'on'` GUC'si yalnızca burada
 * ayarlanır (withContext ASLA ayarlamaz) ve gerçekten kiracı taşımayan sistem
 * tablolarının (ör. core.fx_rates) yazma politikalarınca kontrol edilir.
 */
export async function withSystemContext<T>(fn: (tx: Tx) => Promise<T>): Promise<T> {
  return sql.begin(async (tx) => {
    await dropToAppRole(tx);
    await tx`select set_config('app.system_context', 'on', true)`;
    return fn(tx);
  }) as unknown as Promise<T>;
}

/**
 * Başlangıçta etkin veritabanı rolünün bir güvenlik sınırı olduğunu doğrular.
 *
 * RLS yalnızca rol BYPASSRLS taşımıyorsa ve superuser değilse bir sınırdır.
 * .env.example bir owner (BYPASSRLS) DATABASE_URL'i ile gelir; DB_APP_ROLE
 * ayarlanmadan yapılan bir dağıtım kiracı izolasyonunu hiçbir uyarı vermeden
 * kaybederdi. Bu kontrol o dağıtımın açılışta AÇIKÇA durmasını sağlar —
 * kapalı kapanır, açık kapanmaz.
 */
export async function assertSafeDbRole(): Promise<void> {
  const rows = (await sql.begin(async (tx) => {
    await dropToAppRole(tx);
    return tx`
      select current_user as role,
             coalesce((select r.rolbypassrls from pg_roles r
                        where r.rolname = current_user), true) as bypassrls,
             current_setting('is_superuser') as is_superuser`;
  })) as unknown as Array<{ role: string; bypassrls: boolean; is_superuser: string }>;

  const row = rows[0];
  const sorunlar: string[] = [];
  if (!row || row.bypassrls) sorunlar.push('rol BYPASSRLS taşıyor');
  if (row?.is_superuser === 'on') sorunlar.push('rol superuser');

  if (sorunlar.length > 0) {
    throw new Error(
      `Güvenli olmayan veritabanı rolü "${row?.role ?? '?'}": ${sorunlar.join(', ')}.\n` +
        '  Bu rolde RLS bir güvenlik sınırı değil — kiracı izolasyonu kapalı demektir.\n' +
        '  Çözüm: DB_APP_ROLE ile yetkisi daraltılmış bir role (ör. sezra_app) düşün,\n' +
        '  ya da DATABASE_URL\'i owner olmayan bir role çevir.',
    );
  }
}

export async function closeDb(): Promise<void> {
  await sql.end({ timeout: 5 });
}
