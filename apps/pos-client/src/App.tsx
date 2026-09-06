import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { api, getUser, setUser } from './api';
import {
  computeTotals, enqueue, loadCatalog, loadQueue, loadSession, money, nextClientSeq,
  removeFromQueue, bumpAttempts, saveCatalog, saveSession, round2,
  type CatalogProduct, type CatalogSnapshot, type PosSessionRef,
  type QueuedLine, type QueuedOrder, type QueuedPayment,
} from './offline';

const DEMO_USERS = [
  { id: '22222222-2222-2222-2222-222222222222', label: 'Merve Yıldız — Şirket Yöneticisi' },
  { id: '44444444-4444-4444-4444-444444444444', label: 'Deniz Aras — Şube Müdürü' },
];

// =============================================================================
// Kurulum: terminal seç, kataloğu indir, kasa aç
// =============================================================================
function Setup({ onReady }: { onReady: (c: CatalogSnapshot, s: PosSessionRef) => void }) {
  const [user, setU] = useState(getUser() || DEMO_USERS[0]!.id);
  const [terminals, setTerminals] = useState<{ id: string; code: string; name: string }[]>([]);
  const [terminalId, setTerminalId] = useState('');
  const [openingCash, setOpeningCash] = useState('500');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  const loadTerminals = useCallback(async () => {
    setUser(user);
    const res = await api.get<{ data: { id: string; code: string; name: string }[] }>(
      '/pos/terminals?is_active=true&limit=50');
    if (res.ok) {
      const list = (res.data as unknown as { data?: typeof terminals })?.data ?? [];
      setTerminals(list);
      if (list[0]) setTerminalId(list[0].id);
      setError('');
    } else {
      setError(res.offline ? 'Sunucuya ulaşılamıyor — kasa açmak için bağlantı gerekir' : res.error);
    }
  }, [user]);

  useEffect(() => { void loadTerminals(); }, [loadTerminals]);

  const start = async () => {
    if (!terminalId) return;
    setBusy(true); setError('');
    try {
      // Katalog ve kasa açılışı ÇEVRİMİÇİ yapılır: vardiya başlarken bağlantı
      // olması makul bir beklenti. Vardiya SIRASINDA kopması normaldir ve
      // satışı durdurmaz.
      const cat = await api.get<{ terminal: { id: string; prices_include_tax: boolean };
                                 products: CatalogProduct[]; fetched_at: string }>(
        `/pos/catalog?terminal_id=${terminalId}`);
      if (!cat.ok) { setError(cat.error); return; }

      const ses = await api.post<PosSessionRef>('/pos/sessions/open', {
        terminal_id: terminalId, opening_cash: Number(openingCash) || 0,
      });
      if (!ses.ok) { setError(ses.error); return; }

      const snapshot: CatalogSnapshot = {
        fetched_at: cat.data.fetched_at,
        terminal_id: terminalId,
        prices_include_tax: cat.data.terminal.prices_include_tax,
        products: cat.data.products.map((p) => ({
          ...p, tax_rate: Number(p.tax_rate), barcodes: p.barcodes ?? [],
        })),
      };
      saveCatalog(snapshot);
      saveSession(ses.data);
      onReady(snapshot, ses.data);
    } finally { setBusy(false); }
  };

  return (
    <div className="center">
      <div className="card">
        <h1>Sezra Kasa</h1>
        <p>Vardiya başlangıcı — katalog indirilir ve kasa açılır</p>

        <div className="field">
          <label>Kullanıcı</label>
          <select value={user} onChange={(e) => setU(e.target.value)}>
            {DEMO_USERS.map((u) => <option key={u.id} value={u.id}>{u.label}</option>)}
          </select>
        </div>

        <div className="field">
          <label>Terminal</label>
          <select value={terminalId} onChange={(e) => setTerminalId(e.target.value)}>
            {terminals.map((t) => <option key={t.id} value={t.id}>{t.code} — {t.name}</option>)}
          </select>
        </div>

        <div className="field">
          <label>Kasadaki açılış parası (bozukluk)</label>
          <input type="number" value={openingCash} onChange={(e) => setOpeningCash(e.target.value)} />
        </div>

        <button className="btn btn-primary" style={{ width: '100%' }}
                disabled={busy || !terminalId} onClick={start}>
          {busy ? 'Açılıyor…' : 'Kasayı aç'}
        </button>
        {error && <div className="err">{error}</div>}
      </div>
    </div>
  );
}

