import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { NavLink, Outlet, useLocation } from 'react-router-dom';
import { useSession } from '../api/session';
import { useBranding } from '../api/branding';
import { StatusBar } from './StatusBar';
import { QuickAccess, type HizliMadde } from './QuickAccess';
import { CommandPalette, type HizliEylem } from './CommandPalette';
import { GlobalSearch } from './GlobalSearch';
import { Notifications } from './Notifications';
import { Avatar } from '../ui/Avatar';
import { ContactBox } from './ContactBox';
import { Calculator } from './Calculator';
import { t } from '../i18n';
import { applyTheme, readTheme, resolvedTheme, type Theme } from '../ui/theme';
import { Icon, type IconName } from '../ui/icons';
import { LogOut, Menu, Moon, Sparkles, Sun, Zap } from 'lucide-react';
import {
  AlertTriangle, Banknote, BarChart3, Boxes, Building2, CalendarDays,
  ClipboardCheck, ClipboardList, Contact, FileSpreadsheet, FileText, FolderKanban,
  Gauge, Handshake, History, KanbanSquare, Landmark, Layers,
  ListChecks, Package, PackageCheck, Palette, Receipt, ScanLine,
  ScrollText, Shield, Store, Tag, Ticket, TrendingUp,
  Truck, UserCog, Users, Wrench,
} from 'lucide-react';
import type { LucideIcon } from 'lucide-react';

/**
 * Tema anahtarı. Üç durumu sırayla dolaşır: sistem, aydınlık, karanlık.
 * Etiketi metin taşır; renk tek başına anlam taşımaz.
 */
function ThemeToggle() {
  const [theme, setTheme] = useState<Theme>(() => readTheme());

  const cycle = () => {
    const next: Theme = theme === 'system' ? 'light' : theme === 'light' ? 'dark' : 'system';
    setTheme(next);
    applyTheme(next);
  };

  const shown = resolvedTheme(theme);
  const label = theme === 'system'
    ? `Sistem teması (${shown === 'dark' ? 'karanlık' : 'aydınlık'})`
    : theme === 'light' ? 'Aydınlık tema' : 'Karanlık tema';

  return (
    <button className="icon-btn theme-toggle" onClick={cycle} title={label} aria-label={`${label}. Değiştir.`}>
      {shown === 'dark' ? <Moon size={16} /> : <Sun size={16} />}
    </button>
  );
}

interface NavEntry {
  to: string; label: string;
  /** Madde ikonu. Uçan panelde ve geniş menüde satırın başında durur. */
  simge?: LucideIcon;
  permission?: string; module?: string; platform?: boolean;
  /**
   * "YENİ" rozeti.
   *
   * SÜRÜME BAĞLI BİR LİSTEDİR, kalıcı bir özellik değil: bu bayrak
   * temizlenmezse rozet bir süre sonra yalan söylemeye başlar ("yeni" olmayan
   * bir şeyi yeni gösterir). Yeni bir sürüm çıkarken burası boşaltılmalı.
   */
  yeni?: boolean;
}
interface NavGroup { key: string; group: string; icon: IconName; items: NavEntry[] }

/**
 * Menü davranışının değiştiği genişlik.
 *
 * Aynı değer styles.css'teki medya sorgusunda da var; ikisi birlikte
 * değişmeli. Medya sorgusu bir token okuyamadığı için tek kaynağa
 * indirilemiyor, o yüzden burada adı konuyor.
 */
const DAR_EKRAN = '(max-width: 900px)'; // ds-allow-hardcode: medya sorgusu var() kabul etmez

/**
 * Uçan panelin kapanma gecikmesi (ms).
 *
 * Fare raydan panele geçerken kısa bir an ikisinin de dışına düşer. Bu süre
 * o geçişe yeter; daha kısası paneli yakalanmaz kılar, daha uzunu menüde
 * gezerken panellerin üst üste binmesine yol açar.
 */
const UCAN_KAPANMA_MS = 320;

/** Menü durumu oturumlar arası korunur: her açılışta aynı yerden devam edilir. */
const COLLAPSE_KEY = 'sezra.nav.collapsed';
const GROUPS_KEY = 'sezra.nav.groups';

/**
 * Dar ekranda mıyız?
 *
 * Üst çubuktaki tek menü düğmesi iki farklı şey yapar: dar ekranda menüyü
 * çekmece olarak AÇAR, geniş ekranda rayı DARALTIR. Hangisi olduğunu
 * bilmeden düğme ya mobilde rayı daraltır (görünmeyen bir şeyi) ya da
 * masaüstünde çekmece açar (zaten duran bir şeyi).
 */
