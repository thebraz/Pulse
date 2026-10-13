import { test as base, expect } from '@playwright/test';
import { fork, type ChildProcess } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { randomBytes, randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { Store } from '../../apps/server/src/persistence/store.js';
import { monitorCreateSchema } from '@pulse/contracts';
import { temp, dispose } from '../helpers.js';
async function listen(server: ReturnType<typeof createServer>) {
    await new Promise<void>((r, j) => { server.once('error', j); server.listen(0, '127.0.0.1', r); });
    const address = server.address();
    if (!address || typeof address === 'string')
        throw new Error('FIXTURE_ADDRESS');
    return address.port;
}
type Environment = {
    origin: string;
    targetUrl: string;
    receipts: {
        id: string;
        type: string;
        attempt: number;
        body: string;
    }[];
    token: string;
    setFailure: (value: boolean) => void;
    setReceiverStatus: (status: number) => void;
    restart: () => Promise<void>;
    authenticated: boolean;
    oldIncidentMonitorId: string | null;
};
export const test = base.extend<{
    pulse: Environment;
    authenticated: boolean;
    oldIncident: boolean;
}>({
    oldIncident: [false, { option: true }],
    authenticated: [false, {
            option: true
        }], pulse: async ({ authenticated, oldIncident }, use) => {
        const dir = await temp(), secrets = join(dir, 'secrets');
        await mkdir(secrets);
        let fail = false, receiverStatus = 204;
        const receipts: Environment['receipts'] = [];
        const target = createServer((_req, res) => { res.writeHead(fail ? 500 : 200); res.end('controlled target'); }), targetPort = await listen(target), receiver = createServer(async (req, res) => {
            let body = '';
            for await (const chunk of req)
                body += String(chunk);
            const event = JSON.parse(body) as {
                eventId: string;
                type: string;
            };
            receipts.push({
                id: event.eventId, type: event.type, attempt: Number(req.headers['x-pulse-attempt']), body
            });
            res.writeHead(receiverStatus);
            res.end();
        }), receiverPort = await listen(receiver), placeholder = createServer(), port = await listen(placeholder);
        await new Promise<void>(r => placeholder.close(() => r()));
        const origin = 'http://127.0.0.1:' + port, token = randomBytes(32).toString('base64url');
        await writeFile(join(secrets, 'ops.url'), 'http://127.0.0.1:' + receiverPort + '/events?key=FAKE_BROWSER_CANARY', {
            mode: 0o600
        });
        await writeFile(join(secrets, 'ops.key'), randomBytes(32).toString('base64url'), {
            mode: 0o600
        });
        await writeFile(join(secrets, 'operator.key'), token, {
            mode: 0o600
        });
        let oldIncidentMonitorId: string | null = null;
        if (oldIncident) {
            const now = Date.now() - 100 * 86400000, store = new Store(join(dir, 'pulse.sqlite'));
            store.execute('initialize', { now, runId: randomUUID(), fingerprint: 'a'.repeat(64) });
            const monitor = store.execute('create', { now, input: monitorCreateSchema.parse({ name: 'Long unresolved outage', url: 'http://127.0.0.1:' + targetPort + '/health', failureThreshold: 1 }) });
            const reservation = store.execute('dispatch', { now, preferManual: false })!;
            store.execute('finish', { id: reservation.check.id, now: now + 1, observation: { outcome: 'HTTP_ERROR', httpStatus: 500, durationMs: 1, redirectCount: 0, errorCode: 'UNEXPECTED_STATUS' } });
            store.execute('patch', { id: monitor.id, revision: 1, now: now + 2, input: { enabled: false } });
            store.execute('close', {});
            oldIncidentMonitorId = monitor.id;
        }
        let processHandle: ChildProcess | null = null, exited: Promise<unknown> | null = null;
        const start = async () => {
            const env = {
                ...process.env
            };
            for (const key of Object.keys(env))
                if (key.startsWith('PULSE_'))
                    delete env[key];
            Object.assign(env, {
                PULSE_DATA_DIR: dir, PULSE_SECRETS_DIR: secrets, PULSE_PORT: String(port), PULSE_PUBLIC_ORIGIN: origin, PULSE_EGRESS_POLICY: 'allow-private', PULSE_ALLOWED_PRIVATE_CIDRS: '127.0.0.1/32', ...(authenticated ? {
                    PULSE_AUTH_TOKEN_FILE: join(secrets, 'operator.key')
                } : {})
            });
            processHandle = fork(join(process.cwd(), 'apps/server/dist/main.js'), {
                execPath: process.execPath, execArgv: [], env, stdio: ['ignore', 'pipe', 'pipe', 'ipc']
            });
            exited = once(processHandle, 'exit');
            let ready = false;
            processHandle.stdout?.on('data', (data: Buffer) => {
                if (data.toString().includes('PULSE_READY'))
                    ready = true;
            });
            await expect.poll(() => ready, {
                timeout: 12000
            }).toBe(true);
        };
        const stop = async () => {
            if (processHandle && processHandle.exitCode === null && processHandle.signalCode === null)
                processHandle.send('shutdown');
            if (exited)
                await exited;
        };
        try {
            await start();
            await use({
                origin, targetUrl: 'http://127.0.0.1:' + targetPort + '/health', receipts, token, authenticated, oldIncidentMonitorId, setFailure: value => { fail = value; }, setReceiverStatus: status => { receiverStatus = status; }, restart: async () => { await stop(); await start(); }
            });
        }
        finally {
            await stop();
            for (const server of [target, receiver]) {
                server.closeAllConnections();
                await new Promise<void>(r => server.close(() => r()));
            }
            await dispose(dir);
        }
    }
});
export { expect };
