import { describe, it, expect } from 'vitest';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { Store } from '../apps/server/src/persistence/store.js';
import { Database } from '../apps/server/src/persistence/database.js';
import { acquireLock } from '../apps/server/src/runtime/lock.js';
import { temp, dispose, input, success } from './helpers.js';
async function store() {
    const dir = await temp(), s = new Store(join(dir, 'pulse.sqlite')), now = Date.now();
    s.execute('initialize', {
        now, runId: randomUUID(), fingerprint: 'a'.repeat(64)
    });
    return {
        dir, s, now
    };
}
describe('real on-disk SQLite', () => {
    it('persists monitors/checks, WAL/FULL and indexes survive reopening', async () => {
        const { dir, s, now } = await store();
        try {
            expect(s.db.prepare('PRAGMA journal_mode').get()?.journal_mode).toBe('wal');
            expect(s.db.prepare('PRAGMA synchronous').get()?.synchronous).toBe(2);
            const m = s.execute('create', {
                now, input: input()
            });
            const reservation = s.execute('dispatch', {
                now, preferManual: false
            })!;
            s.execute('finish', {
                id: reservation.check.id, now: now + 10, observation: success
            });
            s.execute('close', {});
            const reopened = new Store(join(dir, 'pulse.sqlite'));
            try {
                reopened.execute('initialize', {
                    now: now + 20, runId: randomUUID(), fingerprint: 'b'.repeat(64)
                });
                expect(reopened.execute('get', {
                    id: m.id
                }).name).toBe(m.name);
                expect(reopened.execute('execution', {
                    id: reservation.check.id
                })).toMatchObject({
                    outcome: 'SUCCESS', durationMs: 1
                });
                const plan = reopened.db.prepare("EXPLAIN QUERY PLAN SELECT * FROM checks WHERE monitor_id=? ORDER BY sequence DESC LIMIT 50").all(m.id);
                expect(JSON.stringify(plan)).toContain('checks_monitor_sequence');
            }
            finally {
                reopened.execute('close', {});
            }
        }
        finally {
            await dispose(dir);
        }
    });
    it('enforces unique unsettled/FKs/check constraints and rolls back invalid transactions', async () => {
        const { dir, s, now } = await store();
        try {
            const m = s.execute('create', {
                now, input: input()
            }), r = s.execute('manual', {
                now, id: m.id, limit: 1
            });
            expect(s.execute('manual', {
                now, id: m.id, limit: 1
            }).id).toBe(r.id);
            expect(() => s.db.prepare('UPDATE monitors SET interval_ms=1 WHERE id=?').run(m.id)).toThrow();
            expect(() => s.db.prepare('UPDATE checks SET monitor_id=? WHERE id=?').run(randomUUID(), r.id)).toThrow();
            expect(() => s.db.prepare("UPDATE checks SET lifecycle='COMPLETED' WHERE id=?").run(r.id)).toThrow();
            s.db.exec('BEGIN IMMEDIATE');
            s.db.prepare('UPDATE monitors SET name=? WHERE id=?').run('Uncommitted', m.id);
            s.db.exec('ROLLBACK');
            expect(s.execute('get', {
                id: m.id
            }).name).toBe('Fixture');
            expect(() => s.execute('patch', {
                id: m.id, revision: 5, now, input: {
                    name: 'bad'
                }
            })).toThrow('REVISION_CONFLICT');
            expect(s.execute('get', {
                id: m.id
            }).revision).toBe(1);
        }
        finally {
            s.execute('close', {});
            await dispose(dir);
        }
    });
    it('restart abandons unfinished work without pretending downtime', async () => {
        const { dir, s, now } = await store();
        try {
            const m = s.execute('create', {
                now, input: input()
            }), r = s.execute('dispatch', {
                now, preferManual: false
            })!;
            s.execute('close', {});
            const reopened = new Store(join(dir, 'pulse.sqlite'));
            try {
                reopened.execute('initialize', {
                    now: now + 100, runId: randomUUID(), fingerprint: 'a'.repeat(64)
                });
                expect(reopened.execute('execution', {
                    id: r.check.id
                })).toMatchObject({
                    lifecycle: 'ABANDONED', outcome: null, durationMs: null
                });
                expect(reopened.execute('get', {
                    id: m.id
                }).status.state).toBe('UNKNOWN');
                expect(reopened.execute('dispatch', {
                    now: now + 100, preferManual: false
                })?.monitor.id).toBe(m.id);
            }
            finally {
                reopened.execute('close', {});
            }
        }
        finally {
            await dispose(dir);
        }
    });
    it('fences stale results after edit and cascades only confirmed service deletion', async () => {
        const { dir, s, now } = await store();
        try {
            const m = s.execute('create', {
                now, input: input()
            }), r = s.execute('dispatch', {
                now, preferManual: false
            })!;
            s.execute('patch', {
                id: m.id, revision: 1, now: now + 2, input: {
                    name: 'Renamed'
                }
            });
            s.execute('finish', {
                id: r.check.id, now: now + 3, observation: success
            });
            expect(s.execute('execution', {
                id: r.check.id
            }).lifecycle).toBe('CANCELLED');
            expect(s.execute('get', {
                id: m.id
            }).timeoutMs).toBe(1000);
            s.execute('delete', {
                id: m.id, revision: 2, now: now + 4
            });
            expect(s.db.prepare('SELECT count(*) AS n FROM checks').get()?.n).toBe(0);
        }
        finally {
            s.execute('close', {});
            await dispose(dir);
        }
    });
    it('refuses newer schema and checksum mismatch without resetting existing records', async () => {
        const { dir, s, now } = await store();
        const m = s.execute('create', {
            now, input: input()
        });
        s.execute('close', {});
        try {
            for (const sql of ["UPDATE schema_migrations SET version=99 WHERE version=2", "UPDATE schema_migrations SET version=2,checksum='tampered' WHERE version=99"]) {
                const db = new DatabaseSync(join(dir, 'pulse.sqlite'));
                db.exec(sql);
                db.close();
                expect(() => new Store(join(dir, 'pulse.sqlite'))).toThrow('SCHEMA_UNSUPPORTED');
                const read = new DatabaseSync(join(dir, 'pulse.sqlite'), {
                    readOnly: true
                });
                expect(read.prepare('SELECT name FROM monitors WHERE id=?').get(m.id)?.name).toBe('Fixture');
                read.close();
            }
        }
        finally {
            await dispose(dir);
        }
    });
    it('single-instance canonical lock refuses second owner and releases cleanly', async () => {
        const dir = await temp();
        const first = await acquireLock(dir);
        try {
            await expect(acquireLock(join(dir, '.'))).rejects.toThrow('DATA_DIRECTORY_LOCKED');
        }
        finally {
            await first.release();
        }
        const next = await acquireLock(dir);
        await next.release();
        await dispose(dir);
    });
    it('worker queue bounds reads and exposes worker death as a persistence fault', async () => {
        const dir = await temp(), db = new Database(dir, 10);
        try {
            await db.ready;
            await db.call('initialize', {
                now: Date.now(), runId: randomUUID(), fingerprint: 'a'.repeat(64)
            });
            const promises = Array.from({
                length: 20
            }, () => db.call('health', {}));
            const results = await Promise.allSettled(promises);
            expect(results.some(r => r.status === 'rejected')).toBe(true);
            expect(db.queueLength).toBe(0);
            await db.close();
            await expect(db.call('health', {})).rejects.toThrow();
        }
        finally {
            await dispose(dir);
        }
    });
});
