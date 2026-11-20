import type { WebhookEvent } from '@athena-sky/shared';
import type { Db } from '../db/database';
import { parseJson } from '../db/database';
import { decryptSecret, hmacSha256Hex } from '../lib/crypto';
import { assertPublicTarget } from '../lib/net';
import { nowIso, uuid } from '../lib/util';

interface Logger {
  warn(obj: unknown, msg?: string): void;
  error(obj: unknown, msg?: string): void;
}

interface HookInfo {
  id: string;
  url: string;
  events: Set<string>;
  secret: string;
}

export interface WebhookOptions {
  allowPrivateTargets: boolean;
  /** Delays between retries (ms). Attempts = delays.length + 1. */
  retryDelaysMs?: number[];
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}

const DEFAULT_RETRIES = [10_000, 60_000, 300_000, 1_800_000, 7_200_000];
/** High-frequency events are delivered best-effort (no retries) and their logs are pruned quickly. */
const EPHEMERAL_EVENTS = new Set(['telemetry', 'payload.data']);

/**
 * Outbound webhooks ("stream telemetry and payload data directly to the customer's cloud").
 * Each delivery is signed: X-Athena-Signature = sha256=HMAC(secret, `${timestamp}.${body}`).
 */
export class WebhookDispatcher {
  private readonly cache = new Map<string, HookInfo[]>();
  private readonly timer: ReturnType<typeof setInterval>;
  private readonly inflight = new Set<string>();
  private lastCleanup = 0;
  private stopped = false;
  private readonly fetchImpl: typeof fetch;
  private readonly retries: number[];

  constructor(
    private readonly db: Db,
    private readonly secretKey: Buffer,
    private readonly log: Logger,
    private readonly opts: WebhookOptions,
  ) {
    this.fetchImpl = opts.fetchImpl ?? fetch;
    this.retries = opts.retryDelaysMs ?? DEFAULT_RETRIES;
    this.timer = setInterval(() => void this.processDue(), 2000);
    this.timer.unref?.();
  }

  invalidate(orgId: string): void {
    this.cache.delete(orgId);
  }

  private hooks(orgId: string): HookInfo[] {
    let hooks = this.cache.get(orgId);
    if (!hooks) {
      hooks = this.db
        .all<{ id: string; url: string; events: string; secret: string }>('SELECT id, url, events, secret FROM webhooks WHERE org_id = ? AND active = 1', orgId)
        .map((r) => {
          let secret = '';
          try {
            secret = decryptSecret(this.secretKey, r.secret);
          } catch (err) {
            this.log.error({ err, webhookId: r.id }, 'cannot decrypt webhook secret');
          }
          return { id: r.id, url: r.url, events: new Set(parseJson<string[]>(r.events, [])), secret };
        });
      this.cache.set(orgId, hooks);
    }
    return hooks;
  }

  /** Queues an event for every active webhook of the organisation subscribed to it. */
  emit(orgId: string, event: WebhookEvent, data: Record<string, unknown>): void {
    if (this.stopped) return;
    const targets = this.hooks(orgId).filter((h) => h.events.has(event));
    for (const h of targets) this.enqueue(orgId, h.id, event, data);
  }

  /** Sends a test delivery to one webhook (bypasses its event filter). */
  sendTest(orgId: string, webhookId: string): string {
    return this.enqueue(orgId, webhookId, 'ping', { message: 'Athena-sky webhook test' });
  }

  private enqueue(orgId: string, webhookId: string, event: string, data: Record<string, unknown>): string {
    const id = uuid();
    const createdAt = nowIso();
    const payload = JSON.stringify({ id, event, createdAt, organisationId: orgId, data });
    this.db.run(
      'INSERT INTO webhook_deliveries (id, webhook_id, event, payload, attempts, delivered, next_attempt_at, created_at) VALUES (?, ?, ?, ?, 0, 0, ?, ?)',
      id,
      webhookId,
      event,
      payload,
      createdAt,
      createdAt,
    );
    void this.attempt(id);
    return id;
  }

