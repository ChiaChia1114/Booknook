/**
 * Overlays of the live console: the time-ordered event log (green text, warnings and
 * errors highlighted) and the "reposition" form (altitude, speed, heading, position).
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import { ChevronDown, ChevronUp, ScrollText, X } from 'lucide-react';
import type { DroneView } from '../../api/live';
import { useLive } from '../../state/live';
import { AsyncButton, useToast } from '../ui';
import { useStillShown } from '../../hooks';

export interface ConsoleEvent {
  t: number;
  level: string;
  drone: string | null;
  message: string;
}

export function EventLogOverlay({ drones, system }: { drones: DroneView[]; system: ConsoleEvent[] }) {
  // Collapsed by default on phones, where it would cover the map.
  const [open, setOpen] = useState(() => !window.matchMedia?.('(max-width: 640px)').matches);
  const events = useMemo(() => {
    const all: ConsoleEvent[] = [...system];
    for (const d of drones) for (const e of d.events) all.push({ t: e.t, level: e.level, drone: d.name, message: e.message });
    return all.sort((a, b) => b.t - a.t).slice(0, 200);
  }, [drones, system]);
  return (
    <div className={`console-log${open ? '' : ' collapsed'}`} data-testid="console-log">
      <button className="console-log-head" onClick={() => setOpen(!open)} aria-expanded={open}>
        <ScrollText aria-hidden="true" /> Event log <span className="log-count">{events.length}</span>
        <span className="spacer" />
        {open ? <ChevronDown aria-hidden="true" /> : <ChevronUp aria-hidden="true" />}
      </button>
      {open && (
        <div className="console-log-body">
          {events.length === 0 && <div className="muted">No events yet</div>}
          {events.map((e, i) => (
            <div key={`${e.t}-${i}`} className={`log-line ${e.level}`}>
              <span className="muted">{new Date(e.t).toLocaleTimeString()}</span> {e.level === 'warning' ? 'Warning: ' : e.level === 'error' || e.level === 'critical' ? 'Error: ' : ''}
              {e.drone ? <b>{e.drone}</b> : null} {e.message}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

export interface RepositionTarget {
  lat: number;
  lon: number;
}

export function RepositionForm({
  drones,
  droneId,
  setDroneId,
  picked,
  picking,
  setPicking,
  onClose,
  onSystemEvent,
}: {
  drones: DroneView[];
  droneId: string;
  setDroneId(id: string): void;
  picked: RepositionTarget | null;
  picking: boolean;
  setPicking(v: boolean): void;
  onClose(): void;
  onSystemEvent(e: ConsoleEvent): void;
}) {
  const { client } = useLive();
  const toast = useToast();
  const stillShown = useStillShown();
  const d = drones.find((x) => x.droneId === droneId);
  const t = d?.telemetry;
  const fromTelemetry = () =>
    t ? { alt: Math.max(5, Math.round(t.altRel)), speed: 8, heading: String(Math.round(t.heading)), lat: t.lat.toFixed(6), lon: t.lon.toFixed(6) } : { alt: 30, speed: 8, heading: '', lat: '', lon: '' };
  // Start from the drone's current state (synchronously, so typing never races an effect) …
  const [form, setForm] = useState(fromTelemetry);
  // … and again when another drone is chosen (each choice counted: a drone chosen again after
  // another is shown afresh).
  const shownFor = useRef(droneId);
  const choices = useRef(0);
  useEffect(() => {
    if (shownFor.current === droneId) return;
    shownFor.current = droneId;
    choices.current += 1;
    setForm(fromTelemetry());
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [droneId]);
  useEffect(() => {
    if (picked) setForm((f) => ({ ...f, lat: picked.lat.toFixed(6), lon: picked.lon.toFixed(6) }));
  }, [picked]);

  const submit = async () => {
    if (!client || !d) return;
    const choice = choices.current;
    const lat = Number(form.lat);
    const lon = Number(form.lon);
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) {
      toast('Enter a valid position', 'error');
      return;
    }
    const r = await client.command(d.droneId, 'goto', { lat, lon, alt: form.alt, speed: form.speed, ...(form.heading !== '' ? { yaw: ((Number(form.heading) % 360) + 360) % 360 } : {}) });
    const ok = r.result === 'accepted' || r.result === 'completed';
    toast(`${d.name}: reposition ${r.result}${r.message ? ` – ${r.message}` : ''}`, ok ? 'ok' : 'error');
    if (!ok) onSystemEvent({ t: Date.now(), level: 'warning', drone: d.name, message: `Reposition ${r.result}${r.message ? `: ${r.message}` : ''}` });
    // Accepted: the panel closes – unless it was closed meanwhile or a drone was chosen in it since
    // (another one, or this one again after another).
    else if (stillShown() && choices.current === choice) onClose();
  };

  return (
    <div className="console-panel reposition" data-testid="reposition-form" onClick={(e) => e.stopPropagation()}>
      <div className="row" style={{ justifyContent: 'space-between' }}>
        <b>Reposition</b>
        <button className="icon-btn" aria-label="Close" onClick={onClose}>
          <X />
        </button>
      </div>
      <label className="field">
        Select device to reposition
        <select value={droneId} onChange={(e) => setDroneId(e.target.value)} aria-label="Device">
          {drones
            .filter((x) => x.online)
            .map((x) => (
              <option key={x.droneId} value={x.droneId}>
                {x.name}
              </option>
            ))}
        </select>
      </label>
      <div className="form-grid">
        <label className="field">
          Altitude (m)
          <input type="number" value={form.alt} onChange={(e) => setForm({ ...form, alt: Number(e.target.value) })} aria-label="Reposition altitude" />
        </label>
        <label className="field">
          Speed (m/s)
          <input type="number" value={form.speed} onChange={(e) => setForm({ ...form, speed: Number(e.target.value) })} aria-label="Reposition speed" />
        </label>
        <label className="field">
          Heading (°)
          <input type="number" value={form.heading} placeholder="keep" onChange={(e) => setForm({ ...form, heading: e.target.value })} aria-label="Reposition heading" />
        </label>
        <label className="field">
          Latitude
          <input value={form.lat} onChange={(e) => setForm({ ...form, lat: e.target.value })} aria-label="Reposition latitude" />
        </label>
        <label className="field">
          Longitude
          <input value={form.lon} onChange={(e) => setForm({ ...form, lon: e.target.value })} aria-label="Reposition longitude" />
        </label>
      </div>
      <div className="row" style={{ marginTop: 8 }}>
        <button className={`btn small${picking ? ' active' : ''}`} onClick={() => setPicking(!picking)}>
          {picking ? 'Click the map…' : 'Pick on map'}
        </button>
        <AsyncButton className="btn small primary" onClick={submit} disabled={!d?.telemetry?.inAir}>
          Reposition
        </AsyncButton>
      </div>
      {!d?.telemetry?.inAir && <div className="small muted">The drone must be airborne.</div>}
    </div>
  );
}
