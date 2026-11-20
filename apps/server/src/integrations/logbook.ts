/**
 * External flight-logbook export (Sky-Drones offers a DroneLogbook integration).
 * The connector POSTs a JSON flight record (summary + CSV track) to a configured
 * endpoint with the customer's API key. Provider "dronelogbook" uses the same
 * transport; a provider-specific mapping can be added without changing callers.
 */
import type { LogbookIntegrationDto } from '@athena-sky/shared';
import type { Db } from '../db/database';
import { parseJson } from '../db/database';
import { decryptSecret, encryptSecret } from '../lib/crypto';
import { badRequest } from '../lib/errors';
import { assertPublicTarget, validateOutboundUrl } from '../lib/net';
import { nowIso } from '../lib/util';
import { getFlight, loadEvents, loadSamples } from '../flights/flight-service';
import { toCsv } from '../flights/export';

interface LogbookConfig {
  enabled: boolean;
  provider: string;
  endpointUrl: string;
  autoExport: boolean;
}

interface Logger {
  warn(obj: unknown, msg?: string): void;
}

export class LogbookExporter {
  constructor(
    private readonly db: Db,
    private readonly secretKey: Buffer,
    private readonly log: Logger,
    private readonly allowPrivateTargets: boolean,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  private row(orgId: string) {
    return this.db.get<{ config: string; secret: string | null; last_export_at: string | null; last_status: string | null }>(
      "SELECT config, secret, last_export_at, last_status FROM integrations WHERE org_id = ? AND kind = 'logbook'",
      orgId,
    );
  }

  get(orgId: string): LogbookIntegrationDto {
    const r = this.row(orgId);
    const c = parseJson<Partial<LogbookConfig>>(r?.config, {});
    return {
      enabled: c.enabled === true,
      provider: c.provider ?? 'dronelogbook',
      endpointUrl: c.endpointUrl ?? '',
      autoExport: c.autoExport === true,
      hasApiKey: !!r?.secret,
      lastExportAt: r?.last_export_at ?? null,
      lastStatus: r?.last_status ?? null,
    };
  }

  set(orgId: string, input: { enabled: boolean; provider: string; endpointUrl: string; autoExport: boolean; apiKey?: string | null }): LogbookIntegrationDto {
    if (input.enabled) validateOutboundUrl(input.endpointUrl);
    const cfg: LogbookConfig = { enabled: input.enabled, provider: input.provider, endpointUrl: input.endpointUrl, autoExport: input.autoExport };
    const existing = this.row(orgId);
    const secret = input.apiKey === undefined ? (existing?.secret ?? null) : input.apiKey ? encryptSecret(this.secretKey, input.apiKey) : null;
    this.db.run(
      `INSERT INTO integrations (org_id, kind, config, secret) VALUES (?, 'logbook', ?, ?)
       ON CONFLICT (org_id, kind) DO UPDATE SET config = excluded.config, secret = excluded.secret`,
      orgId,
      JSON.stringify(cfg),
      secret,
    );
    return this.get(orgId);
  }

  /** Exports one flight. Returns the HTTP status (or throws on configuration errors). */
  async exportFlight(orgId: string, flightId: string): Promise<{ ok: boolean; status: number | null; message: string }> {
    const cfg = this.get(orgId);
    if (!cfg.enabled || !cfg.endpointUrl) throw badRequest('Logbook integration is not enabled');
    const flight = getFlight(this.db, orgId, flightId);
    if (!flight) throw badRequest('Flight not found');
    if (flight.status === 'in_progress') throw badRequest('Flight is still in progress');
    const r = this.row(orgId);
    const apiKey = r?.secret ? decryptSecret(this.secretKey, r.secret) : null;
    const samples = loadSamples(this.db, flightId);
    const body = JSON.stringify({
      source: 'Athena-sky',
      provider: cfg.provider,
      flight: {
        id: flight.id,
        drone: flight.droneName,
        pilot: flight.pilotName,
        takeoffTime: flight.startedAt,
        landingTime: flight.endedAt,
        durationS: Math.round(flight.durationS),
        distanceM: Math.round(flight.distanceM),
        maxAltitudeM: Math.round(flight.maxAltM * 10) / 10,
        takeoff: flight.startLat !== null ? { lat: flight.startLat, lon: flight.startLon } : null,
        landing: flight.endLat !== null ? { lat: flight.endLat, lon: flight.endLon } : null,
        batteryStartPct: flight.batteryStartPct,
        batteryEndPct: flight.batteryEndPct,
      },
      events: loadEvents(this.db, flightId),
      trackCsv: toCsv(samples),
    });
    let status: number | null = null;
    let message = 'ok';
    try {
      const url = validateOutboundUrl(cfg.endpointUrl);
      await assertPublicTarget(url, this.allowPrivateTargets);
      const res = await this.fetchImpl(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'user-agent': 'Athena-sky-Logbook/1.0', ...(apiKey ? { authorization: `Bearer ${apiKey}` } : {}) },
        body,
        redirect: 'manual',
        signal: AbortSignal.timeout(20_000),
      });
      status = res.status;
      await res.body?.cancel().catch(() => undefined);
      if (!res.ok) message = `HTTP ${res.status}`;
    } catch (err) {
      message = err instanceof Error ? err.message : String(err);
    }
    const ok = status !== null && status >= 200 && status < 300;
    this.db.run(
      "UPDATE integrations SET last_export_at = ?, last_status = ? WHERE org_id = ? AND kind = 'logbook'",
      nowIso(),
      ok ? `exported ${flightId}` : `failed: ${message}`,
      orgId,
    );
    if (!ok) this.log.warn({ orgId, flightId, message }, 'logbook export failed');
    return { ok, status, message };
  }

  /** Auto-export hook called when a flight is closed. */
  onFlightClosed(orgId: string, flightId: string): void {
    const cfg = this.get(orgId);
    if (cfg.enabled && cfg.autoExport) void this.exportFlight(orgId, flightId).catch(() => undefined);
  }
}
