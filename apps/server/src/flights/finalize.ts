import type { AppContext } from '../context';
import { getFlight, runAnalysis, runCompliance } from './flight-service';

/**
 * Post-flight pipeline: AI analysis → compliance → webhooks → logbook auto-export.
 * Used for live flights (when the recorder closes them) and uploaded logs.
 */
export function finalizeFlight(ctx: Pick<AppContext, 'db' | 'webhooks' | 'logbook' | 'log'>, flightId: string): void {
  const analysis = runAnalysis(ctx.db, flightId);
  const compliance = runCompliance(ctx.db, flightId);
  const row = ctx.db.get<{ org_id: string }>('SELECT org_id FROM flights WHERE id = ?', flightId);
  if (!row) return;
  const flight = getFlight(ctx.db, row.org_id, flightId);
  if (!flight) return;
  ctx.webhooks.emit(row.org_id, 'flight.ended', { flight });
  if (analysis) {
    ctx.webhooks.emit(row.org_id, 'flight.analyzed', { flightId, droneId: flight.droneId, score: analysis.score, findings: analysis.findings, compliance });
    const serious = analysis.findings.filter((f) => f.severity === 'critical');
    if (serious.length > 0) {
      ctx.webhooks.emit(row.org_id, 'alert.raised', { flightId, droneId: flight.droneId, droneName: flight.droneName, findings: serious });
    }
  }
  ctx.logbook.onFlightClosed(row.org_id, flightId);
}
