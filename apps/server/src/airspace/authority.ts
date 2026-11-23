/**
 * External flight authorities (UTM services such as Altitude Angel, AirMap or High Lander).
 *
 * Without one, Athena-sky decides authorisation requests itself: clear volumes are approved at
 * once, volumes in controlled airspace wait for the organisation's mission manager, and
 * approved public reservations appear on this server's drone safety map.
 *
 * With an authority configured (`ATHENA_UTM_AUTHORITY_URL`), every request that passes the
 * local checks is submitted to it as a flight plan and stays pending until the authority
 * decides; its decision (and a later withdrawal) is applied here, a cancellation is passed on,
 * and the authority's own public page of the reservation (e.g. its drone safety map) is linked.
 * The exchange is the HTTP/JSON protocol of docs/UTM_AUTHORITY.md, spoken by
 * {@link HttpFlightAuthority}; another service is connected by implementing
 * {@link FlightAuthority} (or by a small bridge speaking the protocol).
 */
import type { AuthGeometry, FlightAuthorityStatusDto } from '@athena-sky/shared';
import { bufferPolyline, circlePolygon } from '@athena-sky/shared';
import type { Db } from '../db/database';
import { parseJson } from '../db/database';
import { nowIso } from '../lib/util';
import { AUTH_SELECT } from './airspace-service';
import { authShape } from './geometry';
import { checkOrgVolume } from './mission-check';
import type { AirspaceService } from './providers';
import { feedOrigin } from './providers';

export type AuthorityStatus = 'approved' | 'pending' | 'rejected' | 'cancelled';

/** The authority's view of a flight plan. */
export interface AuthorityDecision {
  /** The authority's identifier of the flight plan. */
  id: string;
  status: AuthorityStatus;
  reason: string | null;
  /** The authority's public page of the reservation (its drone safety map), if any. */
  publicUrl: string | null;
}

/** A flight plan as submitted (see docs/UTM_AUTHORITY.md). */
export interface FlightPlanSubmission {
  reference: string;
  operator: { organisation: string; requestedBy: string | null };
  drone: { name: string; serial: string | null } | null;
  volume: AuthGeometry;
  /** The volume's outline as a GeoJSON polygon feature (lon, lat order). */
  geojson: { type: 'Feature'; geometry: { type: 'Polygon'; coordinates: number[][][] }; properties: { reference: string } };
  minAltM: number;
  maxAltM: number;
  /** Heights are above the take-off point. */
  altitudeReference: 'takeoff';
  startAt: string;
  endAt: string;
  public: boolean;
}

export interface FlightAuthority {
  readonly name: string;
  /** Where it is reached (scheme, host, port), for display. */
  readonly origin: string | null;
  submit(plan: FlightPlanSubmission): Promise<AuthorityDecision>;
  get(id: string): Promise<AuthorityDecision>;
  /** Withdraws a flight plan; resolves when it is gone (also when the authority no longer knows it). */
  cancel(id: string): Promise<void>;
}

/** Longest time an authority may take to answer one call. */
export const AUTHORITY_TIMEOUT_MS = 10_000;
/** Largest answer read from an authority. */
const MAX_ANSWER_BYTES = 65_536;
const STATUSES = new Set<AuthorityStatus>(['approved', 'pending', 'rejected', 'cancelled']);

export class AuthorityError extends Error {}

/** A link the web app may show: http(s) only, of bounded length. */
function safeLink(v: unknown): string | null {
  if (typeof v !== 'string' || v.length > 1000) return null;
  try {
    const u = new URL(v);
    return u.protocol === 'https:' || u.protocol === 'http:' ? u.toString() : null;
  } catch {
    return null;
  }
}

