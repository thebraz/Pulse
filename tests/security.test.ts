import { describe, it, expect, vi } from 'vitest';
import { randomBytes } from 'node:crypto';
import { writeFile, mkdir, readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import type { Worker } from 'node:worker_threads';
import { sessionViewSchema } from '@pulse/contracts';
import { instance, temp, dispose, until, rawGet, rawApi } from './helpers.js';
async function authenticated(remote = false) {
    const dir = await temp(), secrets = join(dir, 'secrets');
    await mkdir(secrets);
    const token = randomBytes(32).toString('base64url');
    await writeFile(join(secrets, 'operator.key'), token, {
        mode: 0o600
    });
    const p = await instance({
        dir, autoStart: false, env: {
            PULSE_SECRETS_DIR: secrets, PULSE_AUTH_TOKEN_FILE: join(secrets, 'operator.key'), ...(remote ? {
                PULSE_EXPOSURE: 'remote', PULSE_PUBLIC_ORIGIN: 'https://pulse.example'
            } : {})
        }
    });
    return {
        ...p, token, dispose: async () => { await p.close(); await dispose(dir); }
    };
}
describe('API trust boundaries, secret handling and readiness', () => {
    it('sessions expire after eight hours without a sliding extension', async () => {
        const p = await authenticated();
        try {
            const login = await p.request('/api/v1/session', 'POST', {
                token: p.token
            });
            const cookie = login.headers.get('set-cookie')!.split(';')[0]!;
            const view = sessionViewSchema.parse((await login.json() as {
                data: unknown;
            }).data);
            vi.useFakeTimers({
                toFake: ['Date']
            });
            vi.setSystemTime(Date.parse(view.expiresAt!) + 1);
            expect((await p.request('/api/v1/monitors', 'GET', undefined, {
                cookie
            })).status).toBe(401);
        }
        finally {
            vi.useRealTimers();
            await p.dispose();
        }
    });
    it('remote declared HTTPS mode requires auth and issues Secure session cookies through the actual listener', async () => {
        const p = await authenticated(true);
        try {
            const origin = `http://127.0.0.1:${p.config.port}`, headers = {
                host: 'pulse.example', origin: 'https://pulse.example'
            };
            expect((await rawApi(origin + '/api/v1/monitors', 'GET', headers)).status).toBe(401);
            const login = await rawApi(origin + '/api/v1/session', 'POST', headers, {
                token: p.token
            });
            expect(login.status).toBe(200);
            expect(login.headers['set-cookie']?.[0]).toContain('; Secure');
            expect((await rawApi(origin + '/api/v1/monitors', 'GET', {
                ...headers, authorization: 'Bearer ' + p.token
            })).status).toBe(200);
        }
        finally {
            await p.dispose();
        }
    });
    it('Host/Origin and JSON checks protect local unauthenticated mode', async () => {
        const p = await instance({
            autoStart: false
        });
        try {
            const url = p.config.publicOrigin;
            expect(await rawGet(url + '/health/live', {
                host: 'attacker.example'
            })).toBe(403);
            expect((await fetch(url + '/health/live', {
                headers: {
                    origin: 'https://attacker.example'
                }
            })).status).toBe(403);
            expect((await fetch(url + '/api/v1/monitors', {
                method: 'POST', headers: {
                    'content-type': 'application/json'
                }, body: '{}'
            })).status).toBe(403);
            expect((await p.request('/api/v1/monitors', 'POST', {}, {
                origin: 'null'
            })).status).toBe(403);
            const r = await p.request('/health/live');
            expect(r.headers.get('x-request-id')).toMatch(/^[a-f0-9-]{36}$/);
            expect(r.headers.get('access-control-allow-origin')).toBeNull();
            expect(r.headers.get('content-security-policy')).toContain("default-src 'none'");
        }
        finally {
            await p.close();
        }
    });
    it('bearer auth, login cookie, CSRF and logout enforce separate authority', async () => {
        const p = await authenticated();
        try {
            expect((await p.request('/api/v1/monitors')).status).toBe(401);
            expect((await p.request('/api/v1/monitors', 'GET', undefined, {
                authorization: 'Bearer wrong'
            })).status).toBe(401);
            expect((await fetch(p.config.publicOrigin + '/api/v1/monitors', {
                headers: {
                    authorization: 'Bearer ' + p.token
                }
            })).status).toBe(200);
            const login = await p.request('/api/v1/session', 'POST', {
                token: p.token
            });
            expect(login.status).toBe(200);
            const cookie = login.headers.get('set-cookie')!.split(';')[0]!;
            expect(login.headers.get('set-cookie')).toContain('HttpOnly');
            expect(login.headers.get('set-cookie')).toContain('SameSite=Strict');
            const view = sessionViewSchema.parse((await login.json() as {
                data: unknown;
            }).data);
            expect(view.csrfToken).not.toBeNull();
            expect((await p.request('/api/v1/monitors', 'POST', {
                name: 'A', url: 'https://example.com', enabled: false
            }, {
                cookie
            })).status).toBe(403);
            expect((await p.request('/api/v1/monitors', 'POST', {
                name: 'A', url: 'https://example.com', enabled: false
            }, {
                cookie, 'x-pulse-csrf': view.csrfToken!
            })).status).toBe(201);
            expect((await p.request('/api/v1/session', 'DELETE', undefined, {
                cookie, 'x-pulse-csrf': view.csrfToken!
            })).status).toBe(204);
            expect((await p.request('/api/v1/monitors', 'GET', undefined, {
                cookie
            })).status).toBe(401);
        }
        finally {
            await p.dispose();
        }
    });
    it('supplied hostile Origin cannot be bypassed by bearer or forwarded headers', async () => {
        const p = await authenticated();
        try {
            const r = await p.request('/api/v1/monitors', 'GET', undefined, {
                authorization: 'Bearer ' + p.token, origin: 'https://evil.example', 'x-forwarded-host': new URL(p.config.publicOrigin).host, 'x-forwarded-proto': 'https', 'x-forwarded-for': '127.0.0.1'
            });
            expect(r.status).toBe(403);
            const fake = await rawGet(p.config.publicOrigin + '/health/live', {
                host: 'evil.example', 'x-forwarded-host': new URL(p.config.publicOrigin).host
            });
            expect(fake).toBe(403);
        }
        finally {
            await p.dispose();
        }
    });
    it('bounds login attempts with Retry-After and does not echo fake token canaries', async () => {
        const p = await authenticated();
        try {
            const canary = randomBytes(32).toString('base64url');
            for (let i = 0; i < 5; i++) {
                const r = await p.request('/api/v1/session', 'POST', {
                    token: canary
                });
                expect(r.status).toBe(401);
                expect(await r.text()).not.toContain(canary);
            }
            const limited = await p.request('/api/v1/session', 'POST', {
                token: canary
            });
            expect(limited.status).toBe(429);
            expect(limited.headers.get('retry-after')).toBe('1');
            const config = await p.request('/api/v1/configuration', 'GET', undefined, {
                authorization: 'Bearer ' + p.token
            });
            const text = await config.text();
            expect(text).not.toContain(p.token);
            expect(text).not.toContain(p.dir);
            async function scan(dir: string): Promise<void> {
                for (const e of await readdir(dir, {
                    withFileTypes: true
                })) {
                    const path = join(dir, e.name);
                    if (e.isDirectory())
                        await scan(path);
                    else
                        expect(await readFile(path, 'utf8')).not.toContain(p.token);
                }
            }
            await scan('apps/server/dist');
            await scan('packages/contracts/dist');
        }
        finally {
            await p.dispose();
        }
    });
    it('real database worker death fails readiness and prevents new mutations', async () => {
        const p = await instance();
        try {
            await (p.runtime.db as unknown as {
                worker: Worker;
            }).worker.terminate();
            await until(() => p.runtime.db.fault, Boolean);
            expect((await p.request('/health/live')).status).toBe(200);
            const r = await p.request('/health/ready');
            expect(r.status).toBe(503);
            expect(await r.text()).toContain('DATABASE_UNAVAILABLE');
            expect((await p.request('/api/v1/monitors', 'POST', {
                name: 'A', url: 'https://example.com'
            })).status).toBe(503);
        }
        finally {
            await p.close().catch(() => { });
        }
    });
});
