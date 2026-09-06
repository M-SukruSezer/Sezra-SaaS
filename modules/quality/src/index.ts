import type { FastifyInstance, FastifyRequest } from 'fastify';
import {
  registerResource, withContext, contextFromRequest, translatePgError,
  badRequest, notFound, type SezraModule, type Tx,
} from '@sezra/core';

async function run<T>(req: FastifyRequest, fn: (tx: Tx) => Promise<T>): Promise<T> {
  const ctx = contextFromRequest(req);
  try {
    return await withContext(ctx, fn);
  } catch (err) {
    throw translatePgError(err);
  }
}

const INSPECTION_COLUMNS = ['id', 'branch_id', 'number', 'stage', 'status',
  'product_id', 'sku', 'product_name', 'partner_id', 'partner_name',
  'quantity', 'sampled_quantity', 'plan_id', 'plan_code', 'plan_name',
  'inspector_id', 'inspector_name', 'inspected_at',
  'source_module', 'source_table', 'source_id',
  'branch_name', 'owner_id', 'created_at',
  'check_count', 'failed_count', 'pending_count'] as const;

const NC_COLUMNS = ['id', 'branch_id', 'number', 'inspection_id', 'inspection_number',
  'product_id', 'sku', 'product_name', 'partner_id', 'partner_name',
  'quantity', 'severity', 'description', 'disposition', 'disposition_note',
  'corrective_action', 'decided_by', 'decided_by_name', 'decided_at', 'closed_at',
  'is_open', 'branch_name', 'owner_id', 'created_at'] as const;

