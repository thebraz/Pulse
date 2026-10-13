import { createServer, request as nativeRequest, type Server, type RequestListener } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve, dirname, basename } from 'node:path';
import { monitorSchema, executionSchema, type MonitorInput } from '@pulse/contracts';
import { loadConfig, type Config } from '../apps/server/src/config/config.js';
import { createRuntime } from '../apps/server/src/runtime/runtime.js';
import { acquireLock } from '../apps/server/src/runtime/lock.js';
import type { Executor } from '../apps/server/src/monitoring/http.js';
export async function until<T>(fn: () => T | Promise<T>, test: (value: T) => boolean, timeout = 6000): Promise<T> {
    const deadline = Date.now() + timeout;
    while (true) {
        const value = await fn();
        if (test(value))
            return value;
        if (Date.now() > deadline)
            throw new Error('CONDITION_DEADLINE');
        await new Promise(r => setTimeout(r, 10));
    }
}
export async function temp() {
    for (let attempt = 0; ; attempt++) {
        const directory = await mkdtemp(join(tmpdir(), 'pulse-test-'));
        try {
            // Select a new fixture with an available lock port before any data is written.
            const lock = await acquireLock(directory); await lock.release(); return directory;
        } catch (error) {
            await dispose(directory);
            if (attempt >= 7 || !(error instanceof Error) || error.message !== 'DATA_DIRECTORY_LOCKED') throw error;
        }
    }
}
export async function dispose(path: string) {
    const absolute = resolve(path);
    if (dirname(absolute).toLowerCase() !== resolve(tmpdir()).toLowerCase() || !basename(absolute).startsWith('pulse-test-'))
        throw new Error('UNSAFE_FIXTURE_CLEANUP');
    await rm(absolute, {
        recursive: true, force: true
    });
}
export async function listen(server: Server) {
    await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
    const addr = server.address();
    if (typeof addr !== 'object' || !addr)
        throw new Error('NO_ADDRESS');
    return addr.port;
}
export async function target(handler: RequestListener = (_req, res) => res.end('ok')) {
    const server = createServer(handler), port = await listen(server);
    return {
        server, port, url: `http://127.0.0.1:${port}/health`, close: async () => { server.closeAllConnections(); await new Promise<void>(r => server.close(() => r())); }
    };
}
export async function freePort() { const server = createServer(), port = await listen(server); await new Promise<void>(r => server.close(() => r())); return port; }
export async function configuration(dir: string, extra: NodeJS.ProcessEnv = {}): Promise<Config> {
    const port = await freePort();
    return loadConfig({
        PULSE_PORT: String(port), PULSE_PUBLIC_ORIGIN: `http://127.0.0.1:${port}`, PULSE_DATA_DIR: dir, PULSE_EGRESS_POLICY: 'allow-private', PULSE_ALLOWED_PRIVATE_CIDRS: '127.0.0.1/32', ...extra
    });
}
export async function instance(options: {
    dir?: string;
    executor?: Executor;
    rawClock?: () => number;
    autoStart?: boolean;
    env?: NodeJS.ProcessEnv;
} = {}) {
    let dir = options.dir ?? await temp(), config = await configuration(dir, options.env);
    let runtime: Awaited<ReturnType<typeof createRuntime>>;
    for (let attempt = 0; ; attempt++) {
        try { runtime = await createRuntime(config, options); break; }
        catch (error) {
            // Unrelated listeners can occupy a new disposable fixture's hashed lock port.
            // Explicit restart/lock fixtures retain their exact directory and failure behavior.
            if (options.dir || attempt >= 7 || !(error instanceof Error) || error.message !== 'DATA_DIRECTORY_LOCKED') throw error;
            await dispose(dir);
            dir = await temp(); config = await configuration(dir, options.env);
        }
    }
    try { await runtime.listen(); }
    catch (error) { await runtime.close(); if (!options.dir) await dispose(dir); throw error; }
    const request = (path: string, method = 'GET', body?: unknown, headers: Record<string, string> = {}) => fetch(config.publicOrigin + path, {
        method, headers: {
            origin: config.publicOrigin, ...(body === undefined ? {} : {
                'content-type': 'application/json'
            }), ...headers
        }, ...(body === undefined ? {} : {
            body: JSON.stringify(body)
        })
    });
    return {
        dir, config, runtime, request, close: async () => {
            try {
                await runtime.close();
            }
            finally {
                if (!options.dir)
                    await dispose(dir);
            }
        }
    };
}
export async function monitorResponse(response: Response) {
    const body = await response.json() as {
        data: unknown;
    };
    return monitorSchema.parse(body.data);
}
export async function executionResponse(response: Response) {
    const body = await response.json() as {
        data: unknown;
    };
    return executionSchema.parse(body.data);
}
export function input(url = 'https://example.com/health'): MonitorInput {
    return {
        name: 'Fixture', url, method: 'GET', expectedStatusCodes: [200], intervalMs: 15000, timeoutMs: 1000, followRedirects: false, enabled: true, failureThreshold: 3, recoveryThreshold: 2, latencyThresholdMs: 1000, degradationThreshold: 3
    };
}
export const success = {
    outcome: 'SUCCESS', httpStatus: 200, durationMs: 1, redirectCount: 0, errorCode: null
} as const;
export function deferred<T>() {
    let resolve!: (value: T) => void;
    const promise = new Promise<T>(r => { resolve = r; });
    return {
        promise, resolve
    };
}
export function rawApi(url: string, method: string, headers: Record<string, string>, body?: unknown): Promise<{
    status: number;
    headers: import('node:http').IncomingHttpHeaders;
    body: string;
}> {
    return new Promise((resolve, reject) => {
        const payload = body === undefined ? undefined : JSON.stringify(body);
        nativeRequest(url, {
            method, headers: {
                ...headers, ...(payload ? {
                    'content-type': 'application/json', 'content-length': String(Buffer.byteLength(payload))
                } : {})
            }
        }, res => {
            let text = '';
            res.setEncoding('utf8');
            res.on('data', (chunk: string) => { text += chunk; });
            res.on('end', () => resolve({
                status: res.statusCode!, headers: res.headers, body: text
            }));
        }).on('error', reject).end(payload);
    });
}
export async function rawGet(url: string, headers: Record<string, string>): Promise<number> { return (await rawApi(url, 'GET', headers)).status; }
