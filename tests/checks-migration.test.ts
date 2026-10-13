import { describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { DatabaseSync, type SQLInputValue } from 'node:sqlite';
import { applyChecksMigration } from '../apps/server/src/persistence/checks-migration.js';
import { checksSchema3, checksSchema4, migration1, migration2, migration3, migration4 } from '../apps/server/src/persistence/migration.js';
import { dispose, temp } from './helpers.js';

const checksum = (sql: string) => createHash('sha256').update(sql).digest('hex');
const migrations = [migration1, migration2, migration3];

async function fixture() {
    const directory = await temp();
    const db = new DatabaseSync(join(directory, 'migration.sqlite'));
    db.exec('PRAGMA journal_mode=WAL;PRAGMA synchronous=FULL;PRAGMA foreign_keys=ON');
    db.exec('CREATE TABLE schema_migrations(version INTEGER PRIMARY KEY,checksum TEXT NOT NULL,applied_at INTEGER NOT NULL) STRICT');
    for (const [index, sql] of migrations.entries()) {
        db.exec(sql);
        db.prepare('INSERT INTO schema_migrations VALUES(?,?,?)').run(index + 1, checksum(sql), 1700000000000);
    }
    db.exec(`
        INSERT INTO monitors(id,name,url,method,expected_status_codes_json,interval_ms,timeout_ms,follow_redirects,enabled,failure_threshold,recovery_threshold,latency_threshold_ms,degradation_threshold,revision,execution_epoch,created_at,updated_at,next_due_at)
        VALUES('m','Fixture','https://example.com','GET','[200]',60000,10000,0,1,3,2,1000,3,1,1,1000,1000,1000);
        INSERT INTO service_runs(id,started_at,last_heartbeat_at,config_fingerprint) VALUES('r',1000,1000,'fixture');
        INSERT INTO checks(sequence,id,monitor_id,service_run_id,monitor_revision,execution_epoch,trigger,lifecycle,queued_at,started_at,completed_at,outcome,http_status,duration_ms,terminal_order)
        VALUES(41,'old','m','r',1,1,'automatic','COMPLETED',1000,1001,1002,'HTTP_ERROR',500,1,1);
        INSERT INTO checks(sequence,id,monitor_id,service_run_id,monitor_revision,execution_epoch,trigger,lifecycle,queued_at,started_at,completed_at,outcome,http_status,duration_ms,terminal_order)
        VALUES(99,'deleted','m','r',1,1,'manual','COMPLETED',1000,1001,1002,'SUCCESS',200,1,2);
        DELETE FROM checks WHERE id='deleted';
        INSERT INTO state_transitions(sequence,id,monitor_id,from_state,to_state,reason,occurred_at,check_id,monitor_revision,execution_epoch)
        VALUES(7,'transition','m','UNKNOWN','DOWN','fixture',1002,'old',1,1);
        INSERT INTO incidents(id,monitor_id,monitor_revision,status,opened_at,detected_at,opening_check_id,opening_transition_id,failure_category,diagnostic_summary)
        VALUES('incident','m',1,'OPEN',1001,1002,'old','transition','HTTP_ERROR','fixture');
        INSERT INTO monitor_status(monitor_id,state,reason,last_check_id,state_changed_at,open_incident_id)
        VALUES('m','DOWN','fixture','old',1002,'incident');
        INSERT INTO monitor_activity_windows(id,monitor_id,enabled_at) VALUES('window','m',1000);
        INSERT INTO notification_destinations(id,name,enabled,url_secret_ref,revision,created_at,updated_at)
        VALUES('destination','Fixture',1,'fixture',1,1000,1000);
        INSERT INTO notification_deliveries(id,event_id,destination_id,incident_id,destination_revision,event_type,payload_json,state,next_attempt_at,created_at,updated_at)
        VALUES('delivery','event','destination','incident',1,'incident.opened','{}','PENDING',1002,1002,1002);
    `);
    return { db, close: async () => { db.close(); await dispose(directory); } };
}

function migrate(db: DatabaseSync) {
    db.exec('BEGIN IMMEDIATE');
    try {
        applyChecksMigration(db);
        db.prepare('INSERT INTO schema_migrations VALUES(4,?,?)').run(checksum(migration4), Date.now());
        db.exec('COMMIT');
    } catch (error) {
        if (db.isTransaction) db.exec('ROLLBACK');
        throw error;
    }
}

function snapshot(db: DatabaseSync) {
    return db.prepare("SELECT name FROM sqlite_schema WHERE type='table' AND name!='schema_migrations' ORDER BY name").all().map(row => ({
        name: row.name, rows: db.prepare(`SELECT rowid,* FROM "${String(row.name).replaceAll('"', '""')}" ORDER BY rowid`).all()
    }));
}

function assertDefensive(db: DatabaseSync) {
    expect(db.prepare('PRAGMA writable_schema').get()?.writable_schema).toBe(0);
    expect(db.prepare('PRAGMA ignore_check_constraints').get()?.ignore_check_constraints).toBe(0);
    expect(db.prepare('PRAGMA foreign_keys').get()?.foreign_keys).toBe(1);
    db.exec('PRAGMA writable_schema=ON');
    try {
        expect(() => db.exec("UPDATE sqlite_schema SET sql=sql WHERE name='checks'")).toThrow();
    } finally {
        db.exec('PRAGMA writable_schema=OFF');
    }
}

const corruptions = [
    ['monitor revision', 'monitor_revision=0'], ['execution epoch', 'execution_epoch=0'],
    ['trigger', "trigger='evil'"], ['lifecycle', "lifecycle='evil'"], ['outcome', "outcome='evil'"],
    ['HTTP status', 'http_status=700'], ['duration', 'duration_ms=-1'], ['redirect count', 'redirect_count=4'],
    ['terminal order', 'terminal_order=0'], ['terminal lifecycle pairing', 'terminal_order=NULL'],
    ['completed lifecycle fields', 'completed_at=NULL'],
    ['running start', "lifecycle='RUNNING',terminal_order=NULL,completed_at=NULL,outcome=NULL,http_status=NULL,duration_ms=NULL,started_at=NULL"],
    ['start order', 'started_at=queued_at-1'], ['completion order', 'completed_at=started_at-1'], ['slow success', 'slow_success=2']
];

describe('schema-only equivalent CHECK migration', () => {
    it('preserves original migration checksums, every rowid, sequence, FK link and index rootpage', async () => {
        const f = await fixture();
        try {
            expect(migrations.map(checksum)).toEqual([
                'ce8f7daf47fcaf49f72e286ac824c84b364d07200bcf297d1393246a8c6a60fd',
                '949ad899a59415277602642296b3bfda8a0e893836f252687df0356ec33f725c',
                '8c31232722c661f4ac975627e09203d12fbfa50debbb28a82c062dd63eea2060'
            ]);
            const data = snapshot(f.db), before = f.db.prepare('SELECT type,name,rootpage,sql FROM sqlite_schema ORDER BY type,name').all();
            const records = f.db.prepare('SELECT * FROM schema_migrations ORDER BY version').all();
            const version = Number(f.db.prepare('PRAGMA schema_version').get()?.schema_version);
            migrate(f.db);
            expect(snapshot(f.db)).toEqual(data);
            const after = f.db.prepare('SELECT type,name,rootpage,sql FROM sqlite_schema ORDER BY type,name').all();
            expect(after.map(row => row.name === 'checks' && row.type === 'table' ? { ...row, sql: checksSchema3 } : row)).toEqual(before);
            expect(f.db.prepare("SELECT sql FROM sqlite_schema WHERE type='table' AND name='checks'").get()?.sql).toBe(checksSchema4);
            expect(f.db.prepare('SELECT * FROM schema_migrations WHERE version<=3 ORDER BY version').all()).toEqual(records);
            expect(f.db.prepare('SELECT checksum FROM schema_migrations WHERE version=4').get()?.checksum).toBe(checksum(migration4));
            expect(f.db.prepare('PRAGMA schema_version').get()?.schema_version).toBe(version + 1);
            expect(f.db.prepare('PRAGMA quick_check').all()).toEqual([{ quick_check: 'ok' }]);
            expect(f.db.prepare('PRAGMA foreign_key_check').all()).toEqual([]);
            expect(f.db.prepare("EXPLAIN PRAGMA quick_check('checks')").all().some(row => row.opcode === 'OpenEphemeral')).toBe(false);
            f.db.exec("INSERT INTO checks(id,monitor_id,service_run_id,monitor_revision,execution_epoch,trigger,lifecycle,queued_at) VALUES('next','m','r',1,1,'manual','QUEUED',1003)");
            expect(f.db.prepare("SELECT sequence FROM checks WHERE id='next'").get()?.sequence).toBe(100);
            assertDefensive(f.db);
        } finally { await f.close(); }
    });

    it.each(corruptions)('fails closed and rolls the entire migration back for persisted %s CHECK corruption', async (_name, mutation) => {
        const f = await fixture();
        try {
            f.db.exec(`PRAGMA ignore_check_constraints=ON;UPDATE checks SET ${mutation} WHERE id='old';PRAGMA ignore_check_constraints=OFF`);
            const before = snapshot(f.db), version = f.db.prepare('PRAGMA schema_version').get()?.schema_version;
            expect(() => migrate(f.db)).toThrow('DATABASE_UNAVAILABLE');
            expect(snapshot(f.db)).toEqual(before);
            expect(f.db.prepare("SELECT sql FROM sqlite_schema WHERE type='table' AND name='checks'").get()?.sql).toBe(checksSchema3);
            expect(f.db.prepare('PRAGMA schema_version').get()?.schema_version).toBe(version);
            expect(f.db.prepare('SELECT count(*) AS n FROM schema_migrations').get()?.n).toBe(3);
            assertDefensive(f.db);
        } finally { await f.close(); }
    });

    it('rolls back on persisted FK corruption after all writable CHECK validation', async () => {
        const f = await fixture();
        try {
            f.db.exec("PRAGMA foreign_keys=OFF;UPDATE checks SET monitor_id='missing' WHERE id='old';PRAGMA foreign_keys=ON");
            const before = snapshot(f.db);
            expect(() => migrate(f.db)).toThrow('DATABASE_UNAVAILABLE');
            expect(snapshot(f.db)).toEqual(before);
            expect(f.db.prepare("SELECT sql FROM sqlite_schema WHERE type='table' AND name='checks'").get()?.sql).toBe(checksSchema3);
            expect(f.db.prepare('SELECT count(*) AS n FROM schema_migrations').get()?.n).toBe(3);
            assertDefensive(f.db);
        } finally { await f.close(); }
    });

    it('refuses unknown DDL and an unprotected caller transaction', async () => {
        const f = await fixture();
        try {
            expect(() => applyChecksMigration(f.db)).toThrow('SCHEMA_UNSUPPORTED');
            f.db.exec('ALTER TABLE checks ADD COLUMN unexpected INTEGER');
            const before = snapshot(f.db), sql = f.db.prepare("SELECT sql FROM sqlite_schema WHERE name='checks'").get()?.sql;
            expect(() => migrate(f.db)).toThrow('SCHEMA_UNSUPPORTED');
            expect(snapshot(f.db)).toEqual(before);
            expect(f.db.prepare("SELECT sql FROM sqlite_schema WHERE name='checks'").get()?.sql).toBe(sql);
            expect(f.db.prepare('SELECT count(*) AS n FROM schema_migrations').get()?.n).toBe(3);
            assertDefensive(f.db);
        } finally { await f.close(); }
    });

    it('restores defensive controls and old schema when SQLite rejects the schema update', async () => {
        const f = await fixture();
        const exec = f.db.exec.bind(f.db);
        try {
            f.db.exec = (sql: string) => { if (sql === migration4) throw new Error('INJECTED_SCHEMA_WRITE_FAILURE'); exec(sql); };
            expect(() => migrate(f.db)).toThrow('INJECTED_SCHEMA_WRITE_FAILURE');
            expect(f.db.prepare("SELECT sql FROM sqlite_schema WHERE type='table' AND name='checks'").get()?.sql).toBe(checksSchema3);
            expect(f.db.prepare('SELECT count(*) AS n FROM schema_migrations').get()?.n).toBe(3);
            assertDefensive(f.db);
        } finally { f.db.exec = exec; await f.close(); }
    });

    it('retains NULL and all lifecycle/outcome acceptance semantics on real STRICT tables', async () => {
        const f = await fixture();
        try {
            const cases: SQLInputValue[][] = [];
            for (const lifecycle of ['QUEUED', 'RUNNING', 'COMPLETED', 'CANCELLED', 'ABANDONED', 'invalid'])
                for (const outcome of [null, 'SUCCESS', 'HTTP_ERROR', 'DNS_ERROR', 'TLS_ERROR', 'CONNECTION_ERROR', 'TIMEOUT', 'REDIRECT_ERROR', 'POLICY_BLOCKED', 'invalid']) {
                    const unsettled = lifecycle === 'QUEUED' || lifecycle === 'RUNNING';
                    cases.push([lifecycle, lifecycle === 'QUEUED' ? null : 1001, unsettled ? null : 1002, outcome, outcome === null ? null : 200, outcome === null ? null : 1, unsettled ? null : 3]);
                }
            function accepted(values: SQLInputValue[]): boolean {
                f.db.exec('SAVEPOINT candidate');
                try {
                    f.db.prepare("INSERT INTO checks(id,monitor_id,service_run_id,monitor_revision,execution_epoch,trigger,queued_at,lifecycle,started_at,completed_at,outcome,http_status,duration_ms,terminal_order) VALUES('candidate','m','r',1,1,'manual',1000,?,?,?,?,?,?,?)").run(...values);
                    return true;
                } catch { return false; }
                finally { f.db.exec('ROLLBACK TO candidate;RELEASE candidate'); }
            }
            const before = cases.map(accepted);
            expect(before[0]).toBe(true); // QUEUED permits its null observation.
            expect(before[20]).toBe(false); // COMPLETED requires an outcome.
            expect(before[21]).toBe(true); // COMPLETED SUCCESS is accepted.
            expect(before[30]).toBe(true); // CANCELLED permits its null observation.
            migrate(f.db);
            expect(cases.map(accepted)).toEqual(before);
            assertDefensive(f.db);
        } finally { await f.close(); }
    });
});
