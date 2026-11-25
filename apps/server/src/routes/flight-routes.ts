import type { FastifyInstance } from 'fastify';
import { readFile } from 'node:fs/promises';
import { Readable } from 'node:stream';
import { Type, type Static } from '@sinclair/typebox';
import { Nullable } from '../lib/schema';
import type { FlightFileDto, FlightSampleDto, LogTopicDto, PayloadImageDto, PayloadRecordDto } from '@athena-sky/shared';
import { can, flownFrom, interpolateLatLon, missionPath, normalizePlan, type MissionPlan } from '@athena-sky/shared';
import type { AppContext } from '../context';
import { orgAccess } from '../auth/auth';
import { parseJson } from '../db/database';
import { audit } from '../lib/audit';
import { badRequest, conflict, notFound } from '../lib/errors';
import { readMultipart } from '../lib/multipart';
import { nowIso, resolveRange, safeFilename, uuid, yieldToLoop } from '../lib/util';
import { isSafeImageType, sniffImageFile } from '../lib/images';
import { csvCell } from '../lib/csv';
import { exportParts, type ExportFormat } from '../flights/export';
import {
  FLIGHT_SELECT,
  analysisDto,
  flightDto,
  flownPlanJson,
  getFlight,
  loadEvents,
  loadSampleSpreadAsync,
  loadSamplesAsync,
  runAnalysis,
  sameFlightAs,
  sampleDto,
  samplePagesSteps,
} from '../flights/flight-service';
import { LogFormatError, normalizeLogSteps } from '../flights/ingest';
import { DuplicateLogError, ImportGoneError, importFlight } from '../flights/import';
import { finalizeFlight } from '../flights/finalize';
import { clearFlightRows } from '../flights/cleanup';
import { assertPilot } from '../orgs/org-service';
import { ULogError } from '../flights/ulog';
import { ulogFields, ulogTopics } from '../flights/ulog-cache';
import { runSliced } from '../lib/slice';

const OrgParams = Type.Object({ orgId: Type.String({ format: 'uuid' }) });
const FlightParams = Type.Object({ orgId: Type.String({ format: 'uuid' }), flightId: Type.String({ format: 'uuid' }) });
type FlightP = Static<typeof FlightParams>;
const ListQuery = Type.Object({
  from: Type.Optional(Type.String()),
  to: Type.Optional(Type.String()),
  droneId: Type.Optional(Type.String({ format: 'uuid' })),
  pilotId: Type.Optional(Type.String({ format: 'uuid' })),
  fleetId: Type.Optional(Type.String({ format: 'uuid' })),
  status: Type.Optional(Type.Union([Type.Literal('in_progress'), Type.Literal('processing'), Type.Literal('completed'), Type.Literal('aborted')])),
  limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 500 })),
  offset: Type.Optional(Type.Integer({ minimum: 0, maximum: 10_000_000 })),
});
/** Telemetry samples: how many at most (spread over the flight). */
const SamplesQuery = Type.Object({ maxPoints: Type.Optional(Type.Integer({ minimum: 2, maximum: 100_000 })) });
/** One field of a ULog topic: which (the topic's instance too), and how many values at most. */
const SeriesQuery = Type.Object({
  topic: Type.Optional(Type.String({ maxLength: 200 })),
  field: Type.Optional(Type.String({ maxLength: 200 })),
  multiId: Type.Optional(Type.Integer({ minimum: 0, maximum: 255 })),
  maxPoints: Type.Optional(Type.Integer({ minimum: 10, maximum: 50_000 })),
});
const FlightPatch = Type.Object({
  notes: Type.Optional(Type.String({ maxLength: 5000 })),
  pilotId: Type.Optional(Nullable(Type.String({ format: 'uuid' }))),
});

