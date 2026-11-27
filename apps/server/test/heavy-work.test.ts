/**
 * No member's requests hold up the live connections (see lib/turns.ts): an observer asking for the
 * organisation's heatmap, a long flight's samples and export and a two-year report – from eight
 * connections at once, as fast as they are answered (within the member's allowance) – leaves the
 * owner's commands and the drone's link about as quick as without it: a few milliseconds.
 */
import http from 'node:http';
import { createRequire } from 'node:module';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { addMember, api, signup, startServer, Viewer, waitFor, type Session, type TestServer } from './helpers';

const WebSocket = createRequire(import.meta.url)('ws');

let s: TestServer;
let owner: Session;
let observer: Session;
let droneId: string;
let longFlight: string;
let link: any;
let telemetry: NodeJS.Timeout;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const DAY = 86_400_000;

beforeAll(async () => {
  s = await startServer();
  owner = await signup(s.app, { name: 'Owner' });
  observer = await signup(s.app, { name: 'Owen Observer' });
  await addMember(s.app, owner, observer, 'viewer');
  // An archive of 40 flights of 2500 airborne samples each (100 000 samples).
  const archive = (await api(s.app, owner)('POST', `/api/v2/organisations/${owner.orgId}/drones`, { name: 'Archive', model: 'X4' })).json();
  const { db } = s.ctx;
  db.tx(() => {
    for (let f = 0; f < 40; f++) {
      const id = `00000000-0000-4000-8000-${String(f).padStart(12, '0')}`;
      const at = Date.now() - (f + 1) * DAY;
      db.run(
        `INSERT INTO flights (id, org_id, drone_id, source, status, started_at, ended_at, duration_s, distance_m, max_alt_m, created_at)
         VALUES (?, ?, ?, 'upload', 'completed', ?, ?, 1250, 5000, 60, ?)`,
        id,
        owner.orgId,
        archive.id,
        new Date(at).toISOString(),
        new Date(at + 1_250_000).toISOString(),
        new Date(at).toISOString(),
      );
      for (let i = 0; i < 2500; i++) {
        db.run(
          `INSERT INTO flight_samples (flight_id, t, lat, lon, alt_msl, alt_rel, ground_speed, climb_rate, heading, roll, pitch, yaw, battery_pct, voltage, satellites, mode, armed)
           VALUES (?, ?, ?, ?, 70, 60, 8, 0, 90, 0, 0, 90, 80, 16, 12, 'MISSION', 1)`,
          id,
          at + i * 500,
          25 + f * 0.001 + i * 1e-5,
          121 + i * 1e-5,
        );
      }
      if (f === 0) longFlight = id;
    }
  });
  // A drone online, answering its commands and the cloud's probes at once.
  const created = (await api(s.app, owner)('POST', `/api/v2/organisations/${owner.orgId}/drones`, { name: 'Live', model: 'X4' })).json();
  droneId = created.id;
  link = new WebSocket(`${s.wsBase}/api/v2/link`, { headers: { authorization: `Bearer ${created.linkKey}` } });
  link.on('message', (data: Buffer, bin: boolean) => {
    if (bin) return;
    const m = JSON.parse(data.toString());
    if (m.type === 'welcome') link.send(JSON.stringify({ type: 'hello', firmware: 'f 1', capabilities: {}, t: Date.now() }));
    if (m.type === 'ping') link.send(JSON.stringify({ type: 'pong', id: m.id, t: Date.now() }));
    if (m.type === 'command') link.send(JSON.stringify({ type: 'ack', id: m.id, result: 'accepted' }));
  });
  await new Promise((r) => link.once('open', r));
  const t = { lat: 25, lon: 121, altMsl: 10, altRel: 0, heading: 0, groundSpeed: 0, climbRate: 0, roll: 0, pitch: 0, yaw: 0, battery: { pct: 90, voltage: 16 }, gps: { fix: 3, satellites: 12 }, mode: 'HOLD', armed: false, inAir: false };
  telemetry = setInterval(() => link.readyState === 1 && link.send(JSON.stringify({ type: 'telemetry', t: Date.now(), ...t })), 100);
  await waitFor(() => s.ctx.hub.droneState(droneId)?.telemetry, 10_000);
});

afterAll(async () => {
  clearInterval(telemetry);
  link?.close();
  await s.close();
});

const pct = (a: number[], p: number) => [...a].sort((x, y) => x - y)[Math.min(a.length - 1, Math.floor(p * a.length))]!;

