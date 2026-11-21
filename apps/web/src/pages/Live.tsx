import { Suspense, lazy, useEffect, useMemo, useRef, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import type { CommandName, CommandParams } from '@athena-sky/shared';
import { AIRFRAMES, haversineDistance, type AirspaceZoneDto, type DroneDto } from '@athena-sky/shared';
import { useApi } from '../hooks';
import type { DroneModel } from '../lib/cesium';

const Live3D = lazy(() => import('../components/Live3D'));
const VIEW_KEY = 'athena.live.view';
import type { DroneView } from '../api/live';
import { useAuth, useOrgId } from '../state/auth';
import { useLive } from '../state/live';
import { MapView } from '../components/MapView';
import { AttitudeIndicator } from '../components/charts';
import { Badge, Empty, fmtNum, useToast } from '../components/ui';

const SEL_KEY = 'athena.live.selection';

const TEXT_INPUT_TYPES = new Set(['text', 'number', 'email', 'password', 'search', 'tel', 'url', 'date', 'datetime-local', 'time', 'month', 'week']);

/**
 * True when a key press belongs to a field the user is typing in. Other focused controls
 * (e.g. the "Manual control" checkbox itself, buttons) must not swallow the flight keys.
 */
function isTextEntry(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  if (target.isContentEditable || target.tagName === 'TEXTAREA' || target.tagName === 'SELECT') return true;
  return target.tagName === 'INPUT' && TEXT_INPUT_TYPES.has((target as HTMLInputElement).type);
}

function useManualInput(active: boolean, send: (x: number, y: number, z: number, r: number) => void) {
  const keys = useRef(new Set<string>());
  const [gamepad, setGamepad] = useState<string | null>(null);
  useEffect(() => {
    if (!active) return;
    const down = (e: KeyboardEvent) => {
      if (isTextEntry(e.target)) return;
      keys.current.add(e.key.toLowerCase());
      if (['arrowup', 'arrowdown', 'arrowleft', 'arrowright', ' '].includes(e.key.toLowerCase())) e.preventDefault();
    };
    const up = (e: KeyboardEvent) => keys.current.delete(e.key.toLowerCase());
    // Releasing keys while the window is unfocused would otherwise leave the drone "stuck".
    const blur = () => keys.current.clear();
    window.addEventListener('keydown', down);
    window.addEventListener('keyup', up);
    window.addEventListener('blur', blur);
    const timer = setInterval(() => {
      const k = keys.current;
      let x = (k.has('w') ? 1 : 0) - (k.has('s') ? 1 : 0);
      let y = (k.has('d') ? 1 : 0) - (k.has('a') ? 1 : 0);
      let z = (k.has('arrowup') ? 1 : 0) - (k.has('arrowdown') ? 1 : 0);
      let r = (k.has('e') ? 1 : 0) - (k.has('q') ? 1 : 0);
      const pad = navigator.getGamepads?.().find((g) => g);
      if (pad) {
        setGamepad(pad.id);
        const dz = (v: number | undefined) => (v === undefined || Math.abs(v) < 0.08 ? 0 : v);
        // Mode-2 sticks: left = throttle/yaw, right = pitch/roll.
        if (!x && !y && !z && !r) {
          z = -dz(pad.axes[1]);
          r = dz(pad.axes[0]);
          x = -dz(pad.axes[3]);
          y = dz(pad.axes[2]);
        }
      }
      send(x * 0.6, y * 0.6, z, r * 0.6);
    }, 50);
    return () => {
      clearInterval(timer);
      window.removeEventListener('keydown', down);
      window.removeEventListener('keyup', up);
      window.removeEventListener('blur', blur);
      keys.current.clear();
    };
  }, [active, send]);
  return gamepad;
}

function DroneCard({ d, manualActive, setManual }: { d: DroneView; manualActive: boolean; setManual(v: boolean): void }) {
  const { client, live } = useLive();
  const { can } = useAuth();
  const toast = useToast();
  const [alt, setAlt] = useState(20);
  const [gotoMode, setGotoMode] = useState(false);
  const [quality, setQuality] = useState<'sd' | 'hd'>('sd');
  const [video, setVideo] = useState(false);
  const t = d.telemetry;
  const mine = d.controller?.userId === live.userId;
  const controlledByOther = !!d.controller && !mine;
  const canCmd = live.canControl && d.online && !controlledByOther;
  const send = useMemo(() => (x: number, y: number, z: number, r: number) => client?.manual(d.droneId, x, y, z, r), [client, d.droneId]);
  const gamepad = useManualInput(manualActive && mine, send);

  useEffect(() => {
    if (!client) return;
    client.setVideo(d.droneId, video && d.online, quality);
    return () => client.setVideo(d.droneId, false);
  }, [client, video, quality, d.droneId, d.online]);

  const cmd = async (command: CommandName, params: CommandParams = {}, confirmText?: string) => {
    if (!client) return;
    if (confirmText && !confirm(confirmText)) return;
    const r = await client.command(d.droneId, command, params);
    toast(`${d.name}: ${command} ${r.result}${r.message ? ` – ${r.message}` : ''}`, r.result === 'accepted' || r.result === 'completed' ? 'ok' : 'error');
  };
  const distHome = t?.home ? haversineDistance(t, t.home) : null;
  const videoFresh = d.frameUrl && Date.now() - d.frameAt < 5000;

  return (
    <section className="card" data-testid={`drone-card-${d.name}`}>
      <div className="card-head">
        <div className="row">
          <h3 style={{ margin: 0 }}>{d.name}</h3>
          {d.online ? <Badge tone="ok">online</Badge> : <Badge>offline</Badge>}
          {t && <Badge tone="accent">{String(t.mode)}</Badge>}
          {t?.armed && <Badge tone={t.inAir ? 'warn' : 'accent'}>{t.inAir ? 'airborne' : 'armed'}</Badge>}
          {d.flightId && (
            <Link to={`/flights/${d.flightId}`} className="small">
              ● recording
            </Link>
          )}
        </div>
        <div className="row small muted">
          {d.rttMs !== null && <span title="End-to-end round trip browser → cloud → drone">RTT {d.rttMs} ms</span>}
          {t?.link?.tech && (
            <span>
              {t.link.tech} {t.link.rsrp !== undefined ? `${t.link.rsrp} dBm` : ''}
            </span>
          )}
        </div>
      </div>

      <div className="grid" style={{ gridTemplateColumns: 'minmax(0, 3fr) minmax(0, 2fr)', gap: 10 }}>
        <div className="video" data-testid={`video-${d.name}`}>
          {video && videoFresh ? <img src={d.frameUrl!} alt={`${d.name} live video`} /> : <div className="placeholder">{!d.online ? 'Drone offline' : video ? 'Waiting for video…' : 'Video off'}</div>}
          <div className="overlay">
            <button className={`btn small${video ? ' active' : ''}`} onClick={() => setVideo(!video)} disabled={!d.online}>
              {video ? '■ Stop video' : '▶ Live video'}
            </button>
            <select value={quality} onChange={(e) => setQuality(e.target.value as 'sd' | 'hd')} aria-label="Video quality">
              <option value="sd">SD</option>
              <option value="hd">HD 720p</option>
            </select>
          </div>
        </div>
        <MapView
          fitKey={d.droneId + (t ? 'ok' : '')}
          fit={t ? [[t.lat, t.lon]] : []}
          cursor={gotoMode ? 'crosshair' : undefined}
          onClick={(lat, lon) => {
            if (!gotoMode) return;
            setGotoMode(false);
            void cmd('goto', { lat, lon, alt: t?.altRel ?? alt });
          }}
          lines={d.track.length > 1 ? [{ id: 'trk', points: d.track, color: '#38bdf8' }] : []}
          markers={[
            ...(t ? [{ id: 'd', lat: t.lat, lon: t.lon, heading: t.heading, color: '#38bdf8', label: d.name }] : []),
            ...(t?.home ? [{ id: 'h', lat: t.home.lat, lon: t.home.lon, color: '#60a5fa', label: 'Home' }] : []),
            ...d.traffic.map((a) => ({ id: a.icao, lat: a.lat, lon: a.lon, heading: a.heading, color: '#f97316', label: `✈ ${a.callsign ?? a.icao}` })),
          ]}
        />
      </div>

      <div className="row" style={{ marginTop: 10, alignItems: 'stretch' }}>
        <AttitudeIndicator roll={t?.roll ?? 0} pitch={t?.pitch ?? 0} size={104} />
        <div className="hud" style={{ flex: 1 }} data-testid={`hud-${d.name}`}>
          <div className="cell">
            <div className="k">Altitude</div>
            <div className="v" data-testid={`alt-${d.name}`}>
              {fmtNum(t?.altRel)} m
            </div>
          </div>
          <div className="cell">
            <div className="k">Speed</div>
            <div className="v">{fmtNum(t?.groundSpeed)} m/s</div>
          </div>
          <div className="cell">
            <div className="k">Climb</div>
            <div className="v">{fmtNum(t?.climbRate)} m/s</div>
          </div>
          <div className="cell">
            <div className="k">Heading</div>
            <div className="v">{t ? Math.round(t.heading) : '—'}°</div>
          </div>
          <div className="cell">
            <div className="k">Battery</div>
            <div className="v" style={{ color: t && t.battery.pct < 25 ? 'var(--danger)' : undefined }}>
              {t ? `${Math.round(t.battery.pct)}%` : '—'}
            </div>
          </div>
          <div className="cell">
            <div className="k">Voltage</div>
            <div className="v">{fmtNum(t?.battery.voltage)} V</div>
          </div>
          <div className="cell">
            <div className="k">GNSS</div>
            <div className="v">{t ? `${t.gps.satellites} sats` : '—'}</div>
          </div>
          <div className="cell">
            <div className="k">Home</div>
            <div className="v">{distHome !== null ? `${Math.round(distHome)} m` : '—'}</div>
          </div>
        </div>
      </div>

      {d.mission && (
        <div className="small" style={{ marginTop: 8 }}>
          Mission <b>{d.mission.name}</b>: item {Math.min(d.mission.seq + 1, d.mission.total)} / {d.mission.total}
          <div style={{ height: 6, background: 'var(--bg-elev-2)', borderRadius: 4, marginTop: 4 }}>
            <div style={{ width: `${(d.mission.seq / Math.max(1, d.mission.total)) * 100}%`, height: '100%', background: 'var(--accent)', borderRadius: 4 }} />
          </div>
        </div>
      )}
      {d.firmwareProgress && !['completed', 'failed'].includes(d.firmwareProgress.status) && (
        <div className="small" style={{ marginTop: 6 }}>
          Software update: {d.firmwareProgress.status} {Math.round(d.firmwareProgress.progress)} %
        </div>
      )}

      <div className="col" style={{ marginTop: 10 }}>
        <div className="row small">
          {d.controller ? (
            <span>
              Pilot in command: <b>{d.controller.name}</b>
            </span>
          ) : (
            <span className="muted">No pilot in command – observers can watch</span>
          )}
          {live.canControl && d.online && (
            <>
              {!mine && !controlledByOther && (
                <button className="btn small" onClick={() => client?.control(d.droneId, 'request')}>
                  Take control
                </button>
              )}
              {controlledByOther && can('drone.manage') && (
                <button className="btn small danger" onClick={() => confirm(`Take over control from ${d.controller!.name}?`) && client?.control(d.droneId, 'force')}>
                  Override
                </button>
              )}
              {mine && (
                <button className="btn small" onClick={() => { setManual(false); client?.control(d.droneId, 'release'); }}>
                  Release control
                </button>
              )}
            </>
          )}
        </div>
        {live.canControl ? (
          <>
            <div className="row">
              {!t?.armed ? (
                <button className="btn small" disabled={!canCmd} onClick={() => cmd('arm', {}, `Arm ${d.name}? Propellers will spin.`)}>
                  Arm
                </button>
              ) : (
                <button className="btn small" disabled={!canCmd || t.inAir} onClick={() => cmd('disarm')}>
                  Disarm
                </button>
              )}
              <input type="number" min={2} max={500} value={alt} onChange={(e) => setAlt(Number(e.target.value))} style={{ width: 64 }} aria-label="Take-off altitude" />
              <button className="btn small primary" disabled={!canCmd || !!t?.inAir} onClick={() => cmd('takeoff', { alt }, `Take off ${d.name} to ${alt} m?`)}>
                Take off
              </button>
              <button className="btn small" disabled={!canCmd || !t?.inAir} onClick={() => cmd('hold')}>
                Hold
              </button>
              <button className={`btn small${gotoMode ? ' active' : ''}`} disabled={!canCmd || !t?.inAir} onClick={() => setGotoMode(!gotoMode)}>
                Go to…
              </button>
              <button className="btn small" disabled={!canCmd || !t?.inAir} onClick={() => cmd('rtl')}>
                Return home
              </button>
              <button className="btn small danger" disabled={!canCmd || !t?.inAir} onClick={() => cmd('land')}>
                Land
              </button>
            </div>
            <div className="row">
              <button className="btn small" disabled={!canCmd || !d.mission} onClick={() => cmd('mission_start', {}, `Start mission "${d.mission?.name}"?`)}>
                Start mission
              </button>
              <button className="btn small" disabled={!canCmd || String(t?.mode) !== 'MISSION'} onClick={() => cmd('mission_pause')}>
                Pause
              </button>
              <button className="btn small" disabled={!canCmd || !d.mission || !t?.inAir || String(t?.mode) === 'MISSION'} onClick={() => cmd('mission_resume')}>
                Resume
              </button>
              <button className="btn small" disabled={!canCmd} onClick={() => cmd('camera_photo')}>
                Photo
              </button>
              <label className="row small" title="Keyboard: W/S forward/back, A/D left/right, ↑/↓ climb/descend, Q/E yaw. USB gamepads are supported.">
                <input type="checkbox" checked={manualActive} disabled={!mine || !t?.inAir} onChange={(e) => setManual(e.target.checked)} /> Manual control
                {manualActive && <span className="muted">{gamepad ? `🎮 ${gamepad.slice(0, 24)}` : '⌨ WASD · ↑↓ · QE'}</span>}
              </label>
            </div>
          </>
        ) : (
          <div className="small muted">Observer mode – your role can watch flights but not control drones.</div>
        )}
      </div>

      <div className="event-log" style={{ marginTop: 10 }} data-testid={`events-${d.name}`}>
        {d.events.length === 0 && <div className="muted">No events yet</div>}
        {d.events.slice(0, 30).map((e, i) => (
          <div key={i} style={{ color: e.level === 'critical' || e.level === 'error' ? 'var(--danger)' : e.level === 'warning' ? 'var(--warn)' : undefined }}>
            {new Date(e.t).toLocaleTimeString()} {e.message}
          </div>
        ))}
      </div>
    </section>
  );
}

export function LivePage() {
  const { live } = useLive();
  const orgId = useOrgId();
  const [params] = useSearchParams();
  const [manualFor, setManualFor] = useState<string | null>(null);
  const [view, setView] = useState<'map' | '3d'>(() => {
    try {
      return localStorage.getItem(VIEW_KEY) === '3d' ? '3d' : 'map';
    } catch {
      return 'map';
    }
  });
  const [focusId, setFocusId] = useState<string | null>(null);
  const fleet = useApi<DroneDto[]>(view === '3d' ? `/api/v2/organisations/${orgId}/drones` : null, [view]);
  const zones = useApi<AirspaceZoneDto[]>(view === '3d' ? `/api/v2/organisations/${orgId}/airspace/zones` : null, [view]);
  const models = useMemo(() => {
    const out: Record<string, DroneModel> = {};
    for (const d of fleet.data ?? []) out[d.id] = AIRFRAMES.find((a) => a.id === d.airframeId)?.model ?? 'quadcopter';
    return out;
  }, [fleet.data]);
  const chooseView = (v: 'map' | '3d') => {
    setView(v);
    try {
      localStorage.setItem(VIEW_KEY, v);
    } catch {
      /* private mode */
    }
  };
  const [selection, setSelection] = useState<Set<string> | null>(() => {
    const q = params.get('drone');
    if (q) return new Set([q]);
    try {
      const s = localStorage.getItem(SEL_KEY);
      return s ? new Set(JSON.parse(s) as string[]) : null;
    } catch {
      return null;
    }
  });
  const drones = Object.values(live.drones).sort((a, b) => Number(b.online) - Number(a.online) || a.name.localeCompare(b.name));
  // Default view: every online drone ("operate multiple drones on a single page").
  const shown = drones.filter((d) => (selection ? selection.has(d.droneId) : d.online));
  const toggle = (id: string) => {
    const s = new Set(selection ?? drones.filter((d) => d.online).map((d) => d.droneId));
    if (s.has(id)) s.delete(id);
    else s.add(id);
    setSelection(s);
    localStorage.setItem(SEL_KEY, JSON.stringify([...s]));
  };
  const positions = shown.filter((d) => d.telemetry).map((d) => [d.telemetry!.lat, d.telemetry!.lon] as [number, number]);
  return (
    <div className="content fill">
      <div className="live-layout">
        <aside className="live-side">
          <h3>Vehicles</h3>
          {!live.connected && <div className="small" style={{ color: 'var(--danger)' }}>Connecting to the real-time service…</div>}
          {drones.length === 0 && <div className="small muted">No drones registered.</div>}
          {drones.map((d) => (
            <div key={d.droneId} className={`drone-row${shown.includes(d) ? ' selected' : ''}`} onClick={() => toggle(d.droneId)} data-testid={`select-${d.name}`}>
              <input type="checkbox" readOnly checked={shown.includes(d)} aria-label={`Show ${d.name}`} />
              <span className={`dot ${d.online ? 'ok' : ''}`} />
              <div style={{ minWidth: 0 }}>
                <div className="truncate">{d.name}</div>
                <div className="small muted">
                  {d.online ? `${String(d.telemetry?.mode ?? '…')} · ${Math.round(d.telemetry?.battery.pct ?? 0)}%` : 'offline'}
                  {d.controller ? ` · ${d.controller.name}` : ''}
                </div>
              </div>
            </div>
          ))}
          <h3 style={{ marginTop: 16 }}>Online now</h3>
          {live.users.map((u) => (
            <div key={u.userId} className="row small">
              <span className="dot ok" /> {u.name} <span className="muted">{u.role}</span>
            </div>
          ))}
        </aside>
        <main className="live-main">
          {shown.some((d) => d.telemetry) && (
            <div className="row" style={{ marginBottom: 8, justifyContent: 'flex-end' }}>
              <div className="segmented" role="group" aria-label="Live view">
                <button className={`btn small${view === 'map' ? ' primary' : ''}`} onClick={() => chooseView('map')}>
                  2D map
                </button>
                <button className={`btn small${view === '3d' ? ' primary' : ''}`} onClick={() => chooseView('3d')}>
                  3D view
                </button>
              </div>
            </div>
          )}
          {view === '3d' && shown.some((d) => d.telemetry) && (
            <section className="card tight" style={{ marginBottom: 16 }}>
              <Suspense fallback={<div className="small muted">Loading the 3D view…</div>}>
                <Live3D drones={shown} models={models} zones={zones.data ?? []} selectedId={focusId} onSelect={setFocusId} />
              </Suspense>
            </section>
          )}
          {view === 'map' && shown.length > 1 && (
            <section className="card tight" style={{ marginBottom: 16 }}>
              <MapView
                fitKey={shown.map((d) => d.droneId).join() + positions.length}
                fit={positions}
                lines={shown.filter((d) => d.track.length > 1).map((d) => ({ id: d.droneId, points: d.track, color: '#38bdf8' }))}
                markers={[
                  ...shown.filter((d) => d.telemetry).map((d) => ({ id: d.droneId, lat: d.telemetry!.lat, lon: d.telemetry!.lon, heading: d.telemetry!.heading, color: d.telemetry!.inAir ? '#38bdf8' : '#94a3b8', label: `${d.name} · ${Math.round(d.telemetry!.altRel)} m` })),
                  ...shown.flatMap((d) => d.traffic).map((a) => ({ id: a.icao, lat: a.lat, lon: a.lon, heading: a.heading, color: '#f97316', label: `✈ ${a.callsign ?? a.icao} ${Math.round(a.altMsl)} m` })),
                ]}
              />
            </section>
          )}
          {shown.length === 0 ? (
            <Empty>
              No vehicle selected. {drones.some((d) => d.online) ? 'Select drones on the left.' : 'No drone is online – connect a drone (or the simulator) with its link key.'}
            </Empty>
          ) : (
            <div className="live-grid">
              {shown.map((d) => (
                <DroneCard key={d.droneId} d={d} manualActive={manualFor === d.droneId} setManual={(v) => setManualFor(v ? d.droneId : null)} />
              ))}
            </div>
          )}
        </main>
      </div>
    </div>
  );
}
