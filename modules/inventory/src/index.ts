import type { FastifyInstance, FastifyRequest } from 'fastify';
import {
  registerResource, registerNotificationSource, withContext, contextFromRequest,
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

const MOVE_COLUMNS = ['id', 'branch_id', 'number', 'move_date', 'state', 'product_id',
  'sku', 'product_name', 'lot_id', 'lot_code', 'expiry_date',
  'from_location_id', 'from_code', 'to_location_id', 'to_code',
  'direction', 'signed_quantity', 'quantity', 'unit_cost', 'total_cost',
  'source_module', 'source_table', 'source_id', 'reference', 'branch_name'] as const;

const STOCK_COLUMNS = ['product_id', 'sku', 'product_name', 'kind', 'uom_code',
  'warehouse_id', 'warehouse_name', 'branch_id', 'branch_name',
  'quantity', 'reserved', 'available', 'average_cost', 'stock_value'] as const;

export const inventoryModule: SezraModule = {
  code: 'inventory',

  register(app: FastifyInstance) {
    /* ---- Bildirim: kritik seviyeye düşen stok ------------------------
       Depo sorumlusu bunu ancak stok ekranına bakarsa görür; bildirim onu
       ekranın önüne getirir. Sipariş açılmazsa üretim durur. */
    registerNotificationSource({
      ad: 'inventory.reorder', modul: 'inventory', izin: 'inventory.stock.read.all',
      uret: (tx, limit) => tx`
        select product_id, sku, product_name, on_hand, min_quantity, suggested_quantity
        from inventory.v_reorder_alerts
        order by on_hand asc limit ${limit}`
        .then((r) => r.map((x) => {
          const p = x as {
            product_id: string; sku: string; product_name: string;
            on_hand: string; min_quantity: string; suggested_quantity: string;
          };
          return {
            key: `inventory.reorder:${p.product_id}`,
            baslik: `${p.product_name} kritik seviyede`,
            metin: `${p.sku} — elde ${p.on_hand}, asgari ${p.min_quantity}. `
                 + `Önerilen sipariş ${p.suggested_quantity}.`,
            ton: (Number(p.on_hand) <= 0 ? 'tehlike' : 'uyari') as 'tehlike' | 'uyari',
            yol: '/inventory/alerts',
            zaman: null,
          };
        })),
    });

    // ========================= Depo ve konumlar =========================
    registerResource(app, {
      path: '/inventory/warehouses',
      schema: 'inventory', table: 'warehouses',
      columns: ['id', 'branch_id', 'code', 'name', 'address', 'is_default', 'is_active',
        'created_at', 'updated_at'],
      writable: ['branch_id', 'code', 'name', 'address', 'is_default', 'is_active'],
      searchable: ['code', 'name'],
      defaultSort: 'name', defaultOrder: 'asc',
    });

    registerResource(app, {
      path: '/inventory/locations',
      schema: 'inventory', table: 'locations',
      columns: ['id', 'warehouse_id', 'parent_id', 'code', 'name', 'kind', 'is_active'],
      writable: ['warehouse_id', 'parent_id', 'code', 'name', 'kind', 'is_active'],
      searchable: ['code', 'name'],
      defaultSort: 'code', defaultOrder: 'asc',
    });

    registerResource(app, {
      path: '/inventory/lots',
      schema: 'inventory', table: 'lots',
      columns: ['id', 'product_id', 'code', 'production_date', 'expiry_date', 'supplier_lot',
        'notes', 'created_at'],
      writable: ['product_id', 'code', 'production_date', 'expiry_date', 'supplier_lot', 'notes'],
      searchable: ['code', 'supplier_lot'],
      defaultSort: 'expiry_date', defaultOrder: 'asc',
    });

    // ========================= Hareketler =========================
    registerResource(app, {
      path: '/inventory/moves',
      schema: 'inventory', table: 'moves', readFrom: 'v_stock_ledger',
      columns: [...MOVE_COLUMNS],
      // unit_cost/total_cost/state/number YAZILAMAZ: maliyeti değerleme motoru,
      // durumu post_move, numarayı sekans belirler.
      writable: ['branch_id', 'product_id', 'lot_id', 'from_location_id', 'to_location_id',
        'quantity', 'uom_id', 'move_date', 'reference', 'notes', 'owner_id'],
      filterable: [...MOVE_COLUMNS],
      searchable: ['number', 'reference', 'product_name', 'sku'],
      sortable: [...MOVE_COLUMNS],
      defaultSort: 'move_date',
    });

    // Stok durumu — türetilmiş, yalnızca okunur
    registerResource(app, {
      path: '/inventory/stock',
      schema: 'inventory', table: 'quants', readFrom: 'v_stock_on_hand',
      columns: [...STOCK_COLUMNS],
      writable: [],
      filterable: [...STOCK_COLUMNS],
      searchable: ['sku', 'product_name'],
      sortable: [...STOCK_COLUMNS],
      defaultSort: 'product_name', defaultOrder: 'asc',
    });

    // ========================= Sayım =========================
    registerResource(app, {
      path: '/inventory/counts',
      schema: 'inventory', table: 'counts',
      columns: ['id', 'branch_id', 'number', 'warehouse_id', 'count_date', 'status',
        'notes', 'applied_at', 'owner_id', 'created_at'],
      writable: ['branch_id', 'warehouse_id', 'count_date', 'notes', 'owner_id'],
      defaultSort: 'count_date',
    });

    registerResource(app, {
      path: '/inventory/count-lines',
      schema: 'inventory', table: 'count_lines',
      // created_at LISTEDE olmak zorunda: varsayilan siralama alani da bu ve
      // `sortable` kolonlardan tureniyor. Yoksa uc her istekte "Siralanamayan
      // alan: created_at" ile 400 donuyordu -- yani sayim satirlari HIC
      // okunamiyordu. Ayrica alan kendi basina anlamli: okutma sirasi.
      columns: ['id', 'count_id', 'location_id', 'product_id', 'lot_id',
        'system_quantity', 'counted_quantity', 'difference', 'notes', 'created_at'],
      // difference generated; system_quantity sayım anında dondurulur
      writable: ['count_id', 'location_id', 'product_id', 'lot_id',
        'system_quantity', 'counted_quantity', 'notes'],
      defaultSort: 'created_at', defaultOrder: 'asc',
    });

    registerResource(app, {
      path: '/inventory/barcodes',
      schema: 'inventory', table: 'barcodes',
      columns: ['id', 'product_id', 'code', 'quantity', 'uom_id', 'kind', 'is_gtin',
        'is_active', 'created_at', 'updated_at'],
      writable: ['product_id', 'code', 'quantity', 'uom_id', 'kind', 'is_gtin', 'is_active'],
      searchable: ['code'],
      defaultSort: 'code', defaultOrder: 'asc',
    });

    registerResource(app, {
      path: '/inventory/reorder-rules',
      schema: 'inventory', table: 'reorder_rules',
      columns: ['id', 'branch_id', 'product_id', 'warehouse_id', 'min_quantity',
        'max_quantity', 'is_active', 'last_alert_at'],
      writable: ['branch_id', 'product_id', 'warehouse_id', 'min_quantity', 'max_quantity',
        'is_active'],
      defaultSort: 'min_quantity',
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

    action('/inventory/moves/:id/post', async (tx, id) => {
      const [row] = await tx`select * from inventory.post_move(${id})`;
      return row;
    });

    action('/inventory/counts/:id/apply', async (tx, id) => {
      const [row] = await tx`select * from inventory.apply_count(${id})`;
      return row;
    });

    /**
     * Sayım sayfasını açar: depodaki mevcut bakiyeleri satır olarak yazar.
     * Sistem miktarı O AN dondurulur — sayım sürerken stok hareket ederse
     * fark yanlış hesaplanmasın (bkz. 0500 count_lines yorumu).
     */
    app.post('/inventory/counts/:id/populate', async (req) => {
      const { id } = req.params as { id: string };
      return run(req, async (tx) => {
        const rows = await tx`
          insert into inventory.count_lines
            (count_id, location_id, product_id, lot_id, system_quantity, counted_quantity)
          select ${id}, q.location_id, q.product_id, q.lot_id, q.quantity, q.quantity
          from inventory.quants q
          join inventory.locations l on l.id = q.location_id
          join inventory.counts c on c.id = ${id}
          where l.warehouse_id = c.warehouse_id and q.quantity <> 0
          returning id`;
        return { data: { inserted: rows.length } };
      });
    });

    /**
     * Barkod çözümleme: okutulan kodun hangi ürün ve KAÇ ADET olduğunu döner.
     * Koli barkodu okutulduğunda multiplier 1 değil (ör. 12) gelir — çağıran
     * taraf çarpanı kendi hesaplamaz.
     */
    app.get('/inventory/barcode/:code', async (req) => {
      const { code } = req.params as { code: string };
      return run(req, async (tx) => {
        const [row] = await tx`select * from inventory.resolve_barcode(${code})`;
        if (!row || !(row as { product_id?: string }).product_id) {
          // Tanınmayan barkod bir SUNUCU HATASI değil, "kayıt yok"tur.
          // Ham Error fırlatmak bunu 500 yapardı ve okutan kişiye
          // "beklenmeyen hata" derdi; oysa yapması gereken ürünü eşleştirmek.
          throw notFound(`Barkod tanınmadı: ${code}`);
        }
        // Okutan kişi genelde "bu üründen elimde kaç var" da bilmek ister
        const stock = await tx`
          select warehouse_name, quantity, reserved, available
          from inventory.v_stock_on_hand
          where product_id = ${(row as { product_id: string }).product_id}`;
        return { data: { ...row, stock } };
      });
    });

    /** Okutarak sayım: her okutma sayım satırını artırır. */
    app.post('/inventory/counts/:id/scan', async (req) => {
      const { id } = req.params as { id: string };
      const b = (req.body ?? {}) as Record<string, unknown>;
      if (!b.barcode) throw badRequest('barcode zorunlu');
      return run(req, async (tx) => {
        const [row] = await tx`
          select * from inventory.scan_to_count(
            ${id}, ${b.barcode as string}, ${Number(b.quantity ?? 1)},
            ${(b.location_id as string) ?? null})`;
        return { data: row };
      });
    });

    /** Elle stok girişi (açılış stoğu, üretimden giriş). */
    app.post('/inventory/receive', async (req) => {
      const b = (req.body ?? {}) as Record<string, unknown>;
      if (!b.product_id || !b.quantity) throw badRequest('product_id ve quantity zorunlu');
      return run(req, async (tx) => {
        const [me] = await tx`select core.current_tenant_id() as t`;
        const [row] = await tx`
          select inventory.receive_stock(
            ${(me as { t: string }).t}, ${(b.branch_id as string) ?? null},
            ${b.product_id as string}, ${Number(b.quantity)},
            ${Number(b.unit_cost ?? 0)}, ${(b.lot_id as string) ?? null},
            'manual', 'inventory', null, ${(b.reference as string) ?? 'Elle giriş'}) as move_id`;
        return { data: row };
      });
    });

    /** Rezervasyonu sevkiyata çevirir (kaynak belge bazında). */
    app.post('/inventory/ship', async (req) => {
      const b = (req.body ?? {}) as Record<string, unknown>;
      if (!b.source_module || !b.source_id) {
        throw badRequest('source_module ve source_id zorunlu');
      }
      return run(req, async (tx) => {
        const [row] = await tx`
          select inventory.ship_reservation(
            ${b.source_module as string},
            ${(b.source_table as string) ?? 'sale_orders'},
            ${b.source_id as string}) as shipped`;
        return { data: row };
      });
    });

    // ========================= Raporlar =========================
    app.get('/inventory/reports/expiring', async (req) => {
      const { days } = req.query as { days?: string };
      return run(req, async (tx) => ({
        data: await tx`
          select * from inventory.v_expiring_stock
          where days_left <= ${Number(days ?? 30)}
          order by days_left`,
      }));
    });

    app.get('/inventory/reports/reorder-alerts', async (req) =>
      run(req, async (tx) => ({
        data: await tx`
          select * from inventory.v_reorder_alerts order by on_hand, product_name`,
      })));

    app.get('/inventory/reports/valuation', async (req) =>
      run(req, async (tx) => ({
        data: await tx`select * from inventory.v_stock_valuation`,
      })));

    app.get('/inventory/reports/ledger', async (req) => {
      const { product_id, limit } = req.query as { product_id?: string; limit?: string };
      return run(req, async (tx) => ({
        data: await tx`
          select * from inventory.v_stock_ledger
          where (${product_id ?? null}::uuid is null or product_id = ${product_id ?? null}::uuid)
            and state = 'done'
          order by move_date desc
          limit ${Math.min(Number(limit ?? 200), 500)}`,
      }));
    });
  },
};

export default inventoryModule;
