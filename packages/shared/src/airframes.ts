/**
 * Airframe catalogue and flight-physics models ("true-to-life models").
 *
 * Power models:
 *  - Rotor-borne flight (multirotors, VTOL hover/vertical phases): momentum theory.
 *    Hover induced velocity v_h = sqrt(T / (2ρA)); in forward flight the induced velocity
 *    follows Glauert's relation v_i = v_h² / sqrt(V² + v_i²). Shaft power = T·v_i / FM
 *    plus body drag power D·V and climb power T·V_c, divided by the drivetrain efficiency.
 *  - Wing-borne cruise (fixed-wing, VTOL cruise): parabolic drag polar
 *    C_D = C_D0 + C_L² / (π e AR), power = D·V / η_prop (+ climb power W·V_c / η_prop).
 *  - Air density from the ISA model (optionally with the actual temperature).
 *  - Wind: wind triangle per leg; multirotors hold the planned ground speed, aircraft on
 *    the wing hold their cruise airspeed.
 *
 * Parameters are representative of commercial airframes of each class; they are
 * editable data, not marketing figures of a specific product.
 */
import type { LatLon } from './geo';

export const G = 9.80665;
export const SEA_LEVEL_DENSITY = 1.225;

export type AirframeKind = 'multirotor' | 'vtol' | 'fixed_wing';
export type AirframeModel = 'taixichuang-quad' | 'h380' | 'hamburger-x8' | 'specter-10x' | 'vtol';

/** Induced-power penalty of a coaxial rotor pair (interference; 1.2–1.3 in the literature). */
export const COAXIAL_INTERFERENCE = 1.25;

export interface CameraSpec {
  name: string;
  sensorWidthMm: number;
  sensorHeightMm: number;
  focalLengthMm: number;
  imageWidthPx: number;
  imageHeightPx: number;
}

export interface BatterySpec {
  cells: number;
  capacityAh: number;
  /** Fraction of the capacity that may be used before the pack is considered empty. */
  usableFraction: number;
}

export interface Airframe {
  id: string;
  name: string;
  kind: AirframeKind;
  description: string;
  /** Take-off mass without payload, battery included (kg). */
  emptyMassKg: number;
  maxPayloadKg: number;
  /** Lift rotors (multirotor and VTOL). */
  rotors: number;
  /** Rotors mounted in coaxial pairs (X8): half the disk area, interference losses. */
  coaxial?: boolean;
  propDiameterM: number;
  /** Rotor figure of merit in hover (0.5–0.75). */
  figureOfMerit: number;
  /** Motor + ESC efficiency. */
  drivetrainEfficiency: number;
  /** Equivalent flat-plate drag area C_D·A of the body in rotor-borne flight (m²). */
  dragAreaM2: number;
  /** Wing (VTOL, fixed-wing). */
  wing?: { areaM2: number; aspectRatio: number; cd0: number; oswald: number; propEfficiency: number; stallSpeedMs: number };
  cruiseSpeedMs: number;
  maxSpeedMs: number;
  maxClimbMs: number;
  maxDescentMs: number;
  /** Highest sustained wind the airframe is rated for (m/s). */
  maxWindMs: number;
  /** Maximum density altitude (m). */
  serviceCeilingM: number;
  battery: BatterySpec;
  /** Flight controller, radios, companion computer (W). */
  avionicsW: number;
  /** Camera / gimbal / payload electronics (W). */
  payloadPowerW: number;
  camera: CameraSpec;
  /** VTOL: duration of each hover↔cruise transition (s). */
  transitionS?: number;
  /** 3D model used by the views (apps/web/public/models/<model>.glb). */
  model: AirframeModel;
}

const CAM_SMALL: CameraSpec = { name: '1/2.3" 12 MP', sensorWidthMm: 6.17, sensorHeightMm: 4.55, focalLengthMm: 4.49, imageWidthPx: 4000, imageHeightPx: 3000 };
const CAM_1INCH: CameraSpec = { name: '1" 20 MP', sensorWidthMm: 13.2, sensorHeightMm: 8.8, focalLengthMm: 8.8, imageWidthPx: 5472, imageHeightPx: 3648 };
const CAM_FULL_FRAME: CameraSpec = { name: 'Full-frame 61 MP', sensorWidthMm: 35.7, sensorHeightMm: 23.8, focalLengthMm: 35, imageWidthPx: 9504, imageHeightPx: 6336 };

