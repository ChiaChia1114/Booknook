import { useEffect, useRef, useState, type ReactNode } from 'react';
import uPlot from 'uplot';
import 'uplot/dist/uPlot.min.css';
import { maxOf, minOf } from '@athena-sky/shared';

export interface Series {
  label: string;
  values: (number | null)[];
  color: string;
  scale?: string;
  /** Draw points only (no line). */
  points?: boolean;
  /** Dash pattern of the line, e.g. [5, 4]. */
  dash?: number[];
}

/** Time-series chart (uPlot). x values are seconds (unix or relative). */
export function TimeChart({
  x,
  series,
  height = 220,
  relative = false,
  xFormat,
  legend = true,
  onReady,
}: {
  x: number[];
  series: Series[];
  height?: number;
  relative?: boolean;
  /** Custom x labels (non-time axis), e.g. flight hours. */
  xFormat?(v: number): string;
  /** uPlot's live legend under the chart. */
  legend?: boolean;
  onReady?(u: uPlot): void;
}) {
  const host = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!host.current || x.length === 0) return;
    const el = host.current;
    const style = getComputedStyle(document.documentElement);
    const grid = style.getPropertyValue('--chart-grid').trim() || 'rgba(255,255,255,0.07)';
    const text = style.getPropertyValue('--text-faint').trim() || '#6c7480';
    const scales = [...new Set(series.map((s) => s.scale ?? 'y'))];
    const opts: uPlot.Options = {
      width: el.clientWidth || 600,
      height,
      scales: { x: { time: !relative && !xFormat } },
      cursor: { sync: { key: 'athena-flight' } },
      legend: { show: legend },
      axes: [
        {
          stroke: text,
          grid: { stroke: grid, width: 1 },
          ticks: { stroke: grid },
          // Room for "12:34:56"-style labels without collisions on narrow charts.
          space: 80,
          ...(xFormat ? { values: (_u: uPlot, v: number[]) => v.map((s) => xFormat(s)) } : relative ? { values: (_u: uPlot, v: number[]) => v.map((s) => `${Math.round(s)}s`) } : {}),
        },
        ...scales.map((sc, i) => ({ scale: sc, side: i === 0 ? 3 : 1, stroke: text, grid: { show: i === 0, stroke: grid, width: 1 }, ticks: { stroke: grid } })),
      ],
      series: [
        {},
        ...series.map((s) =>
          s.points
            ? { label: s.label, stroke: s.color, width: 0, scale: s.scale ?? 'y', points: { show: true, size: 6, width: 1, fill: s.color } }
            : { label: s.label, stroke: s.color, width: 1.6, scale: s.scale ?? 'y', spanGaps: true, points: { show: false }, ...(s.dash ? { dash: s.dash } : {}) },
        ),
      ],
    };
    const u = new uPlot(opts, [x, ...series.map((s) => s.values)] as uPlot.AlignedData, el);
    onReady?.(u);
    const ro = new ResizeObserver(() => u.setSize({ width: el.clientWidth, height }));
    ro.observe(el);
    return () => {
      ro.disconnect();
      u.destroy();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [x, series, height, relative, legend]);
  return <div ref={host} className="chart" />;
}

/** Simple responsive SVG bar chart. */
export function BarChart({ data, height = 160, color = 'var(--accent)', format = (v: number) => String(v), testId }: { data: { label: string; value: number }[]; height?: number; color?: string; format?(v: number): string; testId?: string }) {
  const max = Math.max(1, ...data.map((d) => d.value));
  const w = 100 / Math.max(1, data.length);
  return (
    <svg className="bar-chart" viewBox={`0 0 100 ${height / 4}`} preserveAspectRatio="none" style={{ width: '100%', height }} role="img" aria-label="bar chart" data-testid={testId}>
      {data.map((d, i) => {
        const h = (d.value / max) * (height / 4 - 6);
        return (
          <g key={d.label}>
            <rect x={i * w + w * 0.15} y={height / 4 - 4 - h} width={w * 0.7} height={Math.max(h, d.value > 0 ? 0.6 : 0)} fill={color} rx={0.6}>
              <title>{`${d.label}: ${format(d.value)}`}</title>
            </rect>
          </g>
        );
      })}
      <line x1="0" x2="100" y1={height / 4 - 4} y2={height / 4 - 4} stroke="var(--border)" strokeWidth="0.3" />
    </svg>
  );
}

