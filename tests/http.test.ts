import { describe, it, expect } from 'vitest';
import { createServer as createTlsServer } from 'node:https';
import { readFile } from 'node:fs/promises';
import { createExecutor } from '../apps/server/src/monitoring/http.js';
import { input, target, freePort, listen } from './helpers.js';
const policy = {
    mode: 'allow-private', cidrs: ['127.0.0.1/32']
} as const;
const executor = () => createExecutor({
    ...policy, cidrs: [...policy.cidrs]
});
describe('actual HTTP socket observations', () => {
    it('GET and HEAD contact real target with fixed headers and ignore slow infinite bodies', async () => {
        const methods: string[] = [], hosts: string[] = [], server = await target((req, res) => { methods.push(req.method!); hosts.push(req.headers.host!); expect(req.headers.authorization).toBeUndefined(); res.writeHead(200); res.flushHeaders(); });
        try {
            for (const method of ['GET', 'HEAD'] as const) {
                const result = await executor()({
                    ...input(server.url), method
                }, new AbortController().signal);
                expect(result?.outcome).toBe('SUCCESS');
                expect(result?.httpStatus).toBe(200);
                expect(result?.durationMs).toBeLessThan(900);
            }
            expect(methods).toEqual(['GET', 'HEAD']);
            expect(hosts).toEqual([`127.0.0.1:${server.port}`, `127.0.0.1:${server.port}`]);
        }
        finally {
            await server.close();
        }
    });
    it('classifies 500 without throwing', async () => {
        const s = await target((_req, res) => { res.statusCode = 500; res.end('secret body'); });
        try {
            const result = await executor()(input(s.url), new AbortController().signal);
            expect(result).toMatchObject({
                outcome: 'HTTP_ERROR', httpStatus: 500, errorCode: 'UNEXPECTED_STATUS'
            });
            expect(JSON.stringify(result)).not.toContain('secret body');
        }
        finally {
            await s.close();
        }
    });
    it('enforces absolute timeout and closes stalled socket', async () => {
        let closed = false;
        const s = await target(req => { req.socket.on('close', () => { closed = true; }); });
        try {
            const result = await executor()(input(s.url), new AbortController().signal);
            expect(result?.outcome).toBe('TIMEOUT');
            expect(result!.durationMs).toBeGreaterThanOrEqual(990);
            await new Promise<void>(resolve => {
                if (closed)
                    return resolve();
                s.server.closeAllConnections();
                setTimeout(resolve, 20);
            });
            expect(closed).toBe(true);
        }
        finally {
            await s.close();
        }
    });
    it('classifies connection refusal and reset without raw error content', async () => {
        const port = await freePort();
        expect(await executor()(input(`http://127.0.0.1:${port}`), new AbortController().signal)).toMatchObject({
            outcome: 'CONNECTION_ERROR', httpStatus: null, errorCode: 'CONNECTION_FAILED'
        });
        const s = await target(req => req.socket.destroy());
        try {
            expect((await executor()(input(s.url), new AbortController().signal))?.outcome).toBe('CONNECTION_ERROR');
        }
        finally {
            await s.close();
        }
    });
    it('DNS errors are distinct and unexpected resolver exceptions are sanitized', async () => {
        const run = createExecutor({
            mode: 'public-only', cidrs: []
        }, async () => { throw new Error('CANARY_RAW_DNS_EXCEPTION'); });
        const result = await run(input(), new AbortController().signal);
        expect(result?.outcome).toBe('DNS_ERROR');
        expect(JSON.stringify(result)).not.toContain('CANARY_RAW');
    });
    it('pins actual address while retaining original Host and never resolves twice', async () => {
        let calls = 0, host = '';
        const s = await target((req, res) => { host = req.headers.host!; res.end('ok'); });
        try {
            const run = createExecutor({
                ...policy, cidrs: [...policy.cidrs]
            }, async () => { calls++; return calls === 1 ? ['127.0.0.1'] : ['169.254.169.254']; });
            const result = await run(input(`http://fixture.example:${s.port}/health`), new AbortController().signal);
            expect(result?.outcome).toBe('SUCCESS');
            expect(calls).toBe(1);
            expect(host).toBe(`fixture.example:${s.port}`);
        }
        finally {
            await s.close();
        }
    });
    it('rejects a mixed DNS answer set before any actual contact', async () => {
        let contacts = 0;
        const s = await target((_req, res) => { contacts++; res.end(); });
        try {
            const run = createExecutor({
                ...policy, cidrs: [...policy.cidrs]
            }, async () => ['127.0.0.1', '169.254.169.254']);
            expect((await run(input(`http://fixture.example:${s.port}`), new AbortController().signal))?.outcome).toBe('POLICY_BLOCKED');
            expect(contacts).toBe(0);
        }
        finally {
            await s.close();
        }
    });
    it('revalidates redirects, denies metadata before connecting and bounds loops', async () => {
        let contacts = 0;
        const s = await target((req, res) => { contacts++; res.statusCode = 302; res.setHeader('Location', req.url === '/deny' ? 'http://169.254.169.254/latest/meta-data' : req.url === '/missing' ? '' : req.url === '/a' ? '/b' : '/a'); res.end(); });
        try {
            const run = executor();
            expect((await run({
                ...input(`http://127.0.0.1:${s.port}/deny`), followRedirects: true
            }, new AbortController().signal))?.outcome).toBe('POLICY_BLOCKED');
            expect(contacts).toBe(1);
            expect((await run({
                ...input(`http://127.0.0.1:${s.port}/a`), followRedirects: true
            }, new AbortController().signal))?.errorCode).toBe('REDIRECT_LOOP');
            expect((await run({
                ...input(`http://127.0.0.1:${s.port}/missing`), followRedirects: true
            }, new AbortController().signal))?.outcome).toBe('REDIRECT_ERROR');
            expect((await run({
                ...input(s.url), expectedStatusCodes: [302]
            }, new AbortController().signal))?.outcome).toBe('SUCCESS');
        }
        finally {
            await s.close();
        }
    });
    it('administrative cancellation has no fabricated observation', async () => {
        const controller = new AbortController(), s = await target(() => controller.abort());
        try {
            expect(await executor()(input(s.url), controller.signal)).toBeNull();
        }
        finally {
            await s.close();
        }
    });
    it('bounds DNS under the total deadline and blocks late socket creation', async () => {
        let resolve!: (v: string[]) => void, contacts = 0;
        const s = await target((_req, res) => { contacts++; res.end(); });
        try {
            const run = createExecutor({
                ...policy, cidrs: [...policy.cidrs]
            }, () => new Promise(r => { resolve = r; }));
            const result = await run(input(`http://fixture.example:${s.port}`), new AbortController().signal);
            expect(result?.outcome).toBe('TIMEOUT');
            resolve(['127.0.0.1']);
            await Promise.resolve();
            expect(contacts).toBe(0);
        }
        finally {
            await s.close();
        }
    });
    it('rejects an untrusted TLS certificate with TLS_ERROR', async () => {
        const key = await readFile(new URL('./fixtures/localhost-key.pem', import.meta.url)), cert = await readFile(new URL('./fixtures/localhost-cert.pem', import.meta.url));
        const server = createTlsServer({
            key, cert
        }, (_req, res) => res.end('ok'));
        const port = await listen(server);
        try {
            const result = await executor()(input(`https://127.0.0.1:${port}`), new AbortController().signal);
            expect(result?.outcome).toBe('TLS_ERROR');
        }
        finally {
            server.closeAllConnections();
            await new Promise<void>(r => server.close(() => r()));
        }
    });
});
