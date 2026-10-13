import { describe, it, expect } from 'vitest';
import { errorSchema, monitorPageSchema, checkPageSchema } from '@pulse/contracts';
import { instance, target, monitorResponse, executionResponse, until } from './helpers.js';
describe('real Fastify listener, destination and persisted API', () => {
    it('creates and edits with revision checks, confirmed deletion and safe error envelopes', async () => {
        const server = await target(), p = await instance({
            autoStart: false
        });
        try {
            const response = await p.request('/api/v1/monitors', 'POST', {
                name: ' API ', url: server.url, enabled: false
            });
            expect(response.status).toBe(201);
            const m = await monitorResponse(response);
            expect(m.name).toBe('API');
            expect(response.headers.get('etag')).toBe('"1"');
            expect((await p.request(`/api/v1/monitors/${m.id}`)).status).toBe(200);
            expect((await p.request(`/api/v1/monitors/${m.id}`, 'PATCH', {
                name: 'x'
            })).status).toBe(428);
            expect((await p.request(`/api/v1/monitors/${m.id}`, 'PATCH', {
                name: 'x'
            }, {
                'if-match': '"2"'
            })).status).toBe(409);
            const patch = await p.request(`/api/v1/monitors/${m.id}`, 'PATCH', {
                name: 'Renamed'
            }, {
                'if-match': '"1"'
            });
            expect(patch.status).toBe(200);
            expect((await monitorResponse(patch)).enabled).toBe(false);
            expect((await p.request(`/api/v1/monitors/${m.id}`, 'DELETE', undefined, {
                'if-match': '"2"'
            })).status).toBe(400);
            expect((await p.request(`/api/v1/monitors/${m.id}?confirm=true`, 'DELETE', undefined, {
                'if-match': '"2"'
            })).status).toBe(204);
            const missing = await p.request(`/api/v1/monitors/${m.id}`);
            expect(missing.status).toBe(404);
            expect(errorSchema.parse(await missing.json()).error.code).toBe('NOT_FOUND');
        }
        finally {
            await p.close();
            await server.close();
        }
    });
    it('executes automatic and manual checks against an actual target and polls terminal persistence', async () => {
        let contacts = 0;
        const server = await target((_req, res) => { contacts++; res.end(); }), p = await instance();
        try {
            const m = await monitorResponse(await p.request('/api/v1/monitors', 'POST', {
                name: 'Real', url: server.url
            }));
            await until(() => p.request(`/api/v1/monitors/${m.id}/checks`).then(r => r.json()).then(b => checkPageSchema.parse(b)), b => b.data.some(c => c.lifecycle === 'COMPLETED'));
            const response = await p.request(`/api/v1/monitors/${m.id}/checks`, 'POST', {});
            expect(response.status).toBe(202);
            const exec = await executionResponse(response);
            const final = await until(() => p.request(`/api/v1/executions/${exec.id}`).then(executionResponse), e => e.lifecycle === 'COMPLETED');
            expect(final.outcome).toBe('SUCCESS');
            expect(contacts).toBeGreaterThanOrEqual(2);
            const monitor = await monitorResponse(await p.request(`/api/v1/monitors/${m.id}`));
            expect(monitor.status.state).toBe('UP');
        }
        finally {
            await p.close();
            await server.close();
        }
    });
    it('validates inputs, protocol/address policy, unknown properties, media, payload and UUIDs', async () => {
        const p = await instance({
            autoStart: false
        });
        try {
            for (const body of [{
                    name: 'bad', url: 'not-url'
                }, {
                    name: 'bad', url: 'ftp://example.com'
                }, {
                    name: 'bad', url: 'http://u:secret@example.com'
                }, {
                    name: 'bad', url: 'https://example.com?q=secret'
                }, {
                    name: 'x', url: 'https://example.com', enabled: 'false'
                }, {
                    name: 'x', url: 'https://example.com', id: 'forbidden'
                }])
                expect((await p.request('/api/v1/monitors', 'POST', body)).status).toBe(400);
            expect((await p.request('/api/v1/monitors', 'POST', {
                name: 'x', url: 'http://169.254.169.254'
            })).status).toBe(422);
            expect((await p.request('/api/v1/monitors/not-a-uuid')).status).toBe(400);
            for (const q of ['?limit=101', '?limit=0', '?foo=bar', '?enabled=0', '?sort=evil', '?cursor=%%%'])
                expect((await p.request('/api/v1/monitors' + q)).status).toBe(400);
            expect((await p.request('/api/v1/monitors', 'POST', {
                x: 'x'.repeat(65536)
            })).status).toBe(413);
            const media = await fetch(p.config.publicOrigin + '/api/v1/monitors', {
                method: 'POST', headers: {
                    origin: p.config.publicOrigin, 'content-type': 'text/plain'
                }, body: 'bad'
            });
            expect(media.status).toBe(415);
        }
        finally {
            await p.close();
        }
    });
    it('bounded monitor pagination, literal wildcard search and later-stage resources', async () => {
        const p = await instance({
            autoStart: false
        });
        try {
            for (const name of ['A_100%', 'B', 'C'])
                await p.request('/api/v1/monitors', 'POST', {
                    name, url: 'https://example.com', enabled: false
                });
            const first = monitorPageSchema.parse(await (await p.request('/api/v1/monitors?limit=2')).json());
            expect(first.data).toHaveLength(2);
            const next = monitorPageSchema.parse(await (await p.request('/api/v1/monitors?limit=2&cursor=' + first.page.nextCursor)).json());
            expect(next.data).toHaveLength(1);
            expect(new Set([...first.data, ...next.data].map(m => m.id)).size).toBe(3);
            expect((await p.request('/api/v1/monitors?limit=2&enabled=false&cursor=' + first.page.nextCursor)).status).toBe(400);
            const search = monitorPageSchema.parse(await (await p.request('/api/v1/monitors?q=' + encodeURIComponent('_100%'))).json());
            expect(search.data).toHaveLength(1);
            expect((await p.request('/api/v1/incidents')).status).toBe(200);
            expect((await p.request('/api/v1/monitors?include=summary')).status).toBe(200);
            expect((await p.request('/api/v1/no-such-route')).status).toBe(404);
        }
        finally {
            await p.close();
        }
    });
    it('disabled monitors refuse checks and health/configuration expose no paths or targets', async () => {
        const p = await instance();
        try {
            const m = await monitorResponse(await p.request('/api/v1/monitors', 'POST', {
                name: 'Paused', url: 'https://example.com', enabled: false
            }));
            expect((await p.request(`/api/v1/monitors/${m.id}/checks`, 'POST', {})).status).toBe(409);
            for (const path of ['/health/live', '/health/ready', '/api/v1/configuration']) {
                const r = await p.request(path);
                expect(r.status).toBe(200);
                const text = await r.text();
                expect(text).not.toContain(p.dir);
                expect(text).not.toContain('example.com');
            }
        }
        finally {
            await p.close();
        }
    });
});
