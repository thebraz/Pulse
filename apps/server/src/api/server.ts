import Fastify from 'fastify';
import { z } from 'zod';
import { idSchema, monitorCreateSchema, monitorPatchSchema, monitorQuerySchema, historyQuerySchema, executionSchema, emptySchema, metricsQuerySchema, incidentQuerySchema, transitionQuerySchema, engineSchema } from '@pulse/contracts';
import type { Config } from '../config/config.js';
import type { Database } from '../persistence/database.js';
import type { Scheduler } from '../scheduler/scheduler.js';
import type { LogicalClock } from '../scheduler/clock.js';
import { Monitors } from '../application/monitors.js';
import { AppError, safeLog } from '../application/errors.js';
import { inCidrs } from '../monitoring/policy.js';
import { Security } from './security.js';
import { destinationCreateSchema, destinationPatchSchema, destinationQuerySchema, deliveryQuerySchema } from '@pulse/contracts';
import { installEvents } from './events.js';
import { installAssets } from './assets.js';
import { provisioned } from '../notifications/secrets.js';
import type { Deliveries } from '../notifications/worker.js';
function decode<T>(schema: z.ZodType<T>, value: unknown): T {
    const parsed = schema.safeParse(value);
    if (!parsed.success)
        throw new AppError('VALIDATION_ERROR', 400);
    return parsed.data;
}
const pathSchema = z.strictObject({
    id: idSchema
});
const noQuery = z.strictObject({});
const id = (value: unknown) => decode(pathSchema, value).id;
function revision(header: string | string[] | undefined): number {
    if (!header)
        throw new AppError('PRECONDITION_REQUIRED', 428);
    if (typeof header !== 'string' || !/^"[1-9]\d{0,14}"$/.test(header))
        throw new AppError('VALIDATION_ERROR', 400);
    return Number(header.slice(1, -1));
}
export function createApi(config: Config, db: Database, scheduler: Scheduler, clock: LogicalClock, ready: () => boolean, diagnostics: () => {
    retentionDeleted: number;
    retentionBacklog: boolean;
    lastBackgroundFailure: string | null;
} = () => ({
    retentionDeleted: 0, retentionBacklog: false, lastBackgroundFailure: null
}), deliveries?: Deliveries) {
    const app = Fastify({
        logger: false, bodyLimit: 65536, requestTimeout: 15000, connectionTimeout: 10000, keepAliveTimeout: 5000, maxRequestsPerSocket: 100, trustProxy: address => inCidrs(address, config.trustedProxyCidrs), genReqId: () => crypto.randomUUID(), requestIdHeader: false
    });
    const monitors = new Monitors(db, scheduler, clock, config.egress);
    const security = new Security(config);
    security.install(app, ready);
    installEvents(app, db, security);
    installAssets(app);
    app.setErrorHandler((error, req, reply) => {
        const framework = error as {
            statusCode?: number;
            code?: string;
        };
        const status = error instanceof AppError ? error.status : framework.statusCode && [400, 413, 415].includes(framework.statusCode) ? framework.statusCode : 500;
        const code = error instanceof AppError ? error.code : status === 413 ? 'PAYLOAD_TOO_LARGE' : status === 415 ? 'UNSUPPORTED_MEDIA_TYPE' : status === 400 ? 'VALIDATION_ERROR' : 'INTERNAL_ERROR';
        if (status >= 500)
            safeLog(code);
        if (status === 429 || status === 503)
            reply.header('Retry-After', '1');
        reply.code(status).send({
            error: {
                code, message: status === 400 ? 'Request validation failed.' : code === 'FEATURE_NOT_AVAILABLE' ? 'This feature requires a later stage.' : 'The request could not be completed.', requestId: req.id
            }
        });
    });
    app.setNotFoundHandler(() => { throw new AppError('NOT_FOUND', 404); });
    app.get('/health/live', async (req) => {
        decode(noQuery, req.query);
        return {
            status: 'alive'
        };
    });
    app.get('/health/ready', async (req, reply) => {
        decode(noQuery, req.query);
        let valid = ready();
        if (valid) {
            try {
                valid = await db.call('health', {});
            }
            catch {
                valid = false;
            }
        }
        return valid ? {
            status: 'ready'
        } : reply.header('Retry-After', '1').code(503).send({
            status: 'not_ready', code: db.fault ? 'DATABASE_UNAVAILABLE' : 'SERVICE_STOPPING'
        });
    });
    app.post('/api/v1/monitors', async (req, reply) => {
        decode(noQuery, req.query);
        const monitor = await monitors.create(decode(monitorCreateSchema, req.body));
        reply.code(201).header('ETag', `"${monitor.revision}"`).header('Location', `/api/v1/monitors/${monitor.id}`);
        return {
            data: monitor
        };
    });
    app.get('/api/v1/monitors', async (req) => db.call('list', {
        now: clock.now(), query: decode(monitorQuerySchema, req.query)
    }));
    app.get('/api/v1/monitors/:id', async (req, reply) => {
        decode(noQuery, req.query);
        const monitor = await db.call('get', {
            id: id(req.params)
        });
        reply.header('ETag', `"${monitor.revision}"`);
        return {
            data: monitor
        };
    });
    app.patch('/api/v1/monitors/:id', async (req, reply) => {
        decode(noQuery, req.query);
        const monitor = await monitors.patch(id(req.params), revision(req.headers['if-match']), decode(monitorPatchSchema, req.body));
        reply.header('ETag', `"${monitor.revision}"`);
        return {
            data: monitor
        };
    });
    app.delete('/api/v1/monitors/:id', async (req, reply) => {
        decode(z.strictObject({
            confirm: z.literal('true')
        }), req.query);
        await monitors.delete(id(req.params), revision(req.headers['if-match']));
        return reply.code(204).send();
    });
    app.post('/api/v1/monitors/:id/checks', async (req, reply) => {
        decode(noQuery, req.query);
        decode(emptySchema, req.body);
        const execution = await scheduler.manual(id(req.params));
        reply.code(202).header('Location', `/api/v1/executions/${execution.id}`);
        return {
            data: executionSchema.strip().parse(execution)
        };
    });
    app.get('/api/v1/executions/:id', async (req) => {
        decode(noQuery, req.query);
        return {
            data: executionSchema.strip().parse(await db.call('execution', {
                id: id(req.params)
            }))
        };
    });
    app.get('/api/v1/monitors/:id/checks', async (req) => db.call('history', {
        id: id(req.params), now: clock.now(), query: decode(historyQuerySchema, req.query)
    }));
    app.get('/api/v1/configuration', async (req) => {
        decode(noQuery, req.query);
        return {
            data: {
                version: '0.1.0', exposure: config.exposure, egressPolicy: config.egress.mode, checkConcurrency: config.concurrency, manualQueueLimit: config.manualQueueLimit, defaults: {
                    intervalMs: 60000, timeoutMs: 10000, failureThreshold: 3, recoveryThreshold: 2, latencyThresholdMs: 1000, degradationThreshold: 3
                }, features: {
                    foundation: 1, healthEvaluation: 2, dashboard: 3, notifications: 3
                }, retention: {
                    checksDays: config.checkRetentionDays, incidentsDays: config.incidentRetentionDays, deliveriesDays: config.deliveryRetentionDays
                }
            }
        };
    });
    app.get('/api/v1/monitors/summary', async (req) => {
        decode(noQuery, req.query);
        return {
            data: await db.call('summary', {
                now: clock.now()
            })
        };
    });
    app.get('/api/v1/engine', async (req) => {
        decode(noQuery, req.query);
        const now = clock.now(), stored = await db.call('engine', {
            now
        });
        return {
            data: engineSchema.parse({
                ...stored, asOf: new Date(now).toISOString(), running: scheduler.running, databaseQueueLength: db.queueLength, checkConcurrency: config.concurrency, ...diagnostics()
            })
        };
    });
    app.get('/api/v1/monitors/:id/metrics', async (req) => ({
        data: await db.call('metrics', {
            id: id(req.params), now: clock.now(), query: decode(metricsQuerySchema, req.query)
        })
    }));
    app.get('/api/v1/monitors/:id/transitions', async (req) => db.call('transitions', {
        id: id(req.params), now: clock.now(), query: decode(transitionQuerySchema, req.query)
    }));
    app.get('/api/v1/incidents', async (req) => db.call('incidents', {
        now: clock.now(), query: decode(incidentQuerySchema, req.query)
    }));
    app.get('/api/v1/incidents/:id', async (req) => {
        decode(noQuery, req.query);
        return {
            data: await db.call('incident', {
                id: id(req.params), now: clock.now()
            })
        };
    });
    app.get('/api/v1/dashboard', async (req) => {
        decode(z.strictObject({
            window: z.literal('24h').optional()
        }), req.query);
        return {
            data: await db.call('dashboard', {
                now: clock.now()
            })
        };
    });
    app.get('/api/v1/notification-destinations', async (req) => db.call('destinations', {
        now: clock.now(), query: decode(destinationQuerySchema, req.query)
    }));
    app.get('/api/v1/notification-destinations/:id', async (req, reply) => {
        decode(noQuery, req.query);
        const data = await db.call('destinationGet', {
            id: id(req.params)
        });
        reply.header('ETag', `"${data.revision}"`);
        return {
            data
        };
    });
    app.post('/api/v1/notification-destinations', async (req, reply) => {
        decode(noQuery, req.query);
        const input = decode(destinationCreateSchema, req.body);
        await provisioned(config, input.urlSecretRef, 'url');
        if (input.signingSecretRef)
            await provisioned(config, input.signingSecretRef, 'key');
        const data = await db.call('destinationCreate', {
            input, now: clock.now()
        });
        reply.code(201).header('ETag', `"${data.revision}"`);
        return {
            data
        };
    });
    app.patch('/api/v1/notification-destinations/:id', async (req, reply) => {
        decode(noQuery, req.query);
        const input = decode(destinationPatchSchema, req.body);
        if (input.urlSecretRef)
            await provisioned(config, input.urlSecretRef, 'url');
        if (input.signingSecretRef)
            await provisioned(config, input.signingSecretRef, 'key');
        const destinationId = id(req.params), data = await db.call('destinationPatch', {
            id: destinationId, revision: revision(req.headers['if-match']), now: clock.now(), input
        });
        deliveries?.cancel(destinationId);
        reply.header('ETag', `"${data.revision}"`);
        return {
            data
        };
    });
    app.delete('/api/v1/notification-destinations/:id', async (req, reply) => {
        decode(z.strictObject({
            confirm: z.literal('true')
        }), req.query);
        const destinationId = id(req.params);
        await db.call('destinationDelete', {
            id: destinationId, revision: revision(req.headers['if-match']), now: clock.now()
        });
        deliveries?.cancel(destinationId);
        return reply.code(204).send();
    });
    app.post('/api/v1/notification-destinations/:id/test', async (req, reply) => {
        decode(noQuery, req.query);
        decode(emptySchema, req.body);
        const data = await db.call('destinationTest', {
            id: id(req.params), now: clock.now()
        });
        deliveries?.wake();
        return reply.code(202).send({
            data
        });
    });
    app.get('/api/v1/notification-deliveries', async (req) => db.call('deliveries', {
        now: clock.now(), query: decode(deliveryQuerySchema, req.query)
    }));
    app.get('/api/v1/notifications/diagnostics', async (req) => {
        decode(noQuery, req.query);
        return {
            data: {
                ...await db.call('deliveryStats', {
                    now: clock.now()
                }), workerFailure: deliveries?.fault ?? null
            }
        };
    });
    return app;
}
