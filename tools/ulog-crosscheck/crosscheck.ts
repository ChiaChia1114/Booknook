/**
 * ULog cross-validation against pyulog, PX4's reference ULog implementation.
 *
 *   1. The simulator's onboard logger writes a complete flight (.ulg).
 *   2. pyulog reads that file (proving the writer emits valid ULog) and writes it back out
 *      with pyulog's own writer.
 *   3. Athena-sky's parser reads both files; every topic sample, field value, logged message,
 *      parameter and info entry must equal pyulog's reading, and the normalised flights
 *      (what the cloud stores) must be identical.
 *
 * Run: pip install pyulog && npm run verify:ulog   (PYTHON=/path/to/python to pick an interpreter)
 */
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { destinationPoint, newItemId, type MissionPlan } from '@athena-sky/shared';
import { simulateMission } from '@athena-sky/simulator';
import { parseULog, type ULogFile } from '../../apps/server/src/flights/ulog';
import { normalizeLog } from '../../apps/server/src/flights/ingest';

interface Dump {
  info: Record<string, string | number>;
  params: Record<string, number | null>;
  messages: { t: number; level: number; text: string }[];
  dropouts: { t: number; durationMs: number }[];
  topics: { name: string; multiId: number; fields: Record<string, (number | null)[]> }[];
}

const here = dirname(fileURLToPath(import.meta.url));
const python = process.env.PYTHON ?? 'python3';
const failures: string[] = [];
const fail = (msg: string) => failures.length < 50 && failures.push(msg);
const same = (a: number | null | undefined, b: number | null | undefined) => (a === null || Number.isNaN(a) ? b === null || Number.isNaN(b as number) : a === b);

function compare(label: string, ours: ULogFile, ref: Dump): { topics: number; values: number } {
  let values = 0;
  const refKeys = ref.topics.map((t) => `${t.name}#${t.multiId}`).sort();
  const ourKeys = ours.topics.filter((t) => t.samples > 0).map((t) => `${t.name}#${t.multiId}`).sort();
  if (refKeys.join() !== ourKeys.join()) fail(`${label}: topic set differs\n  pyulog: ${refKeys.join(', ')}\n  athena: ${ourKeys.join(', ')}`);
  for (const rt of ref.topics) {
    const ot = ours.topics.find((t) => t.name === rt.name && t.multiId === rt.multiId);
    if (!ot) continue;
    const refTs = rt.fields.timestamp ?? [];
    if (ot.samples !== refTs.length) fail(`${label}: ${rt.name} has ${ot.samples} samples, pyulog ${refTs.length}`);
    refTs.forEach((t, i) => same(ot.timestamps[i], t) || fail(`${label}: ${rt.name} timestamp[${i}] ${ot.timestamps[i]} != ${t}`));
    const refFields = Object.keys(rt.fields).filter((f) => f !== 'timestamp').sort();
    const ourFields = Object.keys(ot.data).filter((f) => f !== 'timestamp').sort();
    if (refFields.join() !== ourFields.join()) fail(`${label}: ${rt.name} fields differ\n  pyulog: ${refFields.join(',')}\n  athena: ${ourFields.join(',')}`);
    for (const f of refFields) {
      const a = ot.data[f];
      const b = rt.fields[f]!;
      if (!a) continue;
      b.forEach((v, i) => {
        values++;
        if (!same(a[i], v)) fail(`${label}: ${rt.name}.${f}[${i}] ${a[i]} != ${v}`);
      });
    }
  }
  if (ours.messages.length !== ref.messages.length) fail(`${label}: ${ours.messages.length} logged messages, pyulog ${ref.messages.length}`);
  ref.messages.forEach((m, i) => {
    const o = ours.messages[i];
    const level = m.level >= 48 ? m.level - 48 : m.level;
    if (!o || o.t !== m.t || o.level !== level || o.text !== m.text) fail(`${label}: message[${i}] ${JSON.stringify(o)} != ${JSON.stringify({ ...m, level })}`);
  });
  for (const [k, v] of Object.entries(ref.params)) if (!same(ours.params[k], v)) fail(`${label}: param ${k} ${ours.params[k]} != ${v}`);
  if (Object.keys(ours.params).length !== Object.keys(ref.params).length) fail(`${label}: parameter count differs`);
  for (const [k, v] of Object.entries(ref.info)) if (String(ours.info[k]) !== String(v)) fail(`${label}: info ${k} ${ours.info[k]} != ${v}`);
  if (ours.dropouts.length !== ref.dropouts.length) fail(`${label}: dropout count differs`);
  return { topics: ref.topics.length, values };
}

