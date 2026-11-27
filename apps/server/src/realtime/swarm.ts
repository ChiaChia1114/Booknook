/**
 * Swarm operations: several drones flying one mission in formation (or a mission split between
 * them) with a synchronised take-off, barrier synchronisation and a common return.
 *
 *  - create: plans the per-drone missions (shared `planSwarm`), stores them as missions of the
 *    operation and uploads them to all drones in parallel;
 *  - start: sends `mission_start` to every drone at the same moment (synchronised take-off);
 *  - barriers: the mission items listed as sync points (take-off completion, waypoints or the
 *    last waypoint) are barriers – a drone that passes one while another has not yet reached it
 *    is held (`mission_pause`) and all waiting drones continue together (`mission_resume`) when
 *    the last one arrives;
 *  - pause / resume / return home / land act on every drone of the operation at once.
 *
 * A drone leaves the operation (and stops holding the others back) when its link is lost,
 * another pilot takes control of it, it changes to a mode the operation did not command (e.g. a
 * battery failsafe) or a command is refused. Every change is pushed to live viewers.
 */
import type { MissionPlan, Role, SwarmAction, SwarmDto, SwarmMemberDto, SwarmMemberState, SwarmOptionsDto, SwarmPreviewDto, SwarmState, Telemetry } from '@athena-sky/shared';
import { MOVING_COMMANDS, airframeById, can, flownFrom, haversineDistance, planSwarm, validateMission, type SwarmMemberInput } from '@athena-sky/shared';
import type { Db } from '../db/database';
import { parseJson } from '../db/database';
import type { WebhookDispatcher } from '../integrations/webhooks';
import { audit } from '../lib/audit';
import { badRequest, conflict, notFound } from '../lib/errors';
import { nowIso, uuid } from '../lib/util';
import { getOrgSettings } from '../orgs/org-service';
import type { AirspaceService } from '../airspace/providers';
import { checkMissionAirspace, enforceMissionAirspace } from '../airspace/mission-check';
import type { Hub } from './hub';
import type { NotificationService } from './notifications';

export interface SwarmActor {
  id: string;
  name: string;
  role: Role;
}

interface MemberRt extends SwarmMemberDto {
  syncPoints: number[];
  /** Ordinal of the sync point the drone holds at, waiting for the others. */
  waitingAt: number | null;
  /** Last command sent by the operation (mode changes shortly after it are expected). */
  commandAt: number;
  airborne: boolean;
  /**
   * In the air by its last telemetry – kept with the member: when its link is lost, the hub has
   * dropped the connection (and its telemetry) before the operation hears of it.
   */
  inAir: boolean;
  /**
   * Sync points where the drone holds by itself (unlimited loiters: the last waypoint, the return
   * altitude, above home) until the operation releases it; `ordinal` is the sync point's number.
   */
  holds: { index: number; ordinal: number; lat: number; lon: number; alt: number }[];
  /** The member's own altitude on the way home (m above take-off). */
  returnAltM: number | null;
  home: { lat: number; lon: number } | null;
  /** "Return all home": the member has reached the current step (return altitude, above home). */
  homewardReady: boolean;
}

/**
 * Steps of "return all home": climb (or descend) on the spot to the members' own return
 * altitudes, fly home once all are there, land once all are above their homes.
 */
type HomewardStep = 'climb' | 'home' | 'land';

interface SwarmRt {
  id: string;
  orgId: string;
  name: string;
  baseMissionId: string | null;
  options: SwarmOptionsDto;
  state: SwarmState;
  message: string | null;
  actor: SwarmActor;
  members: MemberRt[];
  /** The step of "return all home" in progress (state `returning`). */
  homeward: HomewardStep | null;
  createdBy: string | null;
  createdByName: string | null;
  createdAt: string;
  updatedAt: string;
}

const FINAL = new Set<SwarmState>(['completed', 'aborted', 'failed']);

/** Why an action is not possible in a state (null: it is). */
const ACTION_REFUSAL: Record<SwarmAction, (state: SwarmState) => string | null> = {
  start: (s) => (s === 'ready' ? null : `The operation cannot start while ${s}`),
  pause: (s) => (s === 'running' ? null : `The operation cannot pause while ${s}`),
  resume: (s) => (s === 'paused' ? null : `The operation cannot resume while ${s}`),
  rtl: (s) => (s === 'running' || s === 'paused' ? null : `Not possible while the operation is ${s}`),
  land: (s) => (s === 'running' || s === 'paused' || s === 'returning' ? null : `Not possible while the operation is ${s}`),
  end: (s) => (FINAL.has(s) ? 'The swarm operation has ended' : null),
};
const MEMBER_FINAL = new Set<SwarmMemberState>(['done', 'detached', 'upload_failed']);
/** Modes a drone reports shortly after an operation command are not judged for this long. */
const MODE_GRACE_MS = 5000;

const memberDto = (m: MemberRt | SwarmMemberDto): SwarmMemberDto => ({
  droneId: m.droneId,
  name: m.name,
  slot: m.slot,
  missionId: m.missionId,
  state: m.state,
  syncPassed: m.syncPassed,
  syncTotal: m.syncTotal,
  seq: m.seq,
  total: m.total,
  message: m.message,
});

