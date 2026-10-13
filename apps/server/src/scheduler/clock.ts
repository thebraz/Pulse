import { safeLog } from '../application/errors.js';
export class LogicalClock {
    private last: number;
    private warned = false;
    constructor(seed = 0, private readonly raw: () => number = Date.now) { this.last = seed; }
    now(): number {
        const raw = this.raw();
        if (raw < this.last && !this.warned) {
            safeLog('CLOCK_REGRESSION');
            this.warned = true;
        }
        this.last = Math.max(this.last, raw);
        return this.last;
    }
}
export function nextDue(due: number, completed: number, interval: number): number { return due > completed ? due : due + (Math.floor((completed - due) / interval) + 1) * interval; }
