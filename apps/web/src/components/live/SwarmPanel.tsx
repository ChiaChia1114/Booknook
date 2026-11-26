/**
 * Swarm control in the live console: choose drones, send group commands to all of them at
 * once (staggered take-off, hold, return home, land), plan a swarm mission (formation of one
 * mission or a route split between the drones) with a preview on the map, and run it with a
 * synchronised take-off, synchronised waypoints and a common return.
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import { Flag, Hexagon, House, Pause, PlaneLanding, PlaneTakeoff, Play, X } from 'lucide-react';
import type { CommandName, CommandParams, FormationPattern, MissionDto, MissionPlan, SwarmAction, SwarmDto, SwarmOptionsDto, SwarmPreviewDto } from '@athena-sky/shared';
import { FORMATION_PATTERNS } from '@athena-sky/shared';
import { api, errorMessage } from '../../api/client';
import type { DroneView } from '../../api/live';
import { useApi } from '../../hooks';
import { useAuth, useOrgId } from '../../state/auth';
import { useLive } from '../../state/live';
import { BusyButton, ErrorBox, Loading, fmtDistance, fmtDuration, loadError, useToast } from '../ui';
import type { ConsoleEvent } from './ConsoleOverlays';

export interface PreviewRoute {
  droneId: string;
  name: string;
  plan: MissionPlan;
  color: string;
}

export const SWARM_COLORS = ['#22d3ee', '#a78bfa', '#f472b6', '#34d399', '#fbbf24', '#60a5fa', '#f87171', '#c084fc', '#2dd4bf', '#fb923c', '#e879f9', '#4ade80'];
const FINAL = new Set(['completed', 'aborted', 'failed']);
const PATTERN_LABEL: Record<FormationPattern, string> = { line: 'Line abreast', column: 'Column (trail)', echelon: 'Echelon', v: 'V formation', grid: 'Grid' };
const MEMBER_TONE: Record<string, string> = { flying: 'ok', returning: 'accent', waiting: 'warn', paused: 'warn', detached: 'danger', upload_failed: 'danger', done: '', uploaded: '' };

/** The operation shown in the panel: a running one, else the newest. */
export function currentOperation(swarms: Record<string, SwarmDto>, initial: SwarmDto[]): SwarmDto | null {
  const all = new Map<string, SwarmDto>();
  for (const s of initial) all.set(s.id, s);
  for (const s of Object.values(swarms)) all.set(s.id, s);
  const list = [...all.values()].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  return list.find((s) => !FINAL.has(s.state)) ?? list[0] ?? null;
}

