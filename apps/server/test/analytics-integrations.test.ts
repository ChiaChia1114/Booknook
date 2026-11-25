import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { destinationPoint, newItemId, zonedDayKey, type MissionPlan } from '@athena-sky/shared';
import { simulateMission } from '@athena-sky/simulator';
import { addMember, api, multipart, signup, startServer, waitFor, type Session, type TestServer } from './helpers';
import { seedDemo, DEMO_EMAIL, DEMO_PASSWORD } from '../src/demo/demo';

const HOME = { lat: 25.0732, lon: 121.5355 };
const received: { url: string; headers: Record<string, string>; body: any; raw: string }[] = [];
let failNext = 0;
const fakeFetch: typeof fetch = async (input, init) => {
  const url = String(input);
  const raw = init?.body instanceof Uint8Array ? Buffer.from(init.body).toString('utf8') : String(init?.body ?? 'null');
  let body: unknown = null;
  try {
    body = JSON.parse(raw);
  } catch {
    /* multipart / text body: see raw */
  }
  received.push({ url, headers: Object.fromEntries(new Headers(init?.headers).entries()), body, raw });
  if (failNext > 0) {
    failNext--;
    return new Response('boom', { status: 500 });
  }
  return new Response(null, { status: 204 });
};

let s: TestServer;
let owner: Session;
let pilot: Session;
const drones: Record<string, string> = {};
const fleets: Record<string, string> = {};

function plan(bearing: number, alt: number): MissionPlan {
  return {
    home: { ...HOME, alt: 8 },
    items: [
      { id: newItemId(), type: 'takeoff', alt },
      { id: newItemId(), type: 'waypoint', ...destinationPoint(HOME, bearing, 400), alt },
      { id: newItemId(), type: 'rtl' },
    ],
    rallyPoints: [],
    geofence: null,
    defaultSpeed: 10,
    defaultAlt: alt,
  };
}

async function uploadFlight(session: Session, droneId: string, p: MissionPlan, startTime: number) {
  const sim = simulateMission(p, { home: HOME, startTime, ulog: true, drone: { groundAltMsl: 8, seed: startTime % 1000 } });
  const mp = multipart({ droneId }, [{ field: 'file', filename: `f${startTime}.ulg`, content: sim.ulog! }]);
  const res = await s.app.inject({ method: 'POST', url: `/api/v2/organisations/${owner.orgId}/flights/upload`, headers: { cookie: session.cookie, 'x-csrf-token': session.csrf, 'content-type': mp.contentType }, payload: mp.body });
  if (res.statusCode !== 201) throw new Error(res.body);
  return res.json();
}

beforeAll(async () => {
  s = await startServer({ fetchImpl: fakeFetch, allowPrivateTargets: false, webhookRetryDelaysMs: [50, 50] });
  owner = await signup(s.app, { name: 'Ada Owner' });
  pilot = await signup(s.app, { name: 'Pete Pilot' });
  const call = api(s.app, owner);
  await addMember(s.app, owner, pilot, 'pilot');
  fleets.a = (await call('POST', `/api/v2/organisations/${owner.orgId}/fleets`, { name: 'Alpha' })).json().id;
  fleets.b = (await call('POST', `/api/v2/organisations/${owner.orgId}/fleets`, { name: 'Bravo' })).json().id;
  drones.a1 = (await call('POST', `/api/v2/organisations/${owner.orgId}/drones`, { name: 'A1', fleetId: fleets.a })).json().id;
  drones.b1 = (await call('POST', `/api/v2/organisations/${owner.orgId}/drones`, { name: 'B1', fleetId: fleets.b })).json().id;
  await call('POST', `/api/v2/organisations/${owner.orgId}/airspace/zones`, {
    name: 'No-fly',
    type: 'prohibited',
    geometry: { kind: 'circle', center: destinationPoint(HOME, 180, 400), radiusM: 120 },
  });
  const day = 86_400_000;
  const now = Date.now();
  await uploadFlight(owner, drones.a1!, plan(0, 40), now - 3 * day);
  await uploadFlight(pilot, drones.a1!, plan(90, 40), now - 2 * day);
  await uploadFlight(pilot, drones.a1!, plan(45, 140), now - 2 * day + 3_600_000); // above 120 m
  await uploadFlight(pilot, drones.b1!, plan(180, 40), now - day); // through the no-fly zone
  await uploadFlight(pilot, drones.b1!, plan(270, 40), now - 40 * day); // outside the default 30-day window
});
afterAll(async () => {
  await s.close();
});

