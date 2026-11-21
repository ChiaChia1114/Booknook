/**
 * Regression tests for the defects found by the independent acceptance review
 * (stored XSS, ULog DoS, analysis on long logs, CSV time units, anomaly z-score floors,
 * live-socket authorisation, analytics range cap, IPv6 SSRF) and for the pluggable
 * airspace providers.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { LinkClient, ULogWriter, VirtualDrone } from '@athena-sky/simulator';
import { destinationPoint, type FlightSampleDto } from '@athena-sky/shared';
import { parseULog, ULogError } from '../src/flights/ulog';
import { LogFormatError, normalizeCsv } from '../src/flights/ingest';
import { analyzeFlight } from '../src/flights/analysis';
import { assertPublicTarget, isPrivateAddress, safeFetch } from '../src/lib/net';
import { parseAirspaceFeeds } from '../src/config';
import type { GeoJsonFeedProvider } from '../src/airspace/providers';
import { addMember, api, cookieHeader, multipart, signup, startServer, Viewer, waitFor, type Session, type TestServer } from './helpers';

const HOME = { lat: 25.0732, lon: 121.5355 };
// 1×1 transparent PNG
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64');

let s: TestServer;
let owner: Session;
let pilot: Session;
let droneId: string;

/** A simple CSV flight: `rows` samples every `stepMs`, header configurable. */
function csvFlight(rows: number, stepMs: number, timeHeader: string | null, timeOf: (ms: number) => string): string {
  const head = [...(timeHeader ? [timeHeader] : []), 'latitude', 'longitude', 'altitude_msl', 'altitude_rel', 'battery', 'voltage', 'current', 'armed'];
  const lines = [head.join(',')];
  for (let i = 0; i < rows; i++) {
    const p = destinationPoint(HOME, 90, (i / rows) * 2000);
    const alt = Math.min(40, i * 0.5);
    lines.push(
      [...(timeHeader ? [timeOf(i * stepMs)] : []), p.lat.toFixed(7), p.lon.toFixed(7), (10 + alt).toFixed(2), alt.toFixed(2), (100 - (60 * i) / rows).toFixed(1), (24.6 - i / rows).toFixed(2), '18.5', '1'].join(','),
    );
  }
  return lines.join('\n');
}

async function upload(session: Session, filename: string, content: Buffer | string) {
  const mp = multipart({ droneId }, [{ field: 'file', filename, content: Buffer.from(content) }]);
  return s.app.inject({
    method: 'POST',
    url: `/api/v2/organisations/${owner.orgId}/flights/upload`,
    headers: { cookie: session.cookie, 'x-csrf-token': session.csrf, 'content-type': mp.contentType },
    payload: mp.body,
  });
}

beforeAll(async () => {
  s = await startServer();
  owner = await signup(s.app, { name: 'Rita Owner' });
  pilot = await signup(s.app, { name: 'Paul Pilot' });
  const call = api(s.app, owner);
  await addMember(s.app, owner, pilot, 'pilot');
  droneId = (await call('POST', `/api/v2/organisations/${owner.orgId}/drones`, { name: 'Kestrel', model: 'X4' })).json().id;
});

afterAll(async () => {
  await s.close();
});