export class SwarmService {
  private readonly ops = new Map<string, SwarmRt>();
  private readonly byDrone = new Map<string, string>();
  /**
   * Drones that left an operation (it was ended, or they were detached) while flying its mission:
   * the holds of the operation still ahead in it (unlimited loiters) are released as they reach
   * them – they fly on by themselves instead of waiting for an operation that is gone.
   */
  private readonly released = new Map<string, { orgId: string; actor: SwarmActor; holds: MemberRt['holds']; seq: number; total: number; pending: boolean; at: number }>();

  constructor(private readonly deps: { db: Db; hub: Hub; notifications: NotificationService; webhooks: WebhookDispatcher; airspace: AirspaceService }) {
    // Coordination lives in this process: operations interrupted by a restart are over.
    deps.db.run(
      "UPDATE swarm_operations SET state = 'aborted', message = 'Interrupted by a server restart', updated_at = ? WHERE state NOT IN ('completed', 'aborted', 'failed')",
      nowIso(),
    );
    deps.hub.setCommandGuard((_orgId, droneId, user, command, params) => this.guardCommand(droneId, user, command, params));
    deps.hub.events.on('commanded', (_orgId, droneId, user, command) => this.onCommanded(droneId, user, command));
    deps.hub.events.on('progress', (_orgId, droneId, seq, total) => this.onProgress(droneId, seq, total));
    deps.hub.events.on('telemetry', (_orgId, droneId, t) => this.onTelemetry(droneId, t));
    // A drone that comes back after a link drop still has its holds released (the entry goes
    // when it lands, gets another mission or joins another operation).
    deps.hub.events.on('offline', (_orgId, droneId) => this.detachDrone(droneId, 'Data link lost'));
    deps.hub.events.on('control', (_orgId, droneId, c) => {
      const op = this.opOf(droneId);
      if (op && c && c.userId !== op.actor.id) this.detachDrone(droneId, `${c.name} took control`);
    });
    // The operator was demoted or removed: synchronisation commands would be sent in their
    // name, so the operation ends; the drones keep flying their own missions (or hold).
    deps.hub.events.on('member', (orgId, userId, role) => {
      if (role && can(role, 'drone.control')) return;
      for (const op of [...this.ops.values()]) {
        if (op.orgId === orgId && op.actor.id === userId && !FINAL.has(op.state)) this.finish(op, 'aborted', `${op.actor.name} can no longer control drones – synchronisation stopped, take over the drones`);
      }
    });
  }

  // =======================================================================================
  // Planning and creation
  // =======================================================================================

  private loadBase(orgId: string, missionId: string): { id: string; name: string; plan: MissionPlan } {
    const r = this.deps.db.get<{ id: string; name: string; plan: string }>('SELECT id, name, plan FROM missions WHERE id = ? AND org_id = ? AND swarm_id IS NULL', missionId, orgId);
    if (!r) throw notFound('Mission');
    return { id: r.id, name: r.name, plan: parseJson<MissionPlan>(r.plan, { home: null, items: [], rallyPoints: [], geofence: null, defaultSpeed: 8, defaultAlt: 50 }) };
  }

  private memberInputs(orgId: string, droneIds: string[], requireOnline: boolean): SwarmMemberInput[] {
    const ids = [...new Set(droneIds)];
    if (ids.length < 2) throw badRequest('Select at least two drones');
    if (ids.length > 12) throw badRequest('A swarm can have at most 12 drones');
    return ids.map((id) => {
      const row = this.deps.db.get<{ id: string; name: string; airframe_id: string | null; last_lat: number | null; last_lon: number | null }>(
        'SELECT id, name, airframe_id, last_lat, last_lon FROM drones WHERE id = ? AND org_id = ?',
        id,
        orgId,
      );
      if (!row) throw notFound('Drone');
      const st = this.deps.hub.droneState(id);
      if (requireOnline && !st?.online) throw conflict(`${row.name} is offline`);
      const t = st?.telemetry;
      const position = t ? { lat: t.lat, lon: t.lon } : row.last_lat !== null && row.last_lon !== null ? { lat: row.last_lat, lon: row.last_lon } : null;
      if (!position) throw conflict(`${row.name} has no known position`);
      return { id: row.id, name: row.name, position, maxSpeedMs: airframeById(row.airframe_id)?.maxSpeedMs };
    });
  }

  private plan(orgId: string, base: MissionPlan, inputs: SwarmMemberInput[], options: SwarmOptionsDto) {
    try {
      return planSwarm(base, inputs, { ...options, maxAltM: getOrgSettings(this.deps.db, orgId).maxAltitudeM });
    } catch (err) {
      throw badRequest(`Cannot plan the swarm: ${(err as Error).message}`);
    }
  }