/** Width of an element, kept up to date. */
function useWidth<T extends HTMLElement>(): [React.RefObject<T | null>, number] {
  const ref = useRef<T>(null);
  const [w, setW] = useState(0);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    setW(el.clientWidth);
    const ro = new ResizeObserver(() => setW(el.clientWidth));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  return [ref, w];
}

/** "Nice" axis maximum and step for 4–5 ticks. */
export function niceScale(max: number, ticks = 4): { max: number; step: number } {
  if (!(max > 0)) return { max: 1, step: 0.25 };
  const raw = max / ticks;
  const mag = 10 ** Math.floor(Math.log10(raw));
  const norm = raw / mag;
  const step = (norm <= 1 ? 1 : norm <= 2 ? 2 : norm <= 2.5 ? 2.5 : norm <= 5 ? 5 : 10) * mag;
  return { max: Math.ceil(max / step) * step, step };
}

/** Column chart with a value axis and category labels (Sky-Drones dashboard style). */
export function ColumnChart({
  data,
  height = 220,
  color = 'var(--chart-1)',
  format = (v: number) => String(v),
  testId,
}: {
  data: { label: string; value: number }[];
  height?: number;
  color?: string;
  format?(v: number): string;
  testId?: string;
}) {
  const [ref, width] = useWidth<HTMLDivElement>();
  const left = 40;
  const right = 8;
  const top = 10;
  const plotW = Math.max(10, width - left - right);
  const band = plotW / Math.max(1, data.length);
  const shown = (l: string) => (l.length > 16 ? `${l.slice(0, 15)}…` : l);
  // ~6.2 px per character at 11 px: rotate long labels when few bars, thin out labels when many.
  const labelW = Math.max(0, ...data.map((d) => shown(d.label).length * 6.2));
  const many = data.length > 12;
  const every = many ? Math.max(1, Math.ceil((labelW + 8) / band)) : 1;
  const rotate = !many && labelW > band - 8;
  const bottom = rotate ? Math.min(70, 18 + labelW * 0.6) : 26;
  const plotH = height - top - bottom;
  const { max, step } = niceScale(Math.max(0, ...data.map((d) => d.value)));
  const barW = Math.min(44, band * 0.6);
  const y = (v: number) => top + plotH - (v / max) * plotH;
  const ticks: number[] = [];
  for (let v = 0; v <= max + 1e-9; v += step) ticks.push(Math.round(v * 1000) / 1000);
  return (
    <div ref={ref} style={{ width: '100%' }} data-testid={testId}>
      {width > 0 && (
        <svg className="col-chart" width={width} height={height} role="img" aria-label="column chart">
          {ticks.map((t) => (
            <g key={t}>
              <line x1={left} x2={width - right} y1={y(t)} y2={y(t)} stroke="var(--chart-grid)" />
              <text x={left - 8} y={y(t) + 4} textAnchor="end">
                {format(t)}
              </text>
            </g>
          ))}
          {data.map((d, i) => {
            const x = left + i * band + (band - barW) / 2;
            const h = Math.max(0, y(0) - y(d.value));
            const r = Math.min(4, barW / 2, h);
            const path = h > 0 ? `M${x},${y(0)} V${y(0) - h + r} Q${x},${y(0) - h} ${x + r},${y(0) - h} H${x + barW - r} Q${x + barW},${y(0) - h} ${x + barW},${y(0) - h + r} V${y(0)} Z` : '';
            const cx = left + i * band + band / 2;
            return (
              <g key={`${d.label}-${i}`}>
                {path && (
                  <path className="bar" d={path} fill={color}>
                    <title>{`${d.label}: ${format(d.value)}`}</title>
                  </path>
                )}
                {i % every === 0 && (
                  <text x={cx} y={top + plotH + (rotate ? 12 : 17)} textAnchor={rotate ? 'end' : 'middle'} transform={rotate ? `rotate(-35 ${cx} ${top + plotH + 12})` : undefined}>
                    {shown(d.label)}
                  </text>
                )}
              </g>
            );
          })}
          <line x1={left} x2={width - right} y1={y(0)} y2={y(0)} stroke="var(--border-strong)" />
        </svg>
      )}
    </div>
  );
}

/** Horizontal bars with labels (top-N lists). */
export function HBarList({ rows, format }: { rows: { label: ReactNode; value: number; key: string }[]; format(v: number): string }) {
  const max = Math.max(1, ...rows.map((r) => r.value));
  return (
    <div className="col" style={{ gap: 6 }}>
      {rows.map((r) => (
        <div key={r.key}>
          <div className="row small" style={{ justifyContent: 'space-between' }}>
            <span className="truncate">{r.label}</span>
            <span className="muted">{format(r.value)}</span>
          </div>
          <div className="hbar">
            <div style={{ width: `${(r.value / max) * 100}%` }} />
          </div>
        </div>
      ))}
    </div>
  );
}

