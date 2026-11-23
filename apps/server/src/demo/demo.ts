/**
 * Demo mode: seeds an organisation with users, fleets, drones, missions, airspace
 * data, schedules, authorisations and 30 days of simulated flight history, then
 * connects in-process virtual drones over the real Athena Link WebSocket.
 *
 *   Login: demo@athena-sky.local / athena-demo
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  destinationPoint,
  generateSurvey,
  missionPath,
  newItemId,
  type LatLon,
  type MissionPlan,
  type Telemetry,
} from '@athena-sky/shared';
import { GroundImagery, LinkClient, VirtualDrone, simulateMission } from '@athena-sky/simulator';
import type { AppContext } from '../context';
import { hashPassword, randomToken, sha256Hex } from '../lib/crypto';
import { nowIso, uuid } from '../lib/util';
import { createOrganisation } from '../orgs/org-service';
import { insertLogSteps } from '../flights/flight-service';
import { runAtOnce } from '../lib/slice';
import { computeTotals } from '../flights/ingest';
import { finalizeFlight } from '../flights/finalize';
import { airframeById, type FlightSampleDto } from '@athena-sky/shared';

export const DEMO_EMAIL = 'demo@athena-sky.local';
export const DEMO_PASSWORD = 'athena-demo';
/** Dajia Riverside Park, Taipei – open riverside area used as the demo base. */
export const DEMO_HOME: LatLon = { lat: 25.0732, lon: 121.5355 };
const GROUND_ALT = 8;

interface DemoDrone {
  id: string;
  name: string;
  key: string;
  home: LatLon;
  imbalance: number;
  adsb: boolean;
  payload: boolean;
  /** Airframe model id (flight physics and 3D model). */
  airframe: string;
}

function toSample(t: Telemetry): FlightSampleDto {
  return {
    t: t.t,
    lat: t.lat,
    lon: t.lon,
    altMsl: t.altMsl,
    altRel: t.altRel,
    groundSpeed: t.groundSpeed,
    climbRate: t.climbRate,
    heading: t.heading,
    roll: t.roll,
    pitch: t.pitch,
    yaw: t.yaw,
    batteryPct: t.battery.pct,
    voltage: t.battery.voltage,
    current: t.battery.current,
    satellites: t.gps.satellites,
    hdop: t.gps.hdop,
    mode: String(t.mode),
    armed: t.armed,
    vibration: t.vibration ?? null,
    motors: t.motors ?? null,
  };
}

function towerInspection(center: LatLon): MissionPlan {
  const items: MissionPlan['items'] = [{ id: newItemId(), type: 'takeoff', alt: 30 }, { id: newItemId(), type: 'speed', speed: 5 }];
  for (let i = 0; i < 8; i++) {
    const p = destinationPoint(center, i * 45, 35);
    items.push({ id: newItemId(), type: 'waypoint', lat: p.lat, lon: p.lon, alt: 30 + (i % 2) * 15, holdS: 3 });
    items.push({ id: newItemId(), type: 'photo' });
  }
  items.push({ id: newItemId(), type: 'rtl' });
  return {
    home: { ...DEMO_HOME, alt: GROUND_ALT },
    items,
    rallyPoints: [{ ...destinationPoint(center, 150, 180), alt: 30 }],
    geofence: { polygon: [0, 90, 180, 270].map((b) => destinationPoint(center, b + 45, 700)), maxAlt: 100, action: 'rtl' },
    defaultSpeed: 6,
    defaultAlt: 30,
  };
}

function fieldSurvey(): MissionPlan {
  const corner = destinationPoint(DEMO_HOME, 40, 250);
  const poly = [corner, destinationPoint(corner, 60, 300), destinationPoint(destinationPoint(corner, 60, 300), 150, 180), destinationPoint(corner, 150, 180)];
  const lanes = generateSurvey(poly, { spacingM: 40, angleDeg: 60, alt: 60 });
  return {
    home: { ...DEMO_HOME, alt: GROUND_ALT },
    items: [{ id: newItemId(), type: 'takeoff', alt: 60 }, { id: newItemId(), type: 'speed', speed: 9 }, ...lanes, { id: newItemId(), type: 'rtl' }],
    rallyPoints: [],
    geofence: null,
    defaultSpeed: 9,
    defaultAlt: 60,
  };
}