describe('payload images cannot carry scripts (review defect 1)', () => {
  let flightId: string;
  const uploadImage = (filename: string, content: Buffer, type: string) => {
    const mp = multipart({}, [{ field: 'files', filename, content, type }]);
    return s.app.inject({
      method: 'POST',
      url: `/api/v2/organisations/${owner.orgId}/flights/${flightId}/images`,
      headers: { cookie: pilot.cookie, 'x-csrf-token': pilot.csrf, 'content-type': mp.contentType },
      payload: mp.body,
    });
  };

  beforeAll(async () => {
    const r = await upload(pilot, 'short.csv', csvFlight(120, 1000, 'time(s)', (ms) => String(ms / 1000)));
    expect(r.statusCode).toBe(201);
    flightId = r.json().id;
  });

  it('neutralises spreadsheet formulas in the flight CSV export', async () => {
    const evil = "=1+2+cmd|' /C calc'!A0";
    const rows = csvFlight(30, 1000, 'time(s)', (ms) => String(ms / 1000)).split('\n');
    const csv = [`${rows[0]},mode`, ...rows.slice(1).map((r, i) => `${r},${i === 5 ? evil : 'MISSION'}`)].join('\n');
    const up = await upload(pilot, 'formula.csv', csv);
    expect(up.statusCode).toBe(201);
    const out = await api(s.app, owner)('GET', `/api/v2/organisations/${owner.orgId}/flights/${up.json().id}/export?format=csv`);
    expect(out.statusCode).toBe(200);
    expect(out.body).toContain(`,'=1+2+cmd|' /C calc'!A0,`);
    expect(out.body).not.toMatch(/(^|,)=1\+2/m);
    // Numbers, including negative ones, stay numbers.
    expect(out.body.split('\n')[1]).toMatch(/^\d{4}-\d\d-\d\dT[^,]+,\d+,25\.\d+,121\.\d+,/);
  });

  it('rejects SVG and HTML whatever the declared type or file name', async () => {
    const svg = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" onload="alert(document.cookie)"><rect width="10" height="10"/></svg>');
    const svgRes = await uploadImage('photo.svg', svg, 'image/svg+xml');
    expect(svgRes.statusCode).toBe(400);
    expect(svgRes.json().message).toMatch(/Only JPEG, PNG, WebP, GIF or TIFF/);
    const disguised = await uploadImage('photo.png', Buffer.from('<html><script>alert(1)</script></html>'), 'image/png');
    expect(disguised.statusCode).toBe(400);
    const list = await api(s.app, owner)('GET', `/api/v2/organisations/${owner.orgId}/flights/${flightId}/images`);
    expect(list.json()).toHaveLength(0);
  });

  it('serves accepted images with their sniffed type inside a CSP sandbox', async () => {
    const res = await uploadImage('photo.jpg', PNG, 'image/jpeg');
    expect(res.statusCode).toBe(201);
    const img = res.json()[0];
    const get = await s.app.inject({ method: 'GET', url: `/api/v2/organisations/${owner.orgId}/flights/${flightId}/images/${img.id}`, headers: { cookie: owner.cookie } });
    expect(get.statusCode).toBe(200);
    expect(get.headers['content-type']).toBe('image/png');
    expect(get.headers['content-security-policy']).toMatch(/default-src 'none'.*sandbox/);
    expect(get.headers['x-content-type-options']).toBe('nosniff');
    expect(get.headers['content-disposition']).toMatch(/^inline; filename="photo\.jpg"/);
    expect(get.rawPayload.equals(PNG)).toBe(true);
  });
});

describe('hostile ULog files are rejected quickly (review defect 3)', () => {
  const nested = () => {
    // fan-out 30, depth 5: ≈ 24 million leaves if expanded naively
    const w = new ULogWriter(0);
    w.format('l5:float v');
    w.format('l4:l5[30] a');
    w.format('l3:l4[30] a');
    w.format('l2:l3[30] a');
    w.format('l1:l2[30] a');
    w.format('top:uint64_t timestamp;l1[30] a');
    w.subscribe('top');
    return w.toBuffer();
  };
  const wide = () => {
    // 54 001 leaves in one (otherwise valid, < 64 KiB) topic
    const w = new ULogWriter(0);
    w.format('b:uint8_t v');
    w.format('c:b[30] a');
    w.format('d:c[30] a');
    w.format('e:d[30] a');
    w.format('top:uint64_t timestamp;e[2] a');
    w.subscribe('top');
    return w.toBuffer();
  };
  const many = () => {
    // 40 subscriptions × 8 001 leaves = 320 040 leaves in total
    const w = new ULogWriter(0);
    w.format('wide:uint64_t timestamp;uint8_t[8000] a');
    for (let i = 0; i < 40; i++) w.subscribe('wide', i);
    return w.toBuffer();
  };

  it.each([
    ['nested', nested],
    ['wide', wide],
    ['many', many],
  ])('rejects the %s attack in well under a second', (_name, build) => {
    const buf = build();
    expect(buf.length).toBeLessThan(2048);
    const t0 = performance.now();
    expect(() => parseULog(buf, { include: () => true })).toThrow(ULogError);
    expect(performance.now() - t0).toBeLessThan(1000);
  });

  it('answers 400 to an upload and keeps serving', async () => {
    const r = await upload(pilot, 'bomb.ulg', nested());
    expect(r.statusCode).toBe(400);
    expect((await s.app.inject({ method: 'GET', url: '/healthz' })).statusCode).toBe(200);
  });
});