const tag = { tags: ['flight logs'] };

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
      const limit = q.limit ?? 50;
      const offset = q.offset ?? 0;
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
      // The pilot recorded is a member allowed to fly (a pilot recorded before keeps their place).
      if (req.body.pilotId && req.body.pilotId !== f.pilotId) assertPilot(db, a.orgId, req.body.pilotId);
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
    if (f.status === 'processing') throw conflict('The log of this flight is still being imported');
    // Its samples first, a few at a time (see clearFlightRows) – then the rest at once.
    await clearFlightRows(db, [f.id]);
    const files = [
      ...db.all<{ storage_path: string }>('SELECT storage_path FROM flight_files WHERE flight_id = ?', f.id),
      ...db.all<{ storage_path: string }>('SELECT storage_path FROM payload_images WHERE flight_id = ?', f.id),
    ];
    db.run('DELETE FROM flights WHERE id = ?', f.id);
    for (const file of files) storage.remove(file.storage_path);
    audit(db, a.orgId, a.userId, 'flight.delete', f.id);
    return { ok: true };
  });

  app.get<{ Params: FlightP; Querystring: Static<typeof SamplesQuery> }>(
    '/api/v2/organisations/:orgId/flights/:flightId/samples',
    { schema: { ...tag, summary: 'Telemetry samples of a flight', params: FlightParams, querystring: SamplesQuery } },
    async (req) => {
      const a = orgAccess(db, req, req.params.orgId);
      loadFlight(a.orgId, req.params.flightId);
      // Read a page at a time: a long flight never stalls the server.
      return loadSampleSpreadAsync(db, req.params.flightId, req.query.maxPoints ?? 20_000);
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
      if (f.status === 'processing') throw conflict('Analysis is available once the log is imported');
      return runAnalysis(db, f.id);
    },
  );

  app.get<{ Params: FlightP }>(
    '/api/v2/organisations/:orgId/flights/:flightId/planned-route',
    { schema: { ...tag, summary: 'The mission plan the flight was flown with (snapshot taken at upload) and its 3D path', params: FlightParams } },
    async (req) => {
      const a = orgAccess(db, req, req.params.orgId);
      const f = loadFlight(a.orgId, req.params.flightId);
      const row = db.get<{ mission_id: string | null; mission_plan: string | null; mission_started_at: number | null; start_lat: number | null; start_lon: number | null }>(
        'SELECT mission_id, mission_plan, mission_started_at, start_lat, start_lon FROM flights WHERE id = ?',
        f.id,
      )!;
      const flown = flownPlanJson(db, row);
      let plan: MissionPlan | null = null;
      try {
        plan = flown ? normalizePlan(parseJson(flown.plan, {})) : null;
      } catch {
        plan = null;
      }
      // As the post-flight analysis: from where the mission was begun (live flights) or where the flight took off.
      if (plan && row.mission_started_at == null && row.start_lat != null && row.start_lon != null) plan = flownFrom(plan, { lat: row.start_lat, lon: row.start_lon });
      return { missionId: row.mission_id, snapshot: flown?.snapshot ?? false, plan, path: plan ? missionPath(plan) : [], startedAt: row.mission_started_at };
    },
  );

  app.post<{ Params: FlightP }>('/api/v2/organisations/:orgId/flights/:flightId/analysis', { schema: { ...tag, summary: 'Re-run analysis', params: FlightParams } }, async (req) => {
    const a = orgAccess(db, req, req.params.orgId, 'flight.edit');
    const f = loadFlight(a.orgId, req.params.flightId);
    if (f.status === 'in_progress') throw conflict('Analysis is available after the flight ends');
    if (f.status === 'processing') throw conflict('Analysis is available once the log is imported');
    return runAnalysis(db, f.id);
  });

  app.get<{ Params: FlightP; Querystring: { format?: string } }>(
    '/api/v2/organisations/:orgId/flights/:flightId/export',
    { schema: { ...tag, summary: 'Export the flight log (format=csv|kml|gpx|json)', params: FlightParams } },
    async (req, reply) => {
      const a = orgAccess(db, req, req.params.orgId);
      const f = loadFlight(a.orgId, req.params.flightId);
      const base = `flight-${f.startedAt.slice(0, 19).replace(/[:T]/g, '-')}-${f.id.slice(0, 8)}`;
      const format = req.query.format ?? 'csv';
      const types: Record<ExportFormat, string> = {
        csv: 'text/csv; charset=utf-8',
        kml: 'application/vnd.google-earth.kml+xml',
        gpx: 'application/gpx+xml',
        json: 'application/json',
      };
      if (!Object.hasOwn(types, format)) throw badRequest('format must be csv, kml, gpx or json');
      const parts = exportParts(format as ExportFormat, f, format === 'json' ? loadEvents(db, f.id) : []);
      // Streamed a page of samples at a time: a long flight is neither held whole nor written in one go.
      async function* body(): AsyncGenerator<string> {
        yield parts.head;
        let chunk: string[] = [];
        let first = true;
        const pages = samplePagesSteps(db, f.id, (r) => chunk.push(parts.item(sampleDto(r))));
        for (;;) {
          const done = pages.next().done;
          if (chunk.length) {
            yield (first ? '' : parts.sep) + chunk.join(parts.sep);
            first = false;
            chunk = [];
          }
          if (done) break;
          await yieldToLoop();
        }
        yield parts.tail;
      }
      return reply
        .header('content-type', types[format as ExportFormat])
        .header('content-disposition', `attachment; filename="${base}.${format}"`)
        .send(Readable.from(body()));
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
      let committed = false;
      // The stored file is only removed while nothing references it yet.
      const cleanup = () => file && !committed && storage.remove(file.stored.storagePath);
      try {
        if (!file) throw badRequest('file is required');
        const drone = db.get<{ id: string }>('SELECT id FROM drones WHERE id = ? AND org_id = ?', fields.droneId ?? '', a.orgId);
        if (!drone) throw badRequest('droneId must reference a drone of this organisation');
        let pilotId: string | null = fields.pilotId || null;
        if (pilotId) assertPilot(db, a.orgId, pilotId);
        if (!pilotId && can(a.role, 'drone.control')) pilotId = a.userId;
        const dup = db.get<{ flight_id: string }>('SELECT flight_id FROM flight_files WHERE org_id = ? AND sha256 = ?', a.orgId, file.stored.sha256);
        if (dup) throw conflict('This log has already been uploaded', { flightId: dup.flight_id });
        const buf = await readFile(storage.abs(file.stored.storagePath));
        let log;
        try {
          // In slices: a long log is read while the server goes on answering.
          log = await runSliced(normalizeLogSteps(buf, file.filename));
        } catch (err) {
          if (err instanceof LogFormatError || err instanceof ULogError) throw badRequest(err.message);
          throw err;
        }
        // The log of a flight already recorded (live over the link, or from another of its logs) is
        // attached to it – as when the drone syncs it – rather than counted as a second flight.
        const known = log.absoluteTime ? sameFlightAs(db, drone.id, log.startedAt, log.endedAt) : null;
        if (known) {
          db.tx(() => {
            const again = db.get<{ flight_id: string }>('SELECT flight_id FROM flight_files WHERE org_id = ? AND sha256 = ?', a.orgId, file.stored.sha256);
            if (again) throw conflict('This log has already been uploaded', { flightId: again.flight_id });
            db.run(
              'INSERT INTO flight_files (id, flight_id, org_id, kind, filename, size, sha256, storage_path, uploaded_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
              uuid(),
              known,
              a.orgId,
              log.kind,
              file.filename,
              file.stored.size,
              file.stored.sha256,
              file.stored.storagePath,
              a.userId,
              nowIso(),
            );
            if (pilotId) db.run('UPDATE flights SET pilot_id = ? WHERE id = ? AND pilot_id IS NULL', pilotId, known);
            if (fields.notes) db.run("UPDATE flights SET notes = ? WHERE id = ? AND COALESCE(notes, '') = ''", fields.notes.slice(0, 5000), known);
          });
          committed = true;
          audit(db, a.orgId, a.userId, 'flight.upload', known, { filename: file.filename, kind: log.kind, attached: true });
          reply.code(200);
          return loadFlight(a.orgId, known);
        }
        let flightId: string;
        try {
          flightId = await importFlight(db, storage, {
            orgId: a.orgId,
            droneId: drone.id,
            pilotId,
            notes: fields.notes ?? '',
            log,
            file: { kind: log.kind, filename: file.filename, size: file.stored.size, sha256: file.stored.sha256, storagePath: file.stored.storagePath, uploadedBy: a.userId },
          });
        } catch (err) {
          if (err instanceof DuplicateLogError) throw conflict(err.message, { flightId: err.flightId });
          if (err instanceof ImportGoneError) {
            committed = true; // the import removed the file itself
            throw conflict(err.message);
          }
          throw err;
        }
        committed = true;
        if (log.vehicle.firmware) db.run('UPDATE drones SET firmware_version = COALESCE(firmware_version, ?) WHERE id = ?', log.vehicle.firmware, drone.id);
        // Stored: the parsed log is let go before the flight's samples are read again.
        const sampleCount = log.samples.length;
        log.samples = [];
        log.events = [];
        await finalizeFlight(ctx, flightId);
        audit(db, a.orgId, a.userId, 'flight.upload', flightId, { filename: file.filename, kind: log.kind, samples: sampleCount });
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
      try {
        return await ulogTopics(storage.abs(f.storage_path));
      } catch (err) {
        if (err instanceof ULogError) throw badRequest(err.message);
        throw err;
      }
    },
  );

  app.get<{ Params: FlightP & { fileId: string }; Querystring: Static<typeof SeriesQuery> }>(
    '/api/v2/organisations/:orgId/flights/:flightId/files/:fileId/series',
    { schema: { ...tag, summary: 'One field of a ULog topic as a time series (seconds since log start)', querystring: SeriesQuery } },
    async (req) => {
      const a = orgAccess(db, req, req.params.orgId);
      const f = loadFile(a.orgId, req.params.flightId, req.params.fileId);
      if (f.kind !== 'ulog') throw badRequest('Series extraction is only available for ULog files');
      const { topic, field } = req.query;
      if (!topic || !field) throw badRequest('topic and field are required');
      const multiId = req.query.multiId ?? 0;
      let t;
      try {
        t = await ulogFields(storage.abs(f.storage_path), topic, multiId, field);
      } catch (err) {
        if (err instanceof ULogError) throw badRequest(err.message);
        throw err;
      }
      if (!t) throw notFound('Topic field');
      const t0 = t.timestamps[0] ?? 0;
      // The samples decimate() would pick, found without going through all of them.
      const len = Math.min(t.timestamps.length, t.values.length);
      const max = req.query.maxPoints ?? 5000;
      const step = len > max ? (len - 1) / (max - 1) : 1;
      const idx = Array.from({ length: Math.min(len, max) }, (_, i) => Math.round(i * step));
      return {
        topic,
        field,
        multiId,
        t: idx.map((i) => (t.timestamps[i]! - t0) / 1e6),
        values: idx.map((i) => (Number.isFinite(t.values[i]) ? t.values[i]! : null)),
      };
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
      const samples = await loadSamplesAsync(db, flight.id);
      const exifr = (await import('exifr')).default;
      const out: PayloadImageDto[] = [];
      for (const [idx, f] of files.entries()) {
        // The type is taken from the file signature, never from the client: SVG/HTML could carry scripts.
        const mime = sniffImageFile(storage.abs(f.stored.storagePath));
        if (!mime) {
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
          mime,
          captured ? new Date(captured.getTime() + offsetMs).toISOString() : null,
          lat,
          lon,
          alt,
          nowIso(),
        );
        out.push(imageDto(a.orgId, db.get('SELECT * FROM payload_images WHERE id = ?', id)));
      }
      if (out.length === 0) throw badRequest('Only JPEG, PNG, WebP, GIF or TIFF images are accepted');
      reply.code(201);
      return out;
    },
  );

  app.get<{ Params: FlightP & { imageId: string } }>('/api/v2/organisations/:orgId/flights/:flightId/images/:imageId', { schema: tag }, async (req, reply) => {
    const a = orgAccess(db, req, req.params.orgId);
    const r = db.get<any>('SELECT * FROM payload_images WHERE id = ? AND flight_id = ? AND org_id = ?', req.params.imageId, req.params.flightId, a.orgId);
    if (!r) throw notFound('Image');
    const safe = isSafeImageType(r.mime);
    reply
      .header('content-type', safe ? r.mime : 'application/octet-stream')
      .header('content-disposition', `${safe ? 'inline' : 'attachment'}; filename="${safeFilename(r.filename, 'image')}"`)
      .header('content-security-policy', "default-src 'none'; img-src 'self'; style-src 'unsafe-inline'; sandbox")
      .header('cache-control', 'private, max-age=3600');
    return reply.send(storage.stream(r.storage_path));
  });

  app.get<{ Params: FlightP }>('/api/v2/organisations/:orgId/flights/:flightId/images.csv', { schema: { ...tag, summary: 'Geotags of payload images as CSV' } }, async (req, reply) => {
    const a = orgAccess(db, req, req.params.orgId);
    loadFlight(a.orgId, req.params.flightId);
    const rows = db.all<any>('SELECT filename, captured_at, lat, lon, alt_msl FROM payload_images WHERE flight_id = ? ORDER BY captured_at', req.params.flightId);
    const csv = ['filename,captured_at,latitude,longitude,altitude_msl', ...rows.map((r) => [r.filename, r.captured_at, r.lat, r.lon, r.alt_msl].map((v) => csvCell(v)).join(','))].join('\n');
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
