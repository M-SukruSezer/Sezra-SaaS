import { NavLink, Outlet } from 'react-router-dom';
import { useSession } from '../api/session';
import { t } from '../i18n';

interface NavEntry { to: string; label: string; permission?: string; module?: string }

const NAV: { group: string; items: NavEntry[] }[] = [
  {
    group: 'Genel',
    items: [{ to: '/', label: t('nav.dashboard') }],
  },
  {
    group: t('nav.crm'),
    items: [
      { to: '/crm/board',      label: t('nav.board'),      module: 'crm' },
      { to: '/crm/leads',      label: t('nav.leads'),      module: 'crm' },
      { to: '/crm/quotations', label: t('nav.quotations'), module: 'crm' },
      { to: '/crm/orders',     label: t('nav.orders'),     module: 'crm' },
      { to: '/crm/reports',    label: t('nav.reports'),    module: 'crm', permission: 'crm.report.read' },
    ],
  },
  {
    group: 'Muhasebe & Finans',
    items: [
      { to: '/finance/sales',     label: 'Satış Faturaları',  module: 'finance', permission: 'finance.invoice.read.all' },
      { to: '/finance/purchases', label: 'Alış Faturaları',   module: 'finance', permission: 'finance.invoice.read.all' },
      { to: '/finance/entries',   label: 'Yevmiye Defteri',   module: 'finance', permission: 'finance.entry.read.all' },
      { to: '/finance/reports',   label: 'Muhasebe Raporları',module: 'finance', permission: 'finance.report.read' },
      { to: '/finance/accounts',  label: 'Hesap Planı',       module: 'finance', permission: 'finance.account.read.all' },
    ],
  },
  {
    group: 'Ana Veri',
    items: [
      { to: '/partners', label: t('nav.partners'), permission: 'core.partner.read.all' },
      { to: '/products', label: t('nav.products'), permission: 'core.product.read.all' },
    ],
  },
];

export function Shell() {
  const { me, session, switchTenant, setSupportMode, signOut } = useSession();
  if (!me) return null;

  const enabledModules = new Set(me.modules.map((m) => m.code));
  const permissions = new Set(me.permissions);

  // Menü izinlere ve açık modüllere göre filtrelenir. Bu YALNIZCA görünürlük
  // içindir: kullanıcı URL'yi elle yazsa bile API/RLS onu durdurur.
  const visible = (e: NavEntry) =>
    (!e.module || enabledModules.has(e.module)) &&
    (!e.permission || permissions.has(e.permission));

  return (
    <div className="shell">
      <aside className="sidebar">
        <div className="brand">
          <span className="brand-mark">S</span>
          <span>{t('app.name')}</span>
        </div>
        <nav className="nav">
          {NAV.map((group) => {
            const items = group.items.filter(visible);
            if (items.length === 0) return null;
            return (
              <div key={group.group}>
                <div className="nav-group">{group.group}</div>
                {items.map((item) => (
                  <NavLink
                    key={item.to} to={item.to} end={item.to === '/'}
                    className={({ isActive }) => `nav-item${isActive ? ' active' : ''}`}
                  >
                    {item.label}
                  </NavLink>
                ))}
              </div>
            );
          })}
        </nav>
      </aside>

      <div className="main">
        <header className="topbar">
          {me.memberships.length > 1 ? (
            <select
              value={me.tenant?.id ?? ''}
              onChange={(e) => switchTenant(e.target.value)}
              style={{ width: 'auto' }}
            >
              {me.memberships.map((m) => (
                <option key={m.tenant_id} value={m.tenant_id}>{m.name}</option>
              ))}
            </select>
          ) : (
            <strong>{me.tenant?.name ?? '—'}</strong>
          )}

          <span className="badge">
            {me.branches.length === 1 ? me.branches[0]!.name : `${me.branches.length} şube`}
          </span>

          <div className="spacer" />

          {me.user.is_platform_admin && (
            <label className="row" style={{ fontSize: 12, gap: 6 }} title="Kiracı verisine erişim — denetim izine işlenir">
              <input
                type="checkbox" style={{ width: 'auto' }}
                checked={session?.supportMode ?? false}
                onChange={(e) => setSupportMode(e.target.checked)}
              />
              Destek modu
            </label>
          )}

          <span className="muted" style={{ fontSize: 13 }}>
            {me.user.full_name} · {me.roles.map((r) => r.name).join(', ')}
          </span>
          <button className="btn btn-sm" onClick={signOut}>Çıkış</button>
        </header>

        <main className="content"><Outlet /></main>
      </div>
    </div>
  );
}
