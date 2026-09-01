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
