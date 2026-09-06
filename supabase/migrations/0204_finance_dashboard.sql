-- =============================================================================
-- 0204 — Panel toplamları
-- =============================================================================
-- Panel on iki göstergeyi aynı anda ister. Bunları ayrı ayrı sorgulamak on iki
-- HTTP isteği ve on iki RLS geçişi demekti; tek fonksiyon tek turda döndürüyor.
--
-- RLS: fonksiyonlar `security invoker`. Yani panel, sorguyu ÇALIŞTIRAN
-- kullanıcının görebildiği veriyi toplar. Şube müdürü kendi şubesinin
-- rakamlarını görür; ayrı bir yetki mantığı yazmaya gerek yok, mevcut
-- politikalar zaten doğru cevabı veriyor.
-- =============================================================================

create or replace function finance.dashboard_kpis()
returns table (
  sales_today        numeric,
  sales_mtd          numeric,
  purchases_mtd      numeric,
  collections_today  numeric,
  payments_today     numeric,
  cash_bank_total    numeric,
  receivable_total   numeric,
  payable_total      numeric,
  receivable_overdue numeric,
  receivable_overdue_count integer,
  payable_due_7d     numeric,
  purchase_unpaid    numeric
)
language sql
stable
security invoker
as $$
  with
  inv as (
    select kind, status, issue_date, total, balance_due, due_date
    from finance.v_open_invoices
  ),
  posted as (
    -- Taslak fatura ciro değildir: yalnızca muhasebeleşmiş belgeler sayılır.
    select kind, issue_date, total
    from finance.invoices
    where status in ('posted', 'partially_paid', 'paid')
  ),
  pay as (
    select direction, payment_date, amount
    from finance.payments where status = 'posted'
  )
  select
    coalesce((select sum(total) from posted
               where kind = 'sale' and issue_date = current_date), 0),
    coalesce((select sum(total) from posted
               where kind = 'sale' and issue_date >= date_trunc('month', current_date)), 0),
    coalesce((select sum(total) from posted
               where kind = 'purchase' and issue_date >= date_trunc('month', current_date)), 0),
    coalesce((select sum(amount) from pay
               where direction = 'in' and payment_date = current_date), 0),
    coalesce((select sum(amount) from pay
               where direction = 'out' and payment_date = current_date), 0),
    -- Kasa ve banka: THP'de 100 ve 102. Bakiye borç eksi alacak.
    coalesce((select sum(b.debit_total - b.credit_total)
                from finance.account_balances b
                join finance.accounts a on a.id = b.account_id
               where a.code in ('100', '102')), 0),
    -- Yaşlandırma görünümünde `kind` FATURA TÜRÜDÜR: satış faturası alacak,
    -- alış faturası borç doğurur.
    coalesce((select sum(open_amount) from finance.v_partner_aging
               where kind = 'sale'), 0),
    coalesce((select sum(open_amount) from finance.v_partner_aging
               where kind = 'purchase'), 0),
    coalesce((select sum(overdue_0_30 + overdue_31_60 + overdue_61_90 + overdue_90_plus)
                from finance.v_partner_aging where kind = 'sale'), 0),
    coalesce((select count(*)::integer from inv
               where kind = 'sale' and balance_due > 0 and due_date < current_date), 0),
    coalesce((select sum(balance_due) from inv
               where kind = 'purchase' and balance_due > 0
                 and due_date between current_date and current_date + 7), 0),
    coalesce((select sum(balance_due) from inv
               where kind = 'purchase' and balance_due > 0), 0);
$$;

-- Son N günün satış eğrisi. Boş günler SIFIR olarak döner: grafikte gün
-- atlanırsa eğri yalan söyler.
create or replace function finance.dashboard_sales_trend(p_days integer default 30)
returns table (day date, total numeric, invoice_count integer)
language sql
stable
security invoker
as $$
  select
    d.day::date,
    coalesce(sum(i.total), 0),
    count(i.id)::integer
  from generate_series(
         current_date - (greatest(p_days, 1) - 1), current_date, interval '1 day'
       ) as d(day)
  left join finance.invoices i
    on i.issue_date = d.day::date
   and i.kind = 'sale'
   and i.status in ('posted', 'partially_paid', 'paid')
  group by d.day
  order by d.day;
$$;

-- Kasa ve banka hesaplarının dağılımı (halka grafik).
create or replace function finance.dashboard_cash_accounts()
returns table (account_id uuid, code text, name text, balance numeric)
language sql
stable
security invoker
as $$
  select a.id, a.code, a.name,
         coalesce(sum(b.debit_total - b.credit_total), 0) as balance
  from finance.accounts a
  left join finance.account_balances b on b.account_id = a.id
  where a.code in ('100', '101', '102', '108') and a.is_leaf
  group by a.id, a.code, a.name
  having coalesce(sum(b.debit_total - b.credit_total), 0) <> 0
  order by 4 desc;
$$;

-- Son satışlar, en çok satan ürünler ve tahsilat bekleyen cariler panelin
-- alt bölümünü besler. Hepsi mevcut görünümlerden türüyor.
create or replace function finance.dashboard_recent_sales(p_limit integer default 6)
returns table (id uuid, number text, partner_name text, issue_date date,
               total numeric, status text, balance_due numeric)
language sql
stable
security invoker
as $$
  select i.id, i.number, i.partner_name, i.issue_date, i.total,
         i.status::text, i.balance_due
  from finance.v_invoice_list i
  where i.kind = 'sale'
  order by i.issue_date desc, i.created_at desc
  limit greatest(p_limit, 1);
$$;

create or replace function finance.dashboard_top_products(p_limit integer default 6)
returns table (product_id uuid, sku text, name text,
               quantity numeric, revenue numeric)
language sql
stable
security invoker
as $$
  select l.product_id, p.sku, p.name,
         sum(l.quantity), sum(l.line_total)
  from finance.invoice_lines l
  join finance.invoices i on i.id = l.invoice_id
  left join core.products p on p.id = l.product_id
  where i.kind = 'sale'
    and i.status in ('posted', 'partially_paid', 'paid')
    and i.issue_date >= date_trunc('month', current_date)
    and l.product_id is not null
  group by l.product_id, p.sku, p.name
  order by 5 desc
  limit greatest(p_limit, 1);
$$;
