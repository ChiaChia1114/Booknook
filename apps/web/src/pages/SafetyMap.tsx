import { useState } from 'react';
import { Link } from 'react-router-dom';
import type { PublicReservationDto } from '@athena-sky/shared';
import { useApi } from '../hooks';
import { Logo } from '../components/Layout';
import { MapView } from '../components/MapView';
import { Card, Empty, ErrorBox, fmtDate } from '../components/ui';
import { authLayers } from './Airspace';

/** Public (no login) drone safety map with approved airspace reservations. */
export function SafetyMapPage() {
  const [days, setDays] = useState(7);
  const res = useApi<{ from: string; to: string; reservations: PublicReservationDto[] }>(`/api/v2/public/safety-map?to=${encodeURIComponent(new Date(Date.now() + days * 86_400_000).toISOString().slice(0, 13) + ':00:00Z')}`);
  const list = res.data?.reservations ?? [];
  const now = Date.now();
  const layers = authLayers(list.map((r) => ({ id: r.reference, geometry: r.geometry, color: Date.parse(r.startAt) <= now ? '#ef4444' : '#f97316', label: `${r.reference} – ${r.operator}, ≤${r.maxAltM} m, ${fmtDate(r.startAt)} → ${fmtDate(r.endAt)}` })));
  const fit = list.flatMap((r) => (r.geometry.kind === 'cylinder' ? [[r.geometry.center.lat, r.geometry.center.lon] as [number, number]] : r.geometry.line.map((p) => [p.lat, p.lon] as [number, number])));
  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%' }}>
      <header className="topbar">
        <div className="brand" style={{ padding: 0 }}>
          <Logo /> Athena-sky Drone Safety Map
        </div>
        <span className="spacer" />
        <select value={days} onChange={(e) => setDays(Number(e.target.value))} aria-label="Window">
          <option value={1}>Next 24 hours</option>
          <option value={7}>Next 7 days</option>
          <option value={30}>Next 30 days</option>
        </select>
        <Link to="/login" className="btn small">
          Operator log in
        </Link>
      </header>
      <div className="grid" style={{ gridTemplateColumns: 'minmax(0, 3fr) minmax(260px, 1fr)', padding: 16, flex: 1, minHeight: 0 }}>
        <Card tight className="map-card">
          <MapView className="fill" fit={fit} fitKey={String(list.length)} circles={layers.circles} polygons={layers.polygons} lines={layers.lines} testId="safety-map" />
        </Card>
        <Card title={`Reserved airspace (${list.length})`}>
          <ErrorBox error={res.error} />
          <p className="small muted">Approved drone operations. Red: active now · orange: upcoming.</p>
          {list.length === 0 ? (
            <Empty>No reservations in this window.</Empty>
          ) : (
            list.map((r) => (
              <div key={r.reference} className="finding" style={{ borderLeftColor: Date.parse(r.startAt) <= now ? 'var(--danger)' : 'var(--warn)' }}>
                <b>{r.reference}</b> · {r.operator}
                <div className="small muted">
                  {fmtDate(r.startAt)} – {fmtDate(r.endAt)} · {r.geometry.kind} · up to {r.maxAltM} m
                </div>
              </div>
            ))
          )}
        </Card>
      </div>
    </div>
  );
}
