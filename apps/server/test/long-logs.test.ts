/**
 * Long logs and long flights: reading, storing, analysing, exporting and deleting them never
 * stalls the server – live telemetry, video and commands of every organisation go on meanwhile.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { destinationPoint, newItemId, type FlightSampleDto, type MissionPlan } from '@athena-sky/shared';
import { ULogWriter, simulateMission } from '@athena-sky/simulator';
import { insertLogSteps } from '../src/flights/flight-service';
import { checkComplianceAsync } from '../src/flights/compliance';
import { LogFormatError, MAX_LOG_EVENTS, normalizeCsv, normalizeJson, normalizeLog } from '../src/flights/ingest';
import { runAtOnce } from '../src/lib/slice';
import { api, multipart, signup, startServer, type Session, type TestServer } from './helpers';

const HOME = { lat: 25.0732, lon: 121.5355 };
/**
 * The longest the server may not answer while a long log or flight is handled (ms): slices take a
 * few milliseconds; other tests running alongside, or other load on the machine, can stretch one
 * (a full run measured up to ~320 ms under heavy load). Done at once, each step of these tests
 * would hold the server up for half a second or more – still well above this limit.
 */
const STALL_MS = 400;

/** The garbage of a test's own set-up (large logs built in memory) collected before measuring. */
const collectGarbage = () => (globalThis as { gc?: () => void }).gc?.();

/**
 * Runs `work` while the server is asked how it is every 20 ms: the longest time it could not
 * answer (beyond the 20 ms between questions).
 */
async function stallOf<T>(s: TestServer, work: () => Promise<T>): Promise<{ result: T; worst: number; took: number }> {
  collectGarbage();
  let worst = 0;
  let polling = true;
  const poll = (async () => {
    let last = performance.now();
    while (polling) {
      await new Promise((r) => setTimeout(r, 20));
      await s.app.inject({ method: 'GET', url: '/healthz' });
      const now = performance.now();
      worst = Math.max(worst, now - last - 20);
      last = now;
    }
  })();
  const t0 = performance.now();
  const result = await work();
  const took = performance.now() - t0;
  polling = false;
  await poll;
  return { result, worst, took };
}

