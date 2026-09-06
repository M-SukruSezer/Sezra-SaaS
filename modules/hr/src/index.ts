import type { FastifyInstance, FastifyRequest } from 'fastify';
import {
  registerResource, registerNotificationSource, withContext, contextFromRequest,
  translatePgError,
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

const EMPLOYEE_COLUMNS = ['id', 'branch_id', 'employee_no', 'first_name', 'last_name',
  'full_name', 'email', 'phone', 'hire_date', 'termination_date', 'is_active',
  'department_id', 'department_name', 'position_id', 'position_name',
  'manager_id', 'manager_name', 'branch_name', 'user_id', 'owner_id',
  'tenure_years', 'created_at', 'updated_at'] as const;

const LEAVE_COLUMNS = ['id', 'branch_id', 'employee_id', 'employee_name', 'leave_type_id',
  'leave_type_code', 'leave_type_name', 'is_paid', 'consumes_balance',
  'date_from', 'date_to', 'days', 'reason', 'status', 'approver_id', 'approver_name',
  'approved_at', 'rejection_reason', 'branch_name', 'owner_id', 'created_at'] as const;

const PAYSLIP_COLUMNS = ['id', 'branch_id', 'run_id', 'employee_id', 'employee_no',
  'employee_name', 'period_year', 'period_month', 'period', 'run_status',
  'sgk_days', 'missing_days', 'gross', 'sgk_base', 'sgk_employee', 'unemployment_employee',
  'income_tax_base', 'income_tax_gross', 'income_tax_exemption', 'income_tax', 'stamp_tax',
  'net', 'sgk_employer', 'unemployment_employer', 'employer_cost',
  'department_name', 'branch_name'] as const;

export const hrModule: SezraModule = {
  code: 'hr',

  register(app: FastifyInstance) {
    /* ---- Bildirim: onay bekleyen izin --------------------------------
       Onay kuyruğu kendi ekranında beklerse kimse bakmaz; personel de
       cevabı bekler. İzin görünürlüğü zaten RLS ile sınırlı, dolayısıyla
       yöneticiye yalnızca kendi yetki alanındaki talepler düşer. */
    registerNotificationSource({
      ad: 'hr.leave.pending', modul: 'hr', izin: 'hr.leave.approve',
      uret: (tx, limit) => tx`
        select id, employee_name, leave_type_name, days, date_from, created_at
        from hr.v_leave_request_list
        where status = 'pending'
        order by date_from asc limit ${limit}`
        .then((r) => r.map((x) => {
          const t = x as {
            id: string; employee_name: string; leave_type_name: string;
            days: string; date_from: string; created_at: string;
          };
          return {
            key: `hr.leave.pending:${t.id}`,
            baslik: `${t.employee_name} izin onayı bekliyor`,
            metin: `${t.leave_type_name} · ${t.days} gün, ${t.date_from} tarihinden itibaren`,
            ton: 'bilgi' as const,
            yol: '/hr/leaves',
            zaman: t.created_at,
          };
        })),
    });

    // ========================= Organizasyon =========================
    registerResource(app, {
      path: '/hr/departments',
      schema: 'hr', table: 'departments',
      columns: ['id', 'branch_id', 'parent_id', 'code', 'name', 'manager_id', 'is_active',
        'created_at', 'updated_at'],
      writable: ['branch_id', 'parent_id', 'code', 'name', 'manager_id', 'is_active'],
      searchable: ['code', 'name'],
      defaultSort: 'name', defaultOrder: 'asc',
    });

    registerResource(app, {
      path: '/hr/positions',
      schema: 'hr', table: 'positions',
      columns: ['id', 'department_id', 'code', 'name', 'occupation_code', 'is_active',
        'created_at', 'updated_at'],
      writable: ['department_id', 'code', 'name', 'occupation_code', 'is_active'],
      searchable: ['code', 'name'],
      defaultSort: 'name', defaultOrder: 'asc',
    });

    registerResource(app, {
      path: '/hr/employees',
      schema: 'hr', table: 'employees', readFrom: 'v_employee_list',
      columns: [...EMPLOYEE_COLUMNS],
      // national_id ve iban BİLEREK yazılabilir ama okunabilir kolon listesinde
      // yok: liste ekranı bunları çekmemeli. Tekil kayıt /full ucundan gelir.
      writable: ['branch_id', 'partner_id', 'user_id', 'employee_no', 'first_name', 'last_name',
        'national_id', 'birth_date', 'gender', 'email', 'phone', 'address', 'iban',
        'department_id', 'position_id', 'manager_id', 'hire_date', 'termination_date',
        'termination_reason', 'sgk_no', 'sgk_exit_code', 'is_active', 'owner_id'],
      filterable: [...EMPLOYEE_COLUMNS],
      searchable: ['first_name', 'last_name', 'employee_no', 'email'],
      sortable: [...EMPLOYEE_COLUMNS],
      defaultSort: 'employee_no', defaultOrder: 'asc',
    });

    // Ücret içerir: RLS ayrı izin (hr.contract.*) ister, yetkisiz kullanıcı
    // bu uçtan boş liste alır — 403 değil, çünkü kaydın VARLIĞI da bilgidir.
    registerResource(app, {
      path: '/hr/contracts',
      schema: 'hr', table: 'employee_contracts',
      columns: ['id', 'branch_id', 'employee_id', 'valid_from', 'valid_to', 'employment_type',
        'wage_basis', 'wage_amount', 'wage_period', 'currency', 'weekly_hours',
        'sgk_discount_5510', 'disability_degree', 'is_pensioner', 'is_exempt_from_stamp_tax',
        'annual_leave_entitlement_days', 'notes', 'created_at', 'updated_at'],
      writable: ['branch_id', 'employee_id', 'valid_from', 'valid_to', 'employment_type',
        'wage_basis', 'wage_amount', 'wage_period', 'currency', 'weekly_hours',
        'sgk_discount_5510', 'disability_degree', 'is_pensioner', 'is_exempt_from_stamp_tax',
        'annual_leave_entitlement_days', 'notes'],
      defaultSort: 'valid_from',
    });

    // ========================= İzin =========================
    registerResource(app, {
      path: '/hr/leave-types',
      schema: 'hr', table: 'leave_types',
      columns: ['id', 'code', 'name', 'is_paid', 'consumes_balance', 'requires_approval',
        'reduces_sgk_days', 'max_days_per_year', 'is_active'],
      writable: ['code', 'name', 'is_paid', 'consumes_balance', 'requires_approval',
        'reduces_sgk_days', 'max_days_per_year', 'is_active'],
      defaultSort: 'name', defaultOrder: 'asc',
    });

    registerResource(app, {
      path: '/hr/leave-balances',
      schema: 'hr', table: 'leave_balances', readFrom: 'v_leave_balance_summary',
      columns: ['id', 'employee_id', 'employee_no', 'employee_name', 'branch_id',
        'leave_type_id', 'leave_type_code', 'leave_type_name', 'year',
        'entitled_days', 'carried_days', 'used_days', 'remaining_days', 'pending_days'],
      // used_days YAZILAMAZ: onay akışı yönetir. Elle düzeltme entitled/carried ile yapılır.
      writable: ['employee_id', 'leave_type_id', 'year', 'entitled_days', 'carried_days'],
      defaultSort: 'employee_name', defaultOrder: 'asc',
    });

    registerResource(app, {
      path: '/hr/leave-requests',
      schema: 'hr', table: 'leave_requests', readFrom: 'v_leave_request_list',
      columns: [...LEAVE_COLUMNS],
      // days ve status yazılamaz: gün sayısı tetikleyiciden, durum iş akışından gelir.
      writable: ['branch_id', 'employee_id', 'leave_type_id', 'date_from', 'date_to',
        'reason', 'owner_id'],
      filterable: [...LEAVE_COLUMNS],
      searchable: ['reason', 'employee_name'],
      sortable: [...LEAVE_COLUMNS],
      defaultSort: 'date_from',
    });

    // ========================= Vardiya ve puantaj =========================
    registerResource(app, {
      path: '/hr/shifts',
      schema: 'hr', table: 'shifts',
      columns: ['id', 'branch_id', 'code', 'name', 'start_time', 'end_time', 'break_minutes',
        'crosses_midnight', 'is_active'],
      writable: ['branch_id', 'code', 'name', 'start_time', 'end_time', 'break_minutes', 'is_active'],
      defaultSort: 'start_time', defaultOrder: 'asc',
    });

    registerResource(app, {
      path: '/hr/attendance',
      schema: 'hr', table: 'attendance',
      columns: ['id', 'branch_id', 'employee_id', 'work_date', 'shift_id', 'check_in',
        'check_out', 'worked_minutes', 'overtime_minutes', 'leave_request_id',
        'absence_code', 'note', 'created_at', 'updated_at'],
      // worked_minutes/overtime_minutes tetikleyiciden hesaplanır
      writable: ['branch_id', 'employee_id', 'work_date', 'shift_id', 'check_in', 'check_out',
        'leave_request_id', 'absence_code', 'note'],
      defaultSort: 'work_date',
    });

    registerResource(app, {
      path: '/hr/holidays',
      schema: 'hr', table: 'holidays',
      columns: ['id', 'branch_id', 'holiday_date', 'name', 'is_half_day'],
      writable: ['branch_id', 'holiday_date', 'name', 'is_half_day'],
      defaultSort: 'holiday_date', defaultOrder: 'asc',
    });

    // ========================= Bordro =========================
    registerResource(app, {
      path: '/hr/payroll-runs',
      schema: 'hr', table: 'payroll_runs', readFrom: 'v_payroll_run_list',
      columns: ['id', 'branch_id', 'number', 'period_year', 'period_month', 'period',
        'date_from', 'date_to', 'payment_date', 'status', 'employee_count',
        'total_gross', 'total_net', 'total_employer_cost', 'branch_name',
        'parameter_set_code', 'parameters_verified', 'approved_at', 'posted_at',
        'owner_id', 'created_at'],
      // Tutarlar ve durum yazılamaz: hesaplama ve onay fonksiyonları belirler.
      writable: ['branch_id', 'period_year', 'period_month', 'payment_date', 'notes', 'owner_id'],
      defaultSort: 'date_from',
    });

    registerResource(app, {
      path: '/hr/payslips',
      schema: 'hr', table: 'payslips', readFrom: 'v_payslip_list',
      columns: [...PAYSLIP_COLUMNS],
      // Pusula elle yazılmaz; yalnızca hesaplama üretir.
      writable: [],
      filterable: [...PAYSLIP_COLUMNS],
      searchable: ['employee_name', 'employee_no'],
      sortable: [...PAYSLIP_COLUMNS],
      defaultSort: 'employee_name', defaultOrder: 'asc',
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
    // yeniden çağırırdı (bkz. CRM modülündeki aynı not).
    action('/hr/leave-requests/:id/submit', async (tx, id) => {
      const [row] = await tx`select * from hr.submit_leave_request(${id})`;
      return row;
    });

    action('/hr/leave-requests/:id/approve', async (tx, id) => {
      const [row] = await tx`select * from hr.approve_leave_request(${id})`;
      return row;
    });

    action('/hr/leave-requests/:id/reject', async (tx, id, body) => {
      const [row] = await tx`
        select * from hr.reject_leave_request(${id}, ${(body.reason as string) ?? null})`;
      return row;
    });

    action('/hr/leave-requests/:id/cancel', async (tx, id) => {
      const [row] = await tx`select * from hr.cancel_leave_request(${id})`;
      return row;
    });

    action('/hr/payroll-runs/:id/calculate', async (tx, id) => {
      const [row] = await tx`select * from hr.calculate_payroll_run(${id})`;
      return row;
    });

    action('/hr/payroll-runs/:id/approve', async (tx, id) => {
      const [row] = await tx`select * from hr.approve_payroll_run(${id})`;
      return row;
    });

    /**
     * Maaş simülasyonu — hiçbir şey yazmaz.
     * Bordro çalıştırmasıyla AYNI motoru kullanır (hr.compute_payslip); "teklif
     * ettiğimiz maaşın neti ne olur / işverene maliyeti ne" sorusunun cevabı ile
     * ay sonunda çıkan pusula böylece ayrışamaz.
     */
    app.post('/hr/payroll/simulate', async (req) => {
      const b = (req.body ?? {}) as Record<string, unknown>;
      if (!b.employee_id) throw badRequest('employee_id zorunlu');
      const now = new Date();
      const year = Number(b.year ?? now.getFullYear());
      const month = Number(b.month ?? now.getMonth() + 1);
      return run(req, async (tx) => {
        const [row] = await tx`
          select * from hr.compute_payslip(
            ${b.employee_id as string}, ${year}::smallint, ${month}::smallint,
            ${Number(b.missing_days ?? 0)}, ${Number(b.overtime_hours ?? 0)},
            ${Number(b.bonus ?? 0)})`;
        if (!row) throw notFound();
        return { data: row };
      });
    });

    /** Verilen brütün neti — sözleşme gerektirmez, pazarlık ekranı için. */
    app.post('/hr/payroll/net-from-gross', async (req) => {
      const b = (req.body ?? {}) as Record<string, unknown>;
      if (!b.employee_id) throw badRequest('employee_id zorunlu');
      const now = new Date();
      return run(req, async (tx) => {
        const [row] = await tx`
          select hr.net_from_gross(
            ${Number(b.gross ?? 0)}, ${b.employee_id as string},
            ${Number(b.year ?? now.getFullYear())}::smallint,
            ${Number(b.month ?? now.getMonth() + 1)}::smallint,
            ${Number(b.missing_days ?? 0)}) as net`;
        return { data: row };
      });
    });

    /** Personel kartı: kimlik alanları + yürürlükteki sözleşme + izin bakiyeleri. */
    app.get('/hr/employees/:id/full', async (req) => {
      const { id } = req.params as { id: string };
      return run(req, async (tx) => {
        // full_name ve tenure_years v_employee_list'te türetiliyor; kart ham
        // tabloyu okuduğu için aynı türetmeleri burada da vermek gerekiyor,
        // yoksa başlık boş ve kıdem "—" görünür.
        const [header] = await tx`
          select e.*,
                 e.first_name || ' ' || e.last_name as full_name,
                 round(extract(epoch from age(coalesce(e.termination_date, current_date), e.hire_date))
                       / (365.25 * 86400), 2) as tenure_years,
                 d.name as department_name, p.name as position_name,
                 b.name as branch_name,
                 m.first_name || ' ' || m.last_name as manager_name
          from hr.employees e
          left join hr.departments d on d.id = e.department_id
          left join hr.positions p on p.id = e.position_id
          left join core.branches b on b.id = e.branch_id
          left join hr.employees m on m.id = e.manager_id
          where e.id = ${id}`;
        if (!header) throw notFound();

        // Sözleşmeler ayrı yetki alanı: yetkisiz kullanıcıda RLS boş liste döner.
        const contracts = await tx`
          select * from hr.employee_contracts
          where employee_id = ${id} order by valid_from desc`;
        const balances = await tx`
          select * from hr.v_leave_balance_summary
          where employee_id = ${id} and year = extract(year from current_date)::smallint`;
        return { data: { ...header, contracts, balances } };
      });
    });

    /** Bordro pusulası dökümü — satırlarıyla birlikte. */
    app.get('/hr/payslips/:id/full', async (req) => {
      const { id } = req.params as { id: string };
      return run(req, async (tx) => {
        const [header] = await tx`select * from hr.v_payslip_list where id = ${id}`;
        if (!header) throw notFound();
        const lines = await tx`
          select * from hr.payslip_lines where payslip_id = ${id} order by seq`;
        return { data: { ...header, lines } };
      });
    });

    // ========================= Raporlar =========================
    app.get('/hr/reports/headcount', async (req) =>
      run(req, async (tx) => ({
        data: await tx`
          select * from hr.v_headcount_by_department
          order by branch_name nulls first, department_name`,
      })));

    app.get('/hr/reports/payroll-cost', async (req) => {
      const { year } = req.query as { year?: string };
      return run(req, async (tx) => ({
        data: await tx`
          select * from hr.v_payroll_cost_by_branch
          where (${year ?? null}::int is null or period_year = ${year ?? null}::int)
          order by period_year desc, period_month desc, branch_name`,
      }));
    });

    app.get('/hr/reports/attendance-monthly', async (req) => {
      const { period } = req.query as { period?: string };
      return run(req, async (tx) => ({
        data: await tx`
          select * from hr.v_attendance_monthly
          where (${period ?? null}::date is null or period = ${period ?? null}::date)
          order by period desc, employee_name`,
      }));
    });

    /** Onay bekleyen izinler — yönetici panosu için. */
    app.get('/hr/reports/pending-leaves', async (req) =>
      run(req, async (tx) => ({
        data: await tx`
          select * from hr.v_leave_request_list
          where status = 'pending' order by date_from`,
      })));
  },
};

export default hrModule;
