import type { FastifyInstance, FastifyRequest } from 'fastify';
import {
  registerResource, withContext, contextFromRequest, translatePgError,
  notFound, badRequest, type SezraModule, type Tx,
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

/** UN/ECE birim kodu eşlemesi — UBL-TR bunu ister. */
const UOM_TO_UNECE: Record<string, string> = {
  ADET: 'C62', PAKET: 'PK', KOLI: 'BX', KG: 'KGM', GR: 'GRM',
  LT: 'LTR', ML: 'MLT', SAAT: 'HUR',
};

export const financeModule: SezraModule = {
  code: 'finance',

  register(app: FastifyInstance) {
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
