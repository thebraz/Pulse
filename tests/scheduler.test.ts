import { describe, it, expect } from 'vitest';
import type { Observation } from '@pulse/contracts';
import type { Executor } from '../apps/server/src/monitoring/http.js';
import { instance, monitorResponse, executionResponse, until, success, input } from './helpers.js';
function controlled() {
    const gates = new Map<string, {
        finish: (o: Observation | null) => void;
        signal: AbortSignal;
    }>(), seen: string[] = [];
    let running = 0, max = 0;
    const execute: Executor = (monitor, signal) => new Promise(resolve => {
        expect(gates.has(monitor.name)).toBe(false);
        seen.push(monitor.name);
        running++;
        max = Math.max(max, running);
        const finish = (value: Observation | null) => {
            if (!gates.delete(monitor.name))
                return;
            running--;
            resolve(value);
        };
        gates.set(monitor.name, {
            finish, signal
        });
        signal.addEventListener('abort', () => finish(null), {
            once: true
        });
        if (signal.aborted)
            finish(null);
    });
    return {
        execute, gates, seen, max: () => max, release: (name: string) => gates.get(name)?.finish(success)
    };
}
describe('central bounded scheduler with controlled clock/executor gates', () => {
    it('an unexpected executor fault prevents the active pump from dispatching remaining monitors', async () => {
        const seen: string[] = [];
        const p = await instance({
            autoStart: false, env: {
                PULSE_CHECK_CONCURRENCY: '1'
            }, executor: async (m) => { seen.push(m.name); throw new Error('FAKE_EXECUTOR_FAULT'); }
        });
        try {
            for (let i = 0; i < 8; i++)
                await p.runtime.db.call('create', {
                    now: p.runtime.clock.now(), input: {
                        ...input(), name: String(i)
                    }
                });
            p.runtime.scheduler.start();
            await until(() => p.runtime.scheduler.fault, Boolean);
            await p.runtime.db.call('health', {});
            expect(seen).toHaveLength(1);
            expect((await p.request('/health/ready')).status).toBe(503);
            expect((await p.runtime.db.call('incidents', {
                now: p.runtime.clock.now(), query: {}
            })).data).toHaveLength(0);
        }
        finally {
            await p.close();
        }
    });
    it('due intervals skip missed slots without overlapping or replay bursts', async () => {
        const c = controlled();
        let now = Date.now();
        const p = await instance({
            executor: c.execute, rawClock: () => now, autoStart: false, env: {
                PULSE_CHECK_CONCURRENCY: '1'
            }
        });
        try {
            const m = await monitorResponse(await p.request('/api/v1/monitors', 'POST', {
                name: 'A', url: 'https://example.com', intervalMs: 15000
            }));
            p.runtime.scheduler.start();
            await until(() => c.seen.length, n => n === 1);
            now += 90000;
            p.runtime.scheduler.wake();
            expect(c.seen).toEqual(['A']);
            c.release('A');
            await until(() => p.runtime.scheduler.running, n => n === 0);
            const updated = await monitorResponse(await p.request(`/api/v1/monitors/${m.id}`));
            expect(Date.parse(updated.nextDueAt!)).toBeGreaterThan(now);
            p.runtime.scheduler.wake();
            await p.runtime.db.call('health', {});
            expect(c.seen).toHaveLength(1);
            now = Date.parse(updated.nextDueAt!);
            p.runtime.scheduler.wake();
            await until(() => c.seen.length, n => n === 2);
            expect(c.max()).toBe(1);
            c.release('A');
        }
        finally {
            await p.close();
        }
    });
    it('manual calls coalesce, queue saturates, all work shares global concurrency', async () => {
        const c = controlled(), p = await instance({
            executor: c.execute, autoStart: false, env: {
                PULSE_CHECK_CONCURRENCY: '2', PULSE_MANUAL_QUEUE_LIMIT: '1'
            }
        });
        try {
            const ids: string[] = [];
            for (const name of ['A', 'B', 'C'])
                ids.push((await monitorResponse(await p.request('/api/v1/monitors', 'POST', {
                    name, url: 'https://example.com'
                }))).id);
            const a = await p.request(`/api/v1/monitors/${ids[0]}/checks`, 'POST', {});
            expect(a.status).toBe(202);
            const execution = await executionResponse(a);
            const repeated = await Promise.all(Array.from({
                length: 8
            }, () => p.request(`/api/v1/monitors/${ids[0]}/checks`, 'POST', {}).then(executionResponse)));
            expect(new Set(repeated.map(e => e.id))).toEqual(new Set([execution.id]));
            const saturated = await p.request(`/api/v1/monitors/${ids[1]}/checks`, 'POST', {});
            expect(saturated.status).toBe(429);
            expect(saturated.headers.get('retry-after')).toBe('1');
            p.runtime.scheduler.start();
            await until(() => c.seen.length, n => n === 2);
            expect(c.max()).toBe(2);
            expect(p.runtime.scheduler.running).toBe(2);
            c.release(c.seen[0]!);
            await until(() => c.seen.length, n => n === 3);
            expect(c.max()).toBe(2);
        }
        finally {
            await p.close();
        }
    });
    it('pause cancels running work, retains history, ignores late results and resume dispatches once', async () => {
        const c = controlled(), p = await instance({
            executor: c.execute
        });
        try {
            const m = await monitorResponse(await p.request('/api/v1/monitors', 'POST', {
                name: 'A', url: 'https://example.com'
            }));
            await until(() => c.seen.length, n => n === 1);
            const unsettled = await executionResponse(await p.request(`/api/v1/monitors/${m.id}/checks`, 'POST', {}));
            expect((await p.request(`/api/v1/monitors/${m.id}`, 'PATCH', {
                enabled: false
            }, {
                'if-match': '"1"'
            })).status).toBe(200);
            await until(() => p.runtime.scheduler.running, n => n === 0);
            const cancelled = await executionResponse(await p.request(`/api/v1/executions/${unsettled.id}`));
            expect(cancelled).toMatchObject({
                lifecycle: 'CANCELLED', outcome: null, durationMs: null
            });
            p.runtime.scheduler.wake();
            await p.runtime.db.call('health', {});
            expect(c.seen).toHaveLength(1);
            const resumed = await p.request(`/api/v1/monitors/${m.id}`, 'PATCH', {
                enabled: true
            }, {
                'if-match': '"2"'
            });
            expect(resumed.status).toBe(200);
            await until(() => c.seen.length, n => n === 2);
            expect((await executionResponse(await p.request(`/api/v1/executions/${unsettled.id}`))).lifecycle).toBe('CANCELLED');
            c.release('A');
        }
        finally {
            await p.close();
        }
    });
    it('edit/delete races cancel active resources and disabled monitors are never dispatched', async () => {
        const c = controlled(), p = await instance({
            executor: c.execute
        });
        try {
            const m = await monitorResponse(await p.request('/api/v1/monitors', 'POST', {
                name: 'A', url: 'https://example.com'
            }));
            await until(() => c.seen.length, n => n === 1);
            await p.request(`/api/v1/monitors/${m.id}`, 'PATCH', {
                url: 'https://example.org'
            }, {
                'if-match': '"1"'
            });
            await until(() => c.gates.size, n => n === 0);
            expect(c.seen).toEqual(['A']);
            const b = await monitorResponse(await p.request('/api/v1/monitors', 'POST', {
                name: 'B', url: 'https://example.com'
            }));
            await until(() => c.seen.includes('B'), Boolean);
            expect((await p.request(`/api/v1/monitors/${b.id}?confirm=true`, 'DELETE', undefined, {
                'if-match': '"1"'
            })).status).toBe(204);
            await until(() => c.gates.size, n => n === 0);
            await p.request('/api/v1/monitors', 'POST', {
                name: 'Paused', url: 'https://example.com', enabled: false
            });
            p.runtime.scheduler.wake();
            await p.runtime.db.call('health', {});
            expect(c.seen).not.toContain('Paused');
        }
        finally {
            await p.close();
        }
    });
    it('unexpected executor exceptions fail readiness without inventing target downtime', async () => {
        const p = await instance({
            executor: async () => { throw new Error('CANARY_EXECUTOR_SECRET'); }
        });
        try {
            await p.request('/api/v1/monitors', 'POST', {
                name: 'A', url: 'https://example.com'
            });
            await until(() => p.runtime.scheduler.fault, Boolean);
            const ready = await p.request('/health/ready');
            expect(ready.status).toBe(503);
            expect(await ready.text()).not.toContain('CANARY');
        }
        finally {
            await p.close();
        }
    });
    it('alternates automatic/manual candidates with oldest-due ordering', async () => {
        const c = controlled(), p = await instance({
            executor: c.execute, autoStart: false, env: {
                PULSE_CHECK_CONCURRENCY: '1'
            }
        });
        try {
            const now = p.runtime.clock.now();
            const a = await p.runtime.db.call('create', {
                now, input: {
                    ...input(), name: 'Auto-old'
                }
            });
            await p.runtime.db.call('create', {
                now: now + 1, input: {
                    ...input(), name: 'Auto-new'
                }
            });
            const b = await p.runtime.db.call('create', {
                now: now + 2, input: {
                    ...input(), name: 'Manual-1'
                }
            });
            const d = await p.runtime.db.call('create', {
                now: now + 3, input: {
                    ...input(), name: 'Manual-2'
                }
            });
            await p.runtime.scheduler.manual(b.id);
            await p.runtime.scheduler.manual(d.id);
            p.runtime.scheduler.start();
            await until(() => c.seen.length, n => n === 1);
            expect(c.seen[0]).toBe('Auto-old');
            c.release('Auto-old');
            await until(() => c.seen.length, n => n === 2);
            expect(c.seen[1]).toBe('Manual-1');
            c.release('Manual-1');
            await until(() => c.seen.length, n => n === 3);
            expect(c.seen[2]).toBe('Auto-new');
            expect((await p.runtime.db.call('get', {
                id: a.id
            })).nextDueAt).not.toBeNull();
        }
        finally {
            await p.close();
        }
    });
});
