import { ExternalLink } from 'lucide-react';
import { useMemo, useState } from 'react';
import type { AirspaceCheckDto, AirspaceProviderDto, AirspaceZoneDto, AuthGeometry, AuthorizationDto, DroneDto, FlightAuthorityStatusDto, PublicReservationDto, WeatherDto, ZoneGeometry, ZoneType } from '@athena-sky/shared';
import { ZONE_TYPES, bufferPolyline, type LatLon, hasVisibleText } from '@athena-sky/shared';
import { api, errorMessage } from '../api/client';
import { useApi, useInterval } from '../hooks';
import { useAuth, useOrgId } from '../state/auth';
import { useLive } from '../state/live';
import { MapView, type MapCircle, type MapLine, type MapPolygon } from '../components/MapView';
import { Badge, Card, Empty, ErrorBox, PageHead, fmtDate, useToast } from '../components/ui';

export const ZONE_COLOR: Record<ZoneType, string> = {
  prohibited: '#ef4444',
  restricted: '#ef4444',
  temporary: '#a855f7',
  controlled: '#f97316',
  danger: '#eab308',
  hazard_powerline: '#facc15',
  hazard_obstacle: '#f43f5e',
};

const ZONE_LABEL: Record<ZoneType, string> = {
  prohibited: 'Prohibited',
  restricted: 'Restricted',
  temporary: 'Temporary restriction',
  controlled: 'Controlled airspace',
  danger: 'Danger area',
  hazard_powerline: 'Power line (hazard)',
  hazard_obstacle: 'Obstacle (hazard)',
};

/** Converts zones into map layers. */
export function zoneLayers(zones: AirspaceZoneDto[]): { polygons: MapPolygon[]; circles: MapCircle[]; lines: MapLine[] } {
  const polygons: MapPolygon[] = [];
  const circles: MapCircle[] = [];
  const lines: MapLine[] = [];
  for (const z of zones) {
    const color = ZONE_COLOR[z.type];
    const label = `${z.name} – ${ZONE_LABEL[z.type]} ${Math.round(z.floorM)}–${Math.round(z.ceilingM)} m${z.activeFrom ? ` (${fmtDate(z.activeFrom)} → ${fmtDate(z.activeTo)})` : ''}`;
    if (z.geometry.kind === 'polygon') polygons.push({ id: z.id, points: z.geometry.polygon.map((p) => [p.lat, p.lon]), color, label, dashed: z.type === 'controlled' });
    else if (z.geometry.kind === 'circle') circles.push({ id: z.id, lat: z.geometry.center.lat, lon: z.geometry.center.lon, radiusM: z.geometry.radiusM, color, label });
    else {
      lines.push({ id: z.id, points: z.geometry.line.map((p) => [p.lat, p.lon]), color, weight: 3, label });
      if (z.geometry.bufferM > 0) polygons.push({ id: `${z.id}-buf`, points: bufferPolyline(z.geometry.line, z.geometry.bufferM).map((p) => [p.lat, p.lon]), color, fillOpacity: 0.12, label });
    }
  }
  return { polygons, circles, lines };
}

export function authLayers(geoms: { id: string; geometry: AuthGeometry; color: string; label: string }[]) {
  const circles: MapCircle[] = [];
  const polygons: MapPolygon[] = [];
  const lines: MapLine[] = [];
  for (const g of geoms) {
    if (g.geometry.kind === 'cylinder') circles.push({ id: g.id, lat: g.geometry.center.lat, lon: g.geometry.center.lon, radiusM: g.geometry.radiusM, color: g.color, fillOpacity: 0.25, label: g.label });
    else {
      polygons.push({ id: g.id, points: bufferPolyline(g.geometry.line, g.geometry.widthM / 2).map((p) => [p.lat, p.lon]), color: g.color, fillOpacity: 0.25, label: g.label });
      lines.push({ id: `${g.id}-c`, points: g.geometry.line.map((p) => [p.lat, p.lon]), color: g.color, weight: 1, dashed: true });
    }
  }
  return { circles, polygons, lines };
}

type Draw = 'none' | 'cylinder' | 'corridor' | 'zone';
const toLocal = (d: Date) => new Date(d.getTime() - d.getTimezoneOffset() * 60_000).toISOString().slice(0, 16);