describe('long high-rate CSV logs (review defects 4 and 6)', () => {
  it('stores and analyses a 140 000-row 50 Hz log', async () => {
    const t0 = Date.UTC(2026, 2, 1, 8, 0, 0);
    const r = await upload(pilot, 'long.csv', csvFlight(140_000, 20, 'timestamp', (ms) => new Date(t0 + ms).toISOString()));
    expect(r.statusCode).toBe(201);
    const flight = r.json();
    expect(flight.durationS).toBeCloseTo(2800, -1);
    const analysis = await api(s.app, owner)('GET', `/api/v2/organisations/${owner.orgId}/flights/${flight.id}/analysis`);
    expect(analysis.statusCode).toBe(200);
    expect(analysis.json().metrics.durationS).toBeGreaterThan(2700);
    const file = (await api(s.app, owner)('GET', `/api/v2/organisations/${owner.orgId}/flights/${flight.id}/files`)).json()[0];
    const dl = await api(s.app, owner)('GET', `/api/v2/organisations/${owner.orgId}/flights/${flight.id}/files/${file.id}/download`);
    expect(dl.statusCode).toBe(200);
  }, 60_000);

  const duration = (csv: string) => {
    const n = normalizeCsv(csv, 0);
    return { s: (n.endedAt - n.startedAt) / 1000, events: n.events.map((e) => e.code) };
  };

  it('honours explicit time units in the header', () => {
    expect(duration(csvFlight(6000, 100, 'time(millisecond)', (ms) => String(ms))).s).toBeCloseTo(599.9, 1);
    expect(duration(csvFlight(6000, 100, 'Time (ms)', (ms) => String(ms))).s).toBeCloseTo(599.9, 1);
    expect(duration(csvFlight(6000, 100, 'time_ms', (ms) => String(ms))).s).toBeCloseTo(599.9, 1);
    expect(duration(csvFlight(6000, 100, 'time_boot_us', (ms) => String(ms * 1000))).s).toBeCloseTo(599.9, 1);
    expect(duration(csvFlight(6000, 100, 'time(s)', (ms) => String(ms / 1000))).s).toBeCloseTo(599.9, 1);
  });

  it('detects unit-less millisecond columns and reports assumptions as events', () => {
    const ms = duration(csvFlight(6000, 100, 'time', (v) => String(v)));
    expect(ms.s).toBeCloseTo(599.9, 1);
    expect(ms.events).toContain('csv_time_unit');
    const seconds = duration(csvFlight(600, 1000, 'time', (v) => String(v / 1000)));
    expect(seconds.s).toBe(599);
    expect(seconds.events).not.toContain('csv_time_unit');
    const none = duration(csvFlight(600, 1000, null, () => ''));
    expect(none.s).toBe(599);
    expect(none.events).toContain('csv_no_time');
  });

  it('rejects a present but unparseable time column instead of guessing', () => {
    const csv = csvFlight(10, 1000, 'time', (v) => (v === 5000 ? 'n/a' : String(v / 1000)));
    expect(() => normalizeCsv(csv, 0)).toThrow(LogFormatError);
    expect(() => normalizeCsv(csv, 0)).toThrow(/Row 7: cannot parse time value "n\/a"/);
  });
});

