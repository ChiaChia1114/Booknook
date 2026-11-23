import type { Db } from '../db/database';
import { pacer } from '../lib/slice';

/** Who owns the data being deleted: one drone (its flights), or a whole organisation. */
export type DeletionScope = { droneId: string } | { orgId: string };

/**
 * Files on disk that go with what is deleted: the flight logs and payload images of its
 * flights (and, for an organisation, its firmware packages). Read before the rows are deleted
 * – the files are removed afterwards.
 */
export function storedFilesOf(db: Db, scope: DeletionScope): string[] {
  const rows =
    'droneId' in scope
      ? [
          ...db.all<{ p: string }>('SELECT ff.storage_path AS p FROM flight_files ff JOIN flights f ON f.id = ff.flight_id WHERE f.drone_id = ?', scope.droneId),
          ...db.all<{ p: string }>('SELECT pi.storage_path AS p FROM payload_images pi JOIN flights f ON f.id = pi.flight_id WHERE f.drone_id = ?', scope.droneId),
        ]
      : [
          ...db.all<{ p: string }>('SELECT storage_path AS p FROM flight_files WHERE org_id = ?', scope.orgId),
          ...db.all<{ p: string }>('SELECT storage_path AS p FROM payload_images WHERE org_id = ?', scope.orgId),
          ...db.all<{ p: string }>('SELECT storage_path AS p FROM firmware_packages WHERE org_id = ?', scope.orgId),
        ];
  return rows.map((r) => r.p);
}

/**
 * Drones whose live flight is still being recorded: in the air, or with a link lost moments ago
 * (the flight closes after the link-loss grace period), or flying when the server restarted.
 */
export function dronesInFlight(db: Db, scope: DeletionScope): string[] {
  const rows =
    'droneId' in scope
      ? db.all<{ name: string }>(
          "SELECT DISTINCT d.name FROM flights f JOIN drones d ON d.id = f.drone_id WHERE f.drone_id = ? AND f.status = 'in_progress' AND f.source = 'live'",
          scope.droneId,
        )
      : db.all<{ name: string }>(
          "SELECT DISTINCT d.name FROM flights f JOIN drones d ON d.id = f.drone_id WHERE f.org_id = ? AND f.status = 'in_progress' AND f.source = 'live' ORDER BY d.name",
          scope.orgId,
        );
  return rows.map((r) => r.name);
}

/** Rows deleted at a time by `clearFlightRows`. */
const CLEAR_BATCH = 1000;

/**
 * Deletes the samples, events and payload records of flights a thousand rows at a time, the
 * event loop getting turns in between. Deleting a long flight – or a drone or an organisation
 * with many – then leaves the flight rows alone to the cascade, which is quick: a large delete
 * in one statement would stall every other request meanwhile.
 */
export async function clearFlightRows(db: Db, flightIds: string[]): Promise<void> {
  const pace = pacer();
  for (const id of flightIds) {
    for (const table of ['flight_samples', 'flight_events', 'payload_records'] as const) {
      while (db.run(`DELETE FROM ${table} WHERE rowid IN (SELECT rowid FROM ${table} WHERE flight_id = ? LIMIT ${CLEAR_BATCH})`, id).changes > 0) await pace();
    }
    await pace();
  }
}

/** The flights of a drone or an organisation. */
export function flightsOf(db: Db, scope: DeletionScope): string[] {
  return ('droneId' in scope
    ? db.all<{ id: string }>('SELECT id FROM flights WHERE drone_id = ?', scope.droneId)
    : db.all<{ id: string }>('SELECT id FROM flights WHERE org_id = ?', scope.orgId)
  ).map((r) => r.id);
}
