/**
 * How old the live console takes what it shows to be: the cloud's clock is bounded from this
 * browser's (data never look newer than they are). This computer's clock set back – seen by its
 * monotonic clock – moves what was noted along before anything noted is read: also a probe of the
 * link that is on its way just then. The hello the cloud sends again (a role changed) is no
 * exchange of clocks: it does not make data look old.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { LiveDroneState, Telemetry } from '@athena-sky/shared';

class FakeSocket {
  static readonly OPEN = 1;
  static last: FakeSocket | null = null;
  readyState = 0;
  binaryType = 'blob';
  onopen: (() => void) | null = null;
  onmessage: ((ev: { data: unknown }) => void) | null = null;
  onclose: ((ev: { code: number }) => void) | null = null;
  readonly sent: Record<string, any>[] = [];
  constructor(readonly url: string) {
    FakeSocket.last = this;
  }
  send(data: string): void {
    this.sent.push(JSON.parse(data));
  }
  close(): void {
    this.readyState = 3;
  }
  open(): void {
    this.readyState = 1;
    this.onopen?.();
  }
  deliver(msg: object): void {
    this.onmessage?.({ data: JSON.stringify(msg) });
  }
}

/** This computer's clock (Date.now) and its monotonic clock (performance.now); the cloud's runs with the second. */
let wall = 1_700_000_000_000;
let mono = 50_000;
const cloudNow = () => 1_700_000_000_000 - 50_000 + mono;
const pass = (ms: number) => {
  wall += ms;
  mono += ms;
};

const AT_REST: Telemetry = {
  lat: 25,
  lon: 121,
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
} as Telemetry;

const drone = (at: number): LiveDroneState => ({
  droneId: 'd1',
  name: 'Clocked',
  fleetId: null,
  model: 'X4',
  firmware: null,
  online: true,
  connectedAt: at,
  lastSeenAt: at,
  telemetry: AT_REST,
  telemetryAt: at,
  controller: null,
  flightId: null,
  videoAvailable: false,
  mission: null,
});

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'setInterval', 'clearTimeout', 'clearInterval'] });
  vi.stubGlobal('window', globalThis);
  vi.stubGlobal('location', { protocol: 'http:', host: 'test.local' });
  vi.stubGlobal('WebSocket', FakeSocket);
  vi.stubGlobal('requestAnimationFrame', (cb: () => void) => setTimeout(cb, 0));
  vi.spyOn(Date, 'now').mockImplementation(() => wall);
  vi.spyOn(performance, 'now').mockImplementation(() => mono);
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

/** A client connected to a cloud whose clock is this computer's; a drone sending telemetry. */
async function connected() {
  const { LiveClient } = await import('../src/api/live');
  const client = new LiveClient('org-1');
  const ws = FakeSocket.last!;
  pass(20);
  ws.open();
  ws.deliver({ type: 'hello', userId: 'u1', orgId: 'org-1', serverTime: cloudNow(), canControl: true, role: 'owner' });
  ws.deliver({ type: 'snapshot', drones: [drone(cloudNow())], users: [] });
  // A probe answered at once: the clocks are known to be within a few ms.
  const probe = ws.sent.find((m) => m.type === 'ping')!;
  pass(10);
  ws.deliver({ type: 'pong', id: probe.id, t: probe.t, serverTime: cloudNow() - 5 });
  const telemetry = () => ws.deliver({ type: 'telemetry', droneId: 'd1', data: AT_REST, at: cloudNow() });
  const view = () => client.getSnapshot().drones.d1!;
  return { client, ws, telemetry, view };
}

describe('live console: how old what it shows is', () => {
  it('this computer\'s clock set back while a probe of the link is on its way: the data are not taken for newer than they are', async () => {
    const { client, ws, telemetry, view } = await connected();
    pass(1000);
    telemetry();
    // A probe goes; its answer takes 2.5 s to come; this computer's clock is set back by 2 s meanwhile.
    (client as unknown as { probe(): void }).probe();
    const probe = ws.sent.filter((m) => m.type === 'ping').at(-1)!;
    const answeredAt = cloudNow() + 10;
    pass(2500);
    wall -= 2000;
    ws.deliver({ type: 'pong', id: probe.id, t: probe.t, serverTime: answeredAt });
    // Taken now (in the cloud's clock): as old as it is in this computer's clock as it counts now.
    telemetry();
    expect(view().dataAt).toBeLessThanOrEqual(Date.now() + 5);
    expect(view().late).toBe(false);
    // Nothing more comes: it is late 5 s after it was taken – not 7.
    pass(4900);
    (client as unknown as { refresh(): void }).refresh();
    expect(view().late).toBe(false);
    pass(300);
    (client as unknown as { refresh(): void }).refresh();
    expect(view().late).toBe(true);
    client.close();
  });

  it('this computer\'s clock set back in small steps: seen once they add up – the drone is late 5 s after its data, not later', async () => {
    const { client, telemetry, view } = await connected();
    const refresh = () => (client as unknown as { refresh(): void }).refresh();
    pass(1000);
    telemetry();
    // Every half second the clock is set back by 0.3 s – a step too small to be seen alone.
    for (let k = 0; k < 9; k++) {
      pass(500);
      wall -= 300;
      refresh();
    }
    expect(view().late).toBe(false);
    pass(500);
    wall -= 300;
    refresh();
    // 5.1 s after the data were taken (the clock 3 s behind meanwhile): late.
    pass(100);
    refresh();
    expect(view().late).toBe(true);
    client.close();
  });

  it('the hello sent again (the role changed) is no exchange of clocks: the data do not look old', async () => {
    const { client, ws, telemetry, view } = await connected();
    // A minute later the role changes: the cloud sends its hello again.
    pass(60_000);
    telemetry();
    expect(view().late).toBe(false);
    ws.deliver({ type: 'hello', userId: 'u1', orgId: 'org-1', serverTime: cloudNow(), canControl: false, role: 'viewer' });
    pass(50);
    telemetry();
    expect(view().late).toBe(false);
    expect(Date.now() - view().dataAt).toBeLessThan(100);
    expect(client.getSnapshot().role).toBe('viewer');
    client.close();
  });
});
