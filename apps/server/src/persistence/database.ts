import { Worker } from 'node:worker_threads';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { commands, responses, replySchema, type Operation, type Input, type Output } from './protocol.js';
import { AppError } from '../application/errors.js';
type Pending = {
    resolve: (value: unknown) => void;
    reject: (e: AppError) => void;
    op: Operation;
    timer: ReturnType<typeof setTimeout>;
};
function watchControl(message: unknown): boolean {
    if (process.env.WATCH_REPORT_DEPENDENCIES !== '1' || typeof message !== 'object' || message === null)
        return false;
    const keys = Object.keys(message);
    if (keys.length !== 1 || !['watch:import', 'watch:require'].includes(keys[0]!))
        return false;
    const paths = (message as Record<string, unknown>)[keys[0]!];
    return Array.isArray(paths) && paths.length <= 1000 && paths.every(path => typeof path === 'string' && path.length <= 8192);
}
export class Database {
    private readonly worker: Worker;
    private readonly pending = new Map<number, Pending>();
    private sequence = 0;
    fault: string | null = null;
    private closing = false;
    readonly ready: Promise<void>;
    readonly changes = new Set<(op: Operation) => void>();
    constructor(directory: string, private readonly limit = 1000, private readonly onFault: (code: string) => void = () => { }, private readonly reserved = 2) {
        let url = new URL('./worker.js', import.meta.url);
        if (!existsSync(url))
            url = new URL('../../dist/persistence/worker.js', import.meta.url);
        this.worker = new Worker(url, {
            workerData: {
                path: join(directory, 'pulse.sqlite')
            }
        });
        this.ready = new Promise<void>((resolve, reject) => {
            // Full integrity checks must finish before serving requests, even for large retained histories.
            const timer = setTimeout(() => { this.fail('DATABASE_UNAVAILABLE'); reject(new AppError('DATABASE_UNAVAILABLE', 503)); void this.worker.terminate(); }, 600000);
            const fail = () => { clearTimeout(timer); reject(new AppError('DATABASE_UNAVAILABLE', 503)); };
            this.worker.once('error', fail);
            this.worker.once('exit', fail);
            const initialized = (message: unknown) => {
                // Node's watch supervisor reports dependencies over the same worker channel.
                if (watchControl(message))
                    return;
                this.worker.off('message', initialized);
                clearTimeout(timer);
                this.worker.off('error', fail);
                this.worker.off('exit', fail);
                if (typeof message === 'object' && message !== null && 'ready' in message && message.ready === true)
                    resolve();
                else {
                    const code = typeof message === 'object' && message !== null && 'code' in message && ['SCHEMA_UNSUPPORTED', 'DATABASE_UNAVAILABLE'].includes(String(message.code)) ? String(message.code) : 'DATABASE_UNAVAILABLE';
                    this.fail(code);
                    reject(new AppError(code, 503));
                }
            };
            this.worker.on('message', initialized);
        });
        this.worker.on('message', (message: unknown) => {
            if (watchControl(message))
                return;
            if (typeof message === 'object' && message !== null && 'ready' in message)
                return;
            const reply = replySchema.safeParse(message);
            if (!reply.success) {
                this.fail('DATABASE_UNAVAILABLE');
                return;
            }
            const p = this.pending.get(reply.data.id);
            if (!p)
                return;
            this.pending.delete(reply.data.id);
            clearTimeout(p.timer);
            if (reply.data.ok) {
                const value = responses[p.op].safeParse(reply.data.value);
                if (value.success) {
                    p.resolve(value.data);
                    if (['create', 'patch', 'delete', 'finish', 'destinationCreate', 'destinationPatch', 'destinationDelete', 'destinationTest', 'deliveryFinish'].includes(p.op))
                        for (const listener of this.changes)
                            listener(p.op);
                }
                else {
                    p.reject(new AppError('DATABASE_UNAVAILABLE', 503));
                    this.fail('DATABASE_UNAVAILABLE');
                }
            }
            else {
                p.reject(new AppError(reply.data.code, reply.data.status));
                if (reply.data.status === 503 && reply.data.code !== 'QUEUE_SATURATED')
                    this.fail('DATABASE_UNAVAILABLE');
            }
        });
        this.worker.on('error', () => this.fail('DATABASE_UNAVAILABLE'));
        this.worker.on('exit', () => {
            if (!this.closing)
                this.fail('DATABASE_UNAVAILABLE');
        });
    }
    get queueLength(): number { return this.pending.size; }
    private fail(code: string) {
        if (this.fault)
            return;
        this.fault = code;
        for (const p of this.pending.values()) {
            clearTimeout(p.timer);
            p.reject(new AppError('DATABASE_UNAVAILABLE', 503));
        }
        this.pending.clear();
        this.onFault(code);
    }
    async call<K extends Operation>(op: K, payload: Input<K>): Promise<Output<K>> {
        if (this.fault || (this.closing && op !== 'close'))
            throw new AppError('DATABASE_UNAVAILABLE', 503);
        const bookkeeping = ['finish', 'deliveryFinish', 'stop', 'close', 'heartbeat'].includes(op), read = ['get', 'list', 'execution', 'history', 'metrics', 'incidents', 'incident', 'transitions', 'summary', 'engine', 'retain', 'dashboard', 'destinations', 'deliveries', 'destinationGet', 'destinationSecret', 'deliveryStats'].includes(op);
        const capacity = bookkeeping ? this.limit : read ? Math.min(Math.floor(this.limit / 2), this.limit - this.reserved) : this.limit - this.reserved;
        if (this.pending.size >= capacity)
            throw new AppError('DATABASE_QUEUE_SATURATED', 503);
        const input = commands[op].parse(payload), id = ++this.sequence;
        return new Promise<Output<K>>((resolve, reject) => {
            // Recovery scans run only before readiness; ordinary operations retain the short deadline.
            const timer = setTimeout(() => this.fail('DATABASE_UNAVAILABLE'), op === 'initialize' ? 60000 : 10000);
            this.pending.set(id, {
                op, timer, resolve: v => resolve(v as Output<K>), reject
            });
            this.worker.postMessage({
                id, op, payload: input
            });
        });
    }
    async close(): Promise<void> {
        this.closing = true;
        try {
            if (!this.fault)
                await this.call('close', {});
        }
        finally {
            await this.worker.terminate();
        }
    }
}
