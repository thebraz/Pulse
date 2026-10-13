import { it, expect } from 'vitest';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { loadConfig } from '../apps/server/src/config/config.js';
import { Store } from '../apps/server/src/persistence/store.js';
import { migration1, migration2, migration3, migration4 } from '../apps/server/src/persistence/migration.js';
import { applyChecksMigration } from '../apps/server/src/persistence/checks-migration.js';
import { temp, dispose, input } from './helpers.js';

it.each(['CHECK', 'FOREIGN KEY'])('startup still rejects persisted %s violations after read tuning', async kind => {
    const dir = await temp(), path = join(dir, 'pulse.sqlite'), store = new Store(path);
    try {
        store.execute('initialize', { now: 1000, runId: randomUUID(), fingerprint: 'a'.repeat(64) });
        const m = store.execute('create', { now: 1000, input: input() });
        if (kind === 'CHECK') store.db.exec('PRAGMA ignore_check_constraints=ON; UPDATE monitors SET failure_threshold=0');
        else { store.db.exec('PRAGMA foreign_keys=OFF'); store.db.prepare('UPDATE monitor_status SET monitor_id=? WHERE monitor_id=?').run(randomUUID(), m.id); }
        store.execute('close', {});
        expect(() => new Store(path)).toThrow('DATABASE_UNAVAILABLE');
        const db = new DatabaseSync(path, { readOnly: true });
        expect(db.prepare('SELECT count(*) AS n FROM monitors').get()?.n).toBe(1);
        db.close();
    } finally { await dispose(dir); }
});

it('recovery preserves the largest nullable history clock through indexed probes', async () => {
    const dir = await temp(), path = join(dir, 'pulse.sqlite'), store = new Store(path);
    try {
        store.execute('initialize', { now: 1000, runId: randomUUID(), fingerprint: 'a'.repeat(64) });
        const m = store.execute('create', { now: 1000, input: input() });
        const c = store.execute('manual', { now: 2000000, id: m.id, limit: 10 });
        store.execute('dispatch', { now: 3000000, preferManual: true });
        store.execute('close', {});
        const reopened = new Store(path);
        expect(reopened.execute('initialize', { now: 1000, runId: randomUUID(), fingerprint: 'a'.repeat(64) }).seed).toBe(3000000);
        expect(reopened.db.prepare('SELECT lifecycle,completed_at FROM checks WHERE id=?').get(c.id)).toMatchObject({ lifecycle: 'ABANDONED', completed_at: 3000000 });
        reopened.execute('close', {});
    } finally { await dispose(dir); }
});

it.each(['QUEUED', 'RUNNING', 'COMPLETED', 'CANCELLED', 'ABANDONED'] as const)('indexed recovery retains the maximum %s clock', async lifecycle => {
    const dir = await temp(), path = join(dir, 'pulse.sqlite'), store = new Store(path);
    try {
        const runId = randomUUID();
        store.execute('initialize', { now: 1000, runId, fingerprint: 'a'.repeat(64) });
        const m = store.execute('create', { now: 1000, input: input() });
        const terminal = !['QUEUED', 'RUNNING'].includes(lifecycle);
        store.db.prepare('INSERT INTO checks(id,monitor_id,service_run_id,monitor_revision,execution_epoch,trigger,lifecycle,queued_at,started_at,completed_at,outcome,duration_ms,terminal_order) VALUES(?,?,?,1,1,\'manual\',?,?,?,?,?,?,?)').run(
            randomUUID(), m.id, runId, lifecycle, 2000000, lifecycle === 'QUEUED' ? null : 3000000,
            terminal ? 4000000 : null, lifecycle === 'COMPLETED' ? 'SUCCESS' : null, lifecycle === 'COMPLETED' ? 1000000 : null, terminal ? 1 : null
        );
        for (const sql of [
            "SELECT max(completed_at) AS t FROM checks WHERE lifecycle IN('COMPLETED','CANCELLED','ABANDONED')",
            "SELECT max(queued_at) AS t FROM checks WHERE lifecycle='QUEUED'",
            'SELECT max((SELECT max(started_at) FROM checks WHERE monitor_id=monitors.id)) AS t FROM monitors'
        ]) {
            const plan = store.db.prepare('EXPLAIN QUERY PLAN ' + sql).all().map(row => String(row.detail)).join('\n');
            expect(plan).not.toMatch(/SCAN checks(?:\s|$)/);
            expect(plan).toContain('INDEX checks_');
        }
        store.execute('close', {});
        const reopened = new Store(path);
        expect(reopened.execute('initialize', { now: 1000, runId: randomUUID(), fingerprint: 'a'.repeat(64) }).seed).toBe(terminal ? 4000000 : lifecycle === 'QUEUED' ? 2000000 : 3000000);
        reopened.execute('close', {});
    } finally { await dispose(dir); }
});

