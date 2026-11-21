/**
 * Athena Link (drone <-> cloud) and Athena Live (viewer <-> cloud) protocols.
 *
 * Both run over WebSocket. Control messages are JSON text frames; video is sent
 * as binary frames (see encode/decode helpers below).
 *
 *   Drone   --wss://<host>/api/v2/link-->  Cloud  <--wss://<host>/api/v2/live--  Browser / integration
 */
import type { MissionPlan } from './mission';
import type { Telemetry } from './telemetry';

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

export const COMMANDS = [
  'arm',
  'disarm',
  'takeoff',
  'land',
  'rtl',
  'hold',
  'goto',
  'set_mode',
  'set_speed',
  'mission_start',
  'mission_pause',
  'mission_resume',
  'camera_photo',
  'reboot',
] as const;
export type CommandName = (typeof COMMANDS)[number];

export interface CommandParams {
  /** takeoff target altitude (m, relative). */
  alt?: number;
  lat?: number;
  lon?: number;
  mode?: string;
  /** goto: ground speed (m/s). */
  speed?: number;
  /** goto: heading to hold at the target (degrees from north). */
  yaw?: number;
  fromSeq?: number;
}

export type AckResult = 'accepted' | 'in_progress' | 'completed' | 'rejected' | 'failed' | 'timeout';

export interface DetectedAircraft {
  icao: string;
  callsign?: string;
  lat: number;
  lon: number;
  altMsl: number;
  heading: number;
  speed: number;
  t: number;
}

export type EventLevel = 'info' | 'warning' | 'error' | 'critical';

// ---------------------------------------------------------------------------
// Link protocol: drone -> cloud
// ---------------------------------------------------------------------------

export type LinkUpMessage =
  | { type: 'auth'; key: string }
  | {
      type: 'hello';
      firmware: string;
      model?: string;
      serial?: string;
      capabilities?: { video?: boolean; manualControl?: boolean; adsb?: boolean };
    }
  | ({ type: 'telemetry' } & Telemetry)
  | { type: 'event'; t?: number; level: EventLevel; code?: string; message: string }
  | { type: 'ack'; id: string; result: AckResult; message?: string }
  | { type: 'mission_progress'; seq: number; total: number; reached?: boolean }
  | { type: 'mission_ack'; id: string; result: AckResult; message?: string }
  | {
      type: 'firmware_progress';
      updateId: string;
      status: 'downloading' | 'verifying' | 'installing' | 'completed' | 'failed';
      progress: number;
      message?: string;
    }
  | { type: 'adsb'; aircraft: DetectedAircraft[] }
  | { type: 'payload'; t?: number; kind: string; data: Record<string, unknown> }
  | { type: 'pong'; id: string; t: number };

// ---------------------------------------------------------------------------
// Link protocol: cloud -> drone
// ---------------------------------------------------------------------------

export type LinkDownMessage =
  | { type: 'welcome'; droneId: string; name: string; serverTime: number }
  | { type: 'command'; id: string; command: CommandName; params: CommandParams }
  | { type: 'mission_upload'; id: string; missionId: string; name: string; plan: MissionPlan }
  | { type: 'manual_control'; x: number; y: number; z: number; r: number; t: number }
  | { type: 'video'; action: 'start' | 'stop'; quality: VideoQuality }
  | { type: 'firmware_update'; updateId: string; version: string; url: string; sha256: string; size: number }
  | { type: 'ping'; id: string; t: number }
  | { type: 'error'; message: string };

export type VideoQuality = 'sd' | 'hd';

// ---------------------------------------------------------------------------
// Live protocol: viewer -> cloud
// ---------------------------------------------------------------------------

export type LiveUpMessage =
  | { type: 'subscribe'; droneIds: string[] | 'all' }
  | { type: 'video'; droneId: string; enabled: boolean; quality?: VideoQuality }
  | { type: 'command'; droneId: string; requestId: string; command: CommandName; params?: CommandParams }
  | { type: 'control'; droneId: string; action: 'request' | 'release' | 'force' }
  | { type: 'manual_control'; droneId: string; x: number; y: number; z: number; r: number }
  | { type: 'ping'; id: string; t: number; droneId?: string };

export interface ControllerInfo {
  userId: string;
  name: string;
}

