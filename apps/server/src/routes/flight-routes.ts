import type { FastifyInstance } from 'fastify';
import { readFileSync } from 'node:fs';
import { Type, type Static } from '@sinclair/typebox';
import type { FlightFileDto, FlightSampleDto, LogTopicDto, PayloadImageDto, PayloadRecordDto } from '@athena-sky/shared';
import { can, interpolateLatLon } from '@athena-sky/shared';
import type { AppContext } from '../context';
import { orgAccess } from '../auth/auth';
import { parseJson } from '../db/database';
import { audit } from '../lib/audit';
import { badRequest, conflict, notFound } from '../lib/errors';
import { readMultipart } from '../lib/multipart';
import { clampInt, nowIso, resolveRange, uuid } from '../lib/util';
import { toCsv, toGpx, toJsonExport, toKml } from '../flights/export';
import { FLIGHT_SELECT, analysisDto, flightDto, getFlight, insertSamples, loadEvents, loadSamples, runAnalysis } from '../flights/flight-service';
import { LogFormatError, computeTotals, normalizeLog } from '../flights/ingest';
import { finalizeFlight } from '../flights/finalize';
import { isULog, parseULog, ULogError } from '../flights/ulog';

const OrgParams = Type.Object({ orgId: Type.String({ format: 'uuid' }) });
const FlightParams = Type.Object({ orgId: Type.String({ format: 'uuid' }), flightId: Type.String({ format: 'uuid' }) });
type FlightP = Static<typeof FlightParams>;
const ListQuery = Type.Object({
  from: Type.Optional(Type.String()),
  to: Type.Optional(Type.String()),
  droneId: Type.Optional(Type.String({ format: 'uuid' })),
  pilotId: Type.Optional(Type.String({ format: 'uuid' })),
  fleetId: Type.Optional(Type.String({ format: 'uuid' })),
  status: Type.Optional(Type.Union([Type.Literal('in_progress'), Type.Literal('completed'), Type.Literal('aborted')])),
  limit: Type.Optional(Type.String()),
  offset: Type.Optional(Type.String()),
});
const FlightPatch = Type.Object({
  notes: Type.Optional(Type.String({ maxLength: 5000 })),
  pilotId: Type.Optional(Type.Union([Type.String({ format: 'uuid' }), Type.Null()])),
});

const tag = { tags: ['flight logs'] };

/** Evenly decimates an array to at most n elements (keeps first and last). */
function decimate<T>(arr: T[], n: number): T[] {
  if (arr.length <= n || n < 2) return arr;
  const step = (arr.length - 1) / (n - 1);
  return Array.from({ length: n }, (_, i) => arr[Math.round(i * step)]!);
}

/** Position on the flight track at time t (linear interpolation), or null outside the flight. */
export function positionAt(samples: FlightSampleDto[], t: number, toleranceMs = 10_000): { lat: number; lon: number; altMsl: number } | null {
  if (samples.length === 0 || t < samples[0]!.t - toleranceMs || t > samples[samples.length - 1]!.t + toleranceMs) return null;
  let i = samples.findIndex((s) => s.t >= t);
  if (i <= 0) {
    const s = samples[i === 0 ? 0 : samples.length - 1]!;
    return { lat: s.lat, lon: s.lon, altMsl: s.altMsl };
  }
  const a = samples[i - 1]!;
  const b = samples[i]!;
  const f = b.t === a.t ? 0 : (t - a.t) / (b.t - a.t);
  const p = interpolateLatLon(a, b, f);
  return { lat: p.lat, lon: p.lon, altMsl: a.altMsl + (b.altMsl - a.altMsl) * f };
}