/** Reads an authority's answer about a flight plan, refusing anything malformed. */
export function decisionOf(body: unknown, knownId?: string): AuthorityDecision {
  const b = body as Record<string, unknown> | null;
  if (!b || typeof b !== 'object') throw new AuthorityError('answer is not a JSON object');
  const id = typeof b.id === 'string' && b.id.length > 0 && b.id.length <= 200 ? b.id : (knownId ?? null);
  if (!id) throw new AuthorityError('answer has no flight plan id');
  let status = typeof b.status === 'string' ? b.status.toLowerCase() : '';
  // Common synonyms of the services' own vocabularies.
  if (status === 'accepted' || status === 'authorised' || status === 'authorized') status = 'approved';
  else if (status === 'denied' || status === 'declined') status = 'rejected';
  else if (status === 'withdrawn' || status === 'revoked' || status === 'closed') status = 'cancelled';
  else if (status === 'submitted' || status === 'received' || status === 'in_review') status = 'pending';
  if (!STATUSES.has(status as AuthorityStatus)) throw new AuthorityError(`unknown status "${String(b.status).slice(0, 40)}"`);
  const reason = typeof b.reason === 'string' && b.reason.trim() ? b.reason.trim().slice(0, 500) : null;
  return { id, status: status as AuthorityStatus, reason, publicUrl: safeLink(b.publicUrl) };
}

export interface HttpAuthorityOptions {
  name: string;
  url: string;
  /** Sent as `Authorization: Bearer <key>`. */
  key?: string | null;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}

/** An authority reached over the HTTP/JSON protocol of docs/UTM_AUTHORITY.md. */
export class HttpFlightAuthority implements FlightAuthority {
  readonly name: string;
  readonly origin: string | null;
  private readonly base: string;

  constructor(private readonly opts: HttpAuthorityOptions) {
    this.name = opts.name;
    this.base = opts.url.replace(/\/+$/, '');
    this.origin = feedOrigin(opts.url);
  }

  private async call(method: 'GET' | 'POST' | 'DELETE', path: string, body?: unknown): Promise<{ status: number; json: unknown }> {
    const f = this.opts.fetchImpl ?? fetch;
    const headers: Record<string, string> = { accept: 'application/json' };
    if (body !== undefined) headers['content-type'] = 'application/json';
    if (this.opts.key) headers.authorization = `Bearer ${this.opts.key}`;
    let res: Response;
    try {
      res = await f(`${this.base}${path}`, {
        method,
        headers,
        body: body === undefined ? undefined : JSON.stringify(body),
        redirect: 'error',
        signal: AbortSignal.timeout(this.opts.timeoutMs ?? AUTHORITY_TIMEOUT_MS),
      });
    } catch (err) {
      const e = err as Error;
      throw new AuthorityError(e.name === 'TimeoutError' ? 'no answer in time' : `unreachable (${e.message.slice(0, 120)})`);
    }
    const text = await readAnswer(res);
    if (res.status === 404) return { status: 404, json: null };
    if (!res.ok) throw new AuthorityError(`HTTP ${res.status}${text ? `: ${text.slice(0, 200)}` : ''}`);
    if (!text) return { status: res.status, json: null };
    try {
      return { status: res.status, json: JSON.parse(text) };
    } catch {
      throw new AuthorityError('answer is not JSON');
    }
  }

  async submit(plan: FlightPlanSubmission): Promise<AuthorityDecision> {
    const r = await this.call('POST', '/flight-plans', plan);
    if (r.status === 404) throw new AuthorityError('HTTP 404 – is the authority address right?');
    return decisionOf(r.json);
  }

  async get(id: string): Promise<AuthorityDecision> {
    const r = await this.call('GET', `/flight-plans/${encodeURIComponent(id)}`);
    // An authority that no longer knows the plan has not got it on its map either.
    if (r.status === 404) return { id, status: 'cancelled', reason: 'The authority no longer has this flight plan', publicUrl: null };
    return decisionOf(r.json, id);
  }

  async cancel(id: string): Promise<void> {
    await this.call('DELETE', `/flight-plans/${encodeURIComponent(id)}`);
  }
}

async function readAnswer(res: Response): Promise<string> {
  const reader = res.body?.getReader();
  if (!reader) return '';
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > MAX_ANSWER_BYTES) {
      await reader.cancel().catch(() => undefined);
      throw new AuthorityError(`answer is larger than ${MAX_ANSWER_BYTES} bytes`);
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString('utf8');
}