  preview(orgId: string, body: { missionId: string; droneIds: string[]; options: SwarmOptionsDto }): SwarmPreviewDto {
    const base = this.loadBase(orgId, body.missionId);
    const r = this.plan(orgId, base.plan, this.memberInputs(orgId, body.droneIds, false), body.options);
    const maxAltitude = getOrgSettings(this.deps.db, orgId).maxAltitudeM;
    return {
      // What uploading would refuse (create checks the same).
      errors: r.members.flatMap((m) => validateMission(m.plan, { maxAltitude }).filter((i) => i.level === 'error').map((i) => `Mission of ${m.name} is not valid: ${i.message}`)),
      members: r.members.map((m) => ({ droneId: m.droneId, name: m.name, slot: m.slot, plan: m.plan, syncPoints: m.syncPoints, distanceM: m.distanceM, durationS: m.durationS })),
      separation: r.separation
        ? { droneA: r.separation.droneA, droneB: r.separation.droneB, t: r.separation.t, distanceM: r.separation.distanceM, horizontalM: r.separation.horizontalM, verticalM: r.separation.verticalM }
        : null,
      durationS: r.durationS,
      warnings: r.warnings,
      airspace: r.members.map((m) => {
        const check = checkMissionAirspace(this.deps.db, this.deps.airspace, orgId, this.deps.hub.flownFromHere(m.droneId, m.plan), { droneId: m.droneId });
        return { droneId: m.droneId, name: m.name, verdict: check?.verdict ?? 'clear', conflicts: check?.conflicts ?? [] };
      }),
    };
  }

  async create(
    orgId: string,
    actor: SwarmActor,
    body: { name?: string; missionId: string; droneIds: string[]; options: SwarmOptionsDto; acceptWarnings?: boolean; acceptAirspaceConflicts?: boolean },
  ): Promise<SwarmDto> {
    const base = this.loadBase(orgId, body.missionId);
    const inputs = this.memberInputs(orgId, body.droneIds, true);
    for (const m of inputs) {
      const st = this.deps.hub.droneState(m.id)!;
      if (st.controller && st.controller.userId !== actor.id) throw conflict(`${m.name} is controlled by ${st.controller.name}`);
      if (this.byDrone.has(m.id)) throw conflict(`${m.name} already belongs to a running swarm operation`);
      if (st.telemetry?.inAir && st.telemetry.mode === 'MISSION') throw conflict(`${m.name} is flying a mission`);
    }
    const r = this.plan(orgId, base.plan, inputs, body.options);
    if (r.warnings.length && !body.acceptWarnings) throw conflict(r.warnings.join(' '));
    const maxAltitude = getOrgSettings(this.deps.db, orgId).maxAltitudeM;
    for (const m of r.members) {
      const err = validateMission(m.plan, { maxAltitude }).find((i) => i.level === 'error');
      if (err) throw badRequest(`Mission of ${m.name} is not valid: ${err.message}`);
    }
    const airspaceAccepted = enforceMissionAirspace(
      this.deps.db,
      { orgId, userId: actor.id, role: actor.role },
      base.id,
      r.members.map((m) => ({ droneId: m.droneId, label: m.name, check: checkMissionAirspace(this.deps.db, this.deps.airspace, orgId, this.deps.hub.flownFromHere(m.droneId, m.plan), { droneId: m.droneId }) })),
      body.acceptAirspaceConflicts,
    );
    const now = nowIso();
    const op: SwarmRt = {
      id: uuid(),
      orgId,
      name: body.name?.trim() || `${base.name} – swarm`,
      baseMissionId: base.id,
      options: body.options,
      state: 'uploading',
      message: null,
      actor,
      members: r.members.map((m) => ({
        droneId: m.droneId,
        name: m.name,
        slot: m.slot,
        missionId: uuid(),
        state: 'uploaded',
        syncPassed: 0,
        syncTotal: m.syncPoints.length,
        seq: 0,
        total: m.plan.items.length,
        message: null,
        syncPoints: m.syncPoints,
        waitingAt: null,
        commandAt: 0,
        airborne: false,
        inAir: false,
        holds: m.syncPoints.flatMap((index, ordinal) => {
          const it = m.plan.items[index];
          return it && it.type === 'loiter' && it.unlimited && it.lat !== undefined && it.lon !== undefined ? [{ index, ordinal, lat: it.lat, lon: it.lon, alt: it.alt ?? m.plan.defaultAlt }] : [];
        }),
        returnAltM: m.returnAltM,
        home: m.plan.home ? { lat: m.plan.home.lat, lon: m.plan.home.lon } : null,
        homewardReady: false,
      })),
      homeward: null,
      createdBy: actor.id,
      createdByName: actor.name,
      createdAt: now,
      updatedAt: now,
    };
    const missionName = (m: MemberRt) => `${base.name} · ${m.name} (swarm)`;
    this.deps.db.tx(() => {
      this.deps.db.run(
        'INSERT INTO swarm_operations (id, org_id, name, base_mission_id, options, members, state, message, created_by, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
        op.id,
        orgId,
        op.name,
        base.id,
        JSON.stringify(op.options),
        JSON.stringify(op.members),
        op.state,
        null,
        actor.id,
        now,
        now,
      );
      op.members.forEach((m, i) => {
        this.deps.db.run(
          'INSERT INTO missions (id, org_id, name, description, plan, created_by, created_at, updated_at, swarm_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
          m.missionId,
          orgId,
          missionName(m),
          `Swarm operation "${op.name}" – ${body.options.mode === 'formation' ? `formation slot ${m.slot + 1}` : `route part ${m.slot + 1}`}`,
          JSON.stringify(r.members[i]!.plan),
          actor.id,
          now,
          now,
          op.id,
        );
      });
    });
    audit(this.deps.db, orgId, actor.id, 'swarm.create', op.id, { name: op.name, drones: op.members.map((m) => m.droneId), options: op.options });
    this.ops.set(op.id, op);
    for (const m of op.members) this.byDrone.set(m.droneId, op.id);
    this.changed(op);

    const results = await Promise.all(
      op.members.map((m, i) =>
        this.deps.hub.uploadMission(orgId, m.droneId, actor, { id: m.missionId!, name: missionName(m), plan: r.members[i]!.plan, pilotId: actor.id, airspaceAccepted }),
      ),
    );
    // Ended while the missions were being uploaded: it stays ended.
    if (FINAL.has(op.state)) return this.dto(op);
    results.forEach((res, i) => {
      const m = op.members[i]!;
      if (res.result === 'accepted' || res.result === 'completed') m.state = 'uploaded';
      else {
        m.state = 'upload_failed';
        m.message = `Upload ${res.result}${res.message ? `: ${res.message}` : ''}`;
      }
    });
    const failed = op.members.filter((m) => m.state === 'upload_failed');
    if (failed.length) this.finish(op, 'failed', `Mission upload failed for ${failed.map((m) => `${m.name} (${m.message})`).join(', ')}`);
    else {
      op.state = 'ready';
      this.changed(op);
    }
    return this.dto(op);
  }

