import type { AirspaceCheckDto, ConflictDto, MissionPlan, Role } from '@athena-sky/shared';
import { can, maxOf, missionPath, missionStats, type Shape } from '@athena-sky/shared';
import type { Db } from '../db/database';
import { audit } from '../lib/audit';
import { HttpError, forbidden } from '../lib/errors';
import { activeReservations } from './airspace-service';
import { checkVolume, verdictOf } from './geometry';
import type { AirspaceService } from './providers';

export interface MissionCheckOptions {
  /** The drone that will fly the mission (flags reservations the organisation holds for its other drones). */
  droneId?: string | null;
  startAt?: Date;
  endAt?: Date;
  /** Half-width of the flight corridor around the path (m). */
  bufferM?: number;
}

/**
 * Checks an operation volume of an organisation against its airspace zones and hazards and the
 * approved reservations of every operator. Another operator's reservation blocks. The
 * organisation's own approved authorisations are its permission to fly there, not a conflict –
 * except one held for a different drone than the one that will fly, which is flagged for review
 * (two of its drones in the same airspace at the same time).
 */
export function checkOrgVolume(
  db: Db,
  airspace: AirspaceService,
  orgId: string,
  shape: Shape,
  floorM: number,
  ceilingM: number,
  window: { from: number; to: number },
  opts: { droneId?: string | null; excludeReservationId?: string; zones?: boolean } = {},
): ConflictDto[] {
  const reservations = activeReservations(db, new Date(window.from).toISOString(), new Date(window.to).toISOString(), opts.excludeReservationId);
  const conflicts = checkVolume(
    shape,
    floorM,
    ceilingM,
    window,
    opts.zones === false ? [] : airspace.zones(orgId),
    reservations.filter((r) => r.orgId !== orgId),
  );
  const droneId = opts.droneId ?? null;
  if (droneId) {
    const ownOtherDrones = reservations.filter((r) => r.orgId === orgId && r.droneId && r.droneId !== droneId);
    for (const c of checkVolume(shape, floorM, ceilingM, window, [], ownOtherDrones)) {
      const r = ownOtherDrones.find((x) => x.id === c.id);
      const ref = r?.reference ?? c.name;
      conflicts.push({ ...c, name: ref, severity: 'review', message: `Overlaps your authorisation ${ref}${r?.droneName ? ` for ${r.droneName}` : ' for another drone'}` });
    }
  }
  // Another operator's private reservation is reported without anything that identifies it.
  const privateIds = new Set(reservations.filter((r) => r.orgId !== orgId && r.isPublic === false).map((r) => r.id));
  const rank = { blocking: 0, review: 1, advisory: 2 } as const;
  return conflicts
    .map((c) => (c.id && privateIds.has(c.id) ? { kind: c.kind, severity: c.severity, name: c.name, message: c.message } : c))
    .sort((a, b) => rank[a.severity] - rank[b.severity]);
}

/**
 * Checks a mission's flight corridor (from take-off, up to its highest point) with
 * `checkOrgVolume`, from now for the mission's estimated duration (×1.5, at least 10 min).
 * Null when the mission has no flight path.
 */
export function checkMissionAirspace(db: Db, airspace: AirspaceService, orgId: string, plan: MissionPlan, opts: MissionCheckOptions = {}): AirspaceCheckDto | null {
  const path = missionPath(plan);
  if (path.length < 2) return null;
  const start = opts.startAt ?? new Date();
  const end = opts.endAt ?? new Date(start.getTime() + Math.max(600, missionStats(plan).estimatedTimeS * 1.5) * 1000);
  const conflicts = checkOrgVolume(db, airspace, orgId, { kind: 'line', line: path, radiusM: opts.bufferM ?? 30 }, 0, maxOf(path.map((p) => p.alt)), { from: start.getTime(), to: end.getTime() }, { droneId: opts.droneId ?? null });
  return { conflicts, verdict: verdictOf(conflicts) };
}

export const blockingMessages = (conflicts: ConflictDto[]) => conflicts.filter((c) => c.severity === 'blocking').map((c) => c.message);

/**
 * Refuses to send missions whose airspace check is blocked (prohibited / restricted / temporary
 * restriction areas, other operators' reservations) unless a member allowed to decide on flight
 * authorisations explicitly accepts the conflicts – which is recorded in the audit log.
 * Returns whether blocked conflicts were overridden.
 */
export function enforceMissionAirspace(
  db: Db,
  actor: { orgId: string; userId: string; role: Role },
  missionId: string,
  checks: { droneId: string; label: string | null; check: AirspaceCheckDto | null }[],
  accept: boolean | undefined,
): boolean {
  const blocked = checks.filter((c): c is { droneId: string; label: string | null; check: AirspaceCheckDto } => c.check?.verdict === 'blocked');
  if (!blocked.length) return false;
  const describe = (c: (typeof blocked)[number]) => `${c.label ? `${c.label}: ` : ''}${blockingMessages(c.check.conflicts).join('; ')}`;
  if (!accept) {
    throw new HttpError(409, 'airspace_blocked', `Airspace check blocked – ${blocked.map(describe).join(' | ')}`, {
      drones: blocked.map((c) => ({ droneId: c.droneId, conflicts: c.check.conflicts })),
    });
  }
  if (!can(actor.role, 'authorization.decide')) {
    throw forbidden('Only an owner or administrator can override a blocked airspace check: it takes both flying the drones and deciding on flight authorisations');
  }
  audit(db, actor.orgId, actor.userId, 'mission.airspace_override', missionId, {
    drones: blocked.map((c) => ({ droneId: c.droneId, conflicts: blockingMessages(c.check.conflicts) })),
  });
  return true;
}
