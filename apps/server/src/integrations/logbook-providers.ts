/**
 * Logbook connector formats.
 *
 * A {@link LogbookProvider} turns a completed flight into the HTTP request a logbook service
 * expects. The exporter (manual export, auto-export, status tracking, SSRF-safe transport) is
 * shared; supporting another logbook API means adding a provider to {@link LOGBOOK_PROVIDERS}.
 *
 * Two generic formats are built in. DroneLogbook (the partner Sky-Drones integrates with) does
 * not publish its import API, so no DroneLogbook-specific mapping is shipped: point the
 * connector at an endpoint that accepts one of these formats, or add a provider.
 */
import { randomBytes } from 'node:crypto';
import type { LogbookProviderDto } from '@athena-sky/shared';
import { badRequest } from '../lib/errors';

export interface LogbookFlightRecord {
  source: 'Athena-sky';
  flight: {
    id: string;
    drone: string | null;
    pilot: string | null;
    takeoffTime: string;
    landingTime: string | null;
    durationS: number;
    distanceM: number;
    maxAltitudeM: number;
    takeoff: { lat: number; lon: number } | null;
    landing: { lat: number; lon: number } | null;
    batteryStartPct: number | null;
    batteryEndPct: number | null;
  };
  events: unknown[];
  /** Telemetry track as CSV (see flights/export.ts for the columns). */
  trackCsv: string;
}

export interface LogbookRequest {
  headers: Record<string, string>;
  body: string | Uint8Array;
}

export interface LogbookProvider extends LogbookProviderDto {
  buildRequest(record: LogbookFlightRecord, apiKey: string | null): LogbookRequest;
}

const bearer = (apiKey: string | null): Record<string, string> => (apiKey ? { authorization: `Bearer ${apiKey}` } : {});

/** Encodes text parts as multipart/form-data (RFC 7578). Names and filenames are generated, never user input. */
export function encodeMultipart(parts: { name: string; filename?: string; contentType?: string; data: string }[]): { body: Uint8Array; contentType: string } {
  const boundary = `----AthenaSky${randomBytes(12).toString('hex')}`;
  const chunks: Buffer[] = [];
  for (const p of parts) {
    const disposition = `form-data; name="${p.name}"${p.filename ? `; filename="${p.filename}"` : ''}`;
    chunks.push(Buffer.from(`--${boundary}\r\nContent-Disposition: ${disposition}\r\n${p.contentType ? `Content-Type: ${p.contentType}\r\n` : ''}\r\n`));
    chunks.push(Buffer.from(p.data, 'utf8'), Buffer.from('\r\n'));
  }
  chunks.push(Buffer.from(`--${boundary}--\r\n`));
  return { body: new Uint8Array(Buffer.concat(chunks)), contentType: `multipart/form-data; boundary=${boundary}` };
}

const jsonRecord: LogbookProvider = {
  id: 'json',
  label: 'JSON flight record',
  description: 'POST application/json with the flight summary, events and the CSV track; API key sent as a Bearer token.',
  buildRequest: (record, apiKey) => ({
    headers: { 'content-type': 'application/json', ...bearer(apiKey) },
    body: JSON.stringify({ ...record, provider: 'json' }),
  }),
};

const csvUpload: LogbookProvider = {
  id: 'csv-upload',
  label: 'Log-file upload (multipart CSV)',
  description: 'POST multipart/form-data like a "import from log file" form: part "file" = the CSV track, parts "flight" and "events" = JSON; API key sent as a Bearer token.',
  buildRequest: (record, apiKey) => {
    const mp = encodeMultipart([
      { name: 'file', filename: `athena-flight-${record.flight.id}.csv`, contentType: 'text/csv', data: record.trackCsv },
      { name: 'flight', contentType: 'application/json', data: JSON.stringify(record.flight) },
      { name: 'events', contentType: 'application/json', data: JSON.stringify(record.events) },
      { name: 'source', data: record.source },
    ]);
    return { headers: { 'content-type': mp.contentType, ...bearer(apiKey) }, body: mp.body };
  },
};

export const LOGBOOK_PROVIDERS: readonly LogbookProvider[] = [jsonRecord, csvUpload];

/** Provider ids stored by earlier versions, mapped to the current format. */
const LEGACY_IDS: Record<string, string> = { dronelogbook: 'json', generic: 'json' };

export function normaliseProviderId(id: string | undefined | null): string {
  const v = id ?? 'json';
  return LEGACY_IDS[v] ?? v;
}

export function logbookProvider(id: string | undefined | null): LogbookProvider {
  const norm = normaliseProviderId(id);
  const p = LOGBOOK_PROVIDERS.find((x) => x.id === norm);
  if (!p) throw badRequest(`Unknown logbook provider "${id}". Available: ${LOGBOOK_PROVIDERS.map((x) => x.id).join(', ')}`);
  return p;
}

export function logbookProviderDtos(): LogbookProviderDto[] {
  return LOGBOOK_PROVIDERS.map(({ id, label, description }) => ({ id, label, description }));
}
