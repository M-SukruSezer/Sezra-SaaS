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

const PROJECT_COLUMNS = ['id', 'branch_id', 'code', 'name', 'status', 'billing_type',
  'partner_id', 'partner_name', 'manager_id', 'manager_name',
  'start_date', 'due_date', 'completed_at', 'contract_amount', 'hourly_rate',
  'currency', 'planned_hours', 'branch_name', 'owner_id', 'created_at',
  'task_count', 'done_task_count', 'actual_hours', 'hours_used_pct',
  'billable_amount', 'unbilled_amount', 'overdue_days'] as const;

const TASK_COLUMNS = ['id', 'branch_id', 'project_id', 'project_code', 'project_name',
  'parent_id', 'parent_name', 'code', 'name', 'description', 'status', 'priority',
  'sequence', 'assignee_id', 'assignee_name', 'planned_hours', 'start_date',
  'due_date', 'done_at', 'actual_hours', 'subtask_count', 'overdue_days',
  'branch_name', 'owner_id', 'created_at'] as const;

const TIMESHEET_COLUMNS = ['id', 'branch_id', 'project_id', 'project_code', 'project_name',
  'task_id', 'task_name', 'user_id', 'user_name', 'work_date', 'hours', 'description',
  'is_billable', 'hourly_rate', 'billable_amount', 'invoiced_at', 'invoice_id',
  'is_invoiced', 'branch_name', 'created_at'] as const;

export const projectsModule: SezraModule = {
  code: 'projects',

  register(app: FastifyInstance) {
    registerResource(app, {
      path: '/projects/projects',
      schema: 'projects', table: 'projects', readFrom: 'v_project_list',
      columns: [...PROJECT_COLUMNS],
      writable: ['branch_id', 'code', 'name', 'description', 'partner_id', 'manager_id',
        'status', 'billing_type', 'contract_amount', 'hourly_rate', 'currency',
        'start_date', 'due_date', 'planned_hours', 'owner_id'],
      filterable: [...PROJECT_COLUMNS],
      searchable: ['code', 'name', 'partner_name'],
      sortable: [...PROJECT_COLUMNS],
      defaultSort: 'created_at',
    });

    registerResource(app, {
      path: '/projects/tasks',
      schema: 'projects', table: 'tasks', readFrom: 'v_task_list',
      columns: [...TASK_COLUMNS],
      // done_at YAZILAMAZ: complete_task belirler (alt görev kontrolü orada).
      writable: ['branch_id', 'project_id', 'parent_id', 'code', 'name', 'description',
        'status', 'priority', 'assignee_id', 'planned_hours', 'start_date',
        'due_date', 'sequence', 'owner_id'],
      filterable: [...TASK_COLUMNS],
      searchable: ['name', 'code', 'description'],
      sortable: [...TASK_COLUMNS],
      defaultSort: 'sequence', defaultOrder: 'asc',
    });

    registerResource(app, {
      path: '/projects/timesheets',
      schema: 'projects', table: 'timesheets', readFrom: 'v_timesheet_list',
      columns: [...TIMESHEET_COLUMNS],
      // hourly_rate/hourly_cost/tutarlar YAZILAMAZ: tetikleyici dondurur.
      // owner_id de yazılamaz — sahip her zaman user_id'dir (0901).
      writable: ['branch_id', 'project_id', 'task_id', 'user_id', 'employee_id',
        'work_date', 'hours', 'description', 'is_billable'],
      filterable: [...TIMESHEET_COLUMNS],
      searchable: ['description', 'project_name', 'user_name'],
      sortable: [...TIMESHEET_COLUMNS],
      defaultSort: 'work_date',
    });

    // ========================= Eylemler =========================
    app.post('/projects/tasks/:id/complete', async (req) => {
      const { id } = req.params as { id: string };
      return run(req, async (tx) => {
        const [row] = await tx`select * from projects.complete_task(${id})`;
        return { data: row };
      });
    });

    app.post('/projects/projects/:id/complete', async (req) => {
      const { id } = req.params as { id: string };
      return run(req, async (tx) => {
        const [row] = await tx`select * from projects.complete_project(${id})`;
        return { data: row };
      });
    });

    /** Hakedişi toplar ve faturalanmak üzere olay yayınlar. */
    app.post('/projects/projects/:id/bill', async (req) => {
      const { id } = req.params as { id: string };
      const b = (req.body ?? {}) as Record<string, unknown>;
      return run(req, async (tx) => {
        const [row] = await tx`
          select projects.bill_project(${id}, ${(b.up_to as string) ?? null}) as result`;
        return { data: (row as { result: unknown }).result };
      });
    });

    /** Proje kartı: görevler ve son zaman kayıtlarıyla. */
    app.get('/projects/projects/:id/full', async (req) => {
      const { id } = req.params as { id: string };
      return run(req, async (tx) => {
        const [header] = await tx`select * from projects.v_project_list where id = ${id}`;
        if (!header) throw notFound();
        const tasks = await tx`
          select * from projects.v_task_list where project_id = ${id}
          order by coalesce(parent_id::text, id::text), sequence`;
        const timesheets = await tx`
          select * from projects.v_timesheet_list where project_id = ${id}
          order by work_date desc limit 100`;
        return { data: { ...header, tasks, timesheets } };
      });
    });

    /**
     * Hızlı saat girişi.
     *
     * Zaman kaydı gün sonunda toplu girilir; her satır için ayrı forma girmek
     * en çok terk edilen ekrandır. Bu uç tek çağrıda birden çok gün/görev alır.
     */
    app.post('/projects/timesheets/bulk', async (req) => {
      const b = (req.body ?? {}) as Record<string, unknown>;
      const entries = b.entries;
      if (!Array.isArray(entries) || entries.length === 0) {
        throw badRequest('entries dizisi zorunlu');
      }
      if (entries.length > 100) throw badRequest('Tek seferde en fazla 100 kayıt');
      return run(req, async (tx) => {
        let created = 0;
        for (const raw of entries) {
          const e = raw as Record<string, unknown>;
          if (!e.project_id || !e.user_id || !e.hours) {
            throw badRequest('Her kayıt project_id, user_id ve hours içermeli');
          }
          await tx`
            insert into projects.timesheets
              (project_id, task_id, user_id, work_date, hours, description, is_billable)
            values (
              ${e.project_id as string}, ${(e.task_id as string) ?? null},
              ${e.user_id as string},
              ${(e.work_date as string) ?? null}::date,
              ${Number(e.hours)}, ${(e.description as string) ?? null},
              ${e.is_billable === undefined ? true : Boolean(e.is_billable)})`;
          created += 1;
        }
        return { data: { created } };
      });
    });

    // ========================= Raporlar =========================
    app.get('/projects/reports/profitability', async (req) =>
      run(req, async (tx) => ({
        data: await tx`
          select * from projects.v_project_profitability
          order by margin desc nulls last`,
      })));

    app.get('/projects/reports/utilization', async (req) => {
      const { period } = req.query as { period?: string };
      return run(req, async (tx) => ({
        data: await tx`
          select * from projects.v_user_utilization
          where (${period ?? null}::date is null or period = ${period ?? null}::date)
          order by period desc, billable_pct desc nulls last`,
      }));
    });

    /** Bana atanan açık görevler — kişisel çalışma listesi. */
    app.get('/projects/my-tasks', async (req) =>
      run(req, async (tx) => ({
        data: await tx`
          select * from projects.v_task_list
          where assignee_id = core.current_user_id()
            and status not in ('done', 'cancelled')
          order by (due_date is null), due_date, priority`,
      })));
  },
};

export default projectsModule;
