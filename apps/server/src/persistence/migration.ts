export const migration1 = `
CREATE TABLE service_runs (
 id TEXT PRIMARY KEY, started_at INTEGER NOT NULL, ready_at INTEGER, last_heartbeat_at INTEGER NOT NULL,
 stopped_at INTEGER, stop_reason TEXT, config_fingerprint TEXT NOT NULL
) STRICT;
CREATE TABLE check_commit_clock(id INTEGER PRIMARY KEY CHECK(id=1),value INTEGER NOT NULL CHECK(value>=0)) STRICT;
INSERT INTO check_commit_clock VALUES(1,0);
CREATE TABLE monitors (
 id TEXT PRIMARY KEY, name TEXT NOT NULL CHECK(length(name) BETWEEN 1 AND 120), url TEXT NOT NULL CHECK(length(url)<=2048),
 method TEXT NOT NULL CHECK(method IN ('GET','HEAD')), expected_status_codes_json TEXT NOT NULL CHECK(json_valid(expected_status_codes_json)),
 interval_ms INTEGER NOT NULL CHECK(interval_ms BETWEEN 15000 AND 3600000), timeout_ms INTEGER NOT NULL CHECK(timeout_ms BETWEEN 1000 AND 30000),
 follow_redirects INTEGER NOT NULL CHECK(follow_redirects IN (0,1)), enabled INTEGER NOT NULL CHECK(enabled IN(0,1)),
 failure_threshold INTEGER NOT NULL CHECK(failure_threshold BETWEEN 1 AND 10), recovery_threshold INTEGER NOT NULL CHECK(recovery_threshold BETWEEN 1 AND 10),
 latency_threshold_ms INTEGER NOT NULL CHECK(latency_threshold_ms BETWEEN 1 AND 30000), degradation_threshold INTEGER NOT NULL CHECK(degradation_threshold BETWEEN 1 AND 10),
 revision INTEGER NOT NULL CHECK(revision>0), execution_epoch INTEGER NOT NULL CHECK(execution_epoch>0),
 created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, next_due_at INTEGER,
 CHECK((enabled=0 AND next_due_at IS NULL) OR (enabled=1 AND next_due_at IS NOT NULL))
) STRICT;
CREATE TABLE checks (
 sequence INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT UNIQUE NOT NULL,
 monitor_id TEXT NOT NULL REFERENCES monitors(id) ON DELETE CASCADE,
 service_run_id TEXT NOT NULL REFERENCES service_runs(id) ON DELETE RESTRICT,
 monitor_revision INTEGER NOT NULL CHECK(monitor_revision>0), execution_epoch INTEGER NOT NULL CHECK(execution_epoch>0),
 trigger TEXT NOT NULL CHECK(trigger IN('automatic','manual')),
 lifecycle TEXT NOT NULL CHECK(lifecycle IN('QUEUED','RUNNING','COMPLETED','CANCELLED','ABANDONED')),
 queued_at INTEGER NOT NULL, scheduled_at INTEGER, started_at INTEGER, completed_at INTEGER,
 outcome TEXT CHECK(outcome IN('SUCCESS','HTTP_ERROR','DNS_ERROR','TLS_ERROR','CONNECTION_ERROR','TIMEOUT','REDIRECT_ERROR','POLICY_BLOCKED')),
 http_status INTEGER CHECK(http_status BETWEEN 100 AND 599), duration_ms REAL CHECK(duration_ms>=0),
 redirect_count INTEGER NOT NULL DEFAULT 0 CHECK(redirect_count BETWEEN 0 AND 3), error_code TEXT, terminal_order INTEGER CHECK(terminal_order>0),
 CHECK((lifecycle IN('QUEUED','RUNNING') AND terminal_order IS NULL) OR (lifecycle IN('COMPLETED','CANCELLED','ABANDONED') AND terminal_order IS NOT NULL)),
 CHECK((lifecycle IN('QUEUED','RUNNING') AND completed_at IS NULL AND outcome IS NULL AND duration_ms IS NULL AND http_status IS NULL)
    OR (lifecycle='COMPLETED' AND completed_at IS NOT NULL AND started_at IS NOT NULL AND outcome IS NOT NULL AND duration_ms IS NOT NULL)
    OR (lifecycle IN('CANCELLED','ABANDONED') AND completed_at IS NOT NULL AND outcome IS NULL AND duration_ms IS NULL AND http_status IS NULL)),
 CHECK(lifecycle!='RUNNING' OR started_at IS NOT NULL),
 CHECK(started_at IS NULL OR started_at>=queued_at), CHECK(completed_at IS NULL OR completed_at>=coalesce(started_at,queued_at))
) STRICT;
CREATE UNIQUE INDEX checks_one_unsettled ON checks(monitor_id) WHERE lifecycle IN('QUEUED','RUNNING');
CREATE INDEX monitors_due ON monitors(next_due_at,id) WHERE enabled=1;
CREATE INDEX checks_monitor_sequence ON checks(monitor_id,sequence DESC);
CREATE INDEX checks_monitor_started ON checks(monitor_id,started_at,sequence);
CREATE INDEX checks_retention ON checks(completed_at) WHERE lifecycle IN('COMPLETED','CANCELLED','ABANDONED');
CREATE INDEX checks_service_run ON checks(service_run_id);
`;
export const migration2 = `
ALTER TABLE checks ADD COLUMN slow_success INTEGER CHECK(slow_success IN(0,1));
CREATE TABLE reliability_meta (
 id INTEGER PRIMARY KEY CHECK(id=1), coverage_from INTEGER, checks_from INTEGER, incidents_from INTEGER
) STRICT;
INSERT INTO reliability_meta VALUES(1,NULL,NULL,NULL);
CREATE TABLE monitor_status (
 monitor_id TEXT PRIMARY KEY REFERENCES monitors(id) ON DELETE CASCADE,
 state TEXT NOT NULL CHECK(state IN('UNKNOWN','UP','DEGRADED','DOWN')), reason TEXT NOT NULL,
 consecutive_failures INTEGER NOT NULL DEFAULT 0 CHECK(consecutive_failures BETWEEN 0 AND 10),
 consecutive_successes INTEGER NOT NULL DEFAULT 0 CHECK(consecutive_successes BETWEEN 0 AND 10),
 consecutive_slow INTEGER NOT NULL DEFAULT 0 CHECK(consecutive_slow BETWEEN 0 AND 10),
 consecutive_fast INTEGER NOT NULL DEFAULT 0 CHECK(consecutive_fast BETWEEN 0 AND 10),
 failure_run_started_at INTEGER, recovery_run_started_at INTEGER,
 last_check_id TEXT REFERENCES checks(id) ON DELETE SET NULL,
 first_observation_at INTEGER,
 state_changed_at INTEGER NOT NULL,
 open_incident_id TEXT REFERENCES incidents(id) ON DELETE SET NULL DEFERRABLE INITIALLY DEFERRED,
 CHECK(state!='DOWN' OR open_incident_id IS NOT NULL)
) STRICT;
CREATE TABLE monitor_activity_windows (
 id TEXT PRIMARY KEY,monitor_id TEXT NOT NULL REFERENCES monitors(id) ON DELETE CASCADE,
 enabled_at INTEGER NOT NULL, disabled_at INTEGER CHECK(disabled_at>=enabled_at)
) STRICT;
CREATE UNIQUE INDEX activity_one_open ON monitor_activity_windows(monitor_id) WHERE disabled_at IS NULL;
CREATE INDEX activity_monitor_time ON monitor_activity_windows(monitor_id,enabled_at);
CREATE TABLE state_transitions (
 sequence INTEGER PRIMARY KEY AUTOINCREMENT,id TEXT UNIQUE NOT NULL,
 monitor_id TEXT NOT NULL REFERENCES monitors(id) ON DELETE CASCADE,
 from_state TEXT NOT NULL CHECK(from_state IN('UNKNOWN','UP','DEGRADED','DOWN')),
 to_state TEXT NOT NULL CHECK(to_state IN('UNKNOWN','UP','DEGRADED','DOWN')),
 reason TEXT NOT NULL,occurred_at INTEGER NOT NULL,check_id TEXT REFERENCES checks(id) ON DELETE SET NULL,
 monitor_revision INTEGER NOT NULL,execution_epoch INTEGER NOT NULL,CHECK(from_state!=to_state)
) STRICT;
CREATE TABLE incidents (
 id TEXT PRIMARY KEY, monitor_id TEXT NOT NULL REFERENCES monitors(id) ON DELETE CASCADE,
 monitor_revision INTEGER NOT NULL,status TEXT NOT NULL CHECK(status IN('OPEN','RESOLVED')),
 opened_at INTEGER NOT NULL,detected_at INTEGER NOT NULL CHECK(detected_at>=opened_at),
 observed_end_at INTEGER CHECK(observed_end_at>=opened_at),resolved_at INTEGER CHECK(resolved_at>=observed_end_at),
 opening_check_id TEXT REFERENCES checks(id) ON DELETE SET NULL,resolving_check_id TEXT REFERENCES checks(id) ON DELETE SET NULL,
 opening_transition_id TEXT NOT NULL REFERENCES state_transitions(id) DEFERRABLE INITIALLY DEFERRED,
 resolving_transition_id TEXT REFERENCES state_transitions(id) DEFERRABLE INITIALLY DEFERRED,
 failure_category TEXT NOT NULL CHECK(failure_category IN('HTTP_ERROR','DNS_ERROR','TLS_ERROR','CONNECTION_ERROR','TIMEOUT','REDIRECT_ERROR')),
 diagnostic_summary TEXT NOT NULL,
 CHECK((status='OPEN' AND observed_end_at IS NULL AND resolved_at IS NULL AND resolving_transition_id IS NULL)
 OR (status='RESOLVED' AND observed_end_at IS NOT NULL AND resolved_at IS NOT NULL AND resolving_transition_id IS NOT NULL))
) STRICT;
CREATE UNIQUE INDEX incidents_one_open ON incidents(monitor_id) WHERE status='OPEN';
CREATE INDEX incidents_monitor_time ON incidents(monitor_id,opened_at,id);
CREATE INDEX incidents_detected ON incidents(detected_at,id);
CREATE INDEX incidents_resolved ON incidents(resolved_at) WHERE status='RESOLVED';
CREATE INDEX transitions_monitor_time ON state_transitions(monitor_id,occurred_at,sequence);
CREATE INDEX transitions_retention ON state_transitions(occurred_at);
CREATE INDEX service_runs_coverage ON service_runs(ready_at,stopped_at);
CREATE INDEX checks_queued ON checks(queued_at,id) WHERE lifecycle='QUEUED';
CREATE INDEX checks_cancelled ON checks(id) WHERE lifecycle='CANCELLED';
CREATE INDEX checks_abandoned ON checks(id) WHERE lifecycle='ABANDONED';
CREATE INDEX status_open_incident ON monitor_status(open_incident_id) WHERE open_incident_id IS NOT NULL;
CREATE INDEX status_check ON monitor_status(last_check_id) WHERE last_check_id IS NOT NULL;
CREATE INDEX transitions_check ON state_transitions(check_id) WHERE check_id IS NOT NULL;
CREATE INDEX incidents_opening_check ON incidents(opening_check_id) WHERE opening_check_id IS NOT NULL;
CREATE INDEX incidents_resolving_check ON incidents(resolving_check_id) WHERE resolving_check_id IS NOT NULL;
CREATE INDEX incidents_opening_transition ON incidents(opening_transition_id);
CREATE INDEX incidents_resolving_transition ON incidents(resolving_transition_id) WHERE resolving_transition_id IS NOT NULL;
`;
export const migration3 = `
CREATE TABLE notification_destinations (
 id TEXT PRIMARY KEY,name TEXT NOT NULL CHECK(length(name) BETWEEN 1 AND 120),enabled INTEGER NOT NULL CHECK(enabled IN(0,1)),
 url_secret_ref TEXT NOT NULL CHECK(length(url_secret_ref) BETWEEN 1 AND 64),signing_secret_ref TEXT,
 revision INTEGER NOT NULL CHECK(revision>0),created_at INTEGER NOT NULL,updated_at INTEGER NOT NULL
) STRICT;
CREATE TABLE notification_deliveries (
 sequence INTEGER PRIMARY KEY AUTOINCREMENT,id TEXT UNIQUE NOT NULL,event_id TEXT NOT NULL,
 destination_id TEXT NOT NULL REFERENCES notification_destinations(id) ON DELETE CASCADE,
 incident_id TEXT REFERENCES incidents(id) ON DELETE CASCADE,destination_revision INTEGER NOT NULL CHECK(destination_revision>0),
 event_type TEXT NOT NULL CHECK(event_type IN('incident.opened','incident.resolved','notification.test')),
 payload_json TEXT NOT NULL CHECK(json_valid(payload_json) AND length(CAST(payload_json AS BLOB))<=16384),
 state TEXT NOT NULL CHECK(state IN('PENDING','IN_FLIGHT','SUCCEEDED','DEAD','CANCELLED')),
 attempt_count INTEGER NOT NULL DEFAULT 0 CHECK(attempt_count BETWEEN 0 AND 5),next_attempt_at INTEGER,claimed_at INTEGER,
 last_http_status INTEGER CHECK(last_http_status BETWEEN 100 AND 599),last_error_code TEXT,created_at INTEGER NOT NULL,updated_at INTEGER NOT NULL,finished_at INTEGER,
 CHECK((state IN('PENDING','IN_FLIGHT') AND finished_at IS NULL) OR (state IN('SUCCEEDED','DEAD','CANCELLED') AND finished_at IS NOT NULL)),
 CHECK(state!='PENDING' OR (next_attempt_at IS NOT NULL AND attempt_count<5)),CHECK(state!='IN_FLIGHT' OR (claimed_at IS NOT NULL AND attempt_count>0)),
 CHECK((event_type='notification.test' AND incident_id IS NULL) OR (event_type!='notification.test' AND incident_id IS NOT NULL))
) STRICT;
CREATE UNIQUE INDEX delivery_event_destination ON notification_deliveries(event_id,destination_id);
CREATE UNIQUE INDEX delivery_one_inflight ON notification_deliveries(destination_id) WHERE state='IN_FLIGHT';
CREATE INDEX deliveries_due ON notification_deliveries(next_attempt_at,id) WHERE state='PENDING';
CREATE INDEX deliveries_finished ON notification_deliveries(finished_at) WHERE state IN('SUCCEEDED','DEAD','CANCELLED');
CREATE INDEX deliveries_incident ON notification_deliveries(incident_id);
CREATE INDEX deliveries_destination ON notification_deliveries(destination_id,sequence);
CREATE INDEX checks_dashboard ON checks(started_at) WHERE lifecycle='COMPLETED' AND outcome!='POLICY_BLOCKED';
`;

