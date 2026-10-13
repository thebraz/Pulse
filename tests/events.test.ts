import { describe, it, expect } from 'vitest';
import { instance, monitorResponse, temp, dispose } from './helpers.js';
import { randomBytes } from 'node:crypto';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
describe('actual same-origin SSE', () => {
    it('bounded streams invalidate after committed changes and enforce query, Host and Origin rules', async () => {
        const p = await instance({
            autoStart: false
        }), controllers: AbortController[] = [];
        try {
            for (let i = 0; i < 20; i++) {
                const controller = new AbortController();
                controllers.push(controller);
                const response = await fetch(p.config.publicOrigin + '/api/v1/events', {
                    signal: controller.signal
                });
                expect(response.status).toBe(200);
                expect(response.headers.get('content-type')).toBe('text/event-stream');
                if (i === 0) {
                    const reader = response.body!.getReader();
                    expect(new TextDecoder().decode((await reader.read()).value)).toContain('connected');
                    const m = await monitorResponse(await p.request('/api/v1/monitors', 'POST', {
                        name: 'FAKE_EVENT_NAME', url: 'https://example.com', enabled: false
                    }));
                    const text = new TextDecoder().decode((await reader.read()).value);
                    expect(text).toContain('event: invalidate');
                    expect(text).toContain('"resource":"monitors"');
                    expect(text).not.toContain('FAKE_EVENT_NAME');
                    expect(text).not.toContain(m.url);
                }
            }
            expect((await p.request('/api/v1/events')).status).toBe(429);
            expect((await p.request('/api/v1/events?token=FAKE_QUERY_SECRET')).status).toBe(400);
            expect((await fetch(p.config.publicOrigin + '/api/v1/events', {
                headers: {
                    origin: 'https://attacker.example'
                }
            })).status).toBe(403);
        }
        finally {
            controllers.forEach(c => c.abort());
            await p.close();
        }
    });
    it('authenticated streams require a session cookie, never query tokens or bearer alone', async () => {
        const dir = await temp(), token = randomBytes(32).toString('base64url');
        await writeFile(join(dir, 'operator.key'), token, {
            mode: 0o600
        });
        const p = await instance({
            dir, env: {
                PULSE_AUTH_TOKEN_FILE: join(dir, 'operator.key'), PULSE_SECRETS_DIR: dir
            }
        }), controller = new AbortController();
        try {
            expect((await p.request('/api/v1/events')).status).toBe(401);
            expect((await p.request('/api/v1/events', 'GET', undefined, {
                authorization: 'Bearer ' + token
            })).status).toBe(401);
            const login = await p.request('/api/v1/session', 'POST', {
                token
            }), cookie = login.headers.get('set-cookie')!.split(';')[0]!;
            const response = await fetch(p.config.publicOrigin + '/api/v1/events', {
                headers: {
                    cookie
                }, signal: controller.signal
            });
            expect(response.status).toBe(200);
            expect((await p.request('/')).status).toBe(200);
            expect((await fetch(p.config.publicOrigin + '/', {
                redirect: 'manual'
            })).status).toBe(302);
        }
        finally {
            controller.abort();
            await p.close();
            await dispose(dir);
        }
    });
});
