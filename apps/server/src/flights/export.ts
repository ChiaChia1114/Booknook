/** Flight log exports: CSV, KML (Google Earth), GPX and Athena JSON. */
import { csvCell } from '../lib/csv';
import type { FlightDto, FlightEventDto, FlightSampleDto } from '@athena-sky/shared';

const CSV_COLUMNS: (keyof FlightSampleDto)[] = [
  't',
  'lat',
  'lon',
  'altMsl',
  'altRel',
  'groundSpeed',
  'climbRate',
  'heading',
  'roll',
  'pitch',
  'yaw',
  'batteryPct',
  'voltage',
  'current',
  'satellites',
  'hdop',
  'mode',
  'armed',
  'vibration',
];


/**
 * An export in parts: what comes before the samples, each sample, between two samples and after
 * them – written whole (`exportText`) or streamed a page of samples at a time (flight-routes).
 */
export interface ExportParts {
  head: string;
  item: (s: FlightSampleDto) => string;
  sep: string;
  tail: string;
}

export type ExportFormat = 'csv' | 'kml' | 'gpx' | 'json';

const xml = (s: string): string => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

export function exportParts(format: ExportFormat, flight: FlightDto | null, events: FlightEventDto[] = []): ExportParts {
  switch (format) {
    case 'csv': {
      const header = ['time_utc', 'time_ms', ...CSV_COLUMNS.slice(1).map((c) => c.replace(/[A-Z]/g, (m) => `_${m.toLowerCase()}`))];
      return {
        head: `${header.join(',')}\n`,
        item: (s) => `${[new Date(s.t).toISOString(), s.t, ...CSV_COLUMNS.slice(1).map((c) => csvCell(s[c]))].join(',')}\n`,
        sep: '',
        tail: '',
      };
    }
    case 'kml': {
      const f = flight!;
      const name = `${f.droneName} – ${f.startedAt}`;
      return {
        head: `<?xml version="1.0" encoding="UTF-8"?>
<kml xmlns="http://www.opengis.net/kml/2.2">
  <Document>
    <name>${xml(name)}</name>
    <Style id="track"><LineStyle><color>ff2a8cff</color><width>3</width></LineStyle></Style>
    <Placemark>
      <name>${xml(name)}</name>
      <description>${xml(`Pilot: ${f.pilotName ?? '—'}; duration ${Math.round(f.durationS)} s; distance ${Math.round(f.distanceM)} m; max altitude ${f.maxAltM.toFixed(1)} m`)}</description>
      <styleUrl>#track</styleUrl>
      <LineString>
        <extrude>1</extrude>
        <altitudeMode>absolute</altitudeMode>
        <coordinates>`,
        item: (s) => `${s.lon.toFixed(7)},${s.lat.toFixed(7)},${s.altMsl.toFixed(1)}`,
        sep: ' ',
        tail: `</coordinates>
      </LineString>
    </Placemark>
  </Document>
</kml>
`,
      };
    }
    case 'gpx': {
      const f = flight!;
      return {
        head: `<?xml version="1.0" encoding="UTF-8"?>
<gpx version="1.1" creator="Athena-sky" xmlns="http://www.topografix.com/GPX/1/1">
  <metadata><name>${xml(`${f.droneName} ${f.startedAt}`)}</name><time>${f.startedAt}</time></metadata>
  <trk>
    <name>${xml(f.droneName)}</name>
    <trkseg>
`,
        item: (s) => `      <trkpt lat="${s.lat.toFixed(7)}" lon="${s.lon.toFixed(7)}"><ele>${s.altMsl.toFixed(1)}</ele><time>${new Date(s.t).toISOString()}</time></trkpt>`,
        sep: '\n',
        tail: `
    </trkseg>
  </trk>
</gpx>
`,
      };
    }
    case 'json':
      // As JSON.stringify({ format, version, exportedAt, flight, samples, events }).
      return {
        head: `{"format":"athena-sky-flight","version":1,"exportedAt":${JSON.stringify(new Date().toISOString())},"flight":${JSON.stringify(flight)},"samples":[`,
        item: (s) => JSON.stringify(s),
        sep: ',',
        tail: `],"events":${JSON.stringify(events)}}`,
      };
  }
}

export function exportText(parts: ExportParts, samples: FlightSampleDto[]): string {
  return parts.head + samples.map(parts.item).join(parts.sep) + parts.tail;
}

export function toCsv(samples: FlightSampleDto[]): string {
  return exportText(exportParts('csv', null), samples);
}

export function toKml(flight: FlightDto, samples: FlightSampleDto[]): string {
  return exportText(exportParts('kml', flight), samples);
}

export function toGpx(flight: FlightDto, samples: FlightSampleDto[]): string {
  return exportText(exportParts('gpx', flight), samples);
}

export function toJsonExport(flight: FlightDto, samples: FlightSampleDto[], events: FlightEventDto[]): string {
  return exportText(exportParts('json', flight, events), samples);
}
