/** REST API data-transfer objects shared by the server and the web client. */
import type { LatLon } from './geo';
import type { MissionPlan, MissionStats } from './mission';
import type { Role } from './roles';
import type { HealthPrediction, MaintenanceDue, MetricPoint } from './maintenance';

export interface Paged<T> {
  items: T[];
  total: number;
  limit: number;
  offset: number;
}

export interface UserDto {
  id: string;
  email: string;
  name: string;
  createdAt: string;
}

export interface MembershipSummary {
  orgId: string;
  orgName: string;
  role: Role;
}

export interface MeDto {
  user: UserDto;
  memberships: MembershipSummary[];
}

export interface OrgSettings {
  /** Regulatory altitude limit used for compliance checks (m AGL). */
  maxAltitudeM: number;
  /** Battery level at which simulated / connected drones are expected to RTL. */
  lowBatteryPct: number;
}

export interface OrganisationDto {
  id: string;
  name: string;
  createdAt: string;
  role: Role;
  settings: OrgSettings;
}

export interface MemberDto {
  userId: string;
  email: string;
  name: string;
  role: Role;
  pilotLicense: string | null;
  joinedAt: string;
  online: boolean;
}

export interface InvitationDto {
  id: string;
  email: string;
  role: Role;
  createdAt: string;
  expiresAt: string;
  /**
   * Only returned to the inviter right after creation, and only when accounts are not confirmed
   * by e-mail (otherwise the link goes to the invited mailbox only).
   */
  acceptUrl?: string;
}

export interface FleetDto {
  id: string;
  name: string;
  description: string;
  droneCount: number;
  createdAt: string;
}

export interface NextMissionDto {
  scheduleId: string;
  missionId: string;
  name: string;
  plannedAt: string;
  terrain: TerrainSummary | null;
}

export interface DroneDto {
  id: string;
  name: string;
  model: string;
  serial: string;
  fleetId: string | null;
  fleetName: string | null;
  /** Airframe model used for simulation and 3D views (see AIRFRAMES). */
  airframeId: string | null;
  firmwareVersion: string | null;
  notes: string;
  createdAt: string;
  lastSeenAt: string | null;
  lastPosition: { lat: number; lon: number; altMsl: number } | null;
  online: boolean;
  inFlight: boolean;
  flightCount: number;
  flightTimeS: number;
  distanceM: number;
  batteryCycles: number;
  /** Estimated battery health 0..100 % (null until enough flights). */
  batteryHealthPct: number | null;
  /** Mean post-flight analysis score of the last flights. */
  healthScore: number | null;
  nextMission: NextMissionDto | null;
  linkKeyPrefix: string;
}

export interface DroneCreatedDto extends DroneDto {
  /** Plain link key – shown exactly once. */
  linkKey: string;
}

export type FlightStatus = 'in_progress' | 'completed' | 'aborted';
export type FlightSource = 'live' | 'upload';

export interface ComplianceViolation {
  type: 'zone' | 'altitude' | 'geofence' | 'authorization' | 'reservation';
  message: string;
  zoneId?: string;
}

export interface ComplianceDto {
  compliant: boolean;
  violations: ComplianceViolation[];
}

export interface FlightDto {
  id: string;
  droneId: string;
  droneName: string;
  fleetId: string | null;
  pilotId: string | null;
  pilotName: string | null;
  missionId: string | null;
  source: FlightSource;
  status: FlightStatus;
  startedAt: string;
  endedAt: string | null;
  durationS: number;
  distanceM: number;
  maxAltM: number;
  maxSpeedMs: number;
  batteryStartPct: number | null;
  batteryEndPct: number | null;
  startLat: number | null;
  startLon: number | null;
  endLat: number | null;
  endLon: number | null;
  healthScore: number | null;
  compliance: ComplianceDto | null;
  notes: string;
  createdAt: string;
}

export interface FlightSampleDto {
  t: number;
  lat: number;
  lon: number;
  altMsl: number;
  altRel: number;
  groundSpeed: number;
  climbRate: number;
  heading: number;
  roll: number;
  pitch: number;
  yaw: number;
  batteryPct: number;
  voltage: number;
  current: number;
  satellites: number;
  hdop: number;
  mode: string;
  armed: boolean;
  vibration: number | null;
  /** Normalised motor outputs 0..1, when the vehicle reports them. */
  motors?: number[] | null;
}

export interface FlightEventDto {
  t: number;
  level: 'info' | 'warning' | 'error' | 'critical';
  code: string | null;
  message: string;
}