  // =======================================================================================
  // Operator actions
  // =======================================================================================

  async action(orgId: string, swarmId: string, actor: SwarmActor, action: SwarmAction): Promise<SwarmDto> {
    const op = this.ops.get(swarmId);
    if (!op || op.orgId !== orgId) {
      if (this.deps.db.get('SELECT 1 FROM swarm_operations WHERE id = ? AND org_id = ?', swarmId, orgId)) throw conflict('The swarm operation has ended');
      throw notFound('Swarm operation');
    }
    // Refused actions change nothing (neither the acting user nor the audit trail).
    const refusal = ACTION_REFUSAL[action](op.state);
    if (refusal) throw conflict(refusal);
    if (action === 'start') {
      const unavailable = op.members.filter((m) => MEMBER_FINAL.has(m.state) || !this.deps.hub.droneState(m.droneId)?.online);
      if (unavailable.length) throw conflict(`Not every drone is available: ${unavailable.map((m) => `${m.name}${m.message ? ` (${m.message})` : ''}`).join(', ')}`);
    }
    // A drone with no new data (what it is doing is not known) is never set flying with the others.
    if (action === 'start' || action === 'resume') {
      const late = op.members.filter((m) => !MEMBER_FINAL.has(m.state)).map((m) => [m, this.deps.hub.dataLate(m.droneId)] as const).filter(([, why]) => why);
      if (late.length) throw conflict(`Not every drone has new data: ${late.map(([m, why]) => `${m.name} ${why}`).join(', ')} – ${action === 'start' ? 'the take-off' : 'resuming'} waits for it`);
    }
    op.actor = actor;
    audit(this.deps.db, orgId, actor.id, `swarm.${action}`, op.id, {});
    const active = () => op.members.filter((m) => !MEMBER_FINAL.has(m.state));
    switch (action) {
      case 'start': {
        op.state = 'running';
        // Synchronised take-off: every drone gets the start command at the same moment.
        const ok = await Promise.all(op.members.map((m) => this.command(op, m, 'mission_start', 'flying')));
        op.members.forEach((m, i) => {
          if (!ok[i]) this.detach(op, m, m.message ?? 'Start refused');
        });
        if (!ok.some(Boolean)) this.finish(op, 'failed', 'No drone started the mission');
        else
          this.deps.notifications.create(orgId, {
            level: 'info',
            category: 'swarm',
            code: 'swarm_started',
            title: 'Swarm operation started',
            message: `"${op.name}" took off with ${ok.filter(Boolean).length} drones (${op.options.mode === 'formation' ? `${op.options.pattern ?? 'line'} formation` : 'split route'}).`,
            data: { swarmId: op.id },
          });
        break;
      }
      case 'pause': {
        if (op.state !== 'running') throw conflict(`The operation cannot pause while ${op.state}`);
        op.state = 'paused';
        await Promise.all(
          active()
            .filter((m) => m.state === 'flying')
            .map(async (m) => {
              if (!(await this.command(op, m, 'mission_pause', 'paused'))) this.detach(op, m, m.message ?? 'Pause refused');
            }),
        );
        break;
      }
      case 'resume': {
        if (op.state !== 'paused') throw conflict(`The operation cannot resume while ${op.state}`);
        op.state = 'running';
        const minPassed = Math.min(...active().map((m) => m.syncPassed));
        await Promise.all(
          active()
            .filter((m) => m.state === 'paused')
            .map(async (m) => {
              // A drone that passed a sync point during the pause keeps waiting for the others.
              if (m.syncPassed > minPassed) {
                m.state = 'waiting';
                m.waitingAt = m.syncPassed - 1;
                return;
              }
              if (!(await this.command(op, m, 'mission_resume', 'flying'))) this.detach(op, m, m.message ?? 'Resume refused');
            }),
        );
        this.evaluate(op);
        break;
      }
      case 'rtl': {
        if (op.state !== 'running' && op.state !== 'paused') throw conflict(`Not possible while the operation is ${op.state}`);
        // Home on separated altitudes, like the planned way home: each drone climbs (or descends)
        // on the spot to its own return altitude, they fly home once all are there and land once
        // all are above their homes – crossing ways home stay vertically separated.
        op.state = 'returning';
        op.homeward = 'climb';
        op.message = 'Climbing to separate return altitudes';
        await Promise.all(
          active().map(async (m) => {
            m.waitingAt = null;
            m.homewardReady = false;
            const t = this.deps.hub.droneState(m.droneId)?.telemetry;
            // A drone on the ground has nothing to return from.
            if (!t?.inAir) {
              m.state = 'done';
              return;
            }
            const alt = m.returnAltM ?? t.altRel;
            if (!(await this.command(op, m, 'goto', 'returning', { lat: t.lat, lon: t.lon, alt }))) this.detach(op, m, m.message ?? 'Return refused');
          }),
        );
        break;
      }
      case 'land': {
        if (op.state !== 'running' && op.state !== 'paused' && op.state !== 'returning') throw conflict(`Not possible while the operation is ${op.state}`);
        op.state = 'returning';
        op.homeward = null;
        op.message = 'Landing where they are';
        await Promise.all(
          active().map(async (m) => {
            m.waitingAt = null;
            if (!(await this.command(op, m, 'land', 'returning'))) {
              // A drone on the ground has nothing to land.
              if (!this.deps.hub.droneState(m.droneId)?.telemetry?.inAir) m.state = 'done';
              else this.detach(op, m, m.message ?? 'LAND refused');
            }
          }),
        );
        break;
      }
      case 'end': {
        if (FINAL.has(op.state)) throw conflict('The swarm operation has ended');
        // Drones held at a barrier continue their missions on their own – one with no new data
        // holds where it is (see `command`).
        const held: string[] = [];
        await Promise.all(
          op.members
            .filter((m) => m.state === 'waiting')
            .map(async (m) => {
              if (!(await this.command(op, m, 'mission_resume', 'flying')) && this.deps.hub.dataLate(m.droneId)) held.push(m.name);
            }),
        );
        // On their way home step by step ("Return all"): each finishes it by itself (RTL).
        if (op.state === 'returning' && op.homeward && op.homeward !== 'land') {
          op.homeward = null;
          await Promise.all(op.members.filter((m) => m.state === 'returning').map((m) => this.command(op, m, 'rtl', 'returning')));
        }
        const allDone = op.members.every((m) => m.state === 'done');
        const one = held.length === 1;
        this.finish(op, allDone ? 'completed' : 'aborted', `Ended by ${actor.name}${held.length ? ` – ${held.join(', ')} ${one ? 'has' : 'have'} no new data and ${one ? 'holds where it is' : 'hold where they are'}` : ''}`);
        return this.dto(op);
      }
    }
    this.changed(op);
    return this.dto(op);
  }