function useDarEkran(): boolean {
  const [dar, setDar] = useState(() => window.matchMedia?.(DAR_EKRAN).matches ?? false);

  useEffect(() => {
    const mq = window.matchMedia?.(DAR_EKRAN);
    const guncelle = () => setDar(mq ? mq.matches : window.innerWidth <= 900);

    // İKİ OLAY BİRDEN dinlenir. `change` normal yoldur, ama her ortamda
    // güvenilir değil: gömülü/uzaktan yönetilen tarayıcılarda görünüm
    // ölçüsü değiştiğinde CSS yeni sorguyu uygularken MediaQueryList olayı
    // ateşlenmeyebiliyor. O durumda menü düğmesi yanlış davranışta kalırdı;
    // `resize` bunu kapatır. İkisi de aynı işlevi çağırdığı için çift
    // tetiklenme zararsızdır (aynı değere set edilir, React yeniden çizmez).
    mq?.addEventListener('change', guncelle);
    window.addEventListener('resize', guncelle);
    guncelle();
    return () => {
      mq?.removeEventListener('change', guncelle);
      window.removeEventListener('resize', guncelle);
    };
  }, []);

  return dar;
}

function readSet(key: string): Set<string> {
  try {
    const raw = localStorage.getItem(key);
    return new Set(raw ? (JSON.parse(raw) as string[]) : []);
  } catch { return new Set(); }
}
function writeSet(key: string, value: Set<string>): void {
  try { localStorage.setItem(key, JSON.stringify([...value])); } catch { /* depolama kapalı */ }
}

