import { BrowserRouter, Navigate, Route, Routes } from 'react-router-dom';
import { SessionProvider, useSession } from './api/session';
import { Shell } from './layout/Shell';
import { SignIn } from './pages/SignIn';
import { Dashboard } from './pages/Dashboard';
import { LeadsBoard } from './pages/LeadsBoard';
import { LeadForm, LeadList } from './pages/Leads';
import { OrderDetail, OrderList, QuotationDetail, QuotationList } from './pages/SalesDocs';
import { Partners, Products } from './pages/Partners';
import { InvoiceDetail, InvoiceList } from './pages/Invoices';
import {
  ChartOfAccounts, FinanceReports, JournalEntryDetail, JournalEntryList,
} from './pages/Accounting';
import { Reports } from './pages/Reports';

function Gate() {
  const { me, session, loading, error } = useSession();

  if (!session) return <SignIn />;
  if (loading && !me) return <div className="empty">Yükleniyor…</div>;
  if (!me) return <SignIn />;

  // Kiracısı olmayan kullanıcı — onboarding akışı buraya bağlanacak
  if (!me.tenant) {
    return (
      <div className="empty">
        <p>Hesabınız henüz bir şirkete bağlı değil.</p>
        {error && <p className="muted">{error}</p>}
      </div>
    );
  }

  return (
    <Routes>
      <Route element={<Shell />}>
        <Route index element={<Dashboard />} />
        <Route path="crm/board" element={<LeadsBoard />} />
        <Route path="crm/leads" element={<LeadList />} />
        <Route path="crm/leads/:id" element={<LeadForm />} />
        <Route path="crm/quotations" element={<QuotationList />} />
        <Route path="crm/quotations/:id" element={<QuotationDetail />} />
        <Route path="crm/orders" element={<OrderList />} />
        <Route path="crm/orders/:id" element={<OrderDetail />} />
        <Route path="crm/reports" element={<Reports />} />
        <Route path="finance/sales" element={<InvoiceList kind="sale" />} />
        <Route path="finance/sales/:id" element={<InvoiceDetail kind="sale" />} />
        <Route path="finance/purchases" element={<InvoiceList kind="purchase" />} />
        <Route path="finance/purchases/:id" element={<InvoiceDetail kind="purchase" />} />
        <Route path="finance/entries" element={<JournalEntryList />} />
        <Route path="finance/entries/:id" element={<JournalEntryDetail />} />
        <Route path="finance/reports" element={<FinanceReports />} />
        <Route path="finance/accounts" element={<ChartOfAccounts />} />
        <Route path="partners" element={<Partners />} />
        <Route path="products" element={<Products />} />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Route>
    </Routes>
  );
}

export function App() {
  return (
    <BrowserRouter>
      <SessionProvider><Gate /></SessionProvider>
    </BrowserRouter>
  );
}
