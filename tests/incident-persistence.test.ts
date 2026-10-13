import { describe, it, expect } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import { randomUUID, createHash } from 'node:crypto';
import { fixture, failure, epoch } from './reliability-helpers.js';
import { success, temp, dispose, input } from './helpers.js';
import { Store } from '../apps/server/src/persistence/store.js';
import { migration1 } from '../apps/server/src/persistence/migration.js';
import { join } from 'node:path';
import { writeFile, mkdir } from 'node:fs/promises';
describe('transactional on-disk incident engine', () => {
    it('uses timestamp, queue and evidence-link indexes in actual SQLite query plans', async () => {
        const f = await fixture();
        try {
            const m = f.create({
                failureThreshold: 1
            });
            f.check(m.id, failure);
            const r = f.s.db.prepare('SELECT * FROM incidents').get()!;
            const queries: [
                string,
                string,
                (string | number)[]
            ][] = [
                ['checks_monitor_started', "SELECT * FROM checks WHERE monitor_id=? AND started_at>=? AND started_at<? ORDER BY started_at,sequence", [m.id, epoch, f.now]],
                ['checks_retention', "SELECT sequence FROM checks WHERE completed_at<? AND lifecycle IN('COMPLETED','CANCELLED','ABANDONED') LIMIT 1000", [f.now]],
                ['checks_queued', "SELECT id FROM checks WHERE lifecycle='QUEUED' ORDER BY queued_at,id LIMIT 1", []],
                ['checks_cancelled', "SELECT count(*) AS n FROM checks WHERE lifecycle='CANCELLED'", []],
                ['checks_abandoned', "SELECT count(*) AS n FROM checks WHERE lifecycle='ABANDONED'", []],
                ['incidents_one_open', "SELECT * FROM incidents WHERE status='OPEN' AND monitor_id=?", [m.id]],
                ['incidents_monitor_time', 'SELECT * FROM incidents WHERE monitor_id=? AND opened_at<? ORDER BY opened_at', [m.id, f.now]],
                ['incidents_detected', 'SELECT * FROM incidents WHERE detected_at<? ORDER BY detected_at,id LIMIT 50', [f.now]],
                ['incidents_resolved', "SELECT id FROM incidents WHERE status='RESOLVED' AND resolved_at<? LIMIT 1000", [f.now]],
                ['transitions_monitor_time', 'SELECT * FROM state_transitions WHERE monitor_id=? AND occurred_at<=? ORDER BY occurred_at DESC,sequence DESC LIMIT 1', [m.id, f.now]],
                ['transitions_retention', 'SELECT sequence FROM state_transitions WHERE occurred_at<? LIMIT 1000', [f.now]],
                ['activity_monitor_time', 'SELECT * FROM monitor_activity_windows WHERE monitor_id=? AND enabled_at<? ORDER BY enabled_at', [m.id, f.now]],
                ['activity_one_open', 'SELECT * FROM monitor_activity_windows WHERE monitor_id=? AND disabled_at IS NULL', [m.id]],
                ['service_runs_coverage', 'SELECT * FROM service_runs WHERE ready_at<? ORDER BY ready_at', [f.now]],
                ['status_open_incident', 'SELECT * FROM monitor_status WHERE open_incident_id=?', [String(r.id)]],
                ['status_check', 'SELECT * FROM monitor_status WHERE last_check_id=?', [String(r.opening_check_id)]],
                ['transitions_check', 'SELECT * FROM state_transitions WHERE check_id=?', [String(r.opening_check_id)]],
                ['incidents_opening_check', 'SELECT * FROM incidents WHERE opening_check_id=?', [String(r.opening_check_id)]],
                ['incidents_resolving_check', 'SELECT * FROM incidents WHERE resolving_check_id=?', [String(r.opening_check_id)]],
                ['incidents_opening_transition', 'SELECT * FROM incidents WHERE opening_transition_id=?', [String(r.opening_transition_id)]],
                ['incidents_resolving_transition', 'SELECT * FROM incidents WHERE resolving_transition_id=?', [String(r.opening_transition_id)]],
                ['checks_dashboard', "SELECT count(*) FROM checks WHERE lifecycle='COMPLETED' AND outcome!='POLICY_BLOCKED' AND started_at>=?", [epoch]],
                ['deliveries_due', "SELECT id FROM notification_deliveries WHERE state='PENDING' AND next_attempt_at<=? ORDER BY next_attempt_at,id LIMIT 1", [f.now]],
                ['deliveries_destination', 'SELECT id FROM notification_deliveries WHERE destination_id=? ORDER BY sequence', [m.id]],
                ['deliveries_finished', "SELECT id FROM notification_deliveries WHERE state IN('SUCCEEDED','DEAD','CANCELLED') AND finished_at<? LIMIT 1000", [f.now]]
            ];
            const plans = queries.map(([index, sql, params]) => {
                const plan = f.s.db.prepare('EXPLAIN QUERY PLAN ' + sql).all(...params);
                expect(JSON.stringify(plan)).toContain(index);
                return {
                    index, sql, plan
                };
            });
            await mkdir('docs/evidence', {
                recursive: true
            });
            await writeFile('docs/evidence/stage-3-query-plans.json', JSON.stringify({
                recordedAt: new Date().toISOString(), sqlite: f.s.db.prepare('SELECT sqlite_version() AS v').get()?.v, plans
            }, null, 2) + '\n');
        }
        finally {
            await f.close();
        }
    });
    it('active incidents older than ninety days remain listable; incident and transition cursors reject mismatched contexts', async () => {
        const f = await fixture();
        try {
            const m = f.create({
                failureThreshold: 1, recoveryThreshold: 1
            });
            f.check(m.id, failure);
            f.check(m.id);
            f.check(m.id, failure);
            f.now++;
            const page = f.s.execute('incidents', {
                now: f.now, query: {
                    limit: '1'
                }
            });
            expect(page.page.nextCursor).not.toBeNull();
            const next = f.s.execute('incidents', {
                now: f.now, query: {
                    limit: '1', cursor: page.page.nextCursor!
                }
            });
            expect(next.data[0]!.id).not.toBe(page.data[0]!.id);
            expect(() => f.s.execute('incidents', {
                now: f.now, query: {
                    limit: '1', status: 'OPEN', cursor: page.page.nextCursor!
                }
            })).toThrow('VALIDATION_ERROR');
            const transitions = f.s.execute('transitions', {
                id: m.id, now: f.now, query: {
                    limit: '1', sort: 'sequence'
                }
            });
            f.check(m.id);
            f.now++;
            const second = f.s.execute('transitions', {
                id: m.id, now: f.now, query: {
                    limit: '100', sort: 'sequence', cursor: transitions.page.nextCursor!
                }
            });
            expect(second.data).toHaveLength(2); // the recovery appended after the snapshot is excluded
            f.check(m.id, failure);
            f.now += 100 * 86400000;
            expect(f.s.execute('incidents', {
                now: f.now, query: {
                    status: 'OPEN'
                }
            }).data).toHaveLength(1);
            expect(f.s.execute('incidents', {
                now: f.now, query: {}
            }).data).toHaveLength(0);
        }
        finally {
            await f.close();
        }
    });
    it('rejects a backwards completion atomically and preserves counters across rename-only edits', async () => {
        const f = await fixture();
        try {
            const m = f.create();
            f.check(m.id, failure);
            f.s.execute('patch', {
                id: m.id, revision: 1, now: f.now, input: {
                    name: 'Rename', enabled: true
                }
            });
            expect(f.s.db.prepare('SELECT consecutive_failures FROM monitor_status').get()?.consecutive_failures).toBe(1);
            const queued = f.s.execute('manual', {
                id: m.id, now: f.now, limit: 100
            });
            f.s.execute('dispatch', {
                now: f.now, preferManual: true
            });
            expect(() => f.s.execute('finish', {
                id: queued.id, now: f.now - 1, observation: failure
            })).toThrow();
            expect(f.s.execute('execution', {
                id: queued.id
            }).lifecycle).toBe('RUNNING');
            expect(f.s.db.prepare('SELECT consecutive_failures FROM monitor_status').get()?.consecutive_failures).toBe(1);
            f.s.execute('finish', {
                id: queued.id, now: f.now + 10, observation: failure
            });
            expect(f.s.db.prepare('SELECT consecutive_failures FROM monitor_status').get()?.consecutive_failures).toBe(2);
        }
        finally {
            await f.close();
        }
    });
    it('one transient failure opens no incident; three mixed failures open exactly one; confirmed recovery resolves it', async () => {
        const f = await fixture();
        try {
            const m = f.create();
            f.check(m.id);
            f.check(m.id, failure);
            expect(f.s.execute('get', {
                id: m.id
            }).status).toEqual({
                state: 'DEGRADED', reason: 'PENDING_FAILURE'
            });
            f.check(m.id);
            f.check(m.id);
            expect(f.s.execute('get', {
                id: m.id
            }).status.state).toBe('UP');
            const onset = f.now;
            f.check(m.id, failure);
            f.check(m.id, {
                ...failure, outcome: 'CONNECTION_ERROR', httpStatus: null
            });
            const opening = f.check(m.id, {
                ...failure, outcome: 'TIMEOUT', httpStatus: null
            });
            const incident = f.s.db.prepare('SELECT * FROM incidents').get()!;
            expect(incident).toMatchObject({
                status: 'OPEN', opened_at: onset, detected_at: f.now, opening_check_id: opening, failure_category: 'TIMEOUT'
            });
            for (let i = 0; i < 20; i++)
                f.check(m.id, failure);
            expect(f.s.db.prepare('SELECT count(*) AS n FROM incidents').get()?.n).toBe(1);
            const recovery = f.now;
            f.check(m.id);
            expect(f.s.execute('get', {
                id: m.id
            }).status.state).toBe('DOWN');
            f.check(m.id);
            expect(f.s.execute('get', {
                id: m.id
            }).status.state).toBe('UP');
            expect(f.s.db.prepare('SELECT * FROM incidents').get()).toMatchObject({
                id: incident.id, status: 'RESOLVED', observed_end_at: recovery, resolved_at: f.now
            });
            expect(f.s.execute('incident', {
                id: String(incident.id), now: f.now
            }).durationMs).toBe(recovery - onset);
            expect(f.s.db.prepare('PRAGMA foreign_key_check').all()).toEqual([]);
        }
        finally {
            await f.close();
        }
    });
    it('pause, redundant pause, rename, resume and restart preserve the unresolved outage', async () => {
        const f = await fixture();
        try {
            const m = f.create();
            for (let i = 0; i < 3; i++)
                f.check(m.id, failure);
            const incident = f.s.db.prepare('SELECT id FROM incidents').get()!.id;
            let monitor = f.s.execute('patch', {
                id: m.id, revision: 1, now: f.now, input: {
                    enabled: false
                }
            });
            expect(monitor.status).toEqual({
                state: 'UNKNOWN', reason: 'PAUSED'
            });
            expect(f.s.execute('patch', {
                id: m.id, revision: 2, now: f.now, input: {
                    enabled: false
                }
            }).revision).toBe(2);
            monitor = f.s.execute('patch', {
                id: m.id, revision: 2, now: f.now, input: {
                    name: 'Renamed'
                }
            });
            expect(monitor.status.reason).toBe('PAUSED');
            expect(() => f.s.execute('manual', {
                id: m.id, now: f.now, limit: 100
            })).toThrow('MONITOR_DISABLED');
            f.restart(f.now + 1000);
            monitor = f.s.execute('patch', {
                id: m.id, revision: 3, now: f.now, input: {
                    enabled: true
                }
            });
            expect(monitor.status).toEqual({
                state: 'UNKNOWN', reason: 'INITIAL'
            });
            f.check(m.id);
            expect(f.s.execute('get', {
                id: m.id
            }).status.state).toBe('UNKNOWN');
            f.check(m.id);
            expect(f.s.db.prepare('SELECT id,status FROM incidents').get()).toMatchObject({
                id: incident, status: 'RESOLVED'
            });
        }
        finally {
            await f.close();
        }
    });
    it('restart abandons running/queued attempts, clears runs, reuses incident and recovers overdue work once', async () => {
        const f = await fixture();
        try {
            const m = f.create();
            for (let i = 0; i < 3; i++)
                f.check(m.id, failure);
            const id = f.s.execute('manual', {
                id: m.id, now: f.now, limit: 100
            }).id;
            f.s.execute('dispatch', {
                now: f.now, preferManual: true
            });
            f.s.execute('heartbeat', {
                now: f.now
            });
            const heartbeat = f.now;
            f.restart(f.now + 900000);
            expect(f.s.execute('execution', {
                id
            })).toMatchObject({
                lifecycle: 'ABANDONED', outcome: null, durationMs: null
            });
            expect(f.s.execute('get', {
                id: m.id
            }).status.state).toBe('UNKNOWN');
            const r = f.s.execute('dispatch', {
                now: f.now, preferManual: false
            })!;
            expect(r.monitor.id).toBe(m.id);
            f.s.execute('finish', {
                id: r.check.id, now: f.now + 1, observation: failure
            });
            expect(f.s.execute('get', {
                id: m.id
            }).status.state).toBe('DOWN');
            expect(f.s.execute('dispatch', {
                now: f.now + 2, preferManual: false
            })).toBeNull();
            expect(f.s.db.prepare('SELECT count(*) AS n FROM incidents').get()?.n).toBe(1);
            expect(f.s.db.prepare("SELECT stopped_at FROM service_runs WHERE stop_reason='ABANDONED'").get()?.stopped_at).toBe(heartbeat);
        }
        finally {
            await f.close();
        }
    });
    it('duplicate and stale completions cannot change persisted history or counters', async () => {
        const f = await fixture();
        try {
            const m = f.create({
                failureThreshold: 1
            }), id = f.check(m.id, failure);
            f.s.execute('finish', {
                id, now: f.now + 1, observation: success
            });
            expect(f.s.execute('execution', {
                id
            }).outcome).toBe('HTTP_ERROR');
            const pending = f.s.execute('manual', {
                id: m.id, now: f.now, limit: 100
            });
            f.s.execute('dispatch', {
                now: f.now, preferManual: true
            });
            f.s.execute('patch', {
                id: m.id, revision: 1, now: f.now + 1, input: {
                    timeoutMs: 2000
                }
            });
            f.s.execute('finish', {
                id: pending.id, now: f.now + 2, observation: success
            });
            expect(f.s.execute('execution', {
                id: pending.id
            }).lifecycle).toBe('CANCELLED');
            expect(f.s.execute('get', {
                id: m.id
            }).status.state).toBe('UNKNOWN');
            expect(f.s.db.prepare('SELECT status FROM incidents').get()?.status).toBe('OPEN');
            expect(f.s.db.prepare('SELECT consecutive_successes FROM monitor_status').get()?.consecutive_successes).toBe(0);
        }
        finally {
            await f.close();
        }
    });
    it.each([
        "BEFORE UPDATE ON checks", 'BEFORE INSERT ON state_transitions', 'BEFORE INSERT ON incidents',
        'BEFORE UPDATE ON monitor_status', 'BEFORE UPDATE ON monitors'
    ])('rolls back every effect on failure at %s', async (trigger) => {
        const f = await fixture();
        try {
            const m = f.create({
                failureThreshold: 1
            }), r = f.s.execute('dispatch', {
                now: f.now, preferManual: false
            })!;
            const snapshot = () => JSON.stringify(['checks', 'monitor_status', 'state_transitions', 'incidents', 'monitors', 'check_commit_clock'].map(t => f.s.db.prepare(`SELECT * FROM ${t}`).all()));
            const before = snapshot();
            f.s.db.exec(`CREATE TRIGGER inject ${trigger} BEGIN SELECT RAISE(ABORT,'INJECTED_WRITE_FAILURE'); END`);
            expect(() => f.s.execute('finish', {
                id: r.check.id, now: f.now + 10, observation: failure
            })).toThrow();
            expect(snapshot()).toBe(before);
            f.s.db.exec('DROP TRIGGER inject');
            f.s.execute('finish', {
                id: r.check.id, now: f.now + 10, observation: failure
            });
            expect(f.s.execute('get', {
                id: m.id
            }).status.state).toBe('DOWN');
            expect(f.s.db.prepare('SELECT count(*) AS n FROM incidents').get()?.n).toBe(1);
        }
        finally {
            await f.close();
        }
    });
    it('recovery rollback retains the OPEN incident and the RUNNING execution', async () => {
        const f = await fixture();
        try {
            const m = f.create({
                failureThreshold: 1, recoveryThreshold: 1
            });
            f.check(m.id, failure);
            const r = f.s.execute('manual', {
                id: m.id, now: f.now, limit: 100
            });
            f.s.execute('dispatch', {
                now: f.now, preferManual: true
            });
            f.s.db.exec("CREATE TRIGGER inject BEFORE UPDATE ON incidents BEGIN SELECT RAISE(ABORT,'INJECTED_WRITE_FAILURE'); END");
            expect(() => f.s.execute('finish', {
                id: r.id, now: f.now + 10, observation: success
            })).toThrow();
            expect(f.s.execute('get', {
                id: m.id
            }).status.state).toBe('DOWN');
            expect(f.s.execute('execution', {
                id: r.id
            }).lifecycle).toBe('RUNNING');
            expect(f.s.db.prepare('SELECT count(*) AS n FROM state_transitions').get()?.n).toBe(1);
            f.s.db.exec('DROP TRIGGER inject');
            f.s.execute('finish', {
                id: r.id, now: f.now + 10, observation: success
            });
            expect(f.s.db.prepare('SELECT status FROM incidents').get()?.status).toBe('RESOLVED');
        }
        finally {
            await f.close();
        }
    });
    it('enforces uniqueness, deferred anchors and confirmed owner deletion with cyclic links', async () => {
        const f = await fixture();
        try {
            const m = f.create({
                failureThreshold: 1
            });
            f.check(m.id, failure);
            expect(() => f.s.db.prepare('INSERT INTO incidents SELECT ?,monitor_id,monitor_revision,status,opened_at,detected_at,observed_end_at,resolved_at,opening_check_id,resolving_check_id,opening_transition_id,resolving_transition_id,failure_category,diagnostic_summary FROM incidents').run(randomUUID())).toThrow();
            expect(() => f.s.db.exec('DELETE FROM state_transitions')).toThrow();
            f.s.execute('delete', {
                id: m.id, revision: 1, now: f.now
            });
            for (const table of ['checks', 'incidents', 'state_transitions', 'monitor_status', 'monitor_activity_windows'])
                expect(f.s.db.prepare(`SELECT count(*) AS n FROM ${table}`).get()?.n).toBe(0);
            expect(f.s.db.prepare('PRAGMA foreign_key_check').all()).toEqual([]);
        }
        finally {
            await f.close();
        }
    });
    it('migrates a real Stage 1 database without rewriting checks or fabricating old coverage', async () => {
        const dir = await temp(), path = join(dir, 'pulse.sqlite'), db = new DatabaseSync(path);
        try {
            db.exec('CREATE TABLE schema_migrations(version INTEGER PRIMARY KEY,checksum TEXT NOT NULL,applied_at INTEGER NOT NULL) STRICT');
            db.exec(migration1);
            db.prepare('INSERT INTO schema_migrations VALUES(1,?,?)').run(createHash('sha256').update(migration1).digest('hex'), epoch);
            const id = randomUUID(), m = input();
            db.prepare('INSERT INTO monitors VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,1,1,?,?,?)').run(id, m.name, m.url, m.method, JSON.stringify(m.expectedStatusCodes), m.intervalMs, m.timeoutMs, 0, 1, 3, 2, 1000, 3, epoch, epoch, epoch);
            const runId = randomUUID(), checkId = randomUUID();
            db.prepare('INSERT INTO service_runs(id,started_at,ready_at,last_heartbeat_at,stopped_at,config_fingerprint) VALUES(?,?,?,?,?,?)').run(runId, epoch, epoch, epoch + 200, epoch + 200, 'a'.repeat(64));
            db.prepare("INSERT INTO checks(id,monitor_id,service_run_id,monitor_revision,execution_epoch,trigger,lifecycle,queued_at,started_at,completed_at,outcome,http_status,duration_ms,terminal_order) VALUES(?,?,?,1,1,'automatic','COMPLETED',?,?,?,'SUCCESS',200,125,1)").run(checkId, id, runId, epoch + 10, epoch + 10, epoch + 135);
            db.exec('UPDATE check_commit_clock SET value=1');
            db.close();
            const s = new Store(path);
            try {
                s.execute('initialize', {
                    now: epoch + 1000, runId: randomUUID(), fingerprint: 'a'.repeat(64)
                });
                expect(s.execute('get', {
                    id
                }).status.state).toBe('UNKNOWN');
                expect(s.db.prepare('SELECT enabled_at FROM monitor_activity_windows').get()?.enabled_at).toBe(epoch + 1000);
                expect(s.db.prepare('SELECT count(*) AS n FROM schema_migrations').get()?.n).toBe(5);
                expect(s.execute('execution', {
                    id: checkId
                })).toMatchObject({
                    lifecycle: 'COMPLETED', outcome: 'SUCCESS', durationMs: 125
                });
                const metrics = s.execute('metrics', {
                    id, now: epoch + 2000, query: {
                        from: new Date(epoch).toISOString(), to: new Date(epoch + 2000).toISOString()
                    }
                });
                expect(metrics).toMatchObject({
                    sampleCount: 1, successfulCount: 1, unclassifiedDegradationCount: 1, degradedCount: 0, sampledAvailabilityPercent: 100, observedDowntimeMs: null
                });
                expect(metrics.coverage.knownMs).toBe(0);
                expect(metrics.coverage.incomplete).toBe(true);
            }
            finally {
                s.execute('close', {});
            }
        }
        finally {
            await dispose(dir);
        }
    });
    it('read-only SQLite and actual page-limit exhaustion preserve committed records', async () => {
        const f = await fixture();
        try {
            const m = f.create();
            f.s.db.exec('PRAGMA query_only=ON');
            expect(() => f.check(m.id, failure)).toThrow();
            f.s.db.exec('PRAGMA query_only=OFF');
            expect(f.s.execute('get', {
                id: m.id
            }).status.state).toBe('UNKNOWN');
            const pages = Number(f.s.db.prepare('PRAGMA page_count').get()?.page_count);
            f.s.db.exec(`PRAGMA max_page_count=${pages}`);
            let full = false;
            for (let i = 0; i < 100 && !full; i++)
                try {
                    f.create({
                        url: 'https://example.com/' + 'x'.repeat(1900)
                    });
                }
                catch (e) {
                    full = String(e).includes('full');
                    if (!full)
                        throw e;
                }
            expect(full).toBe(true);
            expect(f.s.execute('get', {
                id: m.id
            }).name).toBe('Fixture');
            expect(f.s.db.prepare('PRAGMA integrity_check').get()?.integrity_check).toBe('ok');
            expect(f.s.db.prepare('PRAGMA foreign_key_check').all()).toEqual([]);
        }
        finally {
            await f.close();
        }
    });
});