/** The volume of a request as a closed GeoJSON ring (lon, lat). */
export function volumeRing(g: AuthGeometry): number[][] {
  const outline = g.kind === 'cylinder' ? circlePolygon(g.center, g.radiusM, 64) : bufferPolyline(g.line, g.widthM / 2);
  const ring = outline.map((p) => [Math.round(p.lon * 1e7) / 1e7, Math.round(p.lat * 1e7) / 1e7]);
  if (ring.length) ring.push([...ring[0]!]);
  return ring;
}

export type AuthorityState = 'submitting' | 'submitted' | 'cancelling' | 'closed';

export interface AuthorityChange {
  orgId: string;
  authId: string;
  /** The request's status before and after. */
  from: string;
  to: string;
  requestedBy: string | null;
  droneId: string | null;
  reference: string;
  reason: string | null;
}

interface Logger {
  warn(obj: unknown, msg?: string): void;
}

export interface AuthorityServiceDeps {
  db: Db;
  airspace: AirspaceService;
  log: Logger;
  /** Called after a request's status changed because of the authority. */
  onChange(change: AuthorityChange): void;
}

/** Keeps a request's exchange with the external authority going: submit, follow, withdraw. */
export class AuthorityService {
  private timer: ReturnType<typeof setInterval> | null = null;
  private polling = false;
  private lastContactAt: string | null = null;
  private lastError: string | null = null;
  /** Requests whose exchange is under way (one call at a time per request). */
  private readonly busy = new Set<string>();

  constructor(
    private readonly deps: AuthorityServiceDeps,
    readonly authority: FlightAuthority | null,
    private readonly pollMs = 15_000,
  ) {}

  get configured(): boolean {
    return this.authority !== null;
  }

  /** Whether `name` is the authority deciding requests now (requests of a former one fall back to the organisation). */
  decides(name: string | null): boolean {
    return !!name && this.authority?.name === name;
  }

  status(): FlightAuthorityStatusDto {
    const pending = this.authority
      ? (this.deps.db.get<{ n: number }>("SELECT COUNT(*) AS n FROM authorizations WHERE authority = ? AND status = 'pending'", this.authority.name)?.n ?? 0)
      : 0;
    return { configured: this.configured, name: this.authority?.name ?? null, origin: this.authority?.origin ?? null, lastContactAt: this.lastContactAt, lastError: this.lastError, pending };
  }