describe('anomaly detection against history (review defect 7)', () => {
  const flight = (imbalance: number): FlightSampleDto[] =>
    Array.from({ length: 300 }, (_, i) => ({
      t: i * 1000,
      ...destinationPoint(HOME, 0, i * 5),
      altMsl: 40,
      altRel: i < 5 || i > 295 ? 0 : 30,
      groundSpeed: 5,
      climbRate: 0,
      heading: 0,
      roll: 0,
      pitch: 0,
      yaw: 0,
      batteryPct: 100 - i * 0.1,
      voltage: 24,
      current: 15,
      satellites: 14,
      hdop: 0.7,
      mode: 'MISSION',
      armed: true,
      vibration: 8,
      motors: [0.5 * (1 + imbalance), 0.5, 0.5, 0.5],
    }));

  it('does not turn a tiny change of a constant metric into an absurd critical alarm', () => {
    const history = Array.from({ length: 10 }, () => ({ motorImbalance: 0, vibrationMean: 8, meanCurrentA: 15, batteryRatePctPerMin: 6 }));
    const r = analyzeFlight({ samples: flight(0.04), events: [], history });
    expect(r.metrics.motorImbalance).toBeCloseTo(0.04, 2);
    expect(r.metrics.motorImbalanceZ).toBeCloseTo(2, 0);
    expect(r.findings.filter((f) => f.code.startsWith('anomaly_'))).toEqual([]);
  });

  it('still flags a real deviation from the drone history', () => {
    const history = Array.from({ length: 10 }, (_, i) => ({ motorImbalance: 0.02 + (i % 2) * 0.005 }));
    const r = analyzeFlight({ samples: flight(0.2), events: [], history });
    const f = r.findings.find((x) => x.code === 'anomaly_motorImbalance');
    expect(f?.severity).toBe('critical');
    expect(f!.metric!).toBeLessThan(99);
  });
});

describe('analytics period cap (review defect 9)', () => {
  it('refuses multi-century ranges and accepts a year', async () => {
    const call = api(s.app, owner);
    const huge = await call('GET', `/api/v2/organisations/${owner.orgId}/analytics/dashboard?from=0001-01-01&to=9999-12-31`);
    expect(huge.statusCode).toBe(400);
    expect(huge.json().message).toMatch(/cannot exceed 366 days/);
    const year = await call('GET', `/api/v2/organisations/${owner.orgId}/analytics/dashboard?from=2026-01-01&to=2026-12-31`);
    expect(year.statusCode).toBe(200);
    expect(year.json().flightsPerDay.length).toBeGreaterThanOrEqual(364);
    expect(year.json().flightsPerDay.length).toBeLessThanOrEqual(366);
  });
});

describe('outbound requests cannot reach private networks (review defect 10)', () => {
  let local: Server;
  let port: number;
  beforeAll(async () => {
    local = createServer((_req, res) => res.writeHead(200).end('internal'));
    await new Promise<void>((r) => local.listen(0, '127.0.0.1', () => r()));
    port = (local.address() as AddressInfo).port;
  });
  afterAll(() => new Promise<void>((r) => local.close(() => r())));

  it('classifies IPv4-mapped and embedded IPv6 forms as private', () => {
    for (const ip of ['::ffff:a9fe:a9fe', '::ffff:169.254.169.254', '::ffff:7f00:1', '[::ffff:7f00:1]', '::1', '::', 'fe80::1%eth0', 'fd12::1', '64:ff9b::a9fe:a9fe', '2002:a9fe:a9fe::1', '127.0.0.1', '10.1.2.3', '100.64.0.1', '169.254.169.254', '0.0.0.0']) {
      expect(isPrivateAddress(ip), ip).toBe(true);
    }
    for (const ip of ['8.8.8.8', '2606:4700:4700::1111', '::ffff:8.8.8.8']) expect(isPrivateAddress(ip), ip).toBe(false);
  });

  it('rejects literal mapped addresses and hostnames resolving to loopback', async () => {
    await expect(assertPublicTarget(new URL('http://[::ffff:169.254.169.254]/latest/meta-data'), false)).rejects.toThrow(/private or loopback/);
    await expect(assertPublicTarget(new URL(`http://localhost:${port}/`), false)).rejects.toThrow(/private or loopback/);
    // the connect-time check (DNS rebinding) blocks the request itself
    await expect(safeFetch(false)(`http://localhost:${port}/`)).rejects.toThrow();
    expect(await (await safeFetch(true)(`http://localhost:${port}/`)).text()).toBe('internal');
  });

  it('never delivers a webhook to a mapped-IPv6 loopback address', async () => {
    const strict = await startServer({ allowPrivateTargets: false });
    try {
      const o = await signup(strict.app);
      const call = api(strict.app, o);
      // Refused when saved …
      const refused = await call('POST', `/api/v2/organisations/${o.orgId}/webhooks`, { url: `http://[::ffff:7f00:1]:${port}/x`, events: ['flight.ended'] });
      expect(refused.statusCode).toBe(400);
      // … and when delivering, should the address change behind a name later.
      const hook = await call('POST', `/api/v2/organisations/${o.orgId}/webhooks`, { url: 'https://8.8.8.8/x', events: ['flight.ended'] });
      expect(hook.statusCode).toBe(201);
      strict.ctx.db.run('UPDATE webhooks SET url = ? WHERE id = ?', `http://[::ffff:7f00:1]:${port}/x`, hook.json().id);
      strict.ctx.webhooks.invalidate(o.orgId);
      const test = await call('POST', `/api/v2/organisations/${o.orgId}/webhooks/${hook.json().id}/test`);
      const d = await waitFor(async () => {
        const list = (await call('GET', `/api/v2/organisations/${o.orgId}/webhooks/${hook.json().id}/deliveries`)).json();
        return list.find((x: any) => x.id === test.json().deliveryId && x.error);
      });
      expect(d.delivered).toBe(false);
      expect(d.error).toMatch(/private or loopback/);
    } finally {
      await strict.close();
    }
  });
});