  /**
   * Sends a command to one member as the acting user; sets the expected state first. One that would
   * set it moving is not sent while the member has no new data (what it is doing is not known): it
   * is held where it is instead – the callers let it go from its operation.
   */
  private async command(
    op: SwarmRt,
    m: MemberRt,
    command: 'mission_start' | 'mission_pause' | 'mission_resume' | 'goto' | 'land' | 'rtl',
    next: SwarmMemberState,
    params: { lat?: number; lon?: number; alt?: number } = {},
  ): Promise<boolean> {
    if ((MOVING_COMMANDS as readonly string[]).includes(command)) {
      const late = this.deps.hub.dataLate(m.droneId);
      if (late) {
        m.message = `${m.name} ${late} – what it is doing is not known: held where it is instead of "${command.replace(/_/g, ' ')}"`;
        void this.deps.hub.sendCommand(op.orgId, m.droneId, op.actor, 'hold', {}, null, { audit: false, swarm: true });
        return false;
      }
    }
    const prev = m.state;
    m.state = next;
    m.commandAt = Date.now();
    // Swarm actions are audited as such (swarm.start, swarm.pause …), not every member command.
    const r = await this.deps.hub.sendCommand(op.orgId, m.droneId, op.actor, command, params, null, { audit: false, swarm: true });
    const ok = r.result === 'accepted' || r.result === 'completed' || r.result === 'in_progress';
    if (!ok) {
      if (m.state === next) m.state = prev;
      m.message = `${command.replace('_', ' ')} ${r.result}${r.message ? `: ${r.message}` : ''}`;
    }
    return ok;
  }

  // =======================================================================================
  // Synchronisation
  // =======================================================================================

