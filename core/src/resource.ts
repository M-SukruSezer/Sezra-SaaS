import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { Tx } from './db.js';
import { withContext } from './db.js';
import { contextFromRequest } from './auth.js';
import { badRequest, notFound, translatePgError } from './errors.js';

export interface ResourceDef {
  /** URL yolu, ör. '/crm/leads' */
  path: string;
  schema: string;
  table: string;
  /**
   * Okuma için kullanılacak görünüm (ör. 'v_sale_order_list'). Yazma her zaman
   * `table`'a gider. Liste ekranları neredeyse hep ilişkili adları (cari, sorumlu)
   * ister; her modülde elle join uçları yazmak yerine görünüm bağlanır.
   * Görünüm `security_invoker = on` olmalıdır — aksi hâlde RLS atlanır.
   */
  readFrom?: string;
  /** Okunabilir kolonlar — beyaz liste; buraya yazılmayan kolon API'den dönmez */
  columns: readonly string[];
  /** Yazılabilir kolonlar. tenant_id ASLA buraya konmaz: veritabanı doldurur. */
  writable: readonly string[];
  filterable?: readonly string[];
  searchable?: readonly string[];
  sortable?: readonly string[];
  defaultSort?: string;
  defaultOrder?: 'asc' | 'desc';
  maxLimit?: number;
}

const OPERATORS = ['eq', 'neq', 'gt', 'gte', 'lt', 'lte', 'in', 'like', 'is'] as const;
type Operator = (typeof OPERATORS)[number];

interface ParsedFilter { column: string; op: Operator; value: unknown }

/**
 * `?stage_id=x&expected_revenue__gte=1000&status__in=open,won` biçimindeki
 * sorgu parametrelerini ayrıştırır.
 *
 * Kolon adları beyaz listeye karşı doğrulanır — bu, SQL enjeksiyonuna karşı
 * TEK savunma değildir (değerler zaten parametreleşir) ama tanımlanmamış bir
 * kolonun sızdırılmasını engeller.
 */
function parseFilters(query: Record<string, unknown>, allowed: readonly string[]): ParsedFilter[] {
  const out: ParsedFilter[] = [];
  const reserved = new Set(['limit', 'offset', 'sort', 'order', 'q']);

  for (const [key, raw] of Object.entries(query)) {
    if (reserved.has(key) || raw === undefined) continue;
    const [column, opRaw] = key.includes('__') ? key.split('__', 2) : [key, 'eq'];
    if (!column || !allowed.includes(column)) {
      throw badRequest(`Filtrelenemeyen alan: ${key}`);
    }
    const op = (opRaw ?? 'eq') as Operator;
    if (!OPERATORS.includes(op)) throw badRequest(`Geçersiz operatör: ${opRaw}`);

    let value: unknown = raw;
    if (op === 'in') value = String(raw).split(',').filter(Boolean);
    else if (op === 'is') value = raw === 'null' ? null : raw === 'true';
    out.push({ column, op, value });
  }
  return out;
}