export type FindingSeverity = 'info' | 'warning' | 'critical';

export interface AnalysisFinding {
  code: string;
  severity: FindingSeverity;
  title: string;
  detail: string;
  metric?: number;
  t?: number;
}

export interface FlightAnalysisDto {
  flightId: string;
  score: number;
  computedAt: string;
  findings: AnalysisFinding[];
  metrics: Record<string, number>;
}

export interface FlightFileDto {
  id: string;
  kind: 'ulog' | 'csv' | 'json' | 'other';
  filename: string;
  size: number;
  sha256: string;
  createdAt: string;
}

/** Topics/fields available for plotting from an uploaded log. */
export interface LogTopicDto {
  name: string;
  multiId: number;
  fields: string[];
  samples: number;
}

export interface TerrainSample {
  /** Distance along the route (m). */
  d: number;
  /** Terrain elevation AMSL (m), null if unknown. */
  elevation: number | null;
  /** Planned altitude AMSL (m). */
  alt: number;
}

export interface TerrainSummary {
  homeElevationM: number | null;
  minElevationM: number | null;
  maxElevationM: number | null;
  /** Smallest planned clearance above terrain along the route (m). */
  minClearanceM: number | null;
  samples: TerrainSample[];
}

export interface MissionDto {
  id: string;
  name: string;
  description: string;
  plan: MissionPlan;
  stats: MissionStats;
  createdBy: string | null;
  createdByName: string | null;
  createdAt: string;
  updatedAt: string;
  terrain: TerrainSummary | null;
  /** Swarm operation this per-drone mission belongs to. */
  swarmId?: string | null;
}

// ---------------------------------------------------------------------------
// Swarm operations
// ---------------------------------------------------------------------------

export type SwarmState = 'uploading' | 'ready' | 'running' | 'paused' | 'returning' | 'completed' | 'aborted' | 'failed';
export type SwarmAction = 'start' | 'pause' | 'resume' | 'rtl' | 'land' | 'end';
export type SwarmMemberState = 'uploaded' | 'upload_failed' | 'flying' | 'waiting' | 'paused' | 'returning' | 'done' | 'detached';

export interface SwarmOptionsDto {
  mode: 'formation' | 'split';
  pattern?: 'line' | 'column' | 'echelon' | 'v' | 'grid';
  spacingM?: number;
  altStepM?: number;
  syncWaypoints?: boolean;
  syncLanding?: boolean;
}

export interface SwarmMemberDto {
  droneId: string;
  name: string;
  /** Formation slot (0 = leader) or route part. */
  slot: number;
  missionId: string | null;
  state: SwarmMemberState;
  /** Synchronisation points passed / total. */
  syncPassed: number;
  syncTotal: number;
  /** Mission item currently flown and the number of items. */
  seq: number;
  total: number;
  message: string | null;
}

