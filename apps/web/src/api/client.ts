/** Thin fetch wrapper for the Athena-sky REST API (cookie session + CSRF double-submit). */

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly details?: unknown,
  ) {
    super(message);
  }
}

function csrfToken(): string {
  const m = /(?:^|;\s*)athena_csrf=([^;]+)/.exec(document.cookie);
  return m ? decodeURIComponent(m[1]!) : '';
}

type Query = Record<string, string | number | boolean | null | undefined>;

export function withQuery(path: string, query?: Query): string {
  if (!query) return path;
  const q = Object.entries(query).filter(([, v]) => v !== undefined && v !== null && v !== '');
  if (q.length === 0) return path;
  return `${path}?${new URLSearchParams(q.map(([k, v]) => [k, String(v)])).toString()}`;
}

let onUnauthorized: (() => void) | null = null;
export function setUnauthorizedHandler(fn: () => void): void {
  onUnauthorized = fn;
}

async function handle<T>(res: Response): Promise<T> {
  if (res.status === 204) return undefined as T;
  const type = res.headers.get('content-type') ?? '';
  const body = type.includes('application/json') ? await res.json().catch(() => null) : await res.text();
  if (!res.ok) {
    if (res.status === 401) onUnauthorized?.();
    const b = (body && typeof body === 'object' ? body : {}) as { error?: string; message?: string; details?: unknown };
    throw new ApiError(res.status, b.error ?? 'error', b.message ?? (typeof body === 'string' && body ? body : res.statusText), b.details);
  }
  return body as T;
}

export async function api<T = unknown>(path: string, opts: { method?: string; body?: unknown; query?: Query; signal?: AbortSignal } = {}): Promise<T> {
  const method = opts.method ?? (opts.body === undefined ? 'GET' : 'POST');
  const headers: Record<string, string> = { accept: 'application/json' };
  if (opts.body !== undefined) headers['content-type'] = 'application/json';
  if (method !== 'GET' && method !== 'HEAD') headers['x-csrf-token'] = csrfToken();
  const res = await fetch(withQuery(path, opts.query), {
    method,
    headers,
    credentials: 'same-origin',
    body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
    signal: opts.signal,
  });
  return handle<T>(res);
}

export async function upload<T = unknown>(path: string, form: FormData): Promise<T> {
  const res = await fetch(path, { method: 'POST', body: form, credentials: 'same-origin', headers: { 'x-csrf-token': csrfToken() } });
  return handle<T>(res);
}

/** Triggers a browser download of an API resource. */
export function download(path: string): void {
  const a = document.createElement('a');
  a.href = path;
  a.rel = 'noopener';
  document.body.appendChild(a);
  a.click();
  a.remove();
}

export function errorMessage(err: unknown): string {
  if (err instanceof ApiError) return err.message;
  if (err instanceof Error) return err.message;
  return String(err);
}
