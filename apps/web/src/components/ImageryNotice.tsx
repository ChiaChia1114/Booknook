import { useCallback, useRef, useState } from 'react';
import { TriangleAlert } from 'lucide-react';
import type { ImageryStatus } from '../lib/cesium';

/**
 * Imagery status of a 3D view. `track()` returns the callback for the imagery layer being set
 * up now: reports of a layer replaced since (map ↔ satellite) are ignored.
 */
export function useImageryStatus() {
  const [status, setStatus] = useState<ImageryStatus | null>(null);
  const generation = useRef(0);
  const track = useCallback(() => {
    const g = ++generation.current;
    return (s: ImageryStatus) => {
      if (generation.current === g) setStatus(s);
    };
  }, []);
  return { status, track };
}

/** Says so on a map when data it draws (e.g. the airspace zones) could not be loaded. */
export function DataNotice({ what, error }: { what: string; error: string | null | undefined }) {
  if (!error) return null;
  return (
    <span className="imagery-notice" role="status" data-testid="data-unavailable" title={`The ${what} could not be loaded: ${error}`}>
      <TriangleAlert /> {what} not loaded
    </span>
  );
}

/** Says so when the map imagery cannot be loaded – rather than leaving a bare globe unexplained. */
export function ImageryNotice({ status }: { status: ImageryStatus | null }) {
  if (status?.state !== 'failing') return null;
  return (
    <span
      className="imagery-notice"
      role="status"
      data-testid="imagery-unavailable"
      title={`${status.source} could not be loaded: ${status.hint}.`}
    >
      <TriangleAlert /> map imagery unavailable
    </span>
  );
}
