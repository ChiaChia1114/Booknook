/** Ordered schema migrations. Never edit a released migration – append a new one. */
export const MIGRATIONS: string[] = [
  /* 1: initial schema */ `
CREATE TABLE users (
  id TEXT PRIMARY KEY,
  email TEXT NOT NULL UNIQUE COLLATE NOCASE,
  name TEXT NOT NULL,
  password_hash TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE sessions (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  csrf TEXT NOT NULL,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  user_agent TEXT,
  ip TEXT
);
CREATE INDEX sessions_user ON sessions(user_id);

CREATE TABLE password_resets (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires_at TEXT NOT NULL,
  used_at TEXT
);

CREATE TABLE organisations (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  settings TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL
);

CREATE TABLE memberships (
  org_id TEXT NOT NULL REFERENCES organisations(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role TEXT NOT NULL,
  pilot_license TEXT,
  created_at TEXT NOT NULL,
  PRIMARY KEY (org_id, user_id)
);
CREATE INDEX memberships_user ON memberships(user_id);

CREATE TABLE invitations (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL REFERENCES organisations(id) ON DELETE CASCADE,
  email TEXT NOT NULL COLLATE NOCASE,
  role TEXT NOT NULL,
  token_hash TEXT NOT NULL UNIQUE,
  invited_by TEXT REFERENCES users(id) ON DELETE SET NULL,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  accepted_at TEXT
);
CREATE INDEX invitations_org ON invitations(org_id);

CREATE TABLE api_tokens (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  org_id TEXT REFERENCES organisations(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  token_hash TEXT NOT NULL UNIQUE,
  prefix TEXT NOT NULL,
  created_at TEXT NOT NULL,
  last_used_at TEXT,
  expires_at TEXT
);

CREATE TABLE fleets (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL REFERENCES organisations(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL
);
CREATE INDEX fleets_org ON fleets(org_id);

CREATE TABLE drones (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL REFERENCES organisations(id) ON DELETE CASCADE,
  fleet_id TEXT REFERENCES fleets(id) ON DELETE SET NULL,
  name TEXT NOT NULL,
  model TEXT NOT NULL DEFAULT '',
  serial TEXT NOT NULL DEFAULT '',
  notes TEXT NOT NULL DEFAULT '',
  link_key_hash TEXT NOT NULL UNIQUE,
  link_key_prefix TEXT NOT NULL,
  firmware_version TEXT,
  created_at TEXT NOT NULL,
  last_seen_at TEXT,
  last_lat REAL,
  last_lon REAL,
  last_alt REAL
);
CREATE INDEX drones_org ON drones(org_id);

CREATE TABLE missions (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL REFERENCES organisations(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  plan TEXT NOT NULL,
  terrain TEXT,
  created_by TEXT REFERENCES users(id) ON DELETE SET NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX missions_org ON missions(org_id);

CREATE TABLE flights (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL REFERENCES organisations(id) ON DELETE CASCADE,
  drone_id TEXT NOT NULL REFERENCES drones(id) ON DELETE CASCADE,
  pilot_id TEXT REFERENCES users(id) ON DELETE SET NULL,
  mission_id TEXT REFERENCES missions(id) ON DELETE SET NULL,
  source TEXT NOT NULL,
  status TEXT NOT NULL,
  started_at TEXT NOT NULL,
  ended_at TEXT,
  duration_s REAL NOT NULL DEFAULT 0,
  distance_m REAL NOT NULL DEFAULT 0,
  max_alt_m REAL NOT NULL DEFAULT 0,
  max_speed_ms REAL NOT NULL DEFAULT 0,
  battery_start REAL,
  battery_end REAL,
  start_lat REAL,
  start_lon REAL,
  end_lat REAL,
  end_lon REAL,
  takeoff_alt_msl REAL,
  health_score REAL,
  compliance TEXT,
  notes TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL
);
CREATE INDEX flights_org_started ON flights(org_id, started_at);
CREATE INDEX flights_drone ON flights(drone_id, started_at);
CREATE INDEX flights_pilot ON flights(pilot_id);

CREATE TABLE flight_samples (
  flight_id TEXT NOT NULL REFERENCES flights(id) ON DELETE CASCADE,
  t INTEGER NOT NULL,
  lat REAL NOT NULL,
  lon REAL NOT NULL,
  alt_msl REAL NOT NULL,
  alt_rel REAL NOT NULL,
  ground_speed REAL,
  climb_rate REAL,
  heading REAL,
  roll REAL,
  pitch REAL,
  yaw REAL,
  battery_pct REAL,
  voltage REAL,
  current REAL,
  satellites INTEGER,
  hdop REAL,
  mode TEXT,
  armed INTEGER,
  vibration REAL,
  motors TEXT
);
CREATE INDEX flight_samples_flight ON flight_samples(flight_id, t);

CREATE TABLE flight_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  flight_id TEXT NOT NULL REFERENCES flights(id) ON DELETE CASCADE,
  t INTEGER NOT NULL,
  level TEXT NOT NULL,
  code TEXT,
  message TEXT NOT NULL
);
CREATE INDEX flight_events_flight ON flight_events(flight_id, t);

CREATE TABLE flight_files (
  id TEXT PRIMARY KEY,
  flight_id TEXT NOT NULL REFERENCES flights(id) ON DELETE CASCADE,
  org_id TEXT NOT NULL REFERENCES organisations(id) ON DELETE CASCADE,
  kind TEXT NOT NULL,
  filename TEXT NOT NULL,
  size INTEGER NOT NULL,
  sha256 TEXT NOT NULL,
  storage_path TEXT NOT NULL,
  uploaded_by TEXT REFERENCES users(id) ON DELETE SET NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX flight_files_flight ON flight_files(flight_id);

CREATE TABLE flight_analyses (
  flight_id TEXT PRIMARY KEY REFERENCES flights(id) ON DELETE CASCADE,
  score REAL NOT NULL,
  findings TEXT NOT NULL,
  metrics TEXT NOT NULL,
  computed_at TEXT NOT NULL
);

CREATE TABLE payload_records (
  id TEXT PRIMARY KEY,
  flight_id TEXT NOT NULL REFERENCES flights(id) ON DELETE CASCADE,
  t INTEGER NOT NULL,
  kind TEXT NOT NULL,
  data TEXT NOT NULL
);
CREATE INDEX payload_records_flight ON payload_records(flight_id, t);

CREATE TABLE payload_images (
  id TEXT PRIMARY KEY,
  flight_id TEXT NOT NULL REFERENCES flights(id) ON DELETE CASCADE,
  org_id TEXT NOT NULL REFERENCES organisations(id) ON DELETE CASCADE,
  filename TEXT NOT NULL,
  storage_path TEXT NOT NULL,
  size INTEGER NOT NULL,
  mime TEXT NOT NULL,
  captured_at TEXT,
  lat REAL,
  lon REAL,
  alt_msl REAL,
  created_at TEXT NOT NULL
);
CREATE INDEX payload_images_flight ON payload_images(flight_id);

CREATE TABLE schedules (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL REFERENCES organisations(id) ON DELETE CASCADE,
  mission_id TEXT NOT NULL REFERENCES missions(id) ON DELETE CASCADE,
  drone_id TEXT NOT NULL REFERENCES drones(id) ON DELETE CASCADE,
  pilot_id TEXT REFERENCES users(id) ON DELETE SET NULL,
  planned_at TEXT NOT NULL,
  status TEXT NOT NULL,
  flight_id TEXT REFERENCES flights(id) ON DELETE SET NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX schedules_drone ON schedules(drone_id, planned_at);
CREATE INDEX schedules_org ON schedules(org_id, planned_at);

CREATE TABLE airspace_zones (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL REFERENCES organisations(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  type TEXT NOT NULL,
  geometry TEXT NOT NULL,
  floor_m REAL NOT NULL,
  ceiling_m REAL NOT NULL,
  active_from TEXT,
  active_to TEXT,
  source TEXT NOT NULL DEFAULT 'manual',
  notes TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL
);
CREATE INDEX airspace_zones_org ON airspace_zones(org_id);

CREATE TABLE authorizations (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL REFERENCES organisations(id) ON DELETE CASCADE,
  reference TEXT NOT NULL UNIQUE,
  geometry TEXT NOT NULL,
  max_alt_m REAL NOT NULL,
  start_at TEXT NOT NULL,
  end_at TEXT NOT NULL,
  status TEXT NOT NULL,
  drone_id TEXT REFERENCES drones(id) ON DELETE SET NULL,
  mission_id TEXT REFERENCES missions(id) ON DELETE SET NULL,
  requested_by TEXT REFERENCES users(id) ON DELETE SET NULL,
  conflicts TEXT NOT NULL DEFAULT '[]',
  decision_reason TEXT,
  decided_by TEXT REFERENCES users(id) ON DELETE SET NULL,
  decided_at TEXT,
  is_public INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL
);
CREATE INDEX authorizations_window ON authorizations(status, start_at, end_at);
CREATE INDEX authorizations_org ON authorizations(org_id, created_at);

CREATE TABLE firmware_packages (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL REFERENCES organisations(id) ON DELETE CASCADE,
  version TEXT NOT NULL,
  model TEXT NOT NULL DEFAULT '',
  filename TEXT NOT NULL,
  size INTEGER NOT NULL,
  sha256 TEXT NOT NULL,
  storage_path TEXT NOT NULL,
  notes TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL
);

CREATE TABLE firmware_updates (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL REFERENCES organisations(id) ON DELETE CASCADE,
  drone_id TEXT NOT NULL REFERENCES drones(id) ON DELETE CASCADE,
  package_id TEXT NOT NULL REFERENCES firmware_packages(id) ON DELETE CASCADE,
  status TEXT NOT NULL,
  progress REAL NOT NULL DEFAULT 0,
  error TEXT,
  download_token_hash TEXT,
  requested_by TEXT REFERENCES users(id) ON DELETE SET NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX firmware_updates_drone ON firmware_updates(drone_id, status);

CREATE TABLE webhooks (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL REFERENCES organisations(id) ON DELETE CASCADE,
  url TEXT NOT NULL,
  secret TEXT NOT NULL,
  events TEXT NOT NULL,
  active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  last_status INTEGER,
  last_delivery_at TEXT
);
CREATE INDEX webhooks_org ON webhooks(org_id);

CREATE TABLE webhook_deliveries (
  id TEXT PRIMARY KEY,
  webhook_id TEXT NOT NULL REFERENCES webhooks(id) ON DELETE CASCADE,
  event TEXT NOT NULL,
  payload TEXT NOT NULL,
  status_code INTEGER,
  attempts INTEGER NOT NULL DEFAULT 0,
  delivered INTEGER NOT NULL DEFAULT 0,
  error TEXT,
  next_attempt_at TEXT,
  created_at TEXT NOT NULL,
  delivered_at TEXT
);
CREATE INDEX webhook_deliveries_hook ON webhook_deliveries(webhook_id, created_at);
CREATE INDEX webhook_deliveries_pending ON webhook_deliveries(delivered, next_attempt_at);

CREATE TABLE integrations (
  org_id TEXT NOT NULL REFERENCES organisations(id) ON DELETE CASCADE,
  kind TEXT NOT NULL,
  config TEXT NOT NULL,
  secret TEXT,
  last_export_at TEXT,
  last_status TEXT,
  PRIMARY KEY (org_id, kind)
);

CREATE TABLE audit_log (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL REFERENCES organisations(id) ON DELETE CASCADE,
  user_id TEXT REFERENCES users(id) ON DELETE SET NULL,
  action TEXT NOT NULL,
  target TEXT,
  details TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL
);
CREATE INDEX audit_org ON audit_log(org_id, created_at);

CREATE TABLE outbox (
  id TEXT PRIMARY KEY,
  to_addr TEXT NOT NULL,
  subject TEXT NOT NULL,
  body TEXT NOT NULL,
  created_at TEXT NOT NULL
);
`,
];
