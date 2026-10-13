import { describe, it, expect } from 'vitest';
import { randomUUID } from 'node:crypto';
import { latency, intersect, measure, union } from '../apps/server/src/domain/metrics.js';
import { fixture, failure, epoch } from './reliability-helpers.js';
import { success } from './helpers.js';
describe('qualified analytics and bounded retention', () => {
    it('calculates exact fixed-window 80% availability and nearest-rank latency with half-open boundaries', async () => {
        const f = await fixture();
        try {
            const m = f.create(), from = f.now;
            for (const durationMs of [100, 200, 300, 1000])
                f.check(m.id, {
                    ...success, durationMs
                });
            f.check(m.id, {
                ...failure, outcome: 'TIMEOUT', httpStatus: null
            });
            const to = f.now;
            f.check(m.id); // starts exactly at to, excluded from the requested window
            const r = f.s.execute('metrics', {
                id: m.id, now: f.now, query: {
                    from: new Date(from).toISOString(), to: new Date(to).toISOString()
                }
            });
            expect(r).toMatchObject({
                sampleCount: 5, successfulCount: 4, failedCount: 1, degradedCount: 1, sampledAvailabilityPercent: 80, incidentCount: 0, observedDowntimeMs: 0,
                latency: {
                    count: 4, meanMs: 400, minMs: 100, maxMs: 1000, p50Ms: 200, p95Ms: 1000, p99Ms: 1000, lowSample: true, p99Sufficient: false
                }
            });
            expect(r.buckets[0]).toMatchObject({
                count: 5, availability: 80, meanLatency: 400
            });
            f.s.execute('patch', {
                id: m.id, revision: 1, now: f.now, input: {
                    latencyThresholdMs: 1
                }
            });
            expect(f.s.execute('metrics', {
                id: m.id, now: f.now, query: {
                    from: new Date(from).toISOString(), to: new Date(to).toISOString()
                }
            }).degradedCount).toBe(1);
        }
        finally {
            await f.close();
        }
    });
    it('partitions 60 minutes into paused 10, offline 10, UNKNOWN 5, known 35, and clips outage to known intervals', async () => {
        const f = await fixture();
        try {
            const m = f.create({
                failureThreshold: 1, recoveryThreshold: 1
            }), minute = 60000;
            f.now = epoch + 5 * minute - 10;
            f.check(m.id); // health known at minute 5
            f.now = epoch + 10 * minute;
            f.check(m.id, failure); // incident onset minute 10
            f.now = epoch + 20 * minute;
            f.s.execute('patch', {
                id: m.id, revision: 1, now: f.now, input: {
                    enabled: false
                }
            });
            f.now = epoch + 30 * minute;
            f.s.execute('patch', {
                id: m.id, revision: 2, now: f.now, input: {
                    enabled: true
                }
            });
            f.check(m.id, failure); // retained incident reestablishes known DOWN after 10ms
            f.now = epoch + 40 * minute;
            f.s.execute('heartbeat', {
                now: f.now
            });
            f.restart(epoch + 50 * minute);
            f.check(m.id, failure);
            f.now = epoch + 55 * minute;
            f.check(m.id);
            f.now = epoch + 60 * minute;
            const r = f.s.execute('metrics', {
                id: m.id, now: f.now, query: {
                    from: new Date(epoch).toISOString(), to: new Date(f.now).toISOString()
                }
            });
            expect(r.coverage).toMatchObject({
                pausedMs: 10 * minute, serviceOfflineMs: 10 * minute, unknownMs: 5 * minute + 20, knownMs: 35 * minute - 20, eligibleMs: 50 * minute
            });
            expect(r.coverage.knownMs + r.coverage.unknownMs + r.coverage.serviceOfflineMs + r.coverage.pausedMs).toBe(60 * minute);
            expect(r.observedDowntimeMs).toBe(25 * minute - 20);
            const incident = f.s.execute('incidents', {
                now: f.now, query: {}
            }).data[0]!;
            expect(incident.durationMs).toBe(45 * minute);
            expect(incident.resolutionConfirmationDelayMs).toBe(10);
            expect(f.s.execute('incident', {
                id: incident.id, now: f.now
            })).toMatchObject({
                observedDowntimeMs: 25 * minute - 20, excludedGapMs: 20 * minute + 20
            });
        }
        finally {
            await f.close();
        }
    });
    it('empty, cancelled, policy-blocked, pre-creation and insufficient histories never become successful availability', async () => {
        const f = await fixture();
        try {
            const m = f.create(), query = {
                from: new Date(epoch).toISOString(), to: new Date(epoch + 1000).toISOString()
            };
            f.now += 1000;
            const empty = f.s.execute('metrics', {
                id: m.id, now: f.now, query
            });
            expect(empty.sampledAvailabilityPercent).toBeNull();
            expect(empty.observedDowntimeMs).toBeNull();
            expect(empty.retention).toEqual({
                checksFrom: null, incidentsFrom: null, coverageFrom: null
            });
            expect(empty.coverage.retainedFrom).toBeNull();
            expect(empty.coverage.unknownMs).toBe(1000);
            const queued = f.s.execute('manual', {
                id: m.id, now: f.now, limit: 100
            });
            f.s.execute('patch', {
                id: m.id, revision: 1, now: f.now, input: {
                    name: 'Rename'
                }
            });
            expect(f.s.execute('execution', {
                id: queued.id
            }).lifecycle).toBe('CANCELLED');
            f.check(m.id, {
                ...failure, outcome: 'POLICY_BLOCKED'
            });
            f.now++;
            const r = f.s.execute('metrics', {
                id: m.id, now: f.now, query: {}
            });
            expect(r.sampleCount).toBe(0);
            expect(r.latency.meanMs).toBeNull();
            const before = f.s.execute('metrics', {
                id: m.id, now: f.now, query: {
                    from: new Date(epoch - 1000).toISOString(), to: new Date(epoch - 1).toISOString()
                }
            });
            expect(before.coverage.eligibleMs).toBe(0);
            expect(before.notApplicableMs).toBe(999);
            expect(before.sampledAvailabilityPercent).toBeNull();
            f.check(m.id);
            f.now += 1000000;
            const sparse = f.s.execute('metrics', {
                id: m.id, now: f.now, query: {}
            });
            expect(sparse.sampleCount).toBe(1);
            expect(sparse.sampledAvailabilityPercent).toBe(100);
            expect(sparse.latency.lowSample).toBe(true);
        }
        finally {
            await f.close();
        }
    });
    it('window options 24h/7d/30d, caps, UTC bucket clipping and weighted means are explicit', async () => {
        const f = await fixture();
        try {
            const m = f.create();
            f.check(m.id, {
                ...success, durationMs: 100
            });
            f.now = epoch + 3600000;
            for (let i = 0; i < 3; i++)
                f.check(m.id, {
                    ...success, durationMs: 300
                });
            for (const window of ['24h', '7d', '30d'] as const)
                expect(f.s.execute('metrics', {
                    id: m.id, now: f.now, query: {
                        window
                    }
                }).sampleCount).toBe(4);
            const r = f.s.execute('metrics', {
                id: m.id, now: f.now, query: {
                    from: new Date(epoch).toISOString(), to: new Date(f.now).toISOString()
                }
            });
            expect(r.latency.meanMs).toBe(250);
            expect(r.buckets.map(b => b.meanLatency)).toEqual([100, 300]);
            expect(r.buckets[1]!.end).toBe(new Date(f.now).toISOString());
            expect(() => f.s.execute('metrics', {
                id: m.id, now: f.now, query: {
                    window: '30d', bucket: '1m'
                }
            })).toThrow('QUERY_RANGE_TOO_LARGE');
            expect(() => f.s.execute('metrics', {
                id: m.id, now: f.now, query: {
                    to: new Date(f.now + 1).toISOString()
                }
            })).toThrow('QUERY_RANGE_TOO_LARGE');
            expect(() => f.s.execute('metrics', {
                id: m.id, now: f.now, query: {
                    from: new Date(f.now).toISOString(), to: new Date(epoch).toISOString()
                }
            })).toThrow('VALIDATION_ERROR');
        }
        finally {
            await f.close();
        }
    });
    it('keeps tied timestamps and earlier observations with later sequences exact across metric batches', async () => {
        const f = await fixture();
        try {
            const m = f.create();
            f.check(m.id);
            const row = f.s.db.prepare('SELECT * FROM checks').get()!;
            const columns = Object.keys(row).filter(key => key !== 'sequence');
            const insert = f.s.db.prepare(`INSERT INTO checks(${columns.join(',')}) VALUES(${columns.map(() => '?').join(',')})`);
            const append = (started: number, outcome: string, duration: number, slow: number | null) => insert.run(...columns.map(key => {
                if (key === 'id') return randomUUID();
                if (key === 'queued_at' || key === 'started_at') return started;
                if (key === 'completed_at') return started + 10;
                if (key === 'outcome') return outcome;
                if (key === 'duration_ms') return duration;
                if (key === 'slow_success') return slow;
                if (key === 'http_status') return outcome === 'TIMEOUT' ? null : outcome === 'HTTP_ERROR' ? 500 : 200;
                return row[key]!;
            }));
            f.s.db.exec('BEGIN');
            for (let index = 0; index < 5000; index++) {
                const kind = index % 5;
                append(epoch + 3600000, kind === 2 ? 'HTTP_ERROR' : kind === 3 ? 'TIMEOUT' : 'SUCCESS', kind === 0 ? 10 : kind === 1 ? 30 : kind === 4 ? 50 : 100, kind === 0 ? 0 : kind === 1 ? 1 : null);
            }
            // These records have later allocation sequences but earlier starts.
            for (let index = 0; index < 17; index++) append(epoch + 1000, 'SUCCESS', 70, 0);
            f.s.db.exec('COMMIT');
            f.now = epoch + 7200000;
            const result = f.s.execute('metrics', { id: m.id, now: f.now, query: { from: new Date(epoch).toISOString(), to: new Date(f.now).toISOString(), bucket: '1h' } });
            expect(result).toMatchObject({ sampleCount: 5018, successfulCount: 3018, failedCount: 2000, degradedCount: 1000, unclassifiedDegradationCount: 1000, latency: { count: 3018, minMs: 1, maxMs: 70, p50Ms: 30, p95Ms: 50, p99Ms: 50 } });
            expect(result.latency.meanMs).toBeCloseTo(91191 / 3018, 10);
            expect(result.buckets.map(bucket => ({ count: bucket.count, success: bucket.success, failure: bucket.failure, mean: bucket.meanLatency }))).toEqual([
                { count: 18, success: 18, failure: 0, mean: 1191 / 18 },
                { count: 5000, success: 3000, failure: 2000, mean: 30 }
            ]);
        } finally {
            await f.close();
        }
    });
    it('bounds raw sample sorting and refuses oversized queries instead of silently truncating', async () => {
        const f = await fixture();
        try {
            const m = f.create();
            f.check(m.id);
            const row = f.s.db.prepare('SELECT * FROM checks').get()!;
            const columns = Object.keys(row).filter(k => k !== 'sequence'), sql = `INSERT INTO checks(${columns.join(',')}) VALUES(${columns.map(() => '?').join(',')})`, stmt = f.s.db.prepare(sql);
            f.s.db.exec('BEGIN');
            for (let i = 0; i < 100000; i++)
                stmt.run(...columns.map(k => k === 'id' ? randomUUID() : row[k]!));
            f.s.db.exec('COMMIT');
            expect(() => f.s.execute('metrics', {
                id: m.id, now: f.now, query: {}
            })).toThrow('QUERY_RANGE_TOO_LARGE');
            f.s.db.exec('DELETE FROM checks WHERE sequence=(SELECT max(sequence) FROM checks)');
            const maximum = f.s.execute('metrics', { id: m.id, now: f.now, query: {} });
            expect(maximum.sampleCount).toBe(100000);
            expect(maximum.successfulCount).toBe(100000);
            expect(maximum.latency.count).toBe(100000);
            expect(maximum.buckets.reduce((sum, bucket) => sum + bucket.count, 0)).toBe(100000);
        }
        finally {
            await f.close();
        }
    });
    it('retention is strictly bounded, protects unresolved incidents/anchors and preserves cutoff rows and unsettled work', async () => {
        const f = await fixture();
        try {
            const m = f.create({
                failureThreshold: 1
            });
            f.check(m.id, failure);
            const incident = f.s.db.prepare('SELECT * FROM incidents').get()!;
            const row = f.s.db.prepare('SELECT * FROM checks').get()!, columns = Object.keys(row).filter(k => k !== 'sequence');
            const stmt = f.s.db.prepare(`INSERT INTO checks(${columns.join(',')}) VALUES(${columns.map(() => '?').join(',')})`);
            f.s.db.exec('BEGIN');
            for (let i = 0; i < 1004; i++)
                stmt.run(...columns.map(k => k === 'id' ? randomUUID() : row[k]!));
            f.s.db.exec('COMMIT');
            const cutoff = f.now, oldNow = f.now;
            f.now += 31 * 86400000;
            f.s.db.prepare('UPDATE checks SET completed_at=? WHERE id=?').run(cutoff, row.id!);
            f.s.execute('manual', {
                id: m.id, now: f.now, limit: 100
            });
            const first = f.s.execute('retain', {
                now: f.now, checkDays: 30, incidentDays: 365
            });
            expect(first).toEqual({
                deleted: 1000, more: true
            });
            const second = f.s.execute('retain', {
                now: f.now, checkDays: 30, incidentDays: 365
            });
            expect(second.deleted).toBe(5);
            expect(f.s.db.prepare('SELECT count(*) AS n FROM checks').get()?.n).toBe(1);
            expect(f.s.db.prepare('SELECT status,opening_check_id FROM incidents').get()).toMatchObject({
                status: 'OPEN', opening_check_id: null
            });
            expect(f.s.db.prepare('SELECT count(*) AS n FROM state_transitions').get()?.n).toBe(1);
            expect(f.s.execute('incident', {
                id: String(incident.id), now: f.now
            }).durationMs).toBe(f.now - epoch);
            const r = f.s.execute('metrics', {
                id: m.id, now: f.now, query: {
                    from: new Date(oldNow - 10).toISOString(), to: new Date(f.now).toISOString(), bucket: '1d'
                }
            });
            expect(r.sampleWindowIncomplete).toBe(true);
            expect(r.sampledAvailabilityPercent).toBeNull();
            expect(f.s.db.prepare('PRAGMA foreign_key_check').all()).toEqual([]);
        }
        finally {
            await f.close();
        }
    });
    it('resolved incident retention removes anchors later while preserving the state predecessor and actual cutoff', async () => {
        const f = await fixture();
        try {
            const m = f.create({
                failureThreshold: 1, recoveryThreshold: 1
            });
            f.check(m.id, failure);
            f.check(m.id);
            const resolved = f.now;
            f.now = resolved + 30 * 86400000;
            f.s.execute('retain', {
                now: f.now, checkDays: 30, incidentDays: 30
            });
            expect(f.s.db.prepare('SELECT count(*) AS n FROM incidents').get()?.n).toBe(1);
            f.now++;
            f.s.execute('retain', {
                now: f.now, checkDays: 30, incidentDays: 30
            });
            expect(f.s.db.prepare('SELECT count(*) AS n FROM incidents').get()?.n).toBe(0);
            expect(f.s.db.prepare('SELECT count(*) AS n FROM state_transitions').get()?.n).toBe(1);
            const r = f.s.execute('metrics', {
                id: m.id, now: f.now + 1000, query: {
                    from: new Date(f.now).toISOString(), to: new Date(f.now + 1000).toISOString()
                }
            });
            expect(r.coverage.knownMs).toBe(1000);
            expect(r.observedDowntimeMs).toBe(0);
        }
        finally {
            await f.close();
        }
    });
    it('nearest-rank percentiles, finite zero cases, interval union and intersection use exact arithmetic', () => {
        expect(latency([])).toMatchObject({
            count: 0, meanMs: null, p50Ms: null, p95Ms: null, p99Ms: null
        });
        expect(latency([125])).toMatchObject({
            meanMs: 125, p50Ms: 125, p95Ms: 125, p99Ms: 125, p99Sufficient: false
        });
        expect(latency([10, 20, 30, 40, 50])).toMatchObject({
            meanMs: 30, p50Ms: 30, p95Ms: 50, p99Ms: 50
        });
        expect(latency(Array.from({
            length: 100
        }, (_, i) => i + 1))).toMatchObject({
            p50Ms: 50, p95Ms: 95, p99Ms: 99, p95Sufficient: true, p99Sufficient: true
        });
        expect(union([[10, 20], [0, 12], [18, 30], [5, 5]])).toEqual([[0, 30]]);
        expect(measure(intersect([[0, 30], [25, 40]], [[10, 20], [30, 50]]))).toBe(20);
    });
});
