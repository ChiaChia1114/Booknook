/**
 * Worker thread running one demo drone – flight physics, camera rendering and JPEG encoding –
 * off the server's event loop, as a drone would on its own computer: rendering HD video in the
 * server's thread delayed the server's answers to every viewer and drone (commands too).
 * Camera imagery comes from the server's tile cache over the worker's message port.
 */
import { parentPort, workerData } from 'node:worker_threads';
import type { LatLon } from '@athena-sky/shared';
import { airframeById } from '@athena-sky/shared';
import { GroundImagery, LinkClient, VirtualDrone } from '@athena-sky/simulator';

export interface DemoWorkerData {
  linkUrl: string;
  key: string;
  name: string;
  home: LatLon;
  groundAltMsl: number;
  airframe: string;
  imbalance: number;
  serial: string;
  model: string;
  firmware: string;
  seed: number;
  adsb: boolean;
  payload: boolean;
  /** Whether the server has an imagery tile cache to film the real place from. */
  imagery: boolean;
}

export type DemoWorkerMessage =
  | { type: 'tile'; id: number; z: number; x: number; y: number }
  | { type: 'log'; msg: string }
  | { type: 'stopped' };

const port = parentPort!;
const d = workerData as DemoWorkerData;
const waiting = new Map<number, (tile: Uint8Array | null) => void>();
let nextId = 1;
const post = (m: DemoWorkerMessage) => port.postMessage(m);

const tile = (z: number, x: number, y: number) =>
  new Promise<Uint8Array | null>((resolve) => {
    const id = nextId++;
    waiting.set(id, resolve);
    post({ type: 'tile', id, z, x, y });
  });

const drone = new VirtualDrone({
  home: d.home,
  groundAltMsl: d.groundAltMsl,
  airframe: airframeById(d.airframe) ?? null,
  motorImbalance: d.imbalance,
  serial: d.serial,
  model: d.model,
  firmware: d.firmware,
  seed: d.seed,
});
// The virtual camera shows the real place and, like drones with an AI computer, detects people
// and vehicles on board; without imagery: the simulator's landscape, analysed in the cloud.
const client = new LinkClient({
  url: d.linkUrl,
  key: d.key,
  drone,
  video: true,
  imagery: d.imagery ? new GroundImagery(tile) : null,
  onboardAi: d.imagery,
  adsb: d.adsb,
  payload: d.payload,
  log: (msg) => post({ type: 'log', msg }),
});

port.on('message', (m: { type: 'tile'; id: number; data: Uint8Array | null } | { type: 'stop' }) => {
  if (m.type === 'tile') {
    waiting.get(m.id)?.(m.data);
    waiting.delete(m.id);
  } else if (m.type === 'stop') {
    void client.stop().finally(() => post({ type: 'stopped' }));
  }
});
client.start();