const dir = mkdtempSync(join(tmpdir(), 'athena-ulog-xcheck-'));
try {
  const home = { lat: 25.0732, lon: 121.5355 };
  const plan: MissionPlan = {
    home: { ...home, alt: 8 },
    items: [
      { id: newItemId(), type: 'takeoff', alt: 40 },
      { id: newItemId(), type: 'waypoint', ...destinationPoint(home, 45, 500), alt: 60 },
      { id: newItemId(), type: 'waypoint', ...destinationPoint(home, 135, 500), alt: 50 },
      { id: newItemId(), type: 'rtl' },
    ],
    rallyPoints: [],
    geofence: null,
    defaultSpeed: 10,
    defaultAlt: 40,
  };
  const sim = simulateMission(plan, { home, startTime: Date.UTC(2026, 0, 15, 2, 0, 0), ulog: true, drone: { groundAltMsl: 8, seed: 42 } });
  const simPath = join(dir, 'sim.ulg');
  const dumpPath = join(dir, 'pyulog.json');
  const rewrittenPath = join(dir, 'pyulog-rewritten.ulg');
  writeFileSync(simPath, sim.ulog!);

  try {
    execFileSync(python, ['-I', join(here, 'pyulog_dump.py'), simPath, dumpPath, '--rewrite', rewrittenPath], { stdio: ['ignore', 'inherit', 'inherit'] });
  } catch (err) {
    console.error(`\npyulog step failed – install it with "pip install pyulog" (interpreter: ${python}).`);
    throw err;
  }
  const ref = JSON.parse(readFileSync(dumpPath, 'utf8')) as Dump;
  const all = { include: () => true };
  const simParsed = parseULog(sim.ulog!, all);
  const rewritten = readFileSync(rewrittenPath);
  const rewrittenParsed = parseULog(rewritten, all);
  const a = compare('simulator log', simParsed, ref);
  const b = compare('pyulog-written log', rewrittenParsed, ref);

  // The flight the cloud stores must not depend on which writer produced the file.
  const n1 = normalizeLog(sim.ulog!, 'sim.ulg', 0);
  const n2 = normalizeLog(rewritten, 'rewritten.ulg', 0);
  if (JSON.stringify(n1.samples) !== JSON.stringify(n2.samples)) fail('normalised samples differ between the simulator and the pyulog-written file');
  if (JSON.stringify(n1.events) !== JSON.stringify(n2.events)) fail('normalised events differ between the simulator and the pyulog-written file');
  if (n1.samples.length < 100) fail(`normalised flight is too short (${n1.samples.length} samples)`);

  if (failures.length > 0) {
    console.error(`ULog cross-check FAILED (${failures.length} difference(s)):\n- ${failures.join('\n- ')}`);
    process.exitCode = 1;
  } else {
    console.log(
      `ULog cross-check PASSED: ${a.topics} topics / ${a.values} values / ${ref.messages.length} messages / ${Object.keys(ref.params).length} params identical to pyulog ` +
        `for the simulator log and the pyulog-written log (${b.values} values); ${n1.samples.length} normalised samples identical.`,
    );
  }
} finally {
  rmSync(dir, { recursive: true, force: true });
}
