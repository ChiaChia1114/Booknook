/**
 * The drone's pose when a video frame was taken. Frames are analysed a little after they were
 * taken (on the way, in the queue, in the detector) – on a busy server more so – and a drone that
 * turns or moves meanwhile would put what it saw in the wrong place: detections are located with
 * the telemetry of the frame's capture time (the drone's own clock, as its telemetry), not with
 * whatever pose the drone reports when the analysis ends.
 */
import type { Telemetry } from '@athena-sky/shared';

/** Telemetry kept per drone to find the pose of a frame (ms). */
export const POSE_HISTORY_MS = 5_000;
/** The closest a pose must be to a frame's capture time to stand for it alone (ms). */
const POSE_MATCH_MS = 1_000;

/**
 * The pose at `t`: interpolated between the poses just before and after it (position, height and
 * the shorter way round for the heading), or the nearest one within a second; null when no pose
 * kept is that close.
 */
export function poseAt(history: readonly Telemetry[], t: number): Telemetry | null {
  let before: Telemetry | null = null;
  let after: Telemetry | null = null;
  for (const p of history) {
    if (p.t <= t && (!before || p.t > before.t)) before = p;
    if (p.t >= t && (!after || p.t < after.t)) after = p;
  }
  if (before && after && after.t > before.t && after.t - before.t <= 2 * POSE_MATCH_MS) {
    const f = (t - before.t) / (after.t - before.t);
    const lerp = (a: number, b: number) => a + (b - a) * f;
    const turn = ((((after.heading - before.heading) % 360) + 540) % 360) - 180;
    return {
      ...before,
      t,
      lat: lerp(before.lat, after.lat),
      lon: lerp(before.lon, after.lon),
      altMsl: lerp(before.altMsl, after.altMsl),
      altRel: lerp(before.altRel, after.altRel),
      heading: (((before.heading + turn * f) % 360) + 360) % 360,
    };
  }
  const near = [before, after].filter((p): p is Telemetry => p !== null).sort((a, b) => Math.abs(a.t - t) - Math.abs(b.t - t))[0];
  return near && Math.abs(near.t - t) <= POSE_MATCH_MS ? near : null;
}

/** Adds a pose to a drone's history, keeping the last {@link POSE_HISTORY_MS} (by its own clock). */
export function keepPose(history: Telemetry[], pose: Telemetry): void {
  history.push(pose);
  const oldest = pose.t - POSE_HISTORY_MS;
  let drop = 0;
  while (drop < history.length - 1 && history[drop]!.t < oldest) drop++;
  if (drop > 0) history.splice(0, drop);
  if (history.length > 200) history.splice(0, history.length - 200);
}
