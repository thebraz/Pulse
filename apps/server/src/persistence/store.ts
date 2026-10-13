import { DatabaseSync, type SQLInputValue, type SQLOutputValue } from 'node:sqlite';
import { createHash, randomUUID } from 'node:crypto';
import { z } from 'zod';
import { monitorCreateSchema, monitorSchema, checkSchema, type Monitor, type Check, type MonitorInput, type MonitorQuery, type HistoryQuery, type Observation, type MetricsQuery, type IncidentQuery, type TransitionQuery } from '@pulse/contracts';
import { AppError } from '../application/errors.js';
import { nextDue } from '../scheduler/clock.js';
import { migration1, migration2, migration3, migration4, migration5 } from './migration.js';
import { applyChecksMigration } from './checks-migration.js';
import { preloadValidationPages } from './validation-read.js';
import { NotificationStore } from './notifications.js';
import { evaluate, initialHealth, type Health } from '../domain/health.js';
import { intersect, measure, latency, type Interval } from '../domain/metrics.js';
import type { Input, Operation, Output } from './protocol.js';
type Row = Record<string, SQLOutputValue>;
const monitorSelect = "SELECT monitors.*, monitor_status.state,monitor_status.reason,last_check.started_at AS last_check_at,last_check.outcome AS last_observed_outcome FROM monitors JOIN monitor_status ON monitor_status.monitor_id=monitors.id LEFT JOIN checks AS last_check ON last_check.sequence=(SELECT max(sequence) FROM checks WHERE monitor_id=monitors.id AND lifecycle='COMPLETED')";
const timestamp = (v: SQLOutputValue | undefined) => v == null ? null : new Date(Number(v)).toISOString();
const cursorTime = z.number().int().min(-62167219200000).max(253402300799999);
const cursorSchema = z.strictObject({
    version: z.literal(1), kind: z.enum(['monitors', 'checks', 'incidents', 'transitions']), filter: z.string().max(2048), asOf: cursorTime.nonnegative(), high: z.number().int().nonnegative(), key: z.union([z.string().max(120), z.number()]), id: z.string().max(36), from: cursorTime.optional(), to: cursorTime.optional()
});
type Cursor = z.infer<typeof cursorSchema>;
function decodeCursor(value: string | undefined, kind: Cursor['kind'], filter: string, now: number): Cursor | null {
    if (!value)
        return null;
    try {
        if (value.length > 1024 || !/^[A-Za-z0-9_-]+$/.test(value))
            throw new Error();
        const parsed = cursorSchema.parse(JSON.parse(Buffer.from(value, 'base64url').toString()));
        if (parsed.kind !== kind || parsed.filter !== filter || parsed.asOf > now || (parsed.from !== undefined && parsed.to !== undefined && (parsed.from >= parsed.to || parsed.to > now || parsed.to - parsed.from > 90 * 86400000)))
            throw new Error();
        if (kind === 'monitors' ? parsed.from !== undefined || parsed.to !== undefined : parsed.from === undefined || parsed.to === undefined || parsed.to > parsed.asOf)
            throw new Error();
        return parsed;
    }
    catch {
        throw new AppError('VALIDATION_ERROR', 400);
    }
}
const encode = (c: Cursor) => Buffer.from(JSON.stringify(c)).toString('base64url');
export class Store {
    readonly db: DatabaseSync;
    private runId = '';
    private readonly notifications: NotificationStore;
    constructor(path: string) {
        this.db = new DatabaseSync(path, {
            timeout: 5000, enableForeignKeyConstraints: true
        });
        this.db.function('pulse_lower', {
            deterministic: true
        }, value => String(value).toLowerCase());
        this.notifications = new NotificationStore(this.db);
        try {
            // Full startup validation uses SQLite's bounded native mapping, avoiding per-page Windows reads.
            // Release the large mapping before admission; steady operation keeps its 64MiB/16MiB bounds.
            this.db.exec('PRAGMA foreign_keys=ON; PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA busy_timeout=5000; PRAGMA wal_autocheckpoint=1000; PRAGMA mmap_size=2147418112; PRAGMA cache_size=-16384;');
            if (this.one('PRAGMA journal_mode')?.journal_mode !== 'wal' || this.one('PRAGMA synchronous')?.synchronous !== 2 || this.one('PRAGMA foreign_keys')?.foreign_keys !== 1)
                throw new Error();
            const migrations = [migration1, migration2, migration3, migration4, migration5];
            let validatedInMigration = false;
            const hasTable = this.one("SELECT name FROM sqlite_master WHERE type='table' AND name='schema_migrations'");
            if (!hasTable && this.one("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'"))
                throw new AppError('SCHEMA_UNSUPPORTED', 503);
            this.tx(() => {
                this.db.exec('CREATE TABLE IF NOT EXISTS schema_migrations(version INTEGER PRIMARY KEY,checksum TEXT NOT NULL,applied_at INTEGER NOT NULL) STRICT');
                const rows = this.all('SELECT version,checksum FROM schema_migrations ORDER BY version');
                if (rows.length > migrations.length || rows.some((r, i) => r.version !== i + 1 || r.checksum !== createHash('sha256').update(migrations[i]!).digest('hex')))
                    throw new AppError('SCHEMA_UNSUPPORTED', 503);
                for (let i = rows.length; i < migrations.length; i++) {
                    if (i === 3) {
                        applyChecksMigration(this.db);
                        validatedInMigration = true;
                    }
                    else {
                        this.db.exec(migrations[i]!);
                        validatedInMigration = false;
                    }
                    this.run('INSERT INTO schema_migrations VALUES(?,?,?)', i + 1, createHash('sha256').update(migrations[i]!).digest('hex'), Date.now());
                }
            });
            if (!validatedInMigration) {
                preloadValidationPages(path, Number(this.one('PRAGMA mmap_size')?.mmap_size));
                const quick = this.all('PRAGMA quick_check');
                if (quick.length !== 1 || quick[0]?.quick_check !== 'ok' || this.all('PRAGMA foreign_key_check').length)
                    throw new AppError('DATABASE_UNAVAILABLE', 503);
            }
            this.db.exec('PRAGMA mmap_size=67108864');
        }
        catch (e) {
            this.db.close();
            throw e;
        }
    }
    private one(sql: string, ...params: SQLInputValue[]): Row | undefined { return this.db.prepare(sql).get(...params); }
    private all(sql: string, ...params: SQLInputValue[]): Row[] { return this.db.prepare(sql).all(...params); }
    private run(sql: string, ...params: SQLInputValue[]) { return this.db.prepare(sql).run(...params); }
    private tx<T>(fn: () => T): T {
        this.db.exec('BEGIN IMMEDIATE');
        try {
            const value = fn();
            this.db.exec('COMMIT');
            return value;
        }
        catch (e) {
            if (this.db.isTransaction)
                this.db.exec('ROLLBACK');
            throw e;
        }
    }
    private monitor(row: Row): Monitor {
        return monitorSchema.parse({
            id: row.id, name: row.name, url: row.url, method: row.method, expectedStatusCodes: JSON.parse(String(row.expected_status_codes_json)), intervalMs: row.interval_ms, timeoutMs: row.timeout_ms, followRedirects: row.follow_redirects === 1, enabled: row.enabled === 1, failureThreshold: row.failure_threshold, recoveryThreshold: row.recovery_threshold, latencyThresholdMs: row.latency_threshold_ms, degradationThreshold: row.degradation_threshold, revision: row.revision, createdAt: timestamp(row.created_at), updatedAt: timestamp(row.updated_at), nextDueAt: timestamp(row.next_due_at), lastCheckAt: timestamp(row.last_check_at), lastObservedOutcome: row.last_observed_outcome ?? null, status: {
                state: row.state, reason: row.reason
            }
        });
    }
    private check(row: Row): Check {
        return checkSchema.parse({
            id: row.id, monitorId: row.monitor_id, sequence: row.sequence, serviceRunId: row.service_run_id, monitorRevision: row.monitor_revision, executionEpoch: row.execution_epoch, trigger: row.trigger, lifecycle: row.lifecycle, queuedAt: timestamp(row.queued_at), scheduledAt: timestamp(row.scheduled_at), startedAt: timestamp(row.started_at), completedAt: timestamp(row.completed_at), outcome: row.outcome, httpStatus: row.http_status, durationMs: row.duration_ms, redirectCount: row.redirect_count, errorCode: row.error_code
        });
    }
    private requireMonitor(id: string): Row {
        const row = this.one(monitorSelect + ' WHERE monitors.id=?', id);
        if (!row)
            throw new AppError('NOT_FOUND', 404);
        return row;
    }
    private requireCheck(id: string): Row {
        const row = this.one('SELECT * FROM checks WHERE id=?', id);
        if (!row)
            throw new AppError('NOT_FOUND', 404);
        return row;
    }
    private fields(input: MonitorInput): SQLInputValue[] { return [input.name, input.url, input.method, JSON.stringify(input.expectedStatusCodes), input.intervalMs, input.timeoutMs, Number(input.followRedirects), Number(input.enabled), input.failureThreshold, input.recoveryThreshold, input.latencyThresholdMs, input.degradationThreshold]; }
    private allocate(row: Row, now: number, trigger: 'manual' | 'automatic', running = false): Row {
        const id = randomUUID();
        this.run(`INSERT INTO checks(id,monitor_id,service_run_id,monitor_revision,execution_epoch,trigger,lifecycle,queued_at,scheduled_at,started_at) VALUES(?,?,?,?,?,?,?,?,?,?)`, id, row.id!, this.runId, row.revision!, row.execution_epoch!, trigger, running ? 'RUNNING' : 'QUEUED', now, row.next_due_at != null && Number(row.next_due_at) <= now ? row.next_due_at : null, running ? now : null);
        return this.requireCheck(id);
    }
    private terminalOrder() { this.run('UPDATE check_commit_clock SET value=value+1 WHERE id=1'); }
    private cancel(id: string, now: number) { this.terminalOrder(); this.run("UPDATE checks SET lifecycle='CANCELLED',terminal_order=(SELECT value FROM check_commit_clock WHERE id=1),completed_at=?,outcome=NULL,http_status=NULL,duration_ms=NULL,error_code=NULL WHERE monitor_id=? AND lifecycle IN('QUEUED','RUNNING')", now, id); }
    private health(row: Row): Health {
        return {
            state: row.state as Health['state'], reason: row.reason as Health['reason'], failures: Number(row.consecutive_failures), successes: Number(row.consecutive_successes),
            slow: Number(row.consecutive_slow), fast: Number(row.consecutive_fast), failureStart: row.failure_run_started_at == null ? null : Number(row.failure_run_started_at),
            recoveryStart: row.recovery_run_started_at == null ? null : Number(row.recovery_run_started_at)
        };
    }
    private transition(row: Row, from: Health['state'], h: Health, now: number, checkId: string | null): string | null {
        if (from === h.state)
            return null;
        const id = randomUUID();
        this.run('INSERT INTO state_transitions(id,monitor_id,from_state,to_state,reason,occurred_at,check_id,monitor_revision,execution_epoch) VALUES(?,?,?,?,?,?,?,?,?)', id, row.id!, from, h.state, h.reason, now, checkId, row.revision!, row.execution_epoch!);
        return id;
    }
    private saveHealth(row: Row, h: Health, now: number, checkId: string | null, openId: SQLInputValue) {
        this.run(`UPDATE monitor_status SET state=?,reason=?,consecutive_failures=?,consecutive_successes=?,consecutive_slow=?,consecutive_fast=?,
            failure_run_started_at=?,recovery_run_started_at=?,last_check_id=?,state_changed_at=CASE WHEN state!=? THEN ? ELSE state_changed_at END,open_incident_id=? WHERE monitor_id=?`, h.state, h.reason, h.failures, h.successes, h.slow, h.fast, h.failureStart, h.recoveryStart, checkId, h.state, now, openId, row.id!);
    }
    private reset(row: Row, now: number, reason: Health['reason']) {
        const previous = this.one('SELECT * FROM monitor_status WHERE monitor_id=?', row.id!)!;
        const h = initialHealth(reason);
        this.transition(row, previous.state as Health['state'], h, now, null);
        this.saveHealth(row, h, now, null, previous.open_incident_id!);
    }
    private accept(row: Row, check: Row, observation: Observation, now: number) {
        const previous = this.one('SELECT * FROM monitor_status WHERE monitor_id=?', row.id!)!;
        const evaluated = evaluate(this.health(previous), this.monitor(row), observation, Number(check.started_at), previous.open_incident_id != null);
        const h = evaluated.health, transitionId = this.transition(row, previous.state as Health['state'], h, now, String(check.id));
        let openId: SQLInputValue = previous.open_incident_id ?? null;
        if (evaluated.incident === 'open') {
            openId = randomUUID();
            this.run(`INSERT INTO incidents(id,monitor_id,monitor_revision,status,opened_at,detected_at,opening_check_id,opening_transition_id,failure_category,diagnostic_summary)
                VALUES(?,?,?,'OPEN',?,?,?,?,?,?)`, openId, row.id!, row.revision!, h.failureStart, now, check.id!, transitionId, observation.outcome, `Confirmed after ${h.failures} consecutive failures; triggering category: ${observation.outcome}.`);
            this.notifications.incident(this.monitor(row), String(openId), 'incident.opened', String(previous.state), h.state, now);
        }
        else if (evaluated.incident === 'resolve') {
            this.run("UPDATE incidents SET status='RESOLVED',observed_end_at=?,resolved_at=?,resolving_check_id=?,resolving_transition_id=? WHERE id=? AND status='OPEN'", h.recoveryStart, now, check.id!, transitionId, openId);
            this.notifications.incident(this.monitor(row), String(openId), 'incident.resolved', String(previous.state), h.state, now);
            openId = null;
        }
        this.saveHealth(row, h, now, String(check.id), openId);
        if (observation.outcome !== 'POLICY_BLOCKED')
            this.run('UPDATE monitor_status SET first_observation_at=coalesce(first_observation_at,?) WHERE monitor_id=?', check.started_at!, row.id!);
    }
    execute<K extends Operation>(op: K, p: Input<K>): Output<K> {
        return this.handle(op, p) as Output<K>;
    }
    private handle(op: Operation, p: unknown): unknown {
        // Payloads have been decoded by the owner worker before this trusted internal dispatch.
        switch (op) {
            case 'initialize': {
                const { now, runId, fingerprint } = p as Input<'initialize'>;
                // Validated lifecycle constraints bound queued clocks by started/completed clocks.
                // Probe existing indexes instead of scanning every retained observation.
                const completed = this.one("SELECT max(completed_at) AS t FROM checks WHERE lifecycle IN('COMPLETED','CANCELLED','ABANDONED')");
                const queued = this.one("SELECT max(queued_at) AS t FROM checks WHERE lifecycle='QUEUED'");
                const started = this.one('SELECT max((SELECT max(started_at) FROM checks WHERE monitor_id=monitors.id)) AS t FROM monitors');
                const seed = Math.max(now, Number(completed?.t ?? 0), Number(queued?.t ?? 0), Number(started?.t ?? 0), Number(this.one('SELECT max(t) AS t FROM (SELECT max(updated_at) AS t FROM monitors UNION ALL SELECT max(last_heartbeat_at) FROM service_runs UNION ALL SELECT max(occurred_at) FROM state_transitions UNION ALL SELECT coverage_from FROM reliability_meta UNION ALL SELECT max(updated_at) FROM notification_destinations UNION ALL SELECT max(updated_at) FROM notification_deliveries)')?.t ?? 0));
                this.tx(() => {
                    this.notifications.recover(seed);
                    this.terminalOrder();
                    this.run("UPDATE service_runs SET stopped_at=last_heartbeat_at,stop_reason='ABANDONED' WHERE stopped_at IS NULL");
                    this.run("UPDATE checks SET lifecycle='ABANDONED',terminal_order=(SELECT value FROM check_commit_clock WHERE id=1),completed_at=?,outcome=NULL,http_status=NULL,duration_ms=NULL,error_code=NULL WHERE lifecycle IN('QUEUED','RUNNING')", seed);
                    this.run('INSERT INTO service_runs(id,started_at,last_heartbeat_at,config_fingerprint) VALUES(?,?,?,?)', runId, seed, seed, fingerprint);
                    const fresh = this.one('SELECT coverage_from FROM reliability_meta')?.coverage_from == null;
                    if (fresh) {
                        this.run('UPDATE reliability_meta SET coverage_from=?,incidents_from=? WHERE id=1', seed, seed);
                        this.run("INSERT INTO monitor_status(monitor_id,state,reason,state_changed_at) SELECT id,'UNKNOWN',CASE WHEN enabled=1 THEN 'RESTARTED' ELSE 'PAUSED' END,? FROM monitors", seed);
                        this.run("UPDATE monitor_status SET first_observation_at=(SELECT min(started_at) FROM checks WHERE monitor_id=monitor_status.monitor_id AND lifecycle='COMPLETED' AND outcome!='POLICY_BLOCKED')");
                        this.run('INSERT INTO monitor_activity_windows(id,monitor_id,enabled_at) SELECT id,id,? FROM monitors WHERE enabled=1', seed);
                    }
                    else {
                        for (const row of this.all('SELECT * FROM monitors'))
                            this.reset(row, seed, row.enabled === 1 ? 'RESTARTED' : 'PAUSED');
                    }
                });
                this.runId = runId;
                return {
                    seed, sqliteVersion: String(this.one('SELECT sqlite_version() AS v')?.v)
                };
            }
            case 'create': {
                const { now, input } = p as Input<'create'>;
                return this.tx(() => {
                    if (Number(this.one('SELECT count(*) AS n FROM monitors')?.n) >= 10000)
                        throw new AppError('MONITOR_LIMIT_REACHED', 409);
                    const id = randomUUID();
                    this.run('INSERT INTO monitors VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,1,1,?,?,?)', id, ...this.fields(input), now, now, input.enabled ? now : null);
                    this.run("INSERT INTO monitor_status(monitor_id,state,reason,state_changed_at) VALUES(?,'UNKNOWN',?,?)", id, input.enabled ? 'INITIAL' : 'PAUSED', now);
                    if (input.enabled)
                        this.run('INSERT INTO monitor_activity_windows(id,monitor_id,enabled_at) VALUES(?,?,?)', randomUUID(), id, now);
                    return this.monitor(this.requireMonitor(id));
                });
            }
            case 'get': return this.monitor(this.requireMonitor((p as Input<'get'>).id));
            case 'patch': {
                const { id, revision, now, input } = p as Input<'patch'>;
                return this.tx(() => {
                    const row = this.requireMonitor(id);
                    if (row.revision !== revision)
                        throw new AppError('REVISION_CONFLICT', 409);
                    const old = this.monitor(row);
                    const next = monitorCreateSchema.parse(Object.fromEntries(Object.entries({
                        ...old, ...input
                    }).filter(([key]) => key in monitorCreateSchema.shape)));
                    if (Object.entries(input).every(([key, value]) => JSON.stringify(old[key as keyof Monitor]) === JSON.stringify(value)))
                        return old;
                    this.cancel(id, now);
                    const reset = ('intervalMs' in input) || ('enabled' in input);
                    let due = next.enabled ? (reset ? now : Number(row.next_due_at)) : null;
                    if (due !== null && !reset)
                        due = nextDue(due, now, next.intervalMs);
                    this.run('UPDATE monitors SET name=?,url=?,method=?,expected_status_codes_json=?,interval_ms=?,timeout_ms=?,follow_redirects=?,enabled=?,failure_threshold=?,recovery_threshold=?,latency_threshold_ms=?,degradation_threshold=?,revision=revision+1,execution_epoch=execution_epoch+1,updated_at=?,next_due_at=? WHERE id=?', ...this.fields(next), now, due, id);
                    if (next.enabled !== old.enabled) {
                        if (next.enabled)
                            this.run('INSERT INTO monitor_activity_windows(id,monitor_id,enabled_at) VALUES(?,?,?)', randomUUID(), id, now);
                        else
                            this.run('UPDATE monitor_activity_windows SET disabled_at=? WHERE monitor_id=? AND disabled_at IS NULL', now, id);
                    }
                    if (Object.keys(input).some(key => key !== 'name' && JSON.stringify(old[key as keyof Monitor]) !== JSON.stringify(next[key as keyof MonitorInput])))
                        this.reset(this.requireMonitor(id), now, !next.enabled ? 'PAUSED' : next.enabled !== old.enabled ? 'INITIAL' : 'RECONFIGURED');
                    return this.monitor(this.requireMonitor(id));
                });
            }
            case 'delete': {
                const { id, revision, now } = p as Input<'delete'>;
                return this.tx(() => {
                    if (this.requireMonitor(id).revision !== revision)
                        throw new AppError('REVISION_CONFLICT', 409);
                    this.cancel(id, now);
                    // Remove the projection before cyclic incident cascades can null its DOWN anchor.
                    this.run('DELETE FROM monitor_status WHERE monitor_id=?', id);
                    this.run('DELETE FROM monitors WHERE id=?', id);
                    return null;
                });
            }
            case 'manual': {
                const { id, now, limit } = p as Input<'manual'>;
                return this.tx(() => {
                    const row = this.requireMonitor(id);
                    if (row.enabled !== 1)
                        throw new AppError('MONITOR_DISABLED', 409);
                    const existing = this.one("SELECT * FROM checks WHERE monitor_id=? AND lifecycle IN('QUEUED','RUNNING')", id);
                    if (existing)
                        return this.check(existing);
                    if (Number(this.one("SELECT count(*) AS n FROM checks WHERE lifecycle='QUEUED' AND trigger='manual'")?.n) >= limit)
                        throw new AppError('QUEUE_SATURATED', 429);
                    return this.check(this.allocate(row, now, 'manual'));
                });
            }
            case 'dispatch': {
                const { now, preferManual, busyIds = [] } = p as Input<'dispatch'>;
                return this.tx(() => {
                    const busy = busyIds.length ? ' AND monitors.id NOT IN (' + busyIds.map(() => '?').join(',') + ')' : '';
                    const manualBusy = busyIds.length ? ' AND monitor_id NOT IN (' + busyIds.map(() => '?').join(',') + ')' : '';
                    const automatic = this.one(monitorSelect + " WHERE monitors.enabled=1 AND next_due_at<=? AND NOT EXISTS(SELECT 1 FROM checks WHERE monitor_id=monitors.id AND lifecycle IN('QUEUED','RUNNING')) " + busy + " ORDER BY monitors.next_due_at,monitors.id LIMIT 1", now, ...busyIds);
                    const manual = this.one("SELECT * FROM checks WHERE lifecycle='QUEUED'" + manualBusy + " ORDER BY queued_at,id LIMIT 1", ...busyIds);
                    let row: Row, check: Row;
                    if (manual && (preferManual || !automatic)) {
                        row = this.requireMonitor(String(manual.monitor_id));
                        this.run("UPDATE checks SET lifecycle='RUNNING',started_at=? WHERE id=?", now, manual.id!);
                        check = this.requireCheck(String(manual.id));
                    }
                    else if (automatic) {
                        row = automatic;
                        check = this.allocate(row, now, 'automatic', true);
                    }
                    else
                        return null;
                    return {
                        monitor: this.monitor(row), check: this.check(check)
                    };
                });
            }
            case 'finish': {
                const { id, now, observation } = p as Input<'finish'>;
                return this.tx(() => {
                    const check = this.one('SELECT * FROM checks WHERE id=?', id);
                    if (!check || check.lifecycle !== 'RUNNING')
                        return null;
                    const row = this.requireMonitor(String(check.monitor_id));
                    if (row.revision !== check.monitor_revision || row.execution_epoch !== check.execution_epoch)
                        return null;
                    if (observation) {
                        this.terminalOrder();
                        this.run("UPDATE checks SET lifecycle='COMPLETED',terminal_order=(SELECT value FROM check_commit_clock WHERE id=1),completed_at=?,outcome=?,http_status=?,duration_ms=?,redirect_count=?,error_code=? WHERE id=?", now, observation.outcome, observation.httpStatus, observation.durationMs, observation.redirectCount, observation.errorCode, id);
                        this.accept(row, check, observation, now);
                        this.run('UPDATE checks SET slow_success=? WHERE id=?', Number(observation.outcome === 'SUCCESS' && observation.durationMs >= Number(row.latency_threshold_ms)), id);
                    }
                    else
                        this.cancel(String(row.id), now);
                    this.run('UPDATE monitors SET next_due_at=? WHERE id=?', row.enabled === 1 ? nextDue(Number(row.next_due_at), now, Number(row.interval_ms)) : null, row.id!);
                    return null;
                });
            }
            case 'execution': return this.check(this.requireCheck((p as Input<'execution'>).id));
            case 'list': {
                const { now, query } = p as Input<'list'>;
                return this.tx(() => this.list(now, query));
            }
            case 'history': {
                const { id, now, query } = p as Input<'history'>;
                return this.tx(() => this.history(id, now, query));
            }
            case 'health': return this.tx(() => { this.run('UPDATE service_runs SET last_heartbeat_at=last_heartbeat_at WHERE id=?', this.runId); return true; });
            case 'heartbeat': {
                const { now } = p as Input<'heartbeat'>;
                return this.tx(() => { this.run('UPDATE service_runs SET ready_at=coalesce(ready_at,?),last_heartbeat_at=max(last_heartbeat_at,?) WHERE id=? AND stopped_at IS NULL', now, now, this.runId); return null; });
            }
            case 'nextWake': {
                const { now } = p as Input<'nextWake'>;
                if (this.one("SELECT id FROM checks WHERE lifecycle='QUEUED' LIMIT 1"))
                    return 250;
                const due = this.one("SELECT next_due_at FROM monitors WHERE enabled=1 AND NOT EXISTS(SELECT 1 FROM checks WHERE monitor_id=monitors.id AND lifecycle IN('QUEUED','RUNNING')) ORDER BY next_due_at,id LIMIT 1")?.next_due_at;
                return due == null ? 10000 : Math.max(25, Math.min(10000, Number(due) - now));
            }
            case 'metrics': {
                const { id, now, query } = p as Input<'metrics'>;
                return this.tx(() => this.metrics(id, now, query));
            }
            case 'incidents': {
                const { now, query } = p as Input<'incidents'>;
                return this.tx(() => this.incidents(now, query));
            }
            case 'incident': {
                const { id, now } = p as Input<'incident'>;
                return this.tx(() => this.incidentDetail(id, now));
            }
            case 'transitions': {
                const { id, now, query } = p as Input<'transitions'>;
                return this.tx(() => this.transitions(id, now, query));
            }
            case 'summary': {
                const { now } = p as Input<'summary'>, rows = this.all('SELECT enabled,state,count(*) AS n FROM monitors JOIN monitor_status ON monitor_id=id GROUP BY enabled,state');
                const result = {
                    asOf: new Date(now).toISOString(), total: 0, enabled: 0, paused: 0, unknown: 0, up: 0, degraded: 0, down: 0, activeIncidents: Number(this.one("SELECT count(*) AS n FROM incidents WHERE status='OPEN'")?.n)
                };
                for (const r of rows) {
                    const n = Number(r.n);
                    result.total += n;
                    if (r.enabled === 0)
                        result.paused += n;
                    else {
                        result.enabled += n;
                        result[String(r.state).toLowerCase() as 'unknown' | 'up' | 'degraded' | 'down'] += n;
                    }
                }
                return result;
            }
            case 'engine': {
                const { now } = p as Input<'engine'>, due = this.one('SELECT count(*) AS n,min(next_due_at) AS oldest FROM monitors WHERE enabled=1 AND next_due_at<=?', now)!;
                return {
                    queued: Number(this.one("SELECT count(*) AS n FROM checks WHERE lifecycle='QUEUED'")?.n), due: Number(due.n), oldestDueLagMs: due.oldest == null ? 0 : Math.max(0, now - Number(due.oldest)),
                    cancelled: Number(this.one("SELECT count(*) AS n FROM checks WHERE lifecycle='CANCELLED'")?.n), abandoned: Number(this.one("SELECT count(*) AS n FROM checks WHERE lifecycle='ABANDONED'")?.n),
                    retentionProtectedIncidents: Number(this.one("SELECT count(*) AS n FROM incidents WHERE status='OPEN'")?.n)
                };
            }
            case 'retain': {
                const { now, checkDays, incidentDays, deliveryDays = 30 } = p as Input<'retain'>;
                return this.tx(() => this.retain(now, checkDays, incidentDays, deliveryDays));
            }
            case 'dashboard': return this.tx(() => this.dashboard((p as Input<'dashboard'>).now));
            case 'destinationCreate': return this.tx(() => this.notifications.create(p as Input<'destinationCreate'>));
            case 'destinationGet': return this.notifications.get((p as Input<'destinationGet'>).id);
            case 'destinationSecret': return this.notifications.secret((p as Input<'destinationSecret'>).id);
            case 'destinationPatch': return this.tx(() => this.notifications.patch(p as Input<'destinationPatch'>));
            case 'destinationDelete': return this.tx(() => this.notifications.delete(p as Input<'destinationDelete'>));
            case 'destinations': {
                const { now, query } = p as Input<'destinations'>;
                return this.tx(() => this.notifications.list(now, query, true));
            }
            case 'deliveries': {
                const { now, query } = p as Input<'deliveries'>;
                return this.tx(() => this.notifications.list(now, query, false));
            }
            case 'destinationTest': return this.tx(() => this.notifications.test(p as Input<'destinationTest'>));
            case 'deliveryClaim': return this.tx(() => this.notifications.claim((p as Input<'deliveryClaim'>).now));
            case 'deliveryFinish': return this.tx(() => this.notifications.finish(p as Input<'deliveryFinish'>));
            case 'deliveryStats': return this.notifications.stats((p as Input<'deliveryStats'>).now);
            case 'stop': {
                const { now } = p as Input<'stop'>;
                return this.tx(() => { this.terminalOrder(); this.run("UPDATE checks SET lifecycle='CANCELLED',terminal_order=(SELECT value FROM check_commit_clock WHERE id=1),completed_at=?,outcome=NULL,http_status=NULL,duration_ms=NULL,error_code=NULL WHERE lifecycle IN('QUEUED','RUNNING')", now); this.run("UPDATE service_runs SET stopped_at=?,last_heartbeat_at=?,stop_reason='CLEAN' WHERE id=?", now, now, this.runId); return null; });
            }
            case 'close':
                this.db.close();
                return null;
        }
    }
    private range(now: number, from?: string, to?: string, days = 1) {
        const end = to ? Date.parse(to) : now, start = from ? Date.parse(from) : Math.max(0, end - days * 86400000);
        if (!Number.isFinite(start) || !Number.isFinite(end) || start < 0 || start >= end)
            throw new AppError('VALIDATION_ERROR', 400);
        if (end > now || end - start > 90 * 86400000)
            throw new AppError('QUERY_RANGE_TOO_LARGE', 422);
        return {
            from: start, to: end
        };
    }
    private bounded(sql: string, ...params: SQLInputValue[]) {
        const rows = this.all(sql + ' LIMIT 100001', ...params);
        if (rows.length > 100000)
            throw new AppError('QUERY_RANGE_TOO_LARGE', 422);
        return rows;
    }
    private transitionView(r: Row) {
        return {
            id: r.id, monitorId: r.monitor_id, sequence: r.sequence, fromState: r.from_state, toState: r.to_state, reason: r.reason,
            occurredAt: timestamp(r.occurred_at), checkId: r.check_id, monitorRevision: r.monitor_revision, executionEpoch: r.execution_epoch
        };
    }
    private incidentView(r: Row, now: number) {
        return {
            id: r.id, monitorId: r.monitor_id, monitorRevision: r.monitor_revision, status: r.status, openedAt: timestamp(r.opened_at), detectedAt: timestamp(r.detected_at),
            observedEndAt: timestamp(r.observed_end_at), resolvedAt: timestamp(r.resolved_at), openingCheckId: r.opening_check_id, resolvingCheckId: r.resolving_check_id,
            openingTransitionId: r.opening_transition_id, resolvingTransitionId: r.resolving_transition_id, failureCategory: r.failure_category, diagnosticSummary: r.diagnostic_summary,
            durationMs: Math.max(0, Number(r.observed_end_at ?? now) - Number(r.opened_at)), ongoing: r.status === 'OPEN', detectionDelayMs: Math.max(0, Number(r.detected_at) - Number(r.opened_at)),
            resolutionConfirmationDelayMs: r.resolved_at == null ? null : Math.max(0, Number(r.resolved_at) - Number(r.observed_end_at)),
            resolutionSummary: r.status === 'OPEN' ? null : 'Resolved after the configured consecutive successful observations.'
        };
    }
    private incidents(now: number, q: IncidentQuery) {
        const filter = JSON.stringify({
            ...q, limit: undefined, cursor: undefined
        }), c = decodeCursor(q.cursor, 'incidents', filter, now), asOf = c?.asOf ?? now;
        const range = this.range(now, q.from, q.to, 90), from = c?.from ?? range.from, to = c?.to ?? range.to;
        const allOpen = q.status === 'OPEN' && !q.from && !q.to;
        const clauses = allOpen ? ['detected_at<=?'] : ['detected_at>=?', 'detected_at<?'], params: SQLInputValue[] = allOpen ? [now] : [from, to];
        if (q.monitorId) {
            this.requireMonitor(q.monitorId);
            clauses.push('monitor_id=?');
            params.push(q.monitorId);
        }
        if (q.status) {
            clauses.push('status=?');
            params.push(q.status);
        }
        if (q.q) {
            clauses.push("monitor_id IN(SELECT id FROM monitors WHERE pulse_lower(name) LIKE ? ESCAPE '\\')");
            params.push('%' + q.q.toLowerCase().replace(/[\\%_]/g, '\\$&') + '%');
        }
        if (q.failureCategory) {
            clauses.push('failure_category=?');
            params.push(q.failureCategory);
        }
        const descending = q.sort !== 'detectedAt', limit = Number(q.limit ?? 50);
        if (c) {
            clauses.push(`(detected_at${descending ? '<' : '>'}? OR (detected_at=? AND id>?))`);
            params.push(c.key, c.key, c.id);
        }
        const rows = this.all(`SELECT * FROM incidents WHERE ${clauses.join(' AND ')} ORDER BY detected_at ${descending ? 'DESC' : 'ASC'},id LIMIT ?`, ...params, limit + 1), last = rows[limit - 1];
        return {
            data: rows.slice(0, limit).map(r => this.incidentView(r, now)), page: {
                limit, asOf: new Date(asOf).toISOString(), nextCursor: rows.length > limit && last ? encode({
                    version: 1, kind: 'incidents', filter, asOf, high: 0, key: Number(last.detected_at), id: String(last.id), from, to
                }) : null
            }
        };
    }
    private transitions(id: string, now: number, q: TransitionQuery) {
        this.requireMonitor(id);
        const filter = JSON.stringify({
            id, ...q, limit: undefined, cursor: undefined
        }), c = decodeCursor(q.cursor, 'transitions', filter, now), asOf = c?.asOf ?? now;
        const range = this.range(now, q.from, q.to), from = c?.from ?? range.from, to = c?.to ?? range.to;
        const high = c?.high ?? Number(this.one('SELECT coalesce(max(sequence),0) AS n FROM state_transitions')?.n), descending = q.sort !== 'sequence', limit = Number(q.limit ?? 50);
        const clauses = ['monitor_id=?', 'occurred_at>=?', 'occurred_at<?', 'sequence<=?'], params: SQLInputValue[] = [id, from, to, high];
        if (c) {
            clauses.push(`sequence${descending ? '<' : '>'}?`);
            params.push(c.key);
        }
        const rows = this.all(`SELECT * FROM state_transitions WHERE ${clauses.join(' AND ')} ORDER BY sequence ${descending ? 'DESC' : 'ASC'} LIMIT ?`, ...params, limit + 1), last = rows[limit - 1];
        return {
            data: rows.slice(0, limit).map(r => this.transitionView(r)), page: {
                limit, asOf: new Date(asOf).toISOString(), nextCursor: rows.length > limit && last ? encode({
                    version: 1, kind: 'transitions', filter, asOf, high, key: Number(last.sequence), id: String(last.id), from, to
                }) : null
            }
        };
    }
    private coverage(id: string, from: number, to: number, now: number, source?: {
        m: Row;
        meta: Row;
        activity: Row[];
        runs: Row[];
        transitions: Row[];
    }) {
        const m = source?.m ?? this.requireMonitor(id), meta = source?.meta ?? this.one('SELECT * FROM reliability_meta')!, start = Math.min(to, Math.max(from, Number(m.created_at))), window: Interval[] = [[start, to]];
        const boundary = Math.max(Number(meta.coverage_from ?? now), Number(meta.incidents_from ?? now));
        const supported = Math.max(start, Number(meta.coverage_from ?? now));
        const activity = source?.activity ?? this.bounded('SELECT enabled_at,disabled_at FROM monitor_activity_windows WHERE monitor_id=? AND enabled_at<? AND (disabled_at IS NULL OR disabled_at>?) ORDER BY enabled_at', id, to, start);
        const enabled = intersect(window, activity.map(r => [Number(r.enabled_at), Number(r.disabled_at ?? now)] as Interval));
        const runs = source?.runs ?? this.bounded('SELECT * FROM service_runs WHERE ready_at<? AND (stopped_at IS NULL OR stopped_at>?) ORDER BY ready_at', to, start);
        const service = intersect([[supported, to]], runs.map(r => [Number(r.ready_at), Number(r.stopped_at ?? (r.id === this.runId ? now : r.last_heartbeat_at))] as Interval));
        const covered = intersect(enabled, service), states: Interval[] = [];
        const predecessor = source ? source.transitions.filter(r => Number(r.occurred_at) <= supported).at(-1) : this.one('SELECT * FROM state_transitions WHERE monitor_id=? AND occurred_at<=? ORDER BY occurred_at DESC,sequence DESC LIMIT 1', id, supported);
        const transitions = source ? source.transitions.filter(r => Number(r.occurred_at) > supported) : this.bounded('SELECT * FROM state_transitions WHERE monitor_id=? AND occurred_at>? AND occurred_at<? ORDER BY occurred_at,sequence', id, supported, to);
        let state = predecessor ? String(predecessor.to_state) : 'UNKNOWN', cursor = supported;
        for (const r of transitions) {
            const t = Number(r.occurred_at);
            if (state !== 'UNKNOWN')
                states.push([cursor, t]);
            cursor = t;
            state = String(r.to_state);
        }
        if (state !== 'UNKNOWN')
            states.push([cursor, to]);
        const known = intersect(covered, states), effectiveMs = to - start, knownMs = measure(known), coveredMs = measure(covered);
        // Pre-migration/pruned activity cannot prove enablement; classify that prefix UNKNOWN.
        const unsupportedMs = Math.max(0, Math.min(to, supported) - start), supportedEnabled = measure(intersect(enabled, [[supported, to]]));
        const effectiveEligible = supportedEnabled + unsupportedMs;
        return {
            known, start, coverage: {
                eligibleMs: effectiveEligible, knownMs, unknownMs: Math.max(0, coveredMs - knownMs) + unsupportedMs,
                pausedMs: effectiveMs - effectiveEligible, serviceOfflineMs: Math.max(0, supportedEnabled - coveredMs), retainedFrom: timestamp(boundary), incomplete: start < boundary
            }, meta,
            notApplicableMs: start - from
        };
    }
    private incidentDetail(id: string, now: number) {
        const row = this.one('SELECT * FROM incidents WHERE id=?', id);
        if (!row)
            throw new AppError('NOT_FOUND', 404);
        const start = Number(row.opened_at), end = Math.max(start, Number(row.observed_end_at ?? now)), c = this.coverage(String(row.monitor_id), start, end, now), known = measure(c.known);
        const incomplete = start < Number(c.meta.coverage_from ?? now), downtime = known > 0 && !incomplete ? known : null;
        return {
            ...this.incidentView(row, now), asOf: new Date(now).toISOString(), observedDowntimeMs: downtime, excludedGapMs: end - start - known, coverageIncomplete: incomplete,
            transitions: this.all('SELECT * FROM state_transitions WHERE id IN (?,?) ORDER BY sequence', row.opening_transition_id!, row.resolving_transition_id ?? null).map(r => this.transitionView(r))
        };
    }
    private metrics(id: string, now: number, q: MetricsQuery) {
        const { from, to } = this.range(now, q.from, q.to, q.window === '7d' ? 7 : q.window === '30d' ? 30 : 1), m = this.requireMonitor(id);
        const bucketMs = ({
            '1m': 60000, '5m': 300000, '1h': 3600000, '1d': 86400000
        } as const)[q.bucket ?? '1h'];
        if (Math.ceil(to / bucketMs) - Math.floor(from / bucketMs) > 2000)
            throw new AppError('QUERY_RANGE_TOO_LARGE', 422);
        const c = this.coverage(id, from, to, now), meta = c.meta;
        const incidents = this.bounded('SELECT * FROM incidents WHERE monitor_id=? AND opened_at<? AND (observed_end_at IS NULL OR observed_end_at>?) ORDER BY opened_at', id, to, from);
        const spans = incidents.map(r => [Number(r.opened_at), Number(r.observed_end_at ?? now)] as Interval);
        const sampleBoundary = Math.max(Number(m.created_at), Number(meta.checks_from ?? 0)), hasEvidence = this.one('SELECT first_observation_at FROM monitor_status WHERE monitor_id=?', id)?.first_observation_at != null;
        const buckets = [], sums: number[] = [], durations: number[] = [];
        let successful = 0, degraded = 0, unclassified = 0;
        for (let start = Math.floor(from / bucketMs) * bucketMs; start < to; start += bucketMs) {
            const a = Math.max(from, start), b = Math.min(to, start + bucketMs);
            sums.push(0);
            buckets.push({
                start: new Date(a).toISOString(), end: new Date(b).toISOString(), count: 0, success: 0, failure: 0, availability: null as number | null, meanLatency: null as number | null, knownMs: measure(intersect(c.known, [[a, b]]))
            });
        }
        // Compact keyset batches bound temporary row allocations; only numeric
        // successful latencies survive for exact nearest-rank percentiles.
        const select = "SELECT sequence,started_at,outcome,duration_ms,slow_success FROM checks WHERE monitor_id=? AND started_at<? AND completed_at<=? AND lifecycle='COMPLETED' AND outcome!='POLICY_BLOCKED'";
        const first = this.db.prepare(select + ' AND started_at>=? ORDER BY started_at,sequence LIMIT ?');
        // The cursor already proves the lower bound. Repeating started_at>=from
        // makes SQLite rescan that prefix instead of seeking the composite key.
        const following = this.db.prepare(select + ' AND (started_at,sequence)>(?,?) ORDER BY started_at,sequence LIMIT ?');
        first.setReturnArrays(true); following.setReturnArrays(true);
        type Sample = [SQLOutputValue, SQLOutputValue, SQLOutputValue, SQLOutputValue, SQLOutputValue];
        let n = 0, cursor: Sample | undefined;
        for (;;) {
            const limit = Math.min(4096, 100001 - n);
            const rows = (cursor ? following.all(id, to, now, cursor[1], cursor[0], limit) : first.all(id, to, now, from, limit)) as unknown as Sample[];
            n += rows.length;
            if (n > 100000)
                throw new AppError('QUERY_RANGE_TOO_LARGE', 422);
            for (const [, started, outcome, durationMs, slow] of rows) {
                const index = Math.floor(Number(started) / bucketMs) - Math.floor(from / bucketMs), bucket = buckets[index]!;
                bucket.count++;
                if (outcome === 'SUCCESS') {
                    const duration = Number(durationMs);
                    successful++; bucket.success++; sums[index]! += duration; durations.push(duration);
                    if (slow === 1) degraded++;
                    if (slow == null) unclassified++;
                }
            }
            if (rows.length < limit)
                break;
            cursor = rows.at(-1);
        }
        for (const [index, bucket] of buckets.entries()) {
            bucket.failure = bucket.count - bucket.success;
            bucket.availability = bucket.count ? 100 * bucket.success / bucket.count : null;
            bucket.meanLatency = bucket.success ? sums[index]! / bucket.success : null;
        }
        return {
            monitorId: id, from: new Date(from).toISOString(), to: new Date(to).toISOString(), asOf: new Date(now).toISOString(), effectiveFrom: new Date(c.start).toISOString(), effectiveTo: new Date(to).toISOString(), notApplicableMs: c.notApplicableMs,
            sampleCount: n, successfulCount: successful, failedCount: n - successful, degradedCount: degraded, unclassifiedDegradationCount: unclassified,
            sampledAvailabilityPercent: n ? 100 * successful / n : null, sampleWindowIncomplete: c.start < sampleBoundary, includesManualChecks: true, latency: latency(durations),
            coverage: {
                ...c.coverage, retainedFrom: hasEvidence ? c.coverage.retainedFrom : null
            }, retention: {
                checksFrom: hasEvidence ? timestamp(sampleBoundary) : null, incidentsFrom: hasEvidence ? timestamp(meta.incidents_from) : null, coverageFrom: hasEvidence ? timestamp(meta.coverage_from) : null
            },
            observedDowntimeMs: c.coverage.knownMs && !c.coverage.incomplete ? measure(intersect(c.known, spans)) : null,
            incidentCount: incidents.filter(r => Math.min(to, Number(r.observed_end_at ?? now)) > Math.max(from, Number(r.opened_at))).length, buckets
        };
    }
    private retain(now: number, checkDays: number, incidentDays: number, deliveryDays: number) {
        const checkCut = Math.max(0, now - checkDays * 86400000), incidentCut = Math.max(0, now - incidentDays * 86400000);
        const oldest = this.one("SELECT min(opened_at) AS t FROM incidents WHERE status='OPEN' OR EXISTS(SELECT 1 FROM notification_deliveries WHERE incident_id=incidents.id)")?.t;
        const coverageCut = Math.min(incidentCut, oldest == null ? incidentCut : Number(oldest));
        let deleted = 0;
        const remove = (table: string, where: string, params: SQLInputValue[]) => {
            if (deleted >= 1000)
                return;
            const key = table === 'checks' || table === 'state_transitions' ? 'sequence' : 'id';
            deleted += Number(this.run(`DELETE FROM ${table} WHERE ${key} IN (SELECT ${key} FROM ${table} WHERE ${where} LIMIT ?)`, ...params, 1000 - deleted).changes);
        };
        remove('notification_deliveries', "finished_at<? AND state IN('SUCCEEDED','DEAD','CANCELLED')", [Math.max(0, now - deliveryDays * 86400000)]);
        remove('checks', "completed_at<? AND lifecycle IN('COMPLETED','CANCELLED','ABANDONED')", [checkCut]);
        remove('incidents', "status='RESOLVED' AND resolved_at<? AND NOT EXISTS(SELECT 1 FROM notification_deliveries WHERE incident_id=incidents.id)", [incidentCut]);
        remove('state_transitions', `occurred_at<? AND NOT EXISTS(SELECT 1 FROM incidents WHERE opening_transition_id=state_transitions.id OR resolving_transition_id=state_transitions.id)
            AND sequence!=(SELECT sequence FROM state_transitions AS predecessor WHERE predecessor.monitor_id=state_transitions.monitor_id AND predecessor.occurred_at<? ORDER BY occurred_at DESC,sequence DESC LIMIT 1)`, [coverageCut, coverageCut]);
        remove('monitor_activity_windows', 'disabled_at<?', [coverageCut]);
        remove('service_runs', 'stopped_at<? AND NOT EXISTS(SELECT 1 FROM checks WHERE service_run_id=service_runs.id)', [coverageCut]);
        this.run('UPDATE reliability_meta SET checks_from=max(coalesce(checks_from,0),?),incidents_from=max(coalesce(incidents_from,0),?),coverage_from=max(coalesce(coverage_from,0),?)', checkCut, incidentCut, coverageCut);
        return {
            deleted, more: deleted === 1000
        };
    }
    private list(now: number, q: MonitorQuery) {
        const sort = q.sort ?? 'name', filter = JSON.stringify({
            q: q.q ?? '', status: q.status ?? '', enabled: q.enabled ?? '', sort
        }), c = decodeCursor(q.cursor, 'monitors', filter, now), limit = Number(q.limit ?? 50), asOf = c?.asOf ?? now;
        const clauses: string[] = [], params: SQLInputValue[] = [];
        if (q.q) {
            clauses.push("pulse_lower(name) LIKE ? ESCAPE '\\'");
            params.push('%' + q.q.toLowerCase().replace(/[\\%_]/g, '\\$&') + '%');
        }
        if (q.enabled) {
            clauses.push('enabled=?');
            params.push(Number(q.enabled === 'true'));
        }
        if (q.status) {
            clauses.push('monitor_status.state=?');
            params.push(q.status);
        }
        const key = sort === 'name' ? 'pulse_lower(monitors.name)' : sort === '-updatedAt' ? 'monitors.updated_at' : "CASE monitor_status.state WHEN 'UNKNOWN' THEN 0 WHEN 'UP' THEN 1 WHEN 'DEGRADED' THEN 2 ELSE 3 END", descending = sort === '-updatedAt';
        if (c) {
            clauses.push(`(${key}${descending ? '<' : '>'}? OR (${key}=? AND monitors.id>?))`);
            params.push(c.key, c.key, c.id);
        }
        const rows = this.all(`${monitorSelect} ${clauses.length ? 'WHERE ' + clauses.join(' AND ') : ''} ORDER BY ${key} ${descending ? 'DESC' : 'ASC'},monitors.id LIMIT ?`, ...params, limit + 1);
        const pageRows = rows.slice(0, limit), samples = q.include ? this.samples(now, pageRows.map(r => String(r.id))) : new Map();
        const data = pageRows.map(r => ({
            ...this.monitor(r), ...(q.include ? {
                summary: samples.get(String(r.id))
            } : {})
        })), last = rows[limit - 1];
        return {
            data, page: {
                limit, asOf: new Date(asOf).toISOString(), nextCursor: rows.length > limit && last ? encode({
                    version: 1, kind: 'monitors', filter, asOf, high: 0, key: sort === 'name' ? String(last.name).toLowerCase() : sort === '-updatedAt' ? Number(last.updated_at) : ['UNKNOWN', 'UP', 'DEGRADED', 'DOWN'].indexOf(String(last.state)), id: String(last.id)
                }) : null
            }
        };
    }
    private samples(now: number, ids: string[]) {
        const result = new Map<string, {
            sampleCount: number;
            sampledAvailabilityPercent: number | null;
            meanLatencyMs: number | null;
            latestLatencyMs: number | null;
            knownMs: number;
            eligibleMs: number;
            coverageIncomplete: boolean;
        }>();
        if (!ids.length)
            return result;
        const rows = this.all(`SELECT monitor_id,count(*) AS n,sum(outcome='SUCCESS') AS successes,avg(CASE WHEN outcome='SUCCESS' THEN duration_ms END) AS mean FROM checks WHERE monitor_id IN (${ids.map(() => '?').join(',')}) AND started_at>=? AND started_at<? AND lifecycle='COMPLETED' AND outcome!='POLICY_BLOCKED' GROUP BY monitor_id`, ...ids, now - 86400000, now);
        const latest = this.all(`SELECT monitors.id AS monitor_id,latest.duration_ms FROM monitors JOIN checks AS latest ON latest.sequence=(SELECT max(sequence) FROM checks WHERE monitor_id=monitors.id AND lifecycle='COMPLETED') WHERE monitors.id IN (${ids.map(() => '?').join(',')})`, ...ids);
        const placeholders = ids.map(() => '?').join(','), meta = this.one('SELECT * FROM reliability_meta')!, from = now - 86400000, supported = Math.max(from, Number(meta.coverage_from ?? now));
        const monitors = this.all(`SELECT * FROM monitors WHERE id IN(${placeholders})`, ...ids), activity = this.bounded(`SELECT * FROM monitor_activity_windows WHERE monitor_id IN(${placeholders}) AND enabled_at<? AND (disabled_at IS NULL OR disabled_at>?) ORDER BY enabled_at`, ...ids, now, from), runs = this.bounded('SELECT * FROM service_runs WHERE ready_at<? AND (stopped_at IS NULL OR stopped_at>?) ORDER BY ready_at', now, from), transitions = this.bounded(`SELECT * FROM state_transitions WHERE monitor_id IN(${placeholders}) AND occurred_at<? AND (occurred_at>? OR sequence=(SELECT sequence FROM state_transitions predecessor WHERE predecessor.monitor_id=state_transitions.monitor_id AND occurred_at<=? ORDER BY occurred_at DESC,sequence DESC LIMIT 1)) ORDER BY occurred_at,sequence`, ...ids, now, supported, supported);
        const group = (rows: Row[]) => {
            const map = new Map<string, Row[]>();
            for (const row of rows) {
                const id = String(row.monitor_id);
                if (!map.has(id))
                    map.set(id, []);
                map.get(id)!.push(row);
            }
            return map;
        }, activities = group(activity), states = group(transitions);
        // One bounded source query per collection, independent of the number of cards.
        for (const id of ids) {
            const r = rows.find(r => r.monitor_id === id), c = this.coverage(id, from, now, now, {
                m: monitors.find(r => r.id === id)!, meta, activity: activities.get(id) ?? [], runs, transitions: states.get(id) ?? []
            }).coverage, n = Number(r?.n ?? 0);
            result.set(id, {
                sampleCount: n, sampledAvailabilityPercent: n ? 100 * Number(r?.successes) / n : null, meanLatencyMs: r?.mean == null ? null : Number(r.mean), latestLatencyMs: latest.find(r => r.monitor_id === id)?.duration_ms == null ? null : Number(latest.find(r => r.monitor_id === id)!.duration_ms), knownMs: c.knownMs, eligibleMs: c.eligibleMs, coverageIncomplete: c.incomplete
            });
        }
        return result;
    }
    private dashboard(now: number) {
        const summary = this.handle('summary', {
            now
        }) as Output<'summary'>;
        const r = this.one("SELECT count(*) AS n,sum(outcome='SUCCESS') AS success,avg(CASE WHEN outcome='SUCCESS' THEN duration_ms END) AS mean FROM checks WHERE started_at>=? AND started_at<? AND lifecycle='COMPLETED' AND outcome!='POLICY_BLOCKED'", now - 86400000, now)!;
        const { asOf, ...counts } = summary;
        return {
            asOf, window: '24h', counts, sampleCount: Number(r.n), sampledAvailabilityPercent: Number(r.n) ? 100 * Number(r.success) / Number(r.n) : null, meanLatencyMs: r.mean == null ? null : Number(r.mean), recentIncidents: this.all('SELECT * FROM incidents ORDER BY detected_at DESC,id LIMIT 10').map(r => this.incidentView(r, now)), recentTransitions: this.all('SELECT * FROM state_transitions ORDER BY sequence DESC LIMIT 10').map(r => this.transitionView(r))
        };
    }
    private history(id: string, now: number, q: HistoryQuery) {
        this.requireMonitor(id);
        const filter = JSON.stringify({
            id, from: q.from ?? '', to: q.to ?? '', outcome: q.outcome ?? '', sort: q.sort ?? '-sequence'
        }), c = decodeCursor(q.cursor, 'checks', filter, now), asOf = c?.asOf ?? now, from = c?.from ?? (q.from ? Date.parse(q.from) : now - 86400000), to = c?.to ?? (q.to ? Date.parse(q.to) : now);
        if (from >= to)
            throw new AppError('VALIDATION_ERROR', 400);
        if (to > now || to - from > 90 * 86400000)
            throw new AppError('QUERY_RANGE_TOO_LARGE', 422);
        const high = c?.high ?? Number(this.one('SELECT value AS n FROM check_commit_clock WHERE id=1')?.n), descending = q.sort !== 'sequence', limit = Number(q.limit ?? 50);
        const clauses = ["monitor_id=?", "lifecycle IN('COMPLETED','CANCELLED','ABANDONED')", 'terminal_order<=?', 'completed_at<=?', 'coalesce(started_at,queued_at)>=?', 'coalesce(started_at,queued_at)<?'], params: SQLInputValue[] = [id, high, asOf, from, to];
        if (q.outcome) {
            clauses.push('outcome=?');
            params.push(q.outcome);
        }
        if (c) {
            clauses.push(`sequence${descending ? '<' : '>'}?`);
            params.push(c.key);
        }
        const rows = this.all(`SELECT * FROM checks WHERE ${clauses.join(' AND ')} ORDER BY sequence ${descending ? 'DESC' : 'ASC'} LIMIT ?`, ...params, limit + 1), last = rows[limit - 1];
        return {
            data: rows.slice(0, limit).map(r => this.check(r)), page: {
                limit, asOf: new Date(asOf).toISOString(), nextCursor: rows.length > limit && last ? encode({
                    version: 1, kind: 'checks', filter, asOf, high, key: Number(last.sequence), id: String(last.id), from, to
                }) : null
            }
        };
    }
}