// =============================================================================
// Ödeme ekranı
// =============================================================================
function PaymentPanel({ total, onDone, onCancel }: {
  total: number;
  onDone: (payments: QueuedPayment[], change: number) => void;
  onCancel: () => void;
}) {
  const [method, setMethod] = useState<QueuedPayment['method']>('cash');
  const [tendered, setTendered] = useState('');
  const amount = Number(tendered) || 0;
  const change = method === 'cash' ? round2(Math.max(amount - total, 0)) : 0;
  const enough = method === 'cash' ? amount >= total : true;

  const press = (k: string) => {
    if (k === 'C') { setTendered(''); return; }
    if (k === '⌫') { setTendered((t) => t.slice(0, -1)); return; }
    setTendered((t) => (t === '0' ? k : t + k));
  };

  return (
    <div className="center" style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,.6)', zIndex: 10 }}>
      <div className="card">
        <h1>Ödeme</h1>
        <p>Tahsil edilecek: <strong style={{ color: 'var(--c-text)' }}>{money(total)}</strong></p>

        <div className="btn-row" style={{ marginBottom: 12 }}>
          {(['cash', 'card'] as const).map((m) => (
            <button key={m}
                    className={`btn ${method === m ? 'btn-primary' : ''}`}
                    onClick={() => { setMethod(m); if (m !== 'cash') setTendered(String(total)); }}>
              {m === 'cash' ? 'Nakit' : 'Kart'}
            </button>
          ))}
        </div>

        {method === 'cash' && (
          <>
            <div className="field">
              <label>Alınan tutar</label>
              <input value={tendered} onChange={(e) => setTendered(e.target.value)}
                     inputMode="decimal" placeholder={String(total)} />
            </div>
            <div className="keypad">
              {['1','2','3','4','5','6','7','8','9','C','0','⌫'].map((k) => (
                <button key={k} onClick={() => press(k)}>{k}</button>
              ))}
            </div>
            <div className="trow">
              <span>Para üstü</span>
              <strong style={{ color: change > 0 ? 'var(--c-warn)' : 'var(--c-mute)' }}>
                {money(change)}
              </strong>
            </div>
          </>
        )}

        <div className="btn-row" style={{ marginTop: 14 }}>
          <button className="btn btn-ghost" onClick={onCancel}>Vazgeç</button>
          <button className="btn btn-primary" disabled={!enough}
                  onClick={() => onDone(
                    [{ method, amount: method === 'cash' ? amount : total }], change)}>
            Tamamla
          </button>
        </div>
      </div>
    </div>
  );
}

