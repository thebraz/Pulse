import { randomUUID } from 'node:crypto';
import type { Config } from '../config/config.js';
import { acquireLock } from './lock.js';
import { Database } from '../persistence/database.js';
import { createExecutor, type Executor } from '../monitoring/http.js';
import { LogicalClock } from '../scheduler/clock.js';
import { Scheduler } from '../scheduler/scheduler.js';
import { createApi } from '../api/server.js';
import { AppError, safeLog } from '../application/errors.js';
import { Deliveries } from '../notifications/worker.js';
export async function createRuntime(config: Config, options: {
    executor?: Executor;
    rawClock?: () => number;
    autoStart?: boolean;
} = {}) {
    const [major, minor] = process.versions.node.split('.').map(Number);
    if (major !== 24 || minor === undefined || minor < 19)
        throw new AppError('UNSUPPORTED_RUNTIME', 500);
    const lock = await acquireLock(config.dataDir);
    let ready = false, stopping = false;
    let database: Database | null = null;
    try {
        const db = new Database(lock.directory, config.dbQueueLimit, code => { ready = false; safeLog(code); }, config.concurrency + config.webhookConcurrency + 2);
        database = db;
        await db.ready;
        const initialized = await db.call('initialize', {
            now: Date.now(), runId: randomUUID(), fingerprint: config.fingerprint
        });
        const clock = new LogicalClock(initialized.seed, options.rawClock ?? Date.now);
        const scheduler = new Scheduler(db, options.executor ?? createExecutor(config.egress), clock, config.concurrency, config.manualQueueLimit);
        const deliveries = new Deliveries(db, config, clock);
        let maintenanceTimer: ReturnType<typeof setTimeout> | null = null, maintenance: Promise<void> | null = null, nextRetention = 0, nextHeartbeat = 0, retentionDeleted = 0, retentionBacklog = false, maintenanceFault: string | null = null;
        const isReady = () => ready && !stopping && !db.fault && !scheduler.fault && !maintenanceFault;
        const api = createApi(config, db, scheduler, clock, isReady, () => ({
            retentionDeleted, retentionBacklog, lastBackgroundFailure: maintenanceFault ?? scheduler.fault ?? db.fault
        }), deliveries);
        const maintain = () => {
            maintenance = (async () => {
                const now = clock.now();
                if (now >= nextHeartbeat) {
                    await db.call('heartbeat', {
                        now
                    });
                    nextHeartbeat = now + 10000;
                }
                if (retentionBacklog || now >= nextRetention) {
                    retentionBacklog = true;
                    for (let batch = 0; batch < 20 && !stopping; batch++) {
                        const result = await db.call('retain', {
                            now, checkDays: config.checkRetentionDays, incidentDays: config.incidentRetentionDays, deliveryDays: config.deliveryRetentionDays
                        });
                        retentionDeleted += result.deleted;
                        retentionBacklog = result.more;
                        if (!result.more) {
                            nextRetention = now + 3600000;
                            break;
                        }
                    }
                }
            })().catch(error => {
                if (error instanceof AppError && error.code === 'DATABASE_QUEUE_SATURATED')
                    return;
                maintenanceFault = 'MAINTENANCE_FAILURE';
                ready = false;
                safeLog(maintenanceFault);
            }).finally(() => {
                maintenance = null;
                if (!stopping && !db.fault && !maintenanceFault)
                    maintenanceTimer = setTimeout(maintain, retentionBacklog ? 100 : 10000);
            });
        };
        let closed: Promise<void> | null = null;
        return {
            api, db, scheduler, deliveries, clock, sqliteVersion: initialized.sqliteVersion, isReady,
            async listen() {
                await api.listen({
                    host: config.host, port: config.port
                });
                await db.call('heartbeat', {
                    now: clock.now()
                });
                nextHeartbeat = clock.now() + 10000;
                ready = true;
                deliveries.start();
                maintenanceTimer = setTimeout(maintain, 10000);
                if (options.autoStart !== false)
                    scheduler.start();
            },
            close(): Promise<void> {
                if (closed)
                    return closed;
                stopping = true;
                ready = false;
                if (maintenanceTimer)
                    clearTimeout(maintenanceTimer);
                closed = (async () => {
                    let fault: unknown;
                    try {
                        await deliveries.stop();
                    }
                    catch (error) {
                        fault = error;
                    }
                    try {
                        await scheduler.stop();
                    }
                    catch (error) {
                        fault = error;
                    }
                    if (maintenance)
                        await maintenance;
                    try {
                        await api.close();
                    }
                    catch (error) {
                        fault ??= error;
                    }
                    try {
                        await db.close();
                    }
                    catch (error) {
                        fault ??= error;
                    }
                    await lock.release();
                    if (fault)
                        throw fault;
                })();
                return closed;
            }
        };
    }
    catch (error) {
        try {
            await database?.close();
        }
        finally {
            await lock.release();
        }
        throw error;
    }
}
