/** The planning worker (see planner.ts): runs a computation of tasks.ts per message, one at a time. */
import { parentPort } from 'node:worker_threads';
import { TASKS, TaskError, type TaskName } from './tasks';

parentPort!.on('message', (m: { id: number; task: TaskName; input: unknown }) => {
  try {
    const run = TASKS[m.task] as (input: unknown) => unknown;
    parentPort!.postMessage({ id: m.id, result: run(m.input) });
  } catch (err) {
    // A request refused (TaskError, or HttpError of the modules it uses) is told as it is.
    const e = err as Error & { status?: unknown; code?: unknown };
    const told = e instanceof TaskError || (typeof e.status === 'number' && e.status < 500 && typeof e.code === 'string');
    parentPort!.postMessage({ id: m.id, error: { message: e.message, status: told ? (e.status as number) : 500, code: told ? (e.code as string) : 'internal_error' } });
  }
});
