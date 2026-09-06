import type { FastifyInstance, FastifyRequest } from 'fastify';
import {
  registerResource, registerPartnerRelation, withContext, contextFromRequest,
  translatePgError,
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

const EQUIPMENT_COLUMNS = ['id', 'branch_id', 'code', 'name', 'category', 'manufacturer',
  'model', 'serial_no', 'status', 'is_critical', 'purchase_date', 'warranty_until',
  'under_warranty', 'usage_counter', 'usage_unit', 'location_note',
  'partner_id', 'service_partner_name', 'branch_name', 'owner_id',
  'open_work_orders', 'last_service_at', 'lifetime_cost', 'lifetime_downtime_minutes'] as const;

const WO_COLUMNS = ['id', 'branch_id', 'number', 'kind', 'status', 'priority', 'title',
  'description', 'resolution', 'equipment_id', 'equipment_code', 'equipment_name',
  'is_critical', 'equipment_category', 'plan_id', 'plan_name',
  'reported_at', 'scheduled_date', 'started_at', 'completed_at',
  'assignee_id', 'assignee_name', 'partner_id', 'service_partner_name',
  'downtime_minutes', 'labor_minutes', 'labor_cost', 'parts_cost', 'service_cost',
  'total_cost', 'branch_name', 'owner_id', 'created_at',
  'task_count', 'pending_task_count', 'overdue_days'] as const;

export const maintenanceModule: SezraModule = {
  code: 'maintenance',

  register(app: FastifyInstance) {
    /* ---- Cari kartı ilişkisi: servis ---------------------------------
       Bu cari bir SERVİS FİRMASI olarak geçtiği iş emirleri. Ekipmanın
       bakımını dışarıdan yaptıran şirketler için carinin en çok bakılan
       yüzü budur: "bu firmaya kaç iş verdik, ne kadar ödedik". */
    registerPartnerRelation({
      anahtar: 'servis', etiket: 'Servis', sira: 75, modul: 'maintenance',
      izin: 'maintenance.workorder.read.all',
      ozet: async (tx, id) => {
        const [r] = await tx`
          select count(*)::int as adet, coalesce(sum(service_cost), 0)::text as toplam
          from maintenance.work_orders where partner_id = ${id}`;
        return r as { adet: number; toplam: string };
      },
      satirlar: (tx, id, limit) => tx`
        select id, number, title, status, kind, reported_at, completed_at,
               equipment_name, total_cost
        from maintenance.v_work_order_list where partner_id = ${id}
        order by reported_at desc limit ${limit}`,
    });

    registerResource(app, {
      path: '/maintenance/equipment',
      schema: 'maintenance', table: 'equipment', readFrom: 'v_equipment_list',
      columns: [...EQUIPMENT_COLUMNS],
      // status YAZILABİLİR (hurdaya ayırma elle yapılır) ama arıza bildirimi
      // report_breakdown üzerinden gitmelidir: o yol iş emri de açar.
      writable: ['branch_id', 'code', 'name', 'category', 'manufacturer', 'model',
        'serial_no', 'partner_id', 'purchase_date', 'warranty_until', 'purchase_cost',
        'location_note', 'status', 'is_critical', 'usage_counter', 'usage_unit',
        'notes', 'owner_id'],
      filterable: [...EQUIPMENT_COLUMNS],
      searchable: ['code', 'name', 'serial_no', 'model'],
      sortable: [...EQUIPMENT_COLUMNS],
      defaultSort: 'code', defaultOrder: 'asc',
    });

    registerResource(app, {
      path: '/maintenance/plans',
      schema: 'maintenance', table: 'plans',
      columns: ['id', 'code', 'name', 'equipment_id', 'category', 'interval_days',
        'interval_usage', 'lead_days', 'estimated_minutes', 'instructions', 'is_active'],
      writable: ['code', 'name', 'equipment_id', 'category', 'interval_days',
        'interval_usage', 'lead_days', 'estimated_minutes', 'instructions', 'is_active'],
      searchable: ['code', 'name'],
      defaultSort: 'code', defaultOrder: 'asc',
    });

    registerResource(app, {
      path: '/maintenance/plan-tasks',
      schema: 'maintenance', table: 'plan_tasks',
      columns: ['id', 'plan_id', 'sequence', 'name', 'instructions'],
      writable: ['plan_id', 'sequence', 'name', 'instructions'],
      defaultSort: 'sequence', defaultOrder: 'asc',
    });

    registerResource(app, {
      path: '/maintenance/work-orders',
      schema: 'maintenance', table: 'work_orders', readFrom: 'v_work_order_list',
      columns: [...WO_COLUMNS],
      // status/number/parts_cost/total_cost YAZILAMAZ: akış ve satırlar belirler.
      writable: ['branch_id', 'equipment_id', 'plan_id', 'kind', 'priority', 'title',
        'description', 'scheduled_date', 'assignee_id', 'partner_id',
        'downtime_minutes', 'labor_minutes', 'labor_cost', 'service_cost',
        'resolution', 'owner_id'],
      filterable: [...WO_COLUMNS],
      searchable: ['number', 'title', 'equipment_name'],
      sortable: [...WO_COLUMNS],
      defaultSort: 'reported_at',
    });

    registerResource(app, {
      path: '/maintenance/work-order-tasks',
      schema: 'maintenance', table: 'work_order_tasks',
      columns: ['id', 'work_order_id', 'sequence', 'name', 'instructions',
        'is_done', 'done_at', 'note'],
      writable: ['work_order_id', 'sequence', 'name', 'instructions', 'is_done', 'note'],
      defaultSort: 'sequence', defaultOrder: 'asc',
    });

    registerResource(app, {
      path: '/maintenance/work-order-parts',
      schema: 'maintenance', table: 'work_order_parts',
      columns: ['id', 'work_order_id', 'product_id', 'quantity', 'unit_cost',
        'total_cost', 'stock_issued', 'note'],
      // total_cost tetikleyiciden; stock_issued envanter köprüsünden gelir.
      writable: ['work_order_id', 'product_id', 'quantity', 'unit_cost', 'note'],
      defaultSort: 'created_at', defaultOrder: 'asc',
    });

    // ========================= Eylemler =========================
    const action = (
      path: string,
      fn: (tx: Tx, id: string, body: Record<string, unknown>) => Promise<unknown>,
    ) => {
      app.post(path, async (req) => {
        const { id } = req.params as { id: string };
        const body = (req.body ?? {}) as Record<string, unknown>;
        const data = await run(req, (tx) => fn(tx, id, body));
        return { data };
      });
    };

    action('/maintenance/work-orders/:id/start', async (tx, id) => {
      const [row] = await tx`select * from maintenance.start_work_order(${id})`;
      return row;
    });

    action('/maintenance/work-orders/:id/complete', async (tx, id, body) => {
      const [row] = await tx`
        select * from maintenance.complete_work_order(
          ${id}, ${(body.resolution as string) ?? null},
          ${body.downtime_minutes === undefined ? null : Number(body.downtime_minutes)})`;
      return row;
    });

    /** Arıza bildirimi: iş emri açar VE ekipmanı durdurur. */
    action('/maintenance/equipment/:id/report-breakdown', async (tx, id, body) => {
      if (!body.title) throw badRequest('title zorunlu');
      const [row] = await tx`
        select * from maintenance.report_breakdown(
          ${id}, ${body.title as string}, ${(body.description as string) ?? null},
          ${Number(body.priority ?? 1)}::smallint)`;
      return row;
    });

    /** Vadesi gelen planlardan iş emri üretir (cron da bunu çağırır). */
    app.post('/maintenance/generate-work-orders', async (req) =>
      run(req, async (tx) => {
        const [row] = await tx`select maintenance.generate_work_orders() as created`;
        return { data: row };
      }));

    app.get('/maintenance/work-orders/:id/full', async (req) => {
      const { id } = req.params as { id: string };
      return run(req, async (tx) => {
        const [header] = await tx`select * from maintenance.v_work_order_list where id = ${id}`;
        if (!header) throw notFound();
        const tasks = await tx`
          select * from maintenance.work_order_tasks
          where work_order_id = ${id} order by sequence`;
        const parts = await tx`
          select p.*, pr.sku, pr.name as product_name
          from maintenance.work_order_parts p
          left join core.products pr on pr.id = p.product_id
          where p.work_order_id = ${id} order by p.created_at`;
        return { data: { ...header, tasks, parts } };
      });
    });

    // ========================= Raporlar =========================
    app.get('/maintenance/reports/due-plans', async (req) =>
      run(req, async (tx) => ({
        data: await tx`
          select * from maintenance.v_due_plans order by days_left nulls last`,
      })));

    app.get('/maintenance/reports/reliability', async (req) =>
      run(req, async (tx) => ({
        data: await tx`
          select * from maintenance.v_equipment_reliability
          order by total_cost desc nulls last`,
      })));
  },
};

export default maintenanceModule;
