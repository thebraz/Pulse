# Pulse database and persistence

Use one local SQLite file under the configured data directory, owned by one dedicated worker. No network filesystem, shared cloud-sync folder or concurrent Pulse process is supported. [ADRs](ARCHITECTURAL-DECISIONS.md) record the runtime/adapter decision; the implementation must verify the selected Node.js SQLite API and bundled SQLite patch version rather than assume support from a major version alone.

## Physical representation and schema

All application tables use SQLite STRICT mode. IDs are TEXT UUIDs, instants INTEGER epoch milliseconds, durations REAL with nonnegative finite application validation, booleans INTEGER CHECK IN(0, 1), enums TEXT CHECK allowlists, counters INTEGER CHECK>=0, and bounded JSON TEXT validated before insertion. Fields map one-to-one to [domain models](03-DOMAIN-MODELS.md), including the additional internal relationships below. NOT NULL is required unless the domain field is nullable. Public camelCase fields map mechanically to snake_case. Computed DTO fields such as urlConfigured, signingConfigured and duration summaries are not stored columns.

| Table / introduced stage | Stored columns and keys |
| --- | --- |
| schema_migrations /1 | version INTEGER PK, checksum TEXT, applied_at INTEGER; immutable applied checksum. |
| check_commit_clock /1 | singleton id=1 and monotonically increasing value; durable snapshot watermark, retained across explicit monitor deletion and future pruning. |
| service_runs /1 | id TEXT PK, started_at, ready_at nullable, last_heartbeat_at, stopped_at nullable, stop_reason nullable, config_fingerprint TEXT. Stage 1 tracks lifecycle; Stage 2 uses coverage. |
| monitors /1 | id PK; name, url, method, expected_status_codes_json, interval_ms, timeout_ms, follow_redirects, enabled, failure_threshold, recovery_threshold, latency_threshold_ms, degradation_threshold, revision, execution_epoch, created_at, updated_at, next_due_at nullable. |
| checks /1 | sequence INTEGER PK AUTOINCREMENT, id TEXT UNIQUE; monitor_id, service_run_id FKs; monitor_revision, execution_epoch, trigger, lifecycle, queued_at, scheduled_at nullable, started_at nullable, completed_at nullable, outcome nullable, http_status nullable, duration_ms nullable, redirect_count, error_code nullable; terminal_order nullable only while unsettled, allocated from check_commit_clock in the terminal transaction. |
| monitor_status /2 | monitor_id PK/FK; state, reason, consecutive_failures, consecutive_successes, consecutive_slow, consecutive_fast, failure_run_started_at nullable, recovery_run_started_at nullable, last_check_id nullable, state_changed_at, open_incident_id nullable. |
| monitor_activity_windows /2 | id PK, monitor_id FK, enabled_at, disabled_at nullable; non-overlapping enabled windows. |
| state_transitions /2 | sequence INTEGER PK AUTOINCREMENT, id TEXT UNIQUE; monitor_id FK, from_state, to_state, reason, occurred_at, check_id nullable, monitor_revision, execution_epoch. |
| incidents /2 | id PK, monitor_id FK, monitor_revision, status, opened_at, detected_at, observed_end_at nullable, resolved_at nullable, opening_check_id nullable, resolving_check_id nullable, opening_transition_id, resolving_transition_id nullable. |
| notification_destinations /3 | id PK, name, enabled, url_secret_ref, signing_secret_ref nullable, revision, created_at, updated_at. References are aliases, not plaintext secret values. |
| notification_deliveries /3 | id PK, event_id, destination_id FK, incident_id FK, destination_revision, event_type, payload_json, state, attempt_count, next_attempt_at nullable, claimed_at nullable, last_http_status nullable, last_error_code nullable, created_at, updated_at, finished_at nullable. |

Migration SQL must encode domain bounds with CHECK where SQLite can express them: monitor interval/timeout/threshold ranges, valid states, resolved incident timestamp presence and ordering, terminal check completion, lifecycle/outcome consistency and nonnegative duration. Cross-row overlap and state/incident relationships require transaction checks in addition to FKs. Monitors do not store the public nested status object; it is joined from monitor_status or returned UNKNOWN in Stage 1.

