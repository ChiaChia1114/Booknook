/**
 * A live viewer's link, simulated (the flow-control tests and measurements use it): drones sending
 * telemetry and video through the cloud's flow control to a viewer over a link of a given
 * distance and rate, the viewer acknowledging what it receives as the web app does.
 */
import { FlowControl } from '../src/realtime/flow';

export interface LinkSpec {
  /** Cloud → viewer: propagation (ms; or as a function of time) and bottleneck rate (bytes per ms, Infinity: none). */
  down: number | ((t: number) => number);
  rate: (t: number) => number;
  /** Viewer → cloud (acknowledgements). */
  up: number;
  /** The viewer does not take in messages during these intervals (a busy page). */
  busy?: [number, number][];
}

export interface Run {
  /** Telemetry samples: share of those taken that reached the viewer (after the warm-up). */
  telemetryShare: number;
  /** Age of the newest telemetry the viewer has, sampled every 250 ms (after the warm-up): percentiles and maximum (ms). */
  p50: number;
  p90: number;
  max: number;
  /** Video frames: share of those taken that reached the viewer, and the oldest one on arrival (ms). */
  frameShare: number;
  frameMaxAge: number;
  /** The flow control at the end. */
  flow: FlowControl;
  /** Ages of what the viewer has, per 250-ms sample, with their times. */
  ages: { t: number; age: number }[];
}

export const DRONES = 3;
export const TELEMETRY_HZ = 5;
/** Video frames as the simulator's camera makes them (JPEG of 640×360 and 1280×720). */
export const FRAME_BYTES = { sd: 20_000, hd: 60_000 };
const TELEMETRY_BYTES = 600;

export function simulate(link: LinkSpec, opts: { seconds: number; warmup?: number; video?: 'sd' | 'hd' | null }): Run {
  const end = opts.seconds * 1000;
  const warmup = opts.warmup ?? 10_000;
  const downAt = typeof link.down === 'number' ? () => link.down as number : link.down;
  const counted = end - downAt(end) - 5000;
  let lastArrive = 0;
  const video = opts.video === undefined ? 'sd' : opts.video;
  const fps = video === 'hd' ? 6 : 10;
  const frameBytes = FRAME_BYTES[video ?? 'sd'];
  const flow = new FlowControl(0, 2);
  let sent = 2;
  // In flight to the viewer (in order): when it arrives, what it is.
  const toViewer: { arrive: number; kind: 'telemetry' | 'frame' | 'other'; taken: number; drone: number }[] = [];
  let linkFree = 0;
  const acks: { arrive: number; n: number }[] = [];
  // The hello and the snapshot (sent before the viewer acknowledged) were received.
  let received = 2;
  let lastAckSent = -Infinity;
  let ackDue: number | null = null;
  const newest: number[] = new Array(DRONES).fill(-Infinity);
  let telemetryTaken = 0;
  let telemetryGot = 0;
  let framesTaken = 0;
  let framesGot = 0;
  let frameMaxAge = 0;
  const ages: { t: number; age: number }[] = [];
  const held = new Map<number, number>();

  const transmit = (now: number, bytes: number, kind: 'telemetry' | 'frame' | 'other', taken: number, drone: number) => {
    sent++;
    flow.sent(sent, bytes, now, kind === 'frame');
    // The bottleneck sends in order at its rate; a stalled one (rate 0) waits.
    let start = Math.max(now, linkFree);
    while (link.rate(start) === 0) start++;
    const r = link.rate(start);
    linkFree = start + (Number.isFinite(r) ? bytes / r : 0);
    // In order (a link that gets shorter does not reorder what is on it).
    lastArrive = Math.max(lastArrive, linkFree + downAt(linkFree));
    toViewer.push({ arrive: lastArrive, kind, taken, drone });
  };

  for (let now = 0; now <= end; now++) {
    // The cloud: acknowledgements arriving; what was kept back goes once the link keeps up.
    while (acks.length && acks[0]!.arrive <= now) {
      flow.ack(Math.min(acks.shift()!.n, sent), now);
      if (held.size && !flow.congested(now)) {
        for (const [drone, taken] of held) transmit(now, TELEMETRY_BYTES, 'telemetry', taken, drone);
        held.clear();
      }
    }
    for (let d = 0; d < DRONES; d++) {
      // Telemetry: only the latest waits while congested.
      if ((now + d * 37) % (1000 / TELEMETRY_HZ) === 0) {
        // Counted unless taken too late to arrive before the end.
        if (now >= warmup && now < counted) telemetryTaken++;
        if (flow.congested(now)) held.set(d, now);
        else {
          held.delete(d);
          transmit(now, TELEMETRY_BYTES, 'telemetry', now, d);
        }
      }
      if (video && (now + d * 23) % Math.round(1000 / fps) === 0) {
        if (now >= warmup && now < counted) framesTaken++;
        if (flow.allowsFrame(frameBytes, now)) transmit(now, frameBytes, 'frame', now, d);
      }
    }
    // Other messages now and then (answers to the viewer's probes, events).
    if (now % 1000 === 500) transmit(now, 120, 'other', now, -1);
    // The viewer: what arrives, unless the page is busy.
    const busy = link.busy?.some(([a, b]) => now >= a && now < b);
    while (!busy && toViewer.length && toViewer[0]!.arrive <= now) {
      const m = toViewer.shift()!;
      received++;
      if (m.kind === 'telemetry') {
        if (m.taken > newest[m.drone]!) newest[m.drone] = m.taken;
        if (m.taken >= warmup && m.taken < counted) telemetryGot++;
      } else if (m.kind === 'frame' && m.taken >= warmup && m.taken < counted) {
        framesGot++;
        frameMaxAge = Math.max(frameMaxAge, now - m.taken);
      }
      // Acknowledged at most every 50 ms (and once more after the last).
      if (now - lastAckSent >= 50) {
        lastAckSent = now;
        acks.push({ arrive: now + link.up, n: received });
      } else ackDue ??= lastAckSent + 50;
    }
    if (ackDue !== null && now >= ackDue && !busy) {
      ackDue = null;
      lastAckSent = now;
      acks.push({ arrive: now + link.up, n: received });
    }
    if (now >= warmup && now % 250 === 0) for (const t of newest) ages.push({ t: now, age: now - t });
  }
  const sorted = ages.map((a) => a.age).sort((a, b) => a - b);
  const pct = (p: number) => sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))]!;
  return {
    telemetryShare: telemetryGot / telemetryTaken,
    p50: pct(0.5),
    p90: pct(0.9),
    max: sorted.at(-1)!,
    frameShare: framesTaken ? framesGot / framesTaken : 0,
    frameMaxAge,
    flow,
    ages,
  };
}

export const KiB = 1024 / 1000; // bytes per ms of 1 KiB/s
