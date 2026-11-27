/**
 * What the top bar counts of the drones of the live connection: online, flying as their data says
 * – a drone with no new data is not counted as flying (what it does is not known) – and with no
 * new data. Nothing while the link is lost (the drones last received are not counted).
 */
export interface CountedDrone {
  online: boolean;
  late: boolean;
  telemetry?: { inAir?: boolean } | null;
}

export function liveCounts(drones: Iterable<CountedDrone>, current: boolean): { online: number; flying: number; noData: number } {
  let online = 0;
  let flying = 0;
  let noData = 0;
  if (!current) return { online, flying, noData };
  for (const d of drones) {
    if (!d.online) continue;
    online++;
    if (d.late) noData++;
    else if (d.telemetry?.inAir) flying++;
  }
  return { online, flying, noData };
}
