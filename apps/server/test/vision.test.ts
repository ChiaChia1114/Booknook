import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { readFileSync, writeFileSync } from 'node:fs';
import jpeg from 'jpeg-js';
import WebSocket from 'ws';
import { ConvNet, base64ToBytes, colorName, destinationPoint, haversineDistance, initialBearing, objectGroundPoint, type Telemetry } from '@athena-sky/shared';
import { FrameRenderer, LinkClient, SimWorld, VIDEO_PRESETS, VirtualDrone, cameraPose, targetBox, worldAnchor } from '@athena-sky/simulator';
import { analyzeFrame, loadDetectorModel } from '../src/vision/analyze';
import { api, signup, startServer, Viewer, waitFor, type Session, type TestServer } from './helpers';

const model = loadDetectorModel()!;

describe('built-in object detector', () => {
  it('is installed with its evaluation', () => {
    expect(model.format).toBe('athena-centernet-1');
    expect(model.classes).toEqual(['person', 'vehicle']);
    expect((model.meta as any).test.vehicle.recall).toBeGreaterThan(0.8);
  });

  it('gives the same outputs as the training implementation (numpy)', () => {
    const fx = JSON.parse(readFileSync(new URL('./fixtures/detector-parity.json', import.meta.url), 'utf8'));
    const net = new ConvNet(model);
    fx.inputs.forEach((b64: string, i: number) => {
      const out = net.forward(base64ToBytes(b64));
      const ref = new Float32Array(base64ToBytes(fx.outputs[i]).buffer);
      expect([out.c, out.h, out.w]).toEqual(fx.shape);
      let worst = 0;
      for (let k = 0; k < ref.length; k++) worst = Math.max(worst, Math.abs(out.data[k]! - ref[k]!));
      expect(worst).toBeLessThan(2e-3);
    });
  });

  it('detects people and vehicles in unseen worlds and geolocates them', () => {
    // A world and times the detector was not trained on, full pipeline from the JPEG frame.
    const world = new SimWorld({ lat: 35.68, lon: 139.69 }, { people: 24, vehicles: 10 });
    const renderer = new FrameRenderer(VIDEO_PRESETS.sd);
    const net = new ConvNet(model);
    const stats = { person: { tp: 0, fp: 0, fn: 0, err: [] as number[], colorOk: 0 }, vehicle: { tp: 0, fp: 0, fn: 0, err: [] as number[], colorOk: 0 } };
    let seed = 99;
    const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
    for (let i = 0; i < 120; i++) {
      const t = Date.UTC(2027, 5, 1) + Math.floor(rnd() * 86_400_000);
      const targets = world.targetsAt(t);
      const target = targets[Math.floor(rnd() * targets.length)]!;
      const alt = 10 + rnd() * 15;
      const bearing = rnd() * 360;
      const pos = destinationPoint(world.positionOf(target), bearing, alt * (0.6 + rnd() * 0.8));
      const tel = { t, lat: pos.lat, lon: pos.lon, altRel: alt, heading: (bearing + 180 + (rnd() - 0.5) * 50 + 360) % 360, groundSpeed: 3, roll: 0, pitch: 0, battery: { pct: 80 }, mode: 'GUIDED' } as unknown as Telemetry;
      const frame = renderer.render(tel, world.anchor, targets);
      const r = analyzeFrame(net, frame, (model.meta as any).threshold ?? 0.35);
      const cam = cameraPose(tel, world.anchor, 640, 360);
      const gts = targets
        .map((tg) => ({ tg, b: targetBox(cam, tg) }))
        .filter((g) => g.b && g.b.visible >= 0.6 && g.b.depth < 400 && (g.b.y1 - g.b.y0) / 2 >= (g.tg.kind === 'person' ? 6 : 4));
      const used = new Set<number>();
      for (const d of r.detections) {
        const box = [d.box[0] * 640, d.box[1] * 360, (d.box[0] + d.box[2]) * 640, (d.box[1] + d.box[3]) * 360];
        let best = 0;
        let bj = -1;
        gts.forEach((g, j) => {
          if (used.has(j) || g.tg.kind !== d.cls) return;
          const x0 = Math.max(box[0]!, g.b!.x0);
          const y0 = Math.max(box[1]!, g.b!.y0);
          const x1 = Math.min(box[2]!, g.b!.x1);
          const y1 = Math.min(box[3]!, g.b!.y1);
          const inter = Math.max(0, x1 - x0) * Math.max(0, y1 - y0);
          const u = (box[2]! - box[0]!) * (box[3]! - box[1]!) + (g.b!.x1 - g.b!.x0) * (g.b!.y1 - g.b!.y0) - inter;
          if (inter / u > best) {
            best = inter / u;
            bj = j;
          }
        });
        if (best >= 0.5) {
          used.add(bj);
          stats[d.cls].tp++;
          const gp = objectGroundPoint(d, { lat: tel.lat, lon: tel.lon, heightM: alt + 0.3, headingDeg: tel.heading, pitchDeg: -45, hfovDeg: 78, aspect: 16 / 9 })!;
          stats[d.cls].err.push(haversineDistance(gp, world.positionOf(gts[bj]!.tg)));
          // Recognition: clothing / body colour.
          if (d.color === colorName(gts[bj]!.tg.color)) stats[d.cls].colorOk++;
        } else {
          // Small or partly hidden objects the matching above leaves out are not false alarms.
          const anyTarget = targets.some((tg) => {
            const b = targetBox(cam, tg);
            if (!b || b.visible <= 0) return false;
            return box[0]! < b.x1 && box[2]! > b.x0 && box[1]! < b.y1 && box[3]! > b.y0;
          });
          if (!anyTarget) stats[d.cls].fp++;
        }
      }
      gts.forEach((g, j) => {
        if (!used.has(j)) stats[g.tg.kind].fn++;
      });
    }
    const median = (a: number[]) => [...a].sort((x, y) => x - y)[Math.floor(a.length / 2)]!;
    // VISION_REPORT=<file>: writes the measured figures (used for the documentation).
    if (process.env.VISION_REPORT) {
      const report = Object.fromEntries(Object.entries(stats).map(([cls, v]) => [cls, { precision: v.tp / (v.tp + v.fp), recall: v.tp / (v.tp + v.fn), medianErrorM: median(v.err), colour: v.colorOk / v.tp, n: v.tp }]));
      writeFileSync(process.env.VISION_REPORT, JSON.stringify(report, null, 2));
    }
    for (const cls of ['person', 'vehicle'] as const) {
      const s = stats[cls];
      const precision = s.tp / Math.max(1, s.tp + s.fp);
      const recall = s.tp / Math.max(1, s.tp + s.fn);
      expect(s.tp).toBeGreaterThan(20);
      expect(precision, `${cls} precision`).toBeGreaterThan(0.85);
      expect(recall, `${cls} recall`).toBeGreaterThan(0.8);
      expect(median(s.err), `${cls} geolocation error`).toBeLessThan(cls === 'person' ? 2.5 : 4);
      expect(s.colorOk / s.tp, `${cls} colour recognition`).toBeGreaterThan(0.7);
    }
  }, 120_000);
});

