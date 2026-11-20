import { describe, expect, it } from 'vitest';
import {
  clampAxis,
  decodeLinkVideoFrame,
  decodeLiveVideoFrame,
  encodeLinkVideoFrame,
  encodeLiveVideoFrame,
} from '../src/protocol';
import { can, permissionsOf } from '../src/roles';
import { sanitizeTelemetry } from '../src/telemetry';

const JPEG = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3, 0xff, 0xd9]);

describe('video framing', () => {
  it('round-trips link frames', () => {
    const f = encodeLinkVideoFrame(1_700_000_000_123.5, 2, JPEG);
    const d = decodeLinkVideoFrame(f)!;
    expect(d.ts).toBe(1_700_000_000_123.5);
    expect(d.stream).toBe(2);
    expect([...d.jpeg]).toEqual([...JPEG]);
  });

  it('rejects non-JPEG payloads', () => {
    const bad = encodeLinkVideoFrame(1, 0, new Uint8Array([1, 2, 3, 4]));
    expect(decodeLinkVideoFrame(bad)).toBeNull();
    expect(decodeLinkVideoFrame(new Uint8Array([9, 9]))).toBeNull();
  });

  it('round-trips live frames with drone id', () => {
    const id = '7f1c2a8e-1111-4c4c-9999-0123456789ab';
    const d = decodeLiveVideoFrame(encodeLiveVideoFrame(id, 42, 0, JPEG))!;
    expect(d.droneId).toBe(id);
    expect(d.ts).toBe(42);
    expect([...d.jpeg]).toEqual([...JPEG]);
  });

  it('clamps manual control axes', () => {
    expect(clampAxis(3)).toBe(1);
    expect(clampAxis(-7)).toBe(-1);
    expect(clampAxis(NaN)).toBe(0);
    expect(clampAxis('1')).toBe(0);
  });
});

describe('telemetry sanitisation', () => {
  it('keeps valid fields and drops garbage', () => {
    const t = sanitizeTelemetry({
      t: 5,
      lat: 10,
      lon: 20,
      altMsl: 100,
      altRel: 30,
      heading: 370,
      groundSpeed: 5,
      battery: { pct: 80, voltage: 16.1, current: 12 },
      gps: { fix: 3, satellites: 14, hdop: 0.8 },
      mode: 'MISSION',
      armed: true,
      inAir: true,
      motors: [0.5, 0.6, 0.55, 0.52],
      wind: { speed: 3, dir: -90 },
      evil: '<script>',
    })!;
    expect(t.heading).toBe(10);
    expect(t.wind).toEqual({ speed: 3, dir: 270 });
    expect(t.motors).toHaveLength(4);
    expect((t as any).evil).toBeUndefined();
  });

  it('rejects missing position', () => {
    expect(sanitizeTelemetry({ lat: 100, lon: 0, altMsl: 0 })).toBeNull();
    expect(sanitizeTelemetry({ lat: 1, lon: 0 })).toBeNull();
    expect(sanitizeTelemetry(null)).toBeNull();
  });
});

describe('roles', () => {
  it('enforces the permission matrix', () => {
    expect(can('owner', 'org.delete')).toBe(true);
    expect(can('admin', 'org.delete')).toBe(false);
    expect(can('pilot', 'drone.control')).toBe(true);
    expect(can('manager', 'drone.control')).toBe(false);
    expect(can('manager', 'authorization.decide')).toBe(true);
    expect(can('viewer', 'live.view')).toBe(true);
    expect(can('viewer', 'mission.edit')).toBe(false);
    expect(can(null, 'live.view')).toBe(false);
    expect(permissionsOf('viewer')).toEqual(['analytics.view', 'live.view']);
  });
});
