/**
 * Automatic waypoint generation in the mission planner: camera-driven mapping survey,
 * lawn-mower survey, corridor scan, perimeter and orbit / multi-layer structure scan.
 * The area, line or centre is drawn on the 3D map ("+ Area / line" mode).
 */
import { useMemo, useState } from 'react';
import {
  AIRFRAMES,
  cameraFootprint,
  generateCameraSurvey,
  generateCorridor,
  generateOrbit,
  generatePerimeter,
  generateSurvey,
  heightForGsd,
  polygonAreaM2,
  polylineLengthM,
  type LatLon,
  type MissionItem,
} from '@athena-sky/shared';

export type Pattern = 'camera_survey' | 'survey' | 'corridor' | 'perimeter' | 'orbit';

const LABEL: Record<Pattern, string> = {
  camera_survey: 'Mapping survey (camera)',
  survey: 'Survey (manual spacing)',
  corridor: 'Corridor scan',
  perimeter: 'Perimeter',
  orbit: 'Orbit / structure scan',
};

const NEEDS: Record<Pattern, { min: number; what: string }> = {
  camera_survey: { min: 3, what: 'area corners' },
  survey: { min: 3, what: 'area corners' },
  corridor: { min: 2, what: 'points along the line' },
  perimeter: { min: 3, what: 'area corners' },
  orbit: { min: 1, what: 'centre point' },
};

export interface GenerateResult {
  items: MissionItem[];
  alt: number;
  summary: string;
}

