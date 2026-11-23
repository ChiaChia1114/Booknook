import { invisibleCodePoints } from '@athena-sky/shared';

/**
 * Migration 12's characters that show nothing (kept as released): white space, control and format characters (zero
 * width space and joiners, byte order mark, soft hyphen, directional marks), Hangul fillers,
 * the blank Braille pattern, combining grapheme joiner and variation selectors.
 */
const V12_INVISIBLE: readonly number[] = [
  ...[0x0, 0x1, 0x2, 0x3, 0x4, 0x5, 0x6, 0x7, 0x8, 0x9, 0xa, 0xb, 0xc, 0xd, 0xe, 0xf, 0x10, 0x11, 0x12, 0x13, 0x14, 0x15, 0x16, 0x17, 0x18, 0x19, 0x1a, 0x1b, 0x1c, 0x1d, 0x1e, 0x1f, 0x20, 0x7f],
  ...Array.from({ length: 0x21 }, (_, i) => 0x80 + i), // C1 controls and no-break space (0x80–0xa0)
  0xad, 0x34f, 0x61c, 0x115f, 0x1160, 0x1680, 0x17b4, 0x17b5, 0x180e,
  ...Array.from({ length: 0x10 }, (_, i) => 0x2000 + i), // en quad … right-to-left mark
  0x2028, 0x2029, 0x202a, 0x202b, 0x202c, 0x202d, 0x202e, 0x202f, 0x205f,
  ...Array.from({ length: 0x10 }, (_, i) => 0x2060 + i).filter((cp) => cp !== 0x2065), // word joiner … nominal digit shapes
  0x2800, 0x3000, 0x3164,
  ...Array.from({ length: 0x10 }, (_, i) => 0xfe00 + i), // variation selectors
  0xfeff, 0xffa0, 0xfff9, 0xfffa, 0xfffb,
];