describe('F2 dashboard', () => {
  it('summarises assets, users and flights with time and fleet filters', async () => {
    const call = api(s.app, owner);
    const d = (await call('GET', `/api/v2/organisations/${owner.orgId}/analytics/dashboard`)).json();
    expect(d.totals).toMatchObject({ drones: 2, members: 2, pilots: 2, flights: 4, dronesOnline: 0 });
    expect(d.totals.flightTimeS).toBeGreaterThan(200);
    expect(d.flightsPerDay.length).toBeGreaterThanOrEqual(30);
    expect(d.flightsPerDay.reduce((n: number, x: any) => n + x.flights, 0)).toBe(4);
    expect(d.recentFlights).toHaveLength(4);
    expect(d.topDrones[0].name).toBe('A1');
    const alpha = (await call('GET', `/api/v2/organisations/${owner.orgId}/analytics/dashboard?fleetId=${fleets.a}`)).json();
    expect(alpha.totals).toMatchObject({ drones: 1, flights: 3 });
    const longRange = (await call('GET', `/api/v2/organisations/${owner.orgId}/analytics/dashboard?from=${new Date(Date.now() - 60 * 86_400_000).toISOString()}`)).json();
    expect(longRange.totals.flights).toBe(5);
    expect((await call('GET', `/api/v2/organisations/${owner.orgId}/analytics/dashboard?from=garbage`)).statusCode).toBe(400);
  });

  it("counts flights per day in the viewer's time zone", async () => {
    const call = api(s.app, owner);
    const starts = s.ctx.db.all<{ started_at: string }>('SELECT started_at FROM flights WHERE org_id = ? AND started_at >= ?', owner.orgId, new Date(Date.now() - 30 * 86_400_000).toISOString());
    expect(starts).toHaveLength(4);
    for (const tz of ['UTC', 'Asia/Taipei', 'Pacific/Kiritimati', 'America/Los_Angeles']) {
      const d = (await call('GET', `/api/v2/organisations/${owner.orgId}/analytics/dashboard?tz=${encodeURIComponent(tz)}`)).json();
      const key = zonedDayKey(tz);
      const expected = new Map<string, number>();
      for (const f of starts) expected.set(key(f.started_at), (expected.get(key(f.started_at)) ?? 0) + 1);
      const got = new Map<string, number>(d.flightsPerDay.filter((x: any) => x.flights > 0).map((x: any) => [x.date, x.flights]));
      expect(got).toEqual(expected);
      // Every day of the period, today (there) included, once.
      expect(d.flightsPerDay.at(-1).date).toBe(key(Date.now()));
      expect(new Set(d.flightsPerDay.map((x: any) => x.date)).size).toBe(d.flightsPerDay.length);
    }
    expect((await call('GET', `/api/v2/organisations/${owner.orgId}/analytics/dashboard?tz=Mars%2FOlympus`)).statusCode).toBe(400);
  });
});

describe('F3 drones and operators', () => {
  it('finds the most used drone, the most experienced and the most active pilot', async () => {
    const r = (await api(s.app, owner)('GET', `/api/v2/organisations/${owner.orgId}/analytics/drones-operators`)).json();
    expect(r.highlights.mostUsedDrone.name).toBe('A1');
    expect(r.highlights.mostActivePilot.name).toBe('Pete Pilot');
    expect(r.highlights.mostActivePilot.flights).toBe(4);
    expect(r.highlights.mostExperiencedPilot.name).toBe('Pete Pilot');
    const ada = r.operators.find((o: any) => o.name === 'Ada Owner');
    expect(ada).toMatchObject({ flights: 1, dronesFlown: 1 });
    const pete = r.operators.find((o: any) => o.name === 'Pete Pilot');
    expect(pete.dronesFlown).toBe(2);
    expect(r.drones.find((d: any) => d.name === 'B1').pilots).toBe(1);
  });
});