export function GeneratePanel({ points, airframeId, onGenerate, onClear }: { points: LatLon[]; airframeId: string; onGenerate(r: GenerateResult): void; onClear(): void }) {
  const [pattern, setPattern] = useState<Pattern>('camera_survey');
  const [p, setP] = useState({ alt: 60, spacingM: 40, angleDeg: 0, gsd: 2.5, front: 75, side: 65, widthM: 60, offsetM: 20, radiusM: 40, points: 16, layers: 3, layerStepM: 10, photos: true, useGsd: true });
  const [error, setError] = useState<string | null>(null);
  const af = AIRFRAMES.find((a) => a.id === airframeId) ?? AIRFRAMES[0]!;
  const need = NEEDS[pattern];
  const set = (k: keyof typeof p, v: number | boolean) => setP({ ...p, [k]: v });
  const num = (k: keyof typeof p, label: string, step = 1) => (
    <label className="field">
      {label}
      <input type="number" step={step} value={p[k] as number} onChange={(e) => set(k, Number(e.target.value))} aria-label={label} />
    </label>
  );
  const camInfo = useMemo(() => {
    const alt = p.useGsd ? heightForGsd(af.camera, p.gsd) : p.alt;
    const fp = cameraFootprint(af.camera, alt);
    return { alt, fp };
  }, [af, p.useGsd, p.gsd, p.alt]);

  const generate = () => {
    setError(null);
    try {
      let r: GenerateResult;
      switch (pattern) {
        case 'camera_survey': {
          const s = generateCameraSurvey({ polygon: points, camera: af.camera, ...(p.useGsd ? { gsdCmPerPx: p.gsd } : { alt: p.alt }), frontOverlap: p.front / 100, sideOverlap: p.side / 100, angleDeg: p.angleDeg });
          r = { items: s.items, alt: s.alt, summary: `${af.camera.name}: GSD ${s.gsdCmPerPx} cm/px at ${s.alt} m, lines every ${s.lineSpacingM} m, photo every ${s.triggerDistanceM} m` };
          break;
        }
        case 'survey':
          r = { items: generateSurvey(points, { spacingM: p.spacingM, angleDeg: p.angleDeg, alt: p.alt }), alt: p.alt, summary: `Lines every ${p.spacingM} m over ${(polygonAreaM2(points) / 10_000).toFixed(1)} ha` };
          break;
        case 'corridor':
          r = { items: generateCorridor({ line: points, widthM: p.widthM, spacingM: p.spacingM, alt: p.alt }), alt: p.alt, summary: `${Math.floor(p.widthM / p.spacingM) + 1} passes along ${(polylineLengthM(points) / 1000).toFixed(2)} km` };
          break;
        case 'perimeter':
          r = { items: generatePerimeter({ polygon: points, offsetM: p.offsetM, alt: p.alt, spacingM: p.spacingM, faceInward: true }), alt: p.alt, summary: `Loop ${p.offsetM} m outside the boundary, camera facing inwards` };
          break;
        case 'orbit':
          r = {
            items: generateOrbit({ center: points[0]!, radiusM: p.radiusM, alt: p.alt, points: p.points, layers: p.layers, layerStepM: p.layerStepM, faceCenter: true, photos: p.photos }),
            alt: p.alt,
            summary: `${p.layers} layer(s) × ${p.points} positions at ${p.radiusM} m, camera facing the centre`,
          };
          break;
      }
      if (r.items.length === 0) throw new Error('The pattern produced no waypoints – check the area and the spacing.');
      onGenerate(r);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  return (
    <div className="card tight" data-testid="generate-panel">
      <h3>Automatic waypoints</h3>
      <label className="field">
        Pattern
        <select value={pattern} onChange={(e) => setPattern(e.target.value as Pattern)} aria-label="Pattern">
          {(Object.keys(LABEL) as Pattern[]).map((k) => (
            <option key={k} value={k}>
              {LABEL[k]}
            </option>
          ))}
        </select>
      </label>
      <p className="small muted">
        Draw the {need.what} on the map with “+ Area / line” ({points.length} so far, at least {need.min}).
      </p>
      <div className="form-grid">
        {pattern === 'camera_survey' && (
          <>
            <label className="field">
              Altitude from
              <select value={p.useGsd ? 'gsd' : 'alt'} onChange={(e) => set('useGsd', e.target.value === 'gsd')} aria-label="Altitude from">
                <option value="gsd">Target GSD</option>
                <option value="alt">Fixed altitude</option>
              </select>
            </label>
            {p.useGsd ? num('gsd', 'GSD (cm/px)', 0.1) : num('alt', 'Altitude (m)')}
            {num('front', 'Front overlap (%)')}
            {num('side', 'Side overlap (%)')}
            {num('angleDeg', 'Direction (°)')}
          </>
        )}
        {pattern === 'survey' && (
          <>
            {num('spacingM', 'Line spacing (m)')}
            {num('angleDeg', 'Direction (°)')}
            {num('alt', 'Altitude (m)')}
          </>
        )}
        {pattern === 'corridor' && (
          <>
            {num('widthM', 'Corridor width (m)')}
            {num('spacingM', 'Pass spacing (m)')}
            {num('alt', 'Altitude (m)')}
          </>
        )}
        {pattern === 'perimeter' && (
          <>
            {num('offsetM', 'Offset outside (m)')}
            {num('spacingM', 'Max. spacing (m)')}
            {num('alt', 'Altitude (m)')}
          </>
        )}
        {pattern === 'orbit' && (
          <>
            {num('radiusM', 'Radius (m)')}
            {num('alt', 'First altitude (m)')}
            {num('points', 'Positions per orbit')}
            {num('layers', 'Layers')}
            {num('layerStepM', 'Layer step (m)')}
            <label className="row small">
              <input type="checkbox" checked={p.photos} onChange={(e) => set('photos', e.target.checked)} /> Photo at each position
            </label>
          </>
        )}
      </div>
      {pattern === 'camera_survey' && (
        <div className="small muted">
          {af.camera.name} ({af.name}): {camInfo.alt.toFixed(0)} m → footprint {camInfo.fp.widthM.toFixed(0)} × {camInfo.fp.heightM.toFixed(0)} m, GSD {camInfo.fp.gsdCmPerPx.toFixed(2)} cm/px
        </div>
      )}
      {error && <div className="small" style={{ color: 'var(--danger)' }}>{error}</div>}
      <div className="row" style={{ marginTop: 8 }}>
        <button className="btn small primary" disabled={points.length < need.min} onClick={generate}>
          Generate
        </button>
        <button className="btn small" onClick={onClear} disabled={points.length === 0}>
          Clear drawing
        </button>
      </div>
    </div>
  );
}
