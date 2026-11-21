/**
 * Pre-deployment mission simulation: flies a mission plan with an airframe model under
 * the given payload, wind, temperature and terrain, and predicts duration, energy,
 * battery state, power and terrain clearance along the route, flagging infeasible plans
 * before a drone leaves the ground. Also used for airframe benchmarking.
 */
import {
  airDensity,
  batteryEnergyWh,
  densityAltitude,
  enduranceEstimate,
  legKinematics,
  rotorPower,
  windAtHeight,
  windVector,
  wingBorne,
  wingPower,
  type Airframe,
  type EnduranceEstimate,
  type GroundLookup,
} from './airframes';
import { haversineDistance, initialBearing, interpolateLatLon, type LatLon, type LatLonAlt } from './geo';
import { loiterSeconds, type MissionPlan } from './mission';
import { decimate } from './stats';

export type SimPhase = 'takeoff' | 'transition' | 'cruise' | 'hold' | 'landing';

export interface SimulationOptions {
  airframe: Airframe;
  payloadKg?: number;
  /** Wind 10 m above ground, blowing from `fromDeg`. */
  wind?: { speedMs: number; fromDeg: number; gustMs?: number | null } | null;
  /** Ground air temperature (°C); ISA when omitted. */
  temperatureC?: number | null;
  /** Ground elevation at home (m AMSL). */
  homeElevationM?: number;
  /** Terrain elevation lookup (m AMSL) for clearance checks. */
  groundAt?: GroundLookup;
  /** Battery state that must remain at landing (%). Default 20. */
  reservePct?: number;
  startSocPct?: number;
  sampleIntervalS?: number;
  maxSamples?: number;
}

export interface SimulationSample {
  t: number;
  lat: number;
  lon: number;
  altRel: number;
  agl: number | null;
  groundSpeed: number;
  airspeed: number;
  climb: number;
  powerW: number;
  socPct: number;
  phase: SimPhase;
}

export interface SimulationLeg {
  index: number;
  phase: SimPhase;
  from: LatLonAlt;
  to: LatLonAlt;
  distanceM: number;
  timeS: number;
  energyWh: number;
  groundSpeedMs: number;
  airspeedMs: number;
  tailwindMs: number;
  climbMs: number;
  powerW: number;
}

export interface SimulationIssue {
  severity: 'error' | 'warning' | 'info';
  code: string;
  message: string;
  t?: number;
}

export interface SimulationResult {
  airframeId: string;
  airframeName: string;
  massKg: number;
  payloadKg: number;
  airDensity: number;
  densityAltitudeM: number;
  durationS: number;
  distanceM: number;
  energyWh: number;
  batteryWh: number;
  usableWh: number;
  endSocPct: number;
  minSocPct: number;
  maxPowerW: number;
  avgPowerW: number;
  minAglM: number | null;
  maxWindMs: number;
  feasible: boolean;
  legs: SimulationLeg[];
  issues: SimulationIssue[];
  samples: SimulationSample[];
  endurance: EnduranceEstimate;
}

const r1 = (v: number) => Math.round(v * 10) / 10;

