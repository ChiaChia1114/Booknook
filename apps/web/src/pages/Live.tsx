import { Box, Crosshair, Gamepad2, Hexagon, Keyboard, Layers, LocateFixed, Map as MapIcon, Plane, Square, TriangleAlert, Video, X } from 'lucide-react';
import { Suspense, lazy, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import type { CommandName, CommandParams } from '@athena-sky/shared';
import { flownFrom, haversineDistance, missionPath, type AirspaceZoneDto, type DroneDto, type MissionPlan, type SwarmDto } from '@athena-sky/shared';
import { api } from '../api/client';
import type { Live3DLayers } from '../components/Live3D';
import { VideoTile } from '../components/live/VideoTile';
import { softwareWebGL } from '../lib/webgl';
import { EventLogOverlay, RepositionForm, type ConsoleEvent, type RepositionTarget } from '../components/live/ConsoleOverlays';
import { SwarmPanel, currentOperation, type PreviewRoute } from '../components/live/SwarmPanel';
import { useApi } from '../hooks';
import { modelOfAirframe, type DroneModel } from '../lib/models';

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
/** Why a swarm member's own mission buttons are off. */
export const SWARM_ONLY = "Flies in a swarm operation – use the operation's controls in the Swarm panel (or end the operation)";

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

function DroneCard({ d, manualActive, setManual, swarm }: { d: DroneView; manualActive: boolean; setManual(v: boolean): void; swarm?: { label: string; state: string } | null }) {
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
  // A member of a running swarm operation flies its mission under the operation's control.
  const inSwarm = !!swarm && swarm.state !== 'detached' && swarm.state !== 'done';
  const send = useMemo(() => (x: number, y: number, z: number, r: number) => client?.manual(d.droneId, x, y, z, r), [client, d.droneId]);
  const gamepad = useManualInput(manualActive && mine, send);

  useEffect(() => {
    if (!client) return;
    client.setVideo(d.droneId, video && d.online, quality, 'card');
    return () => client.setVideo(d.droneId, false, quality, 'card');
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
              <span className="dot danger pulse" /> recording
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

      <div className="grid card-split" style={{ gap: 10 }}>
        <div className="video" data-testid={`video-${d.name}`}>
          {video && videoFresh ? (
            <img src={d.frameUrl!} alt={`${d.name} live video`} />
          ) : (
            <div className="placeholder">{!d.online ? 'Drone offline' : !d.videoAvailable ? 'No camera on this drone' : video ? 'Waiting for video…' : 'Video off'}</div>
          )}
          <div className="overlay">
            <button className={`btn small${video ? ' active' : ''}`} onClick={() => setVideo(!video)} disabled={!d.online || !d.videoAvailable} title={d.online && !d.videoAvailable ? 'This drone reports no camera' : undefined}>
              {video ? (
                <>
                  <Square /> Stop video
                </>
              ) : (
                <>
                  <Video /> Live video
                </>
              )}
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
              <button
                className="btn small"
                disabled={!canCmd || !d.mission || inSwarm}
                title={inSwarm ? SWARM_ONLY : undefined}
                onClick={() => cmd('mission_start', {}, `Start mission "${d.mission?.name}"?`)}
              >
                Start mission
              </button>
              <button className="btn small" disabled={!canCmd || String(t?.mode) !== 'MISSION'} onClick={() => cmd('mission_pause')}>
                Pause
              </button>
              <button
                className="btn small"
                disabled={!canCmd || !d.mission || !t?.inAir || String(t?.mode) === 'MISSION' || inSwarm}
                title={inSwarm ? SWARM_ONLY : t?.inAir ? 'Continue the mission from where the drone is' : 'In the air only – on the ground, use Start mission'}
                onClick={() => cmd('mission_resume')}
              >
                Resume
              </button>
              <button className="btn small" disabled={!canCmd} onClick={() => cmd('camera_photo')}>
                Photo
              </button>
              <label className="row small" title="Keyboard: W/S forward/back, A/D left/right, ↑/↓ climb/descend, Q/E yaw. USB gamepads are supported.">
                <input type="checkbox" checked={manualActive} disabled={!mine || !t?.inAir} onChange={(e) => setManual(e.target.checked)} /> Manual control
                {manualActive && (
                  <span className="muted row" style={{ gap: 4 }}>
                    {gamepad ? (
                      <>
                        <Gamepad2 size={14} /> {gamepad.slice(0, 24)}
                      </>
                    ) : (
                      <>
                        <Keyboard size={14} /> WASD · ↑↓ · QE
                      </>
                    )}
                  </span>
                )}
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

const LAYERS_KEY = 'athena.live.layers';

export function LivePage() {
  const { live } = useLive();
  const orgId = useOrgId();
  const [params] = useSearchParams();
  const [manualFor, setManualFor] = useState<string | null>(null);
  const software = useMemo(() => softwareWebGL(), []);
  const [view, setView] = useState<'map' | '3d'>(() => {
    try {
      const saved = localStorage.getItem(VIEW_KEY);
      if (saved === 'map' || saved === '3d') return saved;
    } catch {
      /* private mode */
    }
    // Without GPU acceleration the 3D view would stall the page: start in 2D.
    return softwareWebGL() ? 'map' : '3d';
  });
  const [layers, setLayers] = useState<Live3DLayers>(() => {
    try {
      return { frustum: true, routes: true, zones: true, trails: true, ...(JSON.parse(localStorage.getItem(LAYERS_KEY) ?? '{}') as Partial<Live3DLayers>) };
    } catch {
      return { frustum: true, routes: true, zones: true, trails: true };
    }
  });
  const [selectedId, setSelectedId] = useState<string | null>(params.get('drone'));
  const [detailId, setDetailId] = useState<string | null>(null);
  const [follow, setFollow] = useState(false);
  const [reposition, setReposition] = useState<string | null>(null);
  const [picking, setPicking] = useState(false);
  const [picked, setPicked] = useState<RepositionTarget | null>(null);
  const [systemEvents, setSystemEvents] = useState<ConsoleEvent[]>([]);
  const [swarmOpen, setSwarmOpen] = useState(params.get('panel') === 'swarm');
  const [previewRoutes, setPreviewRoutes] = useState<PreviewRoute[] | null>(null);
  const [takeoffAlt] = useState(20);
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
  const fleet = useApi<DroneDto[]>(`/api/v2/organisations/${orgId}/drones`);
  const swarmHistory = useApi<SwarmDto[]>(`/api/v2/organisations/${orgId}/swarms`);
  const swarmOp = useMemo(() => currentOperation(live.swarms, swarmHistory.data ?? []), [live.swarms, swarmHistory.data]);
  const swarmOf = (droneId: string) => {
    if (!swarmOp || ['completed', 'aborted', 'failed'].includes(swarmOp.state)) return null;
    const m = swarmOp.members.find((x) => x.droneId === droneId);
    if (!m) return null;
    return { label: swarmOp.options.mode === 'formation' ? (m.slot === 0 ? 'leader' : `slot ${m.slot + 1}`) : `part ${m.slot + 1}`, state: m.state };
  };
  const zones = useApi<AirspaceZoneDto[]>(`/api/v2/organisations/${orgId}/airspace/zones`);
  const models = useMemo(() => {
    const out: Record<string, DroneModel> = {};
    for (const d of fleet.data ?? []) out[d.id] = modelOfAirframe(d.airframeId);
    return out;
  }, [fleet.data]);
  const airframes = useMemo(() => Object.fromEntries((fleet.data ?? []).map((d) => [d.id, d.airframeId])), [fleet.data]);
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
  const chooseView = (v: 'map' | '3d') => {
    setView(v);
    try {
      localStorage.setItem(VIEW_KEY, v);
    } catch {
      /* private mode */
    }
  };
  const setLayer = (k: keyof Live3DLayers, v: boolean) => {
    const next = { ...layers, [k]: v };
    setLayers(next);
    try {
      localStorage.setItem(LAYERS_KEY, JSON.stringify(next));
    } catch {
      /* private mode */
    }
  };

  // The plan loaded on each drone, as uploaded (routes on the map) – not the mission as edited
  // since. Fetched again when another upload replaces it.
  const [loaded, setLoaded] = useState<Record<string, { key: string; plan: MissionPlan }>>({});
  const uploadKeys = shown.map((d) => (d.mission ? `${d.droneId}|${d.mission.missionId}|${d.mission.uploadedAt}` : '')).filter(Boolean).sort().join(',');
  useEffect(() => {
    for (const d of shown) {
      if (!d.mission) continue;
      const key = `${d.mission.missionId}|${d.mission.uploadedAt}`;
      if (loaded[d.droneId]?.key === key) continue;
      api<{ mission: { plan: MissionPlan } | null }>(`/api/v2/organisations/${orgId}/drones/${d.droneId}/loaded-mission`)
        .then((r) => r.mission && setLoaded((prev) => ({ ...prev, [d.droneId]: { key, plan: r.mission!.plan } })))
        .catch(() => undefined);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [uploadKeys, orgId]);
  /** The loaded plan of each drone, flown from its home – or from where it was started in the air. */
  const plansKey = shown
    .map((d) => (d.mission ? `${d.droneId}|${d.mission.missionId}|${d.mission.uploadedAt}|${JSON.stringify(d.mission.start)}|${d.telemetry?.home?.lat.toFixed(6)},${d.telemetry?.home?.lon.toFixed(6)}` : ''))
    .join(';');
  const plans = useMemo(() => {
    const out: Record<string, MissionPlan> = {};
    for (const d of shown) {
      const l = d.mission ? loaded[d.droneId] : undefined;
      if (l && l.key === `${d.mission!.missionId}|${d.mission!.uploadedAt}`) out[d.droneId] = flownFrom(l.plan, d.telemetry?.home, d.mission!.start);
    }
    return out;
    // Recomputed when an upload, a start or a home changes – not at every telemetry update.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [plansKey, loaded]);

  const selected = shown.find((d) => d.droneId === selectedId) ?? null;
  const detail = drones.find((d) => d.droneId === detailId) ?? null;
  const positions = shown.filter((d) => d.telemetry).map((d) => [d.telemetry!.lat, d.telemetry!.lon] as [number, number]);
  const onPick = picking
    ? (lat: number, lon: number) => {
        setPicked({ lat, lon });
        setPicking(false);
      }
    : null;
  const pushSystem = (e: ConsoleEvent) => setSystemEvents((prev) => [e, ...prev].slice(0, 50));
  // UTM, traffic, separation and swarm notifications appear in the event log too.
  const logEvents = useMemo<ConsoleEvent[]>(
    () => [
      ...systemEvents,
      // Traffic advisories and drone faults are already drone events.
      ...live.notifications
        .filter((n) => n.category !== 'traffic' && n.category !== 'drone')
        .map((n) => ({
          t: Date.parse(n.createdAt),
          level: n.level === 'critical' ? 'error' : n.level,
          drone: null,
          message: `${n.title}${n.resolvedAt ? ' (ended)' : ''} – ${n.message}`,
        })),
    ],
    [systemEvents, live.notifications],
  );
  const anyTelemetry = shown.some((d) => d.telemetry);
  // Panels and map controls sit just below the toolbar, however many rows it takes.
  const consoleRef = useRef<HTMLDivElement>(null);
  const toolbarRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const c = consoleRef.current;
    const tb = toolbarRef.current;
    if (!c || !tb) return;
    const update = () => c.style.setProperty('--console-top', `${Math.round(tb.offsetTop + tb.offsetHeight + 6)}px`);
    update();
    const ro = new ResizeObserver(update);
    ro.observe(tb);
    return () => ro.disconnect();
  }, []);

  // The console clips what overflows it: an open toolbar menu ends above its bottom edge, and
  // longer lists (many vehicles) scroll inside the menu.
  useEffect(() => {
    const c = consoleRef.current;
    const tb = toolbarRef.current;
    if (!c || !tb) return;
    const fit = () => {
      const bottom = c.getBoundingClientRect().bottom;
      tb.querySelectorAll<HTMLElement>('details[open] > .dropdown-menu').forEach((m) => {
        m.style.maxHeight = `${Math.max(120, Math.floor(bottom - m.getBoundingClientRect().top - 12))}px`;
      });
    };
    const openMenus = () => [...tb.querySelectorAll<HTMLDetailsElement>('details.dropdown[open]')];
    // One menu at a time: opening one closes the others.
    const onToggle = (e: Event) => {
      const d = e.target as HTMLDetailsElement;
      if (d.open) for (const other of openMenus()) if (other !== d) other.open = false;
      fit();
    };
    // A click elsewhere, or Escape, closes them (Escape gives the focus back to the menu's button).
    const onPointer = (e: PointerEvent) => {
      for (const d of openMenus()) if (!d.contains(e.target as Node)) d.open = false;
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      const open = openMenus();
      if (!open.length) return;
      for (const d of open) d.open = false;
      open[0]!.querySelector<HTMLElement>('summary')?.focus();
    };
    // "toggle" does not bubble: listen in the capture phase.
    tb.addEventListener('toggle', onToggle, true);
    window.addEventListener('resize', fit);
    document.addEventListener('pointerdown', onPointer);
    document.addEventListener('keydown', onKey);
    return () => {
      tb.removeEventListener('toggle', onToggle, true);
      window.removeEventListener('resize', fit);
      document.removeEventListener('pointerdown', onPointer);
      document.removeEventListener('keydown', onKey);
    };
  }, []);

  /** Where the overlays leave the map free: below the toolbar, left of the video column, above the event log (and the phone's video strip). */
  const fitPadding = useCallback(() => {
    const c = consoleRef.current;
    if (!c) return { top: 30, right: 30, bottom: 30, left: 30 };
    const cr = c.getBoundingClientRect();
    const tb = toolbarRef.current?.getBoundingClientRect();
    const vids = c.querySelector('.console-videos')?.getBoundingClientRect();
    const log = c.querySelector('.console-log')?.getBoundingClientRect();
    const strip = !!vids && vids.width > cr.width * 0.8;
    return {
      top: (tb ? tb.bottom - cr.top : 0) + 24,
      left: 30,
      right: vids && !strip ? cr.right - vids.left + 24 : 30,
      bottom: Math.max(strip && vids ? cr.bottom - vids.top : 0, log ? cr.bottom - log.top : 0) + 24,
    };
  }, []);

  /** The console's overlays on the map (the 3D view keeps the drone tags clear of them). */
  const overlayRects = useCallback(() => {
    const c = consoleRef.current;
    if (!c) return [];
    return [...c.querySelectorAll('.console-toolbar, .console-videos .vtile, .console-log, .console-panel, .console-drawer')].map((e) => e.getBoundingClientRect());
  }, []);

  return (
    <div className="content fill">
      <div className="console" data-testid="live-console" ref={consoleRef}>
        <div className="console-stage">
          {anyTelemetry && view === '3d' && (
            <Suspense fallback={<div className="console-empty">Loading the 3D view…</div>}>
              <Live3D drones={shown} models={models} airframes={airframes} zones={zones.data ?? []} zonesError={zones.error} plans={plans} selectedId={selectedId} onSelect={setSelectedId} onPick={onPick} layers={layers} follow={follow} previewRoutes={previewRoutes} fitPadding={fitPadding} overlays={overlayRects} />
            </Suspense>
          )}
          {anyTelemetry && view === 'map' && (
            <MapView
              className="fill"
              fitKey={shown.map((d) => d.droneId).join() + positions.length}
              fit={positions}
              fitPadding={fitPadding}
              cursor={picking ? 'crosshair' : undefined}
              onClick={(lat, lon) => onPick?.(lat, lon)}
              lines={[
                ...(layers.routes
                  ? shown.flatMap((d) => {
                      const plan = plans[d.droneId];
                      return plan ? [{ id: `route:${d.droneId}`, points: missionPath(plan).map((p) => [p.lat, p.lon] as [number, number]), color: '#ffffff', weight: 2 }] : [];
                    })
                  : []),
                ...(previewRoutes ?? []).map((r) => ({ id: `preview:${r.droneId}`, points: missionPath(r.plan).map((p) => [p.lat, p.lon] as [number, number]), color: r.color, weight: 3, dashed: true, label: r.name })),
                ...(layers.trails ? shown.filter((d) => d.track.length > 1).map((d) => ({ id: d.droneId, points: d.track, color: '#facc15', weight: 4 })) : []),
              ]}
              markers={[
                ...shown.filter((d) => d.telemetry).map((d) => ({ id: d.droneId, lat: d.telemetry!.lat, lon: d.telemetry!.lon, heading: d.telemetry!.heading, color: d.droneId === selectedId ? '#ef4444' : d.telemetry!.inAir ? '#f59e0b' : '#94a3b8', label: `${d.name} · ${Math.round(d.telemetry!.altRel)} m`, onClick: () => setSelectedId(d.droneId) })),
                ...shown.flatMap((d) => d.traffic).map((a) => ({ id: a.icao, lat: a.lat, lon: a.lon, heading: a.heading, color: '#f97316', label: `✈ ${a.callsign ?? a.icao} ${Math.round(a.altMsl)} m` })),
                // Objects found by AI vision, at their estimated ground positions.
                ...shown.flatMap((d) =>
                  d.ai?.enabled
                    ? d.detections
                        .filter((o) => o.lat !== null && o.lon !== null)
                        .map((o) => ({
                          id: `obj:${d.droneId}:${o.trackId}`,
                          lat: o.lat!,
                          lon: o.lon!,
                          radius: 5,
                          color: o.trackId === d.ai?.following ? '#ef4444' : o.cls === 'person' ? '#22d3ee' : '#e879f9',
                          label: `#${o.trackId} ${o.color ? `${o.color} ` : ''}${o.cls}`,
                        }))
                    : [],
                ),
              ]}
            />
          )}
          {!anyTelemetry && (
            <div className="console-empty">
              <Empty>
                {drones.length === 0 ? 'No drones registered.' : drones.some((d) => d.online) ? 'No vehicle selected – choose drones in “Vehicles”.' : 'No drone is online – connect a drone (or the simulator) with its link key.'}
              </Empty>
            </div>
          )}
        </div>

        <div className="console-toolbar" ref={toolbarRef}>
          <div className="segmented" role="group" aria-label="Live view">
            <button className={`btn small${view === '3d' ? ' primary' : ''}`} onClick={() => chooseView('3d')} title="3D view">
              <Box className="tb-icon" /> <span className="tb-label">3D view</span>
            </button>
            <button className={`btn small${view === 'map' ? ' primary' : ''}`} onClick={() => chooseView('map')} title="2D map">
              <MapIcon className="tb-icon" /> <span className="tb-label">2D map</span>
            </button>
          </div>
          <details className="dropdown">
            <summary className="btn small" title="Vehicles shown">
              <Plane /> <span className="tb-label">Vehicles </span>
              <span className="tb-count">
                ({shown.length}/{drones.length})
              </span>
            </summary>
            <div className="dropdown-menu">
              {!live.connected && <div className="small" style={{ color: 'var(--danger)' }}>Connecting to the real-time service…</div>}
              {drones.map((d) => (
                <label key={d.droneId} className="row small" data-testid={`select-${d.name}`}>
                  <input type="checkbox" checked={shown.includes(d)} onChange={() => toggle(d.droneId)} aria-label={`Show ${d.name}`} />
                  <span className={`dot ${d.online ? 'ok' : ''}`} /> {d.name}
                  <span className="muted">{d.online ? `${String(d.telemetry?.mode ?? '…')} · ${Math.round(d.telemetry?.battery.pct ?? 0)}%` : 'offline'}</span>
                </label>
              ))}
              <div className="muted small" style={{ marginTop: 6 }}>Online now</div>
              {live.users.map((u) => (
                <div key={u.userId} className="row small">
                  <span className="dot ok" /> {u.name} <span className="muted">{u.role}</span>
                </div>
              ))}
            </div>
          </details>
          <details className="dropdown">
            <summary className="btn small" title="Layers">
              <Layers /> <span className="tb-label">Layers</span>
            </summary>
            <div className="dropdown-menu">
              {(
                [
                  ['frustum', 'Camera view frustum'],
                  ['trails', 'Flown trajectories'],
                  ['routes', 'Mission routes'],
                  ['zones', 'Airspace zones'],
                ] as [keyof Live3DLayers, string][]
              ).map(([k, label]) => (
                <label key={k} className="row small">
                  <input type="checkbox" checked={layers[k]} onChange={(e) => setLayer(k, e.target.checked)} /> {label}
                </label>
              ))}
            </div>
          </details>
          {software && view === '3d' && (
            <span className="small nowrap" style={{ color: 'var(--warn)' }} title="No GPU acceleration: WebGL is rendered in software on this computer, so the 3D view may be slow">
              <TriangleAlert size={13} style={{ verticalAlign: -2 }} /> <span className="tb-label">Software 3D</span>
            </span>
          )}
          <label className="row small chip-like" title="Follow the selected drone with the camera (3D)">
            <input type="checkbox" checked={follow} onChange={(e) => setFollow(e.target.checked)} disabled={!selectedId || view !== '3d'} /> <LocateFixed className="tb-icon" />
            <span className="tb-label">Follow selected</span>
          </label>
          {live.canControl && (
            <button
              className={`btn small${reposition ? ' active' : ''}`}
              aria-pressed={!!reposition}
              title="Reposition"
              onClick={() => {
                if (reposition) return setReposition(null);
                setSwarmOpen(false);
                setDetailId(null);
                setReposition(selectedId ?? shown.find((d) => d.telemetry?.inAir)?.droneId ?? shown[0]?.droneId ?? null);
              }}
              disabled={shown.length === 0}
            >
              <Crosshair /> <span className="tb-label">Reposition</span>
            </button>
          )}
          <button
            className={`btn small${swarmOpen ? ' active' : ''}`}
            title="Swarm"
            onClick={() => {
              if (!swarmOpen) {
                setReposition(null);
                setDetailId(null);
              }
              setSwarmOpen((o) => !o);
            }}
            aria-pressed={swarmOpen}
          >
            <Hexagon /> <span className="tb-label">Swarm</span>
            {swarmOp && !['completed', 'aborted', 'failed'].includes(swarmOp.state) ? <span className="tb-count"> · {swarmOp.state}</span> : null}
          </button>
        </div>

        {shown.length > 0 && (
          <aside className="console-videos" data-testid="video-stack">
            {shown.map((d) => (
              <VideoTile
                key={d.droneId}
                d={d}
                selected={d.droneId === selectedId}
                takeoffAlt={takeoffAlt}
                swarm={swarmOf(d.droneId)}
                onSelect={() => setSelectedId(d.droneId)}
                onDetails={() => {
                  // One panel at a time: details, reposition and swarm share the left side.
                  setSelectedId(d.droneId);
                  setReposition(null);
                  setSwarmOpen(false);
                  setDetailId(d.droneId);
                }}
                onReposition={() => {
                  setSelectedId(d.droneId);
                  setSwarmOpen(false);
                  setDetailId(null);
                  setReposition(d.droneId);
                }}
              />
            ))}
          </aside>
        )}

        <EventLogOverlay drones={shown} system={logEvents} />

        {swarmOpen && <SwarmPanel drones={drones} onPreview={setPreviewRoutes} onSystemEvent={pushSystem} onClose={() => setSwarmOpen(false)} />}

        {reposition && (
          <RepositionForm
            drones={drones}
            droneId={reposition}
            setDroneId={setReposition}
            picked={picked}
            picking={picking}
            setPicking={setPicking}
            onClose={() => {
              setReposition(null);
              setPicking(false);
              setPicked(null);
            }}
            onSystemEvent={pushSystem}
          />
        )}

        {detail && (
          <div className="console-drawer" data-testid="drone-detail">
            <div className="row" style={{ justifyContent: 'flex-end' }}>
              <button className="icon-btn" aria-label="Close details" onClick={() => setDetailId(null)}>
                <X />
              </button>
            </div>
            <DroneCard d={detail} manualActive={manualFor === detail.droneId} setManual={(v) => setManualFor(v ? detail.droneId : null)} swarm={swarmOf(detail.droneId)} />
          </div>
        )}
        {selected && !detail && <span className="sr-only">Selected {selected.name}</span>}
      </div>
    </div>
  );
}