  private async attempt(deliveryId: string): Promise<void> {
    if (this.inflight.has(deliveryId) || this.stopped) return;
    this.inflight.add(deliveryId);
    try {
      const d = this.db.get<{ id: string; webhook_id: string; event: string; payload: string; attempts: number; delivered: number; org_id: string; url: string; active: number }>(
        `SELECT d.id, d.webhook_id, d.event, d.payload, d.attempts, d.delivered, w.org_id, w.url, w.active
           FROM webhook_deliveries d JOIN webhooks w ON w.id = d.webhook_id WHERE d.id = ?`,
        deliveryId,
      );
      if (!d || d.delivered || !d.active) return;
      const hook = this.hooks(d.org_id).find((h) => h.id === d.webhook_id);
      if (!hook) return;
      const attempts = d.attempts + 1;
      let status: number | null = null;
      let error: string | null = null;
      try {
        const url = new URL(d.url);
        await assertPublicTarget(url, this.opts.allowPrivateTargets);
        const ts = Math.floor(Date.now() / 1000).toString();
        const res = await this.fetchImpl(url, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            'user-agent': 'Athena-sky-Webhooks/1.0',
            'x-athena-event': d.event,
            'x-athena-delivery': d.id,
            'x-athena-timestamp': ts,
            'x-athena-signature': `sha256=${hmacSha256Hex(hook.secret, `${ts}.${d.payload}`)}`,
          },
          body: d.payload,
          redirect: 'manual',
          signal: AbortSignal.timeout(this.opts.timeoutMs ?? 10_000),
        });
        status = res.status;
        await res.body?.cancel().catch(() => undefined);
        if (status < 200 || status >= 300) error = `HTTP ${status}`;
      } catch (err) {
        error = err instanceof Error ? err.message : String(err);
      }
      const delivered = error === null;
      const ephemeral = EPHEMERAL_EVENTS.has(d.event);
      const delay = this.retries[attempts - 1];
      const next = delivered || ephemeral || delay === undefined ? null : new Date(Date.now() + delay).toISOString();
      this.db.run(
        'UPDATE webhook_deliveries SET attempts = ?, delivered = ?, status_code = ?, error = ?, next_attempt_at = ?, delivered_at = ? WHERE id = ?',
        attempts,
        delivered,
        status,
        error,
        next,
        delivered ? nowIso() : null,
        d.id,
      );
      this.db.run('UPDATE webhooks SET last_status = ?, last_delivery_at = ? WHERE id = ?', status ?? 0, nowIso(), d.webhook_id);
      if (!delivered && !ephemeral) this.log.warn({ webhookId: d.webhook_id, deliveryId: d.id, error, attempts }, 'webhook delivery failed');
    } finally {
      this.inflight.delete(deliveryId);
    }
  }

  /** Retries due deliveries and prunes old delivery logs. */
  async processDue(): Promise<void> {
    if (this.stopped) return;
    const due = this.db.all<{ id: string }>(
      'SELECT id FROM webhook_deliveries WHERE delivered = 0 AND next_attempt_at IS NOT NULL AND next_attempt_at <= ? ORDER BY next_attempt_at LIMIT 50',
      nowIso(),
    );
    await Promise.all(due.map((r) => this.attempt(r.id)));
    if (Date.now() - this.lastCleanup > 600_000) {
      this.lastCleanup = Date.now();
      const hourAgo = new Date(Date.now() - 3_600_000).toISOString();
      const weekAgo = new Date(Date.now() - 7 * 86_400_000).toISOString();
      this.db.run(`DELETE FROM webhook_deliveries WHERE event IN ('telemetry','payload.data') AND created_at < ?`, hourAgo);
      this.db.run('DELETE FROM webhook_deliveries WHERE created_at < ?', weekAgo);
    }
  }

  stop(): void {
    this.stopped = true;
    clearInterval(this.timer);
  }
}
