import type { AirspaceCheckDto, ConflictDto, MissionPlan, Role } from '@athena-sky/shared';
import { can, maxOf, missionPath, missionStats } from '@athena-sky/shared';
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
 * Checks a mission's flight corridor (from take-off, up to its highest point) against the
 * organisation's airspace zones and hazards and the airspace other operators have reserved.
 * The organisation's own approved authorisations are its permission to fly there, not a
 * conflict – except one held for a different drone, which is flagged for review (two of its
 * drones in the same airspace at the same time). Null when the mission has no flight path.
 */
export function checkMissionAirspace(db: Db, airspace: AirspaceService, orgId: string, plan: MissionPlan, opts: MissionCheckOptions = {}): AirspaceCheckDto | null {
  const path = missionPath(plan);
  if (path.length < 2) return null;
  const start = opts.startAt ?? new Date();
  const end = opts.endAt ?? new Date(start.getTime() + Math.max(600, missionStats(plan).estimatedTimeS * 1.5) * 1000);
  const shape = { kind: 'line' as const, line: path, radiusM: opts.bufferM ?? 30 };
  const ceiling = maxOf(path.map((p) => p.alt));
  const window = { from: start.getTime(), to: end.getTime() };
  const reservations = activeReservations(db, start.toISOString(), end.toISOString());
  const conflicts = checkVolume(
    shape,
    0,
    ceiling,
    window,
    airspace.zones(orgId),
    reservations.filter((r) => r.orgId !== orgId),
  );
  const droneId = opts.droneId ?? null;
  if (droneId) {
    const ownOtherDrones = reservations.filter((r) => r.orgId === orgId && r.droneId && r.droneId !== droneId);
    for (const c of checkVolume(shape, 0, ceiling, window, [], ownOtherDrones)) {
      const r = ownOtherDrones.find((x) => x.id === c.id);
      conflicts.push({ ...c, severity: 'review', message: `Overlaps your authorisation ${c.name}${r?.droneName ? ` for ${r.droneName}` : ' for another drone'}` });
    }
  }
  const rank = { blocking: 0, review: 1, advisory: 2 } as const;
  conflicts.sort((a, b) => rank[a.severity] - rank[b.severity]);
  return { conflicts, verdict: verdictOf(conflicts) };
}

export const blockingMessages = (conflicts: ConflictDto[]) => conflicts.filter((c) => c.severity === 'blocking').map((c) => c.message);

/**
 * Refuses to send missions whose airspace check is blocked (prohibited / restricted / temporary
 * restriction areas, other operators' reservations) unless a member allowed to decide on flight
 * authorisations explicitly accepts the conflicts – which is recorded in the audit log.
 */
export function enforceMissionAirspace(
  db: Db,
  actor: { orgId: string; userId: string; role: Role },
  missionId: string,
  checks: { droneId: string; label: string | null; check: AirspaceCheckDto | null }[],
  accept: boolean | undefined,
): void {
  const blocked = checks.filter((c): c is { droneId: string; label: string | null; check: AirspaceCheckDto } => c.check?.verdict === 'blocked');
  if (!blocked.length) return;
  const describe = (c: (typeof blocked)[number]) => `${c.label ? `${c.label}: ` : ''}${blockingMessages(c.check.conflicts).join('; ')}`;
  if (!accept) {
    throw new HttpError(409, 'airspace_blocked', `Airspace check blocked – ${blocked.map(describe).join(' | ')}`, {
      drones: blocked.map((c) => ({ droneId: c.droneId, conflicts: c.check.conflicts })),
    });
  }
  if (!can(actor.role, 'authorization.decide')) {
    throw forbidden('Only a mission manager or administrator can override a blocked airspace check');
  }
  audit(db, actor.orgId, actor.userId, 'mission.airspace_override', missionId, {
    drones: blocked.map((c) => ({ droneId: c.droneId, conflicts: blockingMessages(c.check.conflicts) })),
  });
}
