import { describe, expect, it } from 'vitest';
import { ULogWriter, simulateMission } from '@athena-sky/simulator';
import { destinationPoint, newItemId } from '@athena-sky/shared';
import { isULog, parseULog, topic } from '../src/flights/ulog';
import { normalizeCsv, normalizeLog } from '../src/flights/ingest';
import { toCsv } from '../src/flights/export';

describe('ULog parser', () => {
  it('parses header, info, parameters, nested types, arrays, padding and messages', () => {
    const w = new ULogWriter(123456);
    w.info('sys_name', 'PX4').info('ver_sw', 'v1.15.0').info('time_ref_utc', -3600, 'int32_t');
    w.param('MPC_XY_CRUISE', 7.5).param('SYS_AUTOSTART', 4001, 'int32_t');
    w.format('esc_report:uint32_t esc_rpm;float esc_voltage');
    w.format('esc_status:uint64_t timestamp;uint8_t esc_count;uint8_t[3] _padding0;esc_report[2] esc');
    w.format('battery_status:uint64_t timestamp;float voltage_v;float current_a;float remaining;uint8_t[4] _padding0');
    w.data('esc_status', { timestamp: 1_000_000, esc_count: 2, esc: [{ esc_rpm: 5000, esc_voltage: 24.1 }, { esc_rpm: 5100, esc_voltage: 24.0 }] });
    w.data('battery_status', { timestamp: 1_000_000, voltage_v: 24.5, current_a: 12.25, remaining: 0.875 });
    w.data('battery_status', { timestamp: 2_000_000, voltage_v: 24.25, current_a: 13.5, remaining: 0.86 });
    w.data('battery_status', { timestamp: 1_500_000, voltage_v: 1, current_a: 1, remaining: 1 }, 1);
    w.log(4, 1_200_000, 'Low battery warning').log(6, 1_300_000, 'Takeoff detected');
    w.dropout(120);
    const buf = w.toBuffer();
    expect(isULog(buf)).toBe(true);

    const all = parseULog(buf, { include: () => true });
    expect(all.version).toBe(1);
    expect(all.headerTimestamp).toBe(123456);
    expect(all.info).toMatchObject({ sys_name: 'PX4', ver_sw: 'v1.15.0', time_ref_utc: -3600 });
    expect(all.params.MPC_XY_CRUISE).toBeCloseTo(7.5);
    expect(all.params.SYS_AUTOSTART).toBe(4001);
    const esc = topic(all, 'esc_status')!;
    expect(esc.fields).toEqual(['timestamp', 'esc_count', 'esc[0].esc_rpm', 'esc[0].esc_voltage', 'esc[1].esc_rpm', 'esc[1].esc_voltage']);
    expect(esc.data['esc[1].esc_rpm']).toEqual([5100]);
    expect(esc.data['esc[0].esc_voltage']![0]).toBeCloseTo(24.1, 4);
    const bat = topic(all, 'battery_status')!;
    expect(bat.multiId).toBe(0);
    expect(bat.timestamps).toEqual([1_000_000, 2_000_000]);
    expect(bat.data.current_a).toEqual([12.25, 13.5]);
    expect(all.topics.filter((t) => t.name === 'battery_status')).toHaveLength(2);
    expect(all.messages).toEqual([
      { t: 1_200_000, level: 4, text: 'Low battery warning' },
      { t: 1_300_000, level: 6, text: 'Takeoff detected' },
    ]);
    expect(all.dropouts).toEqual([{ t: 1_500_000, durationMs: 120 }]);
  });

  it('only materialises included topics but still counts samples', () => {
    const w = new ULogWriter();
    w.format('a:uint64_t timestamp;float x').format('b:uint64_t timestamp;double y');
    for (let i = 0; i < 10; i++) w.data('a', { timestamp: i, x: i }).data('b', { timestamp: i, y: i * 2 });
    const f = parseULog(w.toBuffer(), { include: (n) => n === 'b' });
    expect(topic(f, 'a')!.samples).toBe(10);
    expect(topic(f, 'a')!.data).toEqual({});
    expect(topic(f, 'b')!.data.y).toEqual([0, 2, 4, 6, 8, 10, 12, 14, 16, 18]);
    const dec = parseULog(w.toBuffer(), { include: () => true, maxSamplesPerTopic: 5 });
    expect(topic(dec, 'b')!.timestamps).toHaveLength(5);
  });

  it('tolerates truncated files and rejects bad magic', () => {
    const w = new ULogWriter();
    w.format('a:uint64_t timestamp;float x');
    for (let i = 0; i < 5; i++) w.data('a', { timestamp: i, x: i });
    const buf = w.toBuffer();
    const cut = parseULog(buf.subarray(0, buf.length - 5), { include: () => true });
    expect(topic(cut, 'a')!.data.x).toHaveLength(4);
    expect(() => parseULog(Buffer.from('not a ulog file at all'))).toThrow(/magic/);
  });
});

