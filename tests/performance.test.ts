import { it, expect } from 'vitest';
import { randomUUID } from 'node:crypto';
import { cpus, totalmem, release, platform, arch } from 'node:os';
import { join } from 'node:path';
import { writeFile, mkdir } from 'node:fs/promises';
import { performance, monitorEventLoopDelay } from 'node:perf_hooks';
import { DatabaseSync } from 'node:sqlite';
import { Store } from '../apps/server/src/persistence/store.js';
import { Database } from '../apps/server/src/persistence/database.js';
import { Scheduler } from '../apps/server/src/scheduler/scheduler.js';
import { LogicalClock } from '../apps/server/src/scheduler/clock.js';
import { latency } from '../apps/server/src/domain/metrics.js';
import { input, temp, dispose, success, until } from './helpers.js';
import type { Observation } from '@pulse/contracts';
it('10,000 monitor definitions: indexed selection, bounded pipeline, measured memory and synthetic throughput', async () => {
    const dir = await temp(), path = join(dir, 'pulse.sqlite'), store = new Store(path), now = Date.now(), rssBefore = process.memoryUsage().rss;
    let db: Database | undefined, scheduler: Scheduler | undefined, reader: DatabaseSync | undefined;
    const startedAt = new Date().toISOString(), loop = monitorEventLoopDelay({
        resolution: 10
    });
    loop.enable();
    try {
        store.execute('initialize', {
            now, runId: randomUUID(), fingerprint: 'a'.repeat(64)
        });
        const base = store.execute('create', {
            now, input: input()
        });
        const insert = store.db.prepare('INSERT INTO monitors SELECT ?,?,url,method,expected_status_codes_json,interval_ms,timeout_ms,follow_redirects,enabled,failure_threshold,recovery_threshold,latency_threshold_ms,degradation_threshold,revision,execution_epoch,created_at,updated_at,next_due_at FROM monitors WHERE id=?');
        const status = store.db.prepare("INSERT INTO monitor_status(monitor_id,state,reason,state_changed_at) VALUES(?,'UNKNOWN','INITIAL',?)");
        const activity = store.db.prepare('INSERT INTO monitor_activity_windows(id,monitor_id,enabled_at) VALUES(?,?,?)');
        const seedStart = performance.now();
        store.db.exec('BEGIN');
        for (let i = 1; i < 10000; i++) {
            const id = randomUUID();
            insert.run(id, String(i), base.id);
            status.run(id, now);
            activity.run(randomUUID(), id, now);
        }
        store.db.exec('COMMIT');
        const seedMs = performance.now() - seedStart, rssAfterSeed = process.memoryUsage().rss;
        expect(() => store.execute('create', {
            now, input: input()
        })).toThrow('MONITOR_LIMIT_REACHED');
        const dueSql = "SELECT id FROM monitors WHERE enabled=1 AND next_due_at<=? AND NOT EXISTS(SELECT 1 FROM checks WHERE monitor_id=monitors.id AND lifecycle IN('QUEUED','RUNNING')) ORDER BY next_due_at,id LIMIT 1";
        const plan = store.db.prepare('EXPLAIN QUERY PLAN ' + dueSql).all(now), selection = store.db.prepare(dueSql), samples: number[] = [];
        expect(JSON.stringify(plan)).toContain('monitors_due');
        expect(JSON.stringify(plan)).toContain('checks_one_unsettled');
        for (let i = 0; i < 20; i++)
            selection.get(now); // explicit warm-up
        for (let i = 0; i < 1000; i++) {
            const start = performance.now();
            selection.get(now);
            samples.push(performance.now() - start);
        }
        const expected = store.db.prepare('SELECT name FROM monitors ORDER BY next_due_at,id LIMIT 500').all().map(r => String(r.name));
        store.execute('close', {});
        db = new Database(dir);
        await db.ready;
        const recoveryStart = performance.now(), initialized = await db.call('initialize', {
            now, runId: randomUUID(), fingerprint: 'a'.repeat(64)
        }), recoveryMs = performance.now() - recoveryStart;
        const gates = new Map<string, (o: Observation | null) => void>(), seen: string[] = [];
        let active = 0, peak = 0, maxDbQueue = 0;
        scheduler = new Scheduler(db, (m, signal) => new Promise(resolve => {
            expect(gates.has(m.name)).toBe(false);
            seen.push(m.name);
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
            if (signal.aborted)
                finish(null);
        }), new LogicalClock(initialized.seed), 10, 100);
        reader = new DatabaseSync(path, {
            readOnly: true
        });
        const completed = reader.prepare("SELECT count(*) AS n FROM checks WHERE lifecycle='COMPLETED'");
        const measureStart = performance.now();
        scheduler.start();
        for (let wave = 0; wave < 50; wave++) {
            await until(() => gates.size, n => n === 10);
            maxDbQueue = Math.max(maxDbQueue, db.queueLength);
            for (const finish of [...gates.values()])
                finish(success);
        }
        await until(() => Number(completed.get()?.n), n => n >= 500);
        const processingMs = performance.now() - measureStart;
        await scheduler.stop();
        const rssAfterProcessing = process.memoryUsage().rss, count = Number(completed.get()?.n);
        expect(count).toBe(500);
        expect(peak).toBe(10);
        expect(seen.slice(0, 500)).toEqual(expected);
        expect(active).toBe(0);
        expect(Number(reader.prepare("SELECT count(*) AS n FROM checks WHERE lifecycle IN('QUEUED','RUNNING')").get()?.n)).toBe(0);
        expect(reader.prepare('PRAGMA integrity_check').get()?.integrity_check).toBe('ok');
        const report = {
            startedAt, completedAt: new Date().toISOString(), conditions: {
                os: platform(), release: release(), arch: arch(), node: process.version, sqlite: initialized.sqliteVersion,
                cpu: cpus()[0]?.model, logicalCpus: cpus().length, totalMemoryBytes: totalmem(), definitions: 10000, concurrency: 10, intervalMs: 15000, timeoutMs: 1000,
                selectionWarmup: 20, selectionSamples: 1000, pipelineWarmup: 0, completedChecks: count, realInternetRequests: 0, executor: 'Explicit promise gates; successful synthetic observations; real SQLite worker/WAL/FULL commits.',
                hostLoad: 'Shared workstation; competing load not controlled.', limits: 'Short Vitest process including test harness and worker. Bulk-seeded definitions, small check history, no real HTTP cost, no sustained soak, no production capacity guarantee.'
            },
            seedMs, recoveryMs, dueSelectionMs: latency(samples), dueQueryPlan: plan, processingMs, completedPerSecond: count * 1000 / processingMs, peakConcurrency: peak, maxObservedDatabaseQueue: maxDbQueue,
            rssBytes: {
                beforeSeed: rssBefore, afterSeed: rssAfterSeed, afterProcessing: rssAfterProcessing
            }, eventLoopDelayMs: {
                p95: loop.percentile(95) / 1e6, p99: loop.percentile(99) / 1e6
            }, result: 'PASS'
        };
        await mkdir('docs/evidence', {
            recursive: true
        });
        await writeFile(`docs/evidence/${process.env.TEST_EVIDENCE_PREFIX ?? 'stage-3'}-benchmark.json`, JSON.stringify(report, null, 2) + '\n');
    }
    finally {
        loop.disable();
        reader?.close();
        if (scheduler)
            await scheduler.stop().catch(() => { });
        if (db)
            await db.close();
        else if (store.db.isOpen)
            store.execute('close', {});
        await dispose(dir);
    }
}, 120000);
