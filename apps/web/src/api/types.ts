export interface Me {
  user: { id: string; email: string; full_name: string | null; is_platform_admin: boolean };
  tenant: { id: string; name: string; slug: string; currency: string } | null;
  memberships: { tenant_id: string; name: string; slug: string; is_default: boolean }[];
  branches: { id: string; code: string; name: string; is_headquarter: boolean }[];
  roles: { code: string; name: string }[];
  modules: { code: string; name: string }[];
  permissions: string[];
  supportMode: boolean;
}

export interface Lead {
  id: string; branch_id: string | null; pipeline_id: string; stage_id: string;
  name: string; partner_id: string | null; contact_name: string | null;
  email: string | null; phone: string | null; source: string | null;
  expected_revenue: string; currency: string; probability: number; priority: number;
  status: 'open' | 'won' | 'lost'; lost_reason_id: string | null;
  expected_close_date: string | null; owner_id: string | null;
  notes: string | null; created_at: string; updated_at: string;
}

export interface BoardStage {
  id: string; name: string; sequence: number; probability: number;
  is_won: boolean; is_lost: boolean;
  total_revenue: number;
  leads: (Pick<Lead, 'id' | 'stage_id' | 'name' | 'expected_revenue' | 'currency' | 'probability'
    | 'priority' | 'expected_close_date' | 'owner_id'> & {
    owner_name: string | null; partner_name: string | null; branch_name: string | null;
    overdue_activities: string;
  })[];
}

export interface Board { pipeline: { id: string; name: string }; stages: BoardStage[] }

export interface Partner {
  id: string; name: string; code: string | null; is_customer: boolean; is_supplier: boolean;
  tax_office: string | null; tax_no: string | null; email: string | null; phone: string | null;
  city: string | null; district: string | null; address: string | null;
  payment_term_days: number; owner_id: string | null; is_active: boolean; branch_id: string | null;
}

export interface DocumentLine {
  id: string; sequence: number; product_id: string | null; description: string;
  quantity: string; uom_id: string | null; uom_code?: string | null;
  unit_price: string; discount_pct: string; tax_id: string | null;
  tax_code?: string | null; tax_rate?: string | null; sku?: string | null;
  line_subtotal: string; line_tax: string; line_withholding: string; line_total: string;
}

export interface SalesDocument {
  id: string; number: string | null; partner_id: string; partner_name?: string;
  tax_no?: string | null; tax_office?: string | null; owner_name?: string | null;
  status: string; currency: string;
  subtotal: string; discount_total: string; tax_total: string;
  withholding_total: string; total: string;
  payment_term_days: number; notes: string | null;
  issue_date?: string; valid_until?: string | null;
  order_date?: string; delivery_date?: string | null;
  lead_id?: string | null; quotation_id?: string | null;
  lines?: DocumentLine[];
}

export interface Product {
  id: string; sku: string; name: string; kind: string; uom_id: string | null;
  sale_price: string; sale_tax_id: string | null; currency: string; is_active: boolean;
}

export interface Stage { id: string; pipeline_id: string; name: string; sequence: number; probability: number; is_won: boolean; is_lost: boolean }
export interface LostReason { id: string; name: string }
export interface Tax { id: string; code: string; name: string; rate: string }
export interface Uom { id: string; code: string; name: string }

// ---------------------------------------------------------------------------
// Muhasebe & Finans
// ---------------------------------------------------------------------------
export interface Account {
  id: string; code: string; name: string; parent_id: string | null;
  type: 'asset' | 'liability' | 'equity' | 'income' | 'expense' | 'cost' | 'offbalance';
  is_pl: boolean; is_leaf: boolean; requires_partner: boolean; is_active: boolean;
  parent_code: string | null;
}

export interface Invoice {
  id: string; branch_id: string | null; kind: 'sale' | 'purchase'; number: string | null;
  partner_id: string; partner_name: string | null; tax_no: string | null;
  issue_date: string; due_date: string | null;
  status: 'draft' | 'approved' | 'posted' | 'partially_paid' | 'paid' | 'cancelled';
  currency: string; subtotal: string; discount_total: string; tax_total: string;
  withholding_total: string; total: string; paid_total: string; balance_due: string;
  payment_term_days: number; notes: string | null; journal_entry_id: string | null;
  source_module: string | null; source_table: string | null; source_id: string | null;
  owner_name: string | null; branch_name: string | null; line_count: string;
  einvoice_status: string | null;
  lines?: InvoiceLine[];
  payments?: { amount: string; number: string; payment_date: string; method: string; status: string }[];
}

export interface InvoiceLine {
  id: string; sequence: number; description: string; quantity: string;
  unit_price: string; discount_pct: string; line_subtotal: string; line_tax: string;
  line_withholding: string; line_total: string;
  sku: string | null; product_name: string | null; tax_code: string | null;
  tax_rate: string | null; uom_code: string | null;
  account_code: string | null; account_name: string | null;
}

export interface JournalEntry {
  id: string; number: string | null; entry_date: string; description: string | null;
  reference: string | null; status: 'draft' | 'posted' | 'reversed';
  total_debit: string; total_credit: string; journal_code: string; journal_name: string;
  branch_name: string | null; period_name: string | null; line_count: string;
  source_module: string | null; reversal_of_id: string | null;
  lines?: JournalEntryLine[];
}

export interface JournalEntryLine {
  id: string; sequence: number; account_code: string; account_name: string;
  partner_name: string | null; description: string | null; debit: string; credit: string;
}

export interface TrialBalanceRow {
  account_id: string; code: string; name: string; type: string; is_pl: boolean;
  debit_total: string; credit_total: string; balance: string;
}

export interface ProfitLoss {
  summary: {
    gross_revenue: string; sales_deductions: string; net_revenue: string; cogs: string;
    gross_profit: string; operating_expenses: string; other_income: string;
    financial_expenses: string; net_profit: string;
  } | null;
  by_branch: {
    branch_id: string | null; branch_name: string | null; net_revenue: string;
    cogs: string; gross_profit: string; operating_expenses: string; net_profit: string;
  }[];
  accounts: { code: string; name: string; type: string; group_code: string; amount: string }[];
}

export interface VatRow {
  period_start: string; kind: string; tax_code: string | null; tax_rate: string | null;
  tax_base: string; tax_amount: string; withholding_amount: string; invoice_count: string;
}

export interface AgingRow {
  kind: string; partner_id: string; partner_name: string; open_amount: string;
  not_due: string; overdue_0_30: string; overdue_31_60: string;
  overdue_61_90: string; overdue_90_plus: string; invoice_count: string;
}
