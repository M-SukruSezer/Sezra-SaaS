import { BrowserRouter, Navigate, Route, Routes } from 'react-router-dom';
import { SessionProvider, useSession } from './api/session';
import { BrandingProvider } from './api/branding';
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
import {
  EmployeeDetail, EmployeeList, HrReports, LeaveRequests, PayrollDetail, PayrollRuns,
} from './pages/Hr';
import {
  PurchaseOrderDetail, PurchaseOrderList, RequisitionDetail, RequisitionList,
  SupplierPerformance,
} from './pages/Purchasing';
import { InventoryAlerts, StockLedger, StockOnHand } from './pages/Inventory';
import { PlatformAdmins, PlatformOverview, PlatformSupportGrants, PlatformTenants } from './pages/Platform';
import {
  AccountSettings, AuditLog, Branding, CompanySettings, Definitions, ModuleAccess,
  MailAccounts, SmsSettings, SystemSettings,
} from './pages/Settings';
import { SettingsHub } from './pages/SettingsHub';
import { BarcodeScan } from './pages/BarcodeScan';
import { PartnerDetail } from './pages/PartnerDetail';
import { NoteList, NoteReport } from './pages/Notes';
import {
  InspectionDetail, InspectionList, NonconformityList, QualityReports,
} from './pages/Quality';
import {
  EquipmentList, MaintenanceReports, WorkOrderDetail, WorkOrderList,
} from './pages/Maintenance';
import { PosReports, PosSessionList, ZReport } from './pages/Pos';
import { ProjectDetail, ProjectList, ProjectReports } from './pages/Projects';
import { HelpdeskReports, TicketDetail, TicketList } from './pages/Helpdesk';
import { PortalDavet, PortalShell } from './pages/Portal';
import { AccountantAccess, MusavirPanel, musavirErisimiVar } from './pages/Musavir';

/** Davet bağlantısı: kabul ekranı bu yolda açılır. */
const DAVET_YOLU = '/portal/davet/';

