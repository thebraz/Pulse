import { z } from 'zod';
import { destinationCreateSchema, destinationPatchSchema, destinationSchema, destinationQuerySchema, deliveryQuerySchema, destinationPageSchema, deliveryPageSchema, deliverySchema, dashboardSchema } from '@pulse/contracts';
import { monitorCreateSchema, monitorPatchSchema, idSchema, observationSchema, monitorQuerySchema, historyQuerySchema, monitorSchema, checkSchema, monitorPageSchema, checkPageSchema, metricsQuerySchema, metricsSchema, incidentQuerySchema, incidentPageSchema, incidentDetailSchema, transitionQuerySchema, transitionPageSchema, summarySchema } from '@pulse/contracts';
const now = z.number().int().nonnegative().safe();
export const reservationSchema = z.strictObject({
    monitor: monitorSchema, check: checkSchema
});
export const commands = {
    initialize: z.strictObject({
        now, runId: idSchema, fingerprint: z.string().regex(/^[a-f0-9]{64}$/)
    }),
    create: z.strictObject({
        now, input: monitorCreateSchema
    }),
    get: z.strictObject({
        id: idSchema
    }),
    list: z.strictObject({
        now, query: monitorQuerySchema
    }),
    patch: z.strictObject({
        id: idSchema, revision: z.number().int().positive(), now, input: monitorPatchSchema
    }),
    delete: z.strictObject({
        id: idSchema, revision: z.number().int().positive(), now
    }),
    manual: z.strictObject({
        id: idSchema, now, limit: z.number().int().positive()
    }),
    dispatch: z.strictObject({
        now, preferManual: z.boolean(), busyIds: z.array(idSchema).max(50).optional()
    }),
    finish: z.strictObject({
        id: idSchema, now, observation: observationSchema.nullable()
    }),
    execution: z.strictObject({
        id: idSchema
    }),
    history: z.strictObject({
        id: idSchema, now, query: historyQuerySchema
    }),
    health: z.strictObject({}),
    heartbeat: z.strictObject({
        now
    }),
    nextWake: z.strictObject({
        now
    }),
    metrics: z.strictObject({
        id: idSchema, now, query: metricsQuerySchema
    }),
    incidents: z.strictObject({
        now, query: incidentQuerySchema
    }),
    incident: z.strictObject({
        id: idSchema, now
    }),
    transitions: z.strictObject({
        id: idSchema, now, query: transitionQuerySchema
    }),
    summary: z.strictObject({
        now
    }),
    engine: z.strictObject({
        now
    }),
    retain: z.strictObject({
        now, checkDays: z.number().int().min(1).max(365), incidentDays: z.number().int().min(30).max(3650), deliveryDays: z.number().int().min(1).max(365).optional()
    }),
    dashboard: z.strictObject({
        now
    }),
    destinationCreate: z.strictObject({
        now, input: destinationCreateSchema
    }),
    destinationGet: z.strictObject({
        id: idSchema
    }),
    destinationSecret: z.strictObject({
        id: idSchema
    }),
    destinationPatch: z.strictObject({
        id: idSchema, revision: z.number().int().positive(), now, input: destinationPatchSchema
    }),
    destinationDelete: z.strictObject({
        id: idSchema, revision: z.number().int().positive(), now
    }),
    destinations: z.strictObject({
        now, query: destinationQuerySchema
    }),
    deliveries: z.strictObject({
        now, query: deliveryQuerySchema
    }),
    destinationTest: z.strictObject({
        id: idSchema, now
    }),
    deliveryClaim: z.strictObject({
        now
    }),
    deliveryFinish: z.strictObject({
        id: idSchema, attempt: z.number().int().min(1).max(5), now, status: z.number().int().min(100).max(599).nullable(), code: z.string().regex(/^[A-Z_]+$/).nullable(), retry: z.boolean(), cancel: z.boolean().default(false), retryAfterMs: z.number().int().min(0).max(300000).default(0)
    }),
    deliveryStats: z.strictObject({
        now
    }),
    stop: z.strictObject({
        now
    }),
    close: z.strictObject({})
};
export const responses = {
    dashboard: dashboardSchema, destinationCreate: destinationSchema, destinationGet: destinationSchema, destinationPatch: destinationSchema, destinationDelete: z.null(), destinations: destinationPageSchema, deliveries: deliveryPageSchema, destinationTest: deliverySchema,
    destinationSecret: z.strictObject({
        id: idSchema, enabled: z.boolean(), revision: z.number().int().positive(), urlSecretRef: z.string(), signingSecretRef: z.string().nullable()
    }),
    deliveryClaim: deliverySchema.extend({
        destinationRevision: z.number().int().positive(), payloadJson: z.string().max(16384)
    }).nullable(), deliveryFinish: z.null(),
    deliveryStats: z.strictObject({
        pending: now, inFlight: now, succeeded: now, dead: now, cancelled: now, oldestPendingAgeMs: now
    }),
    initialize: z.strictObject({
        seed: now, sqliteVersion: z.string()
    }), create: monitorSchema, get: monitorSchema, list: monitorPageSchema, patch: monitorSchema, delete: z.null(), manual: checkSchema, dispatch: reservationSchema.nullable(), finish: z.null(), execution: checkSchema, history: checkPageSchema, health: z.boolean(), stop: z.null(), close: z.null(),
    heartbeat: z.null(), nextWake: now, metrics: metricsSchema, incidents: incidentPageSchema, incident: incidentDetailSchema, transitions: transitionPageSchema, summary: summarySchema,
    engine: z.strictObject({
        queued: now, due: now, oldestDueLagMs: now, cancelled: now, abandoned: now, retentionProtectedIncidents: now
    }),
    retain: z.strictObject({
        deleted: now, more: z.boolean()
    })
};
export type Operation = keyof typeof commands;
export type Input<K extends Operation> = z.infer<(typeof commands)[K]>;
export type Output<K extends Operation> = z.infer<(typeof responses)[K]>;
export const requestSchema = z.strictObject({
    id: z.number().int().positive(), op: z.enum(Object.keys(commands) as [
        Operation,
        ...Operation[]
    ]), payload: z.unknown()
});
export const replySchema = z.discriminatedUnion('ok', [
    z.strictObject({
        id: z.number().int().positive(), ok: z.literal(true), value: z.unknown()
    }),
    z.strictObject({
        id: z.number().int().positive(), ok: z.literal(false), code: z.string().regex(/^[A-Z_]+$/), status: z.number().int().min(400).max(599)
    })
]);