Foreign keys: monitor-owned rows ON DELETE CASCADE. Check evidence references from status/incidents/transitions ON DELETE SET NULL to permit raw retention. Incident transition anchors use ON DELETE NO ACTION and DEFERRABLE INITIALLY DEFERRED; keep them while the incident exists. monitor_status.open_incident_id is nullable, deferred and SET NULL on incident deletion; application transactions must preserve DOWN implies open incident. Delivery incident/destination relationships use ON DELETE CASCADE; the application distinguishes retention from explicit deletion by protecting incidents referenced by any retained delivery. service_run_id in checks uses RESTRICT; prune service runs only after no checks reference them and coverage retention allows it. Migration rollback tests must cover cyclic/deferred relationships and confirmed owner deletion.

## Required indexes

```sql
CREATE UNIQUE INDEX checks_one_unsettled ON checks(monitor_id)
  WHERE lifecycle IN ('QUEUED', 'RUNNING');
CREATE UNIQUE INDEX incidents_one_open ON incidents(monitor_id)
  WHERE status = 'OPEN';
CREATE UNIQUE INDEX activity_one_open ON monitor_activity_windows(monitor_id)
  WHERE disabled_at IS NULL;
CREATE UNIQUE INDEX delivery_event_destination
  ON notification_deliveries(event_id, destination_id);
CREATE UNIQUE INDEX delivery_one_inflight ON notification_deliveries(destination_id)
  WHERE state = 'IN_FLIGHT';
CREATE INDEX monitors_due ON monitors(next_due_at, id) WHERE enabled = 1;
CREATE INDEX checks_monitor_sequence ON checks(monitor_id, sequence DESC);
CREATE INDEX checks_monitor_started ON checks(monitor_id, started_at, sequence);
CREATE INDEX checks_retention ON checks(completed_at) WHERE lifecycle IN ('COMPLETED','CANCELLED','ABANDONED');
CREATE INDEX transitions_monitor_time ON state_transitions(monitor_id, occurred_at, sequence);
CREATE INDEX incidents_monitor_time ON incidents(monitor_id, opened_at, id);
CREATE INDEX incidents_detected ON incidents(detected_at, id);
CREATE INDEX deliveries_due ON notification_deliveries(next_attempt_at, id) WHERE state = 'PENDING';
CREATE INDEX deliveries_finished ON notification_deliveries(finished_at) WHERE state IN ('SUCCEEDED','DEAD','CANCELLED');
```

Add foreign-key lookup indexes for deliveries(incident_id), deliveries(destination_id), checks(service_run_id), activity(monitor_id, enabled_at) and service_runs(ready_at, stopped_at). Index additions require EXPLAIN QUERY PLAN evidence for their corresponding query. Do not add redundant indexes by intuition.

## Initialization, migrations and upgrades

Before writes enforce `foreign_keys=ON`, `journal_mode=WAL`, `synchronous=FULL`, `busy_timeout=5000`, and a bounded default WAL auto-checkpoint (1000 pages). Verify actual pragma results. Never silently continue if WAL/local writable storage is unavailable. Transactions use explicit BEGIN IMMEDIATE for serialized mutations and always ROLLBACK on failure. No network calls or async waits inside them. Read pagination/metrics use short snapshot transactions so one response is internally consistent.

The release candidate targets a 16MiB page cache and uses SQLite's native mapping cap, at most 2,147,418,112 bytes, only during complete writable quick_check and foreign_key_check. Before those checks, a database larger than the effective mapping limit is read sequentially through a reusable 1MiB buffer; any existing WAL is pre-read as well, including when the main file fits its mapping. This read-only pass primes filesystem pages and rejects read failures, premature EOF or file-size changes. It is an I/O optimization, never a validation result: SQLite still performs its complete writable checks before admission. It releases the larger mapping and restores the 64MiB limit before returning the store and before readiness. This avoids synchronous Windows reads for most validation pages without retaining multi-gigabyte mappings during normal operation. After validation, recovery probes terminal-completion and queued indexes, and obtains each monitor's maximum started time through its covering index. Validated lifecycle ordering bounds every queued clock by either a started/completed clock or the explicit QUEUED probe, so the exact maximum survives without a retained-history scan. [Measured query plans](../evidence/stage-4-indexed-recovery.json) and all five lifecycle regressions establish this equivalence. Persisted CHECK and foreign-key corruption must still reject startup and preserve data. Component improvements do not establish every reference-load budget; see [measured remediation](../STAGE-4-REMEDIATION.md) and ADR-021.