function Gate() {
  const { me, profilYok, session, loading, error, signOut } = useSession();

  if (!session) return <SignIn />;
  if (loading && !me && !profilYok) return <div className="empty">Yükleniyor…</div>;

  // DAVET EKRANI PROFİLDEN ÖNCE GELİR. Daveti kabul etmeye gelen kişinin
  // henüz profil satırı ve üyeliği yoktur; profil şartı önce koşulsaydı
  // giriş ekranına atılır ve daveti hiç kabul edemezdi -- kabul etmeden de
  // profil sahibi olamaz. Kapalı bir döngü.
  const davette = window.location.pathname.startsWith(DAVET_YOLU);
  if (davette) {
    return (
      <Routes>
        <Route path="/portal/davet/:token" element={<PortalDavet />} />
      </Routes>
    );
  }

  // Profili olmayan ve davet bağlantısında da olmayan kimlik: yapabileceği
  // bir şey yok. Çıkış ŞART, yoksa bu ekranda kilitli kalır.
  if (profilYok) {
    return (
      <div className="empty">
        <p>Bu hesap henüz hiçbir şirkete bağlı değil.</p>
        <p className="muted">
          Bir portal davetiniz varsa e-postanızdaki bağlantıyı kullanın.
        </p>
        <button className="btn" onClick={signOut}>Oturumu kapat</button>
      </div>
    );
  }

  if (!me) return <SignIn />;

  // PORTAL OTURUMU AYRI KABUK: müşterinin hiçbir izni ve modülü yok; personel
  // kabuğu ona boş bir menü ve her sayfada "yetkiniz yok" gösterirdi.
  if (me.portal) return <PortalShell />;

  // PLATFORM YÖNETİCİSİ HİÇBİR KİRACIYA ÜYE DEĞİLDİR ve olmamalıdır: Sezra'nın
  // kendi hesabını bir müşteri şirketinin içine koymak, platform işletmeciliği
  // ile müşteri verisini birbirine karıştırmak olurdu. Dolayısıyla "kiracısı
  // yok" durumu onun için bir hata değil, NORMAL hâldir; konsola girer.
  const tenantless = !me.tenant;

  // MALI MÜŞAVİR: kendi şirketinde üyeliği olmayan ama en az bir kiracıya
  // müşavir erişimi olan kişi "sahipsiz hesap" değildir -- panele girer ve
  // oradan yetkili olduğu şirketleri salt okunur görür.
  const musavir = musavirErisimiVar(me);

  if (tenantless && !me.user.is_platform_admin && !musavir) {
    // Gerçekten sahipsiz hesap. Çıkış butonu ŞART: saklanan oturum artık var
    // olmayan bir kiracıyı gösteriyorsa kullanıcı bu ekranda kilitli kalır.
    return (
      <div className="empty">
        <p>Hesabınız henüz bir şirkete bağlı değil.</p>
        {error && <p className="muted">{error}</p>}
        <button className="btn" style={{ marginTop: 12 }} onClick={signOut}>
          Oturumu kapat
        </button>
      </div>
    );
  }

  return (
    <Routes>
      <Route element={<Shell />}>
        <Route index element={
          tenantless
            ? <Navigate to={me.user.is_platform_admin ? '/platform' : '/musavir'} replace />
            : <Dashboard />
        } />
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
        <Route path="finance/notes" element={<NoteList direction="in" />} />
        <Route path="finance/notes-out" element={<NoteList direction="out" />} />
        <Route path="finance/note-report" element={<NoteReport />} />
        <Route path="finance/entries/:id" element={<JournalEntryDetail />} />
        <Route path="finance/reports" element={<FinanceReports />} />
        <Route path="finance/accounts" element={<ChartOfAccounts />} />
        <Route path="hr/employees" element={<EmployeeList />} />
        <Route path="hr/employees/:id" element={<EmployeeDetail />} />
        <Route path="hr/leaves" element={<LeaveRequests />} />
        <Route path="hr/payroll" element={<PayrollRuns />} />
        <Route path="hr/payroll/:id" element={<PayrollDetail />} />
        <Route path="hr/reports" element={<HrReports />} />
        <Route path="purchasing/requisitions" element={<RequisitionList />} />
        <Route path="purchasing/requisitions/:id" element={<RequisitionDetail />} />
        <Route path="purchasing/orders" element={<PurchaseOrderList />} />
        <Route path="purchasing/orders/:id" element={<PurchaseOrderDetail />} />
        <Route path="purchasing/suppliers" element={<SupplierPerformance />} />
        <Route path="inventory/stock" element={<StockOnHand />} />
        <Route path="inventory/ledger" element={<StockLedger />} />
        <Route path="inventory/alerts" element={<InventoryAlerts />} />
        <Route path="inventory/scan" element={<BarcodeScan />} />
        <Route path="quality/inspections" element={<InspectionList />} />
        <Route path="quality/inspections/:id" element={<InspectionDetail />} />
        <Route path="quality/nonconformities" element={<NonconformityList />} />
        <Route path="quality/reports" element={<QualityReports />} />
        <Route path="maintenance/equipment" element={<EquipmentList />} />
        <Route path="maintenance/work-orders" element={<WorkOrderList />} />
        <Route path="maintenance/work-orders/:id" element={<WorkOrderDetail />} />
        <Route path="maintenance/reports" element={<MaintenanceReports />} />
        <Route path="pos/sessions" element={<PosSessionList />} />
        <Route path="pos/sessions/:id" element={<ZReport />} />
        <Route path="pos/reports" element={<PosReports />} />
        <Route path="projects" element={<ProjectList />} />
        <Route path="projects/reports" element={<ProjectReports />} />
        <Route path="projects/:id" element={<ProjectDetail />} />
        <Route path="helpdesk" element={<TicketList />} />
        <Route path="helpdesk/reports" element={<HelpdeskReports />} />
        <Route path="helpdesk/:id" element={<TicketDetail />} />
        <Route path="platform" element={<PlatformOverview />} />
        <Route path="platform/tenants" element={<PlatformTenants />} />
        <Route path="platform/admins" element={<PlatformAdmins />} />
        <Route path="platform/support-grants" element={<PlatformSupportGrants />} />
        <Route path="musavir" element={<MusavirPanel />} />
        <Route path="settings/accountant" element={<AccountantAccess />} />
        <Route path="settings" element={<SettingsHub />} />
        <Route path="settings/company" element={<CompanySettings />} />
        <Route path="settings/definitions" element={<Definitions />} />
        <Route path="settings/account" element={<AccountSettings />} />
        <Route path="settings/system" element={<SystemSettings />} />
        <Route path="settings/branding" element={<Branding />} />
        <Route path="settings/audit" element={<AuditLog />} />
        <Route path="settings/modules" element={<ModuleAccess />} />
        <Route path="settings/sms" element={<SmsSettings />} />
        <Route path="settings/mail" element={<MailAccounts />} />
        <Route path="partners" element={<Partners />} />
        <Route path="partners/:id" element={<PartnerDetail />} />
        <Route path="products" element={<Products />} />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Route>
    </Routes>
  );
}

export function App() {
  return (
    <BrowserRouter>
      {/* Marka sağlayıcısı oturumun DIŞINDADIR: giriş ekranı da logoyu
          görebilmeli, oysa orada henüz oturum yok. */}
      <BrandingProvider>
        <SessionProvider><Gate /></SessionProvider>
      </BrandingProvider>
    </BrowserRouter>
  );
}
