/**
 * The live link keeps what a viewer gets current: flow control (a viewer that acknowledges what it
 * receives gets no more than its link carries – video dropped, the latest telemetry kept back –
 * so that latency never builds up; see flow-control.test.ts for links of every kind), times
 * passed on in the cloud's clock (the drone's clock bounded), so that viewers can tell how old the
 * data is – however slow a drone's uplink – and no viewer able to load a drone's link.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import WebSocket from 'ws';
import { encodeLinkVideoFrame, decodeLiveVideoFrame } from '@athena-sky/shared';
import { HOLD_AFTER_MS } from '../src/realtime/flow';
import { addMember, api, signup, startServer, Viewer, waitFor, type Session, type TestServer } from './helpers';

/** The test drone's clock runs a minute ahead of the cloud's. */
const SKEW_MS = 60_000;
/** What it sends arrives two seconds after it was taken (as over a slow uplink). */
const AGE_MS = 2000;

let s: TestServer;
let owner: Session;
let droneId: string;
let link: WebSocket;
let videoOn = false;
let pump: NodeJS.Timeout;
let seq = 0;

const droneNow = () => Date.now() + SKEW_MS;
/** A drone at rest, as its telemetry says. */
const AT_REST = {
  lat: 25.07,
  lon: 121.53,
  altMsl: 10,
  altRel: 0,
  heading: 0,
  groundSpeed: 0,
  climbRate: 0,
  roll: 0,
  pitch: 0,
  yaw: 0,
  battery: { pct: 90, voltage: 16 },
  gps: { fix: 3, satellites: 12 },
  mode: 'HOLD',
  armed: false,
  inAir: false,
};
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

beforeAll(async () => {
  s = await startServer();
  owner = await signup(s.app, { name: 'Flow Owner' });
  const created = await api(s.app, owner)('POST', `/api/v2/organisations/${owner.orgId}/drones`, { name: 'Skewed', model: 'X4' });
  droneId = created.json().id;
  link = new WebSocket(`${s.wsBase}/api/v2/link`, { headers: { authorization: `Bearer ${created.json().linkKey}` } });
  link.on('message', (data, isBinary) => {
    if (isBinary) return;
    const msg = JSON.parse(data.toString());
    if (msg.type === 'welcome') link.send(JSON.stringify({ type: 'hello', firmware: 'skew 1.0', capabilities: { video: true, adsb: true } }));
    // The drone answers probes in its own clock.
    if (msg.type === 'ping') link.send(JSON.stringify({ type: 'pong', id: msg.id, t: droneNow() }));
    if (msg.type === 'video') videoOn = msg.action === 'start';
  });
  await new Promise<void>((r) => link.once('open', () => r()));
  // 20 telemetry samples and (while asked for) 20 video frames a second, stamped in its clock
  // two seconds before they are sent.
  const jpeg = new Uint8Array(4000);
  jpeg[0] = 0xff;
  jpeg[1] = 0xd8;
  pump = setInterval(() => {
    if (link.readyState !== WebSocket.OPEN) return;
    seq++;
    link.send(
      JSON.stringify({
        type: 'telemetry',
        t: droneNow() - AGE_MS,
        lat: 25.07,
        lon: 121.53,
        altMsl: 10,
        altRel: 0,
        heading: seq % 360,
        groundSpeed: 0,
        climbRate: 0,
        roll: 0,
        pitch: 0,
        yaw: 0,
        battery: { pct: 90, voltage: 16 },
        gps: { fix: 3, satellites: 12 },
        mode: 'HOLD',
        armed: false,
        inAir: false,
      }),
    );
    if (videoOn) link.send(encodeLinkVideoFrame(droneNow() - AGE_MS, 0, jpeg));
  }, 50);
});

afterAll(async () => {
  clearInterval(pump);
  link?.close();
  await s.close();
});

/** A viewer whose acknowledgements the test controls. */
async function viewer(): Promise<Viewer & { count(): number; ack(): void }> {
  const v = new Viewer(`${s.wsBase}/api/v2/live?org=${owner.orgId}`, { cookie: owner.cookie }) as Viewer & { count(): number; ack(): void };
  v.count = () => v.messages.length + v.frames.length;
  v.ack = () => v.send({ type: 'ack', n: v.count() });
  await v.opened;
  await v.wait((m) => m.type === 'snapshot');
  return v;
}

