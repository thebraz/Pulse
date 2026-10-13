import type { FastifyInstance } from 'fastify';
import type { ServerResponse } from 'node:http';
import type { Database } from '../persistence/database.js';
import type { Operation } from '../persistence/protocol.js';
import type { Security } from './security.js';
import { AppError } from '../application/errors.js';
export function installEvents(app: FastifyInstance, db: Database, security: Security) {
    const streams = new Set<ServerResponse>();
    let sequence = 0;
    const change = (op: Operation) => {
        const resources = op.startsWith('destination') || op === 'deliveryFinish' ? ['deliveries'] : ['monitors', 'incidents', 'deliveries'];
        for (const res of streams)
            for (const resource of resources) {
                const message = `id: ${++sequence}\nevent: invalidate\ndata: ${JSON.stringify({
                    version: 1, resource, ids: [], occurredAt: new Date().toISOString()
                })}\n\n`;
                if (res.writableLength + Buffer.byteLength(message) > 65536) {
                    res.destroy();
                    break;
                }
                res.write(message);
            }
    };
    db.changes.add(change);
    app.get('/api/v1/events', async (req, reply) => {
        if (Object.keys(req.query as object).length)
            throw new AppError('VALIDATION_ERROR', 400);
        if (streams.size >= 20)
            throw new AppError('QUEUE_SATURATED', 429);
        const expiry = security.expiresAt(req);
        // Admitted streams send a heartbeat every 15s; ordinary sockets keep 10s.
        req.raw.socket.setTimeout(30000);
        reply.hijack();
        const res = reply.raw;
        res.writeHead(200, {
            'content-type': 'text/event-stream', 'cache-control': 'no-store', 'x-accel-buffering': 'no', 'x-content-type-options': 'nosniff'
        });
        streams.add(res);
        res.write(': connected\n\n');
        const expiration = expiry === null ? null : setTimeout(() => res.end(), Math.max(0, expiry - Date.now()));
        const timer = setInterval(() => {
            const current = security.expiresAt(req);
            if (res.writableLength > 65536 || (current !== null && Date.now() >= current)) {
                res.end();
                return;
            }
            res.write(': heartbeat\n\n');
        }, 15000);
        res.on('close', () => {
            clearInterval(timer);
            if (expiration)
                clearTimeout(expiration);
            streams.delete(res);
        });
    });
    app.addHook('preClose', async () => {
        db.changes.delete(change);
        for (const res of streams)
            res.end();
        streams.clear();
    });
}