const NAV: NavGroup[] = [
  {
    key: 'platform', icon: 'panel', group: 'Platform',
    items: [
      { to: '/platform',         label: 'Genel Bakış', simge: Gauge, platform: true },
      { to: '/platform/tenants', label: 'Kiracılar', simge: Building2,   platform: true },
    ],
  },
  {
    key: 'genel', icon: 'dashboard', group: 'Anlık Görünüm',
    // Tek maddelik grup AÇILIR LİSTE OLMAZ: açılınca içinden yine tek bir
    // madde çıkan bir başlık, kullanıcıya iki tıklama karşılığında hiçbir
    // şey vermez. Aşağıda doğrudan bağlantı olarak çizilir.
    items: [{ to: '/', label: 'Anlık Görünüm', simge: Gauge }],
  },
  {
    key: 'crm', icon: 'pipeline', group: 'CRM & Satış',
    items: [
      { to: '/crm/board',      label: 'Satış Hunisi', simge: KanbanSquare, module: 'crm' },
      { to: '/crm/leads',      label: 'Fırsatlar', simge: TrendingUp,    module: 'crm' },
      { to: '/crm/quotations', label: 'Teklifler', simge: FileText,    module: 'crm' },
      { to: '/crm/orders',     label: 'Siparişler',   simge: PackageCheck, module: 'crm' },
      { to: '/crm/reports',    label: 'Raporlar', simge: BarChart3,     module: 'crm', permission: 'crm.report.read' },
    ],
  },
  {
    key: 'finance', icon: 'finance', group: 'Muhasebe & Finans',
    items: [
      { to: '/finance/sales',     label: 'Satış Faturaları', simge: Receipt,   module: 'finance', permission: 'finance.invoice.read.all' },
      { to: '/finance/purchases', label: 'Alış Faturaları', simge: ScrollText,    module: 'finance', permission: 'finance.invoice.read.all' },
      { to: '/finance/entries',   label: 'Yevmiye Defteri', simge: FileSpreadsheet,    module: 'finance', permission: 'finance.entry.read.all' },
      { to: '/finance/notes',     label: 'Alınan Çek/Senet', simge: Banknote,    module: 'finance', permission: 'finance.note.read.all' },
      { to: '/finance/notes-out', label: 'Verilen Çek/Senet', simge: Banknote,   module: 'finance', permission: 'finance.note.read.all' },
      { to: '/finance/reports',   label: 'Muhasebe Raporları', simge: BarChart3, module: 'finance', permission: 'finance.report.read' },
      { to: '/finance/accounts',  label: 'Hesap Planı', simge: Landmark,        module: 'finance', permission: 'finance.account.read.all' },
    ],
  },
  {
    key: 'inventory', icon: 'inventory', group: 'Envanter',
    items: [
      { to: '/inventory/stock',  label: 'Stok Durumu', simge: Boxes,    module: 'inventory', permission: 'inventory.stock.read' },
      { to: '/inventory/ledger', label: 'Stok Defteri', simge: ClipboardList,   module: 'inventory', permission: 'inventory.move.read.all' },
      { to: '/inventory/alerts', label: 'Stok Uyarıları', simge: AlertTriangle, module: 'inventory', permission: 'inventory.report.read' },
      { to: '/inventory/scan',   label: 'Barkod Okut', simge: ScanLine,    module: 'inventory', permission: 'inventory.barcode.read.all' },
    ],
  },
  {
    key: 'purchasing', icon: 'purchasing', group: 'Satın Alma',
    items: [
      { to: '/purchasing/requisitions', label: 'Talepler', simge: ClipboardList,              module: 'purchasing', permission: 'purchasing.requisition.read.all' },
      { to: '/purchasing/orders',       label: 'Siparişler',            simge: Truck, module: 'purchasing', permission: 'purchasing.order.read.all' },
      { to: '/purchasing/suppliers',    label: 'Tedarikçi Performansı', simge: Handshake, module: 'purchasing', permission: 'purchasing.report.read' },
    ],
  },
  {
    key: 'pos', icon: 'pos', group: 'Satış Noktası',
    items: [
      { to: '/pos/sessions', label: 'Kasa Oturumları', simge: Store, module: 'pos', permission: 'pos.session.read.all' },
      { to: '/pos/reports',  label: 'Kasa Raporları', simge: BarChart3,  module: 'pos', permission: 'pos.report.read' },
    ],
  },
  {
    key: 'projects', icon: 'projects', group: 'Projeler',
    items: [
      { to: '/projects',         label: 'Projeler', simge: FolderKanban,        module: 'projects', permission: 'projects.project.read.all' },
      { to: '/projects/reports', label: 'Proje Raporları', simge: BarChart3, module: 'projects', permission: 'projects.report.read' },
    ],
  },
  {
    key: 'helpdesk', icon: 'support', group: 'Destek',
    items: [
      { to: '/helpdesk',         label: 'Biletler', simge: Ticket,         module: 'helpdesk', permission: 'helpdesk.ticket.read.all' },
      { to: '/helpdesk/reports', label: 'Destek Raporları', simge: BarChart3, module: 'helpdesk', permission: 'helpdesk.report.read' },
    ],
  },
  {
    key: 'maintenance', icon: 'maintenance', group: 'Bakım',
    items: [
      { to: '/maintenance/equipment',   label: 'Ekipman', simge: Wrench,         module: 'maintenance', permission: 'maintenance.equipment.read.all' },
      { to: '/maintenance/work-orders', label: 'İş Emirleri', simge: ListChecks,     module: 'maintenance', permission: 'maintenance.workorder.read.all' },
      { to: '/maintenance/reports',     label: 'Bakım Raporları', simge: BarChart3, module: 'maintenance', permission: 'maintenance.report.read' },
    ],
  },
  {
    key: 'quality', icon: 'quality', group: 'Kalite',
    items: [
      { to: '/quality/inspections',     label: 'Muayeneler', simge: ClipboardCheck,       module: 'quality', permission: 'quality.inspection.read.all' },
      { to: '/quality/nonconformities', label: 'Uygunsuzluklar', simge: AlertTriangle,   module: 'quality', permission: 'quality.nonconformity.read.all' },
      { to: '/quality/reports',         label: 'Kalite Raporları', simge: BarChart3, module: 'quality', permission: 'quality.report.read' },
    ],
  },
  {
    key: 'hr', icon: 'people', group: 'İnsan Kaynakları',
    items: [
      { to: '/hr/employees', label: 'Personel', simge: Users,       module: 'hr', permission: 'hr.employee.read.all' },
      { to: '/hr/leaves',    label: 'İzin Talepleri', simge: CalendarDays, module: 'hr', permission: 'hr.leave.read.all' },
      { to: '/hr/payroll',   label: 'Bordro', simge: Banknote,         module: 'hr', permission: 'hr.payroll.read.all' },
      { to: '/hr/reports',   label: 'İK Raporları', simge: BarChart3,   module: 'hr', permission: 'hr.report.read' },
    ],
  },
  {
    key: 'settings', icon: 'settings', group: 'Yönetim',
    items: [
      // Merkez EN ÜSTTE: ayarların tamamı tek listeye sığmıyor, menüdeki
      // kısayollar en sık gidilenler. Gerisi merkezden bulunur.
      { to: '/settings',             label: 'Yönetim Paneli', simge: Layers },
      { to: '/settings/company',     label: 'Şirket', simge: Building2 },
      { to: '/settings/definitions', label: 'Tanımlar', simge: Tag },
      { to: '/settings/account',     label: 'Hesap', simge: UserCog },
      { to: '/settings/system',      label: 'Kullanıcılar', simge: Shield, permission: 'core.user.read.all' },
      { to: '/settings/modules',     label: 'Modül Erişimi', simge: Package, yeni: true },
      { to: '/settings/audit',       label: 'Denetim Günlüğü', simge: History, permission: 'core.audit.read.all', yeni: true },
      // Ürün logosu kiracının değil Sezra'nın markasıdır: menüde yalnızca
      // platform yöneticisine görünür. Gizlemek güvenlik değildir — yazma
      // yetkisini veritabanındaki platform_guard() uygular.
      { to: '/settings/branding',    label: 'Marka', simge: Palette, platform: true, yeni: true },
    ],
  },
  {
    key: 'core', icon: 'database', group: 'Ana Veri',
    items: [
      { to: '/partners', label: 'Cariler', simge: Contact, permission: 'core.partner.read.all' },
      { to: '/products', label: 'Ürünler', simge: Package, permission: 'core.product.read.all' },
    ],
  },
];