describe('authorisation list order', () => {
  it('lists the most recently requested authorisation first', async () => {
    const call = api(s.app, owner);
    const at = (h: number) => new Date(Date.now() + h * 3_600_000).toISOString();
    const geometry = { kind: 'cylinder', center: destinationPoint(HOME, 200, 3000), radiusM: 50 };
    const first = await call('POST', `/api/v2/organisations/${owner.orgId}/airspace/authorizations`, { geometry, maxAltM: 50, startAt: at(48), endAt: at(49) });
    const second = await call('POST', `/api/v2/organisations/${owner.orgId}/airspace/authorizations`, { geometry, maxAltM: 50, startAt: at(24), endAt: at(25) });
    expect(first.statusCode).toBe(201);
    expect(second.statusCode).toBe(201);
    const list = (await call('GET', `/api/v2/organisations/${owner.orgId}/airspace/authorizations`)).json();
    expect(list.slice(0, 2).map((a: any) => a.id)).toEqual([second.json().id, first.json().id]);
  });
});

describe('live sockets follow membership, role, session and token changes (review defect 8)', () => {
  let client: LinkClient;
  let liveDroneId: string;
  const closeCode = (v: Viewer) => new Promise<number>((r) => v.ws.on('close', (code) => r(code)));

  beforeAll(async () => {
    const created = (await api(s.app, owner)('POST', `/api/v2/organisations/${owner.orgId}/drones`, { name: 'Live-1' })).json();
    liveDroneId = created.id;
    client = new LinkClient({ url: `${s.wsBase}/api/v2/link`, key: created.linkKey, drone: new VirtualDrone({ home: HOME, groundAltMsl: 10, seed: 3 }), timeScale: 4 });
    client.start();
  });
  afterAll(async () => {
    await client.stop();
  });

  it('applies a role downgrade to an open socket and removes access on member deletion', async () => {
    const member = await signup(s.app, { name: 'Mia Member' });
    await addMember(s.app, owner, member, 'pilot');
    const v = new Viewer(`${s.wsBase}/api/v2/live?org=${owner.orgId}`, { cookie: member.cookie, origin: s.baseUrl });
    await v.opened;
    await v.wait((m) => m.type === 'hello' && m.canControl === true);
    await waitFor(() => [...v.messages].reverse().find((m) => (m.type === 'snapshot' && m.drones.some((d: any) => d.droneId === liveDroneId && d.online)) || (m.type === 'status' && m.drone.droneId === liveDroneId && m.drone.online)));

    await api(s.app, owner)('PATCH', `/api/v2/organisations/${owner.orgId}/members/${member.userId}`, { role: 'viewer' });
    await v.wait((m) => m.type === 'hello' && m.canControl === false);
    v.send({ type: 'command', droneId: liveDroneId, command: 'arm', requestId: 'r-downgraded' });
    const ack = await v.wait((m) => m.type === 'ack' && m.requestId === 'r-downgraded');
    expect(ack.result).toBe('rejected');
    expect(ack.message).toMatch(/cannot control/);

    const closed = closeCode(v);
    await api(s.app, owner)('DELETE', `/api/v2/organisations/${owner.orgId}/members/${member.userId}`);
    expect(await closed).toBe(4403);
  });

  it('re-checks membership on every command even without a role-change notification', async () => {
    const member = await signup(s.app, { name: 'Sam Silent' });
    await addMember(s.app, owner, member, 'pilot');
    const v = new Viewer(`${s.wsBase}/api/v2/live?org=${owner.orgId}`, { cookie: member.cookie, origin: s.baseUrl });
    await v.opened;
    await v.wait((m) => m.type === 'hello');
    // membership removed directly in the database (e.g. by another server process)
    s.ctx.db.run('DELETE FROM memberships WHERE org_id = ? AND user_id = ?', owner.orgId, member.userId);
    const closed = closeCode(v);
    v.send({ type: 'command', droneId: liveDroneId, command: 'arm', requestId: 'r-removed' });
    expect(await closed).toBe(4403);
    expect(v.find((m) => m.type === 'ack' && m.requestId === 'r-removed')).toBeUndefined();
  });

  it('closes sockets of a session that logs out and of a revoked API token', async () => {
    const login = await s.app.inject({ method: 'POST', url: '/api/v2/auth/login', payload: { email: owner.email, password: 'correct-horse-battery' } });
    const second = { cookie: cookieHeader(login.headers['set-cookie']), csrf: login.json().csrfToken };
    const bySession = new Viewer(`${s.wsBase}/api/v2/live?org=${owner.orgId}`, { cookie: second.cookie, origin: s.baseUrl });
    await bySession.opened;
    const sessionClosed = closeCode(bySession);
    await s.app.inject({ method: 'POST', url: '/api/v2/auth/logout', headers: { cookie: second.cookie, 'x-csrf-token': second.csrf } });
    expect(await sessionClosed).toBe(4401);

    const token = (await api(s.app, owner)('POST', '/api/v2/tokens', { name: 'ops', orgId: owner.orgId })).json();
    const byToken = new Viewer(`${s.wsBase}/api/v2/live?org=${owner.orgId}`, { authorization: `Bearer ${token.token}` });
    await byToken.opened;
    await byToken.wait((m) => m.type === 'hello');
    const tokenClosed = closeCode(byToken);
    await api(s.app, owner)('DELETE', `/api/v2/tokens/${token.id}`);
    expect(await tokenClosed).toBe(4401);
  });
});