  /**
   * Commands sent to a member by a user (not by its operation). Whatever would set it flying the
   * operation's mission on its own – start, resume, MISSION mode – is refused: it would leave its
   * barrier while the others still climb or fly below its way. Any other flight command (hold,
   * land, return, reposition …) is the user taking the drone over: it leaves the operation first,
   * so that the others no longer wait for it and the operation no longer commands it.
   */
  private guardCommand(droneId: string, user: { id: string; name: string }, command: string, params: { mode?: string }): string | null {
    const op = this.opOf(droneId);
    const m = op?.members.find((x) => x.droneId === droneId);
    if (!op || !m || MEMBER_FINAL.has(m.state) || FINAL.has(op.state) || op.state === 'uploading') return null;
    if (command === 'camera_photo') return null;
    const fliesMission = command === 'mission_start' || command === 'mission_resume' || (command === 'set_mode' && String(params.mode ?? '').toUpperCase() === 'MISSION');
    if (fliesMission) {
      return `${m.name} flies in the swarm operation "${op.name}" – use the operation's controls (Pause all, Resume all, Return all, Land all) or end the operation first`;
    }
    void user;
    return null;
  }

  /** A command of a user the member accepted (see `guardCommand`): it is out of the operation. */
  private onCommanded(droneId: string, user: { id: string; name: string }, command: string): void {
    if (command === 'camera_photo') return;
    const op = this.opOf(droneId);
    const m = op?.members.find((x) => x.droneId === droneId);
    if (!op || !m || MEMBER_FINAL.has(m.state) || FINAL.has(op.state) || op.state === 'uploading') return;
    this.detach(op, m, `${user.name} sent "${command.replace(/_/g, ' ')}" to it`);
  }

  /** True when both drones belong to the same running operation. */
  sameOperation(a: string, b: string): boolean {
    const x = this.byDrone.get(a);
    return !!x && x === this.byDrone.get(b);
  }

  /** The running operation a drone belongs to (its mission is the operation's). */
  operationOf(droneId: string): { id: string; name: string } | null {
    const op = this.opOf(droneId);
    return op ? { id: op.id, name: op.name } : null;
  }

  private opOf(droneId: string): SwarmRt | null {
    const id = this.byDrone.get(droneId);
    return id ? (this.ops.get(id) ?? null) : null;
  }

  private onProgress(droneId: string, seq: number, total: number): void {
    const rel = this.released.get(droneId);
    if (rel) {
      // Another mission was loaded since: its items are not the operation's.
      if (total !== rel.total) this.released.delete(droneId);
      else rel.seq = seq;
    }
    const op = this.opOf(droneId);
    const m = op?.members.find((x) => x.droneId === droneId);
    if (!op || !m) return;
    m.seq = seq;
    m.total = total;
    m.syncPassed = Math.max(m.syncPassed, m.syncPoints.filter((s) => s < seq).length);
    this.evaluate(op);
    this.changed(op);
  }

  /** Holds drones that are ahead of a barrier and releases those whose barrier everyone passed. */
  private evaluate(op: SwarmRt): void {
    if (op.state !== 'running' && op.state !== 'paused') return;
    const active = op.members.filter((m) => !MEMBER_FINAL.has(m.state));
    if (!active.length) return;
    const minPassed = Math.min(...active.map((m) => m.syncPassed));
    for (const m of active) {
      if (m.state !== 'flying' || m.syncPassed <= minPassed || m.syncPassed === 0) continue;
      m.waitingAt = m.syncPassed - 1;
      void this.command(op, m, 'mission_pause', 'waiting').then((ok) => {
        if (!ok && !MEMBER_FINAL.has(m.state)) this.detach(op, m, m.message ?? 'Hold refused');
        this.changed(op);
      });
    }
    for (const m of active) {
      if (m.state !== 'waiting' || m.waitingAt === null || minPassed < m.waitingAt + 1) continue;
      m.waitingAt = null;
      if (op.state === 'paused') {
        m.state = 'paused';
        continue;
      }
      void this.command(op, m, 'mission_resume', 'flying').then((ok) => {
        if (!ok && !MEMBER_FINAL.has(m.state)) this.detach(op, m, m.message ?? 'Resume refused');
        this.changed(op);
      });
    }
  }

  private onTelemetry(droneId: string, t: Telemetry): void {
    const rel = this.released.get(droneId);
    if (rel) this.releaseHold(droneId, rel, t);
    const op = this.opOf(droneId);
    const m = op?.members.find((x) => x.droneId === droneId);
    if (!op || !m || MEMBER_FINAL.has(m.state)) return;
    m.inAir = t.inAir;
    if (t.inAir) m.airborne = true;
    if (op.state !== 'running' && op.state !== 'paused' && op.state !== 'returning') return;
    if (m.airborne && !t.inAir && !t.armed) {
      m.state = 'done';
      m.waitingAt = null;
      this.evaluate(op);
      this.changed(op);
      return;
    }
    // Touching down (still armed): nothing to judge.
    if (!t.inAir) return;
    if (op.state === 'returning') {
      if (op.homeward) this.homewardProgress(op, m, t);
      return;
    }
    // Arrival at a hold (the drone loiters there by itself until released).
    const hold = m.state === 'flying' ? m.holds.find((h) => h.index === m.seq) : undefined;
    if (hold && haversineDistance(t, hold) < 3 && Math.abs(t.altRel - hold.alt) < 2) {
      m.syncPassed = Math.max(m.syncPassed, hold.ordinal + 1);
      m.state = 'waiting';
      m.waitingAt = hold.ordinal;
      this.evaluate(op);
      this.changed(op);
      return;
    }
    if (Date.now() - m.commandAt < MODE_GRACE_MS) return;
    // Waiting drones hold in HOLD mode, or in MISSION mode at a loiter of their own.
    const expected = m.state === 'flying' ? ['MISSION', 'TAKEOFF'] : m.holds.some((h) => h.index === m.seq) ? ['HOLD', 'MISSION'] : ['HOLD'];
    // Mission finished (hold at the end) or returning by the mission's own RTL item.
    if (m.seq >= m.total && ['HOLD', 'RTL', 'LAND'].includes(t.mode)) return;
    if (m.state === 'flying' && (t.mode === 'RTL' || t.mode === 'LAND') && m.syncPassed >= m.syncTotal && m.seq >= m.total - 1) return;
    if (!expected.includes(t.mode)) this.detach(op, m, `Switched to ${t.mode} mode`);
  }

