import type { MonitorInput, MonitorPatch } from '@pulse/contracts';
import type { Database } from '../persistence/database.js';
import type { Scheduler } from '../scheduler/scheduler.js';
import type { LogicalClock } from '../scheduler/clock.js';
import { parseTarget, type EgressPolicy } from '../monitoring/policy.js';
export class Monitors {
    constructor(private readonly db: Database, private readonly scheduler: Scheduler, private readonly clock: LogicalClock, private readonly policy: EgressPolicy) { }
    async create(input: MonitorInput) {
        const url = parseTarget(input.url, this.policy).href;
        const monitor = await this.db.call('create', {
            input: {
                ...input, url
            }, now: this.clock.now()
        });
        this.scheduler.wake();
        return monitor;
    }
    async patch(id: string, revision: number, input: MonitorPatch) {
        if (input.url)
            input = {
                ...input, url: parseTarget(input.url, this.policy).href
            };
        const monitor = await this.db.call('patch', {
            id, revision, input, now: this.clock.now()
        });
        this.scheduler.cancel(id, monitor.revision);
        return monitor;
    }
    async delete(id: string, revision: number) {
        await this.db.call('delete', {
            id, revision, now: this.clock.now()
        });
        this.scheduler.cancel(id);
    }
}