describe('pluggable airspace providers (external GeoJSON feed)', () => {
  let feed: TestServer;
  let o: Session;
  let p: Session;
  let feedStatus = 200;
  const feedUrl = 'https://airspace.example.org/uas-zones.geojson';
  const center = destinationPoint(HOME, 45, 5000);
  const square = [0, 90, 180, 270, 0].map((b) => destinationPoint(center, b + 45, 400)).map((q) => [q.lon, q.lat]);
  const geojson = {
    type: 'FeatureCollection',
    features: [
      { type: 'Feature', id: 'TW-R-17', properties: { name: 'Restricted area R17', type: 'restricted', floor: 0, ceiling: 300 }, geometry: { type: 'Polygon', coordinates: [square] } },
      { type: 'Feature', properties: { name: 'Broken' }, geometry: { type: 'MultiPoint', coordinates: [] } },
    ],
  };
  const fetchImpl: typeof fetch = async (input) => {
    if (String(input) !== feedUrl) return new Response('not found', { status: 404 });
    return feedStatus === 200 ? new Response(JSON.stringify(geojson), { status: 200, headers: { 'content-type': 'application/geo+json' } }) : new Response('down', { status: feedStatus });
  };

  beforeAll(async () => {
    feed = await startServer({ fetchImpl, config: { airspaceFeeds: [{ id: 'caa', name: 'CAA UAS zones', url: feedUrl, refreshMinutes: 60 }] } });
    o = await signup(feed.app, { name: 'Feed Owner' });
    p = await signup(feed.app, { name: 'Feed Pilot' });
    await addMember(feed.app, o, p, 'pilot');
  });
  afterAll(async () => {
    await feed.close();
  });

  it('loads the feed, reports its status and serves its zones read-only to every organisation', async () => {
    const call = api(feed.app, o);
    const status = await waitFor(async () => (await call('GET', '/api/v2/airspace/providers')).json().find((x: any) => x.id === 'caa' && x.lastFetchAt));
    expect(status).toMatchObject({ kind: 'geojson-feed', name: 'CAA UAS zones', zoneCount: 1, skipped: 1, lastError: null });
    const zones = (await call('GET', `/api/v2/organisations/${o.orgId}/airspace/zones`)).json();
    const z = zones.find((x: any) => x.name === 'Restricted area R17');
    expect(z).toMatchObject({ id: 'feed:caa:TW-R-17', source: 'feed:caa', readOnly: true, ceilingM: 300 });
    expect((await call('PATCH', `/api/v2/organisations/${o.orgId}/airspace/zones/${z.id}`, { name: 'x' })).statusCode).toBe(409);
    expect((await call('DELETE', `/api/v2/organisations/${o.orgId}/airspace/zones/${z.id}`)).statusCode).toBe(409);
  });

  it('includes feed zones in airspace checks and authorisations', async () => {
    const call = api(feed.app, p);
    const at = (h: number) => new Date(Date.now() + h * 3_600_000).toISOString();
    const body = { geometry: { kind: 'cylinder', center, radiusM: 100 }, maxAltM: 60, startAt: at(1), endAt: at(2) };
    const check = (await call('POST', `/api/v2/organisations/${o.orgId}/airspace/check`, body)).json();
    expect(check.verdict).toBe('blocked');
    expect(check.conflicts.map((c: any) => c.name)).toContain('Restricted area R17');
    const auth = (await call('POST', `/api/v2/organisations/${o.orgId}/airspace/authorizations`, body)).json();
    expect(auth.status).toBe('rejected');
  });

  it('keeps serving the last good copy when the feed fails; manual refreshes are throttled', async () => {
    feedStatus = 503;
    // the feed was downloaded less than a minute ago: a manual refresh is a no-op
    const throttled = (await api(feed.app, p)('POST', '/api/v2/airspace/providers/caa/refresh')).json();
    expect(throttled).toMatchObject({ lastError: null, zoneCount: 1 });
    await (feed.ctx.airspace.provider('caa') as GeoJsonFeedProvider).refresh();
    const after = (await api(feed.app, o)('GET', '/api/v2/airspace/providers')).json().find((x: any) => x.id === 'caa');
    expect(after).toMatchObject({ lastError: 'HTTP 503', zoneCount: 1 });
    expect((await api(feed.app, o)('GET', `/api/v2/organisations/${o.orgId}/airspace/zones`)).json().some((x: any) => x.id === 'feed:caa:TW-R-17')).toBe(true);
    expect((await api(feed.app, o)('POST', '/api/v2/airspace/providers/org/refresh')).statusCode).toBe(404);
    feedStatus = 200;
  });

  it('validates ATHENA_AIRSPACE_FEEDS', () => {
    expect(parseAirspaceFeeds(undefined)).toEqual([]);
    expect(parseAirspaceFeeds('[{"id":"caa","url":"https://x.example/z.json"}]')).toEqual([{ id: 'caa', name: 'caa', url: 'https://x.example/z.json', refreshMinutes: 60 }]);
    expect(() => parseAirspaceFeeds('{')).toThrow(/JSON array/);
    expect(() => parseAirspaceFeeds('[{"id":"Bad Id","url":"https://x.example"}]')).toThrow(/slug/);
    expect(() => parseAirspaceFeeds('[{"id":"org","url":"https://x.example"}]')).toThrow(/slug/);
    expect(() => parseAirspaceFeeds('[{"id":"a","url":"ftp://x.example"}]')).toThrow(/http/);
    expect(() => parseAirspaceFeeds('[{"id":"a","url":"https://x.example"},{"id":"a","url":"https://y.example"}]')).toThrow(/duplicate/);
  });
});
