import type { FastifyInstance, FastifyRequest } from 'fastify';
import {
  registerResource, withContext, contextFromRequest, translatePgError,
  notFound, badRequest, type SezraModule, type Tx,
} from '@sezra/core';

/** Bağlamlı sorgu kısayolu — her uçta tekrar etmemek için. */
async function run<T>(req: FastifyRequest, fn: (tx: Tx) => Promise<T>): Promise<T> {
  const ctx = contextFromRequest(req);
  try {
    return await withContext(ctx, fn);
  } catch (err) {
    throw translatePgError(err);
  }
}

const LEAD_COLUMNS = ['id', 'branch_id', 'pipeline_id', 'stage_id', 'name', 'partner_id',
  'contact_name', 'email', 'phone', 'source', 'expected_revenue', 'currency', 'probability',
  'priority', 'status', 'lost_reason_id', 'lost_note', 'expected_close_date', 'closed_at',
  'tags', 'notes', 'owner_id', 'created_at', 'updated_at'] as const;

const DOC_HEADER_COLUMNS = ['id', 'branch_id', 'number', 'partner_id', 'status', 'currency',
  'subtotal', 'discount_total', 'tax_total', 'withholding_total', 'total',
  'payment_term_days', 'notes', 'owner_id', 'created_at', 'updated_at'] as const;

const LINE_COLUMNS = ['id', 'sequence', 'product_id', 'description', 'quantity', 'uom_id',
  'unit_price', 'discount_pct', 'tax_id', 'line_subtotal', 'line_tax', 'line_withholding',
  'line_total'] as const;