/** Attitude indicator (artificial horizon) driven by roll / pitch. */
export function AttitudeIndicator({ roll, pitch, size = 110 }: { roll: number; pitch: number; size?: number }) {
  const p = Math.max(-40, Math.min(40, pitch)) * 1.2;
  return (
    <svg width={size} height={size} viewBox="-50 -50 100 100" aria-label={`roll ${roll.toFixed(0)}°, pitch ${pitch.toFixed(0)}°`}>
      <defs>
        <clipPath id="ai-clip">
          <circle r="46" />
        </clipPath>
      </defs>
      <g clipPath="url(#ai-clip)">
        <g transform={`rotate(${-roll}) translate(0 ${p})`}>
          <rect x="-100" y="-100" width="200" height="100" fill="#3b82f6" />
          <rect x="-100" y="0" width="200" height="100" fill="#92400e" />
          <line x1="-100" x2="100" y1="0" y2="0" stroke="#fff" strokeWidth="1" />
          {[-20, -10, 10, 20].map((d) => (
            <line key={d} x1={-Math.abs(d) / 2} x2={Math.abs(d) / 2} y1={-d * 1.2} y2={-d * 1.2} stroke="#fff" strokeWidth="0.8" />
          ))}
        </g>
      </g>
      <circle r="46" fill="none" stroke="var(--border)" strokeWidth="2" />
      <path d="M-22 0 H-8 L0 6 L8 0 H22" fill="none" stroke="#facc15" strokeWidth="2.5" />
    </svg>
  );
}

/** Small terrain profile chart (planned altitude vs terrain); `labels` adds the heights and the distance. */
export function TerrainProfile({ samples, labels = false }: { samples: { d: number; elevation: number | null; alt: number }[]; labels?: boolean }) {
  if (samples.length < 2) return null;
  const maxD = samples[samples.length - 1]!.d || 1;
  const vals = samples.flatMap((s) => [s.alt, s.elevation ?? s.alt]);
  const lo = minOf(vals) - 5;
  const hi = maxOf(vals) + 5;
  const X = (d: number) => (d / maxD) * 100;
  const Y = (v: number) => 40 - ((v - lo) / (hi - lo || 1)) * 38;
  const terrain = samples.filter((s) => s.elevation !== null);
  const ground = terrain.length > 1 ? `M0 40 ${terrain.map((s) => `L${X(s.d)} ${Y(s.elevation!)}`).join(' ')} L100 40 Z` : '';
  const path = samples.map((s, i) => `${i ? 'L' : 'M'}${X(s.d)} ${Y(s.alt)}`).join(' ');
  const svg = (
    <svg viewBox="0 0 100 42" preserveAspectRatio="none" style={{ width: '100%', height: 110 }} aria-label="terrain profile">
      {ground && <path d={ground} fill="color-mix(in srgb, #92400e 55%, transparent)" />}
      <path d={path} fill="none" stroke="var(--accent)" strokeWidth="0.8" vectorEffect="non-scaling-stroke" />
    </svg>
  );
  if (!labels) return svg;
  const elev = terrain.map((s) => s.elevation!);
  return (
    <div data-testid="terrain-profile">
      <div className="terrain-profile">
        {svg}
        <span className="tp-label" style={{ top: 0, left: 4 }}>
          {Math.round(hi - 5)} m
        </span>
        <span className="tp-label" style={{ bottom: 2, left: 4 }}>
          {Math.round(lo + 5)} m
        </span>
        <span className="tp-label" style={{ bottom: 2, right: 4 }}>
          {maxD >= 1000 ? `${(maxD / 1000).toFixed(1)} km` : `${Math.round(maxD)} m`}
        </span>
      </div>
      <div className="legend">
        <span>
          <span className="legend-line" style={{ margin: 0, borderTopColor: 'var(--accent)' }} /> planned altitude (AMSL)
        </span>
        {elev.length > 0 && (
          <span>
            <span className="swatch" style={{ background: 'color-mix(in srgb, #92400e 55%, transparent)' }} /> terrain {Math.round(minOf(elev))}–{Math.round(maxOf(elev))} m
          </span>
        )}
      </div>
    </div>
  );
}