// =============================================================================
// Kasa ekranı
// =============================================================================
function Till({ catalog, session, onCloseShift }: {
  catalog: CatalogSnapshot; session: PosSessionRef; onCloseShift: () => void;
}) {
  const [lines, setLines] = useState<QueuedLine[]>([]);
  const [scan, setScan] = useState('');
  const [online, setOnline] = useState(navigator.onLine);
  const [pending, setPending] = useState(loadQueue().length);
  const [paying, setPaying] = useState(false);
  const [flash, setFlash] = useState('');
  const scanRef = useRef<HTMLInputElement>(null);

  const totals = useMemo(
    () => computeTotals(lines, catalog.prices_include_tax), [lines, catalog.prices_include_tax]);

  // Barkod okutucu klavye taklidi yapar: kutu daima odakta kalmalı.
  useEffect(() => { if (!paying) scanRef.current?.focus(); });

  // ---- Senkronizasyon --------------------------------------------------------
  const flush = useCallback(async () => {
    const queue = loadQueue();
    if (queue.length === 0) return;
    const res = await api.post<{ created: number; skipped: number }>(
      '/pos/sync', { orders: queue.map(({ attempts: _a, ...o }) => o) });
    if (res.ok) {
      // Sunucu paketi kabul etti: kuyruk temizlenir. `skipped` da başarıdır —
      // fiş zaten oradaydı demektir (idempotanlık).
      removeFromQueue(queue.map((o) => o.id));
      setPending(loadQueue().length);
      setFlash(`${res.data.created} fiş gönderildi`);
      setTimeout(() => setFlash(''), 2500);
    } else {
      bumpAttempts(queue.map((o) => o.id));
    }
  }, []);

  useEffect(() => {
    const on = () => { setOnline(true); void flush(); };
    const off = () => setOnline(false);
    window.addEventListener('online', on);
    window.addEventListener('offline', off);
    // Tarayıcı "online" dese bile sunucu ulaşılamaz olabilir; periyodik deneme
    // tek güvenilir yol.
    const timer = setInterval(() => { void flush(); }, 20000);
    void flush();
    return () => {
      window.removeEventListener('online', on);
      window.removeEventListener('offline', off);
      clearInterval(timer);
    };
  }, [flush]);

  // ---- Sepet -----------------------------------------------------------------
  const addProduct = (p: CatalogProduct) => {
    setLines((prev) => {
      const i = prev.findIndex((l) => l.product_id === p.id);
      if (i >= 0) {
        const next = [...prev];
        next[i] = { ...next[i]!, quantity: next[i]!.quantity + 1 };
        return next;
      }
      return [...prev, {
        product_id: p.id, sku: p.sku, name: p.name,
        quantity: 1, unit_price: Number(p.sale_price),
        tax_id: p.sale_tax_id, tax_rate: Number(p.tax_rate),
      }];
    });
  };

  const changeQty = (idx: number, delta: number) => {
    setLines((prev) => prev.flatMap((l, i) => {
      if (i !== idx) return [l];
      const q = l.quantity + delta;
      return q <= 0 ? [] : [{ ...l, quantity: q }];
    }));
  };

  const onScan = (code: string) => {
    const value = code.trim();
    if (!value) return;
    const hit = catalog.products.find(
      (p) => p.barcodes.includes(value) || p.sku.toLowerCase() === value.toLowerCase());
    if (hit) { addProduct(hit); setFlash(''); }
    else { setFlash(`Barkod tanınmadı: ${value}`); setTimeout(() => setFlash(''), 2500); }
    setScan('');
  };

  // ---- Fiş kapatma -----------------------------------------------------------
  const finish = (payments: QueuedPayment[], change: number) => {
    const order: QueuedOrder = {
      id: crypto.randomUUID(),          // KİMLİĞİ CİHAZ ÜRETİR
      branch_id: session.branch_id,
      session_id: session.id,
      terminal_id: session.terminal_id,
      client_seq: nextClientSeq(),
      ordered_at: new Date().toISOString(),
      status: 'paid',
      lines,
      payments,
    };
    enqueue(order);
    setPending(loadQueue().length);
    setLines([]);
    setPaying(false);
    setFlash(change > 0 ? `Para üstü ${money(change)}` : 'Fiş tamamlandı');
    setTimeout(() => setFlash(''), 3000);
    void flush();
  };

  return (
    <div className="till">
      <div className="pane">
        <div className="topbar">
          <span className="brand">Sezra Kasa</span>
          <span className="pill">{session.number ?? 'Kasa açık'}</span>
          <div className="spacer" />
          {flash && <span className="pill ok">{flash}</span>}
          <span className={`pill ${online ? 'ok' : 'danger'}`}>
            {online ? 'çevrimiçi' : 'ÇEVRİMDIŞI'}
          </span>
          {pending > 0 && <span className="pill warn">{pending} fiş kuyrukta</span>}
          <button className="btn btn-ghost" style={{ padding: '6px 12px' }}
                  onClick={onCloseShift}>Kasayı kapat</button>
        </div>

        <div className="scan">
          <input ref={scanRef} value={scan} placeholder="Barkod okutun ya da stok kodu yazıp Enter"
                 onChange={(e) => setScan(e.target.value)}
                 onKeyDown={(e) => { if (e.key === 'Enter') onScan(scan); }} />
        </div>

        <div className="grid">
          {catalog.products.filter((p) => Number(p.sale_price) > 0).map((p) => (
            <button key={p.id} className="tile" onClick={() => addProduct(p)}>
              <div>
                <div className="tile-name">{p.name}</div>
                <div className="tile-sku">{p.sku}</div>
              </div>
              <div className="tile-price">{money(Number(p.sale_price))}</div>
            </button>
          ))}
        </div>
      </div>

      <div className="pane pane-right">
        <div className="cart">
          {lines.length === 0 && <div className="empty">Sepet boş</div>}
          {lines.map((l, i) => (
            <div className="cart-row" key={l.product_id}>
              <div>
                <div className="cart-name">{l.name}</div>
                <div className="cart-meta">{money(l.unit_price)} · KDV %{l.tax_rate}</div>
              </div>
              <div className="qty">
                <button onClick={() => changeQty(i, -1)}>−</button>
                <span>{l.quantity}</span>
                <button onClick={() => changeQty(i, +1)}>+</button>
              </div>
              <div className="cart-total">{money(round2(l.quantity * l.unit_price))}</div>
            </div>
          ))}
        </div>

        {/* Fiyatlar KDV dahil olduğu için matrah ve KDV BİLGİ amaçlı gösterilir;
            müşteriden tahsil edilen tutar "Toplam"dır. */}
        <div className="totals">
          <div className="trow"><span>Matrah</span><span>{money(totals.subtotal)}</span></div>
          <div className="trow"><span>KDV</span><span>{money(totals.tax)}</span></div>
          <div className="trow grand"><span>Toplam</span><span>{money(totals.total)}</span></div>
        </div>

        <div className="actions">
          <button className="btn btn-primary" disabled={lines.length === 0}
                  onClick={() => setPaying(true)}>Ödeme al</button>
          <button className="btn btn-ghost" disabled={lines.length === 0}
                  onClick={() => setLines([])}>Sepeti boşalt</button>
        </div>
      </div>

      {paying && (
        <PaymentPanel total={totals.total} onDone={finish} onCancel={() => setPaying(false)} />
      )}
    </div>
  );
}