export function AirspacePage() {
  const orgId = useOrgId();
  const { can, me } = useAuth();
  const toast = useToast();
  const { live } = useLive();
  const zones = useApi<AirspaceZoneDto[]>(`/api/v2/organisations/${orgId}/airspace/zones`);
  const auths = useApi<AuthorizationDto[]>(`/api/v2/organisations/${orgId}/airspace/authorizations`);
  // An external flight authority (UTM service) deciding the requests, if the server has one.
  const authority = useApi<FlightAuthorityStatusDto>(`/api/v2/organisations/${orgId}/airspace/authority`);
  const authorityName = authority.data?.configured ? authority.data.name : null;
  // Its decisions arrive in the background: followed while a request waits for one.
  const awaiting = (auths.data ?? []).some((a) => a.authority && (a.authorityState === 'submitting' || a.authorityState === 'submitted' || a.authorityState === 'cancelling'));
  useInterval(
    () => {
      auths.reload();
      authority.reload();
    },
    awaiting ? 10_000 : null,
  );
  const publicMap = useApi<{ reservations: PublicReservationDto[] }>('/api/v2/public/safety-map');
  const drones = useApi<DroneDto[]>(`/api/v2/organisations/${orgId}/drones`);
  const [draw, setDraw] = useState<Draw>('none');
  const [points, setPoints] = useState<LatLon[]>([]);
  const [radius, setRadius] = useState(200);
  const [width, setWidth] = useState(100);
  const [req, setReq] = useState({ maxAltM: 100, start: toLocal(new Date(Date.now() + 30 * 60_000)), hours: 1, droneId: '', isPublic: true });
  const [zoneForm, setZoneForm] = useState<{ name: string; type: ZoneType; shape: 'polygon' | 'circle' | 'line'; floorM: number; ceilingM: number; bufferM: number; activeFrom: string; activeTo: string }>({
    name: '',
    type: 'restricted',
    shape: 'polygon',
    floorM: 0,
    ceilingM: 300,
    bufferM: 30,
    activeFrom: '',
    activeTo: '',
  });
  const [check, setCheck] = useState<AirspaceCheckDto | null>(null);
  const [importReport, setImportReport] = useState<{ imported: number; skipped: number; issues: string[] } | null>(null);
  const [weather, setWeather] = useState<WeatherDto | null>(null);
  const [weatherErr, setWeatherErr] = useState<string | null>(null);
  const [center, setCenter] = useState<LatLon>({ lat: 25.0732, lon: 121.5355 });
  const [error, setError] = useState<string | null>(null);

  const geometry: AuthGeometry | null =
    draw === 'cylinder' && points.length >= 1
      ? { kind: 'cylinder', center: points[0]!, radiusM: radius }
      : draw === 'corridor' && points.length >= 2
        ? { kind: 'corridor', line: points, widthM: width }
        : null;
  const zoneGeometry: ZoneGeometry | null =
    draw !== 'zone'
      ? null
      : zoneForm.shape === 'polygon' && points.length >= 3
        ? { kind: 'polygon', polygon: points }
        : zoneForm.shape === 'circle' && points.length >= 1
          ? { kind: 'circle', center: points[0]!, radiusM: radius }
          : zoneForm.shape === 'line' && points.length >= 2
            ? { kind: 'line', line: points, bufferM: zoneForm.bufferM }
            : null;

  const zl = useMemo(() => zoneLayers(zones.data ?? []), [zones.data]);
  const ownRefs = new Set((auths.data ?? []).map((a) => a.reference));
  const al = useMemo(
    () =>
      authLayers([
        ...(auths.data ?? []).filter((a) => a.status === 'approved' || a.status === 'pending').map((a) => ({ id: a.id, geometry: a.geometry, color: a.status === 'approved' ? '#22c55e' : '#38bdf8', label: `${a.reference} (${a.status}) ${fmtDate(a.startAt)}` })),
        ...(publicMap.data?.reservations ?? []).filter((r) => !ownRefs.has(r.reference)).map((r) => ({ id: r.reference, geometry: r.geometry, color: '#94a3b8', label: `${r.reference} – ${r.operator} ${fmtDate(r.startAt)}` })),
      ]),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [auths.data, publicMap.data],
  );
  const draft = geometry ? authLayers([{ id: 'draft', geometry, color: '#facc15', label: 'Requested volume' }]) : { circles: [], polygons: [], lines: [] };
  const zoneDraft = zoneGeometry ? zoneLayers([{ id: 'zdraft', name: zoneForm.name || 'New zone', type: zoneForm.type, geometry: zoneGeometry, floorM: zoneForm.floorM, ceilingM: zoneForm.ceilingM, activeFrom: null, activeTo: null, source: '', notes: '', createdAt: '', readOnly: false }]) : { circles: [], polygons: [], lines: [] };
  const traffic = Object.values(live.drones).flatMap((d) => d.traffic);
  const liveDrones = Object.values(live.drones).filter((d) => d.online && d.telemetry);

  const timeWindow = () => {
    const s = new Date(req.start);
    return { startAt: s.toISOString(), endAt: new Date(s.getTime() + req.hours * 3_600_000).toISOString() };
  };
  const loadWeather = async (p: LatLon) => {
    setWeatherErr(null);
    try {
      setWeather(await api<WeatherDto>('/api/v2/weather', { query: { lat: p.lat.toFixed(4), lon: p.lon.toFixed(4) } }));
    } catch (err) {
      setWeather(null);
      setWeatherErr(errorMessage(err));
    }
  };

  return (
    <div className="content">
      <PageHead
        title="Airspace & UTM"
        subtitle="Airspace data, ground hazards, weather and real-time flight authorisation (cylinder and corridor flight plans) with public airspace reservation."
        actions={
          <a className="btn" href="/safety-map" target="_blank" rel="noreferrer">
            <ExternalLink /> Public safety map
          </a>
        }
      />
      <ErrorBox error={error} />
      <div className="grid main-side">
        <Card tight>
          <div className="row" style={{ marginBottom: 8, flexWrap: 'wrap' }}>
            <span className="small muted">Draw:</span>
            {can('authorization.request') && (
              <>
                <button className={`btn small${draw === 'cylinder' ? ' active' : ''}`} onClick={() => { setDraw('cylinder'); setPoints([]); setCheck(null); }}>
                  Cylinder plan
                </button>
                <button className={`btn small${draw === 'corridor' ? ' active' : ''}`} onClick={() => { setDraw('corridor'); setPoints([]); setCheck(null); }}>
                  Corridor plan
                </button>
              </>
            )}
            {can('airspace.manage') && (
              <button className={`btn small${draw === 'zone' ? ' active' : ''}`} onClick={() => { setDraw('zone'); setPoints([]); }}>
                Airspace zone
              </button>
            )}
            {draw !== 'none' && (
              <button className="btn small" onClick={() => { setPoints([]); setCheck(null); }}>
                Clear ({points.length})
              </button>
            )}
            <button className="btn small right" onClick={() => loadWeather(center)}>
              Weather at map centre
            </button>
          </div>
          <MapView
            className="tall"
            testId="airspace-map"
            cursor={draw !== 'none' ? 'crosshair' : undefined}
            fitKey={zones.data ? 'zones' : undefined}
            fit={[
              ...(zones.data ?? []).flatMap((z) =>
                z.geometry.kind === 'polygon' ? z.geometry.polygon.map((p) => [p.lat, p.lon] as [number, number]) : z.geometry.kind === 'circle' ? [[z.geometry.center.lat, z.geometry.center.lon] as [number, number]] : z.geometry.line.map((p) => [p.lat, p.lon] as [number, number]),
              ),
              ...(drones.data ?? []).filter((d) => d.lastPosition).map((d) => [d.lastPosition!.lat, d.lastPosition!.lon] as [number, number]),
            ]}
            onMove={(c) => setCenter(c)}
            onClick={(lat, lon) => {
              if (draw === 'none') return;
              const single = draw === 'cylinder' || (draw === 'zone' && zoneForm.shape === 'circle');
              setPoints((p) => (single ? [{ lat, lon }] : [...p, { lat, lon }]));
              setCheck(null);
            }}
            polygons={[...zl.polygons, ...al.polygons, ...draft.polygons, ...zoneDraft.polygons]}
            circles={[...zl.circles, ...al.circles, ...draft.circles, ...zoneDraft.circles]}
            lines={[...zl.lines, ...al.lines, ...draft.lines, ...zoneDraft.lines, ...(draw === 'corridor' || (draw === 'zone' && zoneForm.shape !== 'circle') ? [{ id: 'pts', points: points.map((p) => [p.lat, p.lon] as [number, number]), color: '#facc15', dashed: true }] : [])]}
            markers={[
              ...points.map((p, i) => ({ id: `p${i}`, lat: p.lat, lon: p.lon, color: '#facc15', radius: 4 })),
              ...liveDrones.map((d) => ({ id: d.droneId, lat: d.telemetry!.lat, lon: d.telemetry!.lon, heading: d.telemetry!.heading, color: '#38bdf8', label: d.name })),
              ...traffic.map((a) => ({ id: a.icao, lat: a.lat, lon: a.lon, heading: a.heading, color: '#f97316', label: `✈ ${a.callsign ?? a.icao} ${Math.round(a.altMsl)} m` })),
            ]}
          />
          <div className="row wrap small muted" style={{ marginTop: 6, rowGap: 4, columnGap: 12 }}>
            {(Object.keys(ZONE_COLOR) as ZoneType[]).map((t) => (
              <span key={t} className="row nowrap" style={{ gap: 4 }}>
                <span className="dot" style={{ background: ZONE_COLOR[t] }} />
                {ZONE_LABEL[t]}
              </span>
            ))}
            <span className="row nowrap" style={{ gap: 4 }}>
              <span className="dot" style={{ background: '#22c55e' }} />
              Approved reservation
            </span>
          </div>
        </Card>

        <div className="stack">
          <Card title="Weather">
            {weatherErr && <div className="small muted">{weatherErr}</div>}
            {!weather && !weatherErr && <div className="small muted">Pan the map and press “Weather at map centre”.</div>}
            {weather && (
              <div className="col" data-testid="weather">
                <Badge tone={weather.assessment.status === 'go' ? 'ok' : weather.assessment.status === 'caution' ? 'warn' : 'danger'}>{weather.assessment.status.toUpperCase()}</Badge>
                <div className="hud">
                  <div className="cell">
                    <div className="k">Wind</div>
                    <div className="v">{weather.windSpeedMs?.toFixed(1) ?? '—'} m/s</div>
                  </div>
                  <div className="cell">
                    <div className="k">Gusts</div>
                    <div className="v">{weather.windGustMs?.toFixed(1) ?? '—'} m/s</div>
                  </div>
                  <div className="cell">
                    <div className="k">Temp</div>
                    <div className="v">{weather.temperatureC ?? '—'} °C</div>
                  </div>
                  <div className="cell">
                    <div className="k">Visibility</div>
                    <div className="v">{weather.visibilityM !== null ? `${(weather.visibilityM / 1000).toFixed(1)} km` : '—'}</div>
                  </div>
                </div>
                {weather.assessment.reasons.map((r) => (
                  <div key={r} className="small">
                    • {r}
                  </div>
                ))}
                <div className="small muted">
                  {weather.source} · {fmtDate(weather.time)} · wind from {weather.windDirDeg ?? '—'}°
                </div>
              </div>
            )}
          </Card>

          {(draw === 'cylinder' || draw === 'corridor') && (
            <Card title={`Request authorisation – ${draw} flight plan`}>
              <div className="form">
                <div className="small muted">{draw === 'cylinder' ? 'Click the centre of the operation on the map.' : 'Click the corridor centre line on the map (2+ points).'}</div>
                <div className="form-grid">
                  {draw === 'cylinder' ? (
                    <label className="field">
                      Radius (m)
                      <input type="number" value={radius} onChange={(e) => setRadius(Number(e.target.value))} />
                    </label>
                  ) : (
                    <label className="field">
                      Width (m)
                      <input type="number" value={width} onChange={(e) => setWidth(Number(e.target.value))} />
                    </label>
                  )}
                  <label className="field">
                    Max altitude (m)
                    <input type="number" value={req.maxAltM} onChange={(e) => setReq({ ...req, maxAltM: Number(e.target.value) })} />
                  </label>
                  <label className="field">
                    Start
                    <input type="datetime-local" value={req.start} min={toLocal(new Date())} onChange={(e) => setReq({ ...req, start: e.target.value })} title="Authorisations start now at the earliest" />
                  </label>
                  <label className="field">
                    Duration (h)
                    <input type="number" step={0.25} min={0.25} value={req.hours} onChange={(e) => setReq({ ...req, hours: Number(e.target.value) })} />
                  </label>
                  <label className="field">
                    Drone
                    <select value={req.droneId} onChange={(e) => setReq({ ...req, droneId: e.target.value })}>
                      <option value="">—</option>
                      {(drones.data ?? []).map((d) => (
                        <option key={d.id} value={d.id}>
                          {d.name}
                        </option>
                      ))}
                    </select>
                  </label>
                </div>
                <label className="row small">
                  <input type="checkbox" checked={req.isPublic} onChange={(e) => setReq({ ...req, isPublic: e.target.checked })} /> Publish on the public safety map
                </label>
                <div className="row">
                  <button
                    className="btn"
                    disabled={!geometry}
                    onClick={async () => {
                      try {
                        setCheck(await api<AirspaceCheckDto>(`/api/v2/organisations/${orgId}/airspace/check`, { body: { geometry, maxAltM: req.maxAltM, ...timeWindow() } }));
                      } catch (err) {
                        toast(errorMessage(err), 'error');
                      }
                    }}
                  >
                    Check
                  </button>
                  <button
                    className="btn primary"
                    disabled={!geometry}
                    onClick={async () => {
                      try {
                        const a = await api<AuthorizationDto>(`/api/v2/organisations/${orgId}/airspace/authorizations`, {
                          body: { geometry, maxAltM: req.maxAltM, ...timeWindow(), droneId: req.droneId || null, isPublic: req.isPublic },
                        });
                        toast(
                          a.status === 'pending' && a.authority ? `${a.reference}: submitted to ${a.authority} – awaiting its decision` : `${a.reference}: ${a.status}${a.authority && a.status !== 'pending' ? ` by ${a.authority}` : ''}`,
                          a.status === 'approved' ? 'ok' : a.status === 'rejected' ? 'error' : 'info',
                        );
                        setPoints([]);
                        setDraw('none');
                        setCheck(null);
                        auths.reload();
                        publicMap.reload();
                      } catch (err) {
                        toast(errorMessage(err), 'error');
                      }
                    }}
                  >
                    Submit request
                  </button>
                </div>
                {check && (
                  <div className="col" style={{ gap: 4 }}>
                    <Badge tone={check.verdict === 'clear' ? 'ok' : check.verdict === 'review' ? 'warn' : 'danger'}>{check.verdict}</Badge>
                    {check.conflicts.length === 0 && (
                      <span className="small muted">{authorityName ? `No conflicts here – the request will be submitted to ${authorityName} for its decision.` : 'No conflicts – the request will be approved instantly.'}</span>
                    )}
                    {check.conflicts.map((c, i) => (
                      <div key={i} className={`issue ${c.severity === 'advisory' ? 'warning' : 'error'}`}>
                        {c.message}
                      </div>
                    ))}
                  </div>
                )}
              </div>
            </Card>
          )}

          {draw === 'zone' && (
            <Card title="New airspace zone">
              <div className="form">
                <div className="form-grid">
                  <label className="field">
                    Name
                    <input value={zoneForm.name} onChange={(e) => setZoneForm({ ...zoneForm, name: e.target.value })} />
                  </label>
                  <label className="field">
                    Type
                    <select value={zoneForm.type} onChange={(e) => setZoneForm({ ...zoneForm, type: e.target.value as ZoneType, shape: e.target.value === 'hazard_powerline' ? 'line' : zoneForm.shape })}>
                      {ZONE_TYPES.map((t) => (
                        <option key={t} value={t}>
                          {ZONE_LABEL[t]}
                        </option>
                      ))}
                    </select>
                  </label>
                  <label className="field">
                    Shape
                    <select value={zoneForm.shape} onChange={(e) => { setZoneForm({ ...zoneForm, shape: e.target.value as 'polygon' | 'circle' | 'line' }); setPoints([]); }}>
                      <option value="polygon">Polygon</option>
                      <option value="circle">Circle</option>
                      <option value="line">Line (with buffer)</option>
                    </select>
                  </label>
                  {zoneForm.shape === 'circle' && (
                    <label className="field">
                      Radius (m)
                      <input type="number" value={radius} onChange={(e) => setRadius(Number(e.target.value))} />
                    </label>
                  )}
                  {zoneForm.shape === 'line' && (
                    <label className="field">
                      Buffer (m)
                      <input type="number" value={zoneForm.bufferM} onChange={(e) => setZoneForm({ ...zoneForm, bufferM: Number(e.target.value) })} />
                    </label>
                  )}
                  <label className="field">
                    Floor (m)
                    <input type="number" value={zoneForm.floorM} onChange={(e) => setZoneForm({ ...zoneForm, floorM: Number(e.target.value) })} />
                  </label>
                  <label className="field">
                    Ceiling (m)
                    <input type="number" value={zoneForm.ceilingM} onChange={(e) => setZoneForm({ ...zoneForm, ceilingM: Number(e.target.value) })} />
                  </label>
                  <label className="field">
                    Active from
                    <input type="datetime-local" value={zoneForm.activeFrom} onChange={(e) => setZoneForm({ ...zoneForm, activeFrom: e.target.value })} />
                  </label>
                  <label className="field">
                    Active to
                    <input type="datetime-local" value={zoneForm.activeTo} onChange={(e) => setZoneForm({ ...zoneForm, activeTo: e.target.value })} />
                  </label>
                </div>
                <button
                  className="btn primary"
                  disabled={!zoneGeometry || !hasVisibleText(zoneForm.name)}
                  onClick={async () => {
                    try {
                      await api(`/api/v2/organisations/${orgId}/airspace/zones`, {
                        body: {
                          name: zoneForm.name,
                          type: zoneForm.type,
                          geometry: zoneGeometry,
                          floorM: zoneForm.floorM,
                          ceilingM: zoneForm.ceilingM,
                          activeFrom: zoneForm.activeFrom ? new Date(zoneForm.activeFrom).toISOString() : null,
                          activeTo: zoneForm.activeTo ? new Date(zoneForm.activeTo).toISOString() : null,
                        },
                      });
                      setPoints([]);
                      setDraw('none');
                      zones.reload();
                    } catch (err) {
                      setError(errorMessage(err));
                    }
                  }}
                >
                  Create zone
                </button>
                <label className="field">
                  …or import a GeoJSON FeatureCollection (properties: name, type, floor, ceiling)
                  <input
                    type="file"
                    accept=".json,.geojson"
                    onChange={async (e) => {
                      const f = e.target.files?.[0];
                      if (!f) return;
                      try {
                        const r = await api<{ imported: number; skipped: string[]; warnings: string[] }>(`/api/v2/organisations/${orgId}/airspace/zones/import`, { body: { geojson: JSON.parse(await f.text()), defaultType: zoneForm.type } });
                        // What was skipped or simplified, and why: all of it, listed below the import.
                        const issues = [...r.skipped.map((x) => `Skipped ${x}`), ...r.warnings];
                        setImportReport({ imported: r.imported, skipped: r.skipped.length, issues });
                        toast(`Imported ${r.imported} zone(s)${r.skipped.length ? `, skipped ${r.skipped.length}` : ''}${issues.length ? ' – the reasons are listed below' : ''}`, r.skipped.length ? 'error' : 'ok');
                        zones.reload();
                      } catch (err) {
                        setImportReport(null);
                        toast(errorMessage(err), 'error');
                      } finally {
                        e.target.value = '';
                      }
                    }}
                  />
                </label>
                {importReport && importReport.issues.length > 0 && (
                  <div className="notice small import-report" data-testid="import-report">
                    <div className="import-report-head">
                      <b>
                        Imported {importReport.imported} zone(s){importReport.skipped ? `, skipped ${importReport.skipped}` : ''}
                      </b>
                      <button type="button" className="btn small ghost" onClick={() => setImportReport(null)}>
                        Dismiss
                      </button>
                    </div>
                    <ul className="issue-list">
                      {importReport.issues.map((x, i) => (
                        <li key={i}>{x}</li>
                      ))}
                    </ul>
                  </div>
                )}
              </div>
            </Card>
          )}
        </div>
      </div>

      {/* Full width: requests carry their window, volume, decision and conflicts. */}
      <div className="stack" style={{ marginTop: 16 }}>
        <Card title="Flight authorisations">
          {authority.data?.configured && (
            <div className="notice small" data-testid="authority-status" style={{ marginBottom: 12 }}>
              <div>
                Requests that pass the airspace checks are submitted to <b>{authority.data.name}</b>
                {authority.data.origin ? ` (${authority.data.origin})` : ''}, which approves or rejects them; approved public reservations appear on its drone safety map.
                {authority.data.pending > 0 && ` ${authority.data.pending} waiting for its decision.`}
                {authority.data.lastError && <div style={{ color: 'var(--danger-text)' }}>Last error: {authority.data.lastError}</div>}
              </div>
            </div>
          )}
          {(auths.data ?? []).length === 0 ? (
            <Empty>No requests yet.</Empty>
          ) : (
            <div className="table-wrap">
              <table className="table" data-testid="authorizations">
                <thead>
                  <tr>
                    <th>Reference</th>
                    <th>Window</th>
                    <th>Volume</th>
                    <th>Status</th>
                    <th />
                  </tr>
                </thead>
                <tbody>
                  {auths.data!.map((a) => (
                    <tr key={a.id}>
                      <td>
                        <b>{a.reference}</b>
                        <div className="small muted">
                          {a.requesterName ?? '—'}
                          {a.droneName ? ` · ${a.droneName}` : ''}
                        </div>
                      </td>
                      <td className="small">
                        {fmtDate(a.startAt)}
                        <br />→ {fmtDate(a.endAt)}
                      </td>
                      <td className="small">
                        {a.geometry.kind === 'cylinder' ? `cylinder r=${a.geometry.radiusM} m` : `corridor w=${a.geometry.widthM} m`} · ≤{a.maxAltM} m
                      </td>
                      <td>
                        <Badge tone={a.status === 'approved' ? 'ok' : a.status === 'rejected' ? 'danger' : a.status === 'pending' ? 'warn' : undefined}>{a.status}</Badge>
                        {/* Its history: approved (in effect from then on) and cancelled, each when and by whom. */}
                        {a.approvedAt && (
                          <div className="small muted" data-testid="auth-approved">
                            Approved {fmtDate(a.approvedAt)}
                            {a.deciderName ? ` by ${a.deciderName}` : ''}
                          </div>
                        )}
                        {a.status === 'rejected' && a.decidedAt && (
                          <div className="small muted">
                            Rejected {fmtDate(a.decidedAt)}
                            {a.deciderName ? ` by ${a.deciderName}` : ''}
                          </div>
                        )}
                        {a.cancelledAt && (
                          <div className="small muted" data-testid="auth-cancelled">
                            Cancelled {fmtDate(a.cancelledAt)}
                            {a.cancellerName ? ` by ${a.cancellerName}` : ''}
                          </div>
                        )}
                        {a.cancelReason && <div className="small muted">{a.cancelReason}</div>}
                        <div className="small muted">{a.decisionReason}</div>
                        {a.authority && (
                          <div className="small muted" data-testid="auth-authority">
                            Flight authority: {a.authority}
                            {a.authorityRef ? ` · ref ${a.authorityRef}` : ''}
                            {a.authorityUrl && (
                              <>
                                {' · '}
                                <a href={a.authorityUrl} target="_blank" rel="noopener noreferrer">
                                  View on its safety map <ExternalLink style={{ width: 12, height: 12, verticalAlign: '-2px' }} />
                                </a>
                              </>
                            )}
                          </div>
                        )}
                        {a.authorityError && a.authorityState && a.authorityState !== 'closed' && (
                          <div className="small" style={{ color: 'var(--warn)' }}>
                            {a.authorityState === 'submitting' ? 'Not submitted yet' : a.authorityState === 'cancelling' ? 'Not withdrawn yet' : `${a.authority} not reached`} ({a.authorityError}) – retrying
                          </div>
                        )}
                        {a.authorityError && a.authorityState === 'closed' && <div className="small" style={{ color: 'var(--warn)' }}>{a.authorityError}</div>}
                        {a.status === 'pending' && a.authority && !a.authorityDecides && (
                          <div className="small" style={{ color: 'var(--warn)' }} data-testid="auth-authority-gone">
                            This server is no longer connected to {a.authority}: the organisation decides this request.
                          </div>
                        )}
                        {a.conflicts.map((c, i) => (
                          <div key={i} className="small" style={{ color: c.severity === 'advisory' ? 'var(--warn)' : 'var(--danger)' }}>
                            {c.message}
                          </div>
                        ))}
                      </td>
                      <td>
                        <div className="col">
                          {a.status === 'pending' && a.authorityDecides && <span className="small muted">Awaiting {a.authority}</span>}
                          {a.status === 'pending' && can('authorization.decide') && !a.authorityDecides && (
                            <>
                              <button className="btn small ok" onClick={async () => { try { await api(`/api/v2/organisations/${orgId}/airspace/authorizations/${a.id}/decision`, { body: { decision: 'approve' } }); auths.reload(); publicMap.reload(); } catch (err) { toast(errorMessage(err), 'error'); } }}>
                                Approve
                              </button>
                              <button className="btn small danger" onClick={async () => { try { await api(`/api/v2/organisations/${orgId}/airspace/authorizations/${a.id}/decision`, { body: { decision: 'reject' } }); auths.reload(); } catch (err) { toast(errorMessage(err), 'error'); } }}>
                                Reject
                              </button>
                            </>
                          )}
                          {/* The requester can withdraw their own request; mission managers and administrators any. */}
                          {(a.status === 'pending' || a.status === 'approved') && (a.requestedBy === me?.user.id || can('authorization.decide')) && (
                            <button className="btn small" onClick={async () => { try { await api(`/api/v2/organisations/${orgId}/airspace/authorizations/${a.id}/cancel`, { method: 'POST' }); auths.reload(); publicMap.reload(); } catch (err) { toast(errorMessage(err), 'error'); } }}>
                              Cancel
                            </button>
                          )}
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </Card>
        <Card title="Airspace zones & ground hazards">
          {(zones.data ?? []).length === 0 ? (
            <Empty>No airspace data. Draw zones or import GeoJSON.</Empty>
          ) : (
            <div className="table-wrap">
              <table className="table">
                <tbody>
                  {zones.data!.map((z) => (
                    <tr key={z.id}>
                      <td>
                        <span className="dot" style={{ background: ZONE_COLOR[z.type] }} /> <b>{z.name}</b>
                        <div className="small muted">
                          {ZONE_LABEL[z.type]} · {z.floorM}–{z.ceilingM} m · {z.source}
                          {z.activeFrom ? ` · ${fmtDate(z.activeFrom)} → ${fmtDate(z.activeTo)}` : ''}
                        </div>
                      </td>
                      <td>
                        {z.readOnly ? (
                          <Badge>external feed</Badge>
                        ) : (
                          can('airspace.manage') && (
                            <button className="btn small danger" onClick={async () => { if (confirm(`Delete ${z.name}?`)) { await api(`/api/v2/organisations/${orgId}/airspace/zones/${z.id}`, { method: 'DELETE' }); zones.reload(); } }}>
                              Delete
                            </button>
                          )
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </Card>
        <AirspaceSources />
      </div>
    </div>
  );
}

/** Status of the airspace data providers (organisation zones + external GeoJSON feeds). */
function AirspaceSources() {
  const providers = useApi<AirspaceProviderDto[]>('/api/v2/airspace/providers');
  const feeds = (providers.data ?? []).filter((p) => p.kind !== 'builtin');
  return (
    <Card title="Airspace data sources">
      <p className="small muted">
        Checks, authorisations, mission checks and post-flight compliance use your organisation's zones plus every external feed configured by the server operator
        (<code>ATHENA_AIRSPACE_FEEDS</code>).
      </p>
      {feeds.length === 0 ? (
        <Empty>No external airspace feed configured.</Empty>
      ) : (
        <div className="table-wrap">
          <table className="table small" data-testid="airspace-sources">
            <tbody>
              {feeds.map((p) => (
                <tr key={p.id}>
                  <td>
                    <b>{p.name}</b>
                    <div className="muted">{p.url}</div>
                  </td>
                  <td>
                    {p.zoneCount} zones{p.skipped ? ` · ${p.skipped} skipped` : ''}
                    {p.issues?.length ? (
                      <details className="feed-issues" data-testid={`feed-issues-${p.id}`}>
                        <summary>{p.skipped ? 'Why skipped' : 'Simplified'} ({p.issues.length})</summary>
                        <ul className="issue-list">
                          {p.issues.map((x, i) => (
                            <li key={i}>{x}</li>
                          ))}
                        </ul>
                      </details>
                    ) : null}
                  </td>
                  <td>{p.lastFetchAt ? `updated ${fmtDate(p.lastFetchAt)}` : 'not loaded yet'}</td>
                  <td>{p.lastError ? <Badge tone="warn">{p.lastError}</Badge> : <Badge tone="ok">ok</Badge>}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </Card>
  );
}