describe('F4 flight locations and compliance', () => {
  it('maps flights with compliance status and filters', async () => {
    const call = api(s.app, owner);
    const r = (await call('GET', `/api/v2/organisations/${owner.orgId}/analytics/locations?from=${new Date(Date.now() - 60 * 86_400_000).toISOString()}`)).json();
    expect(r.summary).toMatchObject({ flights: 5, compliant: 3, nonCompliant: 2 });
    const bad = r.points.filter((p: any) => p.compliant === false).flatMap((p: any) => p.violations).join(' | ');
    expect(bad).toMatch(/exceeded the 120 m limit/);
    expect(bad).toMatch(/prohibited airspace "No-fly"/);
    expect(r.points[0].track.length).toBeGreaterThan(5);
    const only = (await call('GET', `/api/v2/organisations/${owner.orgId}/analytics/locations?compliance=non_compliant&fleetId=${fleets.b}`)).json();
    expect(only.points).toHaveLength(1);
    expect(only.points[0].droneName).toBe('B1');
  });

  it('counts every flight of the period and lists them a page at a time, per drone if asked', async () => {
    const call = api(s.app, owner);
    const base = `/api/v2/organisations/${owner.orgId}/analytics/locations?from=${new Date(Date.now() - 60 * 86_400_000).toISOString()}`;
    const all = (await call('GET', base)).json();
    expect(all).toMatchObject({ total: 5, offset: 0 });
    const ids: string[] = [];
    for (let offset = 0; offset < all.total; offset += 2) {
      const page = (await call('GET', `${base}&limit=2&offset=${offset}`)).json();
      expect(page).toMatchObject({ total: 5, offset });
      // The summary is over the whole period, not over the page.
      expect(page.summary).toEqual(all.summary);
      ids.push(...page.points.map((p: any) => p.flightId));
    }
    expect(ids).toEqual(all.points.map((p: any) => p.flightId));
    // The compliance filter runs before paging: older violations are not cut off by newer flights.
    const bad = (await call('GET', `${base}&compliance=non_compliant&limit=1&offset=1`)).json();
    expect(bad).toMatchObject({ total: 2, offset: 1, summary: all.summary });
    expect(bad.points).toHaveLength(1);
    expect(bad.points[0].compliant).toBe(false);
    const one = (await call('GET', `${base}&droneId=${drones.a1}`)).json();
    expect(one.points.length).toBeGreaterThan(0);
    expect(one.points.every((p: any) => p.droneId === drones.a1)).toBe(true);
    expect(one.summary.flights).toBe(one.total);
    expect(one.total).toBeLessThan(all.total);
  });

  it('shows where each drone has been: the tracks of its latest flights', async () => {
    const call = api(s.app, owner);
    const base = `/api/v2/organisations/${owner.orgId}/fleet/tracks`;
    const all = (await call('GET', `${base}?days=60`)).json();
    expect(all.days).toBe(60);
    const a1 = all.drones.find((d: any) => d.droneId === drones.a1);
    expect(a1.flights.length).toBeGreaterThan(1);
    expect(a1.flights[0].track.length).toBeGreaterThan(5);
    // Newest first, and as many as asked.
    expect(a1.flights.map((f: any) => f.startedAt)).toEqual([...a1.flights.map((f: any) => f.startedAt)].sort().reverse());
    const one = (await call('GET', `${base}?days=60&droneId=${drones.a1}&perDrone=1`)).json();
    expect(one.drones).toHaveLength(1);
    expect(one.drones[0].flights).toHaveLength(1);
    expect(one.drones[0].flights[0].flightId).toBe(a1.flights[0].flightId);
    const fleetB = (await call('GET', `${base}?days=60&fleetId=${fleets.b}`)).json();
    expect(fleetB.drones.map((d: any) => d.droneName)).toEqual(['B1']);
    // Another organisation sees none of them.
    const stranger = await signup(s.app);
    expect((await api(s.app, stranger)('GET', `${base}?days=60`)).statusCode).toBe(404);
    // Drones a page at a time (by name), with their total.
    const first = (await call('GET', `${base}?days=60&limit=1`)).json();
    expect(first).toMatchObject({ total: 2, offset: 0 });
    expect(first.drones.map((d: any) => d.droneName)).toEqual(['A1']);
    expect((await call('GET', `${base}?days=60&limit=1&offset=1`)).json().drones.map((d: any) => d.droneName)).toEqual(['B1']);
  });

  it('refuses malformed filters with 400', async () => {
    const call = api(s.app, owner);
    const org = `/api/v2/organisations/${owner.orgId}`;
    for (const q of ['offset=1e308', 'offset=-1', 'limit=0', 'limit=abc', `fleetId=${fleets.a}&fleetId=${fleets.b}`, 'droneId=nope', 'compliance=bad']) {
      expect((await call('GET', `${org}/analytics/locations?${q}`)).statusCode, q).toBe(400);
    }
    for (const q of ['days=0', 'days=1e308', 'perDrone=abc', `fleetId=${fleets.a}&fleetId=${fleets.b}`, 'limit=501']) {
      expect((await call('GET', `${org}/fleet/tracks?${q}`)).statusCode, q).toBe(400);
    }
    // The flight list as well: no silent correction of a malformed page.
    for (const q of ['limit=abc', 'limit=0', 'limit=501', 'offset=-1', 'offset=1.5', 'limit=0x10', 'limit=1e2', 'limit=%2010', 'limit=']) {
      expect((await call('GET', `${org}/flights?${q}`)).statusCode, q).toBe(400);
    }
    expect((await call('GET', `${org}/flights?limit=2&offset=1`)).json()).toMatchObject({ limit: 2, offset: 1 });
    // Whole numbers are written plainly in every query (the validator would read "1e2" as 100).
    for (const q of ['days=1e1', 'perDrone=0x5', 'limit=1e2']) {
      const r = await call('GET', `${org}/fleet/tracks?${q}`);
      expect(r.statusCode, q).toBe(400);
      expect(r.json().message).toMatch(/must be a whole number/);
    }
    // The audit trail as well.
    for (const q of ['limit=abc', 'limit=0', 'limit=501', 'offset=-1', 'limit=1e2']) {
      expect((await call('GET', `${org}/audit?${q}`)).statusCode, q).toBe(400);
    }
    expect((await call('GET', `${org}/audit?limit=1&offset=0`)).json().items).toHaveLength(1);
  });

  it('applies the organisation altitude limit setting', async () => {
    const call = api(s.app, owner);
    const upd = await call('PATCH', `/api/v2/organisations/${owner.orgId}`, { settings: { maxAltitudeM: 150 } });
    expect(upd.json().settings.maxAltitudeM).toBe(150);
    const f = await uploadFlight(owner, drones.a1!, plan(10, 140), Date.now() - 5 * 3_600_000);
    expect(f.compliance.compliant).toBe(true);
  });
});

