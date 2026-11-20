import { useEffect, useRef, type ReactNode } from 'react';
import uPlot from 'uplot';
import 'uplot/dist/uPlot.min.css';

export interface Series {
  label: string;
  values: (number | null)[];
  color: string;
  scale?: string;
}

/** Time-series chart (uPlot). x values are seconds (unix or relative). */
export function TimeChart({ x, series, height = 220, relative = false, onReady }: { x: number[]; series: Series[]; height?: number; relative?: boolean; onReady?(u: uPlot): void }) {
  const host = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!host.current || x.length === 0) return;
    const el = host.current;
    const style = getComputedStyle(document.documentElement);
    const grid = style.getPropertyValue('--border').trim() || '#24324f';
    const text = style.getPropertyValue('--text-dim').trim() || '#93a3bf';
    const scales = [...new Set(series.map((s) => s.scale ?? 'y'))];
    const opts: uPlot.Options = {
      width: el.clientWidth || 600,
      height,
      scales: { x: { time: !relative } },
      cursor: { sync: { key: 'athena-flight' } },
      legend: { show: true },
      axes: [
        { stroke: text, grid: { stroke: grid, width: 1 }, ticks: { stroke: grid }, ...(relative ? { values: (_u: uPlot, v: number[]) => v.map((s) => `${Math.round(s)}s`) } : {}) },
        ...scales.map((sc, i) => ({ scale: sc, side: i === 0 ? 3 : 1, stroke: text, grid: { show: i === 0, stroke: grid, width: 1 }, ticks: { stroke: grid } })),
      ],
      series: [{}, ...series.map((s) => ({ label: s.label, stroke: s.color, width: 1.6, scale: s.scale ?? 'y', spanGaps: true }))],
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
  }, [x, series, height, relative]);
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
          <div style={{ height: 6, background: 'var(--bg-elev-2)', borderRadius: 4 }}>
            <div style={{ width: `${(r.value / max) * 100}%`, height: '100%', background: 'var(--accent)', borderRadius: 4 }} />
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

/** Small terrain profile chart (planned altitude vs terrain). */
export function TerrainProfile({ samples }: { samples: { d: number; elevation: number | null; alt: number }[] }) {
  if (samples.length < 2) return null;
  const maxD = samples[samples.length - 1]!.d || 1;
  const vals = samples.flatMap((s) => [s.alt, s.elevation ?? s.alt]);
  const lo = Math.min(...vals) - 5;
  const hi = Math.max(...vals) + 5;
  const X = (d: number) => (d / maxD) * 100;
  const Y = (v: number) => 40 - ((v - lo) / (hi - lo || 1)) * 38;
  const terrain = samples.filter((s) => s.elevation !== null);
  const ground = terrain.length > 1 ? `M0 40 ${terrain.map((s) => `L${X(s.d)} ${Y(s.elevation!)}`).join(' ')} L100 40 Z` : '';
  const path = samples.map((s, i) => `${i ? 'L' : 'M'}${X(s.d)} ${Y(s.alt)}`).join(' ');
  return (
    <svg viewBox="0 0 100 42" preserveAspectRatio="none" style={{ width: '100%', height: 110 }} aria-label="terrain profile">
      {ground && <path d={ground} fill="color-mix(in srgb, #92400e 55%, transparent)" />}
      <path d={path} fill="none" stroke="var(--accent)" strokeWidth="0.8" vectorEffect="non-scaling-stroke" />
    </svg>
  );
}