it('default data storage is stable across working directories and explicit legacy paths remain supported', async () => {
    expect((await loadConfig({}, '/first')).dataDir).toBe(join(homedir(), '.pulse'));
    expect((await loadConfig({}, '/second')).dataDir).toBe(join(homedir(), '.pulse'));
    const dir = await temp();
    try { expect((await loadConfig({ PULSE_DATA_DIR: './data' }, dir)).dataDir).toBe(join(dir, 'data')); }
    finally { await dispose(dir); }
});

it('overview latest latency uses the latest completed sequence, ignoring newer unsettled and cancelled checks', async () => {
    const dir = await temp(), store = new Store(join(dir, 'pulse.sqlite'));
    try {
        const runId = randomUUID();
        store.execute('initialize', { now: 1000, runId, fingerprint: 'a'.repeat(64) });
        const m = store.execute('create', { now: 1000, input: input() });
        const empty = store.execute('create', { now: 1000, input: {...input(), name:'No observations'} });
        const add = store.db.prepare('INSERT INTO checks(id,monitor_id,service_run_id,monitor_revision,execution_epoch,trigger,lifecycle,queued_at,started_at,completed_at,outcome,duration_ms,terminal_order) VALUES(?,?,?,1,1,\'manual\',?,?,?,?,?,?,?)');
        for (const [lifecycle, outcome, duration] of [['COMPLETED','SUCCESS',11],['COMPLETED','HTTP_ERROR',77],['CANCELLED',null,null],['QUEUED',null,null]] as const) {
            add.run(randomUUID(),m.id,runId,lifecycle,1000,lifecycle==='QUEUED'?null:1000,lifecycle==='QUEUED'?null:1100,outcome,duration,lifecycle==='QUEUED'?null:1);
        }
        const list = store.execute('list', { now: 1200, query:{include:'summary'} });
        expect(list.data.find(row=>row.id===m.id)?.summary).toMatchObject({sampleCount:2,latestLatencyMs:77,sampledAvailabilityPercent:50});
        expect(list.data.find(row=>row.id===empty.id)?.summary).toMatchObject({sampleCount:0,latestLatencyMs:null});
    } finally { store.execute('close', {}); await dispose(dir); }
});

