import type { FastifyInstance, FastifyRequest } from 'fastify';
import {
  registerResource, registerSearchSource, registerNotificationSource,
  registerPartnerRelation,
  withContext, contextFromRequest,
  translatePgError, notFound, badRequest, type SezraModule, type Tx,
} from '@sezra/core';
import { getEInvoiceProvider } from './einvoice/registry.js';
import type { CanonicalInvoice, CanonicalLine, EInvoiceProfile } from './einvoice/types.js';

async function run<T>(req: FastifyRequest, fn: (tx: Tx) => Promise<T>): Promise<T> {
  const ctx = contextFromRequest(req);
  try {
    return await withContext(ctx, fn);
  } catch (err) {
    throw translatePgError(err);
  }
}

const INVOICE_COLUMNS = ['id', 'branch_id', 'kind', 'number', 'partner_id', 'issue_date',
  'due_date', 'status', 'currency', 'exchange_rate', 'subtotal', 'discount_total',
  'tax_total', 'withholding_total', 'total', 'paid_total', 'payment_term_days', 'notes',
  'journal_entry_id', 'source_module', 'source_table', 'source_id', 'owner_id',
  'created_at', 'updated_at'] as const;

const ENTRY_COLUMNS = ['id', 'branch_id', 'journal_id', 'period_id', 'number', 'entry_date',
  'reference', 'description', 'status', 'currency', 'exchange_rate', 'total_debit',
  'total_credit', 'source_module', 'source_table', 'source_id', 'reversal_of_id',
  'posted_at', 'owner_id', 'created_at', 'updated_at'] as const;

const PAYMENT_COLUMNS = ['id', 'branch_id', 'direction', 'number', 'partner_id', 'payment_date',
  'method', 'bank_account_id', 'amount', 'currency', 'allocated_total', 'status',
  'reference', 'notes', 'journal_entry_id', 'owner_id', 'created_at', 'updated_at'] as const;

const TRANSFER_COLUMNS = ['id', 'branch_id', 'number', 'transfer_date',
  'source_account_id', 'source_bank_account_id', 'dest_account_id', 'dest_bank_account_id',
  'source_currency', 'dest_currency', 'source_amount', 'dest_amount', 'exchange_rate',
  'status', 'reference', 'description', 'notes', 'journal_entry_id',
  'cancelled_at', 'cancel_reason', 'owner_id', 'created_at', 'updated_at'] as const;

/** UN/ECE birim kodu eşlemesi — UBL-TR bunu ister. */
const UOM_TO_UNECE: Record<string, string> = {
  ADET: 'C62', PAKET: 'PK', KOLI: 'BX', KG: 'KGM', GR: 'GRM',
  LT: 'LTR', ML: 'MLT', SAAT: 'HUR',
};