/**
 * The multirotors are the operator's own airframes (3D models supplied with the project):
 * propeller size and arm span are measured on the models; masses, batteries and
 * efficiencies are typical values for each class.
 */
export const AIRFRAMES: readonly Airframe[] = [
  {
    id: 'taixichuang-quad',
    name: 'TaiXiChuang Quad',
    kind: 'multirotor',
    description: '13-inch quadcopter (≈ 660 mm motor-to-motor) with a Raspberry Pi 5 companion computer and Wi-Fi 6E mesh radio.',
    emptyMassKg: 3.2,
    maxPayloadKg: 1.2,
    rotors: 4,
    propDiameterM: 0.33,
    figureOfMerit: 0.65,
    drivetrainEfficiency: 0.85,
    dragAreaM2: 0.05,
    cruiseSpeedMs: 10,
    maxSpeedMs: 16,
    maxClimbMs: 5,
    maxDescentMs: 3,
    maxWindMs: 10,
    serviceCeilingM: 3500,
    battery: { cells: 6, capacityAh: 10, usableFraction: 0.85 },
    avionicsW: 30,
    payloadPowerW: 6,
    camera: CAM_SMALL,
    model: 'taixichuang-quad',
  },
  {
    id: 'h380',
    name: 'H380 compact quad',
    kind: 'multirotor',
    description: '380 mm class quadcopter with 9-inch propellers and an on-board compute module.',
    emptyMassKg: 1.6,
    maxPayloadKg: 0.4,
    rotors: 4,
    propDiameterM: 0.23,
    figureOfMerit: 0.6,
    drivetrainEfficiency: 0.83,
    dragAreaM2: 0.025,
    cruiseSpeedMs: 10,
    maxSpeedMs: 18,
    maxClimbMs: 5,
    maxDescentMs: 3,
    maxWindMs: 9,
    serviceCeilingM: 3000,
    battery: { cells: 4, capacityAh: 5.2, usableFraction: 0.85 },
    avionicsW: 18,
    payloadPowerW: 3,
    camera: CAM_SMALL,
    model: 'h380',
  },
  {
    id: 'specter-10x',
    name: 'Specter 10X inspection quad',
    kind: 'multirotor',
    description: '10-inch quadcopter (≈ 530 mm) with LiDAR, gimbal camera and Cube Orange autopilot.',
    emptyMassKg: 2.6,
    maxPayloadKg: 0.8,
    rotors: 4,
    propDiameterM: 0.254,
    figureOfMerit: 0.62,
    drivetrainEfficiency: 0.84,
    dragAreaM2: 0.035,
    cruiseSpeedMs: 12,
    maxSpeedMs: 20,
    maxClimbMs: 6,
    maxDescentMs: 3.5,
    maxWindMs: 11,
    serviceCeilingM: 3500,
    battery: { cells: 6, capacityAh: 8, usableFraction: 0.85 },
    avionicsW: 28,
    payloadPowerW: 8,
    camera: CAM_1INCH,
    model: 'specter-10x',
  },
  {
    id: 'hamburger-x8',
    name: 'Hamburger X8 coaxial octocopter',
    kind: 'multirotor',
    description: 'Heavy-lift coaxial X8 – four arms, eight 15-inch propellers – for LiDAR, delivery and large sensors.',
    emptyMassKg: 9.5,
    maxPayloadKg: 5,
    rotors: 8,
    coaxial: true,
    propDiameterM: 0.38,
    figureOfMerit: 0.68,
    drivetrainEfficiency: 0.86,
    dragAreaM2: 0.12,
    cruiseSpeedMs: 10,
    maxSpeedMs: 15,
    maxClimbMs: 4,
    maxDescentMs: 3,
    maxWindMs: 12,
    serviceCeilingM: 3500,
    battery: { cells: 12, capacityAh: 22, usableFraction: 0.85 },
    avionicsW: 35,
    payloadPowerW: 25,
    camera: CAM_FULL_FRAME,
    model: 'hamburger-x8',
  },
  {
    id: 'athena-vtol',
    name: 'Athena VTOL fixed-wing',
    kind: 'vtol',
    description: 'Quad-plane VTOL for long-range corridor mapping and surveillance; APS-C 24 MP camera.',
    emptyMassKg: 13,
    maxPayloadKg: 2.5,
    rotors: 4,
    propDiameterM: 0.47,
    figureOfMerit: 0.6,
    drivetrainEfficiency: 0.85,
    dragAreaM2: 0.15,
    wing: { areaM2: 0.95, aspectRatio: 10.5, cd0: 0.035, oswald: 0.8, propEfficiency: 0.6, stallSpeedMs: 15 },
    cruiseSpeedMs: 22,
    maxSpeedMs: 30,
    maxClimbMs: 4,
    maxDescentMs: 3,
    maxWindMs: 14,
    serviceCeilingM: 4500,
    battery: { cells: 12, capacityAh: 22, usableFraction: 0.85 },
    avionicsW: 35,
    payloadPowerW: 20,
    camera: { name: 'APS-C 24 MP', sensorWidthMm: 23.5, sensorHeightMm: 15.6, focalLengthMm: 25, imageWidthPx: 6000, imageHeightPx: 4000 },
    transitionS: 10,
    model: 'vtol',
  },
];