for (const version of [1, 2, 3, 4]) it(`upgrades seeded schema ${version} transactionally without changing existing observations`, async () => {
    const dir = await temp(), path = join(dir, 'pulse.sqlite'), template = new Store(join(dir, 'template.sqlite'));
    template.execute('initialize', { now: 1000, runId: randomUUID(), fingerprint: 'a'.repeat(64) });
    const monitor = template.execute('create', { now: 1000, input: input() });
    const definition = template.db.prepare('SELECT * FROM monitors WHERE id=?').get(monitor.id)!;
    template.execute('close', {});
    try {
        const db = new DatabaseSync(path);
        db.exec('CREATE TABLE schema_migrations(version INTEGER PRIMARY KEY,checksum TEXT NOT NULL,applied_at INTEGER NOT NULL) STRICT');
        for (const [i, sql] of [migration1, migration2, migration3, migration4].slice(0, version).entries()) {
            if (i === 3) { db.exec('BEGIN'); applyChecksMigration(db); } else db.exec(sql);
            db.prepare('INSERT INTO schema_migrations VALUES(?,?,?)').run(i + 1, createHash('sha256').update(sql).digest('hex'), 1000);
            if (i === 3) db.exec('COMMIT');
        }
        db.prepare('INSERT INTO monitors VALUES(' + Object.keys(definition).map(() => '?').join(',') + ')').run(...Object.values(definition));
        const runId = randomUUID(), checkId = randomUUID();
        db.prepare('INSERT INTO service_runs(id,started_at,last_heartbeat_at,config_fingerprint) VALUES(?,?,?,?)').run(runId, 1000, 1000, 'a'.repeat(64));
        db.prepare("INSERT INTO checks(id,monitor_id,service_run_id,monitor_revision,execution_epoch,trigger,lifecycle,queued_at,started_at,completed_at,outcome,http_status,duration_ms,terminal_order) VALUES(?,?,?,1,1,'automatic','COMPLETED',1000,1000,1050,'SUCCESS',200,50,1)").run(checkId, monitor.id, runId);
        const original = db.prepare('SELECT id,monitor_id,service_run_id,started_at,completed_at,outcome,http_status,duration_ms FROM checks').all();
        db.close();
        const upgraded = new Store(path);
        expect(upgraded.db.prepare('SELECT * FROM monitors WHERE id=?').get(monitor.id)).toEqual(definition);
        expect(upgraded.db.prepare('SELECT id,monitor_id,service_run_id,started_at,completed_at,outcome,http_status,duration_ms FROM checks').all()).toEqual(original);
        expect(upgraded.db.prepare('SELECT count(*) AS n FROM schema_migrations').get()?.n).toBe(5);
        expect(upgraded.db.prepare('PRAGMA mmap_size').get()?.mmap_size).toBe(67108864);
        expect(upgraded.db.prepare('PRAGMA cache_size').get()?.cache_size).toBe(-16384);
        expect(upgraded.db.prepare('PRAGMA integrity_check').get()?.integrity_check).toBe('ok');
        expect(upgraded.db.prepare('PRAGMA foreign_key_check').all()).toEqual([]);
        upgraded.execute('close', {});
    } finally { await dispose(dir); }
});

it('failed migration rolls back earlier migration steps and preserves the old schema and data', async () => {
    const dir = await temp(), path = join(dir, 'pulse.sqlite');
    try {
        const db = new DatabaseSync(path);
        db.exec('CREATE TABLE schema_migrations(version INTEGER PRIMARY KEY,checksum TEXT NOT NULL,applied_at INTEGER NOT NULL) STRICT');
        db.exec(migration1);
        db.prepare('INSERT INTO schema_migrations VALUES(1,?,1)').run(createHash('sha256').update(migration1).digest('hex'));
        db.exec('CREATE TABLE notification_destinations(id TEXT PRIMARY KEY); INSERT INTO notification_destinations VALUES(\'preserve-me\')');
        db.close();
        expect(() => new Store(path)).toThrow();
        const reopened = new DatabaseSync(path, { readOnly: true });
        expect(reopened.prepare('SELECT count(*) AS n FROM schema_migrations').get()?.n).toBe(1);
        expect(reopened.prepare("SELECT name FROM sqlite_master WHERE name='monitor_status'").get()).toBeUndefined();
        expect(reopened.prepare('SELECT id FROM notification_destinations').get()?.id).toBe('preserve-me');
        reopened.close();
    } finally { await dispose(dir); }
});

it('doctor rejects a newer schema without modifying database records', async () => {
    const dir = await temp(), path = join(dir, 'pulse.sqlite'), store = new Store(path);
    store.db.prepare('INSERT INTO schema_migrations VALUES(6,?,1)').run('f'.repeat(64));
    const before = store.db.prepare('SELECT * FROM schema_migrations ORDER BY version').all();
    store.execute('close', {});
    const env = { ...process.env };
    for (const key of Object.keys(env)) if (key.startsWith('PULSE_')) delete env[key];
    env.PULSE_DATA_DIR = dir;
    try {
        await expect(promisify(execFile)(process.execPath, ['bin/pulse.mjs', 'doctor'], { env, windowsHide: true, timeout: 10000 })).rejects.toMatchObject({ code: 1, stdout: expect.stringContaining('Schema: unsupported') });
        const db = new DatabaseSync(path, { readOnly: true });
        expect(db.prepare('SELECT * FROM schema_migrations ORDER BY version').all()).toEqual(before);
        db.close();
    } finally { await dispose(dir); }
});
