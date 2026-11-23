/**
 * Flights created from imported logs (uploaded by a user, or synced by the drone after landing).
 *
 * A long log is stored without stalling the server: the flight and its file are created first
 * (status `processing`, the file's checksum taken), then its samples and events a transaction of
 * a few hundred rows at a time, and the flight becomes `completed` once all of them are in. A
 * flight still `processing` when the server starts again was cut short: it is removed, with its
 * file, so the log can be imported again.
 */
import type { Db } from '../db/database';
import type { FileStorage } from '../lib/storage';
import { runSliced } from '../lib/slice';
import { nowIso, uuid } from '../lib/util';
import { computeTotalsSteps, type NormalizedLog } from './ingest';
import { insertLogSteps } from './flight-service';
import { clearFlightRows } from './cleanup';

/** The same file is already the log of a flight (imported meanwhile). */
export class DuplicateLogError extends Error {
  constructor(readonly flightId: string) {
    super('This log has already been uploaded');
  }
}

/** The flight was removed (its drone or organisation deleted) while its log was imported. */
export class ImportGoneError extends Error {
  constructor() {
    super('The drone of this log was deleted while the log was imported');
  }
}

export interface ImportedFile {
  kind: NormalizedLog['kind'];
  filename: string;
  size: number;
  sha256: string;
  storagePath: string;
  uploadedBy: string | null;
}

/** Creates the flight of an imported log; returns its id (see the module comment). */
export async function importFlight(
  db: Db,
  storage: FileStorage,
  input: { orgId: string; droneId: string; pilotId: string | null; notes: string; log: NormalizedLog; file: ImportedFile },
): Promise<string> {
  const { log, file } = input;
  const totals = await runSliced(computeTotalsSteps(log.samples));
  const first = log.samples[0]!;
  const last = log.samples[log.samples.length - 1]!;
  const flightId = uuid();
  const insertFlight = (): void => {
    db.run(
      `INSERT INTO flights (id, org_id, drone_id, pilot_id, source, status, started_at, ended_at, duration_s, distance_m, max_alt_m, max_speed_ms,
                            battery_start, battery_end, start_lat, start_lon, end_lat, end_lon, takeoff_alt_msl, notes, created_at)
       VALUES (?, ?, ?, ?, 'upload', 'processing', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      flightId,
      input.orgId,
      input.droneId,
      input.pilotId,
      new Date(log.startedAt).toISOString(),
      new Date(log.endedAt).toISOString(),
      totals.durationS,
      totals.distanceM,
      totals.maxAltM,
      totals.maxSpeedMs,
      totals.batteryStart,
      totals.batteryEnd,
      first.lat,
      first.lon,
      last.lat,
      last.lon,
      first.altMsl - first.altRel,
      input.notes.slice(0, 5000),
      nowIso(),
    );
    db.run(
      'INSERT INTO flight_files (id, flight_id, org_id, kind, filename, size, sha256, storage_path, uploaded_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
      uuid(),
      flightId,
      input.orgId,
      file.kind,
      file.filename,
      file.size,
      file.sha256,
      file.storagePath,
      file.uploadedBy,
      nowIso(),
    );
  };
  try {
    db.tx(() => {
      // Checked again here: the same file may have been imported, or the drone deleted, while
      // this one was read.
      const dup = db.get<{ flight_id: string }>('SELECT flight_id FROM flight_files WHERE org_id = ? AND sha256 = ?', input.orgId, file.sha256);
      if (dup) throw new DuplicateLogError(dup.flight_id);
      if (!db.get('SELECT 1 FROM drones WHERE id = ? AND org_id = ?', input.droneId, input.orgId)) throw new ImportGoneError();
      insertFlight();
    });
  } catch (err) {
    if (err instanceof ImportGoneError) storage.remove(file.storagePath);
    throw err;
  }
  try {
    await runSliced(insertLogSteps(db, flightId, log.samples, log.events));
    if (db.run("UPDATE flights SET status = 'completed' WHERE id = ? AND status = 'processing'", flightId).changes === 0) throw new ImportGoneError();
  } catch (err) {
    // Nothing of a partial import is kept – the log can be imported again.
    const gone = !db.get('SELECT 1 FROM flights WHERE id = ?', flightId);
    await clearFlightRows(db, [flightId]);
    db.run('DELETE FROM flights WHERE id = ?', flightId);
    storage.remove(file.storagePath);
    throw gone ? new ImportGoneError() : err;
  }
  return flightId;
}

/** Removes the flights whose import was cut short (the server stopped meanwhile), with their files. */
export function discardInterruptedImports(db: Db, storage: FileStorage): number {
  const rows = db.all<{ id: string }>("SELECT id FROM flights WHERE status = 'processing'");
  for (const { id } of rows) {
    const files = db.all<{ storage_path: string }>('SELECT storage_path FROM flight_files WHERE flight_id = ?', id);
    db.run('DELETE FROM flights WHERE id = ?', id);
    for (const f of files) storage.remove(f.storage_path);
  }
  return rows.length;
}