function pipelineCorridor(): MissionPlan {
  const items: MissionPlan['items'] = [{ id: newItemId(), type: 'takeoff', alt: 45 }];
  let p: LatLon = DEMO_HOME;
  for (let i = 0; i < 6; i++) {
    p = destinationPoint(p, 205 + (i % 2) * 20, 220);
    items.push({ id: newItemId(), type: 'waypoint', lat: p.lat, lon: p.lon, alt: 45 });
  }
  items.push({ id: newItemId(), type: 'rtl' });
  return {
    home: { ...DEMO_HOME, alt: GROUND_ALT },
    items,
    rallyPoints: [{ ...destinationPoint(DEMO_HOME, 215, 700), alt: 30 }],
    geofence: null,
    defaultSpeed: 10,
    defaultAlt: 45,
  };
}

export async function seedDemo(ctx: Pick<AppContext, 'db' | 'config' | 'webhooks' | 'logbook' | 'log' | 'storage' | 'airspace' | 'terrain'>): Promise<DemoDrone[]> {
  const { db, config } = ctx;
  const keysFile = join(config.dataDir, 'demo-keys.json');
  const existing = db.get<{ id: string }>('SELECT id FROM users WHERE email = ?', DEMO_EMAIL);
  if (existing) {
    const org = db.get<{ org_id: string }>("SELECT org_id FROM memberships WHERE user_id = ? AND role = 'owner'", existing.id);
    let saved: DemoDrone[] = existsSync(keysFile) ? (JSON.parse(readFileSync(keysFile, 'utf8')) as DemoDrone[]) : [];
    saved = saved.filter((d) => db.get('SELECT 1 FROM drones WHERE id = ? AND link_key_hash = ?', d.id, sha256Hex(d.key)));
    if (saved.length === 0 && org) {
      // Keys lost: rotate them so the in-process simulators can reconnect.
      saved = db.all<{ id: string; name: string; airframe_id: string | null }>('SELECT id, name, airframe_id FROM drones WHERE org_id = ? ORDER BY name', org.org_id).map((d, i) => {
        const key = randomToken('adk_', 32);
        db.run('UPDATE drones SET link_key_hash = ?, link_key_prefix = ? WHERE id = ?', sha256Hex(key), key.slice(0, 10), d.id);
        return { id: d.id, name: d.name, key, home: destinationPoint(DEMO_HOME, 90, i * 40), imbalance: 0, adsb: i === 0, payload: i === 1, airframe: d.airframe_id ?? '' };
      });
      writeFileSync(keysFile, JSON.stringify(saved, null, 2), { mode: 0o600 });
    }
    // The airframe is read from the database (key files of earlier versions do not have it).
    return saved.map((d) => ({ ...d, airframe: db.get<{ airframe_id: string | null }>('SELECT airframe_id FROM drones WHERE id = ?', d.id)?.airframe_id ?? '' }));
  }

  ctx.log.info('seeding demo data…');
  const pw = await hashPassword(DEMO_PASSWORD);
  const users = [
    { email: DEMO_EMAIL, name: 'Demo Pilot', role: 'owner' },
    { email: 'maya@athena-sky.local', name: 'Maya Lin (Mission Manager)', role: 'manager' },
    { email: 'pia@athena-sky.local', name: 'Pia Chen (Pilot)', role: 'pilot' },
    { email: 'owen@athena-sky.local', name: 'Owen Wu (Observer)', role: 'viewer' },
  ].map((u) => ({ ...u, id: uuid() }));
  for (const u of users) db.run('INSERT INTO users (id, email, name, password_hash, created_at) VALUES (?, ?, ?, ?, ?)', u.id, u.email, u.name, pw, nowIso());
  const orgId = createOrganisation(db, 'Athena Demo Operations', users[0]!.id);
  for (const u of users.slice(1)) db.run('INSERT INTO memberships (org_id, user_id, role, pilot_license, created_at) VALUES (?, ?, ?, ?, ?)', orgId, u.id, u.role, u.role === 'pilot' ? 'CAA-TW-A1-0421' : null, nowIso());
  db.run('UPDATE memberships SET pilot_license = ? WHERE user_id = ?', 'CAA-TW-A2-0007', users[0]!.id);

  const fleets = [
    { id: uuid(), name: 'Inspection', description: 'Cell tower & infrastructure inspection' },
    { id: uuid(), name: 'Survey', description: 'Mapping and agricultural survey' },
  ];
  for (const f of fleets) db.run('INSERT INTO fleets (id, org_id, name, description, created_at) VALUES (?, ?, ?, ?, ?)', f.id, orgId, f.name, f.description, nowIso());

  const specs = [
    { name: 'Falcon-1', model: 'TaiXiChuang Quad', airframe: 'taixichuang-quad', fleet: 0, imbalance: 0, adsb: true, payload: false },
    { name: 'Falcon-2', model: 'Specter 10X', airframe: 'specter-10x', fleet: 1, imbalance: 0, adsb: false, payload: true },
    { name: 'Heron-3', model: 'Hamburger X8', airframe: 'hamburger-x8', fleet: 1, imbalance: 0.05, adsb: false, payload: false },
    { name: 'Kestrel-4', model: 'Athena VTOL Mapper', airframe: 'athena-vtol', fleet: 0, imbalance: 0, adsb: false, payload: false },
    { name: 'Osprey-5', model: 'H380', airframe: 'h380', fleet: 1, imbalance: 0, adsb: false, payload: false },
  ].slice(0, Math.max(1, Math.min(5, config.demoDrones)));
  const drones: DemoDrone[] = specs.map((s, i) => {
    const id = uuid();
    const key = randomToken('adk_', 32);
    const home = destinationPoint(DEMO_HOME, 90, i * 40);
    db.run(
      `INSERT INTO drones (id, org_id, fleet_id, name, model, serial, notes, link_key_hash, link_key_prefix, firmware_version, created_at, last_lat, last_lon, last_alt, airframe_id)
       VALUES (?, ?, ?, ?, ?, ?, '', ?, ?, ?, ?, ?, ?, ?, ?)`,
      id,
      orgId,
      fleets[s.fleet]!.id,
      s.name,
      s.model,
      `ATH-${2024100 + i}`,
      sha256Hex(key),
      key.slice(0, 10),
      i === 2 ? 'athena-fc 2.3.1' : 'athena-fc 2.4.0',
      nowIso(),
      home.lat,
      home.lon,
      GROUND_ALT,
      s.airframe,
    );
    return { id, name: s.name, key, home, imbalance: s.imbalance, adsb: s.adsb, payload: s.payload, airframe: s.airframe };
  });
  writeFileSync(keysFile, JSON.stringify(drones, null, 2), { mode: 0o600 });

  const tower = destinationPoint(DEMO_HOME, 330, 400);
  const missions = [
    { name: 'Cell tower inspection – Riverside T12', plan: towerInspection(tower) },
    { name: 'Field survey – North parcel', plan: fieldSurvey() },
    { name: 'Pipeline corridor patrol', plan: pipelineCorridor() },
  ].map((m) => ({ ...m, id: uuid() }));
  for (const m of missions) {
    db.run('INSERT INTO missions (id, org_id, name, description, plan, created_by, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)', m.id, orgId, m.name, 'Demo mission', JSON.stringify(m.plan), users[1]!.id, nowIso(), nowIso());
  }

  // Airspace data (demo only – not real aeronautical information).
  const zones = [
    {
      name: 'Demo CTR – city airport',
      type: 'controlled',
      geometry: {
        kind: 'polygon',
        polygon: [destinationPoint(DEMO_HOME, 20, 2500), destinationPoint(DEMO_HOME, 60, 4200), destinationPoint(DEMO_HOME, 100, 3000), destinationPoint(DEMO_HOME, 50, 1400)],
      },
      floor: 0,
      ceiling: 600,
    },
    { name: 'Demo hospital helipad', type: 'restricted', geometry: { kind: 'circle', center: destinationPoint(DEMO_HOME, 180, 1200), radiusM: 300 }, floor: 0, ceiling: 300 },
    { name: 'Demo 161 kV power line', type: 'hazard_powerline', geometry: { kind: 'line', line: [destinationPoint(DEMO_HOME, 300, 900), destinationPoint(DEMO_HOME, 250, 500), destinationPoint(DEMO_HOME, 200, 900)], bufferM: 30 }, floor: 0, ceiling: 60 },
    { name: 'Demo stadium event (TFR)', type: 'temporary', geometry: { kind: 'circle', center: destinationPoint(DEMO_HOME, 110, 2000), radiusM: 500 }, floor: 0, ceiling: 1000 },
  ];
  for (const z of zones) {
    db.run(
      `INSERT INTO airspace_zones (id, org_id, name, type, geometry, floor_m, ceiling_m, active_from, active_to, source, notes, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'demo', 'Demonstration data – not for navigation', ?)`,
      uuid(),
      orgId,
      z.name,
      z.type,
      JSON.stringify(z.geometry),
      z.floor,
      z.ceiling,
      z.type === 'temporary' ? new Date(Date.now() + 2 * 86_400_000).toISOString() : null,
      z.type === 'temporary' ? new Date(Date.now() + 2 * 86_400_000 + 6 * 3_600_000).toISOString() : null,
      nowIso(),
    );
  }
  ctx.airspace.invalidate(orgId);

  // 30 days of history.
  const pilots = [users[0]!, users[2]!];
  const day = 86_400_000;
  let flightNo = 0;
  for (let d = 29; d >= 1; d -= 1) {
    const perDay = d % 3 === 0 ? 2 : 1;
    for (let k = 0; k < perDay; k++) {
      const di = (flightNo + k) % drones.length;
      const drone = drones[di]!;
      const mission = missions[(flightNo + d) % missions.length]!;
      const start = new Date(Date.now() - d * day);
      start.setUTCHours(1 + ((flightNo * 3) % 8), (flightNo * 17) % 60, 0, 0);
      // Heron-3's motor slowly degrades: the analytics should flag it in recent flights.
      const imbalance = di === 2 ? 0.02 + Math.max(0, 22 - d) * 0.012 : drone.imbalance;
      const sim = simulateMission(mission.plan, {
        home: DEMO_HOME,
        startTime: start.getTime(),
        drone: { groundAltMsl: GROUND_ALT, motorImbalance: imbalance, seed: flightNo + 1, windSpeed: 2 + (flightNo % 5), airframe: airframeById(drone.airframe) ?? null },
        ulog: flightNo % 4 === 0,
      });
      const samples = sim.telemetry.map(toSample);
      if (samples.length < 5) continue;
      const totals = computeTotals(samples);
      const flightId = uuid();
      const pilot = pilots[flightNo % pilots.length]!;
      db.tx(() => {
        db.run(
          `INSERT INTO flights (id, org_id, drone_id, pilot_id, mission_id, source, status, started_at, ended_at, duration_s, distance_m, max_alt_m,
                                max_speed_ms, battery_start, battery_end, start_lat, start_lon, end_lat, end_lon, takeoff_alt_msl, created_at)
           VALUES (?, ?, ?, ?, ?, 'live', 'completed', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          flightId,
          orgId,
          drone.id,
          pilot.id,
          mission.id,
          new Date(sim.startedAt).toISOString(),
          new Date(sim.endedAt).toISOString(),
          totals.durationS,
          totals.distanceM,
          totals.maxAltM,
          totals.maxSpeedMs,
          totals.batteryStart,
          totals.batteryEnd,
          samples[0]!.lat,
          samples[0]!.lon,
          samples[samples.length - 1]!.lat,
          samples[samples.length - 1]!.lon,
          GROUND_ALT,
          nowIso(),
        );
        runAtOnce(insertLogSteps(db, flightId, samples, []));
        for (const e of sim.events) db.run('INSERT INTO flight_events (flight_id, t, level, code, message) VALUES (?, ?, ?, ?, ?)', flightId, e.t, e.level, e.code ?? null, e.message);
        for (const p of sim.photos) {
          db.run('INSERT INTO payload_records (id, flight_id, t, kind, data) VALUES (?, ?, ?, ?, ?)', uuid(), flightId, p.t, 'photo', JSON.stringify({ seq: p.seq, lat: p.lat, lon: p.lon, altMsl: p.altMsl }));
        }
      });
      if (sim.ulog) {
        const stored = await ctx.storage.saveBuffer('logs', sim.ulog);
        db.run(
          "INSERT INTO flight_files (id, flight_id, org_id, kind, filename, size, sha256, storage_path, created_at) VALUES (?, ?, ?, 'ulog', ?, ?, ?, ?, ?)",
          uuid(),
          flightId,
          orgId,
          `log_${new Date(sim.startedAt).toISOString().slice(0, 10)}_${drone.name}.ulg`,
          stored.size,
          stored.sha256,
          stored.storagePath,
          nowIso(),
        );
      }
      await finalizeFlight(ctx, flightId);
    }
    flightNo += perDay;
  }

  // Upcoming operations, a public reservation and a pending request. The terrain the scheduled
  // missions meet is worked out as when an operation is scheduled in the application (fleet
  // overview), in the background.
  if (ctx.terrain.enabled) {
    for (const m of missions.slice(0, Math.min(drones.length, missions.length))) {
      void ctx.terrain
        .profile(missionPath(m.plan), m.plan.home?.alt ?? null)
        .then((s) => db.run('UPDATE missions SET terrain = ? WHERE id = ?', JSON.stringify(s), m.id))
        .catch(() => undefined);
    }
  }
  for (let i = 0; i < drones.length; i++) {
    const planned = new Date(Date.now() + (i + 1) * day);
    planned.setUTCHours(1 + i, 30, 0, 0);
    db.run(
      "INSERT INTO schedules (id, org_id, mission_id, drone_id, pilot_id, planned_at, status, created_at) VALUES (?, ?, ?, ?, ?, ?, 'scheduled', ?)",
      uuid(),
      orgId,
      missions[i % missions.length]!.id,
      drones[i]!.id,
      pilots[i % pilots.length]!.id,
      planned.toISOString(),
      nowIso(),
    );
  }
  const tomorrow = new Date(Date.now() + day);
  tomorrow.setUTCHours(1, 0, 0, 0);
  db.run(
    `INSERT INTO authorizations (id, org_id, reference, geometry, max_alt_m, start_at, end_at, status, drone_id, mission_id, requested_by, conflicts, decision_reason, decided_at, is_public, created_at, approved_at)
     VALUES (?, ?, 'ATH-DEMO0001', ?, 120, ?, ?, 'approved', ?, ?, ?, '[]', 'Automatically approved – no conflicts', ?, 1, ?, ?)`,
    uuid(),
    orgId,
    JSON.stringify({ kind: 'cylinder', center: tower, radiusM: 200 }),
    tomorrow.toISOString(),
    new Date(tomorrow.getTime() + 2 * 3_600_000).toISOString(),
    drones[0]!.id,
    missions[0]!.id,
    users[0]!.id,
    nowIso(),
    nowIso(),
    nowIso(),
  );
  // Maintenance plans: the default schedule plus demo tasks that are due soon / overdue, and a log.
  const DAY_MS = 86_400_000;
  const usageAt = (droneId: string, at: string) => {
    const u = db.get<{ h: number; n: number }>('SELECT COALESCE(SUM(duration_s), 0) / 3600.0 AS h, COUNT(*) AS n FROM flights WHERE drone_id = ? AND started_at < ?', droneId, at)!;
    return { hours: Math.round(u.h * 100) / 100, flights: u.n };
  };
  const manager = users[1]!;
  const pilot = users[2]!;
  drones.forEach((d, i) => {
    const plan: { name: string; hours?: number; flights?: number; days?: number; ago: number; notes: string; assignee?: string }[] = [
      { name: 'Pre-season inspection', days: 180, ago: 170 - i * 20, notes: 'Airframe, arms, landing gear, connectors, firmware and calibration.' },
      { name: 'Propeller replacement', hours: 50, ago: 45, notes: 'Replace all propellers; check for nicks and balance.' },
      { name: 'Motor inspection', hours: 100, ago: 45, notes: 'Bearings, windings, mounting screws; spin-test for noise.' },
      { name: 'Battery health check', flights: 50, ago: 45, notes: 'Cell balance, internal resistance and swelling of every pack.' },
    ];
    if (d.payload) plan.push({ name: 'Gimbal & camera calibration', days: 30, ago: 28, notes: 'IMU and horizon calibration of the gimbal; lens cleaning.', assignee: pilot.id });
    if (d.imbalance > 0) plan.push({ name: 'Motor 1 & ESC check', flights: 10, ago: 45, notes: 'Post-flight analysis reports motor imbalance – inspect motor 1, its propeller and the ESC.', assignee: pilot.id });
    for (const t of plan) {
      const at = new Date(Date.now() - t.ago * DAY_MS).toISOString();
      const u = usageAt(d.id, at);
      const taskId = uuid();
      db.run(
        `INSERT INTO maintenance_tasks (id, org_id, drone_id, name, interval_hours, interval_flights, interval_days, notes, assignee_id,
           last_done_at, last_done_hours, last_done_flights, base_at, base_hours, base_flights, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        taskId, orgId, d.id, t.name, t.hours ?? null, t.flights ?? null, t.days ?? null, t.notes, t.assignee ?? null,
        at, u.hours, u.flights, at, u.hours, u.flights, at, at,
      );
      db.run(
        'INSERT INTO maintenance_records (id, org_id, drone_id, task_id, title, done_at, done_by, hours, flights, notes, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
        uuid(), orgId, d.id, taskId, t.name, at, manager.id, u.hours, u.flights, 'Done at commissioning.', at,
      );
    }
  });
  if (drones[0]) {
    const at = new Date(Date.now() - 9 * DAY_MS).toISOString();
    const u = usageAt(drones[0].id, at);
    db.run(
      'INSERT INTO maintenance_records (id, org_id, drone_id, task_id, title, done_at, done_by, hours, flights, notes, created_at) VALUES (?, ?, ?, NULL, ?, ?, ?, ?, ?, ?, ?)',
      uuid(), orgId, drones[0].id, 'Replaced propeller set after a hard landing', at, users[0]!.id, u.hours, u.flights, 'One blade chipped; all four replaced and balanced.', at,
    );
  }
  ctx.log.info({ flights: flightNo }, 'demo data seeded');
  return drones;
}

export async function startDemo(ctx: AppContext, linkUrl: string): Promise<() => Promise<void>> {
  const drones = await seedDemo(ctx);
  // The virtual cameras show the real place from this server's imagery tile cache (one cache for
  // the fleet) – and, like drones with an AI computer, detect people and vehicles on board (the
  // built-in cloud detector was trained on the simulator's procedural landscape). Without
  // imagery: that landscape, analysed in the cloud.
  const imagery = ctx.imagery.enabled ? new GroundImagery((z, x, y) => ctx.imagery.tile(z, x, y)) : null;
  const clients = drones.map((d, i) => {
    const drone = new VirtualDrone({
      home: d.home,
      groundAltMsl: GROUND_ALT,
      airframe: airframeById(d.airframe) ?? null,
      motorImbalance: d.imbalance,
      serial: `ATH-${2024100 + i}`,
      model: i === 2 ? 'Hamburger X8' : i === 1 ? 'Specter 10X' : 'TaiXiChuang Quad',
      firmware: i === 2 ? 'athena-fc 2.3.1' : 'athena-fc 2.4.0',
      seed: 1000 + i,
    });
    const client = new LinkClient({
      url: linkUrl,
      key: d.key,
      drone,
      video: true,
      imagery,
      onboardAi: !!imagery,
      adsb: d.adsb,
      payload: d.payload,
      log: (m) => ctx.log.debug(`[sim ${d.name}] ${m}`),
    });
    client.start();
    return client;
  });
  ctx.log.info(`demo: ${clients.length} virtual drones connected – log in as ${DEMO_EMAIL} / ${DEMO_PASSWORD}`);
  return async () => {
    await Promise.all(clients.map((c) => c.stop()));
  };
}