export function registerResource(app: FastifyInstance, def: ResourceDef): void {
  const {
    path, schema, table, readFrom, columns, writable,
    filterable = columns,
    searchable = [],
    sortable = columns,
    defaultSort = 'created_at',
    defaultOrder = 'desc',
    maxLimit = 200,
  } = def;
  const readRel = readFrom ?? table;

  const run = async <T>(req: FastifyRequest, fn: (tx: Tx) => Promise<T>): Promise<T> => {
    const ctx = contextFromRequest(req);
    try {
      return await withContext(ctx, fn);
    } catch (err) {
      throw translatePgError(err);
    }
  };

  // ---- LİSTE ---------------------------------------------------------------
  app.get(path, async (req, reply) => {
    const query = req.query as Record<string, unknown>;
    const limit = Math.min(Number(query.limit ?? 50) || 50, maxLimit);
    const offset = Math.max(Number(query.offset ?? 0) || 0, 0);
    const sortCol = String(query.sort ?? defaultSort);
    const order = String(query.order ?? defaultOrder).toLowerCase() === 'asc' ? 'asc' : 'desc';
    if (!sortable.includes(sortCol)) throw badRequest(`Sıralanamayan alan: ${sortCol}`);

    const filters = parseFilters(query, filterable);
    const search = query.q ? String(query.q).trim() : '';

    const rows = await run(req, async (tx) => {
      let where = tx`true`;
      for (const f of filters) {
        const col = tx(f.column);
        switch (f.op) {
          case 'eq':  where = tx`${where} and ${col} = ${f.value as never}`; break;
          case 'neq': where = tx`${where} and ${col} <> ${f.value as never}`; break;
          case 'gt':  where = tx`${where} and ${col} > ${f.value as never}`; break;
          case 'gte': where = tx`${where} and ${col} >= ${f.value as never}`; break;
          case 'lt':  where = tx`${where} and ${col} < ${f.value as never}`; break;
          case 'lte': where = tx`${where} and ${col} <= ${f.value as never}`; break;
          case 'in':  where = tx`${where} and ${col} = any(${f.value as never})`; break;
          case 'like': where = tx`${where} and ${col} ilike ${`%${String(f.value)}%`}`; break;
          case 'is':  where = f.value === null
            ? tx`${where} and ${col} is null`
            : tx`${where} and ${col} = ${f.value as never}`; break;
        }
      }

      if (search && searchable.length > 0) {
        let searchExpr = tx`false`;
        for (const c of searchable) {
          searchExpr = tx`${searchExpr} or ${tx(c)}::text ilike ${`%${search}%`}`;
        }
        where = tx`${where} and (${searchExpr})`;
      }

      return tx`
        select ${tx(columns as string[])}, count(*) over() as total_count
        from ${tx(schema)}.${tx(readRel)}
        where ${where}
        order by ${tx(sortCol)} ${order === 'asc' ? tx`asc` : tx`desc`} nulls last
        limit ${limit} offset ${offset}
      `;
    });

    const total = rows.length > 0 ? Number((rows[0] as Record<string, unknown>).total_count) : 0;
    reply.header('x-total-count', String(total));
    return {
      data: rows.map((r) => { const { total_count, ...rest } = r as Record<string, unknown>; return rest; }),
      meta: { total, limit, offset },
    };
  });

  // ---- TEKİL KAYIT ---------------------------------------------------------
  app.get(`${path}/:id`, async (req) => {
    const { id } = req.params as { id: string };
    const rows = await run(req, (tx) => tx`
      select ${tx(columns as string[])} from ${tx(schema)}.${tx(readRel)} where id = ${id} limit 1
    `);
    // RLS gizlediğinde de 0 satır döner; "yok" ile "yetkin yok" ayrılmaz (bkz. errors.ts)
    if (rows.length === 0) throw notFound();
    return { data: rows[0] };
  });

  // ---- OLUŞTUR -------------------------------------------------------------
  app.post(path, async (req, reply) => {
    const body = req.body as Record<string, unknown>;
    if (!body || typeof body !== 'object') throw badRequest('Gövde boş');

    const payload: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(body)) {
      if (!writable.includes(k)) throw badRequest(`Yazılamayan alan: ${k}`);
      payload[k] = v;
    }
    if (Object.keys(payload).length === 0) throw badRequest('Yazılabilir alan yok');

    const rows = await run(req, async (tx) => {
      const [created] = await tx`
        insert into ${tx(schema)}.${tx(table)} ${tx(payload)} returning id`;
      // Görünüm bağlıysa oluşan kaydı oradan okuyup zenginleştirilmiş hâlini döneriz
      return tx`select ${tx(columns as string[])} from ${tx(schema)}.${tx(readRel)}
                where id = ${(created as { id: string }).id}`;
    });
    reply.code(201);
    return { data: rows[0] };
  });

  // ---- GÜNCELLE ------------------------------------------------------------
  app.patch(`${path}/:id`, async (req) => {
    const { id } = req.params as { id: string };
    const body = req.body as Record<string, unknown>;
    const payload: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(body ?? {})) {
      if (!writable.includes(k)) throw badRequest(`Yazılamayan alan: ${k}`);
      payload[k] = v;
    }
    if (Object.keys(payload).length === 0) throw badRequest('Güncellenecek alan yok');

    const rows = await run(req, async (tx) => {
      const updated = await tx`
        update ${tx(schema)}.${tx(table)} set ${tx(payload)} where id = ${id} returning id`;
      if (updated.length === 0) return [];
      return tx`select ${tx(columns as string[])} from ${tx(schema)}.${tx(readRel)}
                where id = ${id}`;
    });
    if (rows.length === 0) throw notFound();
    return { data: rows[0] };
  });

  // ---- SİL -----------------------------------------------------------------
  app.delete(`${path}/:id`, async (req, reply) => {
    const { id } = req.params as { id: string };
    const rows = await run(req, (tx) => tx`
      delete from ${tx(schema)}.${tx(table)} where id = ${id} returning id
    `);
    if (rows.length === 0) throw notFound();
    reply.code(204);
    return null;
  });
}
