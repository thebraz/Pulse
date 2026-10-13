import { it, expect } from 'vitest';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { instance, target, monitorResponse, input, until, temp, dispose } from './helpers.js';

for (const field of ['asOf', 'from', 'to']) it(`rejects an unrepresentable cursor ${field} without faulting persistence`, async () => {
    const p = await instance({ autoStart: false });
    try {
        for (const name of ['A', 'B']) await p.request('/api/v1/monitors', 'POST', { ...input(), name, enabled: false });
        const first = await (await p.request('/api/v1/monitors?limit=1')).json() as { page: { nextCursor: string } };
        const cursor = JSON.parse(Buffer.from(first.page.nextCursor, 'base64url').toString()) as Record<string, unknown>;
        cursor[field] = 8700000000000000;
        // A cross-origin subresource GET can omit Origin in default local mode.
        const response = await fetch(p.config.publicOrigin + '/api/v1/monitors?limit=1&cursor=' + Buffer.from(JSON.stringify(cursor)).toString('base64url'));
        expect(response.status).toBe(400);
        expect((await p.request('/health/ready')).status).toBe(200);
        expect((await p.request('/api/v1/monitors', 'POST', { ...input(), enabled: false })).status).toBe(201);
    } finally { await p.close(); }
});

it.each(['checks', 'incidents', 'transitions'])('rejects forged %s cursor dates before database work', async kind => {
    const p = await instance({ autoStart: false });
    try {
        const m = await monitorResponse(await p.request('/api/v1/monitors', 'POST', { ...input(), enabled: false }));
        const filter = kind === 'checks' ? JSON.stringify({ id: m.id, from: '', to: '', outcome: '', sort: '-sequence' }) : kind === 'transitions' ? JSON.stringify({ id: m.id }) : '{}';
        const path = kind === 'incidents' ? '/api/v1/incidents' : `/api/v1/monitors/${m.id}/${kind}`;
        const now = Date.now();
        for (const change of [{ asOf: 8700000000000000 }, { asOf: now + 86400000 }, { from: now - 91 * 86400000 }, { from: now + 1 }, { to: now + 1 }]) {
            const cursor = { version: 1, kind, filter, asOf: now, high: 0, key: 0, id: '', from: now - 1000, to: now, ...change };
            expect((await p.request(path + '?cursor=' + Buffer.from(JSON.stringify(cursor)).toString('base64url'))).status).toBe(400);
        }
        expect((await p.request('/health/ready')).status).toBe(200);
        expect((await p.request('/api/v1/monitors', 'POST', { ...input(), enabled: false })).status).toBe(201);
    } finally { await p.close(); }
});

it.each([700, 999])('isolates peer HTTP %i and continues unrelated monitoring', async status => {
    const bad = await target((_req, res) => { res.statusCode = status; res.end(); });
    const good = await target();
    const p = await instance({ autoStart: false });
    try {
        const a = await monitorResponse(await p.request('/api/v1/monitors', 'POST', input(bad.url)));
        const b = await monitorResponse(await p.request('/api/v1/monitors', 'POST', input(good.url)));
        p.runtime.scheduler.start();
        const history = await until(() => p.runtime.db.call('history', { id: a.id, now: p.runtime.clock.now(), query: {} }), h => h.data.some(c => c.lifecycle === 'COMPLETED'));
        expect(history.data[0]).toMatchObject({ outcome: 'HTTP_ERROR', httpStatus: null, errorCode: 'INVALID_HTTP_STATUS' });
        await until(() => p.runtime.db.call('get', { id: b.id }), m => m.lastObservedOutcome === 'SUCCESS');
        expect((await p.request('/health/ready')).status).toBe(200);
    } finally { await p.close(); await bad.close(); await good.close(); }
});

it('isolates an unsupported receiver status and delivers another destination', async () => {
    const bad = await target((_req, res) => { res.statusCode = 700; res.end(); });
    const good = await target((_req, res) => { res.statusCode = 204; res.end(); });
    const dir = await temp(), secrets = join(dir, 'secrets');
    await mkdir(secrets);
    for (const [name, url] of [['bad', bad.url], ['good', good.url]]) await writeFile(join(secrets, name + '.url'), url!, { mode: 0o600 });
    const p = await instance({ dir, env: { PULSE_SECRETS_DIR: secrets } });
    try {
        const ids: string[] = [];
        for (const name of ['bad', 'good']) {
            const response = await p.request('/api/v1/notification-destinations', 'POST', { name, urlSecretRef: name });
            expect(response.status).toBe(201);
            const { data } = await response.json() as { data: { id: string } }; ids.push(data.id);
            expect((await p.request(`/api/v1/notification-destinations/${data.id}/test`, 'POST', {})).status).toBe(202);
        }
        const deliveries = await until(() => p.runtime.db.call('deliveries', { now: p.runtime.clock.now(), query: {} }), page => page.data.some(d => d.destinationId === ids[1] && d.state === 'SUCCEEDED') && page.data.some(d => d.destinationId === ids[0] && d.attemptCount >= 1));
        expect(deliveries.data.find(d => d.destinationId === ids[0])).toMatchObject({ state: 'PENDING', lastHttpStatus: null, lastErrorCode: 'INVALID_HTTP_STATUS' });
        expect(p.runtime.deliveries.fault).toBeNull();
        expect((await p.request('/health/ready')).status).toBe(200);
    } finally { await p.close(); await dispose(dir); await bad.close(); await good.close(); }
});
