import type { FastifyInstance } from 'fastify';
import { Readable } from 'node:stream';
import type { AppContext } from '../context';
import { sha256Hex } from '../lib/crypto';
import { badRequest, unauthorized } from '../lib/errors';
import { nowIso, safeFilename, uuid } from '../lib/util';
import { LogFormatError, normalizeLogSteps } from '../flights/ingest';
import { ULogError } from '../flights/ulog';
import { sameFlightAs } from '../flights/flight-service';
import { finalizeFlight } from '../flights/finalize';
import { DuplicateLogError, ImportGoneError, importFlight } from '../flights/import';
import { runSliced } from '../lib/slice';

/**
 * Drone-authenticated HTTP endpoints of the Athena Link protocol.
 * POST /api/v2/link/logs – post-flight sync of the on-board log (raw .ulg/.csv body).
 * The log is attached to the matching live flight, or becomes a new flight record.
 */
export async function registerLinkRoutes(app: FastifyInstance, ctx: AppContext): Promise<void> {
  const { db, storage, config } = ctx;
  await app.register(async (sub) => {
    sub.addContentTypeParser('application/octet-stream', { parseAs: 'buffer', bodyLimit: config.maxUploadMb * 1_048_576 }, (_req, body, done) => done(null, body));
    sub.post<{ Body: Buffer }>(
      '/api/v2/link/logs',
      { schema: { tags: ['link'], summary: 'Drone uploads its on-board flight log (Authorization: Bearer <link key>)' } },
      async (req, reply) => {
        const m = /^Bearer\s+(\S+)$/i.exec(req.headers.authorization ?? '');
        const drone = m ? db.get<{ id: string; org_id: string }>('SELECT id, org_id FROM drones WHERE link_key_hash = ?', sha256Hex(m[1]!)) : undefined;
        if (!drone) throw unauthorized('Invalid drone key');
        if (!Buffer.isBuffer(req.body) || req.body.length === 0) throw badRequest('Empty log');
        const filename = safeFilename(String(req.headers['x-filename'] ?? 'onboard.ulg'));
        const stored = await storage.save('logs', Readable.from([req.body]), config.maxUploadMb * 1_048_576);
        const existingFile = db.get<{ flight_id: string }>('SELECT flight_id FROM flight_files WHERE org_id = ? AND sha256 = ?', drone.org_id, stored.sha256);
        if (existingFile) {
          storage.remove(stored.storagePath);
          return { flightId: existingFile.flight_id, attached: true, duplicate: true };
        }
        let log;
        try {
          // In slices: a long log is read while the server goes on answering.
          log = await runSliced(normalizeLogSteps(req.body, filename));
        } catch (err) {
          storage.remove(stored.storagePath);
          if (err instanceof LogFormatError || err instanceof ULogError) throw badRequest(err.message);
          throw err;
        }
        const kind = log.kind;
        // The flight this log belongs to, when already recorded (live, or from another log of it).
        // A log without its own time base (dated to end now) belongs to the live flight that has
        // just ended (±2 min) – the drone syncs it after landing.
        const known = log.absoluteTime
          ? sameFlightAs(db, drone.id, log.startedAt, log.endedAt)
          : (db.get<{ id: string }>(
              `SELECT id FROM flights WHERE drone_id = ? AND source = 'live'
                 AND started_at <= ? AND COALESCE(ended_at, ?) >= ? ORDER BY started_at DESC LIMIT 1`,
              drone.id,
              new Date(log.endedAt + 120_000).toISOString(),
              nowIso(),
              new Date(log.startedAt - 120_000).toISOString(),
            )?.id ?? null);
        const file = { kind, filename, size: stored.size, sha256: stored.sha256, storagePath: stored.storagePath, uploadedBy: null };
        if (known) {
          const dup = db.tx(() => {
            const again = db.get<{ flight_id: string }>('SELECT flight_id FROM flight_files WHERE org_id = ? AND sha256 = ?', drone.org_id, stored.sha256);
            if (again) return again.flight_id;
            db.run(
              'INSERT INTO flight_files (id, flight_id, org_id, kind, filename, size, sha256, storage_path, uploaded_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL, ?)',
              uuid(),
              known,
              drone.org_id,
              kind,
              filename,
              stored.size,
              stored.sha256,
              stored.storagePath,
              nowIso(),
            );
            return null;
          });
          if (dup) {
            storage.remove(stored.storagePath);
            return { flightId: dup, attached: true, duplicate: true };
          }
          reply.code(201);
          return { flightId: known, attached: true, duplicate: false };
        }
        let flightId: string;
        try {
          flightId = await importFlight(db, storage, { orgId: drone.org_id, droneId: drone.id, pilotId: null, notes: '', log, file });
        } catch (err) {
          if (err instanceof DuplicateLogError) {
            storage.remove(stored.storagePath);
            return { flightId: err.flightId, attached: true, duplicate: true };
          }
          if (err instanceof ImportGoneError) throw unauthorized('Invalid drone key');
          throw err;
        }
        const attached = false;
        // Stored: the parsed log is let go before the flight's samples are read again.
        log.samples = [];
        log.events = [];
        await finalizeFlight(ctx, flightId);
        reply.code(201);
        return { flightId, attached, duplicate: false };
      },
    );
  });
}
