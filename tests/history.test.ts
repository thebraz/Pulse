import { it, expect } from 'vitest';
import { Store } from '../apps/server/src/persistence/store.js';
import { temp, dispose, input, success } from './helpers.js';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
it('history pagination preserves immutable ordering, snapshot and bound filters', async () => {
    const dir = await temp(), store = new Store(join(dir, 'pulse.sqlite')), now = Date.now();
    try {
        store.execute('initialize', {
            now, runId: randomUUID(), fingerprint: 'a'.repeat(64)
        });
        const m = store.execute('create', {
            now, input: input()
        });
        for (let i = 0; i < 5; i++) {
            const c = store.execute('manual', {
                id: m.id, now: now + i * 2, limit: 10
            });
            store.execute('dispatch', {
                now: now + i * 2, preferManual: true
            });
            store.execute('finish', {
                id: c.id, now: now + i * 2 + 1, observation: i % 2 ? {
                    ...success, outcome: 'HTTP_ERROR', httpStatus: 500, errorCode: 'UNEXPECTED_STATUS'
                } : success
            });
        }
        const first = store.execute('history', {
            id: m.id, now: now + 20, query: {
                limit: '2'
            }
        });
        expect(first.data.map(c => c.sequence)).toEqual([5, 4]);
        const late = store.execute('manual', {
            id: m.id, now: now + 21, limit: 10
        });
        store.execute('dispatch', {
            now: now + 21, preferManual: true
        });
        store.execute('finish', {
            id: late.id, now: now + 22, observation: success
        });
        const second = store.execute('history', {
            id: m.id, now: now + 30, query: {
                limit: '2', cursor: first.page.nextCursor!
            }
        });
        expect(second.data.map(c => c.sequence)).toEqual([3, 2]);
        expect(second.page.asOf).toBe(first.page.asOf);
        const third = store.execute('history', {
            id: m.id, now: now + 30, query: {
                limit: '2', cursor: second.page.nextCursor!
            }
        });
        expect(third.data.map(c => c.sequence)).toEqual([1]);
        expect(third.page.nextCursor).toBeNull();
        const failures = store.execute('history', {
            id: m.id, now: now + 30, query: {
                outcome: 'HTTP_ERROR', sort: 'sequence'
            }
        });
        expect(failures.data.map(c => c.sequence)).toEqual([2, 4]);
        expect(() => store.execute('history', {
            id: m.id, now: now + 30, query: {
                cursor: first.page.nextCursor!, outcome: 'HTTP_ERROR'
            }
        })).toThrow('VALIDATION_ERROR');
        expect(() => store.execute('history', {
            id: m.id, now: now + 30, query: {
                from: new Date(now - 91 * 86400000).toISOString()
            }
        })).toThrow('QUERY_RANGE_TOO_LARGE');
    }
    finally {
        store.execute('close', {});
        await dispose(dir);
    }
});