const telemetryOf = (v: Viewer) => v.messages.filter((m) => m.type === 'telemetry' && m.droneId === droneId);

describe('Live link: times in the cloud clock', () => {
  it('probes the drone clock: telemetry, video and traffic times reach viewers in the cloud clock', async () => {
    const v = await viewer();
    // Until the drone's clock is known (its first probe), a sample counts as taken when it arrived.
    const first = await v.wait((m) => m.type === 'telemetry' && m.droneId === droneId);
    expect(first.at).toBeLessThanOrEqual(Date.now());
    // Then a sample's time is when it was taken, in the cloud's clock: two seconds before it
    // arrived (the drone stamps it a minute ahead).
    const sample = await waitFor(() => {
      const last = telemetryOf(v).at(-1);
      return last && Math.abs(last.at - (Date.now() - AGE_MS)) < 500 ? last : null;
    }, 10_000);
    expect(Math.abs(sample.data.t - sample.at - SKEW_MS)).toBeLessThan(500);
    // Video: the capture time in the cloud's clock.
    v.send({ type: 'video', droneId, enabled: true, quality: 'sd' });
    await waitFor(() => v.frames.length >= 3, 10_000);
    const f = decodeLiveVideoFrame(new Uint8Array(v.frames.at(-1)!))!;
    expect(Math.abs(f.ts - (Date.now() - AGE_MS))).toBeLessThan(500);
    v.send({ type: 'video', droneId, enabled: false });
    // Traffic: when each aircraft was reported, in the cloud's clock (never later than its arrival).
    link.send(JSON.stringify({ type: 'adsb', aircraft: [{ icao: 'ABC123', lat: 25.08, lon: 121.54, altMsl: 300, heading: 90, speed: 50, t: droneNow() - 20_000 }] }));
    const adsb = await v.wait((m) => m.type === 'adsb' && m.droneId === droneId && m.aircraft.length === 1);
    expect(Math.abs(adsb.aircraft[0].t - (Date.now() - 20_000))).toBeLessThan(1500);
    const fresh = await v.wait((m) => m.type === 'adsb' && m.droneId === droneId);
    expect(fresh.aircraft[0].t).toBeLessThanOrEqual(Date.now());
    // The cloud answers a probe of the link at once, with its time.
    v.send({ type: 'ping', id: 'link-1', t: Date.now() });
    const pong = await v.wait((m) => m.type === 'pong' && m.id === 'link-1');
    expect(Math.abs(pong.serverTime - Date.now())).toBeLessThan(1000);
    expect(pong.droneRttMs).toBeUndefined();
    // The drone's state carries the time of its latest sample too.
    const state = s.ctx.hub.droneState(droneId)!;
    expect(Math.abs((state.telemetryAt ?? 0) - (Date.now() - AGE_MS))).toBeLessThan(500);
    v.close();
  });
});