export const DEFAULT_AIRFRAME_ID = 'specter-10x';

export function airframeById(id: string | null | undefined): Airframe | undefined {
  return AIRFRAMES.find((a) => a.id === id);
}

/** Nominal pack energy (Wh) at 3.7 V per cell. */
export function batteryEnergyWh(b: BatterySpec): number {
  return b.cells * 3.7 * b.capacityAh;
}

/**
 * Air density (kg/m³) from the International Standard Atmosphere at an altitude above mean
 * sea level, optionally corrected with the actual air temperature.
 */
export function airDensity(altMslM: number, temperatureC?: number | null): number {
  const h = Math.max(-500, Math.min(11_000, altMslM));
  const tIsa = 288.15 - 0.0065 * h;
  const p = 101_325 * (tIsa / 288.15) ** 5.25588;
  const t = temperatureC !== undefined && temperatureC !== null && Number.isFinite(temperatureC) ? temperatureC + 273.15 : tIsa;
  return p / (287.05 * t);
}

/** Altitude of the ISA atmosphere having this density (m). */
export function densityAltitude(rho: number): number {
  // ρ/ρ0 = (1 - 2.25577e-5 h)^4.25588
  return (1 - (rho / SEA_LEVEL_DENSITY) ** (1 / 4.25588)) / 2.25577e-5;
}

export interface PowerBreakdown {
  totalW: number;
  inducedW: number;
  parasiteW: number;
  climbW: number;
  electronicsW: number;
}

/** Rotor-borne flight power (multirotor; VTOL in hover / vertical flight). */
export function rotorPower(af: Airframe, massKg: number, airspeedMs: number, climbMs: number, rho: number): PowerBreakdown {
  const weight = massKg * G;
  const drag = 0.5 * rho * airspeedMs * airspeedMs * af.dragAreaM2;
  const thrust = Math.hypot(weight, drag);
  // Coaxial pairs share one disk; the lower rotor works in the upper rotor's wake.
  const disks = af.coaxial ? af.rotors / 2 : af.rotors;
  const area = disks * Math.PI * (af.propDiameterM / 2) ** 2;
  const vh2 = thrust / (2 * rho * area);
  // Glauert: v_i = v_h² / sqrt(V² + v_i²), solved by fixed-point iteration.
  let vi = Math.sqrt(vh2);
  for (let k = 0; k < 30; k++) vi = vh2 / Math.sqrt(airspeedMs * airspeedMs + vi * vi);
  const eta = af.drivetrainEfficiency;
  const inducedW = ((thrust * vi) / af.figureOfMerit / eta) * (af.coaxial ? COAXIAL_INTERFERENCE : 1);
  const parasiteW = (drag * airspeedMs) / eta;
  // Climbing costs T·Vc; descending recovers part of it (never below 30 % of hover power).
  const climbW = climbMs >= 0 ? (weight * climbMs) / eta : Math.max((weight * climbMs * 0.5) / eta, -0.7 * inducedW);
  const electronicsW = af.avionicsW + af.payloadPowerW;
  return { totalW: inducedW + parasiteW + climbW + electronicsW, inducedW, parasiteW, climbW, electronicsW };
}