/** SQLite expression of a set of characters (to trim names with; char() takes up to 100 arguments here). */
const sqlChars = (codePoints: readonly number[]) => {
  const cps = codePoints.filter((cp) => cp > 0);
  const parts: string[] = [];
  for (let i = 0; i < cps.length; i += 100) parts.push(`char(${cps.slice(i, i + 100).join(', ')})`);
  return parts.join(' || ');
};
const INVISIBLE = sqlChars(V12_INVISIBLE);
/** Every character names are cleaned of (`cleanName`). */
const INVISIBLE_ALL = sqlChars(invisibleCodePoints());

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
  /* 2: airframe model of each drone (flight-physics simulation) */ `
ALTER TABLE drones ADD COLUMN airframe_id TEXT;
`,
  // 3: swarm operations and the notification centre (UTM monitoring, drone and swarm alerts).
  `
CREATE TABLE swarm_operations (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL REFERENCES organisations(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  base_mission_id TEXT REFERENCES missions(id) ON DELETE SET NULL,
  options TEXT NOT NULL,
  members TEXT NOT NULL,
  state TEXT NOT NULL,
  message TEXT,
  created_by TEXT REFERENCES users(id) ON DELETE SET NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX idx_swarm_org ON swarm_operations(org_id, created_at);
ALTER TABLE missions ADD COLUMN swarm_id TEXT;

CREATE TABLE notifications (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL REFERENCES organisations(id) ON DELETE CASCADE,
  created_at TEXT NOT NULL,
  level TEXT NOT NULL,
  category TEXT NOT NULL,
  code TEXT NOT NULL,
  drone_id TEXT REFERENCES drones(id) ON DELETE SET NULL,
  title TEXT NOT NULL,
  message TEXT NOT NULL,
  data TEXT,
  resolved_at TEXT
);
CREATE INDEX idx_notifications_org ON notifications(org_id, created_at);

CREATE TABLE notification_reads (
  org_id TEXT NOT NULL REFERENCES organisations(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  read_until TEXT NOT NULL,
  PRIMARY KEY (org_id, user_id)
);
`,
  // 4: maintenance schedules and records, per-user preferences (custom dashboard).
  `
CREATE TABLE maintenance_tasks (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL REFERENCES organisations(id) ON DELETE CASCADE,
  drone_id TEXT NOT NULL REFERENCES drones(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  interval_hours REAL,
  interval_flights INTEGER,
  interval_days REAL,
  notes TEXT NOT NULL DEFAULT '',
  assignee_id TEXT REFERENCES users(id) ON DELETE SET NULL,
  last_done_at TEXT NOT NULL,
  last_done_hours REAL NOT NULL DEFAULT 0,
  last_done_flights INTEGER NOT NULL DEFAULT 0,
  base_at TEXT NOT NULL,
  base_hours REAL NOT NULL DEFAULT 0,
  base_flights INTEGER NOT NULL DEFAULT 0,
  notified_status TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX idx_maint_tasks_drone ON maintenance_tasks(drone_id);

CREATE TABLE maintenance_records (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL REFERENCES organisations(id) ON DELETE CASCADE,
  drone_id TEXT NOT NULL REFERENCES drones(id) ON DELETE CASCADE,
  task_id TEXT REFERENCES maintenance_tasks(id) ON DELETE SET NULL,
  title TEXT NOT NULL,
  done_at TEXT NOT NULL,
  done_by TEXT REFERENCES users(id) ON DELETE SET NULL,
  hours REAL NOT NULL,
  flights INTEGER NOT NULL,
  notes TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL
);
CREATE INDEX idx_maint_records_drone ON maintenance_records(drone_id, done_at);

CREATE TABLE maintenance_alerts (
  drone_id TEXT NOT NULL REFERENCES drones(id) ON DELETE CASCADE,
  key TEXT NOT NULL,
  level TEXT NOT NULL,
  at TEXT NOT NULL,
  PRIMARY KEY (drone_id, key)
);

CREATE TABLE user_preferences (
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  org_id TEXT NOT NULL REFERENCES organisations(id) ON DELETE CASCADE,
  key TEXT NOT NULL,
  value TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (user_id, org_id, key)
);
`,
  // 5: the plan a flight was flown with (a mission can be edited afterwards).
  `
ALTER TABLE flights ADD COLUMN mission_plan TEXT;
`,
  // 6: sign-ups waiting for their e-mail address to be confirmed (the account is created then).
  `
CREATE TABLE pending_signups (
  id TEXT PRIMARY KEY,
  email TEXT NOT NULL,
  name TEXT NOT NULL,
  password_hash TEXT NOT NULL,
  organisation_name TEXT,
  expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX pending_signups_email ON pending_signups (email);
`,
  // 7: the mission loaded on each drone (kept over link drops and server restarts) and when a
  // flight began to fly its mission (a mission can be started in the air).
  `
CREATE TABLE drone_missions (
  drone_id TEXT PRIMARY KEY REFERENCES drones(id) ON DELETE CASCADE,
  mission_id TEXT NOT NULL REFERENCES missions(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  plan TEXT NOT NULL,
  pilot_id TEXT,
  total INTEGER NOT NULL,
  running INTEGER NOT NULL DEFAULT 0,
  uploaded_at TEXT NOT NULL
);
ALTER TABLE flights ADD COLUMN mission_started_at INTEGER;
`,
  // 8: where a loaded mission was started in the air (its route starts there).
  `
ALTER TABLE drone_missions ADD COLUMN start TEXT;
`,
  // 9: a loaded mission sent with its blocked airspace check overridden (its start is not checked
  // again), and the geofences a drone enforced during a flight (for the compliance check).
  `
ALTER TABLE drone_missions ADD COLUMN airspace_accepted INTEGER NOT NULL DEFAULT 0;
ALTER TABLE flights ADD COLUMN geofence TEXT;
`,
  // 10: flown schedules outlive their mission (history): the mission becomes optional and its name
  // is kept with the schedule.
  `
CREATE TABLE schedules_new (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL REFERENCES organisations(id) ON DELETE CASCADE,
  mission_id TEXT REFERENCES missions(id) ON DELETE SET NULL,
  mission_name TEXT NOT NULL DEFAULT '',
  drone_id TEXT NOT NULL REFERENCES drones(id) ON DELETE CASCADE,
  pilot_id TEXT REFERENCES users(id) ON DELETE SET NULL,
  planned_at TEXT NOT NULL,
  status TEXT NOT NULL,
  flight_id TEXT REFERENCES flights(id) ON DELETE SET NULL,
  created_at TEXT NOT NULL
);
INSERT INTO schedules_new (id, org_id, mission_id, mission_name, drone_id, pilot_id, planned_at, status, flight_id, created_at)
  SELECT s.id, s.org_id, s.mission_id, COALESCE(m.name, ''), s.drone_id, s.pilot_id, s.planned_at, s.status, s.flight_id, s.created_at
    FROM schedules s LEFT JOIN missions m ON m.id = s.mission_id;
DROP TABLE schedules;
ALTER TABLE schedules_new RENAME TO schedules;
CREATE INDEX schedules_drone ON schedules(drone_id, planned_at);
CREATE INDEX schedules_org ON schedules(org_id, planned_at);
`,
  // 11: names made of spaces alone were once accepted (and stored empty): give them a name.
  `
UPDATE users SET name = CASE WHEN instr(email, '@') > 1 THEN substr(email, 1, instr(email, '@') - 1) ELSE 'User' END WHERE trim(name, ' ' || char(9) || char(10) || char(13)) = '';
UPDATE organisations SET name = 'Unnamed organisation' WHERE trim(name, ' ' || char(9) || char(10) || char(13)) = '';
UPDATE api_tokens SET name = 'API token' WHERE trim(name, ' ' || char(9) || char(10) || char(13)) = '';
UPDATE fleets SET name = 'Unnamed fleet' WHERE trim(name, ' ' || char(9) || char(10) || char(13)) = '';
UPDATE drones SET name = 'Unnamed drone' WHERE trim(name, ' ' || char(9) || char(10) || char(13)) = '';
UPDATE missions SET name = 'Unnamed mission' WHERE trim(name, ' ' || char(9) || char(10) || char(13)) = '';
UPDATE airspace_zones SET name = 'Unnamed zone' WHERE trim(name, ' ' || char(9) || char(10) || char(13)) = '';
UPDATE swarm_operations SET name = 'Swarm operation' WHERE trim(name, ' ' || char(9) || char(10) || char(13)) = '';
UPDATE maintenance_tasks SET name = 'Maintenance task' WHERE trim(name, ' ' || char(9) || char(10) || char(13)) = '';
UPDATE maintenance_records SET title = 'Maintenance' WHERE trim(title, ' ' || char(9) || char(10) || char(13)) = '';
`,
  // 12: names made of invisible characters alone (zero-width spaces …) were once accepted too.
  `
UPDATE users SET name = CASE WHEN instr(email, '@') > 1 THEN substr(email, 1, instr(email, '@') - 1) ELSE 'User' END WHERE trim(name, ${INVISIBLE}) = '';
UPDATE organisations SET name = 'Unnamed organisation' WHERE trim(name, ${INVISIBLE}) = '';
UPDATE api_tokens SET name = 'API token' WHERE trim(name, ${INVISIBLE}) = '';
UPDATE fleets SET name = 'Unnamed fleet' WHERE trim(name, ${INVISIBLE}) = '';
UPDATE drones SET name = 'Unnamed drone' WHERE trim(name, ${INVISIBLE}) = '';
UPDATE missions SET name = 'Unnamed mission' WHERE trim(name, ${INVISIBLE}) = '';
UPDATE airspace_zones SET name = 'Unnamed zone' WHERE trim(name, ${INVISIBLE}) = '';
UPDATE swarm_operations SET name = 'Swarm operation' WHERE trim(name, ${INVISIBLE}) = '';
UPDATE maintenance_tasks SET name = 'Maintenance task' WHERE trim(name, ${INVISIBLE}) = '';
UPDATE maintenance_records SET title = 'Maintenance' WHERE trim(title, ${INVISIBLE}) = '';
`,
  // 13: names made of the other invisible characters (tag characters, supplementary variation
  // selectors …), and line zones without a width (they covered nothing).
  `
UPDATE users SET name = CASE WHEN instr(email, '@') > 1 THEN substr(email, 1, instr(email, '@') - 1) ELSE 'User' END WHERE trim(name, ${INVISIBLE_ALL}) = '';
UPDATE organisations SET name = 'Unnamed organisation' WHERE trim(name, ${INVISIBLE_ALL}) = '';
UPDATE api_tokens SET name = 'API token' WHERE trim(name, ${INVISIBLE_ALL}) = '';
UPDATE fleets SET name = 'Unnamed fleet' WHERE trim(name, ${INVISIBLE_ALL}) = '';
UPDATE drones SET name = 'Unnamed drone' WHERE trim(name, ${INVISIBLE_ALL}) = '';
UPDATE missions SET name = 'Unnamed mission' WHERE trim(name, ${INVISIBLE_ALL}) = '';
UPDATE airspace_zones SET name = 'Unnamed zone' WHERE trim(name, ${INVISIBLE_ALL}) = '';
UPDATE swarm_operations SET name = 'Swarm operation' WHERE trim(name, ${INVISIBLE_ALL}) = '';
UPDATE maintenance_tasks SET name = 'Maintenance task' WHERE trim(name, ${INVISIBLE_ALL}) = '';
UPDATE maintenance_records SET title = 'Maintenance' WHERE trim(title, ${INVISIBLE_ALL}) = '';
UPDATE airspace_zones SET geometry = json_set(geometry, '$.bufferM', 1) WHERE json_extract(geometry, '$.kind') = 'line' AND json_extract(geometry, '$.bufferM') < 1;
`,
  // 14: when an authorisation was approved and when it was cancelled – it covers flights (and
  // reserves the airspace) in between, also after it was cancelled. Cancelled ones of before
  // lost their approval time (the cancellation overwrote it): they cover nothing.
  `
ALTER TABLE authorizations ADD COLUMN approved_at TEXT;
ALTER TABLE authorizations ADD COLUMN cancelled_at TEXT;
UPDATE authorizations SET approved_at = decided_at WHERE status = 'approved';
`,
  // 15: a preview of each flight's track (up to 100 points, for the flight map), stored when the
  // flight is finalised – older flights get theirs the first time the map shows them.
  `
ALTER TABLE flights ADD COLUMN track_preview TEXT;
`,
  // 16: who cancelled an authorisation, kept apart from who approved it. A cancellation used to
  // take the place of the decision: it is moved where it belongs (the approver is not known).
  `
ALTER TABLE authorizations ADD COLUMN cancelled_by TEXT;
UPDATE authorizations SET cancelled_by = decided_by, cancelled_at = COALESCE(cancelled_at, decided_at) WHERE status = 'cancelled';
UPDATE authorizations SET decided_by = NULL, decided_at = approved_at, decision_reason = NULL WHERE status = 'cancelled' AND decision_reason LIKE 'Cancelled by %';
`,
  // 17: requests decided by an external flight authority (UTM service): which one, its id of the
  // flight plan, where the exchange stands, its last error and its public page of the
  // reservation; and why a request was cancelled when the authority withdrew it.
  `
ALTER TABLE authorizations ADD COLUMN authority TEXT;
ALTER TABLE authorizations ADD COLUMN authority_ref TEXT;
ALTER TABLE authorizations ADD COLUMN authority_state TEXT;
ALTER TABLE authorizations ADD COLUMN authority_error TEXT;
ALTER TABLE authorizations ADD COLUMN authority_url TEXT;
ALTER TABLE authorizations ADD COLUMN cancel_reason TEXT;
CREATE INDEX authorizations_authority ON authorizations(authority, authority_state);
`,
  // 18: the external authority is known by its address (renaming it keeps the open exchanges),
  // and whether a submission was sent (its plan is withdrawn even when the answer was lost).
  `
ALTER TABLE authorizations ADD COLUMN authority_id TEXT;
ALTER TABLE authorizations ADD COLUMN authority_sent INTEGER NOT NULL DEFAULT 0;
UPDATE authorizations SET authority_sent = 1 WHERE authority_ref IS NOT NULL;
CREATE INDEX authorizations_authority_open ON authorizations(authority_id, authority_state, created_at, id);
`,
];
