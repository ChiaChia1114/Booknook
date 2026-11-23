import type { AppContext } from '../context';
import { yieldToLoop } from '../lib/util';
import { getFlight, loadSamplesAsync, runAnalysis, runComplianceAsync, trackPreview } from './flight-service';

/**
 * Post-flight pipeline: AI analysis → compliance → webhooks → logbook auto-export.
 * Used for live flights (when the recorder closes them) and uploaded logs.
 */
export async function finalizeFlight(ctx: Pick<AppContext, 'db' | 'webhooks' | 'logbook' | 'log' | 'airspace'> & Partial<Pick<AppContext, 'maintenance'>>, flightId: string): Promise<void> {
  // Each step is isolated: a failure is logged and never loses the stored flight or its log file.
  const step = <T>(name: string, fn: () => T): T | null => {
    try {
      return fn();
    } catch (err) {
      ctx.log.error({ err, flightId, step: name }, 'post-flight step failed');
      return null;
    }
  };
  // In slices (the event loop is given back in between): a long flight – read once, analysed,
  // checked among large zones – never holds up the live traffic of the other organisations.
  const samples = await loadSamplesAsync(ctx.db, flightId);
  ctx.db.run('UPDATE flights SET track_preview = ? WHERE id = ?', JSON.stringify(trackPreview(samples)), flightId);
  const later = async <T>(name: string, fn: () => Promise<T>): Promise<T | null> => {
    try {
      return await fn();
    } catch (err) {
      ctx.log.error({ err, flightId, step: name }, 'post-flight step failed');
      return null;
    }
  };
  const analysis = await later('analysis', () => runAnalysis(ctx.db, flightId, samples));
  await yieldToLoop();
  const compliance = await later('compliance', () => runComplianceAsync(ctx.db, flightId, (orgId) => ctx.airspace.zones(orgId), samples));
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
  // New flight hours and health metrics: maintenance due dates and predictive alerts.
  step('maintenance', () => ctx.maintenance?.check(flight.droneId));
}