describe('long logs and long flights', () => {
  let s: TestServer;
  let u: Session;
  let org: string;
  beforeAll(async () => {
    s = await startServer();
    u = await signup(s.app, { name: 'Lena Longflight' });
    org = `/api/v2/organisations/${u.orgId}`;
  });
  afterAll(async () => {
    await s.close();
  });
  const drone = async (name: string) => (await api(s.app, u)('POST', `${org}/drones`, { name, model: 'X4' })).json().id as string;

  it('reads a three-hour 50 Hz CSV log a slice at a time, the flight importing until all its samples are in', async () => {
    const droneId = await drone('Csv');
    const flownAt = Date.now() - 5 * 3_600_000;
    const rows = ['time,latitude,longitude,altitude_rel,battery,voltage,current,ground_speed,heading,mode,armed'];
    for (let i = 0; i < 3 * 3600 * 50; i++) {
      const a = (i / 5000) * 2 * Math.PI;
      rows.push(`${new Date(flownAt + i * 20).toISOString()},${(HOME.lat + 0.002 * Math.sin(a)).toFixed(7)},${(HOME.lon + 0.002 * Math.cos(a)).toFixed(7)},50,${(100 - i / 6000).toFixed(1)},15.2,12.1,8.2,90,MISSION,1`);
    }
    const mp = multipart({ droneId }, [{ field: 'file', filename: 'long.csv', content: Buffer.from(rows.join('\n')) }]);
    rows.length = 0;
    // What others see of the flight meanwhile.
    const seen = new Set<string>();
    let watching = true;
    const watch = (async () => {
      while (watching) {
        await new Promise((r) => setTimeout(r, 5));
        const r = s.ctx.db.get<{ status: string }>('SELECT status FROM flights WHERE drone_id = ?', droneId);
        if (r) seen.add(r.status);
      }
    })();
    const { result: up, worst, took } = await stallOf(s, () =>
      s.app.inject({ method: 'POST', url: `${org}/flights/upload`, headers: { cookie: u.cookie, 'x-csrf-token': u.csrf, 'content-type': mp.contentType }, payload: mp.body }),
    );
    watching = false;
    await watch;
    expect(up.statusCode, up.body).toBe(201);
    expect(up.json().status).toBe('completed');
    // Stored at 5 Hz (and the last sample).
    expect(s.ctx.db.get<{ n: number }>('SELECT COUNT(*) AS n FROM flight_samples WHERE flight_id = ?', up.json().id)!.n).toBe(54_001);
    expect(seen.has('processing')).toBe(true);
    // However long the log took to read, store and check, the server kept answering.
    expect(worst, `upload took ${Math.round(took)} ms`).toBeLessThan(STALL_MS);
  }, 180_000);

  it('analyses, lists, exports and deletes a long survey flight of a thousand waypoints without stalling', async () => {
    const droneId = await drone('Survey');
    // A survey of 1000 waypoints: 500 lines of 400 m, 6 m apart.
    const start = destinationPoint(HOME, 0, 3000);
    const items: MissionPlan['items'] = [{ id: newItemId(), type: 'takeoff', alt: 40 } as MissionPlan['items'][number]];
    for (let k = 0; k < 500; k++) {
      const a = destinationPoint(start, 0, k * 6);
      const b = destinationPoint(a, 90, 400);
      const [p, q] = k % 2 ? [b, a] : [a, b];
      items.push({ id: newItemId(), type: 'waypoint', lat: p.lat, lon: p.lon, alt: 40 } as MissionPlan['items'][number]);
      items.push({ id: newItemId(), type: 'waypoint', lat: q.lat, lon: q.lon, alt: 40 } as MissionPlan['items'][number]);
    }
    items.push({ id: newItemId(), type: 'rtl' } as MissionPlan['items'][number]);
    const plan = { home: { ...start, alt: 0 }, items, rallyPoints: [], geofence: null, defaultSpeed: 8, defaultAlt: 40 };
    // Flown along it at 10 Hz for three hours.
    const t0 = Date.now() - 7 * 3_600_000;
    const n = 108_000;
    const path = items.filter((x) => x.type === 'waypoint') as { lat: number; lon: number }[];
    const samples: FlightSampleDto[] = Array.from({ length: n }, (_, i) => {
      const f = (i / n) * (path.length - 1);
      const a = path[Math.floor(f)]!;
      const b = path[Math.min(path.length - 1, Math.floor(f) + 1)]!;
      const w = f - Math.floor(f);
      return { t: t0 + i * 100, lat: a.lat + (b.lat - a.lat) * w, lon: a.lon + (b.lon - a.lon) * w, altMsl: 48, altRel: 40, groundSpeed: 8, climbRate: 0, heading: 90, roll: 0, pitch: 0, yaw: 90, batteryPct: 90, voltage: 15, current: 12, satellites: 14, hdop: 0.7, mode: 'MISSION', armed: true, vibration: 10 };
    });
    const flightId = '00000000-0000-4000-8000-00000000aa01';
    s.ctx.db.run(
      `INSERT INTO flights (id, org_id, drone_id, source, status, started_at, ended_at, duration_s, start_lat, start_lon, mission_plan, mission_started_at, created_at)
       VALUES (?, ?, ?, 'live', 'completed', ?, ?, ?, ?, ?, ?, ?, ?)`,
      flightId,
      u.orgId,
      droneId,
      new Date(t0).toISOString(),
      new Date(t0 + n * 100).toISOString(),
      n / 10,
      samples[0]!.lat,
      samples[0]!.lon,
      JSON.stringify(plan),
      t0,
      new Date().toISOString(),
    );
    runAtOnce(insertLogSteps(s.ctx.db, flightId, samples, []));
    const call = api(s.app, u);
    const base = `${org}/flights/${flightId}`;

    const analysis = await stallOf(s, () => call('POST', `${base}/analysis`));
    expect(analysis.result.statusCode, analysis.result.body).toBe(200);
    expect(analysis.result.json().metrics.routeCoveragePct).toBeGreaterThan(90);
    expect(analysis.worst, `analysis took ${Math.round(analysis.took)} ms`).toBeLessThan(STALL_MS);

    const spread = await stallOf(s, () => call('GET', `${base}/samples?maxPoints=1000`));
    const got = spread.result.json() as FlightSampleDto[];
    expect(got).toHaveLength(1000);
    expect([got[0]!.t, got[999]!.t]).toEqual([samples[0]!.t, samples[n - 1]!.t]);
    expect(spread.worst).toBeLessThan(STALL_MS);

    for (const format of ['csv', 'json']) {
      const exp = await stallOf(s, () => call('GET', `${base}/export?format=${format}`));
      expect(exp.result.statusCode).toBe(200);
      if (format === 'csv') expect(exp.result.body.trimEnd().split('\n')).toHaveLength(n + 1);
      else expect(JSON.parse(exp.result.body).samples).toHaveLength(n);
      expect(exp.worst, `${format} export took ${Math.round(exp.took)} ms`).toBeLessThan(STALL_MS);
    }

    // Six hours more of it: deleting so many rows at once would take a while.
    runAtOnce(insertLogSteps(s.ctx.db, flightId, Array.from({ length: 216_000 }, (_, i) => ({ ...samples[i % n]!, t: t0 + (n + i) * 100 })), []));
    const del = await stallOf(s, () => call('DELETE', base));
    expect(del.result.statusCode).toBe(200);
    expect(s.ctx.db.get<{ n: number }>('SELECT COUNT(*) AS n FROM flight_samples WHERE flight_id = ?', flightId)!.n).toBe(0);
    expect(del.worst, `delete took ${Math.round(del.took)} ms`).toBeLessThan(STALL_MS);
  }, 180_000);

  it('lists the topics of a large ULog and plots its fields without stalling, reading the file once for both', async () => {
    // A log of one attitude topic at 250 Hz for three hours: 2 700 000 messages.
    const count = 2_700_000;
    const w = new ULogWriter(0);
    w.format('vehicle_attitude:uint64_t timestamp;float[4] q;float rollspeed;float pitchspeed;float yawspeed');
    const msgId = w.subscribe('vehicle_attitude');
    // The data messages written straight into one buffer: 'D', the subscription, 36 bytes of fields.
    const data = Buffer.alloc(count * 41);
    for (let i = 0; i < count; i++) {
      const o = i * 41;
      data.writeUInt16LE(38, o);
      data[o + 2] = 0x44;
      data.writeUInt16LE(msgId, o + 3);
      data.writeBigUInt64LE(BigInt(i * 4000), o + 5);
      data.writeFloatLE(1, o + 13);
      data.writeFloatLE(Math.sin(i / 1000), o + 25);
      data.writeFloatLE(0.1, o + 29);
      data.writeFloatLE(0.2, o + 33);
      data.writeFloatLE(i % 7, o + 37);
    }
    const stored = await s.ctx.storage.saveBuffer('logs', Buffer.concat([w.toBuffer(), data]));
    const droneId = await drone('Explorer');
    const flightId = '00000000-0000-4000-8000-00000000aa04';
    const fileId = '00000000-0000-4000-8000-00000000aa05';
    s.ctx.db.run("INSERT INTO flights (id, org_id, drone_id, source, status, started_at, created_at) VALUES (?, ?, ?, 'upload', 'completed', ?, ?)", flightId, u.orgId, droneId, new Date().toISOString(), new Date().toISOString());
    s.ctx.db.run(
      "INSERT INTO flight_files (id, flight_id, org_id, kind, filename, size, sha256, storage_path, created_at) VALUES (?, ?, ?, 'ulog', 'attitude.ulg', ?, ?, ?, ?)",
      fileId,
      flightId,
      u.orgId,
      stored.size,
      stored.sha256,
      stored.storagePath,
      new Date().toISOString(),
    );
    const call = api(s.app, u);
    const files = `${org}/flights/${flightId}/files/${fileId}`;
    const topics = await stallOf(s, () => call('GET', `${files}/topics`));
    expect(topics.result.json().topics).toEqual([{ name: 'vehicle_attitude', multiId: 0, fields: ['timestamp', 'q[0]', 'q[1]', 'q[2]', 'q[3]', 'rollspeed', 'pitchspeed', 'yawspeed'], samples: count }]);
    expect(topics.worst, `topics took ${Math.round(topics.took)} ms`).toBeLessThan(STALL_MS);
    const series = await stallOf(s, () => call('GET', `${files}/series?topic=vehicle_attitude&field=yawspeed&maxPoints=1000`));
    expect(series.result.json().values).toHaveLength(1000);
    expect(series.result.json().t.at(-1)).toBeCloseTo(10_800, 0);
    expect(series.worst, `series took ${Math.round(series.took)} ms`).toBeLessThan(STALL_MS);
    // Asked again: kept from the first time.
    const again = await stallOf(s, () => call('GET', `${files}/series?topic=vehicle_attitude&field=yawspeed&maxPoints=1000`));
    expect(again.result.json()).toEqual(series.result.json());
    expect(again.took).toBeLessThan(series.took / 4);
    const listed = await stallOf(s, () => call('GET', `${files}/topics`));
    expect(listed.took).toBeLessThan(topics.took / 4);
  }, 180_000);

  it('removes an import that the server did not finish (it stopped meanwhile), so the log can be uploaded again', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'athena-import-'));
    try {
      const a = await startServer({ dataDir });
      const v = await signup(a.app, { name: 'Ivo Interrupted' });
      const droneId = (await api(a.app, v)('POST', `/api/v2/organisations/${v.orgId}/drones`, { name: 'Cut', model: 'X4' })).json().id;
      const stored = await a.ctx.storage.saveBuffer('logs', Buffer.from('time,latitude,longitude\n0,25,121\n'));
      const flightId = '00000000-0000-4000-8000-00000000aa02';
      a.ctx.db.run(
        `INSERT INTO flights (id, org_id, drone_id, source, status, started_at, created_at) VALUES (?, ?, ?, 'upload', 'processing', ?, ?)`,
        flightId,
        v.orgId,
        droneId,
        new Date().toISOString(),
        new Date().toISOString(),
      );
      a.ctx.db.run(
        "INSERT INTO flight_files (id, flight_id, org_id, kind, filename, size, sha256, storage_path, created_at) VALUES (?, ?, ?, 'csv', 'cut.csv', ?, ?, ?, ?)",
        '00000000-0000-4000-8000-00000000aa03',
        flightId,
        v.orgId,
        stored.size,
        stored.sha256,
        stored.storagePath,
        new Date().toISOString(),
      );
      // Meanwhile it is shown as importing, and cannot be deleted or analysed.
      const f = (await api(a.app, v)('GET', `/api/v2/organisations/${v.orgId}/flights/${flightId}`)).json();
      expect(f.status).toBe('processing');
      expect((await api(a.app, v)('DELETE', `/api/v2/organisations/${v.orgId}/flights/${flightId}`)).statusCode).toBe(409);
      expect((await api(a.app, v)('GET', `/api/v2/organisations/${v.orgId}/flights/${flightId}/analysis`)).statusCode).toBe(409);
      await a.close();
      const b = await startServer({ dataDir });
      try {
        expect(b.ctx.db.get('SELECT 1 FROM flights WHERE id = ?', flightId)).toBeUndefined();
        expect(existsSync(b.ctx.storage.abs(stored.storagePath))).toBe(false);
      } finally {
        await b.close();
      }
    } finally {
      rmSync(dataDir, { recursive: true, force: true });
    }
  });
});