export interface SwarmDto {
  id: string;
  name: string;
  baseMissionId: string | null;
  options: SwarmOptionsDto;
  state: SwarmState;
  message: string | null;
  members: SwarmMemberDto[];
  createdBy: string | null;
  createdByName: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface SwarmPreviewMemberDto {
  droneId: string;
  name: string;
  slot: number;
  plan: MissionPlan;
  syncPoints: number[];
  distanceM: number;
  durationS: number;
}

export interface SwarmPreviewDto {
  /** Problems that make the upload fail (e.g. a member's mission above the geofence ceiling). */
  errors: string[];
  members: SwarmPreviewMemberDto[];
  separation: { droneA: string; droneB: string; t: number; distanceM: number; horizontalM: number; verticalM: number } | null;
  durationS: number;
  warnings: string[];
  /** Airspace check of each drone's mission (flown now). */
  airspace: { droneId: string; name: string; verdict: AirspaceCheckDto['verdict']; conflicts: ConflictDto[] }[];
}

// ---------------------------------------------------------------------------
// Notifications (UTM monitoring, drone alerts, swarm operations)
// ---------------------------------------------------------------------------

export type NotificationLevel = 'info' | 'warning' | 'critical';
export type NotificationCategory = 'airspace' | 'traffic' | 'separation' | 'altitude' | 'drone' | 'swarm' | 'maintenance';

export interface NotificationDto {
  id: string;
  createdAt: string;
  level: NotificationLevel;
  category: NotificationCategory;
  code: string;
  droneId: string | null;
  droneName: string | null;
  title: string;
  message: string;
  data: Record<string, unknown> | null;
  /** When the condition ended (live conditions such as "inside a restricted area"). */
  resolvedAt: string | null;
}

export interface NotificationListDto {
  items: NotificationDto[];
  unread: number;
  readUntil: string | null;
}

export type ScheduleStatus = 'scheduled' | 'uploaded' | 'in_progress' | 'completed' | 'cancelled';

export interface ScheduleDto {
  id: string;
  /** Null once the mission has been deleted (a flown schedule stays in the history). */
  missionId: string | null;
  missionName: string;
  droneId: string;
  droneName: string;
  pilotId: string | null;
  pilotName: string | null;
  plannedAt: string;
  status: ScheduleStatus;
  flightId: string | null;
  createdAt: string;
}

export const ZONE_TYPES = [
  'prohibited',
  'restricted',
  'controlled',
  'danger',
  'temporary',
  'hazard_powerline',
  'hazard_obstacle',
] as const;
export type ZoneType = (typeof ZONE_TYPES)[number];

export type ZoneGeometry =
  | { kind: 'polygon'; polygon: LatLon[] }
  | { kind: 'circle'; center: LatLon; radiusM: number }
  | { kind: 'line'; line: LatLon[]; bufferM: number };

export interface AirspaceZoneDto {
  id: string;
  name: string;
  type: ZoneType;
  geometry: ZoneGeometry;
  floorM: number;
  ceilingM: number;
  activeFrom: string | null;
  activeTo: string | null;
  source: string;
  notes: string;
  createdAt: string;
  /** Zones from an external airspace feed cannot be edited or deleted. */
  readOnly: boolean;
}

/** A configured airspace data provider (built-in organisation zones or an external feed). */
export interface AirspaceProviderDto {
  id: string;
  name: string;
  kind: 'builtin' | 'geojson-feed';
  url: string | null;
  /** Zones currently served (null for the per-organisation built-in provider). */
  zoneCount: number | null;
  lastFetchAt: string | null;
  lastError: string | null;
  /** Features of the last download that could not be parsed. */
  skipped: number;
  /** Why features were skipped or simplified in the last download (the first 50). */
  issues: string[];
}

export type AuthGeometry =
  | { kind: 'cylinder'; center: LatLon; radiusM: number }
  | { kind: 'corridor'; line: LatLon[]; widthM: number };

export type AuthorizationStatus = 'pending' | 'approved' | 'rejected' | 'cancelled';

export interface ConflictDto {
  kind: 'zone' | 'reservation' | 'hazard';
  severity: 'blocking' | 'review' | 'advisory';
  id?: string;
  name: string;
  message: string;
}

export interface AuthorizationDto {
  id: string;
  reference: string;
  geometry: AuthGeometry;
  maxAltM: number;
  startAt: string;
  endAt: string;
  status: AuthorizationStatus;
  droneId: string | null;
  droneName: string | null;
  missionId: string | null;
  requestedBy: string | null;
  requesterName: string | null;
  conflicts: ConflictDto[];
  decisionReason: string | null;
  decidedBy: string | null;
  decidedAt: string | null;
  isPublic: boolean;
  createdAt: string;
}

/** Public (unauthenticated) view of an approved airspace reservation. */
export interface PublicReservationDto {
  reference: string;
  operator: string;
  geometry: AuthGeometry;
  maxAltM: number;
  startAt: string;
  endAt: string;
}

export interface AirspaceCheckDto {
  conflicts: ConflictDto[];
  verdict: 'clear' | 'review' | 'blocked';
}

export interface FirmwarePackageDto {
  id: string;
  version: string;
  model: string;
  filename: string;
  size: number;
  sha256: string;
  notes: string;
  createdAt: string;
}

export type FirmwareUpdateStatus = 'pending' | 'sent' | 'downloading' | 'verifying' | 'installing' | 'completed' | 'failed' | 'cancelled';

export interface FirmwareUpdateDto {
  id: string;
  droneId: string;
  droneName: string;
  packageId: string;
  version: string;
  status: FirmwareUpdateStatus;
  progress: number;
  error: string | null;
  createdAt: string;
  updatedAt: string;
}

export const WEBHOOK_EVENTS = [
  'drone.online',
  'drone.offline',
  'flight.started',
  'flight.ended',
  'flight.analyzed',
  'telemetry',
  'alert.raised',
  'authorization.updated',
  'firmware.updated',
  'payload.data',
  'utm.alert',
  'swarm.updated',
] as const;
export type WebhookEvent = (typeof WEBHOOK_EVENTS)[number];

export interface WebhookDto {
  id: string;
  url: string;
  events: WebhookEvent[];
  active: boolean;
  createdAt: string;
  lastStatus: number | null;
  lastDeliveryAt: string | null;
}

export interface WebhookCreatedDto extends WebhookDto {
  /** HMAC secret – shown once. */
  secret: string;
}

export interface WebhookDeliveryDto {
  id: string;
  event: string;
  statusCode: number | null;
  attempts: number;
  delivered: boolean;
  error: string | null;
  createdAt: string;
  deliveredAt: string | null;
}

export interface ApiTokenDto {
  id: string;
  name: string;
  prefix: string;
  orgId: string | null;
  createdAt: string;
  lastUsedAt: string | null;
  expiresAt: string | null;
}

export interface ApiTokenCreatedDto extends ApiTokenDto {
  token: string;
}

/** A logbook connector format (see apps/server/src/integrations/logbook-providers.ts). */
export interface LogbookProviderDto {
  id: string;
  label: string;
  description: string;
}

export interface LogbookIntegrationDto {
  enabled: boolean;
  /** Id of a LogbookProviderDto. */
  provider: string;
  endpointUrl: string;
  autoExport: boolean;
  hasApiKey: boolean;
  lastExportAt: string | null;
  lastStatus: string | null;
}

export interface DashboardTotals {
  drones: number;
  members: number;
  pilots: number;
  flights: number;
  flightTimeS: number;
  distanceM: number;
  avgFlightS: number;
  dronesOnline: number;
  pilotsOnline: number;
  flightsInProgress: number;
  alerts: number;
}

export interface AlertDto {
  flightId: string;
  droneId: string;
  droneName: string;
  severity: 'warning' | 'critical';
  title: string;
  detail: string;
  at: string;
}

export interface DroneStatsDto {
  droneId: string;
  name: string;
  fleetName: string | null;
  flights: number;
  flightTimeS: number;
  distanceM: number;
  lastFlightAt: string | null;
  avgDurationS: number;
  avgHealthScore: number | null;
  pilots: number;
}

export interface OperatorStatsDto {
  userId: string;
  name: string;
  email: string;
  flights: number;
  flightTimeS: number;
  distanceM: number;
  lastFlightAt: string | null;
  dronesFlown: number;
  longestFlightS: number;
}

export interface DashboardDto {
  range: { from: string; to: string };
  fleetId: string | null;
  totals: DashboardTotals;
  flightsPerDay: { date: string; flights: number; flightTimeS: number }[];
  topDrones: DroneStatsDto[];
  topPilots: OperatorStatsDto[];
  recentFlights: FlightDto[];
  alerts: AlertDto[];
}

export interface DronesOperatorsDto {
  range: { from: string; to: string };
  drones: DroneStatsDto[];
  operators: OperatorStatsDto[];
  highlights: {
    mostUsedDrone: DroneStatsDto | null;
    mostExperiencedPilot: OperatorStatsDto | null;
    mostActivePilot: OperatorStatsDto | null;
  };
}

export interface LocationPointDto {
  flightId: string;
  droneId: string;
  droneName: string;
  pilotName: string | null;
  lat: number;
  lon: number;
  startedAt: string;
  durationS: number;
  maxAltM: number;
  compliant: boolean | null;
  violations: string[];
  track: [number, number][];
}

export interface FlightLocationsDto {
  range: { from: string; to: string };
  points: LocationPointDto[];
  summary: { flights: number; compliant: number; nonCompliant: number; unchecked: number };
}

export interface WeatherDto {
  lat: number;
  lon: number;
  time: string;
  temperatureC: number | null;
  windSpeedMs: number | null;
  windGustMs: number | null;
  windDirDeg: number | null;
  precipitationMm: number | null;
  cloudCoverPct: number | null;
  visibilityM: number | null;
  assessment: { status: 'go' | 'caution' | 'no-go'; reasons: string[] };
  source: string;
}

export interface AuditEntryDto {
  id: string;
  userId: string | null;
  userName: string | null;
  action: string;
  target: string | null;
  details: Record<string, unknown>;
  createdAt: string;
}

export interface PayloadRecordDto {
  id: string;
  t: number;
  kind: string;
  data: Record<string, unknown>;
}

export interface PayloadImageDto {
  id: string;
  filename: string;
  capturedAt: string | null;
  lat: number | null;
  lon: number | null;
  altMsl: number | null;
  size: number;
  url: string;
  createdAt: string;
}

export interface ApiErrorBody {
  error: string;
  message: string;
  details?: unknown;
}

// ---------------------------------------------------------------------------
// Maintenance
// ---------------------------------------------------------------------------

export interface MaintenanceTaskDto {
  id: string;
  droneId: string;
  droneName: string;
  name: string;
  intervalHours: number | null;
  intervalFlights: number | null;
  intervalDays: number | null;
  notes: string;
  assigneeId: string | null;
  assigneeName: string | null;
  lastDoneAt: string;
  lastDoneHours: number;
  lastDoneFlights: number;
  due: MaintenanceDue;
}

export interface MaintenanceRecordDto {
  id: string;
  droneId: string;
  taskId: string | null;
  title: string;
  doneAt: string;
  doneBy: string | null;
  doneByName: string | null;
  hours: number;
  flights: number;
  notes: string;
}

export interface DroneMaintenanceDto {
  droneId: string;
  droneName: string;
  usage: { hours: number; flights: number };
  tasks: MaintenanceTaskDto[];
  records: MaintenanceRecordDto[];
  /** Predictive maintenance per health indicator (trend of per-flight metrics). */
  health: HealthPrediction[];
  /** Per-flight metric series (x = cumulative flight hours) behind the predictions. */
  series: Record<string, MetricPoint[]>;
}

export interface MaintenanceOverviewDto {
  drones: {
    droneId: string;
    droneName: string;
    usage: { hours: number; flights: number };
    overdue: number;
    dueSoon: number;
    next: MaintenanceTaskDto | null;
    health: { metric: string; label: string; level: 'ok' | 'watch' | 'action'; remainingHours: number | null }[];
  }[];
  /** Flight hours of the whole fleet (from the flights, not the rounded per-drone figures). */
  fleetHours: number;
  counts: { overdue: number; dueSoon: number; healthActions: number };
}

// ---------------------------------------------------------------------------
// Reports, heatmap and trends
// ---------------------------------------------------------------------------

export const REPORT_SECTIONS = ['summary', 'performance', 'compliance', 'maintenance', 'ai', 'flights'] as const;
export type ReportSection = (typeof REPORT_SECTIONS)[number];

export interface ReportPerformanceRow {
  id: string;
  name: string;
  flights: number;
  hours: number;
  distanceKm: number;
  avgHealth: number | null;
  avgBatteryRatePctPerMin: number | null;
  missionFlights: number;
  routeMeanM: number | null;
  routeOutsidePct: number | null;
  warnings: number;
  criticals: number;
}

export interface ReportFlightRow {
  id: string;
  startedAt: string;
  droneName: string;
  pilotName: string | null;
  missionName: string | null;
  durationMin: number;
  distanceKm: number;
  maxAltM: number;
  batteryUsedPct: number | null;
  healthScore: number | null;
  routeMeanM: number | null;
  routeOutsidePct: number | null;
  issues: string[];
}

export interface ReportDto {
  generatedAt: string;
  range: { from: string; to: string };
  filters: { fleetId: string | null; droneId: string | null; pilotId: string | null };
  sections: ReportSection[];
  summary?: { flights: number; hours: number; distanceKm: number; drones: number; pilots: number; avgDurationMin: number; missionFlights: number; avgHealth: number | null };
  performance?: { byDrone: ReportPerformanceRow[]; byPilot: ReportPerformanceRow[] };
  compliance?: {
    flightsWithIssues: number;
    compliantPct: number;
    issues: { type: string; count: number }[];
    utmAlerts: { code: string; count: number }[];
    overdueMaintenanceFlights: number;
  };
  maintenance?: { overdue: number; dueSoon: number; tasks: { droneName: string; name: string; status: string; remaining: string }[] };
  ai?: { detections: { cls: string; count: number }[]; flightsWithDetections: number };
  flights?: ReportFlightRow[];
}

export interface HeatmapDto {
  cellDeg: number;
  cells: { lat: number; lon: number; count: number }[];
  max: number;
  points: number;
}

export interface TrendDto {
  metric: string;
  label: string;
  unit: string;
  points: { flightId: string; at: string; droneName: string; value: number; z: number; anomaly: boolean }[];
  daily: { day: string; mean: number; n: number }[];
  trend: { slopePerDay: number; r2: number } | null;
}

/** Widgets of the customisable dashboard (the stored layout lists some of them, in order). */
export const DASHBOARD_WIDGETS = ['kpis', 'flights-by-pilot', 'hours-by-pilot', 'flights-by-drone', 'hours-by-drone', 'activity', 'alerts', 'heatmap', 'trends', 'maintenance', 'recent'] as const;
export type DashboardWidgetId = (typeof DASHBOARD_WIDGETS)[number];