/** Wing-borne flight power (fixed-wing, VTOL in cruise). */
export function wingPower(af: Airframe, massKg: number, airspeedMs: number, climbMs: number, rho: number): PowerBreakdown {
  const w = af.wing;
  if (!w) throw new Error(`${af.name} has no wing`);
  const v = Math.max(airspeedMs, w.stallSpeedMs * 1.1);
  const weight = massKg * G;
  const q = 0.5 * rho * v * v;
  const cl = weight / (q * w.areaM2);
  const k = 1 / (Math.PI * w.oswald * w.aspectRatio);
  const induced = q * w.areaM2 * k * cl * cl;
  const parasite = q * w.areaM2 * w.cd0;
  const eta = w.propEfficiency;
  const inducedW = (induced * v) / eta;
  const parasiteW = (parasite * v) / eta;
  const climbW = climbMs >= 0 ? (weight * climbMs) / eta : Math.max((weight * climbMs) / eta, -(inducedW + parasiteW) * 0.9);
  const electronicsW = af.avionicsW + af.payloadPowerW;
  return { totalW: inducedW + parasiteW + climbW + electronicsW, inducedW, parasiteW, climbW, electronicsW };
}

/** Whether the airframe flies this phase on its wing. */
export function wingBorne(af: Airframe, phase: 'vertical' | 'cruise'): boolean {
  return phase === 'cruise' && (af.kind === 'fixed_wing' || af.kind === 'vtol') && !!af.wing;
}

/** Wind vector (m/s, east/north components) blowing FROM `fromDeg`. */
export function windVector(speedMs: number, fromDeg: number): { e: number; n: number } {
  const to = ((fromDeg + 180) * Math.PI) / 180;
  return { e: speedMs * Math.sin(to), n: speedMs * Math.cos(to) };
}

/** Wind at a height above ground from the 10 m wind (1/7 power law, ≥ 2 m). */
export function windAtHeight(speed10m: number, heightAglM: number): number {
  return speed10m * (Math.max(2, heightAglM) / 10) ** (1 / 7);
}

export interface LegKinematics {
  groundSpeedMs: number;
  airspeedMs: number;
  /** Component of the wind along the track (negative = headwind). */
  tailwindMs: number;
  /** False when the aircraft cannot hold the track against the wind. */
  feasible: boolean;
}

/**
 * Wind triangle for a leg with track bearing `trackDeg`.
 * mode 'ground': hold `speedMs` over the ground (multirotor), capped so the airspeed
 * stays below `maxAirspeedMs`; mode 'air': fly at `speedMs` airspeed (wing-borne).
 */
export function legKinematics(trackDeg: number, speedMs: number, wind: { e: number; n: number }, mode: 'ground' | 'air', maxAirspeedMs: number): LegKinematics {
  const t = (trackDeg * Math.PI) / 180;
  const u = { e: Math.sin(t), n: Math.cos(t) };
  const along = wind.e * u.e + wind.n * u.n;
  const w2 = wind.e * wind.e + wind.n * wind.n;
  const groundFor = (va: number): number | null => {
    const disc = along * along - w2 + va * va;
    if (disc < 0) return null;
    const vg = along + Math.sqrt(disc);
    return vg > 0.5 ? vg : null;
  };
  if (mode === 'air') {
    const vg = groundFor(speedMs);
    return { groundSpeedMs: vg ?? 0, airspeedMs: speedMs, tailwindMs: along, feasible: vg !== null };
  }
  let vg = speedMs;
  let va = Math.hypot(vg * u.e - wind.e, vg * u.n - wind.n);
  if (va > maxAirspeedMs) {
    const capped = groundFor(maxAirspeedMs);
    if (capped === null) return { groundSpeedMs: 0, airspeedMs: maxAirspeedMs, tailwindMs: along, feasible: false };
    vg = Math.min(vg, capped);
    va = Math.hypot(vg * u.e - wind.e, vg * u.n - wind.n);
  }
  return { groundSpeedMs: vg, airspeedMs: va, tailwindMs: along, feasible: true };
}