export function SwarmPanel({ drones, onPreview, onSystemEvent, onClose }: { drones: DroneView[]; onPreview(routes: PreviewRoute[] | null): void; onSystemEvent(e: ConsoleEvent): void; onClose(): void }) {
  const orgId = useOrgId();
  const { can } = useAuth();
  const { live, client } = useLive();
  const toast = useToast();
  const online = drones.filter((d) => d.online);
  // Every drone online when the panel opens is chosen – or, opened while the connection is being
  // made (the drones not known yet), every drone online once they are.
  const [picked, setPicked] = useState<Set<string> | null>(() => (live.synced ? new Set(online.map((d) => d.droneId)) : null));
  if (picked === null && live.synced) setPicked(new Set(online.map((d) => d.droneId)));
  const members = online.filter((d) => picked?.has(d.droneId));
  const [alt, setAlt] = useState(20);
  const [step, setStep] = useState(5);
  const missions = useApi<MissionDto[]>(`/api/v2/organisations/${orgId}/missions`);
  const history = useApi<SwarmDto[]>(`/api/v2/organisations/${orgId}/swarms`);
  const [missionId, setMissionId] = useState('');
  const [opts, setOpts] = useState<SwarmOptionsDto>({ mode: 'formation', pattern: 'line', spacingM: 20, altStepM: 5, syncWaypoints: true, syncLanding: true });
  const [preview, setPreview] = useState<SwarmPreviewDto | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [dismissed, setDismissed] = useState<string | null>(null);
  const op = useMemo(() => currentOperation(live.swarms, history.data ?? []), [live.swarms, history.data]);
  const shownOp = op && op.id !== dismissed ? op : null;
  // A running operation may be among the earlier ones: until they are loaded, no new one is offered.
  const opsLoading = !op && !history.data && !history.error;

  useEffect(() => {
    if (!missionId && missions.data?.length) setMissionId(missions.data[0]!.id);
  }, [missions.data, missionId]);
  // A changed selection invalidates the preview.
  const planKey = `${missionId}|${members.map((m) => m.droneId).join()}|${JSON.stringify(opts)}`;
  useEffect(() => {
    setPreview(null);
    onPreview(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [planKey]);
  useEffect(() => () => onPreview(null), [onPreview]);

  /** The selected drones in the order of their places in a group command (the altitude steps). */
  const ordered = () => [...members].sort((a, b) => a.name.localeCompare(b.name));
  const group = async (command: CommandName, params: (i: number) => CommandParams = () => ({})) => {
    if (!client) return;
    const list = ordered();
    // Sent at the same moment to every drone.
    const results = await Promise.all(list.map((d, i) => client.command(d.droneId, command, params(i))));
    const failed = list.filter((_, i) => results[i]!.result !== 'accepted' && results[i]!.result !== 'completed');
    if (failed.length) {
      toast(`${command}: refused by ${failed.map((d) => d.name).join(', ')}`, 'error');
      failed.forEach((d) => {
        const r = results[list.indexOf(d)]!;
        onSystemEvent({ t: Date.now(), level: 'warning', drone: d.name, message: `${command} ${r.result}${r.message ? `: ${r.message}` : ''}` });
      });
    } else toast(`${command} sent to ${list.length} drones`, 'ok');
  };

  // A group take-off arms and launches every selected drone: asked first, like a single take-off,
  // and sent once however often the button is clicked while it is under way. (Hold, RTL and land
  // can be sent again at any time.)
  const takingOff = useRef(false);
  const [takeoffBusy, setTakeoffBusy] = useState(false);
  const takeOffSelected = async () => {
    if (takingOff.current) return;
    takingOff.current = true;
    setTakeoffBusy(true);
    try {
      const list = ordered();
      if (list.length === 0 || !confirm(`Take off ${list.map((d, i) => `${d.name} to ${alt + i * step} m`).join(', ')}?`)) return;
      await group('takeoff', (i) => ({ alt: alt + i * step }));
    } finally {
      takingOff.current = false;
      setTakeoffBusy(false);
    }
  };

  const body = () => ({ missionId, droneIds: members.map((d) => d.droneId), options: opts });
  const runPreview = async () => {
    setBusy('preview');
    try {
      const p = await api<SwarmPreviewDto>(`/api/v2/organisations/${orgId}/swarms/preview`, { body: body() });
      setPreview(p);
      onPreview(p.members.map((m, i) => ({ droneId: m.droneId, name: m.name, plan: m.plan, color: SWARM_COLORS[i % SWARM_COLORS.length]! })));
    } catch (err) {
      toast(errorMessage(err), 'error');
    } finally {
      setBusy(null);
    }
  };
  const upload = async () => {
    const blocked = preview?.airspace.filter((a) => a.verdict === 'blocked') ?? [];
    const blockedText = blocked.map((a) => `${a.name}: ${a.conflicts.filter((c) => c.severity === 'blocking').map((c) => c.message).join('; ')}`).join('\n');
    if (blocked.length) {
      if (!can('authorization.decide')) {
        toast(`Airspace check blocked (${blocked.map((a) => a.name).join(', ')}) – change the route or ask an owner or administrator to override it`, 'error');
        return;
      }
      if (!confirm(`Airspace check blocked:\n${blockedText}\n\nOverride the check and upload anyway? The override is recorded in the audit log.`)) return;
    }
    if (preview?.warnings.length && !confirm(`${preview.warnings.join('\n')}\n\nUpload anyway?`)) return;
    setBusy('upload');
    try {
      const created = await api<SwarmDto>(`/api/v2/organisations/${orgId}/swarms`, {
        body: { ...body(), acceptWarnings: !!preview?.warnings.length, ...(blocked.length ? { acceptAirspaceConflicts: true } : {}) },
      });
      history.setData([created, ...(history.data ?? [])]);
      setDismissed(null);
      setPreview(null);
      onPreview(null);
      toast(created.state === 'ready' ? 'Missions uploaded – ready for a synchronised take-off' : `Upload: ${created.message ?? created.state}`, created.state === 'ready' ? 'ok' : 'error');
    } catch (err) {
      toast(errorMessage(err), 'error');
    } finally {
      setBusy(null);
    }
  };
  // One operation action at a time, however often its button is clicked while it is under way.
  const acting = useRef(false);
  const act = async (action: SwarmAction) => {
    if (!shownOp || acting.current) return;
    const endText =
      shownOp.state === 'returning'
        ? 'Stop coordinating the drones? Each finishes its way home by itself (RTL), without waiting for the others.'
        : 'Stop coordinating the drones? They continue their missions on their own, without waiting for each other. To bring them home on separate altitudes, use Return all instead.';
    if (action === 'end' && !FINAL.has(shownOp.state) && shownOp.state !== 'ready' && !confirm(endText)) return;
    if (action === 'start' && !confirm(`Synchronised take-off of ${shownOp.members.map((m) => m.name).join(', ')}? They arm and take off together.`)) return;
    acting.current = true;
    setBusy(action);
    try {
      await api<SwarmDto>(`/api/v2/organisations/${orgId}/swarms/${shownOp.id}/actions`, { body: { action } });
    } catch (err) {
      toast(errorMessage(err), 'error');
    } finally {
      acting.current = false;
      setBusy(null);
    }
  };
  const canControl = live.canControl;
  const nameOf = (id: string) => drones.find((d) => d.droneId === id)?.name ?? id.slice(0, 6);

  return (
    <div className="console-panel swarm" data-testid="swarm-panel" onClick={(e) => e.stopPropagation()}>
      <div className="row" style={{ justifyContent: 'space-between' }}>
        <b className="row" style={{ gap: 6 }}>
          <Hexagon size={15} aria-hidden="true" /> Swarm
        </b>
        <button className="icon-btn" aria-label="Close swarm panel" onClick={onClose}>
          <X />
        </button>
      </div>

      <ErrorBox error={loadError('Earlier swarm operations', history.error)} />
      {shownOp && (
        <section className="swarm-op" data-testid="swarm-operation">
          <div className="row" style={{ justifyContent: 'space-between' }}>
            <b className="truncate">{shownOp.name}</b>
            <span className={`chip ${shownOp.state === 'running' ? 'ok' : shownOp.state === 'failed' || shownOp.state === 'aborted' ? 'danger' : 'accent'}`} data-testid="swarm-state">
              {shownOp.state}
            </span>
          </div>
          <div className="small muted">
            {shownOp.options.mode === 'formation' ? `${PATTERN_LABEL[shownOp.options.pattern ?? 'line']} · ${shownOp.options.spacingM ?? 20} m` : 'Split route'}
            {shownOp.message ? ` · ${shownOp.message}` : ''}
          </div>
          <div className="swarm-members">
            {shownOp.members.map((m) => (
              <div key={m.droneId} className="swarm-member" data-testid={`swarm-member-${m.name}`}>
                <span className="truncate">
                  <b>{m.name}</b> <span className="muted small">{shownOp.options.mode === 'formation' ? (m.slot === 0 ? 'leader' : `slot ${m.slot + 1}`) : `part ${m.slot + 1}`}</span>
                </span>
                <span className="small muted" title="Synchronisation points passed" data-testid={`swarm-sync-${m.name}`}>
                  <Flag size={12} style={{ verticalAlign: -1 }} /> {m.syncPassed}/{m.syncTotal}
                </span>
                <span className={`chip ${MEMBER_TONE[m.state] ?? ''}`}>{m.state.replace('_', ' ')}</span>
                {m.message && <div className="small muted swarm-msg">{m.message}</div>}
              </div>
            ))}
          </div>
          {canControl && (
            <div className="row" style={{ flexWrap: 'wrap', gap: 4, marginTop: 6 }}>
              {/* One button through the states it moves the operation between (take-off, pause,
                  resume): the focus stays on it when the state changes. */}
              {(shownOp.state === 'ready' || shownOp.state === 'running' || shownOp.state === 'paused') && (
                <BusyButton
                  className={`btn small${shownOp.state === 'ready' ? ' ok solid' : shownOp.state === 'paused' ? ' primary' : ''}`}
                  busy={!!busy}
                  onClick={() => act(shownOp.state === 'ready' ? 'start' : shownOp.state === 'running' ? 'pause' : 'resume')}
                >
                  {shownOp.state === 'ready' ? (
                    <>
                      <PlaneTakeoff /> Synchronised take-off
                    </>
                  ) : shownOp.state === 'running' ? (
                    <>
                      <Pause /> Pause all
                    </>
                  ) : (
                    <>
                      <Play /> Resume all
                    </>
                  )}
                </BusyButton>
              )}
              {(shownOp.state === 'running' || shownOp.state === 'paused') && (
                <BusyButton className="btn small" busy={!!busy} onClick={() => act('rtl')} title="Each drone climbs to its own return altitude, then all fly home and land together">
                  <House /> Return all
                </BusyButton>
              )}
              {(shownOp.state === 'running' || shownOp.state === 'paused' || shownOp.state === 'returning') && (
                <BusyButton className="btn small" busy={!!busy} onClick={() => act('land')} title="Every drone lands where it is">
                  <PlaneLanding /> Land all
                </BusyButton>
              )}
              {/* "End" becomes "New operation" in place: the focus stays on it. */}
              {!FINAL.has(shownOp.state) ? (
                <BusyButton className="btn small ghost danger-text" busy={!!busy} onClick={() => act('end')}>
                  {shownOp.state === 'ready' ? 'Cancel' : 'End'}
                </BusyButton>
              ) : (
                <BusyButton className="btn small ghost" busy={false} onClick={() => setDismissed(shownOp.id)}>
                  New operation
                </BusyButton>
              )}
            </div>
          )}
        </section>
      )}

      {opsLoading && live.synced && <Loading what="Loading swarm operations…" />}
      {(!shownOp || FINAL.has(shownOp.state)) && canControl && !opsLoading && (
        <>
          <section>
            <div className="small muted">Drones ({members.length} selected)</div>
            <div className="swarm-pick">
              {online.length === 0 && <div className="small muted">No drone is online.</div>}
              {online.map((d) => (
                <label key={d.droneId} className="row small">
                  <input
                    type="checkbox"
                    checked={!!picked?.has(d.droneId)}
                    aria-label={`Swarm ${d.name}`}
                    onChange={() =>
                      setPicked((p) => {
                        const n = new Set(p ?? []);
                        if (n.has(d.droneId)) n.delete(d.droneId);
                        else n.add(d.droneId);
                        return n;
                      })
                    }
                  />
                  {d.name}
                  <span className="muted">
                    {String(d.telemetry?.mode ?? '…')} · {Math.round(d.telemetry?.battery.pct ?? 0)}%{d.controller ? ` · ${d.controller.name}` : ''}
                  </span>
                </label>
              ))}
            </div>
          </section>

          <section>
            <div className="small muted">Group commands (all selected drones at once)</div>
            <div className="form-grid">
              <label className="field">
                Take-off alt (m)
                <input type="number" value={alt} min={2} onChange={(e) => setAlt(Number(e.target.value) || 2)} aria-label="Group take-off altitude" />
              </label>
              <label className="field">
                Stagger (m)
                <input type="number" value={step} min={0} onChange={(e) => setStep(Math.max(0, Number(e.target.value) || 0))} aria-label="Group altitude stagger" />
              </label>
            </div>
            <div className="row" style={{ flexWrap: 'wrap', gap: 4, marginTop: 6 }}>
              <BusyButton className="btn small" disabled={members.length === 0} busy={takeoffBusy} onClick={() => void takeOffSelected()}>
                <PlaneTakeoff /> Take off selected
              </BusyButton>
              <button className="btn small" disabled={members.length === 0} onClick={() => group('hold')}>
                <Pause /> Hold selected
              </button>
              <button className="btn small" disabled={members.length === 0} onClick={() => group('rtl')} title="Each selected drone returns home on its own (its RTL altitude) – a swarm operation's Return all keeps them on separate altitudes">
                <House /> RTL selected
              </button>
              <button className="btn small" disabled={members.length === 0} onClick={() => group('land')} title="Each selected drone lands where it is">
                <PlaneLanding /> Land selected
              </button>
            </div>
          </section>

          <section>
            <div className="small muted">Swarm mission</div>
            <ErrorBox error={loadError('The missions', missions.error)} />
            <label className="field">
              Mission
              <select value={missionId} onChange={(e) => setMissionId(e.target.value)} aria-label="Swarm mission" disabled={!missions.data?.length}>
                {!missions.data?.length && <option value="">{missions.data ? 'No missions – plan one first' : missions.error ? 'Not loaded' : 'Loading…'}</option>}
                {(missions.data ?? []).map((m) => (
                  <option key={m.id} value={m.id}>
                    {m.name}
                  </option>
                ))}
              </select>
            </label>
            <div className="segmented" role="group" aria-label="Swarm mode" style={{ margin: '6px 0' }}>
              <button className={`btn small${opts.mode === 'formation' ? ' primary' : ''}`} onClick={() => setOpts({ ...opts, mode: 'formation' })}>
                Formation
              </button>
              <button className={`btn small${opts.mode === 'split' ? ' primary' : ''}`} onClick={() => setOpts({ ...opts, mode: 'split' })}>
                Split route
              </button>
            </div>
            <div className="form-grid">
              {opts.mode === 'formation' && (
                <>
                  <label className="field">
                    Pattern
                    <select value={opts.pattern} onChange={(e) => setOpts({ ...opts, pattern: e.target.value as FormationPattern })} aria-label="Formation pattern">
                      {FORMATION_PATTERNS.map((p) => (
                        <option key={p} value={p}>
                          {PATTERN_LABEL[p]}
                        </option>
                      ))}
                    </select>
                  </label>
                  <label className="field">
                    Spacing (m)
                    <input type="number" min={2} value={opts.spacingM} onChange={(e) => setOpts({ ...opts, spacingM: Math.max(2, Number(e.target.value) || 2) })} aria-label="Formation spacing" />
                  </label>
                </>
              )}
              <label className="field">
                Altitude step (m)
                <input type="number" min={0} value={opts.altStepM} onChange={(e) => setOpts({ ...opts, altStepM: Math.max(0, Number(e.target.value) || 0) })} aria-label="Swarm altitude step" />
              </label>
            </div>
            {opts.mode === 'formation' && (
              <label className="row small">
                <input type="checkbox" checked={opts.syncWaypoints !== false} onChange={(e) => setOpts({ ...opts, syncWaypoints: e.target.checked })} /> Synchronise every waypoint (matched leg speeds)
              </label>
            )}
            <label className="row small">
              <input type="checkbox" checked={!!opts.syncLanding} onChange={(e) => setOpts({ ...opts, syncLanding: e.target.checked })} /> Return home together
            </label>
            <div className="row" style={{ gap: 4, marginTop: 6 }}>
              <BusyButton className="btn small" disabled={!missionId || members.length < 2} busy={!!busy} onClick={runPreview}>
                Preview
              </BusyButton>
              <BusyButton className="btn small primary" disabled={!preview || (preview.errors ?? []).length > 0} busy={!!busy} title={preview?.errors?.length ? 'Fix the problems listed below first' : undefined} onClick={upload}>
                Upload to {members.length} drones
              </BusyButton>
            </div>
            {members.length < 2 && <div className="small muted">Select at least two drones.</div>}
            {preview && (
              <div className="swarm-preview" data-testid="swarm-preview">
                {preview.members.map((m, i) => (
                  <div key={m.droneId} className="row small" style={{ gap: 6 }}>
                    <span className="swatch" style={{ background: SWARM_COLORS[i % SWARM_COLORS.length] }} />
                    <b>{m.name}</b>
                    <span className="muted">{opts.mode === 'formation' ? (m.slot === 0 ? 'leader' : `slot ${m.slot + 1}`) : `part ${m.slot + 1}`}</span>
                    <span className="spacer" />
                    {fmtDistance(m.distanceM)} · {fmtDuration(m.durationS)}
                  </div>
                ))}
                {preview.separation && (
                  <div className="small" data-testid="swarm-separation">
                    Closest approach {preview.separation.distanceM} m ({nameOf(preview.separation.droneA)} – {nameOf(preview.separation.droneB)}, {Math.round(preview.separation.t)} s after take-off)
                  </div>
                )}
                {(preview.errors ?? []).map((e, i) => (
                  <div key={`e${i}`} className="issue error" data-testid="swarm-error">
                    {e}
                  </div>
                ))}
                {preview.warnings.map((w, i) => (
                  <div key={i} className="issue warning">
                    {w}
                  </div>
                ))}
                <div data-testid="swarm-airspace" className="col" style={{ gap: 4 }}>
                  {preview.airspace.every((a) => a.verdict === 'clear') ? (
                    <div className="small muted">Airspace: clear for every drone.</div>
                  ) : (
                    preview.airspace
                      .filter((a) => a.verdict !== 'clear')
                      .map((a) => (
                        <div key={a.droneId} className={`issue ${a.verdict === 'blocked' ? 'error' : 'warning'}`}>
                          Airspace {a.verdict === 'blocked' ? 'blocked' : 'needs review'} – {a.name}:{' '}
                          {a.conflicts
                            .filter((c) => c.severity !== 'advisory')
                            .map((c) => c.message)
                            .join('; ')}
                        </div>
                      ))
                  )}
                </div>
                <div className="small muted">Total {fmtDuration(preview.durationS)} including waits at the synchronisation points.</div>
              </div>
            )}
          </section>
        </>
      )}
      {!live.synced && !shownOp && <Loading what="Connecting to the real-time service…" />}
      {live.synced && !canControl && !shownOp && !opsLoading && <div className="small muted">Your role can watch swarm operations but not control drones.</div>}
    </div>
  );
}
