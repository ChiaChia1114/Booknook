/**
 * Maintenance schedules and predictive maintenance, compliance & performance reports, the
 * activity heatmap, metric trends with anomalies, per-user preferences and the route
 * conformance of mission flights.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DEFAULT_MAINTENANCE_PLAN, destinationPoint, newItemId, type MissionPlan } from '@athena-sky/shared';
import { simulateMission } from '@athena-sky/simulator';
import { addMember, api, multipart, signup, startServer, type Session, type TestServer } from './helpers';

const HOME = { lat: 25.0732, lon: 121.5355 };
const DAY = 86_400_000;

let s: TestServer;
let owner: Session;
let pilot: Session;
let viewer: Session;
let m1: string;
let m2: string;
let fleet: string;
const m1Flights: string[] = [];
let m2Flight: string;
const tasks: Record<string, string> = {};

function plan(bearing: number, alt = 40): MissionPlan {
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

async function upload(session: Session, droneId: string, p: MissionPlan, startTime: number): Promise<string> {
  const sim = simulateMission(p, { home: HOME, startTime, ulog: true, drone: { groundAltMsl: 8, seed: startTime % 997 } });
  const mp = multipart({ droneId }, [{ field: 'file', filename: `m${startTime}.ulg`, content: sim.ulog! }]);
  const res = await s.app.inject({ method: 'POST', url: `/api/v2/organisations/${owner.orgId}/flights/upload`, headers: { cookie: session.cookie, 'x-csrf-token': session.csrf, 'content-type': mp.contentType }, payload: mp.body });
  if (res.statusCode !== 201) throw new Error(res.body);
  return res.json().id;
}

const org = () => `/api/v2/organisations/${owner.orgId}`;
const setMetric = (flightId: string, metric: string, value: number) =>
  s.ctx.db.run(`UPDATE flight_analyses SET metrics = json_set(metrics, '$.${metric}', ?) WHERE flight_id = ?`, value, flightId);

beforeAll(async () => {
  s = await startServer();
  owner = await signup(s.app, { name: 'Olga Owner' });
  pilot = await signup(s.app, { name: 'Pia Pilot' });
  viewer = await signup(s.app, { name: 'Vic Viewer' });
  const call = api(s.app, owner);
  await addMember(s.app, owner, pilot, 'pilot');
  await addMember(s.app, owner, viewer, 'viewer');
  fleet = (await call('POST', `${org()}/fleets`, { name: 'Ops' })).json().id;
  m1 = (await call('POST', `${org()}/drones`, { name: 'M1', fleetId: fleet })).json().id;
  m2 = (await call('POST', `${org()}/drones`, { name: 'M2' })).json().id;
  const now = Date.now();
  // M1: 8 flights 9 … 2 days ago (owner and pilot alternating), M2: one flight yesterday.
  for (let i = 0; i < 8; i++) m1Flights.push(await upload(i % 2 ? pilot : owner, m1, plan(i * 45), now - (9 - i) * DAY));
  m2Flight = await upload(pilot, m2, plan(200), now - DAY);
}, 120_000);

afterAll(async () => {
  await s.close();
});

describe('maintenance schedules', () => {
  it('computes when tasks are due by flights, days and flight hours', async () => {
    const call = api(s.app, owner);
    const a = await call('POST', `${org()}/drones/${m1}/maintenance/tasks`, { name: 'Propeller check', intervalFlights: 5 });
    expect(a.statusCode).toBe(201);
    expect(a.json()).toMatchObject({ lastDoneFlights: 8, due: { status: 'ok', remainingFlights: 5 } });
    tasks.a = a.json().id;
    // Pretend it was last done 10 days ago, before all eight flights.
    const ago = new Date(Date.now() - 10 * DAY).toISOString();
    s.ctx.db.run('UPDATE maintenance_tasks SET last_done_at = ?, base_at = ?, last_done_flights = 0, base_flights = 0, last_done_hours = 0, base_hours = 0 WHERE id = ?', ago, ago, tasks.a);

    tasks.b = (await call('POST', `${org()}/drones/${m1}/maintenance/tasks`, { name: 'Airframe inspection', intervalDays: 10 })).json().id;
    const doneAt = new Date(Date.now() - 9.5 * DAY).toISOString();
    const b = await call('POST', `${org()}/maintenance/tasks/${tasks.b}/complete`, { doneAt, notes: 'Arms and landing gear' });
    expect(b.statusCode).toBe(200);
    tasks.c = (await call('POST', `${org()}/drones/${m1}/maintenance/tasks`, { name: 'Motor service', intervalHours: 1 })).json().id;

    const m = (await call('GET', `${org()}/drones/${m1}/maintenance`)).json();
    expect(m.usage.flights).toBe(8);
    const byName = (n: string) => m.tasks.find((t: any) => t.name === n);
    expect(byName('Propeller check').due).toMatchObject({ status: 'overdue', driver: 'flights', remainingFlights: -3, used: 1.6 });
    const insp = byName('Airframe inspection').due;
    expect(insp).toMatchObject({ status: 'due_soon', driver: 'days' });
    expect(insp.remainingDays).toBeCloseTo(0.5, 1);
    expect(Math.abs(Date.parse(insp.dueDate) - (Date.parse(doneAt) + 10 * DAY))).toBeLessThan(1000);
    expect(byName('Motor service').due).toMatchObject({ status: 'ok', driver: 'hours', remainingHours: 1 });
    // Most urgent first.
    expect(m.tasks[0].name).toBe('Propeller check');
    // The completion is in the log with the usage at that time.
    expect(m.records).toContainEqual(expect.objectContaining({ taskId: tasks.b, title: 'Airframe inspection', flights: 0, notes: 'Arms and landing gear', doneByName: 'Olga Owner' }));
  });

  it('validates tasks and restricts scheduling to drone managers', async () => {
    const call = api(s.app, owner);
    expect((await call('POST', `${org()}/drones/${m1}/maintenance/tasks`, { name: 'No interval' })).statusCode).toBe(400);
    expect((await call('POST', `${org()}/drones/${m1}/maintenance/tasks`, { name: '   ', intervalDays: 5 })).statusCode).toBe(400);
    expect((await call('PATCH', `${org()}/maintenance/tasks/${tasks.c}`, { name: ' ' })).statusCode).toBe(400);
    expect((await call('POST', `${org()}/drones/${m1}/maintenance/tasks`, { name: 'Negative', intervalHours: -1 })).statusCode).toBe(400);
    expect((await call('POST', `${org()}/drones/${m1}/maintenance/tasks`, { name: 'Stranger', intervalDays: 5, assigneeId: '00000000-0000-4000-8000-000000000000' })).statusCode).toBe(400);
    expect((await api(s.app, pilot)('POST', `${org()}/drones/${m1}/maintenance/tasks`, { name: 'By pilot', intervalDays: 5 })).statusCode).toBe(403);
    expect((await api(s.app, pilot)('POST', `${org()}/drones/${m1}/maintenance/default-plan`)).statusCode).toBe(403);
  });

  it('notifies tasks that become due, once per change', async () => {
    s.ctx.maintenance.check();
    s.ctx.maintenance.check(m1);
    const list = (await api(s.app, owner)('GET', `${org()}/notifications?limit=100`)).json();
    const overdue = list.items.filter((n: any) => n.code === 'maintenance_overdue');
    const soon = list.items.filter((n: any) => n.code === 'maintenance_due_soon');
    expect(overdue).toHaveLength(1);
    expect(overdue[0]).toMatchObject({ category: 'maintenance', level: 'warning', droneId: m1 });
    expect(overdue[0].message).toContain('Propeller check on M1 is overdue');
    expect(soon).toHaveLength(1);
    expect(soon[0].message).toMatch(/Airframe inspection on M1 is due in 1 days/);
    // Editing the notes does not change when it is due: no second notification.
    await api(s.app, owner)('PATCH', `${org()}/maintenance/tasks/${tasks.a}`, { notes: 'Use the 13-inch set' });
    s.ctx.maintenance.check();
    const again = (await api(s.app, owner)('GET', `${org()}/notifications?limit=100`)).json();
    expect(again.items.filter((n: any) => n.code === 'maintenance_overdue')).toHaveLength(1);
  });

  it('lets drone managers and the assignee complete a task, which restarts its interval', async () => {
    const call = api(s.app, owner);
    const patched = await call('PATCH', `${org()}/maintenance/tasks/${tasks.a}`, { assigneeId: pilot.userId });
    expect(patched.json()).toMatchObject({ assigneeId: pilot.userId, assigneeName: 'Pia Pilot' });
    expect((await api(s.app, viewer)('POST', `${org()}/maintenance/tasks/${tasks.a}/complete`, {})).statusCode).toBe(403);
    expect((await api(s.app, pilot)('POST', `${org()}/maintenance/tasks/${tasks.b}/complete`, {})).statusCode).toBe(403);
    expect((await api(s.app, pilot)('POST', `${org()}/maintenance/tasks/${tasks.a}/complete`, { doneAt: new Date(Date.now() + 3_600_000).toISOString() })).statusCode).toBe(400);
    const done = await api(s.app, pilot)('POST', `${org()}/maintenance/tasks/${tasks.a}/complete`, { notes: 'New propellers' });
    expect(done.statusCode).toBe(200);
    expect(done.json()).toMatchObject({ lastDoneFlights: 8, due: { status: 'ok', remainingFlights: 5 } });

    expect((await api(s.app, pilot)('POST', `${org()}/drones/${m1}/maintenance/records`, { title: 'Swapped a motor' })).statusCode).toBe(403);
    expect((await call('POST', `${org()}/drones/${m1}/maintenance/records`, { title: 'Replaced motor 3', notes: 'Bearing noise' })).statusCode).toBe(201);
    const m = (await call('GET', `${org()}/drones/${m1}/maintenance`)).json();
    expect(m.records).toContainEqual(expect.objectContaining({ taskId: tasks.a, title: 'Propeller check', doneByName: 'Pia Pilot', notes: 'New propellers', flights: 8 }));
    expect(m.records).toContainEqual(expect.objectContaining({ taskId: null, title: 'Replaced motor 3', doneByName: 'Olga Owner' }));

    expect((await api(s.app, pilot)('DELETE', `${org()}/maintenance/tasks/${tasks.c}`)).statusCode).toBe(403);
    expect((await call('DELETE', `${org()}/maintenance/tasks/${tasks.c}`)).statusCode).toBe(204);
    expect((await call('GET', `${org()}/drones/${m1}/maintenance`)).json().tasks.map((t: any) => t.name)).not.toContain('Motor service');
  });

  it('adds the default plan once and summarises the fleet', async () => {
    const call = api(s.app, owner);
    await call('POST', `${org()}/drones/${m2}/maintenance/default-plan`);
    const again = (await call('POST', `${org()}/drones/${m2}/maintenance/default-plan`)).json();
    expect(again.map((t: any) => t.name).sort()).toEqual(DEFAULT_MAINTENANCE_PLAN.map((t) => t.name).sort());
    const o = (await api(s.app, viewer)('GET', `${org()}/maintenance`)).json();
    const d1 = o.drones.find((d: any) => d.droneName === 'M1');
    expect(d1).toMatchObject({ overdue: 0, dueSoon: 1, usage: { flights: 8 } });
    expect(d1.next.name).toBe('Airframe inspection');
    expect(o.drones.find((d: any) => d.droneName === 'M2')).toMatchObject({ overdue: 0, dueSoon: 0, usage: { flights: 1 } });
    expect(o.counts).toMatchObject({ overdue: 0, dueSoon: 1 });
    // The fleet total comes from the flights, not from the per-drone figures rounded to 0.1 h.
    const secs = s.ctx.db.get<{ s: number }>('SELECT SUM(f.duration_s) AS s FROM flights f JOIN drones d ON d.id = f.drone_id WHERE d.org_id = ?', owner.orgId)!.s;
    expect(o.fleetHours).toBeCloseTo(secs / 3600, 2);
  });
});

describe('predictive maintenance', () => {
  it('predicts from the trend of a health metric and alerts once', async () => {
    const vib = [12, 15, 18, 21, 24, 27, 30.5, 33];
    m1Flights.forEach((id, i) => {
      setMetric(id, 'vibrationMean', vib[i]!);
      setMetric(id, 'motorImbalance', 0.02);
    });
    const m = (await api(s.app, owner)('GET', `${org()}/drones/${m1}/maintenance`)).json();
    expect(m.series.vibrationMean.map((p: any) => p.value)).toEqual(vib);
    expect(m.series.vibrationMean[7].hours).toBeGreaterThan(m.series.vibrationMean[0].hours);
    const v = m.health.find((h: any) => h.indicator.metric === 'vibrationMean');
    expect(v).toMatchObject({ level: 'action', exceeded: true, points: 8 });
    expect(v.slopePerHour).toBeGreaterThan(0);
    expect(m.health.find((h: any) => h.indicator.metric === 'motorImbalance')).toMatchObject({ level: 'ok', exceeded: false });

    s.ctx.maintenance.check(m1);
    s.ctx.maintenance.check(m1);
    const list = (await api(s.app, owner)('GET', `${org()}/notifications?limit=100`)).json();
    const pred = list.items.filter((n: any) => n.code === 'predictive_maintenance');
    expect(pred).toHaveLength(1);
    expect(pred[0].message).toContain('Vibration of M1 has reached its limit');
    expect(pred[0].message).toMatch(/\(now \d+\.\d m\/s², limit 30 m\/s²\)/);
    expect((await api(s.app, owner)('GET', `${org()}/maintenance`)).json().counts.healthActions).toBe(1);
  });
});

describe('reports', () => {
  const from = () => new Date(Date.now() - 30 * DAY).toISOString();

  it('reports performance and compliance, including flights flown with overdue maintenance', async () => {
    const r = (await api(s.app, viewer)('GET', `${org()}/reports/flights?from=${encodeURIComponent(from())}`)).json();
    expect(r.sections).toEqual(['summary', 'performance', 'compliance', 'maintenance', 'ai', 'flights']);
    expect(r.summary).toMatchObject({ flights: 9, drones: 2, pilots: 2, missionFlights: 0 });
    expect(r.performance.byDrone.find((x: any) => x.name === 'M1')).toMatchObject({ flights: 8 });
    // Totals are the stored durations and distances added up, rounded once – as on the dashboard.
    const sums = s.ctx.db.get<{ s: number; m: number }>('SELECT SUM(duration_s) AS s, SUM(distance_m) AS m FROM flights WHERE org_id = ?', owner.orgId)!;
    expect(r.summary.hours).toBe(Math.round((sums.s / 3600) * 10) / 10);
    expect(r.summary.distanceKm).toBe(Math.round((sums.m / 1000) * 100) / 100);
    expect(r.summary.avgDurationMin).toBe(Math.round((sums.s / 60 / 9) * 10) / 10);
    expect(r.performance.byPilot.map((x: any) => [x.name, x.flights]).sort()).toEqual([
      ['Olga Owner', 4],
      ['Pia Pilot', 5],
    ]);
    // Task "Propeller check" (every 5 flights, last done before all of them) was overdue for flights 6–8.
    expect(r.compliance.overdueMaintenanceFlights).toBe(3);
    expect(r.compliance.issues).toContainEqual({ type: 'maintenance', count: 3 });
    const late = r.flights.filter((f: any) => f.issues.includes('Flown with overdue maintenance: Propeller check'));
    expect(late.map((f: any) => f.id)).toEqual(m1Flights.slice(5));
    expect(r.maintenance.tasks.length).toBeGreaterThanOrEqual(6);

    const onlyM2 = (await api(s.app, owner)('GET', `${org()}/reports/flights?from=${encodeURIComponent(from())}&droneId=${m2}&sections=summary`)).json();
    expect(onlyM2).toMatchObject({ sections: ['summary'], summary: { flights: 1, drones: 1 } });
    expect(onlyM2.performance).toBeUndefined();
    const byPilot = (await api(s.app, owner)('GET', `${org()}/reports/flights?from=${encodeURIComponent(from())}&pilotId=${pilot.userId}&sections=summary`)).json();
    expect(byPilot.summary.flights).toBe(5);
    const byFleet = (await api(s.app, owner)('GET', `${org()}/reports/flights?from=${encodeURIComponent(from())}&fleetId=${fleet}&sections=summary`)).json();
    expect(byFleet.summary.flights).toBe(8);
    expect((await api(s.app, owner)('GET', `${org()}/reports/flights?sections=summary,bogus`)).statusCode).toBe(400);
    // UTM alerts raised during a pilot's flights count for that pilot only.
    const f0 = s.ctx.db.get<{ started_at: string; pilot_id: string }>('SELECT started_at, pilot_id FROM flights WHERE id = ?', m1Flights[0])!;
    const during = new Date(Date.parse(f0.started_at) + 20_000).toISOString();
    s.ctx.db.run(
      "INSERT INTO notifications (id, org_id, created_at, level, category, code, drone_id, title, message) VALUES ('n-utm-1', ?, ?, 'warning', 'airspace', 'zone_infringement', ?, 'Inside controlled airspace', 'test')",
      owner.orgId,
      during,
      m1,
    );
    const utmFor = async (pilotId: string) =>
      (await api(s.app, owner)('GET', `${org()}/reports/flights?from=${encodeURIComponent(from())}&pilotId=${pilotId}&sections=compliance`)).json().compliance.utmAlerts;
    const other = f0.pilot_id === owner.userId ? pilot.userId : owner.userId;
    expect(await utmFor(f0.pilot_id)).toEqual([{ code: 'zone_infringement', count: 1 }]);
    expect(await utmFor(other)).toEqual([]);
  });

  it('exports CSV with neutralised formulas and an escaped printable HTML report', async () => {
    const call = api(s.app, owner);
    await call('PATCH', `${org()}/drones/${m2}`, { name: '=HYPERLINK("http://x","y")' });
    const csv = await call('GET', `${org()}/reports/flights?from=${encodeURIComponent(from())}&format=csv`);
    expect(csv.headers['content-type']).toContain('text/csv');
    expect(csv.headers['content-disposition']).toMatch(/attachment; filename="athena-flights_/);
    const lines = csv.body.trim().split('\n');
    expect(lines).toHaveLength(10);
    expect(lines[0]).toMatch(/^Started \(UTC\),Drone,Pilot,Mission/);
    expect(csv.body).toContain(`"'=HYPERLINK(""http://x"",""y"")"`);
    expect(csv.body).not.toMatch(/(^|,)=HYPERLINK/m);

    await call('PATCH', `${org()}/drones/${m2}`, { name: '<img src=x onerror=alert(1)>' });
    const html = await call('GET', `${org()}/reports/flights?from=${encodeURIComponent(from())}&format=html`);
    expect(html.headers['content-type']).toContain('text/html');
    expect(html.headers['content-security-policy']).toContain("default-src 'none'");
    expect(html.body).toContain('&lt;img src=x onerror=alert(1)&gt;');
    expect(html.body).not.toContain('<img src=x');
    expect(html.body).toContain('flown with overdue maintenance');
    await call('PATCH', `${org()}/drones/${m2}`, { name: 'M2' });
  });
});

describe('custom data display', () => {
  it('counts airborne telemetry on a heatmap grid', async () => {
    const q = `from=${encodeURIComponent(new Date(Date.now() - 30 * DAY).toISOString())}`;
    const h = (await api(s.app, viewer)('GET', `${org()}/analytics/heatmap?${q}`)).json();
    expect(h.points).toBeGreaterThan(100);
    expect(h.cells.reduce((n: number, c: any) => n + c.count, 0)).toBe(h.points);
    expect(h.max).toBe(Math.max(...h.cells.map((c: any) => c.count)));
    expect(h.cellDeg).toBe(0.0005);
    for (const c of h.cells) expect(Math.abs(c.lat - HOME.lat)).toBeLessThan(0.01);
    const ops = (await api(s.app, owner)('GET', `${org()}/analytics/heatmap?${q}&fleetId=${fleet}`)).json();
    expect(ops.points).toBeGreaterThan(0);
    expect(ops.points).toBeLessThan(h.points);
  });

  it('shows metric trends and flags anomalies with a robust z-score', async () => {
    const rates = [3.0, 3.1, 2.9, 3.0, 3.2, 2.95, 3.05, 9.0];
    m1Flights.forEach((id, i) => setMetric(id, 'batteryRatePctPerMin', rates[i]!));
    const q = `from=${encodeURIComponent(new Date(Date.now() - 30 * DAY).toISOString())}`;
    const t = (await api(s.app, owner)('GET', `${org()}/analytics/trends?metric=batteryRatePctPerMin&droneId=${m1}&${q}`)).json();
    expect(t).toMatchObject({ metric: 'batteryRatePctPerMin', label: 'Battery consumption', unit: '%/min' });
    expect(t.points.map((p: any) => p.value)).toEqual(rates);
    expect(t.points.map((p: any) => p.anomaly)).toEqual([false, false, false, false, false, false, false, true]);
    expect(t.points[7].z).toBeGreaterThan(3.5);
    expect(t.trend.slopePerDay).toBeGreaterThan(0);
    expect(t.daily.reduce((n: number, d: any) => n + d.n, 0)).toBe(8);
    const dur = (await api(s.app, owner)('GET', `${org()}/analytics/trends?metric=durationS&${q}`)).json();
    expect(dur.points).toHaveLength(9);
    expect(dur.points.every((p: any) => p.value > 30)).toBe(true);
    expect((await api(s.app, owner)('GET', `${org()}/analytics/trends?metric=nope`)).statusCode).toBe(400);
  });

  it('stores preferences per user', async () => {
    const url = `${org()}/preferences/dashboard`;
    expect((await api(s.app, owner)('GET', url)).json()).toMatchObject({ key: 'dashboard', value: null, updatedAt: null });
    const value = { widgets: ['kpis', 'recent', 'heatmap'] };
    expect((await api(s.app, owner)('PUT', url, { value })).statusCode).toBe(200);
    expect((await api(s.app, owner)('GET', url)).json().value).toEqual(value);
    expect((await api(s.app, pilot)('GET', url)).json().value).toBeNull();
    expect((await api(s.app, owner)('PUT', `${org()}/preferences/Bad%20Key`, { value })).statusCode).toBe(400);
    expect((await api(s.app, owner)('PUT', url, { value: 'x'.repeat(20_001) })).statusCode).toBe(400);
  });
});

describe('route conformance', () => {
  it('measures how closely mission flights followed the planned route', async () => {
    const call = api(s.app, owner);
    const mission = (await call('POST', `${org()}/missions`, { name: 'North leg', plan: plan(0) })).json();
    // Flight 0 flew plan(0); flight 2 flew plan(90) – both linked to the north mission.
    s.ctx.db.run('UPDATE flights SET mission_id = ? WHERE id IN (?, ?)', mission.id, m1Flights[0], m1Flights[2]);
    const good = (await call('POST', `${org()}/flights/${m1Flights[0]}/analysis`)).json();
    expect(good.metrics.routeMeanM).toBeLessThan(5);
    expect(good.metrics.routeCoveragePct).toBeGreaterThan(80);
    expect(good.metrics.routeMaxAltDevM).toBeLessThan(10);
    expect(good.findings.map((f: any) => f.code)).not.toContain('route_deviation');
    const off = (await call('POST', `${org()}/flights/${m1Flights[2]}/analysis`)).json();
    expect(off.metrics.routeOutsidePct).toBeGreaterThan(15);
    expect(off.findings).toContainEqual(expect.objectContaining({ code: 'route_deviation', severity: 'warning' }));
    const r = (await call('GET', `${org()}/reports/flights?from=${encodeURIComponent(new Date(Date.now() - 30 * DAY).toISOString())}&droneId=${m1}&sections=summary,performance`)).json();
    expect(r.summary.missionFlights).toBe(2);
    expect(r.performance.byDrone[0].routeMeanM).toBeGreaterThan(0);
  });
});
