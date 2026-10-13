import { it, expect } from 'vitest';
import { fork } from 'node:child_process';
import { once } from 'node:events';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { instance, target, temp, dispose, until } from './helpers.js';
it('kill after actual receipt consumes a durable attempt and retries identical bytes after restart', async () => {
    const dir = await temp(), received: {
        id: string;
        body: string;
        attempt: number;
    }[] = [];
    const receiver = await target(async (req, res) => {
        let body = '';
        for await (const b of req)
            body += String(b);
        received.push({
            id: String(req.headers['x-pulse-event-id']), body, attempt: Number(req.headers['x-pulse-attempt'])
        });
        res.writeHead(204);
        res.end();
    });
    await writeFile(join(dir, 'ops.url'), receiver.url, {
        mode: 0o600
    });
    const child = fork('tests/fixtures/delivery-crash.mjs', [dir], {
        execPath: process.execPath, execArgv: [], stdio: ['ignore', 'ignore', 'pipe', 'ipc']
    }), exit = once(child, 'exit');
    try {
        const [message] = await once(child, 'message');
        expect(message).toEqual({
            code: 'RECEIVED_BEFORE_COMMIT'
        });
        child.kill('SIGKILL');
        await exit;
        expect(received).toHaveLength(1);
        const disk = new DatabaseSync(join(dir, 'pulse.sqlite'));
        try {
            expect(disk.prepare('SELECT state,attempt_count FROM notification_deliveries').get()).toMatchObject({
                state: 'IN_FLIGHT', attempt_count: 1
            });
        }
        finally {
            disk.close();
        }
        const now = Date.now() + 20000, p = await instance({
            dir, rawClock: () => now, env: {
                PULSE_SECRETS_DIR: dir
            }
        });
        try {
            await until(() => p.runtime.db.call('deliveryStats', {
                now
            }), s => s.succeeded === 1);
            expect(received).toHaveLength(2);
            expect(received[1]).toEqual({
                ...received[0]!, attempt: 2
            });
            expect(new Set(received.map(r => r.id)).size).toBe(1);
        }
        finally {
            await p.close();
        }
    }
    finally {
        if (child.exitCode === null && child.signalCode === null) {
            child.kill();
            await exit;
        }
        await receiver.close();
        await dispose(dir);
    }
});
it('real worker retries exactly five times with persistent backoff and never changes event bytes', async () => {
    const dir = await temp(), received: {
        id: string;
        body: string;
        attempt: number;
    }[] = [];
    const receiver = await target(async (req, res) => {
        let body = '';
        for await (const b of req)
            body += String(b);
        received.push({
            id: String(req.headers['x-pulse-event-id']), body, attempt: Number(req.headers['x-pulse-attempt'])
        });
        res.writeHead(503);
        res.end();
    });
    await writeFile(join(dir, 'ops.url'), receiver.url, {
        mode: 0o600
    });
    let now = Date.now() + 10000;
    const p = await instance({
        dir, rawClock: () => now, env: {
            PULSE_SECRETS_DIR: dir
        }
    });
    try {
        const d = await p.runtime.db.call('destinationCreate', {
            now, input: {
                name: 'Retry receiver', urlSecretRef: 'ops', signingSecretRef: null, enabled: true
            }
        });
        await p.runtime.db.call('destinationTest', {
            now, id: d.id
        });
        for (let attempt = 1; attempt <= 5; attempt++) {
            p.runtime.deliveries.wake();
            const job = await until(() => p.runtime.db.call('deliveries', {
                now, query: {}
            }), page => page.data[0]?.attemptCount === attempt && page.data[0]?.state !== 'IN_FLIGHT');
            expect(received.at(-1)?.attempt).toBe(attempt);
            if (attempt < 5) {
                expect(job.data[0]?.state).toBe('PENDING');
                expect(Date.parse(job.data[0]!.nextAttemptAt!) - Date.parse(job.data[0]!.updatedAt)).toBe(5000 * 2 ** (attempt - 1));
                now = Date.parse(job.data[0]!.nextAttemptAt!);
            }
            else
                expect(job.data[0]?.state).toBe('DEAD');
        }
        expect(received).toHaveLength(5);
        expect(new Set(received.map(r => r.id)).size).toBe(1);
        expect(new Set(received.map(r => r.body)).size).toBe(1);
        now += 300000;
        p.runtime.deliveries.wake();
        expect(await p.runtime.db.call('deliveryClaim', {
            now
        })).toBeNull();
    }
    finally {
        await p.close();
        await receiver.close();
        await dispose(dir);
    }
});
