/**
 * Reference flight authority: a small UTM service speaking the protocol of
 * docs/UTM_AUTHORITY.md, for tests, demonstrations and as a template for bridges to real
 * services (Altitude Angel, AirMap, High Lander …).
 *
 *  - `POST /flight-plans`, `GET /flight-plans/:id`, `DELETE /flight-plans/:id` – the protocol;
 *  - `GET /` – a console listing the plans, where an operator approves or rejects pending ones
 *    (`POST /flight-plans/:id/decision` with `{"status": "approved" | "rejected" | "cancelled", "reason"}`);
 *  - `GET /map` – the public "drone safety map": approved public plans.
 */
import { randomBytes } from 'node:crypto';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';

export type MockAuthorityStatus = 'approved' | 'pending' | 'rejected' | 'cancelled';

export interface MockFlightPlan {
  id: string;
  status: MockAuthorityStatus;
  reason: string | null;
  receivedAt: string;
  /** The plan as submitted. */
  plan: Record<string, any>;
}

export interface MockAuthorityOptions {
  port?: number;
  host?: string;
  /** Bearer key the protocol endpoints require (none: open). */
  key?: string | null;
  /**
   * Decision on a new plan. Default: approved, unless it reaches above 120 m (rejected) –
   * `'review'` keeps every plan pending for the console.
   */
  decide?: 'approve' | 'review' | 'reject' | ((plan: Record<string, any>) => { status: MockAuthorityStatus; reason?: string });
}

export interface MockAuthority {
  url: string;
  plans: Map<string, MockFlightPlan>;
  /** Decides a plan as the authority's operator would. */
  setStatus(id: string, status: MockAuthorityStatus, reason?: string): void;
  /** Answers every protocol call with this HTTP status (e.g. 503) until called with null. */
  failWith(status: number | null): void;
  close(): Promise<void>;
}

const esc = (s: unknown) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);

async function body(req: IncomingMessage, max = 1_048_576): Promise<string> {
  const chunks: Buffer[] = [];
  let n = 0;
  for await (const c of req) {
    n += (c as Buffer).length;
    if (n > max) throw new Error('too large');
    chunks.push(c as Buffer);
  }
  return Buffer.concat(chunks).toString('utf8');
}

function defaultDecision(mode: MockAuthorityOptions['decide'], plan: Record<string, any>): { status: MockAuthorityStatus; reason?: string } {
  if (typeof mode === 'function') return mode(plan);
  if (mode === 'review') return { status: 'pending', reason: 'Queued for review by the authority' };
  if (mode === 'reject') return { status: 'rejected', reason: 'Not permitted in this area' };
  if (Number(plan.maxAltM) > 120) return { status: 'rejected', reason: 'Above the 120 m limit of the open category' };
  return { status: 'approved', reason: 'No conflicting operations' };
}

