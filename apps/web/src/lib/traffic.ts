/**
 * Manned traffic reported by the drones' ADS-B receivers, as the maps draw it: each aircraft once
 * (its latest report), orange while it is reported and grey – with the time of its last report –
 * once that is old (it is removed after a minute without a report; see `api/live`).
 */
import type { DroneView, TrafficView } from '../api/live';

/** The traffic the drones report, each aircraft once (its latest report). */
export function liveTraffic(drones: DroneView[]): TrafficView[] {
  const byIcao = new Map<string, TrafficView>();
  for (const d of drones) {
    for (const a of d.traffic) {
      const prev = byIcao.get(a.icao);
      if (!prev || a.t > prev.t) byIcao.set(a.icao, a);
    }
  }
  return [...byIcao.values()];
}

/** Orange while the aircraft is reported, grey once its last report is old. */
export const trafficColor = (a: TrafficView): string => (a.old ? '#94a3b8' : '#f97316');

/** "✈ DLH4AB 450 m", and "· last report 14:03:22" once that is old. */
export function trafficLabel(a: TrafficView, withAlt = true): string {
  const last = a.old ? ` · last report ${new Date(a.t).toLocaleTimeString()}` : '';
  return `✈ ${a.callsign ?? a.icao}${withAlt ? ` ${Math.round(a.altMsl)} m` : ''}${last}`;
}