export function simulateFlight(plan: MissionPlan, opts: SimulationOptions): SimulationResult {
  const af = opts.airframe;
  const payload = Math.max(0, opts.payloadKg ?? 0);
  const mass = af.emptyMassKg + payload;
  const homeElev = opts.homeElevationM ?? plan.home?.alt ?? 0;
  const dt = opts.sampleIntervalS ?? 1;
  const reserve = opts.reservePct ?? 20;
  const batteryWh = batteryEnergyWh(af.battery);
  const usableWh = batteryWh * af.battery.usableFraction;
  const emptySoc = 100 * (1 - af.battery.usableFraction);
  const startSoc = opts.startSocPct ?? 100;
  const wind10 = opts.wind && opts.wind.speedMs > 0 ? opts.wind : null;
  const issues: SimulationIssue[] = [];
  const legs: SimulationLeg[] = [];
  const samples: SimulationSample[] = [];

  const rhoAt = (altRel: number) => airDensity(homeElev + altRel, opts.temperatureC !== undefined && opts.temperatureC !== null ? opts.temperatureC - 0.0065 * altRel : null);
  const groundRel = (p: LatLon): number | null => {
    const g = opts.groundAt?.(p);
    return g === null || g === undefined ? null : g - homeElev;
  };
  const windAt = (altRel: number) => {
    if (!wind10) return { e: 0, n: 0, speed: 0 };
    const speed = windAtHeight(wind10.speedMs, altRel);
    return { ...windVector(speed, wind10.fromDeg), speed };
  };

  // Static feasibility checks.
  if (payload > af.maxPayloadKg) issues.push({ severity: 'error', code: 'payload_over_limit', message: `Payload ${payload} kg exceeds the ${af.maxPayloadKg} kg limit of the ${af.name}.` });
  const first = plan.items.find((i) => i.lat !== undefined && i.lon !== undefined);
  const home: LatLonAlt | null = plan.home ? { lat: plan.home.lat, lon: plan.home.lon, alt: 0 } : first ? { lat: first.lat!, lon: first.lon!, alt: 0 } : null;
  const endurance = enduranceEstimate(af, payload, rhoAt(0));
  const base = {
    airframeId: af.id,
    airframeName: af.name,
    massKg: mass,
    payloadKg: payload,
    airDensity: Math.round(rhoAt(0) * 1000) / 1000,
    densityAltitudeM: Math.round(densityAltitude(rhoAt(0))),
    batteryWh: Math.round(batteryWh),
    usableWh: Math.round(usableWh),
    endurance,
  };
  if (!home) {
    issues.push({ severity: 'error', code: 'no_route', message: 'The mission has no positions to simulate.' });
    return { ...base, durationS: 0, distanceM: 0, energyWh: 0, endSocPct: startSoc, minSocPct: startSoc, maxPowerW: 0, avgPowerW: 0, minAglM: null, maxWindMs: 0, feasible: false, legs, issues, samples };
  }

  let t = 0;
  let energyWh = 0;
  let distance = 0;
  let maxPower = 0;
  let minAgl: number | null = null;
  let maxWind = 0;
  let depletedAt: number | null = null;
  let onWing = false;
  let cur: LatLonAlt = { ...home };
  let speed = plan.defaultSpeed;
  const soc = () => startSoc - (100 * energyWh) / batteryWh;

  const emit = (from: LatLonAlt, to: LatLonAlt, duration: number, power: number, kin: { vg: number; va: number }, phase: SimPhase, climb: number) => {
    const n = Math.max(1, Math.ceil(duration / dt));
    const e0 = energyWh;
    for (let k = 1; k <= n; k++) {
      const f = k / n;
      const p = interpolateLatLon(from, to, f);
      const altRel = from.alt + (to.alt - from.alt) * f;
      energyWh = e0 + (power * duration * f) / 3600;
      const g = groundRel(p);
      const agl = g === null ? null : altRel - g;
      if (agl !== null && phase !== 'takeoff' && phase !== 'landing') minAgl = minAgl === null ? agl : Math.min(minAgl, agl);
      const s = soc();
      if (depletedAt === null && s <= emptySoc) depletedAt = t + duration * f;
      samples.push({ t: Math.round((t + duration * f) * 10) / 10, lat: p.lat, lon: p.lon, altRel: r1(altRel), agl: agl === null ? null : r1(agl), groundSpeed: r1(kin.vg), airspeed: r1(kin.va), climb: r1(climb), powerW: Math.round(power), socPct: r1(s), phase });
    }
    t += duration;
  };

  const leg = (to: LatLonAlt, phase: SimPhase, legSpeed: number) => {
    const from = cur;
    const d = haversineDistance(from, to);
    const dz = to.alt - from.alt;
    const midAlt = Math.max(from.alt, to.alt);
    const w = windAt(midAlt);
    maxWind = Math.max(maxWind, w.speed);
    const rho = rhoAt((from.alt + to.alt) / 2);
    let vg = 0;
    let va = w.speed;
    let tail = 0;
    let tH = 0;
    const wing = onWing && d > 1;
    if (d > 1) {
      const track = initialBearing(from, to);
      const k = wing
        ? legKinematics(track, Math.max(af.cruiseSpeedMs, (af.wing?.stallSpeedMs ?? 0) * 1.2), w, 'air', af.maxSpeedMs)
        : legKinematics(track, Math.min(legSpeed, af.maxSpeedMs), w, 'ground', af.maxSpeedMs);
      if (!k.feasible) {
        issues.push({ severity: 'error', code: 'wind_exceeds_airspeed', message: `Leg ${legs.length + 1}: the wind (${w.speed.toFixed(1)} m/s) prevents holding the track at the available airspeed.`, t });
        vg = Math.max(1, legSpeed * 0.3);
      } else vg = k.groundSpeedMs;
      va = k.airspeedMs;
      tail = k.tailwindMs;
      tH = d / vg;
    }
    const rate = dz >= 0 ? af.maxClimbMs : af.maxDescentMs;
    const tV = Math.abs(dz) / rate;
    const time = Math.max(tH, tV, 0.1);
    const climb = dz / time;
    const pw = (wing ? wingPower(af, mass, va, climb, rho) : rotorPower(af, mass, va, climb, rho)).totalW;
    maxPower = Math.max(maxPower, pw);
    const e0 = energyWh;
    emit(from, to, time, pw, { vg: d > 1 ? vg : 0, va }, phase, climb);
    distance += Math.hypot(d, dz);
    legs.push({ index: legs.length, phase, from, to, distanceM: Math.round(d), timeS: r1(time), energyWh: r1(energyWh - e0), groundSpeedMs: r1(vg), airspeedMs: r1(va), tailwindMs: r1(tail), climbMs: r1(climb), powerW: Math.round(pw) });
    cur = to;
  };

  const hover = (seconds: number, phase: SimPhase) => {
    if (seconds <= 0) return;
    const w = windAt(cur.alt);
    const rho = rhoAt(cur.alt);
    // On the wing a loiter is flown as a circle (bank adds ~10 % power); in rotor mode the drone hovers into the wind.
    const pw = onWing ? wingPower(af, mass, af.cruiseSpeedMs, 0, rho).totalW * 1.1 : rotorPower(af, mass, w.speed, 0, rho).totalW;
    maxPower = Math.max(maxPower, pw);
    const e0 = energyWh;
    emit(cur, cur, seconds, pw, { vg: 0, va: onWing ? af.cruiseSpeedMs : w.speed }, phase, 0);
    legs.push({ index: legs.length, phase, from: cur, to: cur, distanceM: 0, timeS: r1(seconds), energyWh: r1(energyWh - e0), groundSpeedMs: 0, airspeedMs: r1(onWing ? af.cruiseSpeedMs : w.speed), tailwindMs: 0, climbMs: 0, powerW: Math.round(pw) });
  };

  const transition = (toWing: boolean) => {
    if (af.kind !== 'vtol' || onWing === toWing) return;
    const rho = rhoAt(cur.alt);
    // Transitions are flown on the lift rotors while accelerating / decelerating (≈ 1.2 × hover power).
    const pw = rotorPower(af, mass, af.cruiseSpeedMs / 2, 0, rho).totalW * 1.2;
    maxPower = Math.max(maxPower, pw);
    const e0 = energyWh;
    emit(cur, cur, af.transitionS ?? 10, pw, { vg: af.cruiseSpeedMs / 2, va: af.cruiseSpeedMs / 2 }, 'transition', 0);
    legs.push({ index: legs.length, phase: 'transition', from: cur, to: cur, distanceM: 0, timeS: af.transitionS ?? 10, energyWh: r1(energyWh - e0), groundSpeedMs: r1(af.cruiseSpeedMs / 2), airspeedMs: r1(af.cruiseSpeedMs / 2), tailwindMs: 0, climbMs: 0, powerW: Math.round(pw) });
    onWing = toWing;
  };

  const land = () => {
    if (wingBorne(af, 'cruise')) transition(false);
    leg({ ...cur, alt: 0 }, 'landing', speed);
  };

  let airborne = false;
  let ended = false;
  for (const it of plan.items) {
    if (ended) break;
    switch (it.type) {
      case 'speed':
        if (it.speed && it.speed > 0) speed = it.speed;
        break;
      case 'takeoff':
        leg({ ...cur, alt: it.alt ?? plan.defaultAlt }, 'takeoff', speed);
        airborne = true;
        if (wingBorne(af, 'cruise')) transition(true);
        break;
      case 'waypoint':
      case 'loiter':
        if (it.lat === undefined || it.lon === undefined) break;
        if (!airborne) {
          leg({ ...cur, alt: it.alt ?? plan.defaultAlt }, 'takeoff', speed);
          airborne = true;
          if (wingBorne(af, 'cruise')) transition(true);
        }
        leg({ lat: it.lat, lon: it.lon, alt: it.alt ?? cur.alt }, 'cruise', it.speed ?? speed);
        if (it.type === 'loiter' && it.unlimited) issues.push({ severity: 'info', code: 'unlimited_loiter', message: `Loiter ${it.lat.toFixed(5)}, ${it.lon.toFixed(5)} waits for the operator; the simulation continues after one turn.` });
        hover(loiterSeconds(it, it.speed ?? speed), 'hold');
        break;
      case 'land':
        if (it.lat !== undefined && it.lon !== undefined) leg({ lat: it.lat, lon: it.lon, alt: cur.alt }, 'cruise', speed);
        land();
        ended = true;
        break;
      case 'rtl':
        leg({ lat: home.lat, lon: home.lon, alt: cur.alt }, 'cruise', speed);
        land();
        ended = true;
        break;
      default:
        break;
    }
  }
  if (!ended && airborne) issues.push({ severity: 'warning', code: 'no_landing', message: 'The mission does not end with RTL or a landing; the drone keeps hovering at the last waypoint.' });

  // Feasibility checks against the results (assigned inside closures, hence the casts).
  const depleted = depletedAt as number | null;
  const lowestAgl = minAgl as number | null;
  const endSoc = soc();
  let minSoc = startSoc;
  for (const s of samples) minSoc = Math.min(minSoc, s.socPct);
  if (depleted !== null) {
    issues.push({ severity: 'error', code: 'battery_depleted', message: `The usable battery energy (${Math.round(usableWh)} Wh) is exhausted after ${Math.round(depleted / 60)} min – the mission needs ${Math.round(energyWh)} Wh.`, t: depleted });
  } else if (endSoc < reserve) {
    issues.push({ severity: 'warning', code: 'reserve_below_limit', message: `Landing with ${endSoc.toFixed(0)} % battery, below the ${reserve} % reserve.` });
  }
  if (maxWind > af.maxWindMs) issues.push({ severity: 'error', code: 'wind_over_limit', message: `Wind of ${maxWind.toFixed(1)} m/s at flight altitude exceeds the ${af.maxWindMs} m/s limit.` });
  else if (wind10?.gustMs && wind10.gustMs > af.maxWindMs) issues.push({ severity: 'warning', code: 'gusts', message: `Gusts up to ${wind10.gustMs.toFixed(1)} m/s exceed the ${af.maxWindMs} m/s wind limit.` });
  const maxAlt = samples.reduce((m, s) => Math.max(m, s.altRel), 0);
  const da = densityAltitude(rhoAt(maxAlt));
  if (da > af.serviceCeilingM) issues.push({ severity: 'error', code: 'density_altitude', message: `Density altitude ${Math.round(da)} m exceeds the ${af.serviceCeilingM} m service ceiling.` });
  if (lowestAgl !== null) {
    if (lowestAgl < 5) issues.push({ severity: 'error', code: 'terrain_collision', message: `The route passes ${Math.max(0, lowestAgl).toFixed(0)} m above (or into) the terrain.` });
    else if (lowestAgl < 20) issues.push({ severity: 'warning', code: 'low_clearance', message: `Minimum terrain clearance is only ${lowestAgl.toFixed(0)} m.` });
  }
  if (af.kind === 'vtol') {
    const shortCruise = legs.filter((l) => l.phase === 'cruise' && l.distanceM > 0 && l.distanceM < 150).length;
    if (shortCruise > 0) issues.push({ severity: 'info', code: 'vtol_short_legs', message: `${shortCruise} leg(s) are shorter than 150 m – a VTOL flies them inefficiently; consider a multirotor.` });
  }

  const duration = t;
  return {
    ...base,
    durationS: Math.round(duration),
    distanceM: Math.round(distance),
    energyWh: r1(energyWh),
    endSocPct: r1(endSoc),
    minSocPct: r1(minSoc),
    maxPowerW: Math.round(maxPower),
    avgPowerW: duration > 0 ? Math.round((energyWh * 3600) / duration) : 0,
    minAglM: lowestAgl === null ? null : r1(lowestAgl),
    maxWindMs: r1(maxWind),
    feasible: !issues.some((i) => i.severity === 'error'),
    legs,
    issues,
    samples: decimate(samples, opts.maxSamples ?? 3000),
  };
}

export interface AirframeComparisonRow {
  airframeId: string;
  airframeName: string;
  feasible: boolean;
  durationS: number;
  energyWh: number;
  endSocPct: number;
  maxPowerW: number;
  errors: string[];
}

/** Benchmarks several airframes on the same mission and conditions. */
export function compareAirframes(plan: MissionPlan, airframes: readonly Airframe[], opts: Omit<SimulationOptions, 'airframe'>): AirframeComparisonRow[] {
  return airframes.map((af) => {
    const r = simulateFlight(plan, { ...opts, airframe: af, maxSamples: 2 });
    return {
      airframeId: af.id,
      airframeName: af.name,
      feasible: r.feasible,
      durationS: r.durationS,
      energyWh: r.energyWh,
      endSocPct: r.endSocPct,
      maxPowerW: r.maxPowerW,
      errors: r.issues.filter((i) => i.severity === 'error').map((i) => i.message),
    };
  });
}
