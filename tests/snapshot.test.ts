import { it, expect } from 'vitest';
import { Store } from '../apps/server/src/persistence/store.js';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { temp, dispose, input, success } from './helpers.js';
it('snapshot excludes an earlier allocated execution terminalized later in the same millisecond, even after owner deletion', async () => {
    const dir = await temp(), store = new Store(join(dir, 'pulse.sqlite')), now = Date.now();
    try {
        store.execute('initialize', {
            now, runId: randomUUID(), fingerprint: 'a'.repeat(64)
        });
        const m = store.execute('create', {
            now, input: input()
        });
        for (let i = 0; i < 3; i++) {
            const c = store.execute('manual', {
                id: m.id, now, limit: 10
            });
            store.execute('dispatch', {
                now, preferManual: true
            });
            store.execute('finish', {
                id: c.id, now, observation: success
            });
        }
        const pending = store.execute('manual', {
            id: m.id, now, limit: 10
        });
        store.execute('dispatch', {
            now, preferManual: true
        });
        const other = store.execute('create', {
            now, input: {
                ...input(), name: 'Other'
            }
        });
        const otherCheck = store.execute('dispatch', {
            now, preferManual: false
        })!;
        store.execute('finish', {
            id: otherCheck.check.id, now, observation: success
        });
        const first = store.execute('history', {
            id: m.id, now: now + 1, query: {
                limit: '1', sort: 'sequence', to: new Date(now + 1).toISOString()
            }
        });
        expect(first.data).toHaveLength(1);
        store.execute('delete', {
            id: other.id, revision: 1, now
        });
        store.execute('finish', {
            id: pending.id, now: now + 1, observation: success
        });
        const later = store.execute('history', {
            id: m.id, now: now + 1, query: {
                limit: '100', sort: 'sequence', to: new Date(now + 1).toISOString(), cursor: first.page.nextCursor!
            }
        });
        expect(later.data.map(c => c.sequence)).toEqual([2, 3]);
        expect(later.data.some(c => c.id === pending.id)).toBe(false);
    }
    finally {
        store.execute('close', {});
        await dispose(dir);
    }
});
it('Unicode name pagination follows the same normalization as SQL search and stored last observation survives pause', async () => {
    const dir = await temp(), store = new Store(join(dir, 'pulse.sqlite')), now = Date.now();
    try {
        store.execute('initialize', {
            now, runId: randomUUID(), fingerprint: 'a'.repeat(64)
        });
        for (const name of ['Éclair', 'zebra', 'école'])
            store.execute('create', {
                now, input: {
                    ...input(), name
                }
            });
        const page = store.execute('list', {
            now, query: {
                limit: '2'
            }
        });
        const next = store.execute('list', {
            now, query: {
                limit: '2', cursor: page.page.nextCursor!
            }
        });
        expect([...page.data, ...next.data].map(m => m.name)).toEqual(['zebra', 'Éclair', 'école']);
        const m = page.data[0]!;
        const c = store.execute('manual', {
            id: m.id, now, limit: 10
        });
        store.execute('dispatch', {
            now, preferManual: true
        });
        store.execute('finish', {
            id: c.id, now, observation: {
                ...success, outcome: 'HTTP_ERROR', httpStatus: 500, errorCode: 'UNEXPECTED_STATUS'
            }
        });
        const paused = store.execute('patch', {
            id: m.id, revision: 1, now, input: {
                enabled: false
            }
        });
        expect(paused.lastObservedOutcome).toBe('HTTP_ERROR');
        expect(paused.lastCheckAt).toBe(new Date(now).toISOString());
        expect(paused.status.state).toBe('UNKNOWN');
    }
    finally {
        store.execute('close', {});
        await dispose(dir);
    }
});
