import { describe, expect, it } from 'vitest';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fork } from 'node:child_process';
import { once } from 'node:events';
import { pathToFileURL } from 'node:url';
import { randomUUID } from 'node:crypto';
import { LogicalClock } from '../apps/server/src/scheduler/clock.js';
import { temp, dispose, freePort, until, target, instance } from './helpers.js';
// @ts-expect-error The executable benchmark helpers intentionally use native ESM JavaScript.
import { reference, diagnosticProfile, classifyRun, fixtureCloneTarget, memoryTrend, percentiles, startupBudgetMs, startupWithinBudget, operationEvidence, rebaseReferenceHistory, referenceHistorySnapshot } from '../scripts/performance-helpers.mjs';
import { fixture } from './reliability-helpers.js';
describe('release performance evidence safety', () => {
    it('applies the approved sixty-second startup limit to every measured start', () => {
        expect(startupBudgetMs).toBe(60000);
        expect(startupWithinBudget([21154.6614, 60000])).toBe(true);
        expect(startupWithinBudget([21154.6614, 75300.2364])).toBe(false);
        expect(startupWithinBudget([60000.001])).toBe(false);
        for (const trials of [[], [0], [-1], [NaN], [Infinity], [undefined]])
            expect(startupWithinBudget(trials)).toBe(false);
    });
    it('never certifies missing observations, incomplete runs or failed startup', () => {
        expect(percentiles([])).toMatchObject({ count: 0, p95: null, p99: null });
        expect(classifyRun({ startup: false, api: true }, true, true)).toBe('FAIL');
        expect(classifyRun({ startup: true }, false, true)).toBe('NOT VERIFIED');
        expect(classifyRun({ startup: true }, true, false)).toBe('NOT VERIFIED');
        expect(classifyRun({ startup: true }, true, true)).toBe('PASS');
    });
    it('observes repeated scheduling in diagnostics while preserving the full mandatory reference profile', () => {
        expect(reference).toMatchObject({ warmupMs: 300000, measurementMs: 1800000, soakMs: 7200000, overloadMs: 600000, apiSamples: 1000 });
        expect(diagnosticProfile).toEqual({ warmupMs: 60000, measurementMs: 180000, soakMs: 210000, overloadMs: 90000, apiSamples: 100 });
        expect(diagnosticProfile.measurementMs).toBeGreaterThan(60000);
        expect(diagnosticProfile.apiSamples * 60000 / diagnosticProfile.measurementMs).toBeLessThan(60);
        expect(diagnosticProfile.apiSamples / (diagnosticProfile.measurementMs / 4)).toBe(reference.apiSamples / (reference.measurementMs / 4));
        expect(classifyRun({ startup: true }, false, true)).toBe('NOT VERIFIED');
    });
    it('permits only a new benchmark clone beneath the temporary root', () => {
        const source = join(tmpdir(), 'preserve-original', 'pulse.sqlite');
        expect(fixtureCloneTarget(source, join(tmpdir(), 'pulse-reference-fixture'), tmpdir())).toBe(join(tmpdir(), 'pulse-reference-fixture', 'pulse.sqlite'));
        expect(() => fixtureCloneTarget(source, join(tmpdir(), 'preserve-original'), tmpdir())).toThrow('UNSAFE_BENCHMARK_CLONE');
        expect(() => fixtureCloneTarget(source, join(tmpdir(), 'nested', 'pulse-reference-fixture'), tmpdir())).toThrow('UNSAFE_BENCHMARK_CLONE');
        expect(() => fixtureCloneTarget(join(tmpdir(), 'pulse-reference-fixture', 'pulse.sqlite'), join(tmpdir(), 'pulse-reference-fixture'), tmpdir())).toThrow('UNSAFE_BENCHMARK_CLONE');
    });
    it('reports a persistent memory increase instead of declaring a bounded peak sufficient', () => {
        const increasing = Array.from({ length: 16 }, (_, i) => ({ elapsedMs: i * 1000, rss: 10000000 + i * 100000 }));
        expect(memoryTrend(increasing).result).toBe('FAIL');
        expect(memoryTrend(increasing.map(s => ({ ...s, rss: 10000000 }))).result).toBe('PASS');
        expect(memoryTrend(increasing.slice(0, 2)).result).toBe('NOT TESTED');
    });
    it('preserves delayed worker operations and selects exact completion boundaries', () => {
        const samples = [
            { phase: 'reference-measurement', operationSamples: [{ operation: 'metrics', completedAt: 99, ms: 12 }, { operation: 'metrics', completedAt: 100, ms: 14 }], transactionSamples: [{ completedAt: 99, ms: 3 }] },
            { phase: 'soak', operationSamples: [{ operation: 'metrics', completedAt: 199, ms: 18 }, { operation: 'metrics', completedAt: 200, ms: 20 }, { operation: 'history', completedAt: 150, ms: 4 }], transactionSamples: [{ completedAt: 100, ms: 5 }, { completedAt: 199, ms: 7 }, { completedAt: 200, ms: 9 }] }
        ];
        expect(operationEvidence(samples, 100, 200)).toEqual({ operations: { metrics: { count: 2, totalMs: 32, maxMs: 18 }, history: { count: 1, totalMs: 4, maxMs: 4 } }, transactions: { count: 2, p50: 5, p95: 7, p99: 7, max: 7 } });
    });
    it('rebases a reused fixture without changing observations, links or interval arithmetic', async () => {
        const f = await fixture();
        try {
            const monitor = f.create(); f.check(monitor.id); const before = f.s.db.prepare('SELECT * FROM checks').get()!;
            const metrics = () => f.s.execute('metrics', { id: monitor.id, now: f.now, query: { window: '30d' } });
            const original = metrics(), delta = 20 * 3600000, anchor = f.now + delta;
            const translation = rebaseReferenceHistory(f.s.db, anchor);
            expect(translation.shiftMs).toBe(delta);
            f.now += delta;
            const after = f.s.db.prepare('SELECT * FROM checks').get()!;
            expect(after).toEqual({ ...before, queued_at: Number(before.queued_at) + delta, scheduled_at: before.scheduled_at === null ? null : Number(before.scheduled_at) + delta, started_at: Number(before.started_at) + delta, completed_at: Number(before.completed_at) + delta });
            const rebased = metrics();
            for (const key of ['sampleCount', 'successfulCount', 'failedCount', 'latency', 'sampledAvailabilityPercent', 'observedDowntimeMs', 'coverage'] as const)
                if (key !== 'coverage') expect(rebased[key]).toEqual(original[key]);
            expect(rebased.coverage).toEqual({ ...original.coverage, retainedFrom: new Date(Date.parse(original.coverage.retainedFrom!) + delta).toISOString() });
            expect(referenceHistorySnapshot(f.s.db, [monitor.id], f.now)).toMatchObject({ retainedRows: 1, countedRowsIn30d: 1, monitors: [{ monitorId: monitor.id, countedRows: 1, earliestStartedAt: Number(after.started_at), latestStartedAt: Number(after.started_at) }] });
            expect(f.s.db.prepare('PRAGMA quick_check').get()).toEqual({ quick_check: 'ok' });
            expect(f.s.db.prepare('PRAGMA foreign_key_check').all()).toEqual([]);
        } finally { await f.close(); }
    });
    it('excludes post-history rehearsal clocks without removing historical empty runs or freezing automatic dispatch', async () => {
        const f = await fixture();
        let endpoint: Awaited<ReturnType<typeof target>> | undefined, live: Awaited<ReturnType<typeof instance>> | undefined;
        try {
            endpoint = await target();
            const monitor = f.create({ url: endpoint.url }); f.check(monitor.id);
            const latest = f.now, historicalId = randomUUID(), rehearsalId = randomUUID();
            const insert = f.s.db.prepare("INSERT INTO service_runs(id,started_at,ready_at,last_heartbeat_at,stopped_at,stop_reason,config_fingerprint) VALUES(?,?,?,?,?,'CLEAN',?)");
            insert.run(historicalId, latest - 8, latest - 7, latest - 6, latest - 6, 'a'.repeat(64));
            insert.run(rehearsalId, latest + 5 * 3600000, latest + 5 * 3600000, latest + 5 * 3600000 + 100, latest + 5 * 3600000 + 100, 'a'.repeat(64));
            const anchor = Date.now() - 1000;
            expect(rebaseReferenceHistory(f.s.db, anchor)).toMatchObject({ excludedPostHistoryServiceRuns: 1, latestCompletedAt: anchor });
            expect(f.s.db.prepare('SELECT id FROM service_runs WHERE id=?').get(rehearsalId)).toBeUndefined();
            expect(f.s.db.prepare('SELECT started_at,stopped_at FROM service_runs WHERE id=?').get(historicalId)).toEqual({ started_at: anchor - 8, stopped_at: anchor - 6 });
            f.now = anchor;
            const initialized = f.s.execute('initialize', { now: anchor, runId: randomUUID(), fingerprint: 'a'.repeat(64) });
            expect(initialized.seed).toBe(anchor);
            const clock = new LogicalClock(initialized.seed, () => anchor + 1);
            expect(clock.now()).toBe(anchor + 1);
            const due = f.create({ url: endpoint.url });
            expect(f.s.execute('dispatch', { now: clock.now(), preferManual: false })).toMatchObject({ check: { monitorId: due.id, trigger: 'automatic', startedAt: new Date(anchor + 1).toISOString() } });
            expect(f.s.db.prepare('PRAGMA foreign_key_check').all()).toEqual([]);
            f.s.execute('close', {});
            live = await instance({ dir: f.dir });
            const runtime = live.runtime;
            expect(runtime.clock.now()).toBeLessThanOrEqual(Date.now());
            const observed = await until(() => runtime.db.call('history', { id: due.id, now: runtime.clock.now(), query: {} }), result => result.data.some(check => check.trigger === 'automatic' && check.lifecycle === 'COMPLETED' && check.outcome === 'SUCCESS'));
            const automatic = observed.data.find(check => check.trigger === 'automatic' && check.lifecycle === 'COMPLETED' && check.outcome === 'SUCCESS')!;
            expect(Date.parse(automatic.startedAt!)).toBeGreaterThanOrEqual(anchor);
            expect(Date.parse(automatic.startedAt!)).toBeLessThanOrEqual(Date.now());
        } finally { await live?.close(); await endpoint?.close(); if (f.s.db.isOpen) await f.close(); else await dispose(f.dir); }
    });
    it('rejects unexplained future recovery metadata and rolls back the complete fixture translation', async () => {
        const f = await fixture();
        try {
            const monitor = f.create(); f.check(monitor.id);
            const before = f.s.db.prepare('SELECT * FROM checks').get();
            const future = f.now + 5 * 3600000;
            f.s.db.prepare('UPDATE reliability_meta SET coverage_from=?').run(future);
            expect(() => rebaseReferenceHistory(f.s.db, f.now + 20 * 3600000)).toThrow('REFERENCE_FIXTURE_HAS_POST_HISTORY_CLOCKS');
            expect(f.s.db.prepare('SELECT * FROM checks').get()).toEqual(before);
            expect(f.s.db.prepare('SELECT coverage_from FROM reliability_meta').get()).toEqual({ coverage_from: future });
        } finally { await f.close(); }
    });
    it('keeps the main-process measurement phase when delayed worker telemetry arrives', async () => {
        const dir = await temp(), port = await freePort(), env = { ...process.env };
        for (const key of Object.keys(env)) if (key.startsWith('PULSE_') || key === 'NODE_OPTIONS') delete env[key];
        Object.assign(env, { PULSE_DATA_DIR: dir, PULSE_PORT: String(port), PULSE_PUBLIC_ORIGIN: `http://127.0.0.1:${port}` });
        const child = fork(join(process.cwd(), 'scripts/performance-server.mjs'), { execArgv: [], env, stdio: ['ignore', 'pipe', 'pipe', 'ipc'] });
        const exited = once(child, 'exit');
        child.stdout?.resume(); child.stderr?.resume();
        let ready = false, latest: { phase?: string; rss?: number } | undefined;
        child.on('message', (value: { type?: string; phase?: string; rss?: number }) => { if (value.type === 'ready') ready = true; if (value.type === 'sample') latest = value; });
        try {
            await until(() => ready, Boolean);
            child.send({ type: 'phase', phase: 'reference-measurement' });
            await until(() => latest, value => value?.phase === 'reference-measurement');
            latest = undefined;
            child.send({ type: 'probe-fixture', sample: { phase: 'stale-worker-phase', transactionSamples: [], operationSamples: [], manualQueued: 0 } });
            const next = await until(() => latest, Boolean);
            expect(next?.phase).toBe('reference-measurement');
            expect(next?.rss).toBeGreaterThan(0);
            child.send('shutdown');
            expect((await exited)[0]).toBe(0);
        } finally {
            if (child.exitCode === null && child.signalCode === null) { child.kill(); await exited; }
            await dispose(dir);
        }
    });
    it('retains a real SQLite operation when the measurement phase changes before telemetry flushes', async () => {
        const dir = await temp(), port = await freePort(), env = { ...process.env }, origin = `http://127.0.0.1:${port}`;
        for (const key of Object.keys(env)) if (key.startsWith('PULSE_') || key === 'NODE_OPTIONS') delete env[key];
        Object.assign(env, { PULSE_DATA_DIR: dir, PULSE_PORT: String(port), PULSE_PUBLIC_ORIGIN: origin });
        const child = fork(join(process.cwd(), 'scripts/performance-server.mjs'), { execArgv: ['--import', pathToFileURL(join(process.cwd(), 'scripts/performance-probe.mjs')).href], env, stdio: ['ignore', 'pipe', 'pipe', 'ipc'] });
        const exited = once(child, 'exit');
        child.stdout?.resume(); child.stderr?.resume();
        let ready = false, telemetry: { observedAt: number; operationSamples?: { operation: string; completedAt: number; ms: number }[] } | undefined;
        child.on('message', (value: { type?: string; observedAt?: number; operationSamples?: { operation: string; completedAt: number; ms: number }[] }) => {
            if (value.type === 'ready') ready = true;
            if (value.type === 'sample' && typeof value.observedAt === 'number') telemetry = { observedAt: value.observedAt, operationSamples: value.operationSamples ?? [] };
        });
        try {
            await until(() => ready, Boolean);
            const baseline = await until(() => telemetry, Boolean);
            telemetry = undefined;
            const from = Date.now(), response = await fetch(origin + '/api/v1/dashboard', { signal: AbortSignal.timeout(5000) });
            expect(response.status).toBe(200); await response.arrayBuffer();
            child.send({ type: 'phase', phase: 'soak' });
            const next = await until(() => telemetry, value => !!value && value.observedAt > baseline!.observedAt);
            expect(next?.operationSamples?.filter(operation => operation.operation === 'dashboard' && operation.completedAt >= from)).toHaveLength(1);
            child.send('shutdown'); expect((await exited)[0]).toBe(0);
        } finally {
            if (child.exitCode === null && child.signalCode === null) { child.kill(); await exited; }
            await dispose(dir);
        }
    });
});
