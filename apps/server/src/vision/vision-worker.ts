/** Worker thread running the detector off the real-time event loop. */
import { parentPort } from 'node:worker_threads';
import { ConvNet } from '@athena-sky/shared';
import { analyzeFrame, loadDetectorModel } from './analyze';

const spec = loadDetectorModel();
const net = spec ? new ConvNet(spec) : null;

parentPort!.on('message', (m: { id: number; jpeg: Uint8Array; threshold: number }) => {
  if (!net) return parentPort!.postMessage({ id: m.id, error: 'no detector model' });
  try {
    parentPort!.postMessage({ id: m.id, result: analyzeFrame(net, m.jpeg, m.threshold) });
  } catch (err) {
    parentPort!.postMessage({ id: m.id, error: (err as Error).message });
  }
});