export function registerFlightRoutes(app: FastifyInstance, ctx: AppContext): void {
  const { db, storage, config } = ctx;

  const loadFlight = (orgId: string, flightId: string) => {
    const f = getFlight(db, orgId, flightId);
    if (!f) throw notFound('Flight');
    return f;
  };

  app.get<{ Params: Static<typeof OrgParams>; Querystring: Static<typeof ListQuery> }>(
    '/api/v2/organisations/:orgId/flights',
    { schema: { ...tag, summary: 'Flight history (filter by period, drone, pilot, fleet, status)', params: OrgParams, querystring: ListQuery } },
    async (req) => {
      const a = orgAccess(db, req, req.params.orgId);
      const q = req.query;
      const range = q.from || q.to ? resolveRange(q.from, q.to, 3650) : null;
      const limit = clampInt(q.limit, 50, 1, 500);
      const offset = clampInt(q.offset, 0, 0, 10_000_000);
      const where = `WHERE f.org_id = ? AND (? IS NULL OR f.started_at >= ?) AND (? IS NULL OR f.started_at <= ?)
        AND (? IS NULL OR f.drone_id = ?) AND (? IS NULL OR f.pilot_id = ?) AND (? IS NULL OR d.fleet_id = ?) AND (? IS NULL OR f.status = ?)`;
      const from = range?.from.toISOString() ?? null;
      const to = range?.to.toISOString() ?? null;
      const args = [a.orgId, from, from, to, to, q.droneId ?? null, q.droneId ?? null, q.pilotId ?? null, q.pilotId ?? null, q.fleetId ?? null, q.fleetId ?? null, q.status ?? null, q.status ?? null];
      const total = db.get<{ n: number }>(`SELECT COUNT(*) AS n FROM flights f JOIN drones d ON d.id = f.drone_id ${where}`, ...args)!.n;
      const items = db.all(`${FLIGHT_SELECT} ${where} ORDER BY f.started_at DESC LIMIT ? OFFSET ?`, ...args, limit, offset).map(flightDto);
      return { items, total, limit, offset };
    },
  );

  app.get<{ Params: FlightP }>('/api/v2/organisations/:orgId/flights/:flightId', { schema: { ...tag, params: FlightParams } }, async (req) => {
    const a = orgAccess(db, req, req.params.orgId);
    return loadFlight(a.orgId, req.params.flightId);
  });

  app.patch<{ Params: FlightP; Body: Static<typeof FlightPatch> }>(
    '/api/v2/organisations/:orgId/flights/:flightId',
    { schema: { ...tag, params: FlightParams, body: FlightPatch } },
    async (req) => {
      const a = orgAccess(db, req, req.params.orgId, 'flight.edit');
      const f = loadFlight(a.orgId, req.params.flightId);
      if (req.body.pilotId && !db.get('SELECT 1 FROM memberships WHERE org_id = ? AND user_id = ?', a.orgId, req.body.pilotId)) throw badRequest('Pilot is not a member of this organisation');
      db.run(
        'UPDATE flights SET notes = ?, pilot_id = ? WHERE id = ?',
        req.body.notes ?? f.notes,
        req.body.pilotId === undefined ? f.pilotId : req.body.pilotId,
        f.id,
      );
      audit(db, a.orgId, a.userId, 'flight.update', f.id, req.body as Record<string, unknown>);
      return loadFlight(a.orgId, f.id);
    },
  );

  app.delete<{ Params: FlightP }>('/api/v2/organisations/:orgId/flights/:flightId', { schema: { ...tag, params: FlightParams } }, async (req) => {
    const a = orgAccess(db, req, req.params.orgId, 'flight.edit');
    const f = loadFlight(a.orgId, req.params.flightId);
    if (f.status === 'in_progress') throw conflict('Cannot delete a flight in progress');
    const files = [
      ...db.all<{ storage_path: string }>('SELECT storage_path FROM flight_files WHERE flight_id = ?', f.id),
      ...db.all<{ storage_path: string }>('SELECT storage_path FROM payload_images WHERE flight_id = ?', f.id),
    ];
    db.run('DELETE FROM flights WHERE id = ?', f.id);
    for (const file of files) storage.remove(file.storage_path);
    audit(db, a.orgId, a.userId, 'flight.delete', f.id);
    return { ok: true };
  });

  app.get<{ Params: FlightP; Querystring: { maxPoints?: string } }>(
    '/api/v2/organisations/:orgId/flights/:flightId/samples',
    { schema: { ...tag, summary: 'Telemetry samples of a flight', params: FlightParams } },
    async (req) => {
      const a = orgAccess(db, req, req.params.orgId);
      loadFlight(a.orgId, req.params.flightId);
      return decimate(loadSamples(db, req.params.flightId), clampInt(req.query.maxPoints, 20_000, 2, 100_000));
    },
  );

  app.get<{ Params: FlightP }>('/api/v2/organisations/:orgId/flights/:flightId/events', { schema: { ...tag, params: FlightParams } }, async (req) => {
    const a = orgAccess(db, req, req.params.orgId);
    loadFlight(a.orgId, req.params.flightId);
    return loadEvents(db, req.params.flightId);
  });

  app.get<{ Params: FlightP }>(
    '/api/v2/organisations/:orgId/flights/:flightId/analysis',
    { schema: { ...tag, summary: 'Post-flight AI analysis (health score, findings, metrics)', params: FlightParams } },
    async (req) => {
      const a = orgAccess(db, req, req.params.orgId);
      const f = loadFlight(a.orgId, req.params.flightId);
      const r = db.get('SELECT * FROM flight_analyses WHERE flight_id = ?', f.id);
      if (r) return analysisDto(r);
      if (f.status === 'in_progress') throw conflict('Analysis is available after the flight ends');
      return runAnalysis(db, f.id);
    },
  );

  app.post<{ Params: FlightP }>('/api/v2/organisations/:orgId/flights/:flightId/analysis', { schema: { ...tag, summary: 'Re-run analysis', params: FlightParams } }, async (req) => {
    const a = orgAccess(db, req, req.params.orgId, 'flight.edit');
    const f = loadFlight(a.orgId, req.params.flightId);
    if (f.status === 'in_progress') throw conflict('Analysis is available after the flight ends');
    return runAnalysis(db, f.id);
  });

  app.get<{ Params: FlightP; Querystring: { format?: string } }>(
    '/api/v2/organisations/:orgId/flights/:flightId/export',
    { schema: { ...tag, summary: 'Export the flight log (format=csv|kml|gpx|json)', params: FlightParams } },
    async (req, reply) => {
      const a = orgAccess(db, req, req.params.orgId);
      const f = loadFlight(a.orgId, req.params.flightId);
      const samples = loadSamples(db, f.id);
      const base = `flight-${f.startedAt.slice(0, 19).replace(/[:T]/g, '-')}-${f.id.slice(0, 8)}`;
      const format = req.query.format ?? 'csv';
      const send = (type: string, ext: string, body: string) =>
        reply.header('content-type', type).header('content-disposition', `attachment; filename="${base}.${ext}"`).send(body);
      switch (format) {
        case 'csv':
          return send('text/csv; charset=utf-8', 'csv', toCsv(samples));
        case 'kml':
          return send('application/vnd.google-earth.kml+xml', 'kml', toKml(f, samples));
        case 'gpx':
          return send('application/gpx+xml', 'gpx', toGpx(f, samples));
        case 'json':
          return send('application/json', 'json', toJsonExport(f, samples, loadEvents(db, f.id)));
        default:
          throw badRequest('format must be csv, kml, gpx or json');
      }
    },
  );

  // --- Log upload (post-flight sync) ------------------------------------------------------

  app.post<{ Params: Static<typeof OrgParams> }>(
    '/api/v2/organisations/:orgId/flights/upload',
    {
      schema: {
        ...tag,
        summary: 'Upload a flight log (multipart: file=.ulg/.csv/.json, droneId, pilotId?, notes?)',
        params: OrgParams,
        consumes: ['multipart/form-data'],
      },
    },
    async (req, reply) => {
      const a = orgAccess(db, req, req.params.orgId, 'flight.upload');
      const { fields, files } = await readMultipart(req, storage, 'logs', config.maxUploadMb * 1_048_576);
      const file = files[0];
      const cleanup = () => file && storage.remove(file.stored.storagePath);
      try {
        if (!file) throw badRequest('file is required');
        const drone = db.get<{ id: string }>('SELECT id FROM drones WHERE id = ? AND org_id = ?', fields.droneId ?? '', a.orgId);
        if (!drone) throw badRequest('droneId must reference a drone of this organisation');
        let pilotId: string | null = fields.pilotId || null;
        if (pilotId && !db.get('SELECT 1 FROM memberships WHERE org_id = ? AND user_id = ?', a.orgId, pilotId)) throw badRequest('Pilot is not a member of this organisation');
        if (!pilotId && can(a.role, 'drone.control')) pilotId = a.userId;
        const dup = db.get<{ flight_id: string }>('SELECT flight_id FROM flight_files WHERE org_id = ? AND sha256 = ?', a.orgId, file.stored.sha256);
        if (dup) throw conflict('This log has already been uploaded', { flightId: dup.flight_id });
        const buf = readFileSync(storage.abs(file.stored.storagePath));
        let log;
        try {
          log = normalizeLog(buf, file.filename);
        } catch (err) {
          if (err instanceof LogFormatError || err instanceof ULogError) throw badRequest(err.message);
          throw err;
        }
        const totals = computeTotals(log.samples);
        const first = log.samples[0]!;
        const last = log.samples[log.samples.length - 1]!;
        const flightId = uuid();
        db.tx(() => {
          db.run(
            `INSERT INTO flights (id, org_id, drone_id, pilot_id, source, status, started_at, ended_at, duration_s, distance_m, max_alt_m, max_speed_ms,
                                  battery_start, battery_end, start_lat, start_lon, end_lat, end_lon, takeoff_alt_msl, notes, created_at)
             VALUES (?, ?, ?, ?, 'upload', 'completed', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            flightId,
            a.orgId,
            drone.id,
            pilotId,
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
            (fields.notes ?? '').slice(0, 5000),
            nowIso(),
          );
          insertSamples(db, flightId, log.samples);
          for (const e of log.events) {
            db.run('INSERT INTO flight_events (flight_id, t, level, code, message) VALUES (?, ?, ?, ?, ?)', flightId, e.t, e.level, e.code, e.message);
          }
          db.run(
            'INSERT INTO flight_files (id, flight_id, org_id, kind, filename, size, sha256, storage_path, uploaded_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
            uuid(),
            flightId,
            a.orgId,
            log.kind,
            file.filename,
            file.stored.size,
            file.stored.sha256,
            file.stored.storagePath,
            a.userId,
            nowIso(),
          );
          if (log.vehicle.firmware) {
            db.run('UPDATE drones SET firmware_version = COALESCE(firmware_version, ?) WHERE id = ?', log.vehicle.firmware, drone.id);
          }
        });
        finalizeFlight(ctx, flightId);
        audit(db, a.orgId, a.userId, 'flight.upload', flightId, { filename: file.filename, kind: log.kind, samples: log.samples.length });
        reply.code(201);
        return loadFlight(a.orgId, flightId);
      } catch (err) {
        cleanup();
        throw err;
      }
    },
  );

  // --- Original log files and "plot any field" -----------------------------------------------

  const fileDto = (r: any): FlightFileDto => ({ id: r.id, kind: r.kind, filename: r.filename, size: r.size, sha256: r.sha256, createdAt: r.created_at });
  const loadFile = (orgId: string, flightId: string, fileId: string) => {
    const r = db.get<any>('SELECT * FROM flight_files WHERE id = ? AND flight_id = ? AND org_id = ?', fileId, flightId, orgId);
    if (!r) throw notFound('Log file');
    return r;
  };

  app.get<{ Params: FlightP }>('/api/v2/organisations/:orgId/flights/:flightId/files', { schema: { ...tag, params: FlightParams } }, async (req) => {
    const a = orgAccess(db, req, req.params.orgId);
    loadFlight(a.orgId, req.params.flightId);
    return db.all('SELECT * FROM flight_files WHERE flight_id = ? ORDER BY created_at', req.params.flightId).map(fileDto);
  });

  app.get<{ Params: FlightP & { fileId: string } }>('/api/v2/organisations/:orgId/flights/:flightId/files/:fileId/download', { schema: tag }, async (req, reply) => {
    const a = orgAccess(db, req, req.params.orgId);
    const f = loadFile(a.orgId, req.params.flightId, req.params.fileId);
    reply.header('content-type', 'application/octet-stream').header('content-disposition', `attachment; filename="${f.filename}"`);
    return reply.send(storage.stream(f.storage_path));
  });

  app.get<{ Params: FlightP & { fileId: string } }>(
    '/api/v2/organisations/:orgId/flights/:flightId/files/:fileId/topics',
    { schema: { ...tag, summary: 'Topics and fields of an uploaded ULog (for plotting)' } },
    async (req) => {
      const a = orgAccess(db, req, req.params.orgId);
      const f = loadFile(a.orgId, req.params.flightId, req.params.fileId);
      if (f.kind !== 'ulog') throw badRequest('Topic listing is only available for ULog files');
      const parsed = parseULog(readFileSync(storage.abs(f.storage_path)));
      const topics: LogTopicDto[] = parsed.topics.filter((t) => t.samples > 0).map((t) => ({ name: t.name, multiId: t.multiId, fields: t.fields, samples: t.samples }));
      return { topics, info: parsed.info, params: parsed.params };
    },
  );

  app.get<{ Params: FlightP & { fileId: string }; Querystring: { topic: string; field: string; multiId?: string; maxPoints?: string } }>(
    '/api/v2/organisations/:orgId/flights/:flightId/files/:fileId/series',
    { schema: { ...tag, summary: 'One field of a ULog topic as a time series (seconds since log start)' } },
    async (req) => {
      const a = orgAccess(db, req, req.params.orgId);
      const f = loadFile(a.orgId, req.params.flightId, req.params.fileId);
      if (f.kind !== 'ulog') throw badRequest('Series extraction is only available for ULog files');
      const { topic, field } = req.query;
      if (!topic || !field) throw badRequest('topic and field are required');
      const multiId = clampInt(req.query.multiId, 0, 0, 255);
      const parsed = parseULog(readFileSync(storage.abs(f.storage_path)), { include: (n) => n === topic });
      const t = parsed.topics.find((x) => x.name === topic && x.multiId === multiId);
      if (!t || !t.data[field]) throw notFound('Topic field');
      const t0 = t.timestamps[0] ?? 0;
      const pairs = decimate(
        t.timestamps.map((ts, i) => [(ts - t0) / 1e6, t.data[field]![i]!] as const),
        clampInt(req.query.maxPoints, 5000, 10, 50_000),
      );
      return { topic, field, multiId, t: pairs.map((p) => p[0]), values: pairs.map((p) => (Number.isFinite(p[1]) ? p[1] : null)) };
    },
  );

  // --- Payload data & geotagged images ---------------------------------------------------------

  app.get<{ Params: FlightP }>('/api/v2/organisations/:orgId/flights/:flightId/payload', { schema: { ...tag, summary: 'Payload sensor records captured during the flight', params: FlightParams } }, async (req) => {
    const a = orgAccess(db, req, req.params.orgId);
    loadFlight(a.orgId, req.params.flightId);
    return db
      .all<any>('SELECT id, t, kind, data FROM payload_records WHERE flight_id = ? ORDER BY t LIMIT 10000', req.params.flightId)
      .map((r): PayloadRecordDto => ({ id: r.id, t: r.t, kind: r.kind, data: parseJson(r.data, {}) }));
  });

  const imageDto = (orgId: string, r: any): PayloadImageDto => ({
    id: r.id,
    filename: r.filename,
    capturedAt: r.captured_at,
    lat: r.lat,
    lon: r.lon,
    altMsl: r.alt_msl,
    size: r.size,
    url: `/api/v2/organisations/${orgId}/flights/${r.flight_id}/images/${r.id}`,
    createdAt: r.created_at,
  });

  app.get<{ Params: FlightP }>('/api/v2/organisations/:orgId/flights/:flightId/images', { schema: { ...tag, params: FlightParams } }, async (req) => {
    const a = orgAccess(db, req, req.params.orgId);
    loadFlight(a.orgId, req.params.flightId);
    return db.all('SELECT * FROM payload_images WHERE flight_id = ? ORDER BY captured_at, created_at', req.params.flightId).map((r) => imageDto(a.orgId, r));
  });

  app.post<{ Params: FlightP }>(
    '/api/v2/organisations/:orgId/flights/:flightId/images',
    {
      schema: {
        ...tag,
        summary: 'Upload payload images; they are geotagged from EXIF GPS or the flight track (multipart: files, timeOffsetS?)',
        params: FlightParams,
        consumes: ['multipart/form-data'],
      },
    },
    async (req, reply) => {
      const a = orgAccess(db, req, req.params.orgId, 'flight.upload');
      const flight = loadFlight(a.orgId, req.params.flightId);
      const { fields, files } = await readMultipart(req, storage, 'payload', 50 * 1_048_576, 50);
      if (files.length === 0) throw badRequest('At least one image is required');
      const offsetMs = (Number(fields.timeOffsetS) || 0) * 1000;
      const samples = loadSamples(db, flight.id);
      const exifr = (await import('exifr')).default;
      const out: PayloadImageDto[] = [];
      for (const [idx, f] of files.entries()) {
        if (!/^image\//.test(f.mimetype)) {
          storage.remove(f.stored.storagePath);
          continue;
        }
        let captured: Date | null = null;
        let lat: number | null = null;
        let lon: number | null = null;
        let alt: number | null = null;
        try {
          const meta = await exifr.parse(storage.abs(f.stored.storagePath), { gps: true, pick: ['DateTimeOriginal', 'CreateDate', 'GPSLatitude', 'GPSLongitude', 'GPSAltitude', 'latitude', 'longitude'] });
          const d = meta?.DateTimeOriginal ?? meta?.CreateDate;
          if (d instanceof Date && !Number.isNaN(d.getTime())) captured = d;
          if (typeof meta?.latitude === 'number' && typeof meta?.longitude === 'number') {
            lat = meta.latitude;
            lon = meta.longitude;
            alt = typeof meta.GPSAltitude === 'number' ? meta.GPSAltitude : null;
          }
        } catch {
          /* no EXIF */
        }
        // Fallback capture time: per-file field (capturedAt_<n>, e.g. the file's mtime) or a shared one.
        const fallbackTime = fields[`capturedAt_${idx}`] ?? fields.capturedAt;
        if (!captured && fallbackTime) {
          const d = new Date(fallbackTime);
          if (!Number.isNaN(d.getTime())) captured = d;
        }
        if (lat === null && captured) {
          const p = positionAt(samples, captured.getTime() + offsetMs);
          if (p) ({ lat, lon, altMsl: alt } = p);
        }
        const id = uuid();
        db.run(
          'INSERT INTO payload_images (id, flight_id, org_id, filename, storage_path, size, mime, captured_at, lat, lon, alt_msl, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
          id,
          flight.id,
          a.orgId,
          f.filename,
          f.stored.storagePath,
          f.stored.size,
          f.mimetype,
          captured ? new Date(captured.getTime() + offsetMs).toISOString() : null,
          lat,
          lon,
          alt,
          nowIso(),
        );
        out.push(imageDto(a.orgId, db.get('SELECT * FROM payload_images WHERE id = ?', id)));
      }
      reply.code(201);
      return out;
    },
  );

  app.get<{ Params: FlightP & { imageId: string } }>('/api/v2/organisations/:orgId/flights/:flightId/images/:imageId', { schema: tag }, async (req, reply) => {
    const a = orgAccess(db, req, req.params.orgId);
    const r = db.get<any>('SELECT * FROM payload_images WHERE id = ? AND flight_id = ? AND org_id = ?', req.params.imageId, req.params.flightId, a.orgId);
    if (!r) throw notFound('Image');
    reply.header('content-type', r.mime).header('cache-control', 'private, max-age=3600');
    return reply.send(storage.stream(r.storage_path));
  });

  app.get<{ Params: FlightP }>('/api/v2/organisations/:orgId/flights/:flightId/images.csv', { schema: { ...tag, summary: 'Geotags of payload images as CSV' } }, async (req, reply) => {
    const a = orgAccess(db, req, req.params.orgId);
    loadFlight(a.orgId, req.params.flightId);
    const rows = db.all<any>('SELECT filename, captured_at, lat, lon, alt_msl FROM payload_images WHERE flight_id = ? ORDER BY captured_at', req.params.flightId);
    const csv = ['filename,captured_at,latitude,longitude,altitude_msl', ...rows.map((r) => [r.filename, r.captured_at ?? '', r.lat ?? '', r.lon ?? '', r.alt_msl ?? ''].join(','))].join('\n');
    return reply.header('content-type', 'text/csv; charset=utf-8').header('content-disposition', 'attachment; filename="geotags.csv"').send(csv + '\n');
  });

  // --- External logbook export ------------------------------------------------------------------

  app.post<{ Params: FlightP }>(
    '/api/v2/organisations/:orgId/flights/:flightId/logbook-export',
    { schema: { tags: ['integrations'], summary: 'Export the flight to the configured logbook (DroneLogbook connector)', params: FlightParams } },
    async (req) => {
      const a = orgAccess(db, req, req.params.orgId, 'flight.upload');
      loadFlight(a.orgId, req.params.flightId);
      const r = await ctx.logbook.exportFlight(a.orgId, req.params.flightId);
      audit(db, a.orgId, a.userId, 'flight.logbook_export', req.params.flightId, { ok: r.ok, status: r.status });
      return r;
    },
  );
}
