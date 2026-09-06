import type { FastifyInstance, FastifyRequest } from 'fastify';
import {
  registerResource, registerNotificationSource, registerPartnerRelation,
  withContext, contextFromRequest,
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

const TICKET_COLUMNS = ['id', 'branch_id', 'number', 'subject', 'status', 'priority',
  'channel', 'partner_id', 'partner_name', 'contact_name', 'contact_email',
  'team_id', 'team_name', 'assignee_id', 'assignee_name',
  'created_at', 'first_response_at', 'resolved_at', 'closed_at',
  'first_response_due', 'resolution_due',
  'first_response_breached', 'resolution_breached',
  'paused_minutes', 'satisfaction', 'resolution', 'branch_name', 'owner_id', 'tags',
  'message_count', 'first_response_minutes', 'resolution_minutes', 'minutes_to_due'] as const;

export const helpdeskModule: SezraModule = {
  code: 'helpdesk',

  register(app: FastifyInstance) {
    /* ---- Cari kartı ilişkisi: destek biletleri ------------------------ */
    registerPartnerRelation({
      anahtar: 'destek', etiket: 'Destek', sira: 70, modul: 'helpdesk',
      izin: 'helpdesk.ticket.read.all',
      ozet: async (tx, id) => {
        const [r] = await tx`
          select count(*)::int as adet from helpdesk.tickets where partner_id = ${id}`;
        return { adet: Number((r as { adet: number }).adet), toplam: null };
      },
      satirlar: (tx, id, limit) => tx`
        select id, number, subject, status, priority, created_at, resolved_at,
               assignee_name, resolution_breached
        from helpdesk.v_ticket_list where partner_id = ${id}
        order by created_at desc limit ${limit}`,
    });

    /* ---- Bildirim: SLA ihlali ----------------------------------------
       Destekte geri dönülemeyen tek şey geçen süredir; ihlal olduktan
       sonra yapılabilecek şey yalnızca özür dilemek. */
    registerNotificationSource({
      ad: 'helpdesk.sla', modul: 'helpdesk', izin: 'helpdesk.ticket.read.all',
      uret: (tx, limit) => tx`
        select id, number, subject, partner_name, resolution_due, created_at
        from helpdesk.v_ticket_list
        where resolution_breached and status not in ('resolved', 'closed', 'cancelled')
        order by resolution_due asc limit ${limit}`
        .then((r) => r.map((x) => {
          const t = x as {
            id: string; number: string; subject: string;
            partner_name: string | null; resolution_due: string;
          };
          return {
            key: `helpdesk.sla:${t.id}`,
            baslik: `${t.number} çözüm süresini aştı`,
            metin: `${t.subject}${t.partner_name ? ` — ${t.partner_name}` : ''}`,
            ton: 'tehlike' as const,
            yol: `/helpdesk/${t.id}`,
            zaman: t.resolution_due,
          };
        })),
    });

    registerResource(app, {
      path: '/helpdesk/teams',
      schema: 'helpdesk', table: 'teams',
      columns: ['id', 'branch_id', 'code', 'name', 'description', 'is_active'],
      writable: ['branch_id', 'code', 'name', 'description', 'is_active'],
      searchable: ['code', 'name'],
      defaultSort: 'name', defaultOrder: 'asc',
    });

    registerResource(app, {
      path: '/helpdesk/sla-policies',
      schema: 'helpdesk', table: 'sla_policies',
      columns: ['id', 'code', 'name', 'priority', 'team_id',
        'first_response_minutes', 'resolution_minutes', 'is_active'],
      writable: ['code', 'name', 'priority', 'team_id',
        'first_response_minutes', 'resolution_minutes', 'is_active'],
      defaultSort: 'priority', defaultOrder: 'asc',
    });

    registerResource(app, {
      path: '/helpdesk/tickets',
      schema: 'helpdesk', table: 'tickets', readFrom: 'v_ticket_list',
      columns: [...TICKET_COLUMNS],
      // SLA hedefleri ve damgalar YAZILAMAZ: açılışta dondurulur, akış belirler.
      writable: ['branch_id', 'subject', 'description', 'partner_id', 'contact_name',
        'contact_email', 'contact_phone', 'team_id', 'assignee_id', 'priority',
        'channel', 'project_id', 'tags', 'owner_id'],
      filterable: [...TICKET_COLUMNS],
      searchable: ['number', 'subject', 'description', 'partner_name'],
      sortable: [...TICKET_COLUMNS],
      defaultSort: 'created_at',
    });

    registerResource(app, {
      path: '/helpdesk/messages',
      schema: 'helpdesk', table: 'messages',
      columns: ['id', 'ticket_id', 'author_id', 'author_name', 'is_internal',
        'is_from_customer', 'body', 'created_at'],
      writable: ['ticket_id', 'author_id', 'author_name', 'is_internal',
        'is_from_customer', 'body'],
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

    action('/helpdesk/tickets/:id/wait-customer', async (tx, id, body) => {
      const [row] = await tx`
        select * from helpdesk.wait_for_customer(${id}, ${(body.note as string) ?? null})`;
      return row;
    });

    action('/helpdesk/tickets/:id/resolve', async (tx, id, body) => {
      const [row] = await tx`
        select * from helpdesk.resolve_ticket(${id}, ${(body.resolution as string) ?? null})`;
      return row;
    });

    action('/helpdesk/tickets/:id/close', async (tx, id, body) => {
      const [row] = await tx`
        select * from helpdesk.close_ticket(
          ${id},
          ${body.satisfaction === undefined ? null : Number(body.satisfaction)}::smallint,
          ${(body.note as string) ?? null})`;
      return row;
    });

    /**
     * Yanıt gönder.
     *
     * Ayrı bir "mesaj ekle" kaynağı yerine bu uç var: yanıtın müşteriye mi
     * gittiği yoksa iç not mu olduğu SLA ölçümünü doğrudan etkiliyor
     * (iç not ilk yanıt sayılmaz), o yüzden çağıranın bunu bilinçli seçmesi
     * gerekiyor.
     */
    app.post('/helpdesk/tickets/:id/reply', async (req) => {
      const { id } = req.params as { id: string };
      const b = (req.body ?? {}) as Record<string, unknown>;
      if (!b.body) throw badRequest('body zorunlu');
      return run(req, async (tx) => {
        const [me] = await tx`select core.current_user_id() as uid`;
        const [row] = await tx`
          insert into helpdesk.messages
            (ticket_id, author_id, body, is_internal, is_from_customer)
          values (
            ${id}, ${(me as { uid: string }).uid}, ${b.body as string},
            ${Boolean(b.is_internal)}, false)
          returning *`;
        return { data: row };
      });
    });

    /** Müşteriden gelen mesajı kaydet (e-posta/portal entegrasyonu bunu çağırır). */
    app.post('/helpdesk/tickets/:id/customer-reply', async (req) => {
      const { id } = req.params as { id: string };
      const b = (req.body ?? {}) as Record<string, unknown>;
      if (!b.body) throw badRequest('body zorunlu');
      return run(req, async (tx) => {
        const [row] = await tx`
          insert into helpdesk.messages
            (ticket_id, author_name, body, is_from_customer)
          values (${id}, ${(b.author_name as string) ?? 'Müşteri'},
                  ${b.body as string}, true)
          returning *`;
        return { data: row };
      });
    });

    app.get('/helpdesk/tickets/:id/full', async (req) => {
      const { id } = req.params as { id: string };
      return run(req, async (tx) => {
        const [header] = await tx`select * from helpdesk.v_ticket_list where id = ${id}`;
        if (!header) throw notFound();
        const messages = await tx`
          select m.*, u.full_name as author_full_name
          from helpdesk.messages m
          left join core.users u on u.id = m.author_id
          where m.ticket_id = ${id} order by m.created_at`;
        return { data: { ...header, messages } };
      });
    });

    /** SLA taraması — cron da bunu çağırır. */
    app.post('/helpdesk/check-sla', async (req) =>
      run(req, async (tx) => {
        const [row] = await tx`select helpdesk.check_sla_breaches() as breached`;
        return { data: row };
      }));

    // ========================= Raporlar =========================
    app.get('/helpdesk/reports/sla', async (req) =>
      run(req, async (tx) => ({
        data: await tx`
          select * from helpdesk.v_sla_performance
          order by res_compliance_pct nulls last, priority`,
      })));

    app.get('/helpdesk/reports/agents', async (req) =>
      run(req, async (tx) => ({
        data: await tx`select * from helpdesk.v_agent_workload order by open_count desc`,
      })));

    app.get('/helpdesk/reports/partners', async (req) =>
      run(req, async (tx) => ({
        data: await tx`
          select * from helpdesk.v_partner_support order by ticket_count desc limit 100`,
      })));

    /** Bana atanan açık biletler, vadesi yaklaşan önce. */
    app.get('/helpdesk/my-tickets', async (req) =>
      run(req, async (tx) => ({
        data: await tx`
          select * from helpdesk.v_ticket_list
          where assignee_id = core.current_user_id()
            and status in ('new', 'open', 'pending_customer')
          order by (minutes_to_due is null), minutes_to_due`,
      })));
  },
};

export default helpdeskModule;
