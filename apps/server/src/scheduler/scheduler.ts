import type { Check } from '@pulse/contracts';
import { Database } from '../persistence/database.js';
import type { Executor } from '../monitoring/http.js';
import { AppError, safeLog } from '../application/errors.js';
import { LogicalClock } from './clock.js';
type Active = {
    monitorId: string;
    revision: number;
    controller: AbortController;
    task: Promise<void>;
};
export class Scheduler {
    private timer: ReturnType<typeof setTimeout> | null = null;
    private pumping: Promise<void> | null = null;
    private started = false;
    private stopping = false;
    private preferManual = false;
    private requested = false;
    private delay = 250;
    private readonly active = new Map<string, Active>();
    fault: string | null = null;
    constructor(private readonly db: Database, private readonly execute: Executor, private readonly clock: LogicalClock, private readonly concurrency: number, private readonly manualLimit: number) { }
    start() {
        if (this.started)
            throw new AppError('SCHEDULER_ALREADY_STARTED', 500);
        this.started = true;
        this.wake();
    }
    get running() { return this.active.size; }
    wake() {
        if (!this.started || this.stopping || this.fault || this.db.fault)
            return;
        if (this.timer) {
            clearTimeout(this.timer);
            this.timer = null;
        }
        if (this.pumping) {
            this.requested = true;
            return;
        }
        this.requested = false;
        this.pumping = this.pump().catch(error => {
            if (error instanceof AppError && error.code === 'DATABASE_QUEUE_SATURATED') {
                this.delay = 250;
                return;
            }
            this.fault = 'BACKGROUND_FAILURE';
            safeLog(this.fault);
        }).finally(() => {
            this.pumping = null;
            if (!this.stopping && !this.fault && !this.db.fault && (this.requested || this.active.size < this.concurrency))
                this.timer = setTimeout(() => this.wake(), this.requested ? 0 : this.delay);
        });
    }
    private async pump() {
        while (!this.stopping && !this.fault && !this.db.fault && this.active.size < this.concurrency) {
            const reservation = await this.db.call('dispatch', {
                now: this.clock.now(), preferManual: this.preferManual, busyIds: [...this.active.values()].map(a => a.monitorId)
            });
            if (!reservation) {
                this.delay = await this.db.call('nextWake', {
                    now: this.clock.now()
                });
                return;
            }
            const { monitor, check } = reservation;
            this.preferManual = check.trigger === 'automatic';
            const controller = new AbortController();
            const active: Active = {
                monitorId: monitor.id, revision: monitor.revision, controller, task: Promise.resolve()
            };
            this.active.set(check.id, active);
            if (this.stopping || this.fault || this.db.fault) {
                controller.abort();
                break;
            }
            active.task = (async () => {
                const observation = await this.execute(monitor, controller.signal);
                await this.db.call('finish', {
                    id: check.id, now: this.clock.now(), observation
                });
            })().catch(() => { this.fault = 'EXECUTION_FAILURE'; safeLog(this.fault); }).finally(() => { this.active.delete(check.id); this.wake(); });
        }
    }
    async manual(id: string): Promise<Check> {
        if (this.stopping || this.fault || this.db.fault)
            throw new AppError('SERVICE_STOPPING', 503);
        const check = await this.db.call('manual', {
            id, now: this.clock.now(), limit: this.manualLimit
        });
        this.wake();
        return check;
    }
    cancel(id: string, currentRevision?: number) {
        for (const a of this.active.values())
            if (a.monitorId === id && (currentRevision === undefined || a.revision < currentRevision))
                a.controller.abort();
        this.wake();
    }
    async stop() {
        this.stopping = true;
        if (this.timer) {
            clearTimeout(this.timer);
            this.timer = null;
        }
        if (this.pumping)
            await this.pumping;
        // Fence in storage before waiting for any late transport completion.
        let fault: unknown;
        try {
            await this.db.call('stop', {
                now: this.clock.now()
            });
        }
        catch (error) {
            fault = error;
        }
        for (const a of this.active.values())
            a.controller.abort();
        await Promise.all([...this.active.values()].map(a => a.task));
        this.active.clear();
        if (fault)
            throw fault;
    }
}