describe('reading logs', () => {
  it('takes from an export only what the server stores, in time order, at no more than 10 Hz', () => {
    const t = Date.UTC(2026, 3, 1, 8, 0, 0);
    const sample = (dt: number, extra: Record<string, unknown> = {}) => ({ t: t + dt, lat: 25, lon: 121, altMsl: 10, altRel: 5, armed: true, mode: 'MISSION', ...extra });
    const doc = {
      format: 'athena-sky-flight',
      ['__proto__']: { polluted: true },
      samples: [sample(200), sample(0, { altMsl: 'high', mode: { x: 1 }, motors: [0.5, 'x'], vibration: 'v' }), sample(50), sample(100), sample(150), { t: 'later', lat: 1, lon: 2 }],
      events: [{ t: t + 10, level: 'panic', code: 7, message: 'Odd level' }, { t: t + 20, message: 3 }],
    };
    const log = normalizeJson(Buffer.from(`\uFEFF${JSON.stringify(doc)}`));
    expect(log.samples.map((x) => x.t - t)).toEqual([0, 100, 200]);
    expect(log.samples[0]).toMatchObject({ altMsl: 0, mode: 'UNKNOWN', motors: [0.5, 0], vibration: null, armed: true });
    expect(log.events).toEqual([{ t: t + 10, level: 'info', code: null, message: 'Odd level' }]);
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
    expect(() => normalizeJson('{"format": "athena-sky-flight", "samples": [1, 2')).toThrow(LogFormatError);
    expect(() => normalizeJson('{"format": "athena-sky-flight", "samples": [1, 2')).toThrow('Invalid JSON');
    expect(() => normalizeJson('{"samples": []}')).toThrow('Not an Athena-sky flight export');
    expect(() => normalizeJson('[{"t": 1, "lat": 1, "lon": 1}]')).toThrow('Not an Athena-sky flight export');
    expect(() => normalizeJson('{"format": "athena-sky-flight", "samples": []} trailing')).toThrow('Invalid JSON');
    expect(() => normalizeJson(`{"format": "athena-sky-flight", "samples": [{"t": 1, "lat": 1, "lon": 1, "mode": "${'x'.repeat(1_100_000)}"}]}`)).toThrow('larger than a megabyte');
  });

  it('reads CSV logs with a byte order mark and rows out of time order', () => {
    const csv = '\uFEFFtime (ms),latitude,longitude\n# a comment\n400,25,121\n0,25.1,121\n\n200,25.2,121\r\n100,25.3,121\n';
    const log = normalizeCsv(csv, 0);
    expect(log.samples.map((x) => [x.t, x.lat])).toEqual([
      [0, 25.1],
      [200, 25.2],
      [400, 25],
    ]);
    expect(() => normalizeCsv(`time,latitude,longitude\n0,1,${'2'.repeat(1_100_000)}\n`, 0)).toThrow('longer than a megabyte');
    expect(() => normalizeCsv(`time,latitude,longitude,${Array.from({ length: 2500 }, (_, i) => `c${i}`).join(',')}\n0,1,2\n`, 0)).toThrow('CSV has more than 2000 columns');
    // Long rows are read as far as the columns used.
    expect(normalizeCsv(`time,latitude,longitude\n0,25,121,${'9,'.repeat(300_000)}\n1,25.1,121\n`, 0).samples.map((x) => x.lat)).toEqual([25, 25.1]);
  });

  it('keeps ten thousand messages of a log, the last one saying how many more it had', () => {
    const home = { lat: 25.03, lon: 121.56 };
    const plan = {
      home: { ...home, alt: 0 },
      items: [{ id: newItemId(), type: 'takeoff' as const, alt: 20 }, { id: newItemId(), type: 'waypoint' as const, ...destinationPoint(home, 45, 80), alt: 20 }, { id: newItemId(), type: 'rtl' as const }],
      rallyPoints: [],
      geofence: null,
      defaultSpeed: 8,
      defaultAlt: 20,
    };
    const sim = simulateMission(plan, { home, startTime: Date.UTC(2026, 3, 1, 8, 0, 0), ulog: true, drone: { groundAltMsl: 8, seed: 3 } });
    const own = normalizeLog(sim.ulog!, 'flight.ulg').events.length;
    // 12 000 more 'L' (logged string) messages at the end of the file.
    const text = Buffer.from('Spam message');
    const one = Buffer.alloc(3 + 9 + text.length);
    one.writeUInt16LE(9 + text.length, 0);
    one.write('L', 2, 'latin1');
    one.writeUInt8(6, 3);
    one.writeBigUInt64LE(5_000_000n, 4);
    text.copy(one, 12);
    const log = normalizeLog(Buffer.concat([sim.ulog!, ...Array.from({ length: 12_000 }, () => one)]), 'spam.ulg');
    expect(log.events).toHaveLength(MAX_LOG_EVENTS);
    expect(log.events[MAX_LOG_EVENTS - 1]).toMatchObject({
      code: 'log_truncated',
      message: `${(own + 12_000 - (MAX_LOG_EVENTS - 1)).toLocaleString('en')} more log messages were not imported`,
    });
  });
});

