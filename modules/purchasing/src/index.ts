import type { FastifyInstance, FastifyRequest } from 'fastify';
import {
  registerResource, registerPartnerRelation, withContext, contextFromRequest,
  translatePgError,
  notFound, badRequest, type SezraModule, type Tx,
} from '@sezra/core';

async function run<T>(req: FastifyRequest, fn: (tx: Tx) => Promise<T>): Promise<T> {
  const ctx = contextFromRequest(req);
  try {
    return await withContext(ctx, fn);
  } catch (err) {
    throw translatePgError(err);
  }
}

const DOC_TOTALS = ['currency', 'subtotal', 'discount_total', 'tax_total',
  'withholding_total', 'total'] as const;

const LINE_COLUMNS = ['id', 'sequence', 'product_id', 'description', 'quantity', 'uom_id',
  'unit_price', 'discount_pct', 'tax_id', 'line_subtotal', 'line_tax', 'line_withholding',
  'line_total'] as const;

const REQ_COLUMNS = ['id', 'branch_id', 'number', 'request_date', 'needed_by', 'status',
  ...DOC_TOTALS, 'suggested_partner_id', 'suggested_partner_name', 'justification',
  'approver_id', 'approver_name', 'approved_at', 'rejection_reason',
  'branch_name', 'owner_name', 'owner_id', 'line_count', 'created_at', 'updated_at'] as const;

const ORDER_COLUMNS = ['id', 'branch_id', 'number', 'partner_id', 'partner_name', 'tax_no',
  'requisition_id', 'requisition_number', 'order_date', 'promised_date', 'status',
  ...DOC_TOTALS, 'payment_term_days', 'supplier_ref', 'branch_name', 'owner_name', 'owner_id',
  'line_count', 'received_pct', 'confirmed_at', 'cancelled_at',
  'created_at', 'updated_at'] as const;

const RECEIPT_COLUMNS = ['id', 'branch_id', 'number', 'order_id', 'order_number',
  'promised_date', 'partner_id', 'partner_name', 'receipt_date', 'status', 'waybill_no',
  'branch_name', 'owner_id', 'line_count', 'total_quantity', 'rejected_quantity',
  'delay_days', 'confirmed_at', 'created_at'] as const;

