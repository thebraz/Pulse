import { describe, it, expect } from 'vitest';
import { writeFile, mkdir, symlink, unlink, readFile } from 'node:fs/promises';
import { createServer as createTlsServer } from 'node:https';
import { join } from 'node:path';
import { createHmac, randomBytes } from 'node:crypto';
import { destinationSchema, deliveryPageSchema, webhookPayloadSchema, monitorPageSchema } from '@pulse/contracts';
import { fixture, failure } from './reliability-helpers.js';
import { configuration, instance, target, monitorResponse, until, temp, dispose, success } from './helpers.js';
import { provisioned } from '../apps/server/src/notifications/secrets.js';
import { sendWebhook } from '../apps/server/src/notifications/transport.js';
describe('durable notification outbox', () => {
    it('restart logical time includes durable notification mutations without newer checks', async () => {
        const f = await fixture();
        try {
            const future = f.now + 60000;
            const destination = f.s.execute('destinationCreate', {
                now: future, input: {
                    name: 'Clock', urlSecretRef: 'ops', signingSecretRef: null, enabled: true
                }
            });
            f.s.execute('destinationTest', {
                now: future + 1000, id: destination.id
            });
            const initialized = f.s.execute('initialize', {
                now: f.now, runId: '3a4b182a-646f-4d70-91c5-b38b68a178ed', fingerprint: 'a'.repeat(64)
            });
            expect(initialized.seed).toBe(future + 1000);
        }
        finally {
            await f.close();
        }
    });
    it('incident changes and outbox roll back together; stable events deduplicate and preserve ordering', async () => {
        const f = await fixture();
        try {
            const d = f.s.execute('destinationCreate', {
                now: f.now, input: {
                    name: 'Ops', urlSecretRef: 'ops', signingSecretRef: null, enabled: true
                }
            }), m = f.create({
                failureThreshold: 1, recoveryThreshold: 1
            });
            f.s.db.exec("CREATE TRIGGER reject_delivery BEFORE INSERT ON notification_deliveries BEGIN SELECT RAISE(ABORT,'CONTROLLED_ROLLBACK'); END");
            expect(() => f.check(m.id, failure)).toThrow();
            expect(f.s.db.prepare('SELECT count(*) n FROM incidents').get()?.n).toBe(0);
            expect(f.s.db.prepare('SELECT count(*) n FROM notification_deliveries').get()?.n).toBe(0);
            f.s.db.exec('DROP TRIGGER reject_delivery');
            const running = f.s.db.prepare("SELECT id FROM checks WHERE lifecycle='RUNNING'").get()!;
            f.s.execute('finish', {
                id: String(running.id), now: ++f.now, observation: failure
            });
            f.check(m.id, success);
            const rows = f.s.execute('deliveries', {
                now: f.now, query: {}
            }).data;
            expect(rows).toHaveLength(2);
            const open = f.s.execute('deliveryClaim', {
                now: f.now
            })!;
            expect(open.eventType).toBe('incident.opened');
            expect(webhookPayloadSchema.parse(JSON.parse(open.payloadJson)).eventId).toBe(open.eventId);
            expect(f.s.execute('deliveryClaim', {
                now: f.now
            })).toBeNull();
            f.s.execute('deliveryFinish', {
                id: open.id, attempt: 1, now: f.now, status: 503, code: 'RECEIVER_HTTP_ERROR', retry: true, cancel: false, retryAfterMs: 0
            });
            expect(f.s.execute('deliveryClaim', {
                now: f.now + 4999
            })).toBeNull();
            const retry = f.s.execute('deliveryClaim', {
                now: f.now + 5000
            })!;
            expect(retry.payloadJson).toBe(open.payloadJson);
            expect(retry.eventId).toBe(open.eventId);
            expect(retry.attemptCount).toBe(2);
            f.s.execute('deliveryFinish', {
                id: retry.id, attempt: 2, now: f.now + 5000, status: 400, code: 'RECEIVER_HTTP_ERROR', retry: false, cancel: false, retryAfterMs: 0
            });
            expect(f.s.execute('deliveryClaim', {
                now: f.now + 5000
            })?.eventType).toBe('incident.resolved');
            expect(f.s.execute('destinationGet', {
                id: d.id
            })).not.toHaveProperty('urlSecretRef');
        }
        finally {
            await f.close();
        }
    });
    it('finite backoff, Retry-After, uncertainty budget, cancellation and retention protection survive reopen', async () => {
        const f = await fixture();
        try {
            const d = f.s.execute('destinationCreate', {
                now: f.now, input: {
                    name: 'Ops', urlSecretRef: 'ops', signingSecretRef: null, enabled: true
                }
            });
            f.s.execute('destinationTest', {
                now: f.now, id: d.id
            });
            const first = f.s.execute('deliveryClaim', {
                now: f.now
            })!;
            f.restart(f.now + 100);
            let now = f.now;
            expect(f.s.execute('deliveryClaim', {
                now
            })).toBeNull();
            now = Date.parse(first.claimedAt!) + 10000;
            let job = f.s.execute('deliveryClaim', {
                now
            })!;
            expect(job.attemptCount).toBe(2);
            expect(job.eventId).toBe(first.eventId);
            for (const delay of [10000, 20000, 40000]) {
                f.s.execute('deliveryFinish', {
                    id: job.id, attempt: job.attemptCount, now, status: 429, code: 'RECEIVER_HTTP_ERROR', retry: true, cancel: false, retryAfterMs: delay
                });
                expect(f.s.execute('deliveryClaim', {
                    now: now + delay - 1
                })).toBeNull();
                now += delay;
                job = f.s.execute('deliveryClaim', {
                    now
                })!;
            }
            expect(job.attemptCount).toBe(5);
            f.restart(now + 1);
            expect(f.s.execute('deliveries', {
                now: now + 1, query: {}
            }).data[0]).toMatchObject({
                state: 'DEAD', attemptCount: 5, lastErrorCode: 'UNCERTAIN_LAST_ATTEMPT'
            });
            const m = f.create({
                failureThreshold: 1, recoveryThreshold: 1
            });
            f.now = now + 2;
            f.check(m.id, failure);
            f.check(m.id, success);
            f.s.execute('retain', {
                now: now + 400 * 86400000, checkDays: 1, incidentDays: 30, deliveryDays: 30
            });
            expect(f.s.db.prepare('SELECT count(*) n FROM incidents').get()?.n).toBe(1);
            f.s.execute('destinationPatch', {
                id: d.id, revision: 1, now: f.now, input: {
                    enabled: false
                }
            });
            expect(f.s.execute('deliveries', {
                now: f.now, query: {
                    destinationId: d.id
                }
            }).data.every(d => d.state !== 'PENDING')).toBe(true);
            f.s.execute('retain', {
                now: now + 401 * 86400000, checkDays: 1, incidentDays: 30, deliveryDays: 30
            });
            expect(f.s.db.prepare('SELECT count(*) n FROM incidents').get()?.n).toBe(0);
        }
        finally {
            await f.close();
        }
    });
});
describe('real webhook and browser integration boundaries', () => {
    it('denies private DNS answers, rejects untrusted TLS and bounds a real stalled response', async () => {
        const policy = {
            mode: 'allow-private' as const, cidrs: ['127.0.0.1/32']
        }, signal = new AbortController().signal;
        expect(await sendWebhook({
            mode: 'public-only', cidrs: []
        }, 'https://fixture.example', null, '{}', 'event', 1, signal, async () => ['127.0.0.1'])).toMatchObject({
            code: 'TARGET_POLICY_REJECTED', retry: false
        });
        expect(await sendWebhook(policy, 'https://fixture.example', null, '{}', 'event', 1, signal, async () => { throw new Error('FAKE_DNS_SECRET'); })).toMatchObject({
            code: 'CONNECTION_FAILED', retry: true
        });
        const server = createTlsServer({
            key: await readFile(new URL('./fixtures/localhost-key.pem', import.meta.url)), cert: await readFile(new URL('./fixtures/localhost-cert.pem', import.meta.url))
        }, (_req, res) => res.end());
        await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
        try {
            const address = server.address();
            if (!address || typeof address === 'string')
                throw new Error('FIXTURE_ADDRESS');
            expect(await sendWebhook(policy, 'https://127.0.0.1:' + address.port, null, '{}', 'event', 1, signal)).toMatchObject({
                code: 'TLS_FAILED', retry: false
            });
        }
        finally {
            server.closeAllConnections();
            await new Promise<void>(resolve => server.close(() => resolve()));
        }
        const slow = await target(() => { });
        try {
            expect(await sendWebhook(policy, slow.url, null, '{}', 'event', 1, signal)).toMatchObject({
                code: 'DELIVERY_TIMEOUT', retry: true
            });
        }
        finally {
            await slow.close();
        }
    }, 10000);
    it('actual receiver sees signed immutable bytes; incident alerts and fixed test are masked and persisted', async () => {
        const dir = await temp(), secrets = join(dir, 'secrets'), key = randomBytes(32).toString('base64url'), received: {
            body: string;
            id: string;
            attempt: string;
            signature: string;
            timestamp: string;
        }[] = [];
        const receiver = await target(async (req, res) => {
            let body = '';
            for await (const chunk of req)
                body += String(chunk);
            received.push({
                body, id: String(req.headers['x-pulse-event-id']), attempt: String(req.headers['x-pulse-attempt']), signature: String(req.headers['x-pulse-signature']), timestamp: String(req.headers['x-pulse-timestamp'])
            });
            res.writeHead(204);
            res.end();
        });
        let fail = false;
        const endpoint = await target((_req, res) => { res.statusCode = fail ? 500 : 200; res.end(); });
        await mkdir(secrets);
        const canary = 'FAKE_RECEIVER_SECRET';
        await writeFile(join(secrets, 'ops.url'), receiver.url + '?key=' + canary, {
            mode: 0o600
        });
        await writeFile(join(secrets, 'ops.key'), key, {
            mode: 0o600
        });
        const p = await instance({
            dir, env: {
                PULSE_SECRETS_DIR: secrets
            }
        });
        try {
            const response = await p.request('/api/v1/notification-destinations', 'POST', {
                name: 'Ops', urlSecretRef: 'ops', signingSecretRef: 'ops'
            });
            expect(response.status).toBe(201);
            const d = destinationSchema.parse((await response.json() as {
                data: unknown;
            }).data);
            expect(JSON.stringify(d)).not.toContain('ops.url');
            expect((await p.request('/api/v1/notification-destinations/' + d.id + '/test', 'POST', {})).status).toBe(202);
            await until(() => received.length, n => n === 1);
            expect((await p.request('/api/v1/notification-destinations/' + d.id + '/test', 'POST', {})).status).toBe(429);
            const m = await monitorResponse(await p.request('/api/v1/monitors', 'POST', {
                name: 'API', url: endpoint.url, failureThreshold: 1, recoveryThreshold: 1
            }));
            await until(() => p.runtime.db.call('get', {
                id: m.id
            }), m => m.status.state === 'UP');
            fail = true;
            await p.request('/api/v1/monitors/' + m.id + '/checks', 'POST', {});
            await until(() => p.runtime.db.call('get', {
                id: m.id
            }), m => m.status.state === 'DOWN');
            await until(() => received.length, n => n === 2);
            fail = false;
            await p.request('/api/v1/monitors/' + m.id + '/checks', 'POST', {});
            await until(() => received.length, n => n === 3);
            for (const item of received) {
                expect(item.signature).toBe('v1=' + createHmac('sha256', Buffer.from(key, 'base64url')).update(item.timestamp + '.' + item.body).digest('hex'));
                expect(webhookPayloadSchema.parse(JSON.parse(item.body)).eventId).toBe(item.id);
                expect(item.attempt).toBe('1');
                expect(item.body).not.toContain(endpoint.url);
                expect(item.body).not.toContain(canary);
            }
            expect(received.map(r => JSON.parse(r.body).type)).toEqual(['notification.test', 'incident.opened', 'incident.resolved']);
            const deliveries = deliveryPageSchema.parse(await (await p.request('/api/v1/notification-deliveries')).json());
            await until(() => p.runtime.db.call('deliveryStats', {
                now: Date.now()
            }), r => r.succeeded === 3);
            expect(JSON.stringify(deliveries)).not.toContain(canary);
            const overview = monitorPageSchema.parse(await (await p.request('/api/v1/monitors?include=summary')).json());
            expect(overview.data[0]?.summary?.sampleCount).toBeGreaterThanOrEqual(3);
            const html = await p.request('/');
            expect(html.status).toBe(200);
            expect(html.headers.get('content-security-policy')).not.toContain('unsafe-inline');
            expect(await html.text()).toContain('type="module"');
        }
        finally {
            await p.close();
            await receiver.close();
            await endpoint.close();
            await dispose(dir);
        }
    });
    it.each([204, 301, 400, 408, 429, 500])('real receiver HTTP %i has the specified bounded outcome', async (status) => {
        const receiver = await target((_req, res) => {
            res.writeHead(status, {
                'retry-after': '12'
            });
            res.end('FAKE_SECRET_RESPONSE');
        });
        try {
            const result = await sendWebhook({
                mode: 'allow-private', cidrs: ['127.0.0.1/32']
            }, receiver.url, null, '{}', 'test-event', 1, new AbortController().signal);
            expect(result.status).toBe(status);
            expect(result.retry).toBe([408, 429, 500].includes(status));
            expect(result.retryAfterMs).toBe(status === 429 ? 12000 : 0);
            expect(JSON.stringify(result)).not.toContain('FAKE_SECRET_RESPONSE');
        }
        finally {
            await receiver.close();
        }
    });
    it('alias traversal, drive paths, symlink escape and insecure public HTTP fail with safe errors', async () => {
        const dir = await temp(), root = join(dir, 'secrets');
        await mkdir(root);
        await writeFile(join(dir, 'outside.url'), 'https://example.com/FAKE_SECRET', {
            mode: 0o600
        });
        const config = await configuration(dir, {
            PULSE_SECRETS_DIR: root
        });
        try {
            for (const alias of ['../outside', 'C:\\outside', '\\\\host\\share', 'a/b'])
                await expect(provisioned(config, alias, 'url')).rejects.toThrow('DESTINATION_SECRET_INVALID');
            await symlink(join(dir, 'outside.url'), join(root, 'escape.url'));
            await expect(provisioned(config, 'escape', 'url')).rejects.toThrow('DESTINATION_SECRET_INVALID');
            await writeFile(join(root, 'public.url'), 'http://example.com', {
                mode: 0o600
            });
            await expect(provisioned(config, 'public', 'url')).rejects.toThrow('DESTINATION_SECRET_INVALID');
            await unlink(join(root, 'escape.url'));
        }
        finally {
            await dispose(dir);
        }
    });
    it('slow delivery cancellation does not starve real monitoring', async () => {
        const dir = await temp(), root = join(dir, 'secrets');
        await mkdir(root);
        let contacted = 0;
        const slow = await target(() => { contacted++; }), endpoint = await target();
        await writeFile(join(root, 'slow.url'), slow.url, {
            mode: 0o600
        });
        const p = await instance({
            dir, env: {
                PULSE_SECRETS_DIR: root, PULSE_WEBHOOK_CONCURRENCY: '1'
            }
        });
        try {
            const d = destinationSchema.parse((await (await p.request('/api/v1/notification-destinations', 'POST', {
                name: 'Slow', urlSecretRef: 'slow'
            })).json() as {
                data: unknown;
            }).data);
            await p.request('/api/v1/notification-destinations/' + d.id + '/test', 'POST', {});
            await until(() => contacted, n => n === 1);
            const m = await monitorResponse(await p.request('/api/v1/monitors', 'POST', {
                name: 'Probe', url: endpoint.url
            }));
            await until(() => p.runtime.db.call('get', {
                id: m.id
            }), m => m.status.state === 'UP');
            expect((await p.request('/api/v1/notification-destinations/' + d.id, 'PATCH', {
                enabled: false
            }, {
                'if-match': '"1"'
            })).status).toBe(200);
            await until(() => p.runtime.db.call('deliveries', {
                now: Date.now(), query: {}
            }), r => r.data[0]?.state === 'CANCELLED');
            expect(p.runtime.isReady()).toBe(true);
        }
        finally {
            await p.close();
            await slow.close();
            await endpoint.close();
            await dispose(dir);
        }
    });
});