  start(): void {
    if (!this.authority || this.timer) return;
    this.timer = setInterval(() => void this.poll(), this.pollMs);
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  private contact(err: unknown): void {
    if (err) this.lastError = `${nowIso()}: ${(err as Error).message}`;
    else {
      this.lastContactAt = nowIso();
      this.lastError = null;
    }
  }

  private plan(r: any): FlightPlanSubmission {
    const geometry = parseJson<AuthGeometry>(r.geometry, { kind: 'cylinder', center: { lat: 0, lon: 0 }, radiusM: 0 });
    return {
      reference: r.reference,
      operator: { organisation: r.org_name, requestedBy: r.requester_name ?? null },
      drone: r.drone_name ? { name: r.drone_name, serial: r.drone_serial ?? null } : null,
      volume: geometry,
      geojson: { type: 'Feature', geometry: { type: 'Polygon', coordinates: [volumeRing(geometry)] }, properties: { reference: r.reference } },
      minAltM: 0,
      maxAltM: r.max_alt_m,
      altitudeReference: 'takeoff',
      startAt: r.start_at,
      endAt: r.end_at,
      public: r.is_public === 1,
    };
  }

  private row(authId: string): any {
    return this.deps.db.get<any>(`SELECT a.*, d.serial AS drone_serial FROM (${AUTH_SELECT} WHERE a.id = ?) a LEFT JOIN drones d ON d.id = a.drone_id`, authId);
  }

  /** Advances one request's exchange with the authority (never throws). */
  async sync(authId: string): Promise<void> {
    const authority = this.authority;
    if (!authority || this.busy.has(authId)) return;
    this.busy.add(authId);
    try {
      const r = this.row(authId);
      if (!r || !this.decides(r.authority)) return;
      const state = r.authority_state as AuthorityState | null;
      try {
        if (state === 'submitting') {
          if (r.status !== 'pending') {
            // Cancelled before it reached the authority: nothing to withdraw there.
            this.setState(r.id, 'closed', null);
            return;
          }
          if (Date.parse(r.end_at) <= Date.now()) {
            this.expire(r, `No answer from ${authority.name} before the window ended`, 'closed');
            return;
          }
          const d = await authority.submit(this.plan(r));
          this.contact(null);
          this.decide(this.row(authId), d, 'submitted');
          await this.withdraw(authId);
        } else if (state === 'submitted') {
          if (r.status === 'cancelled' || r.status === 'rejected') {
            this.setState(r.id, 'cancelling', null);
            await this.withdraw(authId);
            return;
          }
          if (Date.parse(r.end_at) <= Date.now()) {
            if (r.status === 'pending') {
              this.expire(r, `No decision from ${authority.name} before the window ended`, 'cancelling');
              await this.withdraw(authId);
            } else this.setState(r.id, 'closed', null);
            return;
          }
          const d = await authority.get(r.authority_ref);
          this.contact(null);
          this.decide(this.row(authId), d, 'submitted');
          // An approval that cannot be used here (or one cancelled meanwhile) is withdrawn there at once.
          await this.withdraw(authId);
        } else if (state === 'cancelling') {
          await this.withdraw(authId);
        }
      } catch (err) {
        this.contact(err);
        this.deps.db.run('UPDATE authorizations SET authority_error = ? WHERE id = ?', (err as Error).message.slice(0, 300), authId);
      }
    } finally {
      this.busy.delete(authId);
    }
  }

  /** Withdraws the request's flight plan at the authority (state 'cancelling' → 'closed'). */
  private async withdraw(authId: string): Promise<void> {
    const r = this.row(authId);
    if (!r || r.authority_state !== 'cancelling' || !this.authority) return;
    if (!r.authority_ref) {
      this.setState(r.id, 'closed', null);
      return;
    }
    // Withdrawals left undone for a day after the window are given up (the plan has expired there too).
    try {
      await this.authority.cancel(r.authority_ref);
      this.contact(null);
      this.setState(r.id, 'closed', null);
    } catch (err) {
      this.contact(err);
      if (Date.parse(r.end_at) + 86_400_000 <= Date.now()) this.setState(r.id, 'closed', `Could not withdraw the flight plan: ${(err as Error).message}`.slice(0, 300));
      else throw err;
    }
  }

  /** A pending request the authority did not decide in time: rejected here. */
  private expire(r: any, reason: string, state: AuthorityState): void {
    const db = this.deps.db;
    const changed = db.tx(() => {
      const ok = db.run("UPDATE authorizations SET status = 'rejected', decision_reason = ?, decided_at = ?, authority_state = ? WHERE id = ? AND status = 'pending'", reason, nowIso(), state, r.id).changes > 0;
      if (!ok) db.run('UPDATE authorizations SET authority_state = ? WHERE id = ?', state, r.id);
      return ok;
    });
    if (changed) this.deps.onChange({ orgId: r.org_id, authId: r.id, from: 'pending', to: 'rejected', requestedBy: r.requested_by, droneId: r.drone_id, reference: r.reference, reason });
  }

  private setState(authId: string, state: AuthorityState, error: string | null): void {
    this.deps.db.run('UPDATE authorizations SET authority_state = ?, authority_error = ? WHERE id = ?', state, error, authId);
  }

  /** Applies the authority's view of a request. */
  private decide(r: any, d: AuthorityDecision, nextState: AuthorityState): void {
    if (!r) return;
    const name = this.authority!.name;
    const db = this.deps.db;
    let change: AuthorityChange | null = null;
    db.tx(() => {
      const cur = db.get<any>('SELECT * FROM authorizations WHERE id = ?', r.id);
      if (!cur) return;
      const at = nowIso();
      let state: AuthorityState = nextState;
      let status = cur.status as string;
      if (cur.status === 'pending') {
        if (d.status === 'approved') {
          // The airspace may have been reserved by another operator (or restricted) since the
          // request was made: such an approval cannot be used.
          const geometry = parseJson<AuthGeometry>(cur.geometry, { kind: 'cylinder', center: { lat: 0, lon: 0 }, radiusM: 0 });
          const clash = checkOrgVolume(db, this.deps.airspace, cur.org_id, authShape(geometry), 0, cur.max_alt_m, { from: Date.parse(cur.start_at), to: Date.parse(cur.end_at) }, { droneId: cur.drone_id, excludeReservationId: cur.id }).filter((c) => c.severity === 'blocking');
          if (Date.parse(cur.end_at) <= Date.now() || clash.length > 0) {
            status = 'rejected';
            state = 'cancelling';
            const why = clash.length > 0 ? clash[0]!.message : 'the requested window has ended';
            db.run("UPDATE authorizations SET status = 'rejected', decision_reason = ?, decided_at = ? WHERE id = ?", `Approved by ${name}, but ${why}`.slice(0, 1000), at, cur.id);
          } else {
            status = 'approved';
            db.run("UPDATE authorizations SET status = 'approved', decision_reason = ?, decided_at = ?, approved_at = ? WHERE id = ?", (d.reason ? `Approved by ${name}: ${d.reason}` : `Approved by ${name}`).slice(0, 1000), at, at, cur.id);
          }
        } else if (d.status === 'rejected' || d.status === 'cancelled') {
          status = 'rejected';
          state = 'closed';
          db.run("UPDATE authorizations SET status = 'rejected', decision_reason = ?, decided_at = ? WHERE id = ?", (d.reason ? `Rejected by ${name}: ${d.reason}` : `Rejected by ${name}`).slice(0, 1000), at, cur.id);
        } else if (d.reason) {
          db.run('UPDATE authorizations SET decision_reason = ? WHERE id = ?', `Submitted to ${name} – awaiting its decision (${d.reason})`.slice(0, 1000), cur.id);
        }
      } else if (cur.status === 'approved') {
        if (d.status === 'rejected' || d.status === 'cancelled') {
          // Withdrawn by the authority: the approval is kept (flights before stay covered).
          status = 'cancelled';
          state = 'closed';
          db.run("UPDATE authorizations SET status = 'cancelled', cancelled_at = ?, cancelled_by = NULL, cancel_reason = ? WHERE id = ?", at, (d.reason ? `Withdrawn by ${name}: ${d.reason}` : `Withdrawn by ${name}`).slice(0, 1000), cur.id);
        }
      } else if (d.status !== 'rejected' && d.status !== 'cancelled') {
        // Cancelled here meanwhile: the plan is withdrawn there too.
        state = 'cancelling';
      } else state = 'closed';
      db.run('UPDATE authorizations SET authority_ref = COALESCE(?, authority_ref), authority_url = COALESCE(?, authority_url), authority_state = ?, authority_error = NULL WHERE id = ?', d.id || null, d.publicUrl, state, cur.id);
      if (status !== cur.status) {
        const after = db.get<any>('SELECT decision_reason, cancel_reason FROM authorizations WHERE id = ?', cur.id);
        change = { orgId: cur.org_id, authId: cur.id, from: cur.status, to: status, requestedBy: cur.requested_by, droneId: cur.drone_id, reference: cur.reference, reason: status === 'cancelled' ? after?.cancel_reason : after?.decision_reason };
      }
    });
    if (change) this.deps.onChange(change);
  }

  /** Follows every open exchange once. */
  async poll(): Promise<void> {
    if (!this.authority || this.polling) return;
    this.polling = true;
    try {
      const rows = this.deps.db.all<{ id: string }>(
        "SELECT id FROM authorizations WHERE authority = ? AND authority_state IN ('submitting', 'submitted', 'cancelling') ORDER BY created_at LIMIT 200",
        this.authority.name,
      );
      for (const r of rows) await this.sync(r.id);
    } finally {
      this.polling = false;
    }
  }
}
