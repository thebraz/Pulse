import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { Store } from '../apps/server/src/persistence/store.js';
import type { Observation } from '@pulse/contracts';
import { temp, dispose, input, success } from './helpers.js';
export const epoch = Date.UTC(2026, 9, 1);
export const failure: Observation = {
    ...success, outcome: 'HTTP_ERROR', httpStatus: 500, errorCode: 'UNEXPECTED_STATUS'
};
export async function fixture() {
    const dir = await temp(), path = join(dir, 'pulse.sqlite');
    let store = new Store(path), now = epoch;
    const init = () => {
        store.execute('initialize', {
            now, runId: randomUUID(), fingerprint: 'a'.repeat(64)
        });
        store.execute('heartbeat', {
            now
        });
    };
    init();
    return {
        dir, path, get s() { return store; }, get now() { return now; }, set now(value: number) { now = value; },
        create: (changes = {}) => store.execute('create', {
            now, input: {
                ...input(), ...changes
            }
        }),
        check: (id: string, observation: Observation = success) => {
            const queued = store.execute('manual', {
                id, now, limit: 100
            });
            const r = store.execute('dispatch', {
                now, preferManual: true
            });
            if (r?.check.id !== queued.id)
                throw new Error('FIXTURE_WRONG_DISPATCH');
            now += 10;
            store.execute('finish', {
                id: queued.id, now, observation
            });
            return queued.id;
        },
        restart: (at: number) => { store.execute('close', {}); now = at; store = new Store(path); init(); },
        close: async () => { store.execute('close', {}); await dispose(dir); }
    };
}