describe('checking flights', () => {
  it('checks a long log of position jumps in little memory, bridging only what a drone can fly', async () => {
    const centre = destinationPoint(HOME, 0, 60_000);
    const t0 = Date.UTC(2026, 3, 1, 8);
    const zone = (id: string, at: { lat: number; lon: number }) => ({ id, name: id, type: 'prohibited', geometry: { kind: 'circle', center: at, radiusM: 8 }, floorM: 0, ceilingM: 500, activeFrom: null, activeTo: null, source: 'org', notes: '', createdAt: '', readOnly: false });
    // Forty thousand samples 200 ms apart, jumping between two places 300 m apart (1500 m/s: a
    // corrupt position, not a flight): a small zone half-way between them is not crossed.
    const a = destinationPoint(centre, 90, 150);
    const b = destinationPoint(centre, 270, 150);
    const jumps = Array.from({ length: 40_000 }, (_, i) => ({ t: t0 + i * 200, ...(i % 2 ? b : a), altRel: 50, armed: true }));
    collectGarbage();
    const base = process.memoryUsage().heapUsed;
    let peak = base;
    let on = true;
    const watch = () => {
      peak = Math.max(peak, process.memoryUsage().heapUsed);
      if (on) setImmediate(watch);
    };
    setImmediate(watch);
    // Inside a large geofence: every point of the log is checked against it.
    const fence = { polygon: [0, 90, 180, 270].map((d) => destinationPoint(centre, d + 45, 2000)), maxAlt: null, action: 'rtl' as const };
    const jumped = await checkComplianceAsync({ samples: jumps, maxAltitudeM: 120, zones: [], authorizations: [], geofence: fence });
    on = false;
    expect((peak - base) / 1_048_576, 'heap grown (MB)').toBeLessThan(150);
    expect(jumped).toEqual({ compliant: true, violations: [] });
    expect(await checkComplianceAsync({ samples: jumps, maxAltitudeM: 120, zones: [zone('Between', centre) as never], authorizations: [], geofence: null })).toEqual({ compliant: true, violations: [] });
    // At 60 m/s – as fast as drones fly – the stretch between two samples a second apart is checked.
    const fast = [
      { t: t0, ...destinationPoint(centre, 90, 30), altRel: 50, armed: true },
      { t: t0 + 1000, ...destinationPoint(centre, 270, 30), altRel: 50, armed: true },
    ];
    expect((await checkComplianceAsync({ samples: fast, maxAltitudeM: 120, zones: [zone('Crossed', centre) as never], authorizations: [], geofence: null })).violations).toEqual([
      { type: 'zone', zoneId: 'Crossed', message: 'Entered prohibited airspace "Crossed"' },
    ]);
  }, 60_000);


  it('checks a flight in slices bounded by time, however much each point costs', async () => {
    // Controlled airspace over the whole flight and twenty thousand authorisations near it, only
    // the last of which covers it: every point of the flight is held against all of them.
    const centre = destinationPoint(HOME, 90, 40_000);
    const t0 = Date.UTC(2026, 3, 1, 8);
    const ring = Array.from({ length: 8 }, (_, i) => destinationPoint(centre, i * 45, 1000));
    const zone = { id: 'z', name: 'Control zone', type: 'controlled', geometry: { kind: 'polygon', polygon: ring }, floorM: 0, ceilingM: 500, activeFrom: null, activeTo: null, source: 'org', notes: '', createdAt: '', readOnly: false };
    const authorizations = [
      ...Array.from({ length: 20_000 }, (_, k) => ({ reference: `ATH-${k}`, geometry: { kind: 'cylinder' as const, center: destinationPoint(centre, k % 360, 3000 + k), radiusM: 50 }, maxAltM: 120 })),
      { reference: 'ATH-ALL', geometry: { kind: 'cylinder' as const, center: centre, radiusM: 900 }, maxAltM: 120 },
    ];
    const samples = Array.from({ length: 2000 }, (_, i) => {
      const p = destinationPoint(centre, ((i * 2) / (2 * Math.PI * 150)) * 360, 150);
      return { t: t0 + i * 200, lat: p.lat, lon: p.lon, altRel: 50, armed: true };
    });
    collectGarbage();
    let worst = 0;
    let last = performance.now();
    let on = true;
    const tick = () => {
      const now = performance.now();
      worst = Math.max(worst, now - last);
      last = now;
      if (on) setImmediate(tick);
    };
    setImmediate(tick);
    const started = performance.now();
    const result = await checkComplianceAsync({ samples, maxAltitudeM: 120, zones: [zone as never], authorizations, geofence: null });
    const took = performance.now() - started;
    on = false;
    expect(result).toEqual({ compliant: true, violations: [] });
    // Slices of a few milliseconds – checked by the half second each slice of 512 points took
    // here (other tests running alongside can stretch a slice, or a garbage collection).
    expect(worst, `the check took ${Math.round(took)} ms`).toBeLessThan(250);
  }, 60_000);
});
