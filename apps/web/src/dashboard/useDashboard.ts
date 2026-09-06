import { useList, useItem } from '../ui/useResource';

/**
 * Panelin tüm veri kaynağı tek yerde.
 *
 * Bileşenlerin içine veri gömülmez ve her bileşen kendi isteğini atmaz:
 * panel açıldığında hangi uçların çağrıldığı buradan okunur. Bir gösterge
 * kaldırılacaksa tek yerden kaldırılır.
 */
export interface Kpis {
  sales_today: string; sales_mtd: string; purchases_mtd: string;
  collections_today: string; payments_today: string; cash_bank_total: string;
  receivable_total: string; payable_total: string;
  receivable_overdue: string; receivable_overdue_count: number;
  payable_due_7d: string; purchase_unpaid: string;
}

export interface TrendPoint { day: string; total: string; invoice_count: number }
export interface CashAccount { account_id: string; code: string; name: string; balance: string }
export interface RecentSale {
  id: string; number: string | null; partner_name: string | null;
  issue_date: string; total: string; status: string; balance_due: string;
}
export interface TopProduct {
  product_id: string; sku: string | null; name: string | null;
  quantity: string; revenue: string;
}
export interface AgingRow {
  partner_id: string; partner_name: string; kind: string;
  open_amount: string; overdue_0_30: string; overdue_31_60: string;
  overdue_61_90: string; overdue_90_plus: string; earliest_due: string | null;
}
export interface LowStockRow {
  product_id: string; sku: string; product_name: string;
  on_hand: string; min_quantity: string; suggested_quantity: string;
}

export function useDashboard(enabled: { finance: boolean; inventory: boolean }) {
  const kpis = useItem<Kpis>(enabled.finance ? '/finance/dashboard/kpis' : null);
  const trend = useList<TrendPoint>(
    enabled.finance ? '/finance/dashboard/sales-trend' : '', { days: 30 });
  const cash = useList<CashAccount>(enabled.finance ? '/finance/dashboard/cash-accounts' : '');
  const recent = useList<RecentSale>(enabled.finance ? '/finance/dashboard/recent-sales' : '');
  const products = useList<TopProduct>(enabled.finance ? '/finance/dashboard/top-products' : '');
  const aging = useList<AgingRow>(enabled.finance ? '/finance/reports/aging' : '');
  const lowStock = useList<LowStockRow>(
    enabled.inventory ? '/inventory/reports/reorder-alerts' : '');

  return { kpis, trend, cash, recent, products, aging, lowStock };
}