export const financeModule: SezraModule = {
  code: 'finance',

  register(app: FastifyInstance) {
    /* ---- Çek / senet ------------------------------------------------- */
    registerResource(app, {
      path: '/finance/notes',
      schema: 'finance', table: 'notes', readFrom: 'v_note_list',
      columns: ['id', 'branch_id', 'kind', 'direction', 'status', 'number', 'serial_no',
        'partner_id', 'partner_name', 'drawer_name', 'bank_name', 'bank_branch',
        'bank_account', 'issue_place', 'issue_date', 'due_date', 'amount', 'currency',
        'bank_account_id', 'bank_account_name', 'endorsed_to_id', 'endorsed_to_name',
        'payment_id', 'status_at', 'notes', 'owner_id', 'owner_name', 'branch_name',
        'kalan_gun', 'vadesi_gecti', 'created_at', 'updated_at'],
      // DURUM YAZILAMAZ: geçişler `note_set_status` üzerinden yapılır. Serbest
      // bir UPDATE, tahsil edilmiş bir çeki portföye geri döndürmeye izin
      // verirdi ve durum makinesi anlamını yitirirdi.
      writable: ['branch_id', 'kind', 'direction', 'serial_no', 'partner_id',
        'drawer_name', 'bank_name', 'bank_branch', 'bank_account', 'issue_place',
        'issue_date', 'due_date', 'amount', 'currency', 'notes', 'owner_id'],
      searchable: ['number', 'serial_no', 'drawer_name', 'bank_name', 'partner_name'],
      defaultSort: 'due_date', defaultOrder: 'asc',
    });

    /** Çek/senedin durumunu değiştirir. Kurallar veritabanında. */
    app.post('/finance/notes/:id/status', async (req) => {
      const { id } = req.params as { id: string };
      const b = (req.body ?? {}) as {
        status?: unknown; bank_account_id?: unknown;
        endorsed_to_id?: unknown; note?: unknown;
      };
      if (typeof b.status !== 'string') throw badRequest('status zorunlu');
      return run(req, async (tx) => {
        const [row] = await tx`
          select * from finance.note_set_status(
            ${id}, ${b.status as string}::finance.note_status,
            ${(b.bank_account_id as string) ?? null},
            ${(b.endorsed_to_id as string) ?? null},
            ${(b.note as string) ?? null})`;
        return { data: row };
      });
    });

    /**
     * Portföy özeti: vade dilimlerine göre elde duran evrak.
     *
     * "Ne kadar çekim var" sorusunun cevabı tek bir toplam değildir; bu ayın
     * ve gelecek ayın vadeleri ayrı ayrı bilinmeden nakit planı yapılamaz.
     */
    app.get('/finance/reports/note-portfolio', async (req) => run(req, async (tx) => {
      const rows = await tx`
        select direction, kind,
               count(*)::int as adet,
               coalesce(sum(amount), 0) as toplam,
               coalesce(sum(amount) filter (where due_date < current_date), 0) as vadesi_gecen,
               coalesce(sum(amount) filter (
                 where due_date between current_date and current_date + 30), 0) as gun_30,
               coalesce(sum(amount) filter (
                 where due_date > current_date + 30), 0) as sonra
        from finance.notes
        where status in ('portfoy', 'tahsile_verildi')
        group by direction, kind
        order by direction, kind`;
      return { data: rows };
    }));

    /* ---- Bildirim: vadesi yaklaşan / geçen evrak --------------------- */
    registerNotificationSource({
      ad: 'finance.note.due', modul: 'finance', izin: 'finance.note.read.all',
      uret: (tx, limit) => tx`
        select id, number, kind, direction, partner_name, amount, currency, due_date,
               (current_date - due_date) as gecikme
        from finance.v_note_list
        where status in ('portfoy', 'tahsile_verildi')
          and due_date <= current_date + 7
        order by due_date asc limit ${limit}`
        .then((r) => r.map((x) => {
          const n = x as {
            id: string; number: string; kind: string; direction: string;
            partner_name: string | null; amount: string; currency: string;
            due_date: string; gecikme: number;
          };
          const tur = n.kind === 'cek' ? 'Çek' : 'Senet';
          const gecti = n.gecikme > 0;
          return {
            key: `finance.note.due:${n.id}`,
            baslik: gecti
              ? `${tur} ${n.number} vadesi ${n.gecikme} gün geçti`
              : `${tur} ${n.number} vadesi yaklaşıyor`,
            metin: `${n.partner_name ?? 'Cari yok'} — ${n.amount} ${n.currency}`
                 + (n.direction === 'in' ? ' (alınan)' : ' (verilen)'),
            ton: (gecti ? 'tehlike' : 'uyari') as 'tehlike' | 'uyari',
            yol: '/finance/notes',
            zaman: n.due_date,
          };
        })),
    });

    /* ---- Cari kartı ilişkileri --------------------------------------- */
    registerPartnerRelation({
      anahtar: 'cek', etiket: 'Çek / Senet', sira: 55, modul: 'finance',
      izin: 'finance.note.read.all',
      ozet: async (tx, id) => {
        const [r] = await tx`
          select count(*)::int as adet, coalesce(sum(amount), 0)::text as toplam
          from finance.notes where partner_id = ${id}`;
        return r as { adet: number; toplam: string };
      },
      satirlar: (tx, id, limit) => tx`
        select id, number, serial_no, kind, direction, status, bank_name,
               issue_date, due_date, amount, currency, kalan_gun, vadesi_gecti
        from finance.v_note_list where partner_id = ${id}
        order by due_date desc limit ${limit}`,
    });

    /* ---- Cari kartı ilişkileri --------------------------------------- */
    registerPartnerRelation({
      anahtar: 'fatura', etiket: 'Fatura', sira: 40, modul: 'finance',
      izin: 'finance.invoice.read.all',
      ozet: async (tx, id) => {
        const [r] = await tx`
          select count(*)::int as adet, coalesce(sum(total), 0)::text as toplam
          from finance.invoices where partner_id = ${id} and status <> 'cancelled'`;
        return r as { adet: number; toplam: string };
      },
      satirlar: (tx, id, limit) => tx`
        select id, kind, number, status, issue_date, due_date,
               total, paid_total, balance_due, currency, einvoice_status
        from finance.v_invoice_list where partner_id = ${id}
        order by issue_date desc limit ${limit}`,
    });

    registerPartnerRelation({
      anahtar: 'tahsilat', etiket: 'Tahsilat/Ödeme', sira: 50, modul: 'finance',
      izin: 'finance.payment.read.all',
      ozet: async (tx, id) => {
        const [r] = await tx`
          select count(*)::int as adet, coalesce(sum(amount), 0)::text as toplam
          from finance.payments where partner_id = ${id} and status <> 'cancelled'`;
        return r as { adet: number; toplam: string };
      },
      satirlar: (tx, id, limit) => tx`
        select id, number, direction, payment_date, method, amount, currency,
               allocated_total, status, reference
        from finance.v_payment_list where partner_id = ${id}
        order by payment_date desc limit ${limit}`,
    });

    /* ---- Bildirim: vadesi geçmiş tahsilat ----------------------------
       Bir muhasebecinin gün içinde en çok kaçırdığı şey budur: fatura
       kesilmiştir, ödenmemiştir ve vadesi geçmiştir. Kayıt zaten
       veritabanında; bildirim onu ayrıca saklamaz, sorar. */
    registerNotificationSource({
      ad: 'finance.invoice.overdue', modul: 'finance', izin: 'finance.invoice.read.all',
      uret: (tx, limit) => tx`
        select id, number, partner_name, total, balance_due, currency, due_date,
               (current_date - due_date) as gecikme
        from finance.v_invoice_list
        where kind = 'sale' and balance_due > 0
          and due_date is not null and due_date < current_date
        order by due_date asc limit ${limit}`
        .then((r) => r.map((x) => {
          const f = x as {
            id: string; number: string | null; partner_name: string | null;
            balance_due: string; currency: string; due_date: string; gecikme: number;
          };
          return {
            key: `finance.invoice.overdue:${f.id}`,
            baslik: `${f.number ?? 'Taslak fatura'} · ${f.gecikme} gün gecikti`,
            metin: `${f.partner_name ?? 'Cari yok'} — ${f.balance_due} ${f.currency} tahsil edilmedi`,
            ton: (f.gecikme > 30 ? 'tehlike' : 'uyari') as 'tehlike' | 'uyari',
            yol: `/finance/sales/${f.id}`,
            zaman: f.due_date,
          };
        })),
    });

    /* ---- Genel aramaya katkı: fatura ---------------------------------
       Faturayı aramak, numarayı ya da carinin adını yazmaktır. Tutar da
       alt satırda görünür ki aynı cariye kesilmiş iki fatura ayırt edilsin. */
    registerSearchSource({
      etiket: 'Fatura', sira: 6, modul: 'finance', izin: 'finance.invoice.read.all',
      ara: (tx, desen, limit) => tx`
        select id, coalesce(number, 'Taslak') as baslik, kind,
               nullif(concat_ws(' · ', partner_name,
                                to_char(total, 'FM999G999G990D00')), '') as alt
        from finance.v_invoice_list
        where coalesce(number, '') ilike ${desen} or coalesce(partner_name, '') ilike ${desen}
           or coalesce(tax_no, '') ilike ${desen}
        order by issue_date desc limit ${limit}`
        .then((r) => r.map((x) => {
          const f = x as { id: string; kind: string };
          return { ...x, yol: `/finance/${f.kind === 'sale' ? 'sales' : 'purchases'}/${f.id}` } as never;
        })),
    });

    // ========================= Kaynaklar =========================
    registerResource(app, {
      path: '/finance/accounts',
      schema: 'finance', table: 'accounts', readFrom: 'v_account_list',
      columns: ['id', 'code', 'name', 'parent_id', 'type', 'is_pl', 'is_leaf', 'currency',
        'requires_partner', 'is_active', 'parent_code', 'parent_name', 'created_at'],
      writable: ['code', 'name', 'parent_id', 'type', 'is_pl', 'is_leaf', 'currency',
        'requires_partner', 'is_active'],
      filterable: ['code', 'type', 'is_pl', 'is_leaf', 'is_active', 'parent_id'],
      sortable: ['code', 'name', 'type'],
      searchable: ['code', 'name'],
      defaultSort: 'code', defaultOrder: 'asc', maxLimit: 500,
    });

    registerResource(app, {
      path: '/finance/journals',
      schema: 'finance', table: 'journals',
      columns: ['id', 'code', 'name', 'kind', 'default_account_id', 'is_active'],
      writable: ['code', 'name', 'kind', 'default_account_id', 'is_active'],
      defaultSort: 'code', defaultOrder: 'asc',
    });

    registerResource(app, {
      path: '/finance/periods',
      schema: 'finance', table: 'fiscal_periods',
      columns: ['id', 'fiscal_year_id', 'name', 'date_from', 'date_to', 'is_closed', 'closed_at'],
      writable: ['fiscal_year_id', 'name', 'date_from', 'date_to'],
      defaultSort: 'date_from', defaultOrder: 'desc',
    });

    registerResource(app, {
      path: '/finance/entries',
      schema: 'finance', table: 'journal_entries', readFrom: 'v_journal_entry_list',
      columns: [...ENTRY_COLUMNS, 'journal_code', 'journal_name', 'owner_name',
        'branch_name', 'period_name', 'line_count'],
      writable: ['branch_id', 'journal_id', 'entry_date', 'reference', 'description',
        'currency', 'exchange_rate', 'owner_id'],
      filterable: [...ENTRY_COLUMNS],
      sortable: [...ENTRY_COLUMNS],
      searchable: ['number', 'description', 'reference'],
      defaultSort: 'entry_date',
    });

    registerResource(app, {
      path: '/finance/entry-lines',
      schema: 'finance', table: 'journal_entry_lines',
      columns: ['id', 'entry_id', 'sequence', 'account_id', 'partner_id', 'description',
        'debit', 'credit', 'tax_id', 'tax_base'],
      writable: ['entry_id', 'sequence', 'account_id', 'partner_id', 'description',
        'debit', 'credit', 'tax_id', 'tax_base'],
      defaultSort: 'sequence', defaultOrder: 'asc',
    });

    registerResource(app, {
      path: '/finance/invoices',
      schema: 'finance', table: 'invoices', readFrom: 'v_invoice_list',
      columns: [...INVOICE_COLUMNS, 'partner_name', 'tax_no', 'owner_name', 'branch_name',
        'balance_due', 'line_count', 'einvoice_status'],
      // number, status ve tutarlar yazılamaz: sırasıyla sekans, iş akışı ve
      // satır tetikleyicileri belirler.
      writable: ['branch_id', 'kind', 'partner_id', 'issue_date', 'due_date', 'currency',
        'exchange_rate', 'payment_term_days', 'notes', 'owner_id',
        'source_module', 'source_table', 'source_id'],
      filterable: [...INVOICE_COLUMNS],
      sortable: [...INVOICE_COLUMNS],
      searchable: ['number', 'notes', 'partner_name'],
      defaultSort: 'issue_date',
    });

    registerResource(app, {
      path: '/finance/invoice-lines',
      schema: 'finance', table: 'invoice_lines',
      columns: ['id', 'invoice_id', 'sequence', 'product_id', 'account_id', 'description',
        'quantity', 'uom_id', 'unit_price', 'discount_pct', 'tax_id',
        'line_subtotal', 'line_tax', 'line_withholding', 'line_total'],
      writable: ['invoice_id', 'sequence', 'product_id', 'account_id', 'description',
        'quantity', 'uom_id', 'unit_price', 'discount_pct', 'tax_id'],
      defaultSort: 'sequence', defaultOrder: 'asc',
    });

    registerResource(app, {
      path: '/finance/payments',
      schema: 'finance', table: 'payments', readFrom: 'v_payment_list',
      columns: [...PAYMENT_COLUMNS, 'partner_name', 'bank_account_name', 'owner_name', 'branch_name'],
      writable: ['branch_id', 'direction', 'partner_id', 'payment_date', 'method',
        'bank_account_id', 'amount', 'currency', 'exchange_rate', 'reference', 'notes', 'owner_id'],
      filterable: [...PAYMENT_COLUMNS],
      sortable: [...PAYMENT_COLUMNS],
      searchable: ['number', 'reference', 'partner_name'],
      defaultSort: 'payment_date',
    });

    registerResource(app, {
      path: '/finance/transfers',
      schema: 'finance', table: 'transfers', readFrom: 'v_transfer_list',
      columns: [...TRANSFER_COLUMNS, 'source_account_code', 'source_account_name',
        'dest_account_code', 'dest_account_name', 'source_bank_account_name',
        'dest_bank_account_name', 'owner_name', 'branch_name', 'is_multi_currency'],
      // number, status, tutarlar ve journal_entry_id yazılamaz: sırasıyla sekans,
      // iş akışı (post/cancel) ve yevmiye tetikleyicileri belirler. Virman
      // normalde POST /finance/transfers/execute ile tek adımda oluşturulur;
      // buradaki writable yalnızca elde taslak düzenleme içindir.
      writable: ['branch_id', 'transfer_date', 'source_account_id', 'source_bank_account_id',
        'dest_account_id', 'dest_bank_account_id', 'source_currency', 'dest_currency',
        'source_amount', 'dest_amount', 'exchange_rate', 'reference', 'description',
        'notes', 'owner_id'],
      filterable: [...TRANSFER_COLUMNS],
      sortable: [...TRANSFER_COLUMNS],
      searchable: ['number', 'reference', 'description'],
      defaultSort: 'transfer_date',
    });

    registerResource(app, {
      path: '/finance/bank-accounts',
      schema: 'finance', table: 'bank_accounts',
      columns: ['id', 'branch_id', 'name', 'bank_name', 'iban', 'currency', 'account_id', 'is_active'],
      writable: ['branch_id', 'name', 'bank_name', 'iban', 'currency', 'account_id', 'is_active'],
      defaultSort: 'name', defaultOrder: 'asc',
    });

    registerResource(app, {
      path: '/finance/bank-statements',
      schema: 'finance', table: 'bank_statements',
      columns: ['id', 'bank_account_id', 'name', 'date_from', 'date_to', 'opening_balance',
        'closing_balance', 'source', 'imported_at'],
      writable: ['bank_account_id', 'name', 'date_from', 'date_to', 'opening_balance',
        'closing_balance', 'source'],
      defaultSort: 'date_from',
    });

    registerResource(app, {
      path: '/finance/statement-lines',
      schema: 'finance', table: 'bank_statement_lines',
      columns: ['id', 'statement_id', 'value_date', 'description', 'counterparty', 'reference',
        'amount', 'balance_after', 'status', 'payment_id', 'matched_at'],
      writable: ['statement_id', 'value_date', 'description', 'counterparty', 'reference',
        'amount', 'balance_after', 'status', 'payment_id', 'fingerprint'],
      defaultSort: 'value_date', defaultOrder: 'asc',
    });

    // ========================= Durum geçişleri =========================
    const action = (
      path: string,
      fn: (tx: Tx, id: string, body: Record<string, unknown>) => Promise<unknown>,
    ) => {
      app.post(path, async (req) => {
        const { id } = req.params as { id: string };
        const body = (req.body ?? {}) as Record<string, unknown>;
        return { data: await run(req, (tx) => fn(tx, id, body)) };
      });
    };

    action('/finance/entries/:id/post', async (tx, id) => {
      const [row] = await tx`select * from finance.post_entry(${id})`;
      return row;
    });

    action('/finance/entries/:id/reverse', async (tx, id, body) => {
      const [row] = await tx`
        select * from finance.reverse_entry(
          ${id},
          ${(body.date as string) ?? null}::date,
          ${(body.reason as string) ?? null})`;
      return row;
    });

    action('/finance/invoices/:id/post', async (tx, id) => {
      const [row] = await tx`select * from finance.post_invoice(${id})`;
      return row;
    });

    action('/finance/invoices/:id/pay', async (tx, id, body) => {
      const [row] = await tx`
        select * from finance.register_payment(
          ${id},
          ${(body.amount as number) ?? null}::numeric,
          ${(body.date as string) ?? null}::date,
          ${(body.method as string) ?? 'bank'},
          ${(body.bank_account_id as string) ?? null}::uuid,
          ${(body.reference as string) ?? null})`;
      return row;
    });

    action('/finance/payments/:id/post', async (tx, id) => {
      const [row] = await tx`select * from finance.post_payment(${id})`;
      return row;
    });

    /* ---- Virman ----------------------------------------------------------
       Hesaplar arası iç transfer. `execute` tek adımda oluşturur ve
       muhasebeleştirir (register_payment deseni). Kaynak/hedef bacağı ya bir
       banka hesabıdır (bank_account_id) ya da doğrudan bir kasa/GL hesabıdır
       (account_id). */
    app.post('/finance/transfers/execute', async (req, reply) => {
      const b = (req.body ?? {}) as Record<string, unknown>;
      const amount = Number(b.amount);
      if (!Number.isFinite(amount) || amount <= 0) {
        throw badRequest('amount sıfırdan büyük bir sayı olmalı');
      }
      if (!b.source_account_id && !b.source_bank_account_id) {
        throw badRequest('source_account_id ya da source_bank_account_id zorunlu');
      }
      if (!b.dest_account_id && !b.dest_bank_account_id) {
        throw badRequest('dest_account_id ya da dest_bank_account_id zorunlu');
      }
      const row = await run(req, async (tx) => {
        const [r] = await tx`
          select * from finance.create_transfer(
            ${(b.source_account_id as string) ?? null}::uuid,
            ${(b.dest_account_id as string) ?? null}::uuid,
            ${amount}::numeric,
            ${(b.date as string) ?? null}::date,
            ${(b.source_bank_account_id as string) ?? null}::uuid,
            ${(b.dest_bank_account_id as string) ?? null}::uuid,
            ${(b.reference as string) ?? null},
            ${(b.description as string) ?? null},
            ${(b.notes as string) ?? null},
            ${(b.branch_id as string) ?? null}::uuid,
            ${b.dest_amount != null ? Number(b.dest_amount) : null}::numeric,
            ${b.exchange_rate != null ? Number(b.exchange_rate) : null}::numeric)`;
        return r;
      });
      reply.code(201);
      return { data: row };
    });

    action('/finance/transfers/:id/post', async (tx, id) => {
      const [row] = await tx`select * from finance.post_transfer(${id})`;
      return row;
    });

    action('/finance/transfers/:id/cancel', async (tx, id, body) => {
      const [row] = await tx`
        select * from finance.cancel_transfer(${id}, ${(body.reason as string) ?? null})`;
      return row;
    });

    app.post('/finance/periods/:id/close', async (req) => {
      const { id } = req.params as { id: string };
      return {
        data: await run(req, async (tx) => {
          const rows = await tx`
            update finance.fiscal_periods
               set is_closed = true, closed_at = now()
             where id = ${id} and (select core.has_perm('finance.period.close'))
            returning id, name, is_closed, closed_at`;
          if (rows.length === 0) throw notFound('Dönem bulunamadı ya da kapatma yetkiniz yok');
          return rows[0];
        }),
      };
    });

    // Fatura + satırlar tek çağrıda
    app.get('/finance/invoices/:id/full', async (req) => {
      const { id } = req.params as { id: string };
      return run(req, async (tx) => {
        const [header] = await tx`select * from finance.v_invoice_list where id = ${id}`;
        if (!header) throw notFound();
        const lines = await tx`
          select l.*, p.sku, p.name as product_name, t.code as tax_code, t.rate as tax_rate,
                 u.code as uom_code, a.code as account_code, a.name as account_name
          from finance.invoice_lines l
          left join core.products p on p.id = l.product_id
          left join core.taxes t on t.id = l.tax_id
          left join core.uoms u on u.id = l.uom_id
          left join finance.accounts a on a.id = l.account_id
          where l.invoice_id = ${id} order by l.sequence`;
        const payments = await tx`
          select pa.amount, p.number, p.payment_date, p.method, p.status
          from finance.payment_allocations pa
          join finance.payments p on p.id = pa.payment_id
          where pa.invoice_id = ${id} order by p.payment_date`;
        return { data: { ...header, lines, payments } };
      });
    });

    app.get('/finance/entries/:id/full', async (req) => {
      const { id } = req.params as { id: string };
      return run(req, async (tx) => {
        const [header] = await tx`select * from finance.v_journal_entry_list where id = ${id}`;
        if (!header) throw notFound();
        const lines = await tx`
          select l.*, a.code as account_code, a.name as account_name, p.name as partner_name
          from finance.journal_entry_lines l
          join finance.accounts a on a.id = l.account_id
          left join core.partners p on p.id = l.partner_id
          where l.entry_id = ${id} order by l.sequence`;
        return { data: { ...header, lines } };
      });
    });

    // ========================= Raporlar =========================
    /**
     * Mizan. `from`/`to` dönem aralığıdır; bakiyeler aralık boyunca toplanır.
     * Rapor, tetikleyicilerle bakımı yapılan finance.account_balances tablosundan
     * okur — yevmiye satırlarını taramaz.
     */
    // ========================= Panel =========================
    // On iki gösterge tek turda gelir. Hepsi `security invoker`: panel,
    // sorguyu çalıştıran kullanıcının GÖREBİLDİĞİ veriyi toplar, yani şube
    // müdürü kendi şubesinin rakamlarını görür.
    app.get('/finance/dashboard/kpis', async (req) =>
      run(req, async (tx) => {
        const [row] = await tx`select * from finance.dashboard_kpis()`;
        return { data: row };
      }));

    app.get('/finance/dashboard/sales-trend', async (req) => {
      const { days } = req.query as { days?: string };
      return run(req, async (tx) => ({
        data: await tx`
          select * from finance.dashboard_sales_trend(${Math.min(Number(days ?? 30) || 30, 180)})`,
      }));
    });

    app.get('/finance/dashboard/cash-accounts', async (req) =>
      run(req, async (tx) => ({
        data: await tx`select * from finance.dashboard_cash_accounts()`,
      })));

    app.get('/finance/dashboard/recent-sales', async (req) =>
      run(req, async (tx) => ({
        data: await tx`select * from finance.dashboard_recent_sales(6)`,
      })));

    app.get('/finance/dashboard/top-products', async (req) =>
      run(req, async (tx) => ({
        data: await tx`select * from finance.dashboard_top_products(6)`,
      })));

    app.get('/finance/reports/trial-balance', async (req) => {
      const { from, to, branch_id } = req.query as Record<string, string | undefined>;
      return run(req, async (tx) => ({
        data: await tx`
          select account_id, code, name, type, is_pl,
                 sum(debit_total)  as debit_total,
                 sum(credit_total) as credit_total,
                 sum(debit_total - credit_total) as balance
          from finance.v_trial_balance
          where (${from ?? null}::date is null or period_start >= ${from ?? null}::date)
            and (${to ?? null}::date is null or period_start <= ${to ?? null}::date)
            and (${branch_id ?? null}::uuid is null or branch_id = ${branch_id ?? null}::uuid)
          group by account_id, code, name, type, is_pl
          having sum(debit_total) <> 0 or sum(credit_total) <> 0
          order by code`,
      }));
    });

    app.get('/finance/reports/general-ledger', async (req) => {
      const { account_id, from, to } = req.query as Record<string, string | undefined>;
      if (!account_id) throw badRequest('account_id zorunlu');
      return run(req, async (tx) => ({
        data: await tx`
          select * from finance.v_general_ledger
          where account_id = ${account_id}
            and (${from ?? null}::date is null or entry_date >= ${from ?? null}::date)
            and (${to ?? null}::date is null or entry_date <= ${to ?? null}::date)
          order by entry_date, entry_number`,
      }));
    });

    /** Kâr/zarar — şube kırılımlı ya da toplu. */
    app.get('/finance/reports/profit-loss', async (req) => {
      const { from, to, branch_id, detail } = req.query as Record<string, string | undefined>;
      return run(req, async (tx) => {
        const summary = await tx`
          select sum(gross_revenue)      as gross_revenue,
                 sum(sales_deductions)   as sales_deductions,
                 sum(net_revenue)        as net_revenue,
                 sum(cogs)               as cogs,
                 sum(gross_profit)       as gross_profit,
                 sum(operating_expenses) as operating_expenses,
                 sum(other_income)       as other_income,
                 sum(financial_expenses) as financial_expenses,
                 sum(net_profit)         as net_profit
          from finance.v_profit_loss_summary
          where (${from ?? null}::date is null or period_start >= ${from ?? null}::date)
            and (${to ?? null}::date is null or period_start <= ${to ?? null}::date)
            and (${branch_id ?? null}::uuid is null or branch_id = ${branch_id ?? null}::uuid)`;

        const byBranch = await tx`
          select branch_id, b.name as branch_name,
                 sum(net_revenue) as net_revenue, sum(cogs) as cogs,
                 sum(gross_profit) as gross_profit,
                 sum(operating_expenses) as operating_expenses,
                 sum(net_profit) as net_profit
          from finance.v_profit_loss_summary s
          left join core.branches b on b.id = s.branch_id
          where (${from ?? null}::date is null or period_start >= ${from ?? null}::date)
            and (${to ?? null}::date is null or period_start <= ${to ?? null}::date)
          group by branch_id, b.name
          order by b.name nulls first`;

        const accounts = detail
          ? await tx`
              select code, name, type, group_code, sum(amount) as amount
              from finance.v_profit_loss
              where (${from ?? null}::date is null or period_start >= ${from ?? null}::date)
                and (${to ?? null}::date is null or period_start <= ${to ?? null}::date)
                and (${branch_id ?? null}::uuid is null or branch_id = ${branch_id ?? null}::uuid)
              group by code, name, type, group_code
              having sum(amount) <> 0
              order by code`
          : [];

        return { data: { summary: summary[0] ?? null, by_branch: byBranch, accounts } };
      });
    });

    app.get('/finance/reports/vat', async (req) => {
      const { from, to } = req.query as Record<string, string | undefined>;
      return run(req, async (tx) => ({
        data: await tx`
          select period_start, kind, tax_code, tax_rate,
                 sum(tax_base) as tax_base, sum(tax_amount) as tax_amount,
                 sum(withholding_amount) as withholding_amount,
                 sum(invoice_count) as invoice_count
          from finance.v_vat_summary
          where (${from ?? null}::date is null or period_start >= ${from ?? null}::date)
            and (${to ?? null}::date is null or period_start <= ${to ?? null}::date)
          group by period_start, kind, tax_code, tax_rate
          order by period_start desc, kind, tax_code`,
      }));
    });

    app.get('/finance/reports/aging', async (req) => {
      const { kind } = req.query as { kind?: string };
      return run(req, async (tx) => ({
        data: await tx`
          select kind, partner_id, partner_name,
                 sum(open_amount) as open_amount, sum(not_due) as not_due,
                 sum(overdue_0_30) as overdue_0_30, sum(overdue_31_60) as overdue_31_60,
                 sum(overdue_61_90) as overdue_61_90, sum(overdue_90_plus) as overdue_90_plus,
                 sum(invoice_count) as invoice_count, min(earliest_due) as earliest_due
          from finance.v_partner_aging
          where (${kind ?? null}::text is null or kind::text = ${kind ?? null})
          group by kind, partner_id, partner_name
          order by sum(open_amount) desc`,
      }));
    });

    app.get('/finance/reports/open-invoices', async (req) => {
      const { kind } = req.query as { kind?: string };
      return run(req, async (tx) => ({
        data: await tx`
          select * from finance.v_open_invoices
          where (${kind ?? null}::text is null or kind::text = ${kind ?? null})
          order by days_overdue desc nulls last`,
      }));
    });

    // ========================= e-Fatura =========================
    /**
     * Faturayı seçili entegratöre gönderir.
     *
     * Kanonik yük burada kurulur; sağlayıcıya özgü hiçbir alan yok. Entegratör
     * değiştiğinde bu uç değişmez, yalnızca adapter değişir.
     */
    app.post('/finance/invoices/:id/einvoice', async (req, reply) => {
      const { id } = req.params as { id: string };
      const body = (req.body ?? {}) as { profile?: EInvoiceProfile; provider?: string };

      const canonical = await run(req, async (tx): Promise<CanonicalInvoice> => {
        const [inv] = await tx`
          select i.*, p.name as partner_name, p.tax_no, p.tax_office, p.address,
                 p.district, p.city, p.country_code, p.email, p.phone
          from finance.invoices i
          join core.partners p on p.id = i.partner_id
          where i.id = ${id}`;
        if (!inv) throw notFound();
        if (inv.kind !== 'sale') throw badRequest('Yalnızca satış faturaları gönderilebilir');
        if (!['posted', 'partially_paid', 'paid'].includes(inv.status as string)) {
          throw badRequest('Yalnızca muhasebeleşmiş faturalar gönderilebilir');
        }

        const [tenant] = await tx`
          select t.name, t.legal_name, t.tax_no, t.tax_office, t.country_code
          from core.tenants t where t.id = core.current_tenant_id()`;

        const lines = await tx`
          select l.*, t.rate as tax_rate, u.code as uom_code
          from finance.invoice_lines l
          left join core.taxes t on t.id = l.tax_id
          left join core.uoms u on u.id = l.uom_id
          where l.invoice_id = ${id} order by l.sequence`;

        return {
          invoiceId: inv.id as string,
          number: (inv.number as string) ?? null,
          issueDate: new Date(inv.issue_date as string).toISOString().slice(0, 10),
          currency: inv.currency as string,
          profile: body.profile ?? 'TEMELFATURA',
          supplier: {
            name: (tenant?.legal_name as string) ?? (tenant?.name as string) ?? '',
            taxNumber: (tenant?.tax_no as string) ?? null,
            taxOffice: (tenant?.tax_office as string) ?? null,
            address: null, district: null, city: null,
            country: (tenant?.country_code as string) ?? 'TR',
            email: null, phone: null,
          },
          customer: {
            name: inv.partner_name as string,
            taxNumber: (inv.tax_no as string) ?? null,
            taxOffice: (inv.tax_office as string) ?? null,
            address: (inv.address as string) ?? null,
            district: (inv.district as string) ?? null,
            city: (inv.city as string) ?? null,
            country: (inv.country_code as string) ?? 'TR',
            email: (inv.email as string) ?? null,
            phone: (inv.phone as string) ?? null,
          },
          lines: lines.map((l): CanonicalLine => ({
            sequence: l.sequence as number,
            name: l.description as string,
            quantity: String(l.quantity),
            unitCode: UOM_TO_UNECE[(l.uom_code as string) ?? ''] ?? 'C62',
            unitPrice: String(l.unit_price),
            discountPct: String(l.discount_pct),
            taxRate: String(l.tax_rate ?? 0),
            taxAmount: String(l.line_tax),
            withholdingAmount: String(l.line_withholding),
            lineTotal: String(l.line_subtotal),
          })),
          subtotal: String(inv.subtotal),
          discountTotal: String(inv.discount_total),
          taxTotal: String(inv.tax_total),
          withholdingTotal: String(inv.withholding_total),
          payableAmount: String(inv.total),
          notes: (inv.notes as string) ?? null,
        };
      });

      const provider = getEInvoiceProvider(body.provider);

      // Alıcı e-Fatura mükellefi değilse e-Arşiv profiline düşülür
      let profile = canonical.profile;
      if (!body.profile && canonical.customer.taxNumber) {
        profile = (await provider.isRegistered(canonical.customer.taxNumber))
          ? 'TEMELFATURA' : 'EARSIVFATURA';
      }

      const result = await provider.send({ ...canonical, profile });

      const saved = await run(req, async (tx) => {
        const [row] = await tx`
          insert into finance.einvoice_documents
            (invoice_id, provider, profile, ettn, gib_number, status, attempts,
             provider_payload, provider_response, sent_at)
          values (${id}, ${provider.code}, ${profile}, ${result.ettn}, ${result.gibNumber ?? null},
                  ${result.status}, 1, ${JSON.stringify({ profile })}::jsonb,
                  ${JSON.stringify(result.raw)}::jsonb, now())
          returning id, provider, profile, ettn, gib_number, status, sent_at`;
        return row;
      });

      reply.code(201);
      return { data: saved };
    });

    app.get('/finance/invoices/:id/einvoice', async (req) => {
      const { id } = req.params as { id: string };
      return run(req, async (tx) => ({
        data: await tx`
          select id, provider, profile, ettn, gib_number, direction, status,
                 attempts, last_error, sent_at, responded_at
          from finance.einvoice_documents
          where invoice_id = ${id} order by created_at desc`,
      }));
    });

    // ========================= Muhasebe ayarları =========================
    app.get('/finance/settings/account-mappings', async (req) =>
      run(req, async (tx) => ({
        data: await tx`
          select m.key, m.account_id, a.code, a.name
          from finance.account_mappings m
          join finance.accounts a on a.id = m.account_id
          order by m.key`,
      })));

    app.put('/finance/settings/account-mappings/:key', async (req) => {
      const { key } = req.params as { key: string };
      const { account_id } = req.body as { account_id?: string };
      if (!account_id) throw badRequest('account_id zorunlu');
      return {
        data: await run(req, async (tx) => {
          const [row] = await tx`
            insert into finance.account_mappings (tenant_id, key, account_id)
            values (core.current_tenant_id(), ${key}, ${account_id})
            on conflict (tenant_id, key)
              do update set account_id = excluded.account_id, updated_at = now()
            returning key, account_id`;
          return row;
        }),
      };
    });
  },
};

export default financeModule;
export * from './einvoice/types.js';
export { registerEInvoiceProvider, getEInvoiceProvider } from './einvoice/registry.js';