describe('log normalisation', () => {
  const home = { lat: 25.0732, lon: 121.5355 };
  const plan = {
    home: { ...home, alt: 8 },
    items: [
      { id: newItemId(), type: 'takeoff' as const, alt: 20 },
      { id: newItemId(), type: 'waypoint' as const, ...destinationPoint(home, 45, 120), alt: 25 },
      { id: newItemId(), type: 'rtl' as const },
    ],
    rallyPoints: [],
    geofence: null,
    defaultSpeed: 8,
    defaultAlt: 20,
  };

  it('converts a simulator ULog into absolute-time samples with attitude, battery and motors', () => {
    const start = Date.UTC(2026, 3, 1, 8, 0, 0);
    const sim = simulateMission(plan, { home, startTime: start, ulog: true, drone: { groundAltMsl: 8, seed: 3 } });
    expect(sim.ulog).toBeTruthy();
    const log = normalizeLog(sim.ulog!, 'flight.ulg');
    expect(log.kind).toBe('ulog');
    // GNSS UTC time is used for absolute timestamps
    expect(Math.abs(log.startedAt - sim.startedAt)).toBeLessThan(1500);
    expect(log.samples.length).toBeGreaterThan(20);
    const top = log.samples.reduce((m, s) => (s.altRel > m.altRel ? s : m));
    expect(top.altRel).toBeGreaterThan(22);
    expect(top.altRel).toBeLessThan(32);
    expect(top.batteryPct).toBeGreaterThan(50);
    expect(top.voltage).toBeGreaterThan(20);
    expect(top.motors).toHaveLength(4);
    expect(top.satellites).toBeGreaterThan(5);
    expect(log.samples.some((s) => s.mode === 'MISSION')).toBe(true);
    expect(log.samples.some((s) => s.mode === 'RTL')).toBe(true);
    expect(log.events.some((e) => /Mission started/.test(e.message))).toBe(true);
    expect(log.vehicle.firmware).toBe('athena-fc 2.4.0');
  });

  it('reads generic CSV logs and round-trips Athena CSV exports', () => {
    const csv = 'Time,Latitude,Longitude,Altitude,Height,Speed,Battery\n2026-01-01T10:00:00Z,25.07,121.53,30,0,0,99\n2026-01-01T10:00:01Z,25.0701,121.53,40,10,5,98\n';
    const log = normalizeCsv(csv, 0);
    expect(log.samples).toHaveLength(2);
    expect(log.samples[1]).toMatchObject({ lat: 25.0701, altMsl: 40, altRel: 10, groundSpeed: 5, batteryPct: 98 });
    expect(log.startedAt).toBe(Date.parse('2026-01-01T10:00:00Z'));
    const again = normalizeCsv(toCsv(log.samples), 0);
    expect(again.samples).toHaveLength(2);
    expect(again.samples[1]).toMatchObject({ lat: 25.0701, altRel: 10, batteryPct: 98 });
    expect(() => normalizeCsv('a,b\n1,2', 0)).toThrow(/latitude/);
  });
});
