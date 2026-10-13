import { it, expect } from 'vitest';
import { createServer, request as secureRequest } from 'node:https';
import { request as backendRequest, type IncomingHttpHeaders, type IncomingMessage } from 'node:http';
import { randomBytes } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { instance, temp, dispose, listen, rawApi, until } from './helpers.js';

it('enforces authentication, Host, Origin and CSRF through a real verified HTTPS proxy', async () => {
    const dir = await temp(), secrets = join(dir, 'secrets');
    await mkdir(secrets);
    const token = randomBytes(32).toString('base64url');
    await writeFile(join(secrets, 'operator.key'), token, { mode: 0o600 });
    const key = await readFile(new URL('./fixtures/localhost-key.pem', import.meta.url));
    const cert = await readFile(new URL('./fixtures/localhost-cert.pem', import.meta.url));
    let backendPort = 0;
    const proxy = createServer({ key, cert }, (req, res) => {
        const upstream = backendRequest({ host: '127.0.0.1', port: backendPort, path: req.url, method: req.method, headers: { ...req.headers, 'x-forwarded-proto': 'https', 'x-forwarded-for': '127.0.0.1' } }, response => {
            res.writeHead(response.statusCode!, response.headers); response.pipe(res);
        });
        upstream.on('error', () => { res.writeHead(502); res.end(); });
        req.pipe(upstream);
    });
    const port = await listen(proxy), origin = `https://fixture.example:${port}`;
    const p = await instance({ dir, autoStart: false, env: { PULSE_EXPOSURE: 'remote', PULSE_PUBLIC_ORIGIN: origin, PULSE_SECRETS_DIR: secrets, PULSE_AUTH_TOKEN_FILE: join(secrets, 'operator.key'), PULSE_TRUSTED_PROXY_CIDRS: '127.0.0.1/32' } });
    backendPort = p.config.port;
    const request = (path: string, method = 'GET', headers: Record<string, string> = {}, body?: unknown) => new Promise<{ status: number; headers: IncomingHttpHeaders; body: string }>((resolve, reject) => {
        const payload = body === undefined ? undefined : JSON.stringify(body);
        secureRequest({ hostname: '127.0.0.1', port, servername: 'fixture.example', ca: cert, path, method, headers: { host: `fixture.example:${port}`, origin, ...(payload ? { 'content-type': 'application/json', 'content-length': String(Buffer.byteLength(payload)) } : {}), ...headers } }, response => {
            let text = ''; response.setEncoding('utf8'); response.on('data', chunk => { text += chunk; });
            response.on('end', () => resolve({ status: response.statusCode!, headers: response.headers, body: text }));
        }).on('error', reject).end(payload);
    });
    try {
        expect((await request('/api/v1/monitors')).status).toBe(401);
        expect((await rawApi(`http://127.0.0.1:${backendPort}/api/v1/monitors`, 'GET', { host: `fixture.example:${port}` })).status).toBe(401);
        expect((await request('/health/live', 'GET', { host: 'attacker.example' })).status).toBe(403);
        expect((await request('/health/live', 'GET', { origin: 'https://attacker.example' })).status).toBe(403);
        const login = await request('/api/v1/session', 'POST', {}, { token });
        expect(login.status).toBe(200);
        expect(login.headers['set-cookie']?.[0]).toContain('; Secure');
        const cookie = login.headers['set-cookie']![0]!.split(';')[0]!, csrf = (JSON.parse(login.body) as { data: { csrfToken: string } }).data.csrfToken;
        expect((await request('/api/v1/monitors', 'GET', { cookie })).status).toBe(200);
        expect((await request('/api/v1/events', 'GET', { authorization: 'Bearer ' + token })).status).toBe(401);
        expect((await request('/api/v1/events?token=FAKE_QUERY_SECRET', 'GET', { cookie })).status).toBe(400);
        let stream: IncomingMessage | undefined, events = '';
        const connectedAt = performance.now();
        await new Promise<void>((resolve, reject) => {
            const streamRequest = secureRequest({ hostname: '127.0.0.1', port, servername: 'fixture.example', ca: cert, path: '/api/v1/events', headers: { host: `fixture.example:${port}`, origin, cookie } }, response => {
                stream = response;
                try {
                    expect(response.statusCode).toBe(200);
                    expect(response.headers['content-type']).toBe('text/event-stream');
                    expect(response.headers['x-accel-buffering']).toBe('no');
                    response.setEncoding('utf8');
                    response.on('data', (chunk: string) => { events += chunk; if (events.includes(': connected\n\n')) { clearTimeout(connectionDeadline); resolve(); } });
                    response.on('error', reject);
                } catch (error) { clearTimeout(connectionDeadline); reject(error); }
            });
            const connectionDeadline = setTimeout(() => streamRequest.destroy(new Error('PROXY_STREAM_BUFFERED')), 3000);
            streamRequest.setTimeout(30000, () => streamRequest.destroy(new Error('PROXY_STREAM_IDLE_DEADLINE')));
            streamRequest.on('error', reject).end();
        });
        expect(performance.now() - connectedAt).toBeLessThan(3000);
        const monitor = { name: 'Proxy fixture', url: 'https://example.com', enabled: false };
        expect((await request('/api/v1/monitors', 'POST', { cookie }, monitor)).status).toBe(403);
        try {
            await until(() => events, text => text.includes(': heartbeat\n\n'), 18000);
            expect(stream?.destroyed).toBe(false);
            expect((await request('/api/v1/monitors', 'POST', { cookie, 'x-pulse-csrf': csrf }, monitor)).status).toBe(201);
            await until(() => events, text => text.includes('event: invalidate\n') && text.includes('"resource":"monitors"'), 3000);
            expect(events).not.toContain(monitor.name);
            expect(events).not.toContain(monitor.url);
            expect(events).not.toContain(token);
        } finally { stream?.destroy(); }
        const page = await request('/monitors/proxy-fixture', 'GET', { cookie });
        expect(page.status).toBe(200);
        expect(page.headers['content-security-policy']).toContain("default-src 'none'");
    } finally {
        await p.close(); proxy.closeAllConnections(); await new Promise<void>(resolve => proxy.close(() => resolve())); await dispose(dir);
    }
// Includes the real 15s heartbeat; its independent 18s arrival assertion remains unchanged.
}, 35000);
