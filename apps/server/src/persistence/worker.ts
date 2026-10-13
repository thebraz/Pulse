import { parentPort, workerData } from 'node:worker_threads';
import { z } from 'zod';
import { requestSchema, commands, responses } from './protocol.js';
import { Store } from './store.js';
import { AppError } from '../application/errors.js';
const port = parentPort;
if (!port)
    throw new Error('WORKER_REQUIRED');
let store: Store;
try {
    const input = z.strictObject({
        path: z.string().min(1).max(4096)
    }).parse(workerData);
    store = new Store(input.path);
    port.postMessage({
        ready: true
    });
}
catch (error) {
    port.postMessage({
        ready: false, code: error instanceof AppError ? error.code : 'DATABASE_UNAVAILABLE'
    });
    port.close();
}
port.on('message', (message: unknown) => {
    const decoded = requestSchema.safeParse(message);
    if (!decoded.success) {
        port.close();
        return;
    }
    const { id, op, payload } = decoded.data;
    try {
        const input = commands[op].parse(payload);
        const value = store.execute(op, input);
        responses[op].parse(value);
        port.postMessage({
            id, ok: true, value
        });
        if (op === 'close')
            port.close();
    }
    catch (error) {
        port.postMessage({
            id, ok: false, code: error instanceof AppError ? error.code : 'DATABASE_UNAVAILABLE', status: error instanceof AppError ? error.status : 503
        });
    }
});