describe('long computations of the API and the live connections', () => {
  it('an observer asking for heatmaps, samples, exports and reports from eight connections leaves the owner\'s commands and the drone\'s link quick', async () => {
    const v = new Viewer(`${s.wsBase}/api/v2/live?org=${owner.orgId}`, { cookie: owner.cookie });
    await v.opened;
    await v.wait((m) => m.type === 'snapshot');
    const from = encodeURIComponent(new Date(Date.now() - 700 * DAY).toISOString());
    const paths = [
      `analytics/heatmap?from=${from}`,
      `flights/${longFlight}/samples`,
      `flights/${longFlight}/export?format=csv`,
      `reports/flights?from=${from}`,
    ].map((p) => `/api/v2/organisations/${owner.orgId}/${p}`);
    const agent = new http.Agent({ keepAlive: true, maxSockets: 8 });
    const statuses: number[] = [];
    let stop = false;
    const get = (path: string) =>
      new Promise<number>((resolve) => {
        const req = http.request(`${s.baseUrl}${path}`, { agent, headers: { cookie: observer.cookie } }, (res) => {
          res.resume();
          res.on('end', () => resolve(res.statusCode ?? 0));
        });
        req.on('error', () => resolve(-1));
        req.end();
      });
    const flooding = Array.from({ length: 8 }, async (_, i) => {
      for (let k = i; !stop; k++) statuses.push(await get(paths[k % paths.length]!));
    });
    await sleep(500);
    // Answers taken as they come (not polled for).
    const answers = new Map<string, (m: any) => void>();
    v.ws.on('message', (data: Buffer, bin: boolean) => {
      if (bin) return;
      const m = JSON.parse(data.toString());
      const key = m.type === 'ack' ? m.requestId : m.type === 'pong' ? m.id : null;
      if (key && answers.has(key)) answers.get(key)!(m);
    });
    const ask = (msg: object, key: string) =>
      new Promise<any>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error(`no answer to ${key}`)), 5000);
        answers.set(key, (m) => {
          clearTimeout(timer);
          answers.delete(key);
          resolve(m);
        });
        v.send(msg);
      });
    const commands: number[] = [];
    const links: number[] = [];
    for (let i = 0; i < 40; i++) {
      const requestId = `quick-${i}`;
      const t0 = performance.now();
      await ask({ type: 'command', droneId, requestId, command: 'hold', params: {} }, requestId);
      commands.push(performance.now() - t0);
      const id = `probe-${i}`;
      const pong = await ask({ type: 'ping', id, t: Date.now(), droneId }, id);
      if (typeof pong.droneRttMs === 'number') links.push(pong.droneRttMs);
      await sleep(50);
    }
    stop = true;
    await Promise.all(flooding);
    agent.destroy();
    v.close();
    // The observer was answered all along (long answers included).
    expect(statuses.filter((c) => c === 200).length).toBeGreaterThan(20);
    expect(statuses.every((c) => c === 200 || c === 429)).toBe(true);
    // A command's round trip (cloud and drone both here): a few ms – a long computation's slices
    // let the live connections' messages go between them.
    expect(pct(commands, 0.5)).toBeLessThan(12);
    expect(pct(commands, 0.9)).toBeLessThan(30);
    expect(links.length).toBeGreaterThan(20);
    expect(pct(links, 0.9)).toBeLessThan(30);
  }, 60_000);

  it('waypoints generated: never more than a mission holds (refused at once) – asked for from eight connections, the commands stay quick', async () => {
    // Anyone signed in may generate waypoints (no organisation's data): a stranger here.
    const stranger = await signup(s.app, { name: 'Stranger' });
    const square = [
      { lat: 24, lon: 121 },
      { lat: 24, lon: 122 },
      { lat: 25, lon: 122 },
      { lat: 25, lon: 121 },
    ];
    const generate = (params: object, who = stranger) => api(s.app, who)('POST', '/api/v2/planning/generate', params);
    for (const body of [
      { kind: 'perimeter', params: { polygon: square, spacingM: 0.4, alt: 50 } },
      { kind: 'corridor', params: { line: Array.from({ length: 500 }, (_, i) => ({ lat: 24 + i * 0.001, lon: 121 })), widthM: 5000, spacingM: 25, alt: 50 } },
      { kind: 'orbit', params: { center: square[0], radiusM: 100, points: 360, layers: 50, alt: 30 } },
    ]) {
      const t0 = performance.now();
      const refused = await generate(body);
      expect(refused.statusCode).toBe(400);
      expect(refused.json().message).toBe('That makes more than 2000 mission items – more than a mission holds: use a larger spacing or a smaller area');
      expect(performance.now() - t0).toBeLessThan(2000);
    }
    // At most a mission's worth – the answer sent as the planning worker wrote it.
    const most = { kind: 'perimeter', params: { polygon: square, spacingM: 230, alt: 50 } };
    const one = await generate(most);
    expect(one.statusCode).toBe(200);
    expect(one.json().items.length).toBeGreaterThan(1500);
    expect(one.json().items.length).toBeLessThanOrEqual(2000);
    const v = new Viewer(`${s.wsBase}/api/v2/live?org=${owner.orgId}`, { cookie: owner.cookie });
    await v.opened;
    await v.wait((m) => m.type === 'snapshot');
    const acks = new Map<string, () => void>();
    v.ws.on('message', (data: Buffer, bin: boolean) => {
      if (bin) return;
      const m = JSON.parse(data.toString());
      if (m.type === 'ack') acks.get(m.requestId)?.();
    });
    let stop = false;
    const statuses: number[] = [];
    const flooding = Array.from({ length: 8 }, async () => {
      while (!stop) statuses.push((await generate(most)).statusCode);
    });
    await sleep(300);
    const commands: number[] = [];
    for (let i = 0; i < 30; i++) {
      const requestId = `generating-${i}`;
      const t0 = performance.now();
      await new Promise<void>((resolve) => {
        acks.set(requestId, resolve);
        v.send({ type: 'command', droneId, requestId, command: 'hold', params: {} });
      });
      commands.push(performance.now() - t0);
      await sleep(40);
    }
    stop = true;
    await Promise.all(flooding);
    v.close();
    expect(statuses.filter((c) => c === 200).length).toBeGreaterThan(5);
    expect(pct(commands, 0.5)).toBeLessThan(12);
    expect(pct(commands, 0.9)).toBeLessThan(30);
  }, 60_000);

  it('an observer asking for a route of 150 scattered waypoints to be reordered: computed in the planning worker – the commands stay quick', async () => {
    const mission = (await api(s.app, owner)('POST', `/api/v2/organisations/${owner.orgId}/missions`, { name: 'Scattered', plan: { home: { lat: 25, lon: 121 }, items: [{ id: 't', type: 'takeoff', alt: 40 }] } })).json();
    const plan = {
      home: { lat: 25, lon: 121 },
      defaultAlt: 50,
      defaultSpeed: 10,
      items: [
        { id: 't', type: 'takeoff', alt: 40 },
        ...Array.from({ length: 150 }, (_, i) => ({ id: `w${i}`, type: 'waypoint', lat: 25 + 0.01 * Math.sin(i * 0.37), lon: 121 + 0.01 * Math.cos(i * 0.53), alt: 50 })),
        { id: 'r', type: 'rtl' },
      ],
    };
    const v = new Viewer(`${s.wsBase}/api/v2/live?org=${owner.orgId}`, { cookie: owner.cookie });
    await v.opened;
    await v.wait((m) => m.type === 'snapshot');
    const acks = new Map<string, () => void>();
    v.ws.on('message', (data: Buffer, bin: boolean) => {
      if (bin) return;
      const m = JSON.parse(data.toString());
      if (m.type === 'ack') acks.get(m.requestId)?.();
    });
    const optimizing = Promise.all([1, 2].map(() => api(s.app, observer)('POST', `/api/v2/organisations/${owner.orgId}/missions/${mission.id}/optimize`, { plan, reorder: true, terrainFollow: false })));
    let done = false;
    void optimizing.then(() => (done = true));
    const commands: number[] = [];
    for (let i = 0; !done && i < 200; i++) {
      const requestId = `during-${i}`;
      const t0 = performance.now();
      await new Promise<void>((resolve) => {
        acks.set(requestId, resolve);
        v.send({ type: 'command', droneId, requestId, command: 'hold', params: {} });
      });
      commands.push(performance.now() - t0);
      await sleep(20);
    }
    const answers = await optimizing;
    v.close();
    expect(answers.map((r) => r.statusCode)).toEqual([200, 200]);
    expect(answers[0]!.json().report.reordered).toBe(true);
    expect(commands.length).toBeGreaterThan(5);
    expect(Math.max(...commands)).toBeLessThan(100);
  }, 60_000);
});