export function Shell() {
  const { me, session, switchTenant, setSupportMode, signOut } = useSession();
  const { logo: markaLogosu, branding } = useBranding();
  const [navOpen, setNavOpen] = useState(false);
  /**
   * Daraltılmış rayda açık olan uçan panel.
   *
   * KONUM DA SAKLANIR çünkü panel `position: fixed` çizilir: yan panelin
   * `overflow-y: auto` değeri CSS gereği yatay ekseni de kırpar, dolayısıyla
   * yan panelin İÇİNDE mutlak konumlanan bir kutu görünmez -- kutu yerinde
   * durur ama boyanmaz. Sabit konum bu kırpmanın dışına çıkar; karşılığında
   * çapanın ekran koordinatını elle taşımak gerekir.
   */
  const [ucan, setUcan] = useState<{ key: string; top: number; left: number } | null>(null);
  const ucanGrup = ucan?.key ?? null;

  /**
   * Ray düğmesinin ekran konumundan paneli konumlandırır.
   *
   * Dikey hiza düğmeden, yatay hiza YAN PANELİN KENARINDAN alınır: düğmenin
   * sağ kenarı menü dolgusu kadar içeride kaldığı için ona hizalanan panel
   * yan panelin üstüne biniyordu.
   */
  /**
   * KAPANMA GECİKMESİ.
   *
   * Panel imleç sarmalayıcıdan çıkar çıkmaz kapanıyordu. Fare raydan panele
   * giderken çapraz bir yol izler ve bir an için ikisinin de dışına düşer;
   * o anda panel kaybolduğu için tıklamak neredeyse imkânsızdı. Kısa bir
   * gecikme bu çapraz geçişe zaman tanır.
   *
   * AÇILIŞ GECİKMELİ DEĞİLDİR: menü gezerken beklemek yorucu olur. Yalnızca
   * kapanış bekletilir; geri dönülürse zamanlayıcı iptal olur.
   */
  const kapatmaZamani = useRef<number | null>(null);
  const kapatmayiIptalEt = () => {
    if (kapatmaZamani.current !== null) {
      window.clearTimeout(kapatmaZamani.current);
      kapatmaZamani.current = null;
    }
  };

  const ucaniAc = (key: string, el: HTMLElement | null) => {
    if (!el) return;
    kapatmayiIptalEt();
    const r = el.getBoundingClientRect();
    const kenar = el.closest('.sidebar')?.getBoundingClientRect().right ?? r.right;
    setUcan({ key, top: r.top, left: kenar });
  };

  /** Anında kapat (Escape, gezinti, menü genişletme). */
  const ucaniKapat = () => { kapatmayiIptalEt(); setUcan(null); };

  /** Gecikmeli kapat (fare ayrıldı). */
  const ucaniGecikmeliKapat = () => {
    kapatmayiIptalEt();
    kapatmaZamani.current = window.setTimeout(() => setUcan(null), UCAN_KAPANMA_MS);
  };

  useEffect(() => kapatmayiIptalEt, []);

  const ucanRef = useRef<HTMLDivElement>(null);

  /**
   * Paneli görünür alana sıkıştırır.
   *
   * Alttaki rayların paneli, çapasının hizasında açılınca ekranın altından
   * TAŞIYOR ve son maddeleri ulaşılamaz hâle geliyordu. Yükseklik ancak
   * çizimden sonra bilindiği için düzeltme burada, boyamadan önce yapılır.
   * `useEffect` kullanılsaydı kullanıcı bir kare boyunca taşmış paneli görürdü.
   */
  useLayoutEffect(() => {
    if (!ucan) return;
    const el = ucanRef.current;
    if (!el) return;
    const bosluk = 8;
    const enFazla = window.innerHeight - el.offsetHeight - bosluk;
    if (ucan.top > enFazla) {
      setUcan((u) => (u ? { ...u, top: Math.max(bosluk, enFazla) } : u));
    }
  }, [ucan]);
  const [collapsed, setCollapsed] = useState(() => readSet(COLLAPSE_KEY).has('1'));
  const [openGroups, setOpenGroups] = useState<Set<string>>(() => readSet(GROUPS_KEY));
  const location = useLocation();

  // Aktif sayfanın grubu her zaman açık olmalı: kullanıcı bir yere gidip
  // menüde onu bulamıyorsa, menü yalan söylüyor demektir.
  const activeGroup = NAV.find((g) =>
    g.items.some((i) => i.to === '/' ? location.pathname === '/' : location.pathname.startsWith(i.to)),
  )?.key;

  useEffect(() => {
    if (!activeGroup) return;
    setOpenGroups((prev) => {
      if (prev.has(activeGroup)) return prev;
      const next = new Set(prev).add(activeGroup);
      writeSet(GROUPS_KEY, next);
      return next;
    });
  }, [activeGroup]);

  const toggleGroup = (key: string) => {
    setOpenGroups((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key); else next.add(key);
      writeSet(GROUPS_KEY, next);
      return next;
    });
  };

  const toggleCollapsed = () => {
    setCollapsed((prev) => {
      writeSet(COLLAPSE_KEY, new Set(prev ? [] : ['1']));
      return !prev;
    });
  };

  // Üst çubuktaki düğme genişliğe göre farklı durumu çevirir. `aria-expanded`
  // de o duruma bakar: dar ekranda "çekmece açık mı", geniş ekranda "menü
  // genişletilmiş mi". Tek bir bayrağa bakılsaydı ekran okuyucu, ekranın
  // yarısında yanlış durumu okurdu.
  const darEkran = useDarEkran();
  const menuAcik = darEkran ? navOpen : !collapsed;
  const menuEtiketi = menuAcik ? 'Menüyü kapat' : 'Menüyü aç';

  // EYLEM, DURUMU DEĞİL GENİŞLİĞİ O AN OKUR. Etiket ve `aria-expanded` için
  // tepkisel duruma ihtiyaç var, ama tıklamanın doğru şeyi yapması için
  // yoktur: genişlik doğrudan sorulunca, bir `resize` olayı kaçırılmış olsa
  // bile düğme yanlış durumu çevirmez. Görünen etiket bir kare geride
  // kalabilir; yaptığı iş asla yanlış olmaz.
  const menuyuDegistir = () => {
    const suAndaDar = window.matchMedia?.(DAR_EKRAN).matches ?? false;
    if (suAndaDar) setNavOpen((v) => !v);
    else toggleCollapsed();
  };

  // Uçan panel Escape ile kapanır ve menü genişletilince kaybolur.
  // Klavyeyle gezen kullanıcı panelde sıkışmamalı: Escape her zaman çıkış.
  useEffect(() => {
    if (!ucanGrup) return;
    const kapat = (e: KeyboardEvent) => { if (e.key === 'Escape') ucaniKapat(); };
    window.addEventListener('keydown', kapat);
    return () => window.removeEventListener('keydown', kapat);
  }, [ucanGrup]);

  useEffect(() => { if (!collapsed) ucaniKapat(); }, [collapsed]);

  // Sayfa değişince çekmece kapanır: mobilde menüden bir şey seçtikten sonra
  // çekmecenin açık kalması, kullanıcıyı içeriğin önünde bırakır.
  useEffect(() => { setNavOpen(false); }, [location.pathname]);

  /**
   * Komut paleti kısayolu.
   *
   * `metaKey` hem macOS'ta Command hem Windows'ta Windows tuşudur, `ctrlKey`
   * de Windows/Linux'un alışkanlığını karşılar; üçü de aynı paleti açar.
   *
   * TARAYICININ "SAYFADA BUL"U EZİLİYOR: Ctrl/Cmd+F normalde tarayıcının
   * kendi aramasını açar. Bilinçli bir seçim -- bu uygulamada aranan şey
   * sayfadaki metin değil, gidilecek ekran. `preventDefault` olmadan iki
   * arama kutusu birden açılırdı. K de takma ad olarak bağlı: alışkanlığı
   * o olan kullanıcı da aynı yere varır.
   */
  const [paletAcik, setPaletAcik] = useState(false);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const tus = e.key.toLowerCase();
      if ((e.ctrlKey || e.metaKey) && (tus === 'f' || tus === 'k')) {
        e.preventDefault();
        setPaletAcik((v) => !v);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  // Escape ile kapanmalı: açık bir katmanın klavyeyle çıkışı olmak zorunda.
  useEffect(() => {
    if (!navOpen) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setNavOpen(false); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [navOpen]);

  if (!me) return null;

  const enabledModules = new Set(me.modules.map((m) => m.code));
  const permissions = new Set(me.permissions);

  // Menü izinlere ve açık modüllere göre filtrelenir. Bu YALNIZCA görünürlük
  // içindir: kullanıcı URL'yi elle yazsa bile API/RLS onu durdurur.
  // Platform uçları kiracı iznine değil, platform yöneticiliğine bağlıdır.
  /**
   * Hızlı erişimin önerebileceği ekranlar.
   *
   * Menünün SÜZÜLMÜŞ hâlinden türer: kullanıcının yetkisi olmayan ya da
   * modülü kapalı bir ekranı önermek, tıklandığında boş sayfa demektir.
   */
  const visible = (e: NavEntry) =>
    (!e.platform || me.user.is_platform_admin) &&
    (!e.module || enabledModules.has(e.module)) &&
    (!e.permission || permissions.has(e.permission));

  // Liste yalnızca oturum (yetki/modül) değişince yeniden kurulur; her
  // çizimde yeni dizi üretmek alt bileşeni boşuna çalıştırıyordu.
  const hizliMaddeler: HizliMadde[] = useMemo(() => NAV.flatMap((g) =>
    g.items.filter(visible).map((e) => ({
      to: e.to, label: e.label, grup: g.group, simge: e.simge,
    }))), [me]); // eslint-disable-line react-hooks/exhaustive-deps

  /**
   * Paletin "hızlı oluştur" bölümü.
   *
   * YALNIZCA GERÇEKTEN ÇALIŞAN hedefler. Modülü kapalı ya da izni olmayan
   * eylem hiç çizilmez; çizilip "yetkiniz yok" demek, kullanıcıyı boşuna
   * bir tıklamaya göndermektir.
   */
  const hizliEylemler: HizliEylem[] = useMemo(() => [
    {
      ad: 'Yeni fırsat oluştur', yol: '/crm/leads/yeni', simge: TrendingUp,
      aciklama: 'CRM · fırsat kartı açılır',
      gorunur: enabledModules.has('crm') && permissions.has('crm.lead.create'),
    },
    {
      ad: 'Yeni cari ekle', yol: '/partners?yeni=1', simge: Building2,
      aciklama: 'Tanımlar · cari formu açılır',
      gorunur: permissions.has('core.partner.create'),
    },
  ], [me]); // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <div className="shell" data-nav={navOpen ? 'open' : 'closed'} data-collapsed={collapsed ? 'yes' : 'no'}>
      <aside className="sidebar" id="ana-menu">
        <div className="brand">
          {/* MARKA TEK BİR ŞEYLE ANLATILIR: logo varsa ürün adı yazısı
              tekrar olur ve okunacak iki nesne yaratır. Bu yüzden yazı
              işareti yalnızca logo YOKKEN gösterilir.

              Daraltılmış rayda yatay logo okunacak boyuta sığmaz; orada
              harf işareti kalır. Logo o genişliğe sıkıştırılsaydı okunmayan
              bir leke olurdu ki asıl şikâyet buydu. */}
          {markaLogosu && !collapsed
            ? <img className="brand-logo" src={markaLogosu} alt={t('app.name')} />
            : (
              <>
                <span className="brand-mark">S</span>
                {!collapsed && <span className="brand-name">{t('app.name')}</span>}
              </>
            )}
        </div>

        {/* Şirket seçici marka alanının hemen altında: hangi kiracıda
            çalışıldığı, menüye bakmadan önce görülmeli. */}
        {!collapsed && (
          <div className="org-switch">
            {me.memberships.length > 1 ? (
              <select
                value={me.tenant?.id ?? ''}
                onChange={(e) => switchTenant(e.target.value)}
                aria-label="Şirket seç"
              >
                {me.memberships.map((m) => (
                  <option key={m.tenant_id} value={m.tenant_id}>{m.name}</option>
                ))}
              </select>
            ) : (
              <div className="org-current">
                <span className="org-name">{me.tenant?.name ?? 'Platform konsolu'}</span>
                {me.branches.length > 0 && (
                  <span className="org-meta">
                    {me.branches.length === 1 ? me.branches[0]!.name : `${me.branches.length} şube`}
                  </span>
                )}
              </div>
            )}
          </div>
        )}

        <nav className="nav">
          {NAV.map((group) => {
            const items = group.items.filter(visible);
            if (items.length === 0) return null;
            const isOpen = openGroups.has(group.key);
            const hasActive = group.key === activeGroup;

            // TEK MADDELİK GRUP AÇILIR LİSTE OLMAZ. Açılınca içinden yine tek
            // bir madde çıkan bir başlık, iki tıklama karşılığında hiçbir şey
            // vermez; doğrudan bağlantı olur.
            const tekMadde = items.length === 1 ? items[0]! : null;

            // DARALTILMIŞ: yalnızca grup ikonları. Üzerine gelince ya da
            // odaklanınca grubun maddeleri yan panelde açılır — menüyü
            // genişletmeden. Tek maddeli grupta panel gereksizdir, ikon
            // doğrudan bağlantıdır.
            if (collapsed) {
              if (tekMadde) {
                return (
                  <NavLink
                    key={group.key}
                    to={tekMadde.to}
                    end={tekMadde.to === '/'}
                    className={({ isActive }) => `nav-rail${isActive ? ' active' : ''}`}
                    title={group.group}
                    aria-label={group.group}
                  >
                    <Icon name={group.icon} />
                  </NavLink>
                );
              }
              return (
                <div
                  className="nav-rail-sarmal"
                  key={group.key}
                  onMouseEnter={(e) => ucaniAc(group.key, e.currentTarget)}
                  onMouseLeave={() => { if (ucanGrup === group.key) ucaniGecikmeliKapat(); }}
                >
                  <button
                    className={`nav-rail${hasActive ? ' active' : ''}`}
                    onClick={(e) => (ucanGrup === group.key
                      ? ucaniKapat()
                      : ucaniAc(group.key, e.currentTarget.parentElement))}
                    onFocus={(e) => ucaniAc(group.key, e.currentTarget.parentElement)}
                    aria-expanded={ucanGrup === group.key}
                    aria-haspopup="true"
                    title={group.group}
                    aria-label={group.group}
                  >
                    <Icon name={group.icon} />
                  </button>

                  {ucan?.key === group.key && (
                    <div
                      className="nav-ucan"
                      ref={ucanRef}
                      onMouseEnter={kapatmayiIptalEt}
                      onMouseLeave={ucaniGecikmeliKapat}
                      role="group"
                      aria-label={group.group}
                      style={{ top: ucan.top, left: ucan.left }}
                    >
                      <div className="nav-ucan-icerik">
                      <div className="nav-ucan-baslik">{group.group}</div>
                      {items.map((item) => (
                        <NavLink
                          key={item.to} to={item.to} end={item.to === '/'}
                          className={({ isActive }) => `nav-item${isActive ? ' active' : ''}`}
                          onClick={() => { ucaniKapat(); setNavOpen(false); }}
                        >
                          {item.simge && <item.simge className="nav-item-simge" aria-hidden="true" />}
                          <span className="nav-item-ad">{item.label}</span>
                          {item.yeni && <span className="nav-yeni">Yeni</span>}
                        </NavLink>
                      ))}
                      </div>
                    </div>
                  )}
                </div>
              );
            }

            if (tekMadde) {
              return (
                <NavLink
                  key={group.key}
                  to={tekMadde.to}
                  end={tekMadde.to === '/'}
                  className={({ isActive }) => `nav-group nav-group-tek${isActive ? ' active' : ''}`}
                  onClick={() => setNavOpen(false)}
                >
                  <Icon name={group.icon} />
                  <span className="nav-group-label">{group.group}</span>
                </NavLink>
              );
            }

            return (
              <div className="nav-section" key={group.key}>
                <button
                  className="nav-group"
                  onClick={() => toggleGroup(group.key)}
                  aria-expanded={isOpen}
                  aria-controls={`grup-${group.key}`}
                >
                  <Icon name={group.icon} />
                  <span className="nav-group-label">{group.group}</span>
                  {/* Kapalı grupta içerideki madde sayısı görünür: kullanıcı
                      açmadan önce orada ne olduğunu bilir. */}
                  {!isOpen && <span className="nav-count">{items.length}</span>}
                  <Icon name="chevron" className="icon nav-chevron" />
                </button>

                <div className="nav-items" id={`grup-${group.key}`} hidden={!isOpen}>
                  {items.map((item) => (
                    <NavLink
                      key={item.to} to={item.to} end={item.to === '/'}
                      className={({ isActive }) => `nav-item${isActive ? ' active' : ''}`}
                      // Yol değişimini beklemek yetmiyor: kullanıcı ZATEN
                      // bulunduğu sayfanın bağlantısına dokunduğunda pathname
                      // değişmez, efekt tetiklenmez ve çekmece içeriğin
                      // önünde açık kalırdı.
                      onClick={() => setNavOpen(false)}
                    >
                      {item.simge && <item.simge className="nav-item-simge" aria-hidden="true" />}
                      <span className="nav-item-ad">{item.label}</span>
                      {item.yeni && <span className="nav-yeni">Yeni</span>}
                    </NavLink>
                  ))}
                </div>
              </div>
            );
          })}
        </nav>

        {/* Kullanıcı bölümü YAN MENÜDE DEĞİL, üst çubukta: menü daraltılıp
            kapatılabiliyor, üst çubuk ise her ekranda sabit. Kimliğin iki
            yerde birden durması ayrıca hangisinin doğru olduğu sorusunu
            doğuruyordu. */}
      </aside>

      <div className="main">
        <header className="topbar">
          {/* TEK MENÜ DÜĞMESİ. Yan panelin içindeki daralt düğmesi kaldırıldı:
              menü daraltılmışken o düğme de daralıyordu, yani kontrol
              kontrol ettiği şeyle birlikte küçülüyordu. Üst çubuk her
              genişlikte sabit durur, dolayısıyla menüye erişim de sabittir. */}
          <button
            className="icon-btn nav-toggle"
            onClick={menuyuDegistir}
            aria-expanded={menuAcik}
            aria-controls="ana-menu"
            title={menuEtiketi}
            aria-label={menuEtiketi}
          >
            <Menu size={18} />
          </button>

          {/* Hızlı Erişim aramanın SOLUNDA: ikisi de "bir yere gitmek" için ama
              hızlı erişim hatırlamayı gerektirmez, arama gerektirir. Daha az
              çaba isteyen önce gelir. */}
          <QuickAccess maddeler={hizliMaddeler} userId={me.user.id} />

          {/* KAYIT araması: firma, kişi, ürün, teklif, fatura. SAYFA aramak
              komut paletinin işi (Ctrl+F) -- ikisi tek kutuda toplansaydı
              "Ahmet" yazan kullanıcıya "Cariler" sayfası önerilirdi. */}
          <GlobalSearch />

          {/* Bize ulaşın: aramanın hemen sağında. Kurulumda takılan kullanıcı
              önce arar, sonra arama yapar. */}
          <ContactBox branding={branding} />

          <div className="spacer" />

          {/* Dar ekranda etiket gizlenir, ikon kalir; erisilebilir ad
              aria-label'dan gelir, boylece isim etiketle birlikte kaybolmaz. */}
          <button className="btn btn-sm" title="Asistan" aria-label="Asistan">
            <Sparkles size={15} /> <span className="btn-label">Asistan</span>
          </button>
          <button className="btn btn-sm btn-primary" title="Hızlı Satış" aria-label="Hızlı Satış">
            <Zap size={15} /> <span className="btn-label">Hızlı Satış</span>
          </button>
          <ThemeToggle />
          <Notifications />

          {/* Hesap makinesi kullanıcının SOLUNDA: ikisi de "benimle ilgili"
              bölgede ama hesap makinesi bir araç, kullanıcı bir kimliktir;
              araçlar kimliğin soluna toplanır. */}
          <Calculator />

          {/* Kim olarak ve HANGİ ŞİRKETTE çalışıldığı üst çubukta durur.
              Yan menüde de var ama menü daraltılabiliyor; çok kiracılı bir
              üründe "hangi şirketteyim" sorusunun yanıtı hep görünmeli. */}
          <div className="oturum">
            {/* Kimlik TIKLANABİLİR: kullanıcının kendi bilgilerine giden en
                kısa yol, adının üstüdür. Ayarlar menüsünü aramak gerekmez. */}
            <NavLink className="oturum-bag" to="/settings/account"
                     title="Profilim">
              <Avatar
                id={me.user.id}
                ad={me.user.full_name ?? me.user.email}
                gorsel={me.user.avatar_url ?? null}
                olcu="sm"
              />
              <span className="oturum-ad">
                <span className="oturum-kisi">{me.user.full_name ?? me.user.email}</span>
                <span className="oturum-sirket">
                  <span className="oturum-nokta" aria-hidden="true" />
                  {me.tenant?.name ?? 'Platform konsolu'}
                </span>
              </span>
            </NavLink>

            <button className="icon-btn oturum-cikis" onClick={signOut}
                    title="Oturumu kapat" aria-label="Oturumu kapat">
              <LogOut size={16} />
            </button>
          </div>

          {me.user.is_platform_admin && (
            <label className="row support-toggle" title="Kiracı verisine erişim denetim izine işlenir">
              <input
                type="checkbox"
                checked={session?.supportMode ?? false}
                onChange={(e) => setSupportMode(e.target.checked)}
              />
              Destek
            </label>
          )}
          {me.support_session && (
            <span className="badge badge-warn" title="Bu erişim denetim izine yazılır">
              Destek oturumu
            </span>
          )}
        </header>

        <main className="content"><Outlet /></main>

        <StatusBar />

        <CommandPalette acik={paletAcik} kapat={() => setPaletAcik(false)}

                        maddeler={hizliMaddeler} eylemler={hizliEylemler} />
      </div>

      {/* Çekmece açıkken arkayı kapatan katman. Buton olarak veriliyor ki
          tıklamanın yanı sıra klavyeyle de kapatılabilsin. */}
      <button
        className="scrim"
        onClick={() => setNavOpen(false)}
        tabIndex={navOpen ? 0 : -1}
        aria-label="Menüyü kapat"
      />
    </div>
  );
}
