import { it, expect, vi, afterEach } from 'vitest';
import { Worker } from 'node:worker_threads';
import { randomUUID } from 'node:crypto';
import { Database } from '../apps/server/src/persistence/database.js';

vi.mock('node:worker_threads', async () => {
    const { EventEmitter } = await import('node:events');
    class Worker extends EventEmitter {
        static current: Worker;
        constructor() { super(); Worker.current = this; }
        postMessage = vi.fn();
        terminate = vi.fn(async () => 0);
    }
    return { Worker };
});
type Fixture = { emit: (event: string, value: unknown) => void; terminate: ReturnType<typeof vi.fn> };
const worker = () => (Worker as unknown as { current: Fixture }).current;
afterEach(() => vi.useRealTimers());

it('allows slow integrity validation and recovery before readiness without weakening normal operation deadlines', async () => {
    vi.useFakeTimers();
    const db = new Database('/fixture');
    await vi.advanceTimersByTimeAsync(200000);
    expect(db.fault).toBeNull();
    worker().emit('message', { ready: true });
    await db.ready;
    const recovery = db.call('initialize', { now: 1000, runId: randomUUID(), fingerprint: 'a'.repeat(64) });
    await vi.advanceTimersByTimeAsync(20000);
    expect(db.fault).toBeNull();
    worker().emit('message', { id: 1, ok: true, value: { seed: 1000, sqliteVersion: '3.53.3' } });
    expect((await recovery).seed).toBe(1000);
    const timedOut = expect(db.call('heartbeat', { now: 2000 })).rejects.toMatchObject({ code: 'DATABASE_UNAVAILABLE' });
    await vi.advanceTimersByTimeAsync(10000);
    await timedOut;
    await db.close();
});

it('terminates an integrity worker that exceeds the finite bootstrap deadline', async () => {
    vi.useFakeTimers();
    const db = new Database('/fixture');
    const rejected = expect(db.ready).rejects.toMatchObject({ code: 'DATABASE_UNAVAILABLE' });
    await vi.advanceTimersByTimeAsync(600000);
    await rejected;
    expect(worker().terminate).toHaveBeenCalled();
    await db.close();
});
