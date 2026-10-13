import type { Config } from '../config/config.js';
import type { Database } from '../persistence/database.js';
import type { LogicalClock } from '../scheduler/clock.js';
import { AppError, safeLog } from '../application/errors.js';
import { provisioned } from './secrets.js';
import { sendWebhook } from './transport.js';
export class Deliveries {
    private timer: ReturnType<typeof setTimeout> | null = null;
    private pumping: Promise<void> | null = null;
    private active = new Map<string, {
        destinationId: string;
        controller: AbortController;
        promise: Promise<void>;
    }>();
    private stopping = false;
    fault: string | null = null;
    constructor(private readonly db: Database, private readonly config: Config, private readonly clock: LogicalClock) { }
    start() { this.wake(); }
    cancel(destinationId: string) {
        for (const active of this.active.values())
            if (active.destinationId === destinationId)
                active.controller.abort();
        this.wake();
    }
    wake() {
        if (this.stopping || this.fault || this.db.fault || this.pumping)
            return;
        if (this.timer)
            clearTimeout(this.timer);
        this.timer = null;
        this.pumping = this.pump().catch(error => {
            if (error instanceof AppError && error.code === 'DATABASE_QUEUE_SATURATED')
                return;
            this.fault = 'DELIVERY_WORKER_FAILED';
            safeLog(this.fault);
        }).finally(() => {
            this.pumping = null;
            if (!this.stopping && !this.fault)
                this.timer = setTimeout(() => this.wake(), 1000);
        });
    }
    private async pump() {
        while (!this.stopping && !this.db.fault && this.active.size < this.config.webhookConcurrency) {
            const job = await this.db.call('deliveryClaim', {
                now: this.clock.now()
            });
            if (!job)
                break;
            const controller = new AbortController();
            const promise = (async () => {
                let result = {
                    status: null as number | null, code: null as string | null, retry: false, retryAfterMs: 0, cancel: false
                };
                try {
                    const d = await this.db.call('destinationSecret', {
                        id: job.destinationId
                    });
                    if (!d.enabled || d.revision !== job.destinationRevision)
                        result = {
                            ...result, cancel: true, code: 'DESTINATION_CHANGED'
                        };
                    else {
                        const url = await provisioned(this.config, d.urlSecretRef, 'url'), key = d.signingSecretRef ? await provisioned(this.config, d.signingSecretRef, 'key') : null;
                        result = await sendWebhook(this.config.egress, url, key, job.payloadJson, job.eventId, job.attemptCount, controller.signal);
                        if (this.stopping && result.cancel)
                            result = {
                                ...result, cancel: false, retry: true, code: 'SHUTDOWN_UNCERTAINTY'
                            };
                    }
                }
                catch (error) {
                    if (error instanceof AppError && error.code === 'NOT_FOUND')
                        result = {
                            ...result, cancel: true, code: 'DESTINATION_CHANGED'
                        };
                    else if (error instanceof AppError && error.code === 'DESTINATION_SECRET_INVALID')
                        result = {
                            ...result, code: 'DESTINATION_SECRET_INVALID'
                        };
                    else
                        throw error;
                }
                await this.db.call('deliveryFinish', {
                    id: job.id, attempt: job.attemptCount, now: this.clock.now(), ...result
                });
            })().catch(() => { this.fault = 'DELIVERY_WORKER_FAILED'; safeLog(this.fault); }).finally(() => { this.active.delete(job.id); this.wake(); });
            this.active.set(job.id, {
                destinationId: job.destinationId, controller, promise
            });
        }
    }
    async stop() {
        this.stopping = true;
        if (this.timer)
            clearTimeout(this.timer);
        if (this.pumping)
            await this.pumping;
        for (const a of this.active.values())
            a.controller.abort();
        await Promise.all([...this.active.values()].map(a => a.promise));
    }
}