// =============================================================================
// Kasa kapatma
// =============================================================================
function CloseShift({ session, onClosed, onCancel }: {
  session: PosSessionRef; onClosed: () => void; onCancel: () => void;
}) {
  const [expected, setExpected] = useState<number | null>(null);
  const [counted, setCounted] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const queued = loadQueue().length;

  useEffect(() => {
    void (async () => {
      const res = await api.get<{ expected_cash: string }>(
        `/pos/sessions/${session.id}/expected-cash`);
      if (res.ok) setExpected(Number(res.data.expected_cash));
    })();
  }, [session.id]);

  const close = async () => {
    setBusy(true); setError('');
    const res = await api.post('/pos/sessions/' + session.id + '/close', {
      counted_cash: Number(counted) || 0,
    });
    setBusy(false);
    if (res.ok) { saveSession(null); onClosed(); }
    else setError(res.error);
  };

  const diff = expected === null ? null : round2((Number(counted) || 0) - expected);

  return (
    <div className="center">
      <div className="card">
        <h1>Kasayı kapat</h1>
        <p>{session.number ?? ''} — sayım</p>

        {/* Kuyrukta fiş varken kapatmak, sunucudaki beklenen nakdi eksik
            hesaplatır. Kasiyeri bağlantı gelene kadar bekletiyoruz. */}
        {queued > 0 && (
          <div className="err" style={{ marginBottom: 12 }}>
            {queued} fiş henüz gönderilmedi. Kapatmadan önce bağlantının gelmesini bekleyin —
            aksi hâlde kasa farkı yanlış hesaplanır.
          </div>
        )}

        <div className="trow" style={{ fontSize: 15 }}>
          <span>Kasada olması gereken</span>
          <strong style={{ color: 'var(--c-text)' }}>
            {expected === null ? '…' : money(expected)}
          </strong>
        </div>

        <div className="field" style={{ marginTop: 14 }}>
          <label>Sayılan nakit</label>
          <input type="number" value={counted} inputMode="decimal"
                 onChange={(e) => setCounted(e.target.value)} />
        </div>

        {diff !== null && counted !== '' && (
          <div className="trow" style={{ fontSize: 15 }}>
            <span>Fark</span>
            <strong style={{ color: diff === 0 ? 'var(--c-ok)' : diff < 0 ? 'var(--c-danger)' : 'var(--c-warn)' }}>
              {diff > 0 ? '+' : ''}{money(diff)}
            </strong>
          </div>
        )}

        <div className="btn-row" style={{ marginTop: 16 }}>
          <button className="btn btn-ghost" onClick={onCancel}>Vazgeç</button>
          <button className="btn btn-primary" disabled={busy || counted === '' || queued > 0}
                  onClick={close}>Kasayı kapat</button>
        </div>
        {error && <div className="err">{error}</div>}
      </div>
    </div>
  );
}

// =============================================================================
export function App() {
  const [catalog, setCatalog] = useState<CatalogSnapshot | null>(loadCatalog());
  const [session, setSession] = useState<PosSessionRef | null>(loadSession());
  const [closing, setClosing] = useState(false);

  if (!catalog || !session) {
    return <Setup onReady={(c, s) => { setCatalog(c); setSession(s); }} />;
  }
  if (closing) {
    return (
      <CloseShift
        session={session}
        onClosed={() => { setSession(null); setClosing(false); }}
        onCancel={() => setClosing(false)}
      />
    );
  }
  return <Till catalog={catalog} session={session} onCloseShift={() => setClosing(true)} />;
}