export async function startMockAuthority(opts: MockAuthorityOptions = {}): Promise<MockAuthority> {
  const plans = new Map<string, MockFlightPlan>();
  let failStatus: number | null = null;
  let base = '';
  const view = (p: MockFlightPlan) => ({ id: p.id, status: p.status, reason: p.reason, publicUrl: p.status === 'approved' && p.plan.public ? `${base}/map#${p.id}` : null });
  const send = (res: ServerResponse, status: number, data?: unknown, type = 'application/json') => {
    res.writeHead(status, { 'content-type': type });
    res.end(data === undefined ? undefined : type === 'application/json' ? JSON.stringify(data) : String(data));
  };

  const server = createServer(async (req, res) => {
    try {
      const url = new URL(req.url ?? '/', 'http://x');
      const path = url.pathname.replace(/\/+$/, '') || '/';
      const m = /^\/flight-plans(?:\/([^/]+))?(\/decision)?$/.exec(path);
      if (m && !m[2]) {
        if (failStatus) return send(res, failStatus, { error: 'unavailable' });
        if (opts.key && req.headers.authorization !== `Bearer ${opts.key}`) return send(res, 401, { error: 'unauthorised' });
        if (!m[1] && req.method === 'POST') {
          let plan: Record<string, any>;
          try {
            plan = JSON.parse(await body(req));
          } catch {
            return send(res, 400, { error: 'invalid JSON' });
          }
          if (!plan || typeof plan.reference !== 'string' || !plan.volume || !plan.startAt || !plan.endAt || typeof plan.maxAltM !== 'number') {
            return send(res, 400, { error: 'reference, volume, startAt, endAt and maxAltM are required' });
          }
          const d = defaultDecision(opts.decide, plan);
          const p: MockFlightPlan = { id: `FP-${randomBytes(4).toString('hex').toUpperCase()}`, status: d.status, reason: d.reason ?? null, receivedAt: new Date().toISOString(), plan };
          plans.set(p.id, p);
          return send(res, 201, view(p));
        }
        if (!m[1] && req.method === 'GET') return send(res, 200, [...plans.values()].map(view));
        const p = m[1] ? plans.get(decodeURIComponent(m[1])) : undefined;
        if (!p) return send(res, 404, { error: 'unknown flight plan' });
        if (req.method === 'GET') return send(res, 200, view(p));
        if (req.method === 'DELETE') {
          if (p.status === 'pending' || p.status === 'approved') {
            p.status = 'cancelled';
            p.reason = 'Withdrawn by the operator';
          }
          return send(res, 204);
        }
        return send(res, 405, { error: 'method not allowed' });
      }
      if (m && m[2] && req.method === 'POST') {
        const p = plans.get(decodeURIComponent(m[1]!));
        if (!p) return send(res, 404, { error: 'unknown flight plan' });
        const raw = await body(req, 10_000);
        const form = (req.headers['content-type'] ?? '').includes('application/x-www-form-urlencoded');
        const d = form ? Object.fromEntries(new URLSearchParams(raw)) : (JSON.parse(raw || '{}') as Record<string, string>);
        if (!['approved', 'rejected', 'cancelled'].includes(d.status ?? '')) return send(res, 400, { error: 'status must be approved, rejected or cancelled' });
        p.status = d.status as MockAuthorityStatus;
        p.reason = d.reason?.slice(0, 300) || null;
        if (form) {
          res.writeHead(303, { location: '/' });
          return res.end();
        }
        return send(res, 200, view(p));
      }
      if (req.method === 'GET' && (path === '/' || path === '/map')) {
        const map = path === '/map';
        const list = [...plans.values()].filter((p) => !map || (p.status === 'approved' && p.plan.public));
        const rows = list
          .map((p) => {
            const v = p.plan.volume ?? {};
            const where = v.kind === 'cylinder' ? `cylinder r ${esc(v.radiusM)} m at ${esc(v.center?.lat)}, ${esc(v.center?.lon)}` : `corridor ${esc(v.widthM)} m wide, ${esc(v.line?.length)} points`;
            const actions =
              !map && p.status === 'pending'
                ? `<form method="post" action="/flight-plans/${esc(p.id)}/decision" style="display:inline"><input type="hidden" name="status" value="approved"><button>Approve</button></form>
                   <form method="post" action="/flight-plans/${esc(p.id)}/decision" style="display:inline"><input type="hidden" name="status" value="rejected"><input name="reason" placeholder="reason"><button>Reject</button></form>`
                : '';
            return `<tr id="${esc(p.id)}"><td>${esc(p.id)}</td><td>${esc(p.plan.reference)}</td><td>${esc(p.plan.operator?.organisation)}</td><td>${where}, up to ${esc(p.plan.maxAltM)} m</td><td>${esc(p.plan.startAt)} – ${esc(p.plan.endAt)}</td><td>${esc(p.status)}${p.reason ? ` (${esc(p.reason)})` : ''}</td><td>${actions}</td></tr>`;
          })
          .join('');
        return send(
          res,
          200,
          `<!doctype html><meta charset="utf-8"><title>${map ? 'Drone safety map' : 'Flight authority console'}</title><style>body{font:14px system-ui;margin:24px}td,th{border-bottom:1px solid #ddd;padding:6px;text-align:left}</style><h1>${map ? 'Drone safety map – approved operations' : 'Flight authority console'}</h1><table><tr><th>Plan</th><th>Operator reference</th><th>Operator</th><th>Volume</th><th>Window</th><th>Status</th><th></th></tr>${rows || '<tr><td colspan="7">None</td></tr>'}</table>`,
          'text/html; charset=utf-8',
        );
      }
      return send(res, 404, { error: 'not found' });
    } catch (err) {
      return send(res, 500, { error: (err as Error).message });
    }
  });
  await new Promise<void>((resolve) => server.listen(opts.port ?? 0, opts.host ?? '127.0.0.1', resolve));
  const addr = server.address() as AddressInfo;
  base = `http://${opts.host ?? '127.0.0.1'}:${addr.port}`;
  return {
    url: base,
    plans,
    setStatus(id, status, reason) {
      const p = plans.get(id);
      if (!p) throw new Error(`unknown flight plan ${id}`);
      p.status = status;
      p.reason = reason ?? null;
    },
    failWith(status) {
      failStatus = status;
    },
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections?.();
        server.close(() => resolve());
      }),
  };
}
