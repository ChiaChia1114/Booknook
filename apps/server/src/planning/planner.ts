/**
 * Planning computations off the event loop: generating waypoints, simulating a mission with an
 * airframe model, optimising a route (see tasks.ts) run in a worker thread of their own, one at a
 * time – a long one (hundreds of waypoints reordered, a survey of a large area) never holds up the
 * live connections or anyone's requests.
 *
 * Members in turn: the next computation is the next member's who has one waiting (round robin);
 * a member has at most `PER_OWNER` waiting or running (more are refused: 429); one that takes
 * longer than `TIMEOUT_MS` is stopped (503) – the worker is started again for the next.
 */
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { Worker } from 'node:worker_threads';
import type { FastifyBaseLogger } from 'fastify';
import { HttpError } from '../lib/errors';
import { ownerOfWork } from '../lib/turns';
import type { TaskInput, TaskName, TaskOutput } from './tasks';

/** Computations of one member waiting or running at once. */
export const PER_OWNER = 2;
/** The longest a computation may take (ms). */
export const TIMEOUT_MS = 20_000;

interface Job {
  id: number;
  owner: string;
  task: TaskName;
  input: unknown;
  resolve: (v: any) => void;
  reject: (e: Error) => void;
}

export class Planner {
  private worker: Worker | null = null;
  private running: { job: Job; timer: NodeJS.Timeout } | null = null;
  private readonly queues = new Map<string, Job[]>();
  private readonly counts = new Map<string, number>();
  /** When each member's computation last began (members in turn: the one served longest ago goes first). */
  private readonly served = new Map<string, number>();
  private serving = 0;
  private seq = 0;
  private closed = false;

  constructor(
    private readonly log: FastifyBaseLogger,
    private readonly timeoutMs = TIMEOUT_MS,
  ) {}

  /** Runs a computation of tasks.ts in the worker – of the member (or address) whose request it serves. */
  run<K extends TaskName>(task: K, input: TaskInput<K>, owner = ownerOfWork()): Promise<TaskOutput<K>> {
    if (this.closed) return Promise.reject(new HttpError(503, 'shutting_down', 'The server is shutting down'));
    const n = this.counts.get(owner) ?? 0;
    if (n >= PER_OWNER) {
      return Promise.reject(new HttpError(429, 'too_many_requests', 'Your plans are still being computed – try again once they are done'));
    }
    this.counts.set(owner, n + 1);
    return new Promise((resolve, reject) => {
      const job: Job = { id: ++this.seq, owner, task, input, resolve, reject };
      const q = this.queues.get(owner);
      if (q) q.push(job);
      else this.queues.set(owner, [job]);
      this.next();
    });
  }

  shutdown(): void {
    this.closed = true;
    if (this.running) clearTimeout(this.running.timer);
    void this.worker?.terminate();
    this.worker = null;
  }

  private done(job: Job): void {
    const n = (this.counts.get(job.owner) ?? 1) - 1;
    if (n > 0) this.counts.set(job.owner, n);
    else {
      this.counts.delete(job.owner);
      this.served.delete(job.owner);
    }
  }

  private next(): void {
    if (this.running || this.closed) return;
    // The member whose computation began longest ago (or never) goes first.
    let owner: string | undefined;
    for (const o of this.queues.keys()) if (owner === undefined || (this.served.get(o) ?? -1) < (this.served.get(owner) ?? -1)) owner = o;
    if (owner === undefined) return;
    const q = this.queues.get(owner)!;
    const job = q.shift()!;
    if (!q.length) this.queues.delete(owner);
    this.served.set(owner, ++this.serving);
    const worker = this.worker ?? this.start();
    const timer = setTimeout(() => this.timedOut(), this.timeoutMs);
    this.running = { job, timer };
    worker.postMessage({ id: job.id, task: job.task, input: job.input });
  }

  private start(): Worker {
    // Bundled build: dist/planning-worker.js next to dist/main.js; sources: the .ts file via tsx.
    const js = new URL('./planning-worker.js', import.meta.url);
    const url = existsSync(fileURLToPath(js)) ? js : new URL('./planning-worker.ts', import.meta.url);
    const w = new Worker(url, url.pathname.endsWith('.ts') ? { execArgv: ['--import', 'tsx'] } : {});
    w.unref();
    w.on('message', (m: { id: number; result?: unknown; error?: { message: string; status: number; code: string } }) => {
      const r = this.running;
      if (!r || r.job.id !== m.id) return;
      clearTimeout(r.timer);
      this.running = null;
      this.done(r.job);
      if (m.error) r.job.reject(new HttpError(m.error.status, m.error.code, m.error.status >= 500 ? 'The computation failed' : m.error.message));
      else r.job.resolve(m.result);
      this.next();
    });
    w.on('error', (err) => {
      this.log.error({ err }, 'planning worker failed');
      this.fail(new HttpError(500, 'internal_error', 'The computation failed'));
    });
    w.on('exit', () => {
      if (this.worker === w) this.worker = null;
    });
    this.worker = w;
    return w;
  }

  /** Took too long: stopped (the worker with it), the next one gets a new worker. */
  private timedOut(): void {
    this.fail(new HttpError(503, 'too_long', 'The computation took too long – plan fewer waypoints or a smaller area'));
  }

  private fail(err: HttpError): void {
    const r = this.running;
    const w = this.worker;
    this.worker = null;
    void w?.terminate();
    if (r) {
      clearTimeout(r.timer);
      this.running = null;
      this.done(r.job);
      r.job.reject(err);
    }
    this.next();
  }
}