export const qualityModule: SezraModule = {
  code: 'quality',

  register(app: FastifyInstance) {
    // ========================= Planlar =========================
    registerResource(app, {
      path: '/quality/plans',
      schema: 'quality', table: 'plans',
      columns: ['id', 'code', 'name', 'product_id', 'category_id', 'stage',
        'sample_pct', 'is_active', 'created_at', 'updated_at'],
      writable: ['code', 'name', 'product_id', 'category_id', 'stage',
        'sample_pct', 'is_active'],
      searchable: ['code', 'name'],
      defaultSort: 'code', defaultOrder: 'asc',
    });

    registerResource(app, {
      path: '/quality/check-points',
      schema: 'quality', table: 'check_points',
      columns: ['id', 'plan_id', 'sequence', 'code', 'name', 'kind', 'unit',
        'min_value', 'max_value', 'expected_bool', 'choices', 'expected_choice',
        'is_critical', 'instructions'],
      writable: ['plan_id', 'sequence', 'code', 'name', 'kind', 'unit',
        'min_value', 'max_value', 'expected_bool', 'choices', 'expected_choice',
        'is_critical', 'instructions'],
      defaultSort: 'sequence', defaultOrder: 'asc',
    });

    // ========================= Muayeneler =========================
    registerResource(app, {
      path: '/quality/inspections',
      schema: 'quality', table: 'inspections', readFrom: 'v_inspection_list',
      columns: [...INSPECTION_COLUMNS],
      // status/number/inspector YAZILAMAZ: sonucu complete_inspection türetir.
      writable: ['branch_id', 'plan_id', 'product_id', 'lot_id', 'partner_id',
        'quantity', 'sampled_quantity', 'stage', 'notes', 'owner_id'],
      filterable: [...INSPECTION_COLUMNS],
      searchable: ['number', 'product_name', 'partner_name'],
      sortable: [...INSPECTION_COLUMNS],
      defaultSort: 'created_at',
    });

    // Ölçüm satırları: denetçi buraya yazar, `passed` tetikleyiciden gelir.
    registerResource(app, {
      path: '/quality/results',
      schema: 'quality', table: 'results',
      columns: ['id', 'inspection_id', 'check_point_id', 'sequence', 'code', 'name',
        'kind', 'unit', 'min_value', 'max_value', 'expected_bool', 'expected_choice',
        'is_critical', 'numeric_value', 'bool_value', 'text_value', 'passed', 'note'],
      writable: ['numeric_value', 'bool_value', 'text_value', 'note'],
      defaultSort: 'sequence', defaultOrder: 'asc',
    });

    registerResource(app, {
      path: '/quality/nonconformities',
      schema: 'quality', table: 'nonconformities', readFrom: 'v_nonconformity_list',
      columns: [...NC_COLUMNS],
      // disposition YAZILAMAZ: karar decide_nonconformity üzerinden verilir,
      // çünkü gerekçe zorunluluğu ve kapanış izi orada uygulanıyor.
      writable: ['branch_id', 'inspection_id', 'product_id', 'partner_id', 'quantity',
        'severity', 'description', 'corrective_action', 'owner_id'],
      filterable: [...NC_COLUMNS],
      searchable: ['number', 'description', 'product_name', 'partner_name'],
      sortable: [...NC_COLUMNS],
      defaultSort: 'created_at',
    });

    // ========================= Eylemler =========================
    app.post('/quality/inspections/:id/complete', async (req) => {
      const { id } = req.params as { id: string };
      return run(req, async (tx) => {
        const [row] = await tx`select * from quality.complete_inspection(${id})`;
        return { data: row };
      });
    });

    app.post('/quality/nonconformities/:id/decide', async (req) => {
      const { id } = req.params as { id: string };
      const b = (req.body ?? {}) as Record<string, unknown>;
      if (!b.disposition) throw badRequest('disposition zorunlu');
      return run(req, async (tx) => {
        const [row] = await tx`
          select * from quality.decide_nonconformity(
            ${id}, ${b.disposition as string}::quality.disposition,
            ${(b.note as string) ?? null}, ${(b.corrective_action as string) ?? null})`;
        return { data: row };
      });
    });

    /** Elle muayene açar (üretim, sevkiyat öncesi ya da plansız kontrol). */
    app.post('/quality/inspections/open', async (req) => {
      const b = (req.body ?? {}) as Record<string, unknown>;
      if (!b.product_id) throw badRequest('product_id zorunlu');
      return run(req, async (tx) => {
        const [me] = await tx`select core.current_tenant_id() as t`;
        const [row] = await tx`
          select quality.open_inspection(
            ${(me as { t: string }).t}, ${(b.branch_id as string) ?? null},
            ${b.product_id as string}, ${Number(b.quantity ?? 0)},
            ${(b.partner_id as string) ?? null}, ${(b.lot_id as string) ?? null},
            ${(b.stage as string) ?? 'incoming'},
            'manual', 'quality', null) as inspection_id`;
        const id = (row as { inspection_id: string | null })?.inspection_id;
        if (!id) {
          // Plan yoksa muayene AÇILMAZ (bilinçli). Bunu sessiz başarı gibi
          // döndürmek, kullanıcıyı olmayan bir kaydı aramaya iterdi.
          throw notFound('Bu ürün için etkin muayene planı yok');
        }
        return { data: { inspection_id: id } };
      });
    });

    /** Muayene kartı: ölçüm satırlarıyla birlikte. */
    app.get('/quality/inspections/:id/full', async (req) => {
      const { id } = req.params as { id: string };
      return run(req, async (tx) => {
        const [header] = await tx`select * from quality.v_inspection_list where id = ${id}`;
        if (!header) throw notFound();
        const results = await tx`
          select * from quality.results where inspection_id = ${id} order by sequence`;
        return { data: { ...header, results } };
      });
    });

    // ========================= Raporlar =========================
    app.get('/quality/reports/supplier-quality', async (req) =>
      run(req, async (tx) => ({
        data: await tx`
          select * from quality.v_supplier_quality
          order by pass_rate_pct nulls last, partner_name`,
      })));

    app.get('/quality/reports/failed-checks', async (req) =>
      run(req, async (tx) => ({
        data: await tx`
          select * from quality.v_failed_checks order by fail_count desc, name`,
      })));
  },
};

export default qualityModule;