describe('F12 integrations: webhooks and logbook export', () => {
  it('rejects webhooks to private networks (SSRF) but accepts public URLs', async () => {
    const call = api(s.app, owner);
    expect((await call('POST', `/api/v2/organisations/${owner.orgId}/webhooks`, { url: 'ftp://x.example.com', events: ['flight.ended'] })).statusCode).toBe(400);
    // Refused when saved: IP literals and local names of private / loopback networks …
    for (const url of ['http://127.0.0.1:9/x', 'http://10.0.0.5/hook', 'http://169.254.169.254/latest/meta-data', 'http://[::1]/x', 'http://[::ffff:192.168.1.1]/x', 'http://localhost:8080/x', 'http://localhost./x', 'http://api.localhost../x', 'https://printer.local/x']) {
      const res = await call('POST', `/api/v2/organisations/${owner.orgId}/webhooks`, { url, events: ['flight.ended'] });
      expect(res.statusCode, url).toBe(400);
      expect(res.json().message).toMatch(/private or loopback/);
    }
    expect((await call('PUT', `/api/v2/organisations/${owner.orgId}/integrations/logbook`, { enabled: true, provider: 'dronelogbook', endpointUrl: 'http://192.168.0.10/import', autoExport: false })).statusCode).toBe(400);
    // … and blocked again when delivering (a name may resolve differently later: DNS rebinding).
    const priv = await call('POST', `/api/v2/organisations/${owner.orgId}/webhooks`, { url: 'https://8.8.8.8/later-private', events: ['flight.ended'] });
    expect(priv.statusCode).toBe(201);
    expect((await call('PATCH', `/api/v2/organisations/${owner.orgId}/webhooks/${priv.json().id}`, { url: 'http://127.0.0.1:9/x' })).statusCode).toBe(400);
    s.ctx.db.run('UPDATE webhooks SET url = ? WHERE id = ?', 'http://127.0.0.1:9/x', priv.json().id);
    s.ctx.webhooks.invalidate(owner.orgId);
    const test = await call('POST', `/api/v2/organisations/${owner.orgId}/webhooks/${priv.json().id}/test`);
    await new Promise((r) => setTimeout(r, 200));
    const deliveries = await call('GET', `/api/v2/organisations/${owner.orgId}/webhooks/${priv.json().id}/deliveries`);
    const d = deliveries.json().find((x: any) => x.id === test.json().deliveryId);
    expect(d.delivered).toBe(false);
    expect(d.error).toMatch(/private or loopback/);
    expect(received.some((r) => r.url.startsWith('http://127.0.0.1:9'))).toBe(false);
    await call('DELETE', `/api/v2/organisations/${owner.orgId}/webhooks/${priv.json().id}`);
  });

  it('signs deliveries, retries failures and only sends subscribed events', async () => {
    const call = api(s.app, owner);
    const hook = await call('POST', `/api/v2/organisations/${owner.orgId}/webhooks`, { url: 'https://8.8.8.8/athena', events: ['flight.ended', 'alert.raised'] });
    expect(hook.statusCode).toBe(201);
    expect(hook.json().secret).toMatch(/^whsec_/);
    const list = await call('GET', `/api/v2/organisations/${owner.orgId}/webhooks`);
    expect(JSON.stringify(list.json())).not.toContain(hook.json().secret);
    failNext = 1;
    received.length = 0;
    await uploadFlight(pilot, drones.b1!, plan(300, 30), Date.now() - 4 * 3_600_000);
    const got = await waitFor(() => received.find((r) => r.url === 'https://8.8.8.8/athena' && r.body?.event === 'flight.ended' && received.filter((x) => x.body?.id === r.body.id).length >= 2), 5000);
    expect(got.headers['x-athena-signature']).toMatch(/^sha256=[0-9a-f]{64}$/);
    expect(got.headers['x-athena-event']).toBe('flight.ended');
    expect(received.some((r) => r.body?.event === 'flight.analyzed')).toBe(false);
    const deliveries = (await call('GET', `/api/v2/organisations/${owner.orgId}/webhooks/${hook.json().id}/deliveries`)).json();
    expect(deliveries.find((d: any) => d.event === 'flight.ended')).toMatchObject({ delivered: true, attempts: 2, statusCode: 204 });
  });

  it('exports flights to an external logbook (DroneLogbook connector)', async () => {
    const call = api(s.app, owner);
    // Every member can see whether export is available (the Export button), not the settings.
    const status = () => call('GET', `/api/v2/organisations/${owner.orgId}/integrations/logbook/status`).then((r) => r.json());
    expect(await status()).toEqual({ enabled: false });
    const cfg = await call('PUT', `/api/v2/organisations/${owner.orgId}/integrations/logbook`, { enabled: true, provider: 'dronelogbook', endpointUrl: 'https://8.8.4.4/logbook/import', autoExport: false, apiKey: 'dlb-secret-key' });
    // the provider id of earlier versions maps to the JSON record format
    expect(cfg.json()).toMatchObject({ enabled: true, hasApiKey: true, provider: 'json' });
    expect(await status()).toEqual({ enabled: true });
    expect(JSON.stringify(cfg.json())).not.toContain('dlb-secret-key');
    const flights = (await call('GET', `/api/v2/organisations/${owner.orgId}/flights`)).json().items;
    received.length = 0;
    const r = await call('POST', `/api/v2/organisations/${owner.orgId}/flights/${flights[0].id}/logbook-export`);
    expect(r.json()).toMatchObject({ ok: true, status: 204 });
    const sent = received.find((x) => x.url === 'https://8.8.4.4/logbook/import')!;
    expect(sent.headers.authorization).toBe('Bearer dlb-secret-key');
    expect(sent.body.flight).toMatchObject({ id: flights[0].id, drone: expect.any(String) });
    expect(sent.body.trackCsv.split('\n').length).toBeGreaterThan(10);
    const after = (await call('GET', `/api/v2/organisations/${owner.orgId}/integrations/logbook`)).json();
    expect(after.lastStatus).toBe(`exported ${flights[0].id}`);
    // auto-export on new flights
    await call('PUT', `/api/v2/organisations/${owner.orgId}/integrations/logbook`, { enabled: true, provider: 'dronelogbook', endpointUrl: 'https://8.8.4.4/logbook/import', autoExport: true });
    received.length = 0;
    const f = await uploadFlight(pilot, drones.a1!, plan(200, 30), Date.now() - 2 * 3_600_000);
    await waitFor(() => received.find((x) => x.url === 'https://8.8.4.4/logbook/import' && x.body?.flight?.id === f.id), 5000);
  });

  it('offers pluggable logbook formats, including a multipart log-file upload', async () => {
    const call = api(s.app, owner);
    const providers = (await call('GET', '/api/v2/integrations/logbook/providers')).json();
    expect(providers.map((p: any) => p.id)).toEqual(['json', 'csv-upload']);
    expect((await call('PUT', `/api/v2/organisations/${owner.orgId}/integrations/logbook`, { enabled: true, provider: 'nope', endpointUrl: 'https://8.8.4.4/x', autoExport: false })).statusCode).toBe(400);
    await call('PUT', `/api/v2/organisations/${owner.orgId}/integrations/logbook`, { enabled: true, provider: 'csv-upload', endpointUrl: 'https://8.8.4.4/logbook/upload', autoExport: false });
    const flights = (await call('GET', `/api/v2/organisations/${owner.orgId}/flights`)).json().items;
    received.length = 0;
    const r = await call('POST', `/api/v2/organisations/${owner.orgId}/flights/${flights[0].id}/logbook-export`);
    expect(r.json()).toMatchObject({ ok: true });
    const sent = received.find((x) => x.url === 'https://8.8.4.4/logbook/upload')!;
    const boundary = /^multipart\/form-data; boundary=(.+)$/.exec(sent.headers['content-type']!)![1]!;
    expect(sent.headers.authorization).toBe('Bearer dlb-secret-key');
    const parts = sent.raw.split(`--${boundary}`).slice(1, -1);
    expect(parts).toHaveLength(4);
    expect(parts[0]).toContain(`Content-Disposition: form-data; name="file"; filename="athena-flight-${flights[0].id}.csv"`);
    expect(parts[0]).toContain('Content-Type: text/csv');
    expect(parts[0]!.split('\r\n\r\n')[1]!.split('\n')[0]).toContain('time_utc,time_ms,lat,lon');
    expect(JSON.parse(parts[1]!.split('\r\n\r\n')[1]!.trim())).toMatchObject({ id: flights[0].id });
    expect(sent.raw.endsWith(`--${boundary}--\r\n`)).toBe(true);
  });
});

