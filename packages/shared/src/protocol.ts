import type { Role } from './roles';
/**
 * Athena Link (drone <-> cloud) and Athena Live (viewer <-> cloud) protocols.
 *
 * Both run over WebSocket. Control messages are JSON text frames; video is sent
 * as binary frames (see encode/decode helpers below).
 *
 *   Drone   --wss://<host>/api/v2/link-->  Cloud  <--wss://<host>/api/v2/live--  Browser / integration
 */
import type { NotificationDto, SwarmDto } from './api';
import type { MissionPlan } from './mission';
import type { LatLonAlt } from './geo';
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

/** Camera model of a drone's video stream. */
export interface CameraInfo {
  /** Horizontal field of view (degrees). */
  hfovDeg: number;
  /** Gimbal pitch (degrees, negative = below the horizon). */
  pitchDeg: number;
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
  /** When the aircraft was reported (ms since 1970; the cloud passes it on in its own clock). */
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
      /** `ai`: object detection on board – started and stopped with the `ai` message, reported with `detections`. */
      capabilities?: { video?: boolean; manualControl?: boolean; adsb?: boolean; ai?: boolean };
      /** Gimbal camera of the video stream (geolocation of detected objects). */
      camera?: CameraInfo;
      /**
       * The mission on board (as uploaded: its id, the current item and the item count), or null
       * when there is none. Lets the cloud pick up a loaded mission again after a reconnect.
       */
      mission?: { id: string; seq: number; total: number } | null;
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
  /** Detections of an on-board AI (normalised boxes in the video frame). */
  | { type: 'detections'; t?: number; objects: { cls: string; score: number; box: [number, number, number, number] }[] }
  | { type: 'pong'; id: string; t: number };

// ---------------------------------------------------------------------------
// Link protocol: cloud -> drone
// ---------------------------------------------------------------------------

export type LinkDownMessage =
  | { type: 'welcome'; droneId: string; name: string; serverTime: number }
  | { type: 'command'; id: string; command: CommandName; params: CommandParams }
  | { type: 'mission_upload'; id: string; missionId: string; name: string; plan: MissionPlan }
  /** The loaded mission has been flown to the end: clear it (it is uploaded again to fly it again). */
  | { type: 'mission_clear'; id: string; missionId: string }
  | { type: 'manual_control'; x: number; y: number; z: number; r: number; t: number }
  | { type: 'video'; action: 'start' | 'stop'; quality: VideoQuality }
  /** Turns the on-board object detection of a drone declaring `capabilities.ai` on or off. */
  | { type: 'ai'; enabled: boolean }
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
  /**
   * Latency probe: answered by the cloud at once (`pong` with its time), or by way of the drone
   * when `droneId` is given (its `droneRttMs`).
   */
  | { type: 'ping'; id: string; t: number; droneId?: string }
  /**
   * Flow control (optional, recommended): the viewer has received the first `n` messages (text
   * and binary) of the connection. A viewer that acknowledges what it receives gets no more than
   * its link carries without delay: while messages wait too long for their acknowledgement, video
   * frames are dropped and only the latest telemetry and detections of each drone are kept back.
   */
  | { type: 'ack'; n: number };

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
  /** When the telemetry sample was taken, in the cloud's clock (ms since 1970). */
  telemetryAt?: number | null;
  controller: ControllerInfo | null;
  flightId: string | null;
  videoAvailable: boolean;
  /**
   * The mission loaded on the drone: `uploadedAt` identifies the upload (its plan:
   * `GET …/drones/:id/loaded-mission`), `start` is where it was started in the air (null: from home).
   */
  mission: { missionId: string; name: string; seq: number; total: number; uploadedAt: string; start: LatLonAlt | null } | null;
  /** AI vision on the drone's video. */
  ai?: AiStatus | null;
}

export interface AiStatus {
  enabled: boolean;
  /** Where detection runs: the cloud on the video stream, or on board the drone. */
  source: 'cloud' | 'onboard';
  /** Track followed by the drone (follow-me), if any. */
  following: number | null;
  followStatus: 'following' | 'searching' | null;
}

/** A tracked object in a drone's video. */
export interface DetectedObjectDto {
  trackId: number;
  cls: string;
  score: number;
  /** Box in normalised image coordinates: left, top, width, height. */
  box: [number, number, number, number];
  /** Dominant colour (recognition). */
  color: string | null;
  /** Estimated ground position. */
  lat: number | null;
  lon: number | null;
  /** Ground speed of the object (m/s). */
  speedMs: number | null;
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
  | { type: 'hello'; userId: string; orgId: string; serverTime: number; canControl: boolean; /** The viewer's role (sent again when it changes). */ role?: Role }
  | { type: 'snapshot'; drones: LiveDroneState[]; users: OnlineUser[] }
  | { type: 'status'; drone: LiveDroneState }
  /** `at`: when the sample was taken, in the cloud's clock (`data.t` is the drone's clock). */
  | { type: 'telemetry'; droneId: string; data: Telemetry; at?: number }
  | { type: 'event'; droneId: string; t: number; level: EventLevel; code?: string; message: string }
  | { type: 'ack'; droneId: string; requestId: string; command: string; result: AckResult; message?: string }
  | { type: 'control'; droneId: string; controller: ControllerInfo | null }
  | { type: 'flight'; droneId: string; flightId: string; state: 'started' | 'ended' }
  | { type: 'mission_progress'; droneId: string; seq: number; total: number }
  | { type: 'firmware_progress'; droneId: string; updateId: string; status: string; progress: number; message?: string }
  | { type: 'adsb'; droneId: string; aircraft: DetectedAircraft[] }
  | { type: 'users'; users: OnlineUser[] }
  | { type: 'pong'; id: string; t: number; serverTime: number; droneRttMs?: number }
  | { type: 'notification'; notification: NotificationDto }
  | { type: 'detections'; droneId: string; t: number; objects: DetectedObjectDto[] }
  | { type: 'swarm'; swarm: SwarmDto }
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

/**
 * Live video frame: [0x01][u8 idLen][droneId utf8][f64 BE ts][u8 stream][JPEG bytes] – `ts` is
 * the capture time in the cloud's clock (the `serverTime` of `hello` and `pong` tells the
 * viewer's offset to it).
 */
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