  /**
   * "Return all home": notes the members that reached the current step and starts the next one
   * when every member still taking part has. A member that switches to a mode of its own (a
   * failsafe, a pilot) leaves the operation and is no longer commanded.
   */
  private homewardProgress(op: SwarmRt, m: MemberRt, t: Telemetry): void {
    if (m.state !== 'returning' || !op.homeward) return;
    const alt = m.returnAltM ?? t.altRel;
    const settled = Date.now() - m.commandAt >= MODE_GRACE_MS;
    const expected = op.homeward === 'land' ? ['LAND'] : ['GUIDED', 'HOLD'];
    if (settled && !expected.includes(t.mode)) {
      this.detach(op, m, `Switched to ${t.mode} mode`);
      return;
    }
    if (op.homeward === 'land') return;
    const home = m.home ?? t;
    if (!m.homewardReady) m.homewardReady = op.homeward === 'climb' ? Math.abs(t.altRel - alt) < 1.5 : haversineDistance(t, home) < 3 && Math.abs(t.altRel - alt) < 1.5;
    this.homewardNext(op);
  }

  /** Starts the next step of "return all home" once every member still taking part is ready. */
  private homewardNext(op: SwarmRt): void {
    if (op.state !== 'returning' || !op.homeward || op.homeward === 'land') return;
    const going = op.members.filter((x) => x.state === 'returning');
    if (!going.length || !going.every((x) => x.homewardReady)) return;
    const next: HomewardStep = op.homeward === 'climb' ? 'home' : 'land';
    op.homeward = next;
    op.message = next === 'home' ? 'Flying home, each drone at its own altitude' : 'Landing';
    for (const x of going) {
      x.homewardReady = false;
      const target = x.home ?? this.deps.hub.droneState(x.droneId)?.telemetry ?? null;
      const sent = next === 'land' ? this.command(op, x, 'land', 'returning') : target ? this.command(op, x, 'goto', 'returning', { lat: target.lat, lon: target.lon, alt: x.returnAltM ?? undefined }) : Promise.resolve(false);
      void sent.then((ok) => {
        if (!ok && !MEMBER_FINAL.has(x.state)) this.detach(op, x, x.message ?? (next === 'land' ? 'LAND refused' : 'Return refused'));
        this.changed(op);
      });
    }
    this.changed(op);
  }

  /** A drone that left its operation reached one of the operation's holds: on it goes. */
  private releaseHold(droneId: string, rel: NonNullable<ReturnType<SwarmService['released']['get']>>, t: Telemetry): void {
    // Landed, or flying in an operation again (as an active member – a detached one is on its own).
    const op = this.opOf(droneId);
    const member = op?.members.find((x) => x.droneId === droneId);
    if ((!t.inAir && !t.armed) || (member && !MEMBER_FINAL.has(member.state))) {
      this.released.delete(droneId);
      return;
    }
    if (rel.pending || t.mode !== 'MISSION') return;
    // Where the drone is in its mission: as it says now (also after its link was lost), else as
    // last heard.
    const live = this.deps.hub.droneState(droneId)?.mission;
    const seq = live && live.total === rel.total ? live.seq : rel.seq;
    const hold = rel.holds.find((h) => h.index === seq);
    if (!hold || haversineDistance(t, hold) >= 3 || Math.abs(t.altRel - hold.alt) >= 2) return;
    // What it sent is old (its uplink is slow): on it goes once it is new.
    if (this.deps.hub.dataLate(droneId)) return;
    rel.pending = true;
    void this.deps.hub
      .sendCommand(rel.orgId, droneId, rel.actor, 'mission_resume', {}, null, { audit: false, swarm: true })
      .finally(() => (rel.pending = false));
  }

  /** Remembers a member leaving its operation in the air, for its holds ahead to be released. */
  private release(op: SwarmRt, m: MemberRt): void {
    // Entries of drones never heard of again do not pile up.
    for (const [id, r] of this.released) if (Date.now() - r.at > 12 * 3_600_000) this.released.delete(id);
    // In the air: by its telemetry, or – its link just lost, the connection gone – by the last of it.
    const inAir = this.deps.hub.droneState(m.droneId)?.telemetry?.inAir ?? m.inAir;
    if (!m.holds.some((h) => h.index >= m.seq) || !inAir) return;
    this.released.set(m.droneId, { orgId: op.orgId, actor: op.actor, holds: m.holds, seq: m.seq, total: m.total, pending: false, at: Date.now() });
  }