describe('Demo mode', () => {
  it('seeds a complete organisation with history, anomalies and future work', async () => {
    const drones = await seedDemo(s.ctx);
    expect(drones.length).toBeGreaterThanOrEqual(3);
    const login = await s.app.inject({ method: 'POST', url: '/api/v2/auth/login', payload: { email: DEMO_EMAIL, password: DEMO_PASSWORD } });
    expect(login.statusCode).toBe(200);
    const orgId = login.json().memberships[0].orgId;
    const cookie = String(login.headers['set-cookie']).split(';')[0]!;
    const get = (url: string) => s.app.inject({ method: 'GET', url, headers: { cookie } }).then((r) => r.json());
    const dash = await get(`/api/v2/organisations/${orgId}/analytics/dashboard`);
    expect(dash.totals.flights).toBeGreaterThan(20);
    expect(dash.totals.members).toBe(4);
    const heron = (await get(`/api/v2/organisations/${orgId}/drones`)).find((d: any) => d.name === 'Heron-3');
    expect(heron.nextMission).toBeTruthy();
    const heronFlights = (await get(`/api/v2/organisations/${orgId}/flights?droneId=${heron.id}&limit=1`)).items;
    const analysis = await get(`/api/v2/organisations/${orgId}/flights/${heronFlights[0].id}/analysis`);
    expect(analysis.findings.map((f: any) => f.code).join(',')).toMatch(/motor_imbalance|anomaly_motorImbalance/);
    expect((await get(`/api/v2/organisations/${orgId}/airspace/zones`)).length).toBe(4);
    // idempotent
    const again = await seedDemo(s.ctx);
    expect(again.map((d) => d.id)).toEqual(drones.map((d) => d.id));
  });
});