describe('Live link: flow control', () => {
  it('a viewer that stops acknowledging gets no video and only the latest telemetry until it does again', async () => {
    const v = await viewer();
    v.ack();
    v.send({ type: 'video', droneId, enabled: true, quality: 'sd' });
    // Acknowledging as it receives: video and telemetry flow.
    let acking = true;
    const acker = setInterval(() => acking && v.ack(), 50);
    await waitFor(() => v.frames.length >= 10, 10_000);
    const t0 = telemetryOf(v).length;
    await sleep(500);
    expect(telemetryOf(v).length - t0).toBeGreaterThan(5);

    // It stops acknowledging (its link stalls): after the link's round trip and a short budget,
    // nothing more of the video is sent – nor of the telemetry, once it stalled for a while.
    acking = false;
    await sleep(700);
    const framesStalled = v.frames.length;
    await sleep(HOLD_AFTER_MS + 300);
    const telemetryStalled = telemetryOf(v).length;
    await sleep(1500);
    expect(v.frames.length).toBe(framesStalled);
    expect(telemetryOf(v).length).toBe(telemetryStalled);
    // Other messages still come (events, state changes).
    link.send(JSON.stringify({ type: 'event', level: 'warning', message: 'still told' }));
    await v.wait((m) => m.type === 'event' && m.message === 'still told');

    // Acknowledged again: the latest telemetry comes at once (not the ones kept back before it),
    // then video and telemetry flow again.
    const before = telemetryOf(v).length;
    v.ack();
    const flushed = await waitFor(() => telemetryOf(v)[before], 2000);
    expect(Math.abs(flushed.data.t - (droneNow() - AGE_MS))).toBeLessThan(500);
    acking = true;
    const framesBack = v.frames.length;
    await waitFor(() => v.frames.length >= framesBack + 5, 5000);
    clearInterval(acker);
    v.send({ type: 'video', droneId, enabled: false });
    v.close();
  });

  it('a viewer that does not acknowledge (an older integration) gets everything as before', async () => {
    const v = await viewer();
    v.send({ type: 'video', droneId, enabled: true, quality: 'sd' });
    await waitFor(() => v.frames.length >= 5, 10_000);
    const t0 = telemetryOf(v).length;
    const f0 = v.frames.length;
    await sleep(1500);
    expect(telemetryOf(v).length - t0).toBeGreaterThan(15);
    expect(v.frames.length - f0).toBeGreaterThan(15);
    v.send({ type: 'video', droneId, enabled: false });
    v.close();
  });

  it('ignores acknowledgements that make no sense', async () => {
    const v = await viewer();
    for (const n of [-1, 1.5, 'x', null, 1e12]) v.send({ type: 'ack', n });
    v.send({ type: 'ping', id: 'still-ok', t: Date.now() });
    await v.wait((m) => m.type === 'pong' && m.id === 'still-ok');
    // An acknowledgement of more than was sent counts as everything sent: telemetry keeps flowing.
    const t0 = telemetryOf(v).length;
    await sleep(600);
    v.ack();
    await sleep(600);
    expect(telemetryOf(v).length - t0).toBeGreaterThan(5);
    expect(v.find((m) => m.type === 'error')).toBeUndefined();
    v.close();
  });
});

/**
 * A drone of the test's own: its clock `skew` ms off the cloud's (it can be set later), everything
 * it sends `uplink` ms late (a slow uplink, in order), sending telemetry stamped as it is taken;
 * what it receives is counted. It introduces itself with its clock (`hello.t`, unless `helloTime`
 * is false) and answers probes – but no commands.
 */
async function rawDrone(
  name: string,
  opts: { skew?: number; uplink?: number; uplinkAfterHello?: number; helloTime?: boolean; pongTime?: boolean; answer?: boolean; telemetry?: boolean } = {},
) {
  let skew = opts.skew ?? 0;
  let uplink = opts.uplink ?? 0;
  const created = await api(s.app, owner)('POST', `/api/v2/organisations/${owner.orgId}/drones`, { name, model: 'X4' });
  const id = created.json().id as string;
  const ws = new WebSocket(`${s.wsBase}/api/v2/link`, { headers: { authorization: `Bearer ${created.json().linkKey}` } });
  const got: Record<string, number> = {};
  const clock = () => Date.now() + skew;
  // In order: each message goes `uplink` ms after it was made, never before the one before it.
  let lastOut = 0;
  const out = (msg: object) => {
    const data = JSON.stringify(msg);
    const go = () => ws.readyState === WebSocket.OPEN && ws.send(data);
    if (!uplink) return go();
    const at = Math.max(Date.now() + uplink, lastOut);
    lastOut = at;
    setTimeout(go, at - Date.now());
  };
  ws.on('message', (data, isBinary) => {
    if (isBinary) return;
    const msg = JSON.parse(data.toString());
    got[msg.type] = (got[msg.type] ?? 0) + 1;
    if (msg.type === 'welcome') {
      out({ type: 'hello', firmware: 'raw 1.0', capabilities: { video: true, manualControl: true }, ...(opts.helloTime === false ? {} : { t: clock() }) });
      if (opts.uplinkAfterHello !== undefined) uplink = opts.uplinkAfterHello;
    }
    if (msg.type === 'ping') out({ type: 'pong', id: msg.id, ...(opts.pongTime === false ? {} : { t: clock() }) });
    if (msg.type === 'command' && opts.answer) out({ type: 'ack', id: msg.id, result: 'accepted' });
  });
  await new Promise<void>((r) => ws.once('open', () => r()));
  let sending = opts.telemetry !== false;
  const pump = setInterval(() => sending && out({ type: 'telemetry', t: clock(), ...AT_REST }), 100);
  return {
    id,
    got,
    /** Its telemetry stops (the rest goes on). */
    stopTelemetry() {
      sending = false;
    },
    /** Sets its clock `ms` off the cloud's from now on. */
    setSkew(ms: number) {
      skew = ms;
    },
    stop() {
      clearInterval(pump);
      ws.close();
    },
  };
}