export interface LiveDroneState {
  droneId: string;
  name: string;
  fleetId: string | null;
  model: string | null;
  firmware: string | null;
  online: boolean;
  connectedAt: number | null;
  lastSeenAt: number | null;
  telemetry: Telemetry | null;
  controller: ControllerInfo | null;
  flightId: string | null;
  videoAvailable: boolean;
  mission: { missionId: string; name: string; seq: number; total: number } | null;
}

export interface OnlineUser {
  userId: string;
  name: string;
  role: string;
  since: number;
}

// ---------------------------------------------------------------------------
// Live protocol: cloud -> viewer
// ---------------------------------------------------------------------------

export type LiveDownMessage =
  | { type: 'hello'; userId: string; orgId: string; serverTime: number; canControl: boolean }
  | { type: 'snapshot'; drones: LiveDroneState[]; users: OnlineUser[] }
  | { type: 'status'; drone: LiveDroneState }
  | { type: 'telemetry'; droneId: string; data: Telemetry }
  | { type: 'event'; droneId: string; t: number; level: EventLevel; code?: string; message: string }
  | { type: 'ack'; droneId: string; requestId: string; command: string; result: AckResult; message?: string }
  | { type: 'control'; droneId: string; controller: ControllerInfo | null }
  | { type: 'flight'; droneId: string; flightId: string; state: 'started' | 'ended' }
  | { type: 'mission_progress'; droneId: string; seq: number; total: number }
  | { type: 'firmware_progress'; droneId: string; updateId: string; status: string; progress: number; message?: string }
  | { type: 'adsb'; droneId: string; aircraft: DetectedAircraft[] }
  | { type: 'users'; users: OnlineUser[] }
  | { type: 'pong'; id: string; t: number; serverTime: number; droneRttMs?: number }
  | { type: 'error'; message: string; requestId?: string };

// ---------------------------------------------------------------------------
// Binary video frames
// ---------------------------------------------------------------------------

export const FRAME_VIDEO_JPEG = 0x01;

/** Link video frame: [0x01][f64 BE capture time ms][u8 stream][JPEG bytes]. */
export function encodeLinkVideoFrame(ts: number, stream: number, jpeg: Uint8Array): Uint8Array {
  const out = new Uint8Array(10 + jpeg.length);
  const dv = new DataView(out.buffer);
  out[0] = FRAME_VIDEO_JPEG;
  dv.setFloat64(1, ts);
  out[9] = stream & 0xff;
  out.set(jpeg, 10);
  return out;
}

export function decodeLinkVideoFrame(buf: Uint8Array): { ts: number; stream: number; jpeg: Uint8Array } | null {
  if (buf.length < 12 || buf[0] !== FRAME_VIDEO_JPEG) return null;
  const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  const jpeg = buf.subarray(10);
  // JPEG SOI marker check (FF D8)
  if (jpeg[0] !== 0xff || jpeg[1] !== 0xd8) return null;
  return { ts: dv.getFloat64(1), stream: buf[9]!, jpeg };
}

/** Live video frame: [0x01][u8 idLen][droneId utf8][f64 BE ts][u8 stream][JPEG bytes]. */
export function encodeLiveVideoFrame(droneId: string, ts: number, stream: number, jpeg: Uint8Array): Uint8Array {
  const id = new TextEncoder().encode(droneId);
  const out = new Uint8Array(2 + id.length + 9 + jpeg.length);
  const dv = new DataView(out.buffer);
  out[0] = FRAME_VIDEO_JPEG;
  out[1] = id.length;
  out.set(id, 2);
  dv.setFloat64(2 + id.length, ts);
  out[2 + id.length + 8] = stream & 0xff;
  out.set(jpeg, 2 + id.length + 9);
  return out;
}

export function decodeLiveVideoFrame(
  buf: Uint8Array,
): { droneId: string; ts: number; stream: number; jpeg: Uint8Array } | null {
  if (buf.length < 2 || buf[0] !== FRAME_VIDEO_JPEG) return null;
  const idLen = buf[1]!;
  if (buf.length < 2 + idLen + 9 + 2) return null;
  const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  const droneId = new TextDecoder().decode(buf.subarray(2, 2 + idLen));
  const ts = dv.getFloat64(2 + idLen);
  const stream = buf[2 + idLen + 8]!;
  return { droneId, ts, stream, jpeg: buf.subarray(2 + idLen + 9) };
}

/** Clamp manual-control axes into [-1, 1]. */
export function clampAxis(v: unknown): number {
  return typeof v === 'number' && Number.isFinite(v) ? Math.max(-1, Math.min(1, v)) : 0;
}