export const purchasingModule: SezraModule = {
  code: 'purchasing',

  register(app: FastifyInstance) {
    /* ---- Cari kartı ilişkisi: sevkiyat (mal kabul irsaliyeleri) ------ */
    registerPartnerRelation({
      anahtar: 'sevkiyat', etiket: 'Sevkiyat', sira: 65, modul: 'purchasing',
      izin: 'purchasing.receipt.read.all',
      ozet: async (tx, id) => {
        const [r] = await tx`
          select count(*)::int as adet from purchasing.receipts where partner_id = ${id}`;
        return { adet: Number((r as { adet: number }).adet), toplam: null };
      },
      satirlar: (tx, id, limit) => tx`
        select id, number, waybill_no, receipt_date, status, order_number,
               total_quantity, rejected_quantity, delay_days
        from purchasing.v_receipt_list where partner_id = ${id}
        order by receipt_date desc limit ${limit}`,
    });

    /* ---- Cari kartı ilişkisi: satın alma siparişleri ------------------ */
    registerPartnerRelation({
      anahtar: 'satinalma', etiket: 'Satın alma', sira: 60, modul: 'purchasing',
      izin: 'purchasing.order.read.all',
      ozet: async (tx, id) => {
        const [r] = await tx`
          select count(*)::int as adet, coalesce(sum(total), 0)::text as toplam
          from purchasing.orders where partner_id = ${id} and status <> 'cancelled'`;
        return r as { adet: number; toplam: string };
      },
      satirlar: (tx, id, limit) => tx`
        select id, number, status, order_date, promised_date, total, currency,
               received_pct, line_count
        from purchasing.v_order_list where partner_id = ${id}
        order by order_date desc limit ${limit}`,
    });

    // ========================= Tedarikçi fiyatları =========================
    registerResource(app, {
      path: '/purchasing/supplier-prices',
      schema: 'purchasing', table: 'supplier_prices',
      columns: ['id', 'partner_id', 'product_id', 'supplier_sku', 'unit_price', 'currency',
        'uom_id', 'min_quantity', 'lead_time_days', 'valid_from', 'valid_to', 'is_active',
        'created_at', 'updated_at'],
      writable: ['partner_id', 'product_id', 'supplier_sku', 'unit_price', 'currency', 'uom_id',
        'min_quantity', 'lead_time_days', 'valid_from', 'valid_to', 'is_active'],
      searchable: ['supplier_sku'],
      defaultSort: 'valid_from',
    });

    // ========================= Talepler =========================
    registerResource(app, {
      path: '/purchasing/requisitions',
      schema: 'purchasing', table: 'requisitions', readFrom: 'v_requisition_list',
      columns: [...REQ_COLUMNS],
      // number/status/tutarlar yazılamaz: numarayı sekans, durumu iş akışı,
      // tutarları satır trigger'ları belirler.
      writable: ['branch_id', 'suggested_partner_id', 'request_date', 'needed_by',
        'currency', 'justification', 'notes', 'owner_id'],
      filterable: [...REQ_COLUMNS],
      searchable: ['number', 'justification'],
      sortable: [...REQ_COLUMNS],
      defaultSort: 'request_date',
    });

    registerResource(app, {
      path: '/purchasing/requisition-lines',
      schema: 'purchasing', table: 'requisition_lines',
      columns: [...LINE_COLUMNS, 'requisition_id'],
      writable: ['requisition_id', 'sequence', 'product_id', 'description', 'quantity',
        'uom_id', 'unit_price', 'discount_pct', 'tax_id'],
      defaultSort: 'sequence', defaultOrder: 'asc',
    });

    // ========================= Siparişler =========================
    registerResource(app, {
      path: '/purchasing/orders',
      schema: 'purchasing', table: 'orders', readFrom: 'v_order_list',
      columns: [...ORDER_COLUMNS],
      writable: ['branch_id', 'partner_id', 'order_date', 'promised_date', 'currency',
        'payment_term_days', 'supplier_ref', 'notes', 'owner_id'],
      filterable: [...ORDER_COLUMNS],
      searchable: ['number', 'supplier_ref', 'partner_name'],
      sortable: [...ORDER_COLUMNS],
      defaultSort: 'order_date',
    });

    registerResource(app, {
      path: '/purchasing/order-lines',
      schema: 'purchasing', table: 'order_lines',
      columns: [...LINE_COLUMNS, 'order_id', 'requisition_line_id', 'received_quantity'],
      // received_quantity YAZILAMAZ: mal kabul akışı ilerletir.
      writable: ['order_id', 'requisition_line_id', 'sequence', 'product_id', 'description',
        'quantity', 'uom_id', 'unit_price', 'discount_pct', 'tax_id'],
      defaultSort: 'sequence', defaultOrder: 'asc',
    });

    // ========================= Mal kabul =========================
    registerResource(app, {
      path: '/purchasing/receipts',
      schema: 'purchasing', table: 'receipts', readFrom: 'v_receipt_list',
      columns: [...RECEIPT_COLUMNS],
      writable: ['branch_id', 'order_id', 'partner_id', 'receipt_date', 'waybill_no',
        'notes', 'owner_id'],
      filterable: [...RECEIPT_COLUMNS],
      searchable: ['number', 'waybill_no', 'partner_name'],
      sortable: [...RECEIPT_COLUMNS],
      defaultSort: 'receipt_date',
    });

    registerResource(app, {
      path: '/purchasing/receipt-lines',
      schema: 'purchasing', table: 'receipt_lines',
      columns: ['id', 'receipt_id', 'order_line_id', 'sequence', 'quantity',
        'rejected_quantity', 'reject_reason', 'created_at'],
      writable: ['receipt_id', 'order_line_id', 'sequence', 'quantity',
        'rejected_quantity', 'reject_reason'],
      defaultSort: 'sequence', defaultOrder: 'asc',
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

    // `select * from fn(x)` — `select (fn(x)).*` fonksiyonu kolon başına
    // yeniden çalıştırırdı (bkz. CRM modülündeki aynı not).
    action('/purchasing/requisitions/:id/submit', async (tx, id) => {
      const [row] = await tx`select * from purchasing.submit_requisition(${id})`;
      return row;
    });

    action('/purchasing/requisitions/:id/approve', async (tx, id) => {
      const [row] = await tx`select * from purchasing.approve_requisition(${id})`;
      return row;
    });

    action('/purchasing/requisitions/:id/reject', async (tx, id, body) => {
      const [row] = await tx`
        select * from purchasing.reject_requisition(${id}, ${(body.reason as string) ?? null})`;
      return row;
    });

    action('/purchasing/requisitions/:id/create-order', async (tx, id, body) => {
      if (!body.partner_id) throw badRequest('partner_id zorunlu — tedarikçi seçilmeli');
      const [row] = await tx`
        select * from purchasing.create_order_from_requisition(${id}, ${body.partner_id as string})`;
      return row;
    });

    action('/purchasing/orders/:id/confirm', async (tx, id) => {
      const [row] = await tx`select * from purchasing.confirm_order(${id})`;
      return row;
    });

    action('/purchasing/orders/:id/cancel', async (tx, id, body) => {
      const [row] = await tx`
        select * from purchasing.cancel_order(${id}, ${(body.reason as string) ?? null})`;
      return row;
    });

    action('/purchasing/receipts/:id/confirm', async (tx, id) => {
      const [row] = await tx`select * from purchasing.confirm_receipt(${id})`;
      return row;
    });

    /** Bir ürün+miktar için önerilen tedarikçi fiyatı (sipariş satırı açarken). */
    app.get('/purchasing/best-price', async (req) => {
      const q = req.query as { product_id?: string; quantity?: string; partner_id?: string };
      if (!q.product_id) throw badRequest('product_id zorunlu');
      return run(req, async (tx) => {
        const [row] = await tx`
          select * from purchasing.best_supplier_price(
            ${q.product_id!}, ${Number(q.quantity ?? 1)}, ${q.partner_id ?? null})`;
        return { data: row?.id ? row : null };
      });
    });

    /** Belge + satırları tek çağrıda. */
    const full = (path: string, view: string, lineTable: string, fk: string) => {
      app.get(path, async (req) => {
        const { id } = req.params as { id: string };
        return run(req, async (tx) => {
          const [header] = await tx`
            select * from ${tx('purchasing')}.${tx(view)} where id = ${id}`;
          if (!header) throw notFound();
          const lines = await tx`
            select l.*, pr.sku, t.code as tax_code, t.rate as tax_rate, uo.code as uom_code
            from ${tx('purchasing')}.${tx(lineTable)} l
            left join core.products pr on pr.id = l.product_id
            left join core.taxes t on t.id = l.tax_id
            left join core.uoms uo on uo.id = l.uom_id
            where l.${tx(fk)} = ${id} order by l.sequence`;
          return { data: { ...header, lines } };
        });
      });
    };

    full('/purchasing/requisitions/:id/full', 'v_requisition_list',
         'requisition_lines', 'requisition_id');
    full('/purchasing/orders/:id/full', 'v_order_list', 'order_lines', 'order_id');

    /** Mal kabul dökümü — satırlar sipariş satırına bağlı olduğu için ayrı sorgu. */
    app.get('/purchasing/receipts/:id/full', async (req) => {
      const { id } = req.params as { id: string };
      return run(req, async (tx) => {
        const [header] = await tx`select * from purchasing.v_receipt_list where id = ${id}`;
        if (!header) throw notFound();
        const lines = await tx`
          select rl.*, ol.description, ol.product_id, ol.quantity as ordered_quantity,
                 ol.received_quantity, ol.unit_price, pr.sku, uo.code as uom_code
          from purchasing.receipt_lines rl
          join purchasing.order_lines ol on ol.id = rl.order_line_id
          left join core.products pr on pr.id = ol.product_id
          left join core.uoms uo on uo.id = ol.uom_id
          where rl.receipt_id = ${id} order by rl.sequence`;
        return { data: { ...header, lines } };
      });
    });

    // ========================= Raporlar =========================
    app.get('/purchasing/reports/supplier-performance', async (req) =>
      run(req, async (tx) => ({
        data: await tx`
          select * from purchasing.v_supplier_performance
          order by total_spend desc nulls last`,
      })));

    app.get('/purchasing/reports/price-history', async (req) => {
      const { product_id } = req.query as { product_id?: string };
      return run(req, async (tx) => ({
        data: await tx`
          select * from purchasing.v_price_history
          where (${product_id ?? null}::uuid is null or product_id = ${product_id ?? null}::uuid)
          order by order_date desc, product_name`,
      }));
    });

    app.get('/purchasing/reports/open-orders', async (req) =>
      run(req, async (tx) => ({
        data: await tx`
          select * from purchasing.v_open_orders
          order by overdue_days desc nulls last, promised_date`,
      })));
  },
};

export default purchasingModule;
