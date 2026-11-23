import type { FastifyInstance } from 'fastify';
import { Readable } from 'node:stream';
import type { AppContext } from '../context';
import { sha256Hex } from '../lib/crypto';
import { badRequest, unauthorized } from '../lib/errors';
import { nowIso, safeFilename, uuid } from '../lib/util';
import { LogFormatError, computeTotals, normalizeLog } from '../flights/ingest';
import { ULogError } from '../flights/ulog';
import { insertSamples, sameFlightAs } from '../flights/flight-service';
import { finalizeFlight } from '../flights/finalize';

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
          log = normalizeLog(req.body, filename);
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
        let flightId: string;
        let attached = false;
        if (known) {
          flightId = known;
          attached = true;
        } else {
          flightId = uuid();
          const totals = computeTotals(log.samples);
          const first = log.samples[0]!;
          const last = log.samples[log.samples.length - 1]!;
          db.tx(() => {
            db.run(
              `INSERT INTO flights (id, org_id, drone_id, source, status, started_at, ended_at, duration_s, distance_m, max_alt_m, max_speed_ms,
                                    battery_start, battery_end, start_lat, start_lon, end_lat, end_lon, takeoff_alt_msl, created_at)
               VALUES (?, ?, ?, 'upload', 'completed', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
              flightId,
              drone.org_id,
              drone.id,
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
              nowIso(),
            );
            insertSamples(db, flightId, log.samples);
            for (const e of log.events) db.run('INSERT INTO flight_events (flight_id, t, level, code, message) VALUES (?, ?, ?, ?, ?)', flightId, e.t, e.level, e.code, e.message);
          });
        }
        db.run(
          'INSERT INTO flight_files (id, flight_id, org_id, kind, filename, size, sha256, storage_path, uploaded_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL, ?)',
          uuid(),
          flightId,
          drone.org_id,
          kind,
          filename,
          stored.size,
          stored.sha256,
          stored.storagePath,
          nowIso(),
        );
        if (!attached) await finalizeFlight(ctx, flightId);
        reply.code(201);
        return { flightId, attached, duplicate: false };
      },
    );
  });
}
