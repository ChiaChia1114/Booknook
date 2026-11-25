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
 *
 * An authority is known by its address (`id`), not by its display name: renaming it keeps the
 * open exchanges. Submissions are idempotent (the request's reference is the key), so a
 * submission whose answer was lost can be sent again without leaving a second plan behind; a
 * plan whose submission got no answer is found by its reference when it must be withdrawn.
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
  /** Stable identity of the authority (its address): requests are followed by it, whatever its display name. */
  readonly id: string;
  readonly name: string;
  /** Where it is reached (scheme, host, port), for display. */
  readonly origin: string | null;
  /** Submits a plan; submitting the same reference again returns the plan the authority already has. */
  submit(plan: FlightPlanSubmission): Promise<AuthorityDecision>;
  get(id: string): Promise<AuthorityDecision>;
  /** The authority's plans with this reference (to find a plan whose submission got no answer). */
  find(reference: string): Promise<AuthorityDecision[]>;
  /**
   * Withdraws every plan with this reference, also one the authority makes later from a submission
   * still under way (the reference stays withdrawn). Resolves false when the authority does not
   * support it.
   */
  cancelByReference(reference: string): Promise<boolean>;
  /** Withdraws a flight plan; resolves when it is gone (also when the authority no longer knows it). */
  cancel(id: string): Promise<void>;
}