describe('live AI vision: detection, tracking and follow-me', () => {
  let s: TestServer;
  let owner: Session;
  let call: ReturnType<typeof api>;
  let viewer: Viewer;
  let client: LinkClient;
  let droneId: string;
  let linkKey: string;
  const HOME = { lat: 25.0732, lon: 121.5355 };
  const world = new SimWorld(worldAnchor(HOME));

  beforeAll(async () => {
    s = await startServer({ vision: { mode: 'worker', hz: 4 } });
    owner = await signup(s.app, { name: 'Vision Pilot' });
    call = api(s.app, owner);
    const created = (await call('POST', `/api/v2/organisations/${owner.orgId}/drones`, { name: 'Eye-1', model: 'X4' })).json();
    droneId = created.id;
    linkKey = created.linkKey;
    // Start next to a person so that the camera can find it quickly.
    const person = world.targetsAt(Date.now()).find((t) => t.kind === 'person')!;
    const home = destinationPoint(world.positionOf(person), 180, 12);
    client = new LinkClient({ url: `${s.wsBase}/api/v2/link`, key: linkKey, drone: new VirtualDrone({ home, groundAltMsl: 10, seed: 5 }), timeScale: 2, video: true });
    client.start();
    viewer = new Viewer(`${s.wsBase}/api/v2/live?org=${owner.orgId}`, { cookie: owner.cookie, origin: s.baseUrl });
    await viewer.opened;
    await waitFor(() => s.ctx.hub.droneState(droneId)?.telemetry, 10_000);
  }, 30_000);

  afterAll(async () => {
    viewer?.close();
    await client?.stop();
    await s?.close();
  });

  const cmd = async (command: string, params: Record<string, unknown> = {}) => {
    const requestId = Math.random().toString(36).slice(2);
    viewer.send({ type: 'command', droneId, requestId, command, params });
    return viewer.wait((m) => m.type === 'ack' && m.requestId === requestId);
  };
  const truth = (id: string) => world.positionOf(world.targetsAt(Date.now()).find((t) => t.id === id)!);
  const nearestTarget = (lat: number, lon: number, kind: string) =>
    world
      .targetsAt(Date.now())
      .filter((t) => t.kind === kind)
      .map((t) => ({ t, d: haversineDistance({ lat, lon }, world.positionOf(t)) }))
      .sort((a, b) => a.d - b.d)[0]!;

  it('detects and geolocates objects in the live video (worker thread)', async () => {
    expect((await cmd('takeoff', { alt: 14 })).result).toBe('accepted');
    await waitFor(() => (s.ctx.hub.telemetryOf(droneId)?.altRel ?? 0) > 12, 20_000);
    // Face the person (north of the take-off point).
    const tel = s.ctx.hub.telemetryOf(droneId)!;
    const p = nearestTarget(tel.lat, tel.lon, 'person');
    await cmd('goto', { ...destinationPoint(world.positionOf(p.t), initialBearing(world.positionOf(p.t), tel), 14), alt: 14, yaw: initialBearing(tel, world.positionOf(p.t)) });
    const res = await call('POST', `/api/v2/organisations/${owner.orgId}/drones/${droneId}/ai`, { enabled: true });
    expect(res.statusCode).toBe(200);
    expect(res.json().status).toMatchObject({ enabled: true, source: 'cloud' });
    const msg = await viewer.wait((m) => m.type === 'detections' && m.droneId === droneId && m.objects.some((o: any) => o.cls === 'person' && o.lat !== null), 30_000);
    const obj = msg.objects.find((o: any) => o.cls === 'person' && o.lat !== null);
    expect(nearestTarget(obj.lat, obj.lon, 'person').d).toBeLessThan(6);
    expect(obj.box.every((v: number) => v >= -0.05 && v <= 1.05)).toBe(true);
    // Status in the drone state and the REST view.
    expect((await call('GET', `/api/v2/organisations/${owner.orgId}/drones/${droneId}/ai`)).json().stats.frames).toBeGreaterThan(0);
    expect(viewer.find((m) => m.type === 'status' && m.drone.droneId === droneId && m.drone.ai?.enabled)).toBeTruthy();
    expect(viewer.find((m) => m.type === 'event' && m.droneId === droneId && m.code === 'ai_detection')).toBeTruthy();
  }, 60_000);

  it('follows a walking person and holds when told to stop', async () => {
    const last = [...viewer.messages].reverse().find((m) => m.type === 'detections' && m.droneId === droneId && m.objects.some((o: any) => o.cls === 'person' && o.lat !== null));
    const obj = last.objects.find((o: any) => o.cls === 'person' && o.lat !== null);
    const person = nearestTarget(obj.lat, obj.lon, 'person').t;
    const res = await call('POST', `/api/v2/organisations/${owner.orgId}/drones/${droneId}/ai/follow`, { trackId: obj.trackId, altM: 14 });
    expect(res.statusCode).toBe(200);
    expect(res.json().status).toMatchObject({ following: obj.trackId, followStatus: 'following' });
    // Over 20 s the person walks ~25 m: the drone keeps it in view at the stand-off distance.
    const distances: number[] = [];
    for (let k = 0; k < 20; k++) {
      await new Promise((r) => setTimeout(r, 1000));
      const tel = s.ctx.hub.telemetryOf(droneId)!;
      distances.push(haversineDistance(tel, truth(person.id)));
    }
    // Still following the same person (the tracker may have re-identified it under a new number).
    const status = s.ctx.vision.status(droneId)!;
    expect(status.following).not.toBeNull();
    const followed = s.ctx.vision.objects(droneId).find((o) => o.trackId === status.following);
    if (followed?.lat != null && followed.lon != null) expect(nearestTarget(followed.lat, followed.lon, 'person').t.id).toBe(person.id);
    const late = distances.slice(8);
    expect(Math.max(...late), `distances ${distances.map((d) => d.toFixed(0)).join(',')}`).toBeLessThan(28);
    expect(Math.min(...late)).toBeGreaterThan(5);
    const stop = await call('DELETE', `/api/v2/organisations/${owner.orgId}/drones/${droneId}/ai/follow`);
    expect(stop.json().status.following).toBeNull();
    await waitFor(() => s.ctx.hub.telemetryOf(droneId)?.mode === 'HOLD', 10_000);
    // The confirmed objects were recorded with the flight.
    expect(viewer.find((m) => m.type === 'event' && m.code === 'follow' && /stopped by/.test(m.message))).toBeTruthy();
    expect((await call('POST', `/api/v2/organisations/${owner.orgId}/drones/${droneId}/ai`, { enabled: false })).json().status).toBeNull();
    await cmd('land');
  }, 90_000);

  it('rejects follow requests that cannot be honoured', async () => {
    expect((await call('POST', `/api/v2/organisations/${owner.orgId}/drones/${droneId}/ai/follow`, { trackId: 999 })).statusCode).toBe(400);
    const stranger = await signup(s.app);
    expect((await api(s.app, stranger)('POST', `/api/v2/organisations/${owner.orgId}/drones/${droneId}/ai`, { enabled: true })).statusCode).toBe(404);
  });

  it('uses detections from an on-board AI', async () => {
    const created = (await call('POST', `/api/v2/organisations/${owner.orgId}/drones`, { name: 'Edge-2', model: 'X4' })).json();
    const ws = new WebSocket(`${s.wsBase}/api/v2/link`, { headers: { authorization: `Bearer ${created.linkKey}` } });
    await new Promise((r) => ws.once('open', r));
    const send = (m: unknown) => ws.send(JSON.stringify(m));
    send({ type: 'hello', firmware: '1.0', camera: { hfovDeg: 78, pitchDeg: -45 } });
    const tel = { t: Date.now(), lat: 25.07, lon: 121.53, altMsl: 40, altRel: 30, heading: 0, groundSpeed: 0, climbRate: 0, roll: 0, pitch: 0, yaw: 0, battery: { pct: 90, voltage: 22 }, gps: { fix: 3, satellites: 12, hdop: 0.8 }, mode: 'HOLD', armed: true, inAir: true };
    for (let k = 0; k < 3; k++) {
      send({ type: 'telemetry', ...tel, t: Date.now() });
      send({ type: 'detections', objects: [{ cls: 'vehicle', score: 0.9, box: [0.45, 0.45, 0.1, 0.08] }, { cls: 'unicorn', score: 1, box: [0, 0, 1, 1] }] });
      await new Promise((r) => setTimeout(r, 300));
    }
    const ai = await waitFor(async () => {
      const r = (await call('GET', `/api/v2/organisations/${owner.orgId}/drones/${created.id}/ai`)).json();
      return r.objects.length ? r : null;
    }, 5000);
    expect(ai.status).toMatchObject({ enabled: true, source: 'onboard' });
    expect(ai.objects).toHaveLength(1);
    expect(ai.objects[0]).toMatchObject({ cls: 'vehicle' });
    // Geolocated 30 m ahead (45° pitch, object below the image centre: a little closer).
    const d = haversineDistance({ lat: 25.07, lon: 121.53 }, ai.objects[0]);
    expect(d).toBeGreaterThan(20);
    expect(d).toBeLessThan(32);
    ws.close();
  });
});
