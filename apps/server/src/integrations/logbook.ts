/**
 * External flight-logbook export (Sky-Drones offers a DroneLogbook integration).
 * The exporter handles configuration, the encrypted API key, SSRF-safe delivery, status
 * tracking and auto-export; the request format comes from a pluggable LogbookProvider
 * (see logbook-providers.ts).
 */
import type { LogbookIntegrationDto } from '@athena-sky/shared';
import type { Db } from '../db/database';
import { parseJson } from '../db/database';
import { decryptSecret, encryptSecret } from '../lib/crypto';
import { badRequest } from '../lib/errors';
import { assertPublicTarget, checkOutboundTarget, safeFetch, validateOutboundUrl } from '../lib/net';
import { nowIso } from '../lib/util';
import { getFlight, loadEvents, loadSampleSpreadAsync } from '../flights/flight-service';
import { toCsv } from '../flights/export';
import { logbookProvider, normaliseProviderId, type LogbookFlightRecord } from './logbook-providers';

/** Most track points sent to a logbook (a long flight's track is evenly thinned). */
export const LOGBOOK_TRACK_POINTS = 10_000;

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
    fetchImpl?: typeof fetch,
  ) {
    this.fetchImpl = fetchImpl ?? safeFetch(allowPrivateTargets);
  }

  private readonly fetchImpl: typeof fetch;

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
      provider: normaliseProviderId(c.provider),
      endpointUrl: c.endpointUrl ?? '',
      autoExport: c.autoExport === true,
      hasApiKey: !!r?.secret,
      lastExportAt: r?.last_export_at ?? null,
      lastStatus: r?.last_status ?? null,
    };
  }

  async set(orgId: string, input: { enabled: boolean; provider: string; endpointUrl: string; autoExport: boolean; apiKey?: string | null }): Promise<LogbookIntegrationDto> {
    if (input.enabled) await checkOutboundTarget(validateOutboundUrl(input.endpointUrl), this.allowPrivateTargets);
    const provider = logbookProvider(input.provider).id;
    const cfg: LogbookConfig = { enabled: input.enabled, provider, endpointUrl: input.endpointUrl, autoExport: input.autoExport };
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
    if (flight.status === 'processing') throw badRequest('The log of this flight is still being imported');
    const r = this.row(orgId);
    const apiKey = r?.secret ? decryptSecret(this.secretKey, r.secret) : null;
    // The track at up to LOGBOOK_TRACK_POINTS points, evenly spread (read without stalling the server).
    const samples = await loadSampleSpreadAsync(this.db, flightId, LOGBOOK_TRACK_POINTS);
    const record: LogbookFlightRecord = {
      source: 'Athena-sky',
      flight: {
        id: flight.id,
        drone: flight.droneName,
        pilot: flight.pilotName,
        takeoffTime: flight.startedAt,
        landingTime: flight.endedAt,
        durationS: Math.round(flight.durationS),
        distanceM: Math.round(flight.distanceM),
        maxAltitudeM: Math.round(flight.maxAltM * 10) / 10,
        takeoff: flight.startLat !== null && flight.startLon !== null ? { lat: flight.startLat, lon: flight.startLon } : null,
        landing: flight.endLat !== null && flight.endLon !== null ? { lat: flight.endLat, lon: flight.endLon } : null,
        batteryStartPct: flight.batteryStartPct,
        batteryEndPct: flight.batteryEndPct,
      },
      events: loadEvents(this.db, flightId),
      trackCsv: toCsv(samples),
    };
    const request = logbookProvider(cfg.provider).buildRequest(record, apiKey);
    let status: number | null = null;
    let message = 'ok';
    try {
      const url = validateOutboundUrl(cfg.endpointUrl);
      await assertPublicTarget(url, this.allowPrivateTargets);
      const res = await this.fetchImpl(url, {
        method: 'POST',
        headers: { 'user-agent': 'Athena-sky-Logbook/1.0', ...request.headers },
        body: request.body,
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
