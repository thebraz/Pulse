import { z } from 'zod';
export const idSchema = z.uuid();
export const timestampSchema = z.iso.datetime({
    precision: 3
});
export const outcomes = ['SUCCESS', 'HTTP_ERROR', 'DNS_ERROR', 'TLS_ERROR', 'CONNECTION_ERROR', 'TIMEOUT', 'REDIRECT_ERROR', 'POLICY_BLOCKED'] as const;
export const outcomeSchema = z.enum(outcomes);
export const lifecycleSchema = z.enum(['QUEUED', 'RUNNING', 'COMPLETED', 'CANCELLED', 'ABANDONED']);
export const monitorFields = {
    name: z.string().trim().min(1).max(120), url: z.string().min(1).max(2048),
    method: z.enum(['GET', 'HEAD']).default('GET'),
    expectedStatusCodes: z.array(z.number().int().min(200).max(599)).min(1).max(50).transform(v => [...new Set(v)].sort((a, b) => a - b)).default([200]),
    intervalMs: z.number().int().min(15000).max(3600000).default(60000),
    timeoutMs: z.number().int().min(1000).max(30000).default(10000),
    followRedirects: z.boolean().default(false), enabled: z.boolean().default(true),
    failureThreshold: z.number().int().min(1).max(10).default(3),
    recoveryThreshold: z.number().int().min(1).max(10).default(2),
    latencyThresholdMs: z.number().int().min(1).max(30000).default(1000),
    degradationThreshold: z.number().int().min(1).max(10).default(3)
};
export const monitorCreateSchema = z.strictObject(monitorFields);
export const monitorPatchSchema = z.strictObject({
    name: monitorFields.name.optional(), url: monitorFields.url.optional(), method: monitorFields.method.removeDefault().optional(),
    expectedStatusCodes: monitorFields.expectedStatusCodes.removeDefault().optional(), intervalMs: monitorFields.intervalMs.removeDefault().optional(),
    timeoutMs: monitorFields.timeoutMs.removeDefault().optional(), followRedirects: monitorFields.followRedirects.removeDefault().optional(), enabled: monitorFields.enabled.removeDefault().optional(),
    failureThreshold: monitorFields.failureThreshold.removeDefault().optional(), recoveryThreshold: monitorFields.recoveryThreshold.removeDefault().optional(),
    latencyThresholdMs: monitorFields.latencyThresholdMs.removeDefault().optional(), degradationThreshold: monitorFields.degradationThreshold.removeDefault().optional()
}).refine(v => Object.keys(v).length > 0);
export type MonitorInput = z.infer<typeof monitorCreateSchema>;
export type MonitorPatch = z.infer<typeof monitorPatchSchema>;
export const monitorSchema = z.strictObject({
    name: monitorFields.name, url: monitorFields.url, method: monitorFields.method.removeDefault(), expectedStatusCodes: monitorFields.expectedStatusCodes.removeDefault(),
    intervalMs: monitorFields.intervalMs.removeDefault(), timeoutMs: monitorFields.timeoutMs.removeDefault(), followRedirects: monitorFields.followRedirects.removeDefault(), enabled: monitorFields.enabled.removeDefault(),
    failureThreshold: monitorFields.failureThreshold.removeDefault(), recoveryThreshold: monitorFields.recoveryThreshold.removeDefault(), latencyThresholdMs: monitorFields.latencyThresholdMs.removeDefault(), degradationThreshold: monitorFields.degradationThreshold.removeDefault(),
    id: idSchema, revision: z.number().int().positive(), createdAt: timestampSchema, updatedAt: timestampSchema, nextDueAt: timestampSchema.nullable(), lastCheckAt: timestampSchema.nullable(), lastObservedOutcome: outcomeSchema.nullable(), status: z.strictObject({
        state: z.enum(['UNKNOWN', 'UP', 'DEGRADED', 'DOWN']), reason: z.enum(['INITIAL', 'PAUSED', 'RECONFIGURED', 'RESTARTED', 'HEALTHY', 'SLOW', 'PENDING_FAILURE', 'FAILURE_THRESHOLD', 'RECOVERING', 'POLICY_BLOCKED'])
    })
});
export type Monitor = z.infer<typeof monitorSchema>;
export const executionFields = {
    id: idSchema, monitorId: idSchema, lifecycle: lifecycleSchema, trigger: z.enum(['automatic', 'manual']), queuedAt: timestampSchema, startedAt: timestampSchema.nullable(), completedAt: timestampSchema.nullable(), outcome: outcomeSchema.nullable(), httpStatus: z.number().int().min(100).max(599).nullable(), durationMs: z.number().finite().nonnegative().nullable(), errorCode: z.string().regex(/^[A-Z_]{1,64}$/).nullable()
};
export const executionSchema = z.strictObject(executionFields);
export type Execution = z.infer<typeof executionSchema>;
export const checkSchema = executionSchema.extend({
    sequence: z.number().int().positive(), serviceRunId: idSchema, monitorRevision: z.number().int().positive(), executionEpoch: z.number().int().positive(), scheduledAt: timestampSchema.nullable(), redirectCount: z.number().int().min(0).max(3)
});
export type Check = z.infer<typeof checkSchema>;
export const observationSchema = z.strictObject({
    outcome: outcomeSchema, httpStatus: executionFields.httpStatus, durationMs: z.number().finite().nonnegative(), redirectCount: z.number().int().min(0).max(3), errorCode: executionFields.errorCode
});
export type Observation = z.infer<typeof observationSchema>;
export const emptySchema = z.strictObject({});
export const sessionCreateSchema = z.strictObject({
    token: z.string().regex(/^[A-Za-z0-9_-]{1,512}$/)
});
const queryText = z.string().max(1024);
export const monitorQuerySchema = z.strictObject({
    limit: z.string().regex(/^(?:[1-9]|[1-9]\d|100)$/).optional(), cursor: queryText.optional(), q: z.string().trim().max(120).optional(), status: z.enum(['UNKNOWN', 'UP', 'DEGRADED', 'DOWN']).optional(), enabled: z.enum(['true', 'false']).optional(), sort: z.enum(['name', '-updatedAt', 'status']).optional(), include: z.literal('summary').optional()
});
export const historyQuerySchema = z.strictObject({
    limit: z.string().regex(/^(?:[1-9]|[1-9]\d|100)$/).optional(), cursor: queryText.optional(), from: timestampSchema.optional(), to: timestampSchema.optional(), outcome: outcomeSchema.optional(), sort: z.enum(['sequence', '-sequence']).optional()
});
export type MonitorQuery = z.infer<typeof monitorQuerySchema>;
export type HistoryQuery = z.infer<typeof historyQuerySchema>;
export const pageSchema = z.strictObject({
    nextCursor: z.string().nullable(), limit: z.number().int().min(1).max(100), asOf: timestampSchema
});
export const monitorSampleSchema = z.strictObject({
    sampleCount: z.number().int().nonnegative(), sampledAvailabilityPercent: z.number().min(0).max(100).nullable(), meanLatencyMs: z.number().nonnegative().nullable(), latestLatencyMs: z.number().nonnegative().nullable(), knownMs: z.number().nonnegative(), eligibleMs: z.number().nonnegative(), coverageIncomplete: z.boolean()
});
export const monitorOverviewSchema = monitorSchema.extend({
    summary: monitorSampleSchema.optional()
});
export const monitorPageSchema = z.strictObject({
    data: z.array(monitorOverviewSchema).max(100), page: pageSchema
});
export const checkPageSchema = z.strictObject({
    data: z.array(checkSchema).max(100), page: pageSchema
});
export const sessionViewSchema = z.strictObject({
    mode: z.enum(['local', 'authenticated']), authenticated: z.boolean(), csrfToken: z.string().nullable(), expiresAt: timestampSchema.nullable()
});
export const errorSchema = z.strictObject({
    error: z.strictObject({
        code: z.string().regex(/^[A-Z_]+$/), message: z.string(), requestId: z.string().max(100), details: z.array(z.strictObject({
            field: z.string(), rule: z.string()
        })).optional()
    })
});
const countSchema = z.number().int().nonnegative().safe();
const numberSchema = z.number().finite().nonnegative();
const stateSchema = monitorSchema.shape.status.shape.state;
const reasonSchema = monitorSchema.shape.status.shape.reason;
const limitQuery = historyQuerySchema.shape.limit;
export const transitionQuerySchema = historyQuerySchema.omit({
    outcome: true
});
export const incidentQuerySchema = z.strictObject({
    limit: limitQuery, cursor: queryText.optional(), monitorId: idSchema.optional(), status: z.enum(['OPEN', 'RESOLVED']).optional(),
    from: timestampSchema.optional(), to: timestampSchema.optional(), sort: z.enum(['detectedAt', '-detectedAt']).optional(), q: z.string().trim().max(120).optional(), failureCategory: outcomeSchema.optional()
});
export const metricsQuerySchema = z.strictObject({
    from: timestampSchema.optional(), to: timestampSchema.optional(), window: z.enum(['24h', '7d', '30d']).optional(), bucket: z.enum(['1m', '5m', '1h', '1d']).optional()
}).refine(q => !(q.window && (q.from || q.to)));
export type MetricsQuery = z.infer<typeof metricsQuerySchema>;
export type IncidentQuery = z.infer<typeof incidentQuerySchema>;
export type TransitionQuery = z.infer<typeof transitionQuerySchema>;
export const transitionSchema = z.strictObject({
    id: idSchema, monitorId: idSchema, sequence: countSchema, fromState: stateSchema, toState: stateSchema, reason: reasonSchema,
    occurredAt: timestampSchema, checkId: idSchema.nullable(), monitorRevision: countSchema, executionEpoch: countSchema
});
export const incidentSchema = z.strictObject({
    id: idSchema, monitorId: idSchema, monitorRevision: countSchema, status: z.enum(['OPEN', 'RESOLVED']),
    openedAt: timestampSchema, detectedAt: timestampSchema, observedEndAt: timestampSchema.nullable(), resolvedAt: timestampSchema.nullable(),
    openingCheckId: idSchema.nullable(), resolvingCheckId: idSchema.nullable(), openingTransitionId: idSchema, resolvingTransitionId: idSchema.nullable(),
    failureCategory: outcomeSchema, diagnosticSummary: z.string().max(256), durationMs: numberSchema, ongoing: z.boolean(),
    detectionDelayMs: numberSchema, resolutionConfirmationDelayMs: numberSchema.nullable(),
    resolutionSummary: z.string().max(256).nullable()
});
export const incidentPageSchema = z.strictObject({
    data: z.array(incidentSchema).max(100), page: pageSchema
});
export const transitionPageSchema = z.strictObject({
    data: z.array(transitionSchema).max(100), page: pageSchema
});
export const incidentDetailSchema = incidentSchema.extend({
    asOf: timestampSchema, observedDowntimeMs: numberSchema.nullable(), excludedGapMs: numberSchema,
    coverageIncomplete: z.boolean(), transitions: z.array(transitionSchema).max(2)
});
const latencySchema = z.strictObject({
    count: countSchema, meanMs: numberSchema.nullable(), minMs: numberSchema.nullable(), maxMs: numberSchema.nullable(),
    p50Ms: numberSchema.nullable(), p95Ms: numberSchema.nullable(), p99Ms: numberSchema.nullable(), method: z.literal('nearest-rank'),
    lowSample: z.boolean(), p95Sufficient: z.boolean(), p99Sufficient: z.boolean()
});
const percentSchema = z.number().finite().min(0).max(100).nullable();
export const metricsSchema = z.strictObject({
    monitorId: idSchema, from: timestampSchema, to: timestampSchema, asOf: timestampSchema, effectiveFrom: timestampSchema, effectiveTo: timestampSchema,
    notApplicableMs: countSchema, sampleCount: countSchema, successfulCount: countSchema, failedCount: countSchema, degradedCount: countSchema, unclassifiedDegradationCount: countSchema,
    sampledAvailabilityPercent: percentSchema, sampleWindowIncomplete: z.boolean(), includesManualChecks: z.literal(true), latency: latencySchema,
    coverage: z.strictObject({
        eligibleMs: countSchema, knownMs: countSchema, unknownMs: countSchema, pausedMs: countSchema, serviceOfflineMs: countSchema,
        retainedFrom: timestampSchema.nullable(), incomplete: z.boolean()
    }),
    retention: z.strictObject({
        checksFrom: timestampSchema.nullable(), incidentsFrom: timestampSchema.nullable(), coverageFrom: timestampSchema.nullable()
    }),
    observedDowntimeMs: numberSchema.nullable(), incidentCount: countSchema,
    buckets: z.array(z.strictObject({
        start: timestampSchema, end: timestampSchema, count: countSchema, success: countSchema, failure: countSchema,
        availability: percentSchema, meanLatency: numberSchema.nullable(), knownMs: countSchema
    })).max(2000)
});
export const summarySchema = z.strictObject({
    asOf: timestampSchema, total: countSchema, enabled: countSchema, paused: countSchema, unknown: countSchema, up: countSchema, degraded: countSchema, down: countSchema, activeIncidents: countSchema
});
export const engineSchema = z.strictObject({
    asOf: timestampSchema, running: countSchema, queued: countSchema, due: countSchema, oldestDueLagMs: numberSchema,
    cancelled: countSchema, abandoned: countSchema, databaseQueueLength: countSchema, checkConcurrency: countSchema,
    lastBackgroundFailure: z.string().nullable(), retentionProtectedIncidents: countSchema, retentionDeleted: countSchema, retentionBacklog: z.boolean()
});
export const aliasSchema = z.string().regex(/^[A-Za-z0-9_-]{1,64}$/);
export const destinationCreateSchema = z.strictObject({
    name: monitorFields.name, urlSecretRef: aliasSchema, signingSecretRef: aliasSchema.nullable().default(null), enabled: z.boolean().default(true)
});
export const destinationPatchSchema = z.strictObject({
    name: monitorFields.name.optional(), urlSecretRef: aliasSchema.optional(), signingSecretRef: aliasSchema.nullable().optional(), enabled: z.boolean().optional()
}).refine(v => Object.keys(v).length > 0);
export const destinationSchema = z.strictObject({
    id: idSchema, name: monitorFields.name, enabled: z.boolean(), urlConfigured: z.boolean(), signingConfigured: z.boolean(), revision: z.number().int().positive(), createdAt: timestampSchema, updatedAt: timestampSchema
});
export const deliveryStateSchema = z.enum(['PENDING', 'IN_FLIGHT', 'SUCCEEDED', 'DEAD', 'CANCELLED']);
export const eventTypeSchema = z.enum(['incident.opened', 'incident.resolved', 'notification.test']);
export const deliverySchema = z.strictObject({
    id: idSchema, eventId: idSchema, destinationId: idSchema, incidentId: idSchema.nullable(), eventType: eventTypeSchema, state: deliveryStateSchema, attemptCount: z.number().int().min(0).max(5), nextAttemptAt: timestampSchema.nullable(), claimedAt: timestampSchema.nullable(), lastHttpStatus: z.number().int().min(100).max(599).nullable(), lastErrorCode: z.string().regex(/^[A-Z_]+$/).nullable(), createdAt: timestampSchema, updatedAt: timestampSchema, finishedAt: timestampSchema.nullable()
});
export const destinationQuerySchema = z.strictObject({
    limit: limitQuery, cursor: queryText.optional(), sort: z.literal('name').optional()
});
export const deliveryQuerySchema = z.strictObject({
    limit: limitQuery, cursor: queryText.optional(), destinationId: idSchema.optional(), incidentId: idSchema.optional(), state: deliveryStateSchema.optional()
});
export const destinationPageSchema = z.strictObject({
    data: z.array(destinationSchema).max(100), page: pageSchema
});
export const deliveryPageSchema = z.strictObject({
    data: z.array(deliverySchema).max(100), page: pageSchema
});
export const invalidationSchema = z.strictObject({
    version: z.literal(1), resource: z.enum(['monitors', 'incidents', 'deliveries']), ids: z.array(idSchema).max(100), occurredAt: timestampSchema
});
export const dashboardSchema = z.strictObject({
    asOf: timestampSchema, window: z.literal('24h'), counts: summarySchema.omit({
        asOf: true
    }), sampleCount: countSchema, sampledAvailabilityPercent: percentSchema, meanLatencyMs: numberSchema.nullable(), recentIncidents: z.array(incidentSchema).max(10), recentTransitions: z.array(transitionSchema).max(10)
});
export const webhookPayloadSchema = z.discriminatedUnion('type', [
    z.strictObject({
        version: z.literal(1), eventId: idSchema, type: z.enum(['incident.opened', 'incident.resolved']), occurredAt: timestampSchema, monitor: z.strictObject({
            id: idSchema, name: monitorFields.name
        }), incident: z.strictObject({
            id: idSchema, status: z.enum(['OPEN', 'RESOLVED']), openedAt: timestampSchema, detectedAt: timestampSchema, observedEndAt: timestampSchema.nullable(), resolvedAt: timestampSchema.nullable()
        }), transition: z.strictObject({
            fromState: stateSchema, toState: stateSchema
        })
    }),
    z.strictObject({
        version: z.literal(1), eventId: idSchema, type: z.literal('notification.test'), occurredAt: timestampSchema
    })
]);
export const configurationSchema = z.strictObject({
    version: z.string(), exposure: z.enum(['local', 'remote']), egressPolicy: z.enum(['public-only', 'allow-private']), checkConcurrency: countSchema, manualQueueLimit: countSchema, defaults: z.strictObject({
        intervalMs: countSchema, timeoutMs: countSchema, failureThreshold: countSchema, recoveryThreshold: countSchema, latencyThresholdMs: countSchema, degradationThreshold: countSchema
    }), features: z.strictObject({
        foundation: countSchema, healthEvaluation: countSchema, dashboard: countSchema, notifications: countSchema
    }), retention: z.strictObject({
        checksDays: countSchema, incidentsDays: countSchema, deliveriesDays: countSchema
    })
});
