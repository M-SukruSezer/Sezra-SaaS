import {
  Area, AreaChart, CartesianGrid, Cell, Pie, PieChart,
  ResponsiveContainer, Tooltip, XAxis, YAxis,
} from 'recharts';
import { money, num } from '../i18n';
import type { CashAccount, TrendPoint } from './useDashboard';

/**
 * Grafikler renklerini CSS değişkenlerinden alır (`var(--c-brand)`), çünkü SVG
 * fill/stroke değerleri de değişken kabul eder. Böylece grafik tema değişince
 * kendiliğinden dönüyor ve palet tek kaynakta kalıyor.
 */
const AXIS = { fontSize: 11, fill: 'var(--c-text-mute)' };

function TrendTooltip({ active, payload, label }: {
  active?: boolean; payload?: { value: number }[]; label?: string;
}) {
  if (!active || !payload?.length) return null;
  return (
    <div className="chart-tip">
      <div className="chart-tip-label">{label}</div>
      <div className="chart-tip-value">{money(payload[0]!.value)}</div>
    </div>
  );
}

export function SalesChart({ data }: { data: TrendPoint[] }) {
  const points = data.map((d) => ({
    day: new Date(d.day).toLocaleDateString('tr-TR', { day: '2-digit', month: 'short' }),
    total: Number(d.total),
  }));

  return (
    <div className="chart chart-tall">
      <ResponsiveContainer width="100%" height="100%">
        <AreaChart data={points} margin={{ top: 8, right: 8, left: 0, bottom: 0 }}>
          <defs>
            <linearGradient id="salesFill" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor="var(--c-brand)" stopOpacity={0.22} />
              <stop offset="100%" stopColor="var(--c-brand)" stopOpacity={0} />
            </linearGradient>
          </defs>
          {/* Yalnızca yatay ızgara: dikey çizgiler günlük veride gürültü yapıyor. */}
          <CartesianGrid stroke="var(--c-border)" vertical={false} />
          <XAxis
            dataKey="day" tick={AXIS} tickLine={false}
            axisLine={{ stroke: 'var(--c-border)' }} minTickGap={24}
          />
          <YAxis
            tick={AXIS} tickLine={false} axisLine={false} width={64}
            tickFormatter={(v: number) => num(Math.round(v / 1000)) + 'B'}
          />
          <Tooltip content={<TrendTooltip />} cursor={{ stroke: 'var(--c-border-strong)' }} />
          <Area
            type="monotone" dataKey="total"
            stroke="var(--c-brand)" strokeWidth={2}
            fill="url(#salesFill)"
          />
        </AreaChart>
      </ResponsiveContainer>
    </div>
  );
}

/* Halka grafik dilimleri: tek accent yerine onun tonları. Şartname "renkleri
   aşırı kullanma" diyor; farklı hue yerine aynı rengin yoğunlukları. */
const SLICE_OPACITY = [1, 0.72, 0.52, 0.36, 0.24];

export function CashBankChart({ data }: { data: CashAccount[] }) {
  const slices = data.map((d) => ({ name: d.name, code: d.code, value: Number(d.balance) }));
  const total = slices.reduce((n, s) => n + s.value, 0);

  if (slices.length === 0) {
    return <div className="empty"><span className="empty-title">Boş</span>
      <span>Kasa ve banka hesaplarında hareket yok.</span></div>;
  }

  return (
    <div className="donut-wrap">
      <div className="chart chart-donut">
        <ResponsiveContainer width="100%" height="100%">
          <PieChart>
            <Pie
              data={slices} dataKey="value" nameKey="name"
              innerRadius="66%" outerRadius="92%" paddingAngle={2} stroke="none"
            >
              {slices.map((s, i) => (
                <Cell
                  key={s.code} fill="var(--c-brand)"
                  fillOpacity={SLICE_OPACITY[i % SLICE_OPACITY.length]}
                />
              ))}
            </Pie>
            <Tooltip
              content={({ active, payload }) => {
                if (!active || !payload?.length) return null;
                const p = payload[0]!;
                return (
                  <div className="chart-tip">
                    <div className="chart-tip-label">{p.name}</div>
                    <div className="chart-tip-value">{money(Number(p.value))}</div>
                  </div>
                );
              }}
            />
          </PieChart>
        </ResponsiveContainer>
        <div className="donut-center">
          <div className="donut-center-label">Toplam</div>
          <div className="donut-center-value">{money(total)}</div>
        </div>
      </div>

      <ul className="legend">
        {slices.map((s, i) => (
          <li key={s.code}>
            <span
              className="legend-dot"
              style={{ opacity: SLICE_OPACITY[i % SLICE_OPACITY.length] }}
            />
            <span className="legend-name">{s.name}</span>
            <span className="legend-value">{money(s.value)}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}