  private detachDrone(droneId: string, reason: string): void {
    const op = this.opOf(droneId);
    const m = op?.members.find((x) => x.droneId === droneId);
    if (op && m) this.detach(op, m, reason);
  }

  private detach(op: SwarmRt, m: MemberRt, reason: string): void {
    if (MEMBER_FINAL.has(m.state) || FINAL.has(op.state)) return;
    m.state = 'detached';
    m.waitingAt = null;
    m.message = reason;
    this.release(op, m);
    if (op.state !== 'ready' && op.state !== 'uploading') {
      this.deps.notifications.create(op.orgId, {
        level: 'warning',
        category: 'swarm',
        code: 'swarm_member_detached',
        droneId: m.droneId,
        title: 'Drone left the swarm',
        message: `${m.name} left "${op.name}": ${reason}. The other drones continue without waiting for it.`,
        data: { swarmId: op.id },
      });
    }
    this.evaluate(op);
    this.homewardNext(op);
    this.changed(op);
  }

  private finish(op: SwarmRt, state: SwarmState, message: string): void {
    op.state = state;
    op.message = message;
    for (const m of op.members) if (!MEMBER_FINAL.has(m.state)) this.release(op, m);
    for (const m of op.members) if (this.byDrone.get(m.droneId) === op.id) this.byDrone.delete(m.droneId);
    this.ops.delete(op.id);
    if (state !== 'aborted' || op.members.some((m) => m.airborne)) {
      this.deps.notifications.create(op.orgId, {
        level: state === 'completed' ? 'info' : 'warning',
        category: 'swarm',
        code: `swarm_${state}`,
        title: `Swarm operation ${state}`,
        message: `"${op.name}": ${message}.`,
        data: { swarmId: op.id },
      });
    }
    this.changed(op);
  }

  private lastPublishedState = new Map<string, SwarmState>();

  /** Persists and pushes the operation; completes it when every drone is done or detached. */
  private changed(op: SwarmRt): void {
    if (!FINAL.has(op.state) && op.state !== 'uploading' && op.state !== 'ready' && op.members.every((m) => MEMBER_FINAL.has(m.state))) {
      const done = op.members.filter((m) => m.state === 'done').length;
      this.finish(op, done ? 'completed' : 'failed', done ? `${done} of ${op.members.length} drones completed the operation` : 'No drone completed the operation');
      return;
    }
    op.updatedAt = nowIso();
    this.deps.db.run('UPDATE swarm_operations SET state = ?, message = ?, members = ?, updated_at = ? WHERE id = ?', op.state, op.message, JSON.stringify(op.members), op.updatedAt, op.id);
    const dto = this.dto(op);
    this.deps.hub.broadcast(op.orgId, { type: 'swarm', swarm: dto });
    if (this.lastPublishedState.get(op.id) !== op.state) {
      this.lastPublishedState.set(op.id, op.state);
      this.deps.webhooks.emit(op.orgId, 'swarm.updated', { swarm: dto });
      if (FINAL.has(op.state)) this.lastPublishedState.delete(op.id);
    }
  }

  // =======================================================================================
  // Queries
  // =======================================================================================

  private dto(op: SwarmRt): SwarmDto {
    return {
      id: op.id,
      name: op.name,
      baseMissionId: op.baseMissionId,
      options: op.options,
      state: op.state,
      message: op.message,
      members: op.members.map(memberDto),
      createdBy: op.createdBy,
      createdByName: op.createdByName,
      createdAt: op.createdAt,
      updatedAt: op.updatedAt,
    };
  }

  private rowDto(r: any): SwarmDto {
    const live = this.ops.get(r.id);
    if (live) return this.dto(live);
    return {
      id: r.id,
      name: r.name,
      baseMissionId: r.base_mission_id,
      options: parseJson(r.options, { mode: 'formation' }),
      state: r.state,
      message: r.message,
      members: parseJson<SwarmMemberDto[]>(r.members, []).map(memberDto),
      createdBy: r.created_by,
      createdByName: r.created_by_name ?? null,
      createdAt: r.created_at,
      updatedAt: r.updated_at,
    };
  }

  list(orgId: string, limit = 20): SwarmDto[] {
    return this.deps.db
      .all(`SELECT s.*, u.name AS created_by_name FROM swarm_operations s LEFT JOIN users u ON u.id = s.created_by WHERE s.org_id = ? ORDER BY s.created_at DESC LIMIT ?`, orgId, limit)
      .map((r) => this.rowDto(r));
  }

  get(orgId: string, id: string): SwarmDto {
    const r = this.deps.db.get(`SELECT s.*, u.name AS created_by_name FROM swarm_operations s LEFT JOIN users u ON u.id = s.created_by WHERE s.id = ? AND s.org_id = ?`, id, orgId);
    if (!r) throw notFound('Swarm operation');
    return this.rowDto(r);
  }
}