/** Footprint and ground sampling distance of a nadir camera at a height above ground. */
export function cameraFootprint(camera: CameraSpec, heightM: number): { widthM: number; heightM: number; gsdCmPerPx: number } {
  const widthM = (camera.sensorWidthMm * heightM) / camera.focalLengthMm;
  const h = (camera.sensorHeightMm * heightM) / camera.focalLengthMm;
  return { widthM, heightM: h, gsdCmPerPx: (widthM / camera.imageWidthPx) * 100 };
}

/**
 * Survey line spacing and photo trigger distance for the requested overlaps
 * (image width across track, height along track).
 */
export function surveyParameters(camera: CameraSpec, heightM: number, frontOverlap: number, sideOverlap: number): { lineSpacingM: number; triggerDistanceM: number; gsdCmPerPx: number } {
  const fp = cameraFootprint(camera, heightM);
  return {
    lineSpacingM: fp.widthM * (1 - Math.min(0.95, Math.max(0, sideOverlap))),
    triggerDistanceM: fp.heightM * (1 - Math.min(0.95, Math.max(0, frontOverlap))),
    gsdCmPerPx: fp.gsdCmPerPx,
  };
}

/** Height above ground giving the requested GSD. */
export function heightForGsd(camera: CameraSpec, gsdCmPerPx: number): number {
  return ((gsdCmPerPx / 100) * camera.imageWidthPx * camera.focalLengthMm) / camera.sensorWidthMm;
}

export interface EnduranceEstimate {
  hoverPowerW: number;
  hoverEnduranceS: number;
  cruisePowerW: number;
  cruiseEnduranceS: number;
  cruiseRangeM: number;
}

/** Hover and cruise endurance at a given payload and density. */
export function enduranceEstimate(af: Airframe, payloadKg: number, rho = SEA_LEVEL_DENSITY): EnduranceEstimate {
  const mass = af.emptyMassKg + payloadKg;
  const usableWh = batteryEnergyWh(af.battery) * af.battery.usableFraction;
  const hover = rotorPower(af, mass, 0, 0, rho).totalW;
  const cruise = (wingBorne(af, 'cruise') ? wingPower(af, mass, af.cruiseSpeedMs, 0, rho) : rotorPower(af, mass, af.cruiseSpeedMs, 0, rho)).totalW;
  return {
    hoverPowerW: hover,
    hoverEnduranceS: (usableWh / hover) * 3600,
    cruisePowerW: cruise,
    cruiseEnduranceS: (usableWh / cruise) * 3600,
    cruiseRangeM: (usableWh / cruise) * 3600 * af.cruiseSpeedMs,
  };
}

export interface AirframeSummary {
  id: string;
  name: string;
  kind: AirframeKind;
  description: string;
  model: Airframe['model'];
  maxPayloadKg: number;
  cruiseSpeedMs: number;
  batteryWh: number;
  hoverEnduranceMin: number;
  cruiseEnduranceMin: number;
  cruiseRangeKm: number;
  camera: CameraSpec;
}

export function airframeSummary(af: Airframe): AirframeSummary {
  const e = enduranceEstimate(af, 0);
  return {
    id: af.id,
    name: af.name,
    kind: af.kind,
    description: af.description,
    model: af.model,
    maxPayloadKg: af.maxPayloadKg,
    cruiseSpeedMs: af.cruiseSpeedMs,
    batteryWh: Math.round(batteryEnergyWh(af.battery)),
    hoverEnduranceMin: Math.round(e.hoverEnduranceS / 6) / 10,
    cruiseEnduranceMin: Math.round(e.cruiseEnduranceS / 6) / 10,
    cruiseRangeKm: Math.round(e.cruiseRangeM / 100) / 10,
    camera: af.camera,
  };
}

/** Ground elevation (m above mean sea level) at a position, or null when unknown. */
export type GroundLookup = (p: LatLon) => number | null;
