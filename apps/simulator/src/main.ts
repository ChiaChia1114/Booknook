#!/usr/bin/env node
/**
 * athena-sim – runs one or more virtual drones against an Athena-sky server.
 *
 *   athena-sim --url ws://localhost:8080/api/v2/link --key adk_xxx [--lat 47.397 --lon 8.545]
 *              [--alt 488] [--no-video] [--adsb] [--payload] [--imbalance 0.2] [--name label]
 *   athena-sim --config drones.json      # [{ "key": "...", "lat": .., "lon": .., ... }, ...]
 *   [--imagery <tile URL template>]      # camera over real aerial imagery, on-board detection
 */
import { readFileSync } from 'node:fs';
import { VirtualDrone } from './drone';
import { LinkClient } from './link-client';
import { GroundImagery, urlTileSource } from './imagery';

interface SimSpec {
  key: string;
  lat?: number;
  lon?: number;
  alt?: number;
  name?: string;
  video?: boolean;
  adsb?: boolean;
  payload?: boolean;
  imbalance?: number;
}

function parseArgs(argv: string[]): Record<string, string | boolean> {
  const out: Record<string, string | boolean> = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (!a.startsWith('--')) continue;
    const key = a.slice(2);
    const next = argv[i + 1];
    if (next === undefined || next.startsWith('--')) out[key] = true;
    else {
      out[key] = next;
      i++;
    }
  }
  return out;
}

const HELP = `athena-sim – virtual drones for Athena-sky (Athena Link reference client)

  athena-sim --url ws://localhost:8080/api/v2/link --key adk_xxx [--lat 25.0732 --lon 121.5355]
             [--alt 8] [--no-video] [--adsb] [--payload] [--imbalance 0.2] [--name label]
  athena-sim --config drones.json      # [{ "key": "adk_…", "lat": 25.07, "lon": 121.53, "adsb": true }, …]

Options:
  --url        Athena Link endpoint (ws:// or wss://)
  --key        drone link key shown when the drone was registered
  --lat/--lon  home position; --alt ground elevation (m AMSL)
  --no-video   do not offer the synthetic camera stream
  --adsb       simulate an ADS-B receiver reporting manned traffic
  --payload    publish environmental payload readings in flight
  --imbalance  inject a motor imbalance (0..0.5) to exercise post-flight analytics
  --imagery    aerial imagery tile URL template ({z}/{x}/{y}) for the camera, e.g.
               https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}
               (the camera then shows the real place, and people and vehicles are detected on board)`;

const args = parseArgs(process.argv.slice(2));
if (args.help || (!args.key && !args.config)) {
  console.log(HELP);
  process.exit(args.help ? 0 : 1);
}
const url = String(args.url ?? 'ws://localhost:8080/api/v2/link');
const specs: SimSpec[] = args.config
  ? (JSON.parse(readFileSync(String(args.config), 'utf8')) as SimSpec[])
  : [
      {
        key: String(args.key),
        lat: args.lat ? Number(args.lat) : undefined,
        lon: args.lon ? Number(args.lon) : undefined,
        alt: args.alt ? Number(args.alt) : undefined,
        name: args.name ? String(args.name) : undefined,
        video: args['no-video'] !== true,
        adsb: args.adsb === true,
        payload: args.payload === true,
        imbalance: args.imbalance ? Number(args.imbalance) : 0,
      },
    ];

// One imagery cache for all simulated drones.
const imagery = typeof args.imagery === 'string' ? new GroundImagery(urlTileSource(args.imagery)) : null;

const clients = specs.map((s, i) => {
  const drone = new VirtualDrone({
    home: { lat: s.lat ?? 47.3977 + i * 0.002, lon: s.lon ?? 8.5456 + i * 0.002 },
    groundAltMsl: s.alt ?? 488,
    motorImbalance: s.imbalance ?? 0,
    serial: `SIM-${String(i + 1).padStart(4, '0')}`,
  });
  const label = s.name ?? `drone-${i + 1}`;
  const client = new LinkClient({
    url,
    key: s.key,
    drone,
    video: s.video !== false,
    imagery,
    onboardAi: !!imagery,
    adsb: s.adsb,
    payload: s.payload,
    log: (m) => console.log(`[${label}] ${m}`),
  });
  client.start();
  return client;
});

const stop = async () => {
  await Promise.all(clients.map((c) => c.stop()));
  process.exit(0);
};
process.on('SIGINT', () => void stop());
process.on('SIGTERM', () => void stop());
