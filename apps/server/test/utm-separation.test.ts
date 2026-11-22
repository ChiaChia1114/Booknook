/**
 * Loss of separation between own drones is judged along the stretch flown between two telemetry
 * updates: two drones passing each other between updates are reported too.
 */
import { EventEmitter } from 'node:events';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { destinationPoint, type Telemetry } from '@athena-sky/shared';
import { UtmMonitor } from '../src/airspace/utm-monitor';
import type { AirspaceService } from '../src/airspace/providers';
import type { Db } from '../src/db/database';
import type { Hub } from '../src/realtime/hub';
import type { NotificationService } from '../src/realtime/notifications';

const HOME = { lat: 47.3977, lon: 8.5456 };

function setup(sameSwarm = false) {
  const events = new EventEmitter();
  const latest = new Map<string, Telemetry>();
  const created: { droneId?: string | null; code: string; message: string; data: unknown }[] = [];
  const hub = {
    events,
    droneName: (id: string) => id.toUpperCase(),
    orgDroneStates: () => [...latest.entries()].map(([droneId, telemetry]) => ({ droneId, name: droneId.toUpperCase(), online: true, telemetry })),
  } as unknown as Hub;
  const notifications = {
    create: (_org: string, n: { droneId?: string | null; code: string; message: string; data: unknown }) => {
      created.push(n);
      return { id: `n${created.length}` };
    },
    resolve: () => undefined,
  } as unknown as NotificationService;
  // Only the separation check runs (zones are checked at most once per "interval").
  new UtmMonitor({ db: {} as Db, hub, airspace: {} as AirspaceService, notifications, sameSwarm: () => sameSwarm }, { intervalMs: Number.MAX_SAFE_INTEGER, clearAfterMs: 10_000 });
  const report = (droneId: string, p: { lat: number; lon: number }, altRel: number) => {
    const t = { lat: p.lat, lon: p.lon, altRel, altMsl: 400 + altRel, inAir: true, armed: true, t: Date.now(), mode: 'MISSION' } as unknown as Telemetry;
    latest.set(droneId, t);
    events.emit('telemetry', 'org', droneId, t);
  };
  return { report, created };
}

describe('loss of separation between telemetry updates', () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-06-01T10:00:00Z'));
  });
  afterEach(() => vi.useRealTimers());

  it('reports two drones that passed each other between two updates a second apart', () => {
    const { report, created } = setup();
    const a = destinationPoint(HOME, 0, 2);
    // B crosses A's position at 42 m/s, 21 m before and 21 m after it at its updates.
    for (let k = 0; k < 4; k++) {
      report('a', a, 40);
      report('b', destinationPoint(HOME, 90, -63 + k * 42), 40);
      vi.advanceTimersByTime(1000);
    }
    const sep = created.filter((n) => n.code === 'loss_of_separation');
    expect(sep).toHaveLength(1);
    expect(sep[0]!.data).toMatchObject({ horizontalM: 2, verticalM: 0 });
    expect(sep[0]!.message).toMatch(/came 2 m apart horizontally and 0 m vertically/);
  });

  it('does not report drones that stay apart, nor stretches across a gap in the telemetry', () => {
    const parallel = setup();
    for (let k = 0; k < 4; k++) {
      parallel.report('a', destinationPoint(HOME, 0, k * 10), 40);
      parallel.report('b', destinationPoint(destinationPoint(HOME, 90, 25), 0, k * 10), 40);
      vi.advanceTimersByTime(1000);
    }
    expect(parallel.created).toHaveLength(0);
    // Ten seconds without telemetry: the straight line in between is not what was flown.
    const gap = setup();
    gap.report('a', HOME, 40);
    gap.report('b', destinationPoint(HOME, 90, -300), 40);
    vi.advanceTimersByTime(10_000);
    gap.report('b', destinationPoint(HOME, 90, 300), 40);
    gap.report('a', HOME, 40);
    expect(gap.created).toHaveLength(0);
  });

  it('uses the tighter limits within a swarm operation, between updates as well', () => {
    const swarm = setup(true);
    const a = HOME;
    // 15 m apart (formation spacing): not reported; passing 1 m apart vertically 2 m: reported.
    swarm.report('a', a, 40);
    swarm.report('b', destinationPoint(HOME, 90, 15), 40);
    vi.advanceTimersByTime(500);
    swarm.report('a', a, 40);
    swarm.report('b', destinationPoint(HOME, 90, 15), 40);
    expect(swarm.created).toHaveLength(0);
    vi.advanceTimersByTime(500);
    swarm.report('b', destinationPoint(destinationPoint(HOME, 90, -10), 0, 1), 42);
    vi.advanceTimersByTime(500);
    swarm.report('b', destinationPoint(destinationPoint(HOME, 90, -30), 0, 1), 42);
    expect(swarm.created.map((n) => n.code)).toEqual(['loss_of_separation']);
  });
});
