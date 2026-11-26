/**
 * The live link keeps what a viewer gets current: flow control (a viewer that acknowledges what it
 * receives gets no more than its link carries – video dropped, the latest telemetry kept back –
 * so that latency never builds up), and times passed on in the cloud's clock (the drone's clock
 * probed), so that viewers can tell how old the data is.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import WebSocket from 'ws';
import { encodeLinkVideoFrame, decodeLiveVideoFrame } from '@athena-sky/shared';
import { api, signup, startServer, Viewer, waitFor, type Session, type TestServer } from './helpers';

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
    // nothing more of the video or the telemetry is sent.
    acking = false;
    await sleep(700);
    const framesStalled = v.frames.length;
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