/** Telemetry of a drone as a viewer gets it: the cloud's time of each sample, and the drone's stamp. */
function samplesOf(v: Viewer, droneId: string): { at: number; t: number; got: number }[] {
  const out: { at: number; t: number; got: number }[] = [];
  v.ws.on('message', (data, isBinary) => {
    if (isBinary) return;
    const m = JSON.parse(data.toString());
    if (m.type === 'telemetry' && m.droneId === droneId) out.push({ at: m.at, t: m.data.t, got: Date.now() });
  });
  return out;
}

describe('Live link: a drone with a slow uplink', () => {
  it('is told as old as what it sends is – however slow its uplink, from its first message on', async () => {
    const UPLINK_MS = 3000;
    const d = await rawDrone('Slow-uplink', { skew: -45_000, uplink: UPLINK_MS });
    const v = await viewer();
    const ages: number[] = [];
    v.ws.on('message', (data, isBinary) => {
      if (isBinary) return;
      const m = JSON.parse(data.toString());
      if (m.type === 'telemetry' && m.droneId === d.id) ages.push(Date.now() - m.at);
    });
    await waitFor(() => ages.length >= 60, 20_000);
    // Each sample is told as taken when it was: the uplink's delay before it reached the cloud –
    // the first ones too (its clock is known from its hello), and never half of it (as the middle
    // of a probe's round trip would make it).
    expect(Math.min(...ages)).toBeGreaterThan(UPLINK_MS - 150);
    expect(Math.max(...ages)).toBeLessThan(UPLINK_MS + 500);
    d.stop();
    v.close();
  });

  it('is never taken for newer than it is when its clock is set forward while its uplink is slow', async () => {
    const UPLINK_MS = 3000;
    const SKEW = -20_000;
    const STEP = 2000;
    const d = await rawDrone('Stepped', { skew: SKEW, uplink: UPLINK_MS });
    const v = await viewer();
    const got = samplesOf(v, d.id);
    await waitFor(() => got.length >= 10, 20_000);
    // Set forward by less than its uplink takes (no answer contradicts the bound kept).
    const stepAt = Date.now();
    d.setSkew(SKEW + STEP);
    await waitFor(() => got.filter((g) => g.t >= stepAt + SKEW + STEP).length >= 40, 20_000);
    // When each sample was really taken (in the cloud's clock): its stamp less the clock's offset then.
    // (Never later than that – beyond the jitter of the test's timers.)
    const taken = (t: number) => (t < stepAt + SKEW ? t - SKEW : t - SKEW - STEP);
    for (const g of got) expect(g.at).toBeLessThanOrEqual(taken(g.t) + 150);
    // …and told as old as it is (the uplink's delay), not much older.
    const after = got.filter((g) => g.t >= stepAt + SKEW + STEP);
    for (const g of after) expect(g.got - g.at).toBeLessThan(UPLINK_MS + 600);
    d.stop();
    v.close();
  });

  it('a drone that does not tell its clock in its hello: its first data are not taken for newer than they are either', async () => {
    const UPLINK_MS = 3000;
    const SKEW = 30_000;
    const d = await rawDrone('No-hello-time', { skew: SKEW, uplink: UPLINK_MS, helloTime: false });
    const v = await viewer();
    const got = samplesOf(v, d.id);
    await waitFor(() => got.length >= 50, 20_000);
    for (const g of got) expect(g.at).toBeLessThanOrEqual(g.t - SKEW + 150);
    // The first ones too – taken as made no later than the connection was accepted, until the
    // drone told its time.
    expect(got[0]!.got - got[0]!.at).toBeGreaterThan(UPLINK_MS - 150);
    d.stop();
    v.close();
  });

  it('…nor when its uplink becomes slower after its hello (its first data count as made no later than the connection was accepted)', async () => {
    const SKEW = -12_000;
    const d = await rawDrone('Slower-after-hello', { skew: SKEW, uplink: 1000, uplinkAfterHello: 3000, helloTime: false });
    const v = await viewer();
    const got = samplesOf(v, d.id);
    await waitFor(() => got.length >= 30, 20_000);
    for (const g of got) expect(g.at).toBeLessThanOrEqual(g.t - SKEW + 150);
    d.stop();
    v.close();
  });

  it('a drone that never tells its time: its data cannot be dated – once 5 s passed it is a drone with no new data', async () => {
    const d = await rawDrone('Timeless', { helloTime: false, pongTime: false, answer: true });
    await waitFor(() => s.ctx.hub.droneState(d.id)?.telemetry, 10_000);
    await sleep(5600);
    expect(s.ctx.hub.dataLate(d.id)).toBe('has not told its time yet – how old its data is is not known');
    const user = { id: owner.userId, name: 'Flow Owner', role: 'owner' as const };
    expect(await s.ctx.hub.sendCommand(owner.orgId, d.id, user, 'takeoff', { alt: 10 })).toMatchObject({
      delivered: false,
      message: 'Timeless has not told its time yet – how old its data is is not known – what it is doing is not known: takeoff not sent',
    });
    d.stop();
  });
});