Number migrations sequentially, store checksums and apply each pending version transactionally. A checksum mismatch, newer schema or unsupported upgrade path is a startup error, never automatic reset/downgrade. Stage 2 migration seeds UNKNOWN health and enabled windows at migration time, not fabricated past coverage. Existing checks can supply sampled metrics but do not imply earlier service coverage. Stage 3 migration creates no retroactive notification jobs for pre-feature incidents. Migrate only while no scheduler/HTTP mutation writes are admitted.

Stage 4 migration 4 retains the byte-identical checksums of migrations 1–3. It substitutes equivalent OR equality expressions for constant IN lists in the checks table CHECK definitions, avoiding per-row ephemeral set construction in SQLite 3.53.3 writable quick_check. The on-disk columns, rowids, sequences, foreign keys and all indexes stay unchanged. Schema editing is confined to an active migration transaction with foreign keys/CHECK enforcement on; the helper accepts only the exact known prior DDL, parses both definitions in empty databases, compares physical/FK layouts, updates exactly one schema row and increments SQLite's schema version. It restores writable_schema OFF and defensive mode ON before complete writable quick_check and foreign_key_check. Only successful validation permits the migration record and COMMIT; failure rolls the entire schema/data transaction back. Every ordinary startup still performs the complete checks. Verified backups remain required for operational upgrades. This is an explicitly guarded use of SQLite's [schema editing procedure](https://sqlite.org/lang_altertable.html), never a generic transformation of an unknown database.

Before a supported release upgrade, create a verified consistent backup with the old runtime stopped or SQLite backup facilities. Do not copy only the `.db` file while a live WAL exists. A failed transactional migration leaves its prior schema intact; a nontransactional operation is prohibited in an automatic migration. Restoration is explicit and must preserve the failed database for investigation.

## Transaction boundaries and crash behavior

| Operation | Atomic changes |
| --- | --- |
| Create/edit/pause/resume/delete monitor | Monitor revision/epoch, queued cancellation, due time, lifecycle transition and activity window; delete cascades only after confirmation. |
| Reserve execution | Validate enabled/fence, insert QUEUED/RUNNING identity, reserve unique monitor work. |
| Accept terminal observation | Check, counters, transition, incident, due time and notification outbox. |
| Claim delivery | State IN_FLIGHT, attempt_count increment, claimed_at. |
| Finish delivery | Outcome, next retry or terminal state and safe attempt metadata. |
| Startup recovery | Prior run closure, abandoned executions, UNKNOWN resets, delivery claim recovery. |
| Retention batch | At most 1000 removable rows and any necessary coverage anchor compaction. |

COMMIT acknowledgment means SQLite accepted the transaction under FULL synchronization, subject to host filesystem/hardware behavior. It does not guarantee survival of broken storage or all power-loss scenarios. Network receipt and database acknowledgment cannot be atomic with remote targets; uncertain requests/deliveries may be repeated after crash. Worker errors never synthesize a target failure.

## Retention and coverage anchors

Stage 2 schema version 2 also persists `checks.slow_success` (nullable for pre-feature rows), `monitor_status.first_observation_at`, safe incident failure_category/diagnostic_summary and a singleton reliability_meta for supported source boundaries. Projections and activity windows are seeded during the first Stage 2 initialization transaction before admission; a null coverage marker makes interruption before initialization safely retryable. All prior migration checksums stay unchanged. Additional partial queue/terminal-diagnostics and evidence-link indexes have executable query-plan evidence in [Stage 2 evidence](../evidence/stage-2-query-plans.json).

Run maintenance hourly, with no overlapping job, deleting by strict timestamp `< now-retentionDays*86400000`. Terminal checks default 30d; resolved incidents use resolved_at and default 365d; terminal deliveries use finished_at and default 30d. Never delete OPEN incidents, QUEUED/RUNNING checks, PENDING/IN_FLIGHT deliveries or resolved incidents referenced by any retained delivery, including a terminal one. Prune eligible terminal deliveries before incidents, in separate bounded batches. Keep incident transition anchors and any state-transition predecessor needed to reconstruct health at the coverage cutoff. Non-anchor transitions, closed service runs and closed activity windows default 365d, but retain older portions/anchors needed by an unresolved incident or protected delivery and by referenced checks. This exception can grow storage; expose it rather than silently pruning protected data.

Current Stage 2 maintenance starts after ten seconds, runs hourly when caught up, and deletes at most 1,000 records total per transaction across its tables. It yields after every worker call and after at most 20 batches continues after 100ms while backlog remains; completed-check bookkeeping retains reserved queue capacity. Coverage/transition cleanup uses the earlier of the incident-retention cutoff and oldest unresolved onset. A state predecessor survives at that cutoff. Raw checks may expire even when their incident remains; evidence links become null. Stage 3 migration 3 adds notification_destinations and notification_deliveries. Maintenance now removes eligible terminal deliveries first and protects incidents referenced by any retained delivery. Required coverage anchors use the oldest protected incident, including delivery references. Retention boundaries are conservative supported cutoffs even while a deletion backlog remains.

Pruning a resolved incident removes now-unreferenced anchors in a later bounded batch. Coverage compaction preserves the latest state at the cutoff; it must not invent earlier known coverage. Queries expose source-specific retention boundaries. Retention does not VACUUM on every cycle. Disk-space reclamation uses an explicit maintenance procedure with a verified backup and sufficient free disk; no automatic destructive reset.

## Faults, backup and recovery

On SQLITE_BUSY, the 5s busy timeout is the bounded wait; do not layer unbounded retries. SQLITE_FULL, IOERR, READONLY, CORRUPT or worker death fails readiness and pauses dispatch; return safe 503 on writes. Preserve the database and WAL. There is no empty-database fallback. Recover only after verified operator correction/restart. Log paths only in local operator documentation, not in API errors or public logs.

Backups must use SQLite's consistent backup API when available, or a clean stopped process with closed/checkpointed SQLite and no active lock. Verify SHA-256, `PRAGMA integrity_check`, `foreign_key_check`, migration version and representative record counts on the backup/restore copy. Encrypt/protect backups operationally because monitor URLs and secret aliases are sensitive even though raw credentials are excluded. See [release operations](15-RELEASE-AND-DISTRIBUTION.md).

SQLite WAL supports concurrent readers and one writer, and needs same-host storage; this design uses one writer for deterministic ownership. These constraints and backup risks follow [SQLite WAL documentation](https://sqlite.org/wal.html). Dependency verification must also account for applicable upstream SQLite fixes in the selected runtime; passing a version-family check alone is insufficient.

## Stage 3 outbox migration

Migration 3 preserves the checksums and contents of migrations 1 and 2. STRICT destination/delivery tables enforce state/timestamp consistency, five-attempt bounds, unique event/destination insertion and one IN_FLIGHT delivery per destination. An internal AUTOINCREMENT sequence preserves destination event ordering. Partial due/finished indexes, destination/incident indexes and a counted-completed-check timestamp index support bounded claims, retention and dashboard aggregates. Outbox insertion occurs inside the existing result transaction. No historical event backfill is performed.

## Stage 4 startup deadline correction

The unreleased candidate retains full startup quick_check and foreign-key validation. Worker bootstrap has a finite ten-minute ceiling; the single initialize/recovery call has sixty seconds. All ordinary worker commands retain ten-second deadlines. No HTTP traffic or scheduling begins before both phases finish. These safety ceilings are distinct from the owner-approved sixty-second reference performance target. Historical cached starts did not eliminate a later 75.30-second restart failure; sequential validation pre-reading is a new candidate correction that still requires post-load supported-platform validation. Full reference-load acceptance requires all independent budgets and host conditions. See ADR-013/015/016/020/021 and the Stage 4 report.
