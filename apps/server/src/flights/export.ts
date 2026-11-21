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


export function toCsv(samples: FlightSampleDto[]): string {
  const header = ['time_utc', 'time_ms', ...CSV_COLUMNS.slice(1).map((c) => c.replace(/[A-Z]/g, (m) => `_${m.toLowerCase()}`))];
  const lines = [header.join(',')];
  for (const s of samples) {
    lines.push([new Date(s.t).toISOString(), s.t, ...CSV_COLUMNS.slice(1).map((c) => csvCell(s[c]))].join(','));
  }
  return lines.join('\n') + '\n';
}

const xml = (s: string): string => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

export function toKml(flight: FlightDto, samples: FlightSampleDto[]): string {
  const coords = samples.map((s) => `${s.lon.toFixed(7)},${s.lat.toFixed(7)},${s.altMsl.toFixed(1)}`).join(' ');
  const name = `${flight.droneName} – ${flight.startedAt}`;
  return `<?xml version="1.0" encoding="UTF-8"?>
<kml xmlns="http://www.opengis.net/kml/2.2">
  <Document>
    <name>${xml(name)}</name>
    <Style id="track"><LineStyle><color>ff2a8cff</color><width>3</width></LineStyle></Style>
    <Placemark>
      <name>${xml(name)}</name>
      <description>${xml(`Pilot: ${flight.pilotName ?? '—'}; duration ${Math.round(flight.durationS)} s; distance ${Math.round(flight.distanceM)} m; max altitude ${flight.maxAltM.toFixed(1)} m`)}</description>
      <styleUrl>#track</styleUrl>
      <LineString>
        <extrude>1</extrude>
        <altitudeMode>absolute</altitudeMode>
        <coordinates>${coords}</coordinates>
      </LineString>
    </Placemark>
  </Document>
</kml>
`;
}

export function toGpx(flight: FlightDto, samples: FlightSampleDto[]): string {
  const pts = samples
    .map((s) => `      <trkpt lat="${s.lat.toFixed(7)}" lon="${s.lon.toFixed(7)}"><ele>${s.altMsl.toFixed(1)}</ele><time>${new Date(s.t).toISOString()}</time></trkpt>`)
    .join('\n');
  return `<?xml version="1.0" encoding="UTF-8"?>
<gpx version="1.1" creator="Athena-sky" xmlns="http://www.topografix.com/GPX/1/1">
  <metadata><name>${xml(`${flight.droneName} ${flight.startedAt}`)}</name><time>${flight.startedAt}</time></metadata>
  <trk>
    <name>${xml(flight.droneName)}</name>
    <trkseg>
${pts}
    </trkseg>
  </trk>
</gpx>
`;
}

export function toJsonExport(flight: FlightDto, samples: FlightSampleDto[], events: FlightEventDto[]): string {
  return JSON.stringify({ format: 'athena-sky-flight', version: 1, exportedAt: new Date().toISOString(), flight, samples, events });
}
