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

const SESSION_COLUMNS = ['id', 'branch_id', 'number', 'status', 'terminal_id',
  'terminal_code', 'terminal_name', 'opened_at', 'closed_at',
  'opened_by', 'opened_by_name', 'closed_by', 'closed_by_name',
  'opening_cash', 'counted_cash', 'expected_cash', 'cash_difference',
  'order_count', 'gross_sales', 'discount_total', 'tax_total', 'net_sales',
  'refund_total', 'branch_name', 'notes', 'hours_open'] as const;

const ORDER_COLUMNS = ['id', 'branch_id', 'receipt_no', 'status', 'session_id',
  'session_number', 'terminal_id', 'terminal_code', 'ordered_at', 'synced_at',
  'client_seq', 'cashier_id', 'cashier_name', 'partner_id', 'partner_name',
  'subtotal', 'discount_total', 'tax_total', 'total', 'paid_total', 'change_given',
  'refund_of_id', 'refund_of_receipt', 'branch_name', 'note',
  'line_count', 'payment_methods'] as const;

export const posModule: SezraModule = {
  code: 'pos',

  register(app: FastifyInstance) {
    registerResource(app, {
      path: '/pos/terminals',
      schema: 'pos', table: 'terminals',
      columns: ['id', 'branch_id', 'code', 'name', 'warehouse_id', 'prices_include_tax',
        'is_active', 'created_at'],
      writable: ['branch_id', 'code', 'name', 'warehouse_id', 'prices_include_tax',
        'device_key', 'is_active'],
      searchable: ['code', 'name'],
      defaultSort: 'code', defaultOrder: 'asc',
    });

    registerResource(app, {
      path: '/pos/sessions',
      schema: 'pos', table: 'sessions', readFrom: 'v_session_list',
      columns: [...SESSION_COLUMNS],
      // Tutarlar ve durum YAZILAMAZ: açılış/kapanış fonksiyonları belirler.
      writable: ['branch_id', 'terminal_id', 'notes', 'owner_id'],
      filterable: [...SESSION_COLUMNS],
      searchable: ['number', 'terminal_code'],
      sortable: [...SESSION_COLUMNS],
      defaultSort: 'opened_at',
    });

    registerResource(app, {
      path: '/pos/orders',
      schema: 'pos', table: 'orders', readFrom: 'v_order_list',
      columns: [...ORDER_COLUMNS],
      // id İSTEMCİDEN gelebilir (offline kimlik); tutarlar satırlardan türetilir.
      writable: ['id', 'branch_id', 'session_id', 'terminal_id', 'client_seq',
        'ordered_at', 'partner_id', 'cashier_id', 'note'],
      filterable: [...ORDER_COLUMNS],
      searchable: ['receipt_no', 'note'],
      sortable: [...ORDER_COLUMNS],
      defaultSort: 'ordered_at',
    });

    registerResource(app, {
      path: '/pos/order-lines',
      schema: 'pos', table: 'order_lines',
      columns: ['id', 'order_id', 'sequence', 'product_id', 'sku', 'name', 'quantity',
        'uom_code', 'unit_price', 'discount_pct', 'tax_id', 'tax_rate',
        'line_subtotal', 'line_tax', 'line_total', 'note'],
      writable: ['order_id', 'sequence', 'product_id', 'sku', 'name', 'quantity',
        'uom_code', 'unit_price', 'discount_pct', 'tax_id', 'tax_rate', 'note'],
      defaultSort: 'sequence', defaultOrder: 'asc',
    });

    registerResource(app, {
      path: '/pos/payments',
      schema: 'pos', table: 'payments',
      columns: ['id', 'order_id', 'method', 'amount', 'reference', 'card_last4', 'created_at'],
      writable: ['order_id', 'method', 'amount', 'reference', 'card_last4'],
      defaultSort: 'created_at', defaultOrder: 'asc',
    });

    registerResource(app, {
      path: '/pos/cash-movements',
      schema: 'pos', table: 'cash_movements',
      columns: ['id', 'session_id', 'direction', 'amount', 'reason', 'created_at'],
      writable: ['session_id', 'direction', 'amount', 'reason'],
      defaultSort: 'created_at', defaultOrder: 'asc',
    });

    // ========================= Eylemler =========================
    app.post('/pos/sessions/open', async (req) => {
      const b = (req.body ?? {}) as Record<string, unknown>;
      if (!b.terminal_id) throw badRequest('terminal_id zorunlu');
      return run(req, async (tx) => {
        const [row] = await tx`
          select * from pos.open_session(
            ${b.terminal_id as string}, ${Number(b.opening_cash ?? 0)})`;
        return { data: row };
      });
    });

    app.post('/pos/sessions/:id/close', async (req) => {
      const { id } = req.params as { id: string };
      const b = (req.body ?? {}) as Record<string, unknown>;
      if (b.counted_cash === undefined) throw badRequest('counted_cash zorunlu');
      return run(req, async (tx) => {
        const [row] = await tx`
          select * from pos.close_session(
            ${id}, ${Number(b.counted_cash)}, ${(b.notes as string) ?? null})`;
        return { data: row };
      });
    });

    /** Kapanmadan önce kasada olması gereken nakit — sayım ekranı bunu gösterir. */
    app.get('/pos/sessions/:id/expected-cash', async (req) => {
      const { id } = req.params as { id: string };
      return run(req, async (tx) => {
        const [row] = await tx`select pos.expected_cash(${id}) as expected_cash`;
        return { data: row };
      });
    });

    app.post('/pos/orders/:id/finalize', async (req) => {
      const { id } = req.params as { id: string };
      return run(req, async (tx) => {
        const [row] = await tx`select * from pos.finalize_order(${id})`;
        return { data: row };
      });
    });

    app.post('/pos/orders/:id/refund', async (req) => {
      const { id } = req.params as { id: string };
      const b = (req.body ?? {}) as Record<string, unknown>;
      if (!b.session_id) throw badRequest('session_id zorunlu — iade açık kasaya işlenir');
      return run(req, async (tx) => {
        const [row] = await tx`
          select * from pos.refund_order(
            ${id}, ${b.session_id as string}, ${(b.reason as string) ?? null})`;
        return { data: row };
      });
    });

    /**
     * OFFLINE SENKRONİZASYON.
     *
     * Kasa internetsizken fişleri kendi ürettiği uuid'lerle biriktirir; bağlantı
     * gelince hepsini tek pakette gönderir. Uç İDEMPOTENTTİR: aynı paket ağ
     * hatası yüzünden iki kez ulaşsa da fişler çoğalmaz (0801'deki sync_orders).
     * Bu yüzden kasa istemcisi "gönderdim mi?" sorusunu çözmek zorunda değildir —
     * emin olmadığında yeniden gönderir.
     */
    app.post('/pos/sync', async (req) => {
      const b = (req.body ?? {}) as Record<string, unknown>;
      const orders = b.orders;
      if (!Array.isArray(orders)) throw badRequest('orders dizisi zorunlu');
      if (orders.length > 500) {
        throw badRequest('Tek pakette en fazla 500 fiş gönderilebilir');
      }
      return run(req, async (tx) => {
        // `::text::jsonb` — ZORUNLU ARA ADIM.
        // Doğrudan `::jsonb` yazılırsa sürücü parametre tipini jsonb olarak
        // çözüyor ve metni BİR KEZ DAHA JSON'a kodluyor; dizi, JSON string'ine
        // dönüşüp "cannot extract elements from a scalar" hatası veriyor.
        // Önce text'e bağlayıp SQL içinde jsonb'ye çevirmek bunu keser.
        const [row] = await tx`
          select pos.sync_orders(${JSON.stringify(orders)}::text::jsonb) as result`;
        return { data: (row as { result: unknown }).result };
      });
    });

    /**
     * KASA KATALOĞU — istemcinin çevrimdışı çalışabilmesi için tek çağrılık paket.
     *
     * Ürün, fiyat, KDV oranı ve barkodlar TEK yanıtta döner; kasa bunu yerelde
     * saklar ve internet kesildiğinde ondan satış yapar. Üç ayrı uca (ürün,
     * vergi, barkod) bölmek, kasanın açılışta üç isteğin de başarılı olmasına
     * bağımlı olması demekti.
     */
    app.get('/pos/catalog', async (req) => {
      const { terminal_id } = req.query as { terminal_id?: string };
      if (!terminal_id) throw badRequest('terminal_id zorunlu');
      return run(req, async (tx) => {
        const [terminal] = await tx`
          select id, code, name, branch_id, prices_include_tax
          from pos.terminals where id = ${terminal_id} and is_active`;
        if (!terminal) throw notFound('Terminal bulunamadı ya da pasif');

        const products = await tx`
          select p.id, p.sku, p.name, p.sale_price, p.sale_tax_id,
                 coalesce(t.rate, 0) as tax_rate,
                 coalesce(
                   array_remove(array_agg(distinct b.code), null) || 
                   case when p.barcode is not null then array[p.barcode] else '{}'::text[] end,
                   '{}'::text[]) as barcodes
          from core.products p
          left join core.taxes t on t.id = p.sale_tax_id
          left join inventory.barcodes b
            on b.product_id = p.id and b.is_active and b.quantity = 1
          where p.is_active and p.is_sellable
          group by p.id, p.sku, p.name, p.sale_price, p.sale_tax_id, t.rate, p.barcode
          order by p.name`;

        return {
          data: {
            fetched_at: new Date().toISOString(),
            terminal,
            products,
          },
        };
      });
    });

    /** Fiş dökümü — satırlar ve ödemelerle. */
    app.get('/pos/orders/:id/full', async (req) => {
      const { id } = req.params as { id: string };
      return run(req, async (tx) => {
        const [header] = await tx`select * from pos.v_order_list where id = ${id}`;
        if (!header) throw notFound();
        const lines = await tx`
          select * from pos.order_lines where order_id = ${id} order by sequence`;
        const payments = await tx`
          select * from pos.payments where order_id = ${id} order by created_at`;
        return { data: { ...header, lines, payments } };
      });
    });

    /** Z raporu: oturum özeti + ödeme kırılımı + kasa hareketleri. */
    app.get('/pos/sessions/:id/z-report', async (req) => {
      const { id } = req.params as { id: string };
      return run(req, async (tx) => {
        const [header] = await tx`select * from pos.v_session_list where id = ${id}`;
        if (!header) throw notFound();
        const payments = await tx`
          select method, payment_count, amount from pos.v_payment_breakdown
          where session_id = ${id} order by method`;
        const movements = await tx`
          select * from pos.cash_movements where session_id = ${id} order by created_at`;
        const products = await tx`
          select l.sku, l.name, sum(l.quantity) as quantity, sum(l.line_total) as total
          from pos.order_lines l
          join pos.orders o on o.id = l.order_id
          where o.session_id = ${id} and o.status = 'paid'
          group by l.sku, l.name
          order by sum(l.line_total) desc
          limit 20`;
        return { data: { ...header, payments, movements, products } };
      });
    });

    // ========================= Raporlar =========================
    app.get('/pos/reports/daily-sales', async (req) => {
      const { from, to } = req.query as { from?: string; to?: string };
      return run(req, async (tx) => ({
        data: await tx`
          select * from pos.v_daily_sales
          where (${from ?? null}::date is null or sale_date >= ${from ?? null}::date)
            and (${to ?? null}::date is null or sale_date <= ${to ?? null}::date)
          order by sale_date desc, branch_name`,
      }));
    });

    app.get('/pos/reports/hourly-sales', async (req) =>
      run(req, async (tx) => ({
        data: await tx`
          select * from pos.v_hourly_sales order by day_of_week, hour_of_day`,
      })));

    app.get('/pos/reports/product-sales', async (req) =>
      run(req, async (tx) => ({
        data: await tx`
          select * from pos.v_product_sales order by gross_sales desc nulls last limit 100`,
      })));

    app.get('/pos/reports/payment-breakdown', async (req) =>
      run(req, async (tx) => ({
        data: await tx`
          select method, sum(payment_count) as payment_count, sum(amount) as amount
          from pos.v_payment_breakdown
          group by method order by sum(amount) desc`,
      })));
  },
};

export default posModule;