export const crmModule: SezraModule = {
  code: 'crm',

  register(app: FastifyInstance) {
    // ========================= Kaynaklar =========================
    registerResource(app, {
      path: '/crm/leads',
      schema: 'crm', table: 'leads', readFrom: 'v_lead_list',
      columns: [...LEAD_COLUMNS, 'partner_name', 'owner_name', 'stage_name',
        'branch_name', 'lost_reason_name'],
      writable: ['branch_id', 'pipeline_id', 'stage_id', 'name', 'partner_id', 'contact_name',
        'email', 'phone', 'source', 'expected_revenue', 'currency', 'priority',
        'lost_reason_id', 'lost_note', 'expected_close_date', 'tags', 'notes', 'owner_id'],
      filterable: [...LEAD_COLUMNS],
      searchable: ['name', 'contact_name', 'email', 'phone'],
      sortable: [...LEAD_COLUMNS],
      defaultSort: 'updated_at',
    });

    registerResource(app, {
      path: '/crm/activities',
      schema: 'crm', table: 'activities',
      columns: ['id', 'branch_id', 'lead_id', 'partner_id', 'kind', 'subject', 'notes',
        'due_at', 'done_at', 'outcome', 'assigned_to', 'owner_id', 'created_at'],
      writable: ['branch_id', 'lead_id', 'partner_id', 'kind', 'subject', 'notes', 'due_at',
        'done_at', 'outcome', 'assigned_to', 'owner_id'],
      searchable: ['subject', 'notes'],
      defaultSort: 'due_at', defaultOrder: 'asc',
    });

    registerResource(app, {
      path: '/crm/quotations',
      schema: 'crm', table: 'quotations', readFrom: 'v_quotation_list',
      columns: [...DOC_HEADER_COLUMNS, 'lead_id', 'issue_date', 'valid_until',
        'accepted_at', 'rejected_at', 'partner_name', 'owner_name', 'branch_name', 'line_count'],
      // number/status/tutarlar YAZILAMAZ: numarayı sekans, durumu iş akışı,
      // tutarları satır trigger'ları belirler. API'den yazdırmak bunları bozar.
      writable: ['branch_id', 'partner_id', 'lead_id', 'issue_date', 'valid_until',
        'currency', 'payment_term_days', 'notes', 'owner_id'],
      filterable: [...DOC_HEADER_COLUMNS, 'lead_id', 'issue_date'],
      searchable: ['number', 'notes', 'partner_name'],
      sortable: [...DOC_HEADER_COLUMNS, 'issue_date'],
      defaultSort: 'issue_date',
    });

    registerResource(app, {
      path: '/crm/quotation-lines',
      schema: 'crm', table: 'quotation_lines',
      columns: [...LINE_COLUMNS, 'quotation_id'],
      writable: ['quotation_id', 'sequence', 'product_id', 'description', 'quantity',
        'uom_id', 'unit_price', 'discount_pct', 'tax_id'],
      defaultSort: 'sequence', defaultOrder: 'asc',
    });

    registerResource(app, {
      path: '/crm/sale-orders',
      schema: 'crm', table: 'sale_orders', readFrom: 'v_sale_order_list',
      columns: [...DOC_HEADER_COLUMNS, 'quotation_id', 'order_date', 'delivery_date',
        'confirmed_at', 'cancelled_at', 'partner_name', 'owner_name', 'branch_name', 'line_count'],
      writable: ['branch_id', 'partner_id', 'order_date', 'delivery_date', 'currency',
        'payment_term_days', 'notes', 'owner_id'],
      filterable: [...DOC_HEADER_COLUMNS, 'quotation_id', 'order_date'],
      searchable: ['number', 'notes', 'partner_name'],
      sortable: [...DOC_HEADER_COLUMNS, 'order_date'],
      defaultSort: 'order_date',
    });

    registerResource(app, {
      path: '/crm/sale-order-lines',
      schema: 'crm', table: 'sale_order_lines',
      columns: [...LINE_COLUMNS, 'sale_order_id'],
      writable: ['sale_order_id', 'sequence', 'product_id', 'description', 'quantity',
        'uom_id', 'unit_price', 'discount_pct', 'tax_id'],
      defaultSort: 'sequence', defaultOrder: 'asc',
    });

    registerResource(app, {
      path: '/crm/pipelines', schema: 'crm', table: 'pipelines',
      columns: ['id', 'name', 'is_default', 'is_active'],
      writable: ['name', 'is_default', 'is_active'],
      defaultSort: 'name', defaultOrder: 'asc',
    });

    registerResource(app, {
      path: '/crm/stages', schema: 'crm', table: 'stages',
      columns: ['id', 'pipeline_id', 'name', 'sequence', 'probability', 'is_won', 'is_lost'],
      writable: ['pipeline_id', 'name', 'sequence', 'probability', 'is_won', 'is_lost'],
      defaultSort: 'sequence', defaultOrder: 'asc',
    });

    registerResource(app, {
      path: '/crm/lost-reasons', schema: 'crm', table: 'lost_reasons',
      columns: ['id', 'name', 'is_active'],
      writable: ['name', 'is_active'],
      defaultSort: 'name', defaultOrder: 'asc',
    });

    // ========================= Kanban tahtası =========================
    /** Huni ekranının tek çağrıda ihtiyacı olan her şey: aşamalar + fırsatlar. */
    app.get('/crm/board', async (req) => {
      const { pipeline_id } = req.query as { pipeline_id?: string };
      return run(req, async (tx) => {
        const [pipeline] = pipeline_id
          ? await tx`select id, name from crm.pipelines where id = ${pipeline_id}`
          : await tx`select id, name from crm.pipelines where is_default limit 1`;
        if (!pipeline) throw notFound('Satış hunisi bulunamadı');

        const stages = await tx`
          select id, name, sequence, probability, is_won, is_lost
          from crm.stages where pipeline_id = ${pipeline.id as string}
          order by sequence`;

        const leads = await tx`
          select l.id, l.stage_id, l.name, l.expected_revenue, l.currency, l.probability,
                 l.priority, l.status, l.expected_close_date, l.owner_id,
                 u.full_name as owner_name, p.name as partner_name, b.name as branch_name,
                 (select count(*) from crm.activities a
                   where a.lead_id = l.id and a.done_at is null and a.due_at < now()) as overdue_activities
          from crm.leads l
          left join core.users u on u.id = l.owner_id
          left join core.partners p on p.id = l.partner_id
          left join core.branches b on b.id = l.branch_id
          where l.pipeline_id = ${pipeline.id as string} and l.status = 'open'
          order by l.priority desc, l.expected_close_date nulls last`;

        return {
          data: {
            pipeline,
            stages: stages.map((s) => ({
              ...s,
              leads: leads.filter((l) => l.stage_id === s.id),
              total_revenue: leads
                .filter((l) => l.stage_id === s.id)
                .reduce((sum, l) => sum + Number(l.expected_revenue ?? 0), 0),
            })),
          },
        };
      });
    });

    /** Kanban'da kart taşıma. Aşama kazanıldı/kaybedildi ise durum otomatik değişir. */
    app.post('/crm/leads/:id/stage', async (req) => {
      const { id } = req.params as { id: string };
      const { stage_id, lost_reason_id, lost_note } = req.body as {
        stage_id?: string; lost_reason_id?: string; lost_note?: string;
      };
      if (!stage_id) throw badRequest('stage_id zorunlu');

      return run(req, async (tx) => {
        const rows = await tx`
          update crm.leads
             set stage_id = ${stage_id},
                 lost_reason_id = coalesce(${lost_reason_id ?? null}, lost_reason_id),
                 lost_note = coalesce(${lost_note ?? null}, lost_note)
           where id = ${id}
          returning id, stage_id, status, probability, closed_at`;
        if (rows.length === 0) throw notFound();
        return { data: rows[0] };
      });
    });

    // ========================= Durum geçişleri =========================
    // Bunlar iş kuralı taşıdığı için CRUD değil, veritabanı fonksiyonlarına
    // delegasyon: yetki kontrolü, numaralandırma ve olay yayını orada.
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

    // DİKKAT: `select (fn(x)).*` YAZILMAZ — PostgreSQL bu sözdiziminde fonksiyonu
    // her çıktı kolonu için yeniden çağırır. Durum değiştiren bir fonksiyonda bu,
    // ikinci çağrının "zaten onaylanmış" hatasıyla patlaması demektir.
    // `select * from fn(x)` fonksiyonu tam olarak bir kez çalıştırır.
    action('/crm/quotations/:id/send', async (tx, id) => {
      const [row] = await tx`select * from crm.send_quotation(${id})`;
      return row;
    });

    action('/crm/quotations/:id/accept', async (tx, id) => {
      const [row] = await tx`select * from crm.accept_quotation(${id})`;
      return row;
    });

    action('/crm/sale-orders/:id/confirm', async (tx, id) => {
      const [row] = await tx`select * from crm.confirm_sale_order(${id})`;
      return row;
    });

    action('/crm/sale-orders/:id/cancel', async (tx, id, body) => {
      const [row] = await tx`
        select * from crm.cancel_sale_order(${id}, ${(body.reason as string) ?? null})`;
      return row;
    });

    /** Teklif ya da siparişi satırlarıyla birlikte tek çağrıda döndürür. */
    app.get('/crm/quotations/:id/full', async (req) => {
      const { id } = req.params as { id: string };
      return run(req, async (tx) => {
        const [header] = await tx`
          select q.*, p.name as partner_name, p.tax_no, p.tax_office, u.full_name as owner_name
          from crm.quotations q
          left join core.partners p on p.id = q.partner_id
          left join core.users u on u.id = q.owner_id
          where q.id = ${id}`;
        if (!header) throw notFound();
        const lines = await tx`
          select l.*, pr.sku, t.code as tax_code, t.rate as tax_rate, uo.code as uom_code
          from crm.quotation_lines l
          left join core.products pr on pr.id = l.product_id
          left join core.taxes t on t.id = l.tax_id
          left join core.uoms uo on uo.id = l.uom_id
          where l.quotation_id = ${id} order by l.sequence`;
        return { data: { ...header, lines } };
      });
    });

    app.get('/crm/sale-orders/:id/full', async (req) => {
      const { id } = req.params as { id: string };
      return run(req, async (tx) => {
        const [header] = await tx`
          select so.*, p.name as partner_name, p.tax_no, p.tax_office, u.full_name as owner_name
          from crm.sale_orders so
          left join core.partners p on p.id = so.partner_id
          left join core.users u on u.id = so.owner_id
          where so.id = ${id}`;
        if (!header) throw notFound();
        const lines = await tx`
          select l.*, pr.sku, t.code as tax_code, t.rate as tax_rate, uo.code as uom_code
          from crm.sale_order_lines l
          left join core.products pr on pr.id = l.product_id
          left join core.taxes t on t.id = l.tax_id
          left join core.uoms uo on uo.id = l.uom_id
          where l.sale_order_id = ${id} order by l.sequence`;
        return { data: { ...header, lines } };
      });
    });

    // ========================= Raporlar =========================
    app.get('/crm/reports/rep-performance', async (req) => {
      const { from, to } = req.query as { from?: string; to?: string };
      return run(req, async (tx) => ({
        data: await tx`
          select * from crm.v_rep_performance
          where (${from ?? null}::date is null or period >= ${from ?? null}::date)
            and (${to ?? null}::date is null or period <= ${to ?? null}::date)
          order by period desc, won_revenue desc nulls last`,
      }));
    });

    app.get('/crm/reports/lost-reasons', async (req) =>
      run(req, async (tx) => ({
        data: await tx`select * from crm.v_lost_reason_analysis order by lost_count desc`,
      })));

    /**
     * Huni özeti. Görünüm şube kırılımlı olduğu için aynı aşama birden fazla
     * satırla döner; varsayılan olarak aşama bazında toplanır.
     * ?by_branch=1 ile ham şube kırılımı alınır.
     */
    app.get('/crm/reports/pipeline', async (req) => {
      const { by_branch } = req.query as { by_branch?: string };
      return run(req, async (tx) => ({
        data: by_branch
          ? await tx`select * from crm.v_pipeline_summary order by sequence`
          : await tx`
              select stage_id, stage_name, sequence,
                     sum(lead_count)        as lead_count,
                     sum(total_revenue)     as total_revenue,
                     sum(weighted_revenue)  as weighted_revenue
              from crm.v_pipeline_summary
              group by stage_id, stage_name, sequence
              order by sequence`,
      }));
    });

    app.get('/crm/reports/overdue-activities', async (req) =>
      run(req, async (tx) => ({
        data: await tx`select * from crm.v_overdue_activities order by days_overdue desc`,
      })));
  },
};

export default crmModule;