// These exact definitions are part of migration 4's immutable checksum.
export const checksSchema3 = `CREATE TABLE checks (
 sequence INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT UNIQUE NOT NULL,
 monitor_id TEXT NOT NULL REFERENCES monitors(id) ON DELETE CASCADE,
 service_run_id TEXT NOT NULL REFERENCES service_runs(id) ON DELETE RESTRICT,
 monitor_revision INTEGER NOT NULL CHECK(monitor_revision>0), execution_epoch INTEGER NOT NULL CHECK(execution_epoch>0),
 trigger TEXT NOT NULL CHECK(trigger IN('automatic','manual')),
 lifecycle TEXT NOT NULL CHECK(lifecycle IN('QUEUED','RUNNING','COMPLETED','CANCELLED','ABANDONED')),
 queued_at INTEGER NOT NULL, scheduled_at INTEGER, started_at INTEGER, completed_at INTEGER,
 outcome TEXT CHECK(outcome IN('SUCCESS','HTTP_ERROR','DNS_ERROR','TLS_ERROR','CONNECTION_ERROR','TIMEOUT','REDIRECT_ERROR','POLICY_BLOCKED')),
 http_status INTEGER CHECK(http_status BETWEEN 100 AND 599), duration_ms REAL CHECK(duration_ms>=0),
 redirect_count INTEGER NOT NULL DEFAULT 0 CHECK(redirect_count BETWEEN 0 AND 3), error_code TEXT, terminal_order INTEGER CHECK(terminal_order>0), slow_success INTEGER CHECK(slow_success IN(0,1)),
 CHECK((lifecycle IN('QUEUED','RUNNING') AND terminal_order IS NULL) OR (lifecycle IN('COMPLETED','CANCELLED','ABANDONED') AND terminal_order IS NOT NULL)),
 CHECK((lifecycle IN('QUEUED','RUNNING') AND completed_at IS NULL AND outcome IS NULL AND duration_ms IS NULL AND http_status IS NULL)
    OR (lifecycle='COMPLETED' AND completed_at IS NOT NULL AND started_at IS NOT NULL AND outcome IS NOT NULL AND duration_ms IS NOT NULL)
    OR (lifecycle IN('CANCELLED','ABANDONED') AND completed_at IS NOT NULL AND outcome IS NULL AND duration_ms IS NULL AND http_status IS NULL)),
 CHECK(lifecycle!='RUNNING' OR started_at IS NOT NULL),
 CHECK(started_at IS NULL OR started_at>=queued_at), CHECK(completed_at IS NULL OR completed_at>=coalesce(started_at,queued_at))
) STRICT`;
export const checksSchema4 = `CREATE TABLE checks (
 sequence INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT UNIQUE NOT NULL,
 monitor_id TEXT NOT NULL REFERENCES monitors(id) ON DELETE CASCADE,
 service_run_id TEXT NOT NULL REFERENCES service_runs(id) ON DELETE RESTRICT,
 monitor_revision INTEGER NOT NULL CHECK(monitor_revision>0), execution_epoch INTEGER NOT NULL CHECK(execution_epoch>0),
 trigger TEXT NOT NULL CHECK((trigger='automatic' OR trigger='manual')),
 lifecycle TEXT NOT NULL CHECK((lifecycle='QUEUED' OR lifecycle='RUNNING' OR lifecycle='COMPLETED' OR lifecycle='CANCELLED' OR lifecycle='ABANDONED')),
 queued_at INTEGER NOT NULL, scheduled_at INTEGER, started_at INTEGER, completed_at INTEGER,
 outcome TEXT CHECK((outcome='SUCCESS' OR outcome='HTTP_ERROR' OR outcome='DNS_ERROR' OR outcome='TLS_ERROR' OR outcome='CONNECTION_ERROR' OR outcome='TIMEOUT' OR outcome='REDIRECT_ERROR' OR outcome='POLICY_BLOCKED')),
 http_status INTEGER CHECK(http_status BETWEEN 100 AND 599), duration_ms REAL CHECK(duration_ms>=0),
 redirect_count INTEGER NOT NULL DEFAULT 0 CHECK(redirect_count BETWEEN 0 AND 3), error_code TEXT, terminal_order INTEGER CHECK(terminal_order>0), slow_success INTEGER CHECK((slow_success=0 OR slow_success=1)),
 CHECK(((lifecycle='QUEUED' OR lifecycle='RUNNING') AND terminal_order IS NULL) OR ((lifecycle='COMPLETED' OR lifecycle='CANCELLED' OR lifecycle='ABANDONED') AND terminal_order IS NOT NULL)),
 CHECK(((lifecycle='QUEUED' OR lifecycle='RUNNING') AND completed_at IS NULL AND outcome IS NULL AND duration_ms IS NULL AND http_status IS NULL)
    OR (lifecycle='COMPLETED' AND completed_at IS NOT NULL AND started_at IS NOT NULL AND outcome IS NOT NULL AND duration_ms IS NOT NULL)
    OR ((lifecycle='CANCELLED' OR lifecycle='ABANDONED') AND completed_at IS NOT NULL AND outcome IS NULL AND duration_ms IS NULL AND http_status IS NULL)),
 CHECK(lifecycle!='RUNNING' OR started_at IS NOT NULL),
 CHECK(started_at IS NULL OR started_at>=queued_at), CHECK(completed_at IS NULL OR completed_at>=coalesce(started_at,queued_at))
) STRICT`;
export const migration4 = `UPDATE sqlite_schema SET sql='${checksSchema4.replaceAll("'", "''")}' WHERE type='table' AND name='checks' AND sql='${checksSchema3.replaceAll("'", "''")}';`;

// Preserve the existing seek prefixes while avoiding large-history table lookups for analytics.
export const migration5 = `
DROP INDEX checks_monitor_started;
CREATE INDEX checks_monitor_started ON checks(monitor_id,started_at,sequence,completed_at,outcome,duration_ms,slow_success,lifecycle);
DROP INDEX checks_dashboard;
CREATE INDEX checks_dashboard ON checks(started_at,outcome,duration_ms) WHERE lifecycle='COMPLETED' AND outcome!='POLICY_BLOCKED';
`;
