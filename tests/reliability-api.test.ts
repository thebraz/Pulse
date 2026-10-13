import { describe, it, expect } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import { join } from 'node:path';
import { metricsSchema, incidentPageSchema, incidentDetailSchema, transitionPageSchema, summarySchema, engineSchema, type Observation } from '@pulse/contracts';
import { instance, target, monitorResponse, executionResponse, until, success, temp, dispose, deferred } from './helpers.js';
describe('Stage 2 actual listener, worker and target boundary', () => {
    it('real HTTP errors, timeout and connection reset confirm one outage; slow successful recovery resolves it as DEGRADED', async () => {
        let mode: 'http' | 'timeout' | 'reset' | 'slow' = 'http';
        const server = await target((req, res) => {
            if (mode === 'timeout')
                return;
            if (mode === 'reset') {
                req.socket.destroy();
                return;
            }
            if (mode === 'http') {
                res.statusCode = 500;
                res.end();
                return;
            }
            setTimeout(() => res.end(), 30);
        }), p = await instance({
            autoStart: false
        });
        try {
            const m = await monitorResponse(await p.request('/api/v1/monitors', 'POST', {
                name: 'Mixed real transport', url: server.url, timeoutMs: 1000, latencyThresholdMs: 10
            }));
            p.runtime.scheduler.start();
            await until(() => p.request(`/api/v1/monitors/${m.id}`).then(monitorResponse), m => m.lastObservedOutcome === 'HTTP_ERROR');
            const check = async () => { const e = await executionResponse(await p.request(`/api/v1/monitors/${m.id}/checks`, 'POST', {})); return until(() => p.request(`/api/v1/executions/${e.id}`).then(executionResponse), r => r.lifecycle === 'COMPLETED'); };
            mode = 'timeout';
            expect((await check()).outcome).toBe('TIMEOUT');
            expect(incidentPageSchema.parse(await (await p.request('/api/v1/incidents?status=OPEN')).json()).data).toHaveLength(0);
            mode = 'reset';
            expect((await check()).outcome).toBe('CONNECTION_ERROR');
            const opened = incidentPageSchema.parse(await (await p.request('/api/v1/incidents?status=OPEN')).json()).data;
            expect(opened).toHaveLength(1);
            expect(opened[0]!.failureCategory).toBe('CONNECTION_ERROR');
            mode = 'slow';
            expect((await check()).durationMs).toBeGreaterThanOrEqual(10);
            expect((await monitorResponse(await p.request(`/api/v1/monitors/${m.id}`))).status).toEqual({
                state: 'DOWN', reason: 'RECOVERING'
            });
            await check();
            expect((await monitorResponse(await p.request(`/api/v1/monitors/${m.id}`))).status).toEqual({
                state: 'DEGRADED', reason: 'SLOW'
            });
            const resolved = incidentPageSchema.parse(await (await p.request('/api/v1/incidents')).json()).data;
            expect(resolved).toHaveLength(1);
            expect(resolved[0]!.status).toBe('RESOLVED');
            const metrics = metricsSchema.parse((await (await p.request(`/api/v1/monitors/${m.id}/metrics`)).json() as {
                data: unknown;
            }).data);
            expect(metrics).toMatchObject({
                sampleCount: 5, successfulCount: 2, failedCount: 3, degradedCount: 2, sampledAvailabilityPercent: 40
            });
        }
        finally {
            await p.close();
            await server.close();
        }
    });
    it('persists the periodic heartbeat and automatically prunes expired observations without changing paused health', async () => {
        let now = Date.now();
        const p = await instance({
            rawClock: () => now, executor: async () => success, env: {
                PULSE_CHECK_RETENTION_DAYS: '1'
            }
        });
        const reader = new DatabaseSync(join(p.dir, 'pulse.sqlite'), {
            readOnly: true
        });
        try {
            const m = await monitorResponse(await p.request('/api/v1/monitors', 'POST', {
                name: 'Maintenance', url: 'https://example.com'
            }));
            await until(() => reader.prepare("SELECT count(*) AS n FROM checks WHERE lifecycle='COMPLETED'").get()?.n, n => Number(n) > 0);
            await until(() => p.runtime.scheduler.running, n => n === 0);
            await p.request(`/api/v1/monitors/${m.id}`, 'PATCH', {
                enabled: false
            }, {
                'if-match': '"1"'
            });
            const firstHeartbeat = Number(reader.prepare('SELECT last_heartbeat_at FROM service_runs WHERE stopped_at IS NULL').get()?.last_heartbeat_at);
            now = Date.now() + 2 * 86400000;
            await until(() => reader.prepare('SELECT count(*) AS n FROM checks').get()?.n, n => n === 0, 15000);
            expect(Number(reader.prepare('SELECT last_heartbeat_at FROM service_runs WHERE stopped_at IS NULL').get()?.last_heartbeat_at)).toBeGreaterThan(firstHeartbeat);
            expect((await monitorResponse(await p.request(`/api/v1/monitors/${m.id}`))).status).toEqual({
                state: 'UNKNOWN', reason: 'PAUSED'
            });
            const engine = engineSchema.parse((await (await p.request('/api/v1/engine')).json() as {
                data: unknown;
            }).data);
            expect(engine.retentionDeleted).toBeGreaterThanOrEqual(1);
            expect(engine.retentionBacklog).toBe(false);
        }
        finally {
            reader.close();
            await p.close();
        }
    });
    it('fails and recovers a real HTTP target; exposes persistent incidents, history, metrics and summaries', async () => {
        let status = 500, contacts = 0;
        const server = await target((_req, res) => { contacts++; res.statusCode = status; res.end(); }), p = await instance({
            autoStart: false
        });
        try {
            const m = await monitorResponse(await p.request('/api/v1/monitors', 'POST', {
                name: 'HTTP fixture', url: server.url
            }));
            p.runtime.scheduler.start();
            const check = async () => {
                const execution = await executionResponse(await p.request(`/api/v1/monitors/${m.id}/checks`, 'POST', {}));
                return until(() => p.request(`/api/v1/executions/${execution.id}`).then(executionResponse), e => e.lifecycle === 'COMPLETED');
            };
            await until(() => p.request(`/api/v1/monitors/${m.id}`).then(monitorResponse), m => m.lastObservedOutcome === 'HTTP_ERROR');
            expect((await monitorResponse(await p.request(`/api/v1/monitors/${m.id}`))).status.state).toBe('UNKNOWN');
            await check();
            await check();
            const open = incidentPageSchema.parse(await (await p.request('/api/v1/incidents?status=OPEN&limit=1')).json());
            expect(open.data).toHaveLength(1);
            expect(open.data[0]).toMatchObject({
                status: 'OPEN', failureCategory: 'HTTP_ERROR', ongoing: true
            });
            await check();
            expect(incidentPageSchema.parse(await (await p.request('/api/v1/incidents')).json()).data).toHaveLength(1);
            status = 200;
            await check();
            expect((await monitorResponse(await p.request(`/api/v1/monitors/${m.id}`))).status.state).toBe('DOWN');
            await check();
            const detail = incidentDetailSchema.parse((await (await p.request(`/api/v1/incidents/${open.data[0]!.id}`)).json() as {
                data: unknown;
            }).data);
            expect(detail).toMatchObject({
                status: 'RESOLVED', ongoing: false
            });
            expect(detail.transitions).toHaveLength(2);
            const metrics = metricsSchema.parse((await (await p.request(`/api/v1/monitors/${m.id}/metrics?window=24h`)).json() as {
                data: unknown;
            }).data);
            expect(metrics).toMatchObject({
                sampleCount: 6, successfulCount: 2, failedCount: 4, incidentCount: 1, includesManualChecks: true
            });
            expect(contacts).toBe(6);
            expect(summarySchema.parse((await (await p.request('/api/v1/monitors/summary')).json() as {
                data: unknown;
            }).data)).toMatchObject({
                total: 1, enabled: 1, up: 1, down: 0, activeIncidents: 0
            });
            expect(engineSchema.parse((await (await p.request('/api/v1/engine')).json() as {
                data: unknown;
            }).data)).toMatchObject({
                running: 0, queued: 0, checkConcurrency: 10, lastBackgroundFailure: null
            });
            const transitions = transitionPageSchema.parse(await (await p.request(`/api/v1/monitors/${m.id}/transitions?limit=1`)).json());
            expect(transitions.data).toHaveLength(1);
            expect(transitions.page.nextCursor).not.toBeNull();
            const next = transitionPageSchema.parse(await (await p.request(`/api/v1/monitors/${m.id}/transitions?limit=1&cursor=${transitions.page.nextCursor}`)).json());
            expect(next.data[0]!.id).not.toBe(transitions.data[0]!.id);
            expect((await p.request('/api/v1/dashboard')).status).toBe(200);
        }
        finally {
            await p.close();
            await server.close();
        }
    });
    it('validates all new query bounds, UUIDs, sorts, filters and cursor contexts', async () => {
        const p = await instance({
            autoStart: false
        });
        try {
            const m = await monitorResponse(await p.request('/api/v1/monitors', 'POST', {
                name: 'Validation', url: 'https://example.com'
            }));
            for (const suffix of ['?limit=0', '?limit=101', '?status=bad', '?sort=bad', '?monitorId=bad', '?cursor=%%%', '?unknown=1'])
                expect((await p.request('/api/v1/incidents' + suffix)).status).toBe(400);
            for (const suffix of ['?window=1d', '?bucket=2m', '?window=24h&from=2026-01-01T00:00:00.000Z', '?unknown=1'])
                expect((await p.request(`/api/v1/monitors/${m.id}/metrics` + suffix)).status).toBe(400);
            expect((await p.request(`/api/v1/monitors/${m.id}/metrics?window=30d&bucket=1m`)).status).toBe(422);
            expect((await p.request('/api/v1/incidents/not-uuid')).status).toBe(400);
            expect((await p.request('/api/v1/engine?unknown=1')).status).toBe(400);
            expect((await p.request('/api/v1/monitors/summary?limit=10')).status).toBe(400);
        }
        finally {
            await p.close();
        }
    });
    it('simultaneous failures respect pool bounds and graceful shutdown cancels all loaded work without false recovery', async () => {
        const started = deferred<void>(), gates = new Map<string, (o: Observation | null) => void>();
        let active = 0, peak = 0;
        const p = await instance({
            autoStart: false, env: {
                PULSE_CHECK_CONCURRENCY: '2'
            }, executor: (m, signal) => new Promise(resolve => {
                active++;
                peak = Math.max(peak, active);
                const finish = (o: Observation | null) => {
                    if (!gates.delete(m.name))
                        return;
                    active--;
                    resolve(o);
                };
                gates.set(m.name, finish);
                signal.addEventListener('abort', () => finish(null), {
                    once: true
                });
                if (gates.size === 2)
                    started.resolve();
            })
        });
        try {
            const monitors = [];
            for (let i = 0; i < 8; i++)
                monitors.push(await monitorResponse(await p.request('/api/v1/monitors', 'POST', {
                    name: String(i), url: 'https://example.com', failureThreshold: 1
                })));
            p.runtime.scheduler.start();
            await started.promise;
            expect(peak).toBe(2);
            const running = await executionResponse(await p.request(`/api/v1/monitors/${monitors[0]!.id}/checks`, 'POST', {}));
            const same = await executionResponse(await p.request(`/api/v1/monitors/${monitors[0]!.id}/checks`, 'POST', {}));
            expect(same.id).toBe(running.id);
            for (const finish of [...gates.values()])
                finish({
                    ...success, outcome: 'CONNECTION_ERROR', httpStatus: null, errorCode: 'CONNECTION_FAILED'
                });
            await until(() => p.runtime.db.call('incidents', {
                now: p.runtime.clock.now(), query: {
                    status: 'OPEN'
                }
            }), r => r.data.length === 2);
            await until(() => gates.size, n => n === 2);
            expect(peak).toBe(2);
            const begin = performance.now();
            await p.runtime.close();
            expect(performance.now() - begin).toBeLessThan(15000);
            expect(active).toBe(0);
            const db = new DatabaseSync(join(p.dir, 'pulse.sqlite'), {
                readOnly: true
            });
            try {
                expect(db.prepare("SELECT count(*) AS n FROM checks WHERE lifecycle IN('QUEUED','RUNNING')").get()?.n).toBe(0);
                expect(db.prepare("SELECT count(*) AS n FROM incidents WHERE status='OPEN'").get()?.n).toBe(2);
                expect(db.prepare("SELECT count(*) AS n FROM checks WHERE lifecycle='CANCELLED'").get()?.n).toBe(2);
            }
            finally {
                db.close();
            }
        }
        finally {
            await p.close();
        }
    });
    it('SQLite write failure stops dispatch/readiness and restart recovers the unfinished execution without an incident', async () => {
        const dir = await temp(), gate = deferred<Observation | null>();
        let contacts = 0;
        const p = await instance({
            dir, autoStart: false, executor: async () => { contacts++; return gate.promise; }
        });
        let closed = false;
        try {
            const m = await monitorResponse(await p.request('/api/v1/monitors', 'POST', {
                name: 'Fault', url: 'https://example.com', failureThreshold: 1
            }));
            const external = new DatabaseSync(join(dir, 'pulse.sqlite'));
            external.exec("CREATE TRIGGER inject BEFORE UPDATE ON checks BEGIN SELECT RAISE(ABORT,'FAKE_SECRET_CANARY'); END");
            p.runtime.scheduler.start();
            await until(() => contacts, n => n === 1);
            gate.resolve({
                ...success, outcome: 'TIMEOUT', httpStatus: null, errorCode: 'REQUEST_TIMEOUT'
            });
            await until(() => p.runtime.db.fault, Boolean);
            const ready = await p.request('/health/ready');
            expect(ready.status).toBe(503);
            expect(await ready.text()).not.toContain('CANARY');
            expect((await p.request(`/api/v1/monitors/${m.id}/checks`, 'POST', {})).status).toBe(503);
            expect(contacts).toBe(1);
            external.exec('DROP TRIGGER inject');
            external.close();
            await expect(p.runtime.close()).rejects.toThrow();
            closed = true;
            const restarted = await instance({
                dir, autoStart: false
            });
            try {
                expect((await monitorResponse(await restarted.request(`/api/v1/monitors/${m.id}`))).status.state).toBe('UNKNOWN');
                expect(incidentPageSchema.parse(await (await restarted.request('/api/v1/incidents')).json()).data).toEqual([]);
                const db = new DatabaseSync(join(dir, 'pulse.sqlite'), {
                    readOnly: true
                });
                expect(db.prepare('SELECT lifecycle,outcome FROM checks').get()).toMatchObject({
                    lifecycle: 'ABANDONED', outcome: null
                });
                db.close();
            }
            finally {
                await restarted.close();
            }
        }
        finally {
            if (!closed)
                await p.runtime.close().catch(() => { });
            await dispose(dir);
        }
    });
    it('real competing SQLite writer times out once, faults readiness, and retains data for controlled restart', async () => {
        const dir = await temp(), p = await instance({
            dir, autoStart: false
        });
        let closed = false;
        const external = new DatabaseSync(join(dir, 'pulse.sqlite'));
        try {
            const m = await monitorResponse(await p.request('/api/v1/monitors', 'POST', {
                name: 'Contention', url: 'https://example.com'
            }));
            external.exec('BEGIN IMMEDIATE');
            const begin = performance.now();
            expect((await p.request(`/api/v1/monitors/${m.id}`, 'PATCH', {
                name: 'Uncommitted'
            }, {
                'if-match': '"1"'
            })).status).toBe(503);
            const elapsed = performance.now() - begin;
            expect(elapsed).toBeGreaterThanOrEqual(4500);
            expect(elapsed).toBeLessThan(9000);
            expect((await p.request('/health/ready')).status).toBe(503);
            external.exec('ROLLBACK');
            external.close();
            await expect(p.runtime.close()).rejects.toThrow();
            closed = true;
            const restarted = await instance({
                dir, autoStart: false
            });
            try {
                expect((await monitorResponse(await restarted.request(`/api/v1/monitors/${m.id}`))).name).toBe('Contention');
            }
            finally {
                await restarted.close();
            }
        }
        finally {
            if (external.isOpen)
                external.close();
            if (!closed)
                await p.runtime.close().catch(() => { });
            await dispose(dir);
        }
    });
});