/** The identity of an authority reached at `url`: scheme, host, port and path (no credentials, query or fragment). */
export function authorityId(url: string): string {
  const u = new URL(url);
  return `${u.protocol}//${u.host.toLowerCase()}${u.pathname.replace(/\/+$/, '')}`;
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
  readonly id: string;
  readonly name: string;
  readonly origin: string | null;
  private readonly base: string;

  constructor(private readonly opts: HttpAuthorityOptions) {
    this.id = authorityId(opts.url);
    this.name = opts.name;
    this.base = opts.url.replace(/\/+$/, '');
    this.origin = feedOrigin(opts.url);
  }

  private async call(method: 'GET' | 'POST' | 'DELETE', path: string, body?: unknown, extra: Record<string, string> = {}): Promise<{ status: number; json: unknown }> {
    const f = this.opts.fetchImpl ?? fetch;
    const headers: Record<string, string> = { accept: 'application/json', ...extra };
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
    // The reference makes the submission idempotent: sent again (an answer was lost), it returns the same plan.
    const r = await this.call('POST', '/flight-plans', plan, { 'idempotency-key': plan.reference });
    if (r.status === 404) throw new AuthorityError('HTTP 404 – is the authority address right?');
    return decisionOf(r.json);
  }

  async find(reference: string): Promise<AuthorityDecision[]> {
    const r = await this.call('GET', `/flight-plans?reference=${encodeURIComponent(reference)}`);
    if (r.status === 404) return [];
    if (!Array.isArray(r.json)) throw new AuthorityError('answer is not a JSON array');
    return r.json.slice(0, 20).map((x) => decisionOf(x));
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

  async cancelByReference(reference: string): Promise<boolean> {
    try {
      const r = await this.call('DELETE', `/flight-plans?reference=${encodeURIComponent(reference)}`);
      return r.status !== 404;
    } catch (err) {
      // Not part of what this authority speaks: plans are found and withdrawn one by one instead.
      if (err instanceof AuthorityError && /^HTTP (405|501)\b/.test(err.message)) return false;
      throw err;
    }
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

/** Open exchanges followed at the same time during a poll. */
const POLL_CONCURRENCY = 8;
/** Open exchanges read from the database at a time during a poll. */
const POLL_PAGE = 200;

/** Keeps a request's exchange with the external authority going: submit, follow, withdraw. */
export class AuthorityService {
  private timer: ReturnType<typeof setInterval> | null = null;
  private polling = false;
  /** Per organisation: when its exchanges last reached the authority, and the last error they met. */
  private readonly contacts = new Map<string, { lastContactAt: string | null; lastError: string | null }>();
  /** Requests whose exchange is under way (one call at a time per request). */
  private readonly busy = new Set<string>();
  /**
   * Requests changed here while their call was under way (cancelled during a submission): followed
   * up as soon as that call ends. Only such changes – a poll reaching a busy request leaves it to
   * the next poll, so a slow authority gets no more calls than the poll's pace and limit allow.
   */
  private readonly again = new Set<string>();
  /** Exchanges under way, awaited when the service stops (the database closes after it). */
  private readonly inFlight = new Set<Promise<void>>();
  private stopped = false;
  /** The authority answered that it cannot withdraw by reference: plans are looked up instead (not asked again). */
  private noReferenceCancel = false;

  constructor(
    private readonly deps: AuthorityServiceDeps,
    readonly authority: FlightAuthority | null,
    private readonly pollMs = 15_000,
    /** Delay of the first poll after start (exchanges left open by the last run). */
    private readonly firstPollMs = 1_000,
  ) {}

  get configured(): boolean {
    return this.authority !== null;
  }

  /** Whether the configured authority decides this request (requests of a former one fall back to the organisation). */
  decides(r: { authority_id?: string | null } | null | undefined): boolean {
    return !!r?.authority_id && r.authority_id === this.authority?.id;
  }

  /** The authority as an organisation sees it: its own waiting requests and its own exchanges' last contact and error. */
  status(orgId: string): FlightAuthorityStatusDto {
    const a = this.authority;
    const pending = a ? (this.deps.db.get<{ n: number }>("SELECT COUNT(*) AS n FROM authorizations WHERE org_id = ? AND authority_id = ? AND status = 'pending'", orgId, a.id)?.n ?? 0) : 0;
    const c = this.contacts.get(orgId);
    return { configured: !!a, name: a?.name ?? null, origin: a?.origin ?? null, lastContactAt: c?.lastContactAt ?? null, lastError: c?.lastError ?? null, pending };
  }

  start(): void {
    if (!this.authority || this.timer) return;
    const db = this.deps.db;
    // Requests of the release before authorities were known by their address: theirs was the name.
    // That release did not record whether a submission went out: one still being submitted (or
    // withdrawn) may have reached the authority, so it is withdrawn by its reference if cancelled.
    db.run("UPDATE authorizations SET authority_sent = 1 WHERE authority_id IS NULL AND authority = ? AND authority_state IN ('submitting', 'cancelling')", this.authority.name);
    db.run('UPDATE authorizations SET authority_id = ? WHERE authority_id IS NULL AND authority = ?', this.authority.id, this.authority.name);
    // Open exchanges keep following the authority under its current display name.
    db.run("UPDATE authorizations SET authority = ? WHERE authority_id = ? AND authority_state IS NOT NULL AND authority_state != 'closed' AND authority != ?", this.authority.name, this.authority.id, this.authority.name);
    this.timer = setInterval(() => void this.poll(), this.pollMs);
    this.timer.unref?.();
    // Exchanges left open by the last run are taken up at once, not a whole interval later.
    const first = setTimeout(() => void this.poll(), this.firstPollMs);
    first.unref?.();
  }

  /** Stops following the exchanges; resolves once the calls under way have finished. */
  async stop(): Promise<void> {
    this.stopped = true;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    await Promise.allSettled([...this.inFlight]);
  }

  private contact(orgId: string, err: unknown): void {
    const c = this.contacts.get(orgId) ?? { lastContactAt: null, lastError: null };
    if (err) c.lastError = `${nowIso()}: ${(err as Error).message}`.slice(0, 400);
    else {
      c.lastContactAt = nowIso();
      c.lastError = null;
    }
    this.contacts.set(orgId, c);
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

  /**
   * Advances one request's exchange with the authority (never throws). `changed`: the request was
   * just changed here (e.g. cancelled) – if a call is under way, the exchange is taken up again as
   * soon as it ends rather than at the next poll.
   */
  sync(authId: string, changed = false): Promise<void> {
    if (!this.authority || this.stopped) return Promise.resolve();
    if (this.busy.has(authId)) {
      if (changed) this.again.add(authId);
      return Promise.resolve();
    }
    const p = this.syncOnce(authId, this.authority).catch((err) => this.deps.log.warn({ err, authId }, 'flight authority exchange failed'));
    this.inFlight.add(p);
    void p.finally(() => this.inFlight.delete(p));
    return p;
  }

  private async syncOnce(authId: string, authority: FlightAuthority): Promise<void> {
    this.busy.add(authId);
    try {
      const r = this.row(authId);
      if (!r || !this.decides(r)) return;
      const state = r.authority_state as AuthorityState | null;
      // The state this exchange has left the request in (its steps move it along): the error of a
      // failed step is recorded only if nothing else changed the request meanwhile.
      let step: AuthorityState | null = state;
      const set = (to: AuthorityState) => {
        this.setState(r.id, to, null);
        step = to;
      };
      try {
        if (state === 'submitting') {
          if (r.status !== 'pending') {
            // Cancelled before an answer came: a plan the authority may have received is withdrawn.
            set(r.authority_sent ? 'cancelling' : 'closed');
            await this.withdraw(authId);
            return;
          }
          if (Date.parse(r.end_at) <= Date.now()) {
            step = this.expire(r, `No answer from ${authority.name} before the window ended`, r.authority_sent ? 'cancelling' : 'closed');
            await this.withdraw(authId);
            return;
          }
          this.deps.db.run('UPDATE authorizations SET authority_sent = 1 WHERE id = ?', r.id);
          const d = await authority.submit(this.plan(r));
          this.contact(r.org_id, null);
          step = this.decide(this.row(authId), d, 'submitted') ?? step;
          await this.withdraw(authId);
        } else if (state === 'submitted') {
          if (r.status === 'cancelled' || r.status === 'rejected') {
            set('cancelling');
            await this.withdraw(authId);
            return;
          }
          if (Date.parse(r.end_at) <= Date.now()) {
            if (r.status === 'pending') {
              step = this.expire(r, `No decision from ${authority.name} before the window ended`, 'cancelling');
              await this.withdraw(authId);
            } else set('closed');
            return;
          }
          const d = await authority.get(r.authority_ref);
          this.contact(r.org_id, null);
          step = this.decide(this.row(authId), d, 'submitted') ?? step;
          // An approval that cannot be used here (or one cancelled meanwhile) is withdrawn there at once.
          await this.withdraw(authId);
        } else if (state === 'cancelling') {
          await this.withdraw(authId);
        }
      } catch (err) {
        this.contact(r.org_id, err);
        // Only on the step that failed: a request cancelled during its submission does not take on
        // that submission's error (its withdrawal follows); a withdrawal that failed after a
        // submission or a check in this same exchange does record its error.
        this.deps.db.run('UPDATE authorizations SET authority_error = ? WHERE id = ? AND authority_state IS ?', (err as Error).message.slice(0, 300), authId, step);
      }
    } finally {
      this.busy.delete(authId);
      if (this.again.delete(authId) && !this.stopped) void this.sync(authId);
    }
  }

  /** Withdraws the request's flight plan at the authority (state 'cancelling' → 'closed'). */
  private async withdraw(authId: string): Promise<void> {
    const r = this.row(authId);
    if (!r || r.authority_state !== 'cancelling' || !this.authority) return;
    try {
      if (r.authority_ref) await this.authority.cancel(r.authority_ref);
      else if (r.authority_sent) {
        // A submission whose answer was lost: the authority may make (or have made) a plan from it.
        // Withdrawn by its reference – a plan it makes later from that submission is withdrawn too.
        const byReference = !this.noReferenceCancel && (await this.authority.cancelByReference(r.reference));
        if (!byReference) {
          this.noReferenceCancel = true;
          // Without that: the plan with the reference is withdrawn once found (submissions are
          // idempotent: there is at most one), and looked for until the window ends – a slow
          // authority may make it after the first look.
          const found = await this.authority.find(r.reference);
          for (const p of found) if (p.status === 'pending' || p.status === 'approved') await this.authority.cancel(p.id);
          if (found.length === 0 && Date.parse(r.end_at) > Date.now()) {
            this.contact(r.org_id, null);
            // Still looking: the error of the lost answer is no longer the news.
            this.deps.db.run('UPDATE authorizations SET authority_error = NULL WHERE id = ?', r.id);
            return;
          }
        }
      }
      this.contact(r.org_id, null);
      this.setState(r.id, 'closed', null);
    } catch (err) {
      this.contact(r.org_id, err);
      // Withdrawals left undone for a day after the window are given up (the plan has expired there too).
      if (Date.parse(r.end_at) + 86_400_000 <= Date.now()) this.setState(r.id, 'closed', `Could not withdraw the flight plan: ${(err as Error).message}`.slice(0, 300));
      else throw err;
    }
  }

  /**
   * A pending request the authority did not decide in time: rejected here. Returns the exchange's
   * state (`closed` when nothing reached the authority: the error of the last attempt goes with it –
   * the reason says that no answer came).
   */
  private expire(r: any, reason: string, state: AuthorityState): AuthorityState {
    const db = this.deps.db;
    const changed = db.tx(() => {
      const ok = db.run("UPDATE authorizations SET status = 'rejected', decision_reason = ?, decided_at = ?, authority_state = ? WHERE id = ? AND status = 'pending'", reason, nowIso(), state, r.id).changes > 0;
      if (!ok) db.run('UPDATE authorizations SET authority_state = ? WHERE id = ?', state, r.id);
      if (state === 'closed') db.run('UPDATE authorizations SET authority_error = NULL WHERE id = ?', r.id);
      return ok;
    });
    if (changed) this.deps.onChange({ orgId: r.org_id, authId: r.id, from: 'pending', to: 'rejected', requestedBy: r.requested_by, droneId: r.drone_id, reference: r.reference, reason });
    return state;
  }

  private setState(authId: string, state: AuthorityState, error: string | null): void {
    this.deps.db.run('UPDATE authorizations SET authority_state = ?, authority_error = ? WHERE id = ?', state, error, authId);
  }

  /** Applies the authority's view of a request; returns the exchange's state after it (null: no request). */
  private decide(r: any, d: AuthorityDecision, nextState: AuthorityState): AuthorityState | null {
    if (!r) return null;
    const name = this.authority!.name;
    const db = this.deps.db;
    let change: AuthorityChange | null = null;
    let after: AuthorityState | null = null;
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
          db.run('UPDATE authorizations SET decision_reason = ? WHERE id = ?', `Awaiting the flight authority's decision (${d.reason})`.slice(0, 1000), cur.id);
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
      after = state;
      if (status !== cur.status) {
        const after = db.get<any>('SELECT decision_reason, cancel_reason FROM authorizations WHERE id = ?', cur.id);
        change = { orgId: cur.org_id, authId: cur.id, from: cur.status, to: status, requestedBy: cur.requested_by, droneId: cur.drone_id, reference: cur.reference, reason: status === 'cancelled' ? after?.cancel_reason : after?.decision_reason };
      }
    });
    if (change) this.deps.onChange(change);
    return after;
  }

  /**
   * Follows every open exchange once – of every organisation, however many: read a page at a
   * time (oldest first), a few calls to the authority at a time.
   */
  async poll(): Promise<void> {
    const authority = this.authority;
    if (!authority || this.polling || this.stopped) return;
    this.polling = true;
    try {
      let after = { created: '', id: '' };
      for (;;) {
        const rows = this.deps.db.all<{ id: string; created_at: string }>(
          `SELECT id, created_at FROM authorizations
            WHERE authority_id = ? AND authority_state IN ('submitting', 'submitted', 'cancelling') AND (created_at > ? OR (created_at = ? AND id > ?))
            ORDER BY created_at, id LIMIT ?`,
          authority.id,
          after.created,
          after.created,
          after.id,
          POLL_PAGE,
        );
        for (let i = 0; i < rows.length && !this.stopped; i += POLL_CONCURRENCY) await Promise.all(rows.slice(i, i + POLL_CONCURRENCY).map((r) => this.sync(r.id)));
        if (rows.length < POLL_PAGE || this.stopped) break;
        const last = rows[rows.length - 1]!;
        after = { created: last.created_at, id: last.id };
      }
    } finally {
      this.polling = false;
    }
  }
}