describe('Live link: no viewer can load a drone\'s link', () => {
  it('a watch-only member flooding probes and video switches: the cloud answers, the drone gets none of it', async () => {
    const d = await rawDrone('Flooded');
    const watcher = await signup(s.app, { name: 'Watcher' });
    await addMember(s.app, owner, watcher, 'viewer');
    const v = new Viewer(`${s.wsBase}/api/v2/live?org=${owner.orgId}`, { cookie: watcher.cookie });
    await v.opened;
    await v.wait((m) => m.type === 'snapshot');
    await waitFor(() => (d.got.ping ?? 0) >= 1, 10_000);
    await sleep(300);
    const pings = d.got.ping ?? 0;
    const videos = d.got.video ?? 0;
    for (let i = 0; i < 300; i++) v.send({ type: 'video', droneId: d.id, enabled: true, quality: i % 2 ? 'hd' : 'sd' });
    for (let i = 0; i < 2000; i++) v.send({ type: 'ping', id: `flood-${i}`, t: Date.now(), droneId: d.id });
    await sleep(2500);
    // The drone got none of the viewer's probes (only the cloud's own, every 2 s) and the video
    // switches at most twice a second.
    expect((d.got.ping ?? 0) - pings).toBeLessThanOrEqual(2);
    expect((d.got.video ?? 0) - videos).toBeLessThanOrEqual(7);
    // The cloud answered the probes itself, with the drone's round trip as it measures it – as
    // many as a viewer may send at once (after its video switches): the rest were ignored.
    const answered = v.messages.filter((m) => m.type === 'pong' && String(m.id).startsWith('flood-'));
    expect(answered.length).toBeGreaterThan(50);
    expect(answered.length).toBeLessThan(400);
    expect(answered[0].droneRttMs).toBeGreaterThanOrEqual(0);
    // Its allowance recovers.
    await sleep(1000);
    v.send({ type: 'ping', id: 'after-flood', t: Date.now(), droneId: d.id });
    await v.wait((m) => m.type === 'pong' && m.id === 'after-flood');
    d.stop();
    v.close();
  });

  it('a watch-only member flooding commands from many connections slows no one else: the pilot\'s commands go through at once', async () => {
    const d = await rawDrone('Flood-target', { answer: true });
    await waitFor(() => s.ctx.hub.droneState(d.id)?.online, 10_000);
    const flooder = await signup(s.app, { name: 'Flooder' });
    await addMember(s.app, owner, flooder, 'viewer');
    const url = `${s.wsBase}/api/v2/live?org=${owner.orgId}`;
    // Twenty connections at most at once.
    const conns = Array.from({ length: 25 }, () => new Viewer(url, { cookie: flooder.cookie }));
    const codes: (number | null)[] = await Promise.all(
      conns.map((c) => new Promise<number | null>((resolve) => {
        c.ws.once('close', (code) => resolve(code));
        setTimeout(() => resolve(null), 2000);
      })),
    );
    expect(codes.filter((c) => c === 4429).length).toBe(5);
    const open = conns.filter((_, i) => codes[i] === null);
    expect(open.length).toBe(20);
    // The pilot.
    const pilot = await viewer();
    const rtts: number[] = [];
    const command = async (i: number) => {
      const requestId = `pilot-${i}`;
      const sent = Date.now();
      pilot.send({ type: 'command', droneId: d.id, requestId, command: 'hold', params: {} });
      await pilot.wait((m) => m.type === 'ack' && m.requestId === requestId && m.result === 'accepted', 5000);
      rtts.push(Date.now() - sent);
    };
    await command(0);
    // Each connection floods commands: the cloud looks at the memberships no more often than a
    // member may send them over all their connections (and refuses at once).
    const db = s.ctx.db;
    const get = db.get.bind(db);
    let lookups = 0;
    db.get = ((sql: string, ...args: unknown[]) => {
      if (sql.includes('FROM memberships')) lookups++;
      return get(sql, ...(args as []));
    }) as typeof db.get;
    const floodFrom = Date.now();
    let floodFor = 0;
    try {
      const flood = setInterval(() => {
        for (const c of open) for (let i = 0; i < 200; i++) c.send({ type: 'command', droneId: d.id, requestId: `f-${i}`, command: 'takeoff', params: { alt: 10 } });
      }, 50);
      for (let i = 1; i <= 15; i++) {
        await command(i);
        await sleep(100);
      }
      clearInterval(flood);
      floodFor = Date.now() - floodFrom;
    } finally {
      db.get = get;
    }
    // The pilot's commands went through at once (the drone answers at once)…
    expect(Math.max(...rtts)).toBeLessThan(300);
    // …the flooder's were refused at once, at most as many as a member may send (the rest ignored),
    // and the drone got none of them.
    const refused = open.flatMap((c) => c.messages.filter((m) => m.type === 'ack' && String(m.requestId).startsWith('f-')));
    expect(refused.length).toBeGreaterThan(0);
    expect(refused.every((m) => m.result === 'rejected' && m.message === 'Your role cannot control drones')).toBe(true);
    expect(refused.length).toBeLessThan(800 + 400 * 3);
    expect(d.got.command).toBe(16);
    // The memberships are read once per command of the flooder (and the pilot's): as many as a member may send.
    expect(lookups).toBeLessThan(800 + (400 * (floodFor + 1000)) / 1000 + 50);
    for (const c of conns) c.close();
    pilot.close();
    d.stop();
  });

  it('a drone with no new data – none yet, or none for a while – is sent nothing that sets it moving; stopping it still goes through', async () => {
    const d = await rawDrone('Silent', { answer: true, telemetry: false });
    await waitFor(() => s.ctx.hub.droneState(d.id)?.online, 10_000);
    const v = await viewer();
    const send = async (command: string, requestId: string) => {
      v.send({ type: 'command', droneId: d.id, requestId, command, params: command === 'takeoff' ? { alt: 10 } : {} });
      return v.wait((m) => m.type === 'ack' && m.requestId === requestId, 5000);
    };
    const first = await send('takeoff', 'silent-takeoff');
    expect(first).toMatchObject({ result: 'rejected', message: 'Silent has sent no telemetry yet – what it is doing is not known: takeoff not sent' });
    expect((await send('hold', 'silent-hold')).result).toBe('accepted');
    // Nor through the API.
    const viaApi = await api(s.app, owner)('POST', `/api/v2/organisations/${owner.orgId}/drones/${d.id}/commands`, { command: 'takeoff', params: { alt: 10 } });
    expect(viaApi.statusCode).toBe(409);
    expect(viaApi.json().message).toBe('Silent has sent no telemetry yet – what it is doing is not known: takeoff not sent');
    expect(d.got.command).toBe(1);
    d.stop();
    // Its telemetry stops: once it is older than 5 s, the same.
    const q = await rawDrone('Quiet', { answer: true });
    await waitFor(() => s.ctx.hub.droneState(q.id)?.telemetry, 10_000);
    v.send({ type: 'command', droneId: q.id, requestId: 'quiet-1', command: 'arm', params: {} });
    expect((await v.wait((m) => m.type === 'ack' && m.requestId === 'quiet-1', 5000)).result).toBe('accepted');
    q.stopTelemetry();
    await sleep(5600);
    for (const command of ['arm', 'takeoff', 'goto', 'mission_start', 'set_mode']) {
      v.send({ type: 'command', droneId: q.id, requestId: `quiet-${command}`, command, params: command === 'goto' ? { lat: 25, lon: 121 } : command === 'set_mode' ? { mode: 'MISSION' } : {} });
      const ack = await v.wait((m) => m.type === 'ack' && m.requestId === `quiet-${command}`, 5000);
      expect(ack.result).toBe('rejected');
      expect(ack.message).toMatch(/^Quiet has sent nothing new for \d+ s – what it is doing is not known/);
    }
    for (const command of ['hold', 'land', 'rtl']) {
      v.send({ type: 'command', droneId: q.id, requestId: `quiet-${command}`, command, params: {} });
      expect((await v.wait((m) => m.type === 'ack' && m.requestId === `quiet-${command}`, 5000)).result).toBe('accepted');
    }
    expect(s.ctx.hub.dataLate(q.id)).toMatch(/^has sent nothing new for \d+ s$/);
    q.stop();
    v.close();
  });

  it('a member who may control drones sends at most 100 commands at once (a group command to a large fleet), then 20 a second', async () => {
    const v = await viewer();
    for (let i = 0; i < 130; i++) v.send({ type: 'command', droneId: 'no-such-drone', requestId: `burst-${i}`, command: 'hold', params: {} });
    await waitFor(() => v.messages.filter((m) => m.type === 'ack' && String(m.requestId).startsWith('burst-')).length === 130, 5000);
    const acks = v.messages.filter((m) => m.type === 'ack' && String(m.requestId).startsWith('burst-'));
    const tooMany = acks.filter((m) => /Too many commands/.test(m.message)).length;
    expect(tooMany).toBeGreaterThanOrEqual(25);
    expect(tooMany).toBeLessThanOrEqual(30);
    expect(acks.filter((m) => m.message === 'Drone is offline').length).toBe(130 - tooMany);
    v.close();
  });

  it('a drone that does not answer: a member\'s commands wait for it 8 at most (stopping it, 4 more), all members\' 32 (stopping it, 8 more) – another member\'s still go', async () => {
    const d = await rawDrone('Mute');
    await waitFor(() => s.ctx.hub.droneState(d.id)?.telemetry, 10_000);
    const pilots = await Promise.all(['A', 'B', 'C'].map((n) => signup(s.app, { name: `Pilot ${n}` })));
    for (const p of pilots) await addMember(s.app, owner, p, 'pilot');
    const as = (x: Session, name: string) => ({ id: x.userId, name, role: 'pilot' as const });
    const send = (x: Session, name: string, command: string, k: number) =>
      Array.from({ length: k }, () => s.ctx.hub.sendCommand(owner.orgId, d.id, as(x, name), command, command === 'takeoff' ? { alt: 10 } : {}));
    const waitingFor = (n: number) => waitFor(() => d.got.command === n, 5000);
    const all: Promise<unknown>[] = [];
    // One member: 8 waiting – the rest refused at once; stopping it, 4 more.
    const own = send(owner, 'Flow Owner', 'takeoff', 10);
    all.push(...own);
    for (const r of await Promise.all(own.slice(8))) expect(r).toMatchObject({ delivered: false, message: "You have 8 commands waiting for Mute's answer – try again once it answers" });
    const ownStops = send(owner, 'Flow Owner', 'hold', 5);
    all.push(...ownStops);
    expect(await ownStops[4]).toMatchObject({ delivered: false, message: "You have 12 commands waiting for Mute's answer – try again once it answers" });
    await waitingFor(12);
    // A mission upload waits for its answer too.
    const plan = { home: { lat: 25.07, lon: 121.53, alt: 0 }, items: [], rallyPoints: [], geofence: null, defaultSpeed: 8, defaultAlt: 20 };
    expect(await s.ctx.hub.uploadMission(owner.orgId, d.id, { id: owner.userId, role: 'owner' }, { id: 'm-1', name: 'Mute mission', plan })).toMatchObject({
      result: 'rejected',
      message: "You have 12 commands waiting for Mute's answer – try again once it answers",
    });
    // Others still go: 32 in all.
    all.push(...send(pilots[0]!, 'Pilot A', 'takeoff', 8), ...send(pilots[1]!, 'Pilot B', 'takeoff', 8), ...send(pilots[2]!, 'Pilot C', 'takeoff', 4));
    await waitingFor(32);
    expect(await send(pilots[2]!, 'Pilot C', 'takeoff', 1)[0]).toMatchObject({ delivered: false, message: 'Mute has 32 commands waiting for its answer – try again once it answers' });
    // Stopping it goes still – 8 more at most.
    all.push(...send(pilots[1]!, 'Pilot B', 'land', 4), ...send(pilots[2]!, 'Pilot C', 'land', 4));
    await waitingFor(40);
    expect(await send(pilots[0]!, 'Pilot A', 'land', 1)[0]).toMatchObject({ delivered: false, message: 'Mute has 40 commands waiting for its answer – try again once it answers' });
    await sleep(300);
    expect(d.got.command).toBe(40);
    d.stop();
    await Promise.all(all);
  });

  it('commands over the API are within the same budget as over the live connection – refused (429) before anything is done for them', async () => {
    const d = await rawDrone('Budgeted', { answer: true });
    await waitFor(() => s.ctx.hub.droneState(d.id)?.telemetry, 10_000);
    const member = await signup(s.app, { name: 'Budget Pilot' });
    await addMember(s.app, owner, member, 'pilot');
    const url = `/api/v2/organisations/${owner.orgId}/drones/${d.id}/commands`;
    // Its live connection spends the budget (a burst to a drone that is not there)…
    const v = new Viewer(`${s.wsBase}/api/v2/live?org=${owner.orgId}`, { cookie: member.cookie });
    await v.opened;
    await v.wait((m) => m.type === 'snapshot');
    for (let i = 0; i < 100; i++) v.send({ type: 'command', droneId: 'no-such-drone', requestId: `spend-${i}`, command: 'hold', params: {} });
    await waitFor(() => v.messages.filter((m) => m.type === 'ack' && String(m.requestId).startsWith('spend-')).length === 100, 5000);
    // …so the API refuses the next ones – after a second, its body not even read – and the drone gets none.
    const at = Date.now();
    const refused = await Promise.all(Array.from({ length: 30 }, () => api(s.app, member)('POST', url, { command: 'hold' })));
    const took = Date.now() - at;
    const tooMany = refused.filter((r) => r.statusCode === 429);
    expect(tooMany.length).toBeGreaterThanOrEqual(20);
    expect(tooMany[0]!.json()).toMatchObject({ error: 'too_many_requests', message: 'Too many commands at once – wait a moment and try again' });
    expect(tooMany[0]!.headers['retry-after']).toBe('1');
    expect(took).toBeGreaterThanOrEqual(900);
    expect(d.got.command ?? 0).toBe(refused.length - tooMany.length);
    // A command of another member goes at once.
    const other = await api(s.app, owner)('POST', url, { command: 'hold' });
    expect(other.statusCode).toBe(200);
    v.close();
    d.stop();
  });

  it('manual control does not steer a drone with no new data', async () => {
    const d = await rawDrone('Steered', { answer: true });
    await waitFor(() => s.ctx.hub.droneState(d.id)?.telemetry, 10_000);
    const v = await viewer();
    v.send({ type: 'control', droneId: d.id, action: 'request' });
    await waitFor(() => s.ctx.hub.droneState(d.id)?.controller?.userId === owner.userId, 5000);
    const stick = () => v.send({ type: 'manual_control', droneId: d.id, x: 0.5, y: 0, z: 0, r: 0 });
    stick();
    await waitFor(() => (d.got.manual_control ?? 0) === 1, 5000);
    d.stopTelemetry();
    await sleep(5600);
    for (let i = 0; i < 5; i++) {
      stick();
      await sleep(50);
    }
    await sleep(300);
    expect(d.got.manual_control).toBe(1);
    v.send({ type: 'control', droneId: d.id, action: 'release' });
    v.close();
    d.stop();
  });

  it('tells a viewer when the cloud\'s latest telemetry of the drones it asks about was taken', async () => {
    const v = await viewer();
    v.send({ type: 'ping', id: 'about', t: Date.now(), late: [droneId, 'not-a-drone'] });
    const pong = await v.wait((m) => m.type === 'pong' && m.id === 'about');
    expect(Object.keys(pong.dataAt)).toEqual([droneId]);
    expect(Math.abs(pong.dataAt[droneId] - (Date.now() - AGE_MS))).toBeLessThan(500);
    v.close();
  });
});
