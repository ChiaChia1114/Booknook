import type { AirspaceZoneDto, AuthorizationDto, PublicReservationDto, ZoneType } from '@athena-sky/shared';
import type { Db } from '../db/database';
import { parseJson } from '../db/database';
import type { ReservationLike } from './geometry';

export function zoneDto(r: any): AirspaceZoneDto {
  return {
    id: r.id,
    name: r.name,
    type: r.type as ZoneType,
    geometry: parseJson(r.geometry, { kind: 'polygon', polygon: [] }),
    floorM: r.floor_m,
    ceilingM: r.ceiling_m,
    activeFrom: r.active_from,
    activeTo: r.active_to,
    source: r.source,
    notes: r.notes,
    createdAt: r.created_at,
    readOnly: false,
  };
}

/** Zones stored for an organisation (the built-in provider – see providers.ts). */
export function listZones(db: Db, orgId: string): AirspaceZoneDto[] {
  return db.all('SELECT * FROM airspace_zones WHERE org_id = ? ORDER BY name', orgId).map(zoneDto);
}

export const AUTH_SELECT = `SELECT a.*, d.name AS drone_name, u.name AS requester_name, du.name AS decider_name, cu.name AS canceller_name, o.name AS org_name
  FROM authorizations a
  LEFT JOIN drones d ON d.id = a.drone_id
  LEFT JOIN users u ON u.id = a.requested_by
  LEFT JOIN users du ON du.id = a.decided_by
  LEFT JOIN users cu ON cu.id = a.cancelled_by
  JOIN organisations o ON o.id = a.org_id`;

export function authorizationDto(r: any): AuthorizationDto {
  return {
    id: r.id,
    reference: r.reference,
    geometry: parseJson(r.geometry, { kind: 'cylinder', center: { lat: 0, lon: 0 }, radiusM: 0 }),
    maxAltM: r.max_alt_m,
    startAt: r.start_at,
    endAt: r.end_at,
    status: r.status,
    droneId: r.drone_id,
    droneName: r.drone_name ?? null,
    missionId: r.mission_id,
    requestedBy: r.requested_by,
    requesterName: r.requester_name ?? null,
    conflicts: parseJson(r.conflicts, []),
    decisionReason: r.decision_reason,
    decidedBy: r.decided_by,
    deciderName: r.decider_name ?? null,
    decidedAt: r.decided_at,
    approvedAt: r.approved_at ?? null,
    cancelledAt: r.cancelled_at ?? null,
    cancelledBy: r.cancelled_by ?? null,
    cancellerName: r.canceller_name ?? null,
    cancelReason: r.cancel_reason ?? null,
    isPublic: r.is_public === 1,
    createdAt: r.created_at,
    authority: r.authority ?? null,
    authorityRef: r.authority_ref ?? null,
    authorityUrl: r.authority_url ?? null,
    authorityState: r.authority_state ?? null,
    authorityError: r.authority_error ?? null,
  };
}

/**
 * Approved reservations from every organisation overlapping a window – airspace is
 * shared, so a reservation by one operator blocks overlapping requests by others.
 */
export function activeReservations(db: Db, from: string, to: string, excludeId?: string): ReservationLike[] {
  return db
    .all<any>(`${AUTH_SELECT} WHERE a.status = 'approved' AND a.start_at <= ? AND a.end_at >= ?`, to, from)
    .filter((r) => r.id !== excludeId)
    .map((r) => ({
      id: r.id,
      orgId: r.org_id,
      droneId: r.drone_id ?? null,
      droneName: r.drone_name ?? null,
      isPublic: r.is_public === 1,
      reference: r.reference,
      geometry: parseJson(r.geometry, { kind: 'cylinder', center: { lat: 0, lon: 0 }, radiusM: 0 }),
      maxAltM: r.max_alt_m,
      startAt: r.start_at,
      endAt: r.end_at,
      operator: r.org_name,
    }));
}

export function publicReservations(db: Db, from: string, to: string): PublicReservationDto[] {
  return db
    .all<any>(`${AUTH_SELECT} WHERE a.status = 'approved' AND a.is_public = 1 AND a.start_at <= ? AND a.end_at >= ? ORDER BY a.start_at`, to, from)
    .map((r) => ({
      reference: r.reference,
      operator: r.org_name,
      geometry: parseJson(r.geometry, { kind: 'cylinder', center: { lat: 0, lon: 0 }, radiusM: 0 }),
      maxAltM: r.max_alt_m,
      startAt: r.start_at,
      endAt: r.end_at,
    }));
}
