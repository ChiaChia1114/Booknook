import { describe, expect, it } from 'vitest';
import type { MissionPlan } from '@athena-sky/shared';
import { VirtualDrone } from '../src/drone';

const HOME = { lat: 47.397742, lon: 8.545594, altMsl: 488 };

/** Steps the simulation in 0.1 s steps for up to `seconds`, stopping early once `until` holds. */
function fly(d: VirtualDrone, seconds: number, until?: () => boolean): boolean {
  for (let i = 0; i < seconds * 10; i++) {
    d.step(0.1);
    if (until?.()) return true;
  }
  return false;
}

function landedDrone(): VirtualDrone {
  const d = new VirtualDrone({ home: HOME, groundAltMsl: HOME.altMsl, seed: 7 }, {}, 0);
  expect(d.handleCommand('takeoff', { alt: 10 }).result).toBe('accepted');
  expect(fly(d, 60, () => d.telemetry().altRel > 9)).toBe(true);
  expect(d.handleCommand('land', {}).result).toBe('accepted');
  expect(fly(d, 120, () => !d.telemetry().inAir)).toBe(true);
  return d;
}

/** Lets 1.99 s pass after the touch-down (it disarms by itself after 2 s). */
function justBeforeDisarm(d: VirtualDrone): void {
  fly(d, 1.9);
  d.step(0.09);
}

describe('virtual drone after a landing', () => {
  it('disarms by itself two seconds after touching down', () => {
    const d = landedDrone();
    fly(d, 1);
    expect(d.telemetry().armed).toBe(true);
    fly(d, 1.5);
    expect(d.telemetry().armed).toBe(false);
  });

  it('takes off when told to right after touching down – the disarm that follows a landing does not cut the take-off short', () => {
    const d = landedDrone();
    // Just before it would disarm by itself.
    justBeforeDisarm(d);
    expect(d.telemetry().armed).toBe(true);
    expect(d.handleCommand('takeoff', { alt: 12 }).result).toBe('accepted');
    expect(fly(d, 60, () => d.telemetry().altRel > 11)).toBe(true);
    expect(d.telemetry()).toMatchObject({ armed: true, inAir: true });
  });

  it('starts a mission right after touching down the same way', () => {
    const d = landedDrone();
    justBeforeDisarm(d);
    const plan: MissionPlan = {
      defaultSpeed: 6,
      defaultAlt: 15,
      rallyPoints: [],
      items: [
        { id: 'a', type: 'takeoff', alt: 15 },
        { id: 'b', type: 'waypoint', lat: HOME.lat + 0.0005, lon: HOME.lon, alt: 15 },
      ],
    };
    expect(d.loadMission('m1', plan).result).toBe('accepted');
    expect(d.handleCommand('mission_start', {}).result).toBe('accepted');
    expect(fly(d, 60, () => d.telemetry().altRel > 10)).toBe(true);
    expect(d.telemetry().armed).toBe(true);
  });

  it('an arm command right after touching down keeps it armed for the usual time on the ground', () => {
    const d = landedDrone();
    justBeforeDisarm(d);
    expect(d.handleCommand('arm', {}).result).toBe('accepted');
    fly(d, 5);
    expect(d.telemetry().armed).toBe(true);
    // Not taken off: it disarms by itself after half a minute, as after any arming.
    fly(d, 30);
    expect(d.telemetry().armed).toBe(false);
  });
});
