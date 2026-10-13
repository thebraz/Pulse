// Benchmark-only preload. Production entry points never import this instrumentation.
import { isMainThread, BroadcastChannel } from 'node:worker_threads';
import { performance } from 'node:perf_hooks';
import { randomUUID } from 'node:crypto';
if (!isMainThread) {
    const { Store } = await import('../apps/server/dist/persistence/store.js');
    const channel = new BroadcastChannel('pulse-performance-' + process.pid);
    const execute = Store.prototype.execute, transaction = Store.prototype.tx;
    const context = { store: null };
    let current = '', timer, phase = 'startup', transactionSamples = [], operationSamples = [], errors = 0, enqueued = 0, domainOffered = 0, firstEnqueuedAt = null, lastEnqueuedAt = null, firstOfferedAt = null, lastOfferedAt = null, offeredSecond = null, offeredInSecond = 0, maximumOfferedPerClockSecond = 0, lastDeliverySequence = 0, peakManualQueued = 0;
    function offered(at) {
        firstOfferedAt = firstOfferedAt === null ? at : Math.min(firstOfferedAt, at); lastOfferedAt = Math.max(lastOfferedAt ?? at, at);
        const second = Math.floor(at / 1000);
        offeredInSecond = second === offeredSecond ? offeredInSecond + 1 : 1; offeredSecond = second;
        maximumOfferedPerClockSecond = Math.max(maximumOfferedPerClockSecond, offeredInSecond);
    }
    Store.prototype.execute = function (op, input) {
        context.store = this; current = op; const start = performance.now();
        try { return execute.call(this, op, input); } finally {
            operationSamples.push({ operation: op, completedAt: Date.now(), ms: performance.now() - start });
            if (op === 'manual') peakManualQueued = Math.max(peakManualQueued, Number(this.db.prepare("SELECT count(*) n FROM checks WHERE lifecycle='QUEUED' AND trigger='manual'").get().n));
            current = '';
        }
    };
    Store.prototype.tx = function (fn) {
        const start = performance.now();
        try { return transaction.call(this, fn); }
        finally { if (current === 'finish') transactionSamples.push({ completedAt: Date.now(), ms: performance.now() - start }); }
    };
    channel.onmessage = ({ data }) => {
        // Worker messages can arrive after a long SQLite call. Phase changes must
        // never discard completed work; the reporter selects by completion time.
        if (data.type === 'phase') phase = data.phase;
        if (data.type === 'load') {
            clearInterval(timer);
            if (!data.enabled) return;
            if (!/^[a-f0-9-]{36}$/.test(data.destinationId)) { errors++; return; }
            lastDeliverySequence = Number(context.store.db.prepare('SELECT coalesce(max(sequence),0) n FROM notification_deliveries').get().n);
            // Seed the offered workload in the existing SQLite owner; transport and retries remain unchanged.
            timer = setInterval(() => {
                try {
                    const store = context.store;
                    const destination = store.db.prepare('SELECT revision FROM notification_destinations WHERE id=? AND enabled=1').get(data.destinationId);
                    if (!destination) throw new Error('BENCHMARK_DESTINATION_MISSING');
                    const now = Date.now(), eventId = randomUUID(), payload = JSON.stringify({ version: 1, eventId, type: 'notification.test', occurredAt: new Date(now).toISOString() });
                    const domain = store.db.prepare('SELECT sequence,created_at FROM notification_deliveries WHERE destination_id=? AND sequence>? ORDER BY sequence').all(data.destinationId, lastDeliverySequence);
                    for (const delivery of domain) { lastDeliverySequence = Number(delivery.sequence); domainOffered++; offered(Number(delivery.created_at)); }
                    // Real incident events consume a workload slot; never throttle or
                    // suppress the production outbox merely to preserve fixture cadence.
                    if (lastOfferedAt !== null && now - lastOfferedAt < 500) return;
                    const inserted = store.db.prepare("INSERT INTO notification_deliveries(id,event_id,destination_id,destination_revision,event_type,payload_json,state,next_attempt_at,created_at,updated_at) VALUES(?,?,?,?,'notification.test',?,'PENDING',?,?,?)").run(randomUUID(), eventId, data.destinationId, destination.revision, payload, now, now, now);
                    lastDeliverySequence = Number(inserted.lastInsertRowid);
                    enqueued++; firstEnqueuedAt ??= now; lastEnqueuedAt = now; offered(now);
                } catch { errors++; }
            }, 500);
        }
        if (data.type === 'stop') { clearInterval(timer); clearInterval(telemetry); channel.close(); }
    };
    const telemetry = setInterval(() => {
        const store = context.store;
        if (!store?.db.isOpen) return;
        try {
            const queued = store.db.prepare("SELECT count(*) n FROM checks WHERE lifecycle='QUEUED' AND trigger='manual'").get().n;
            peakManualQueued = Math.max(peakManualQueued, Number(queued));
            channel.postMessage({ phase, observedAt: Date.now(), workerMemory: process.memoryUsage(), transactionSamples, operationSamples, manualQueued: Number(queued), peakManualQueued, injectionErrors: errors, enqueued, domainOffered, firstEnqueuedAt, lastEnqueuedAt, firstOfferedAt, lastOfferedAt, maximumOfferedPerClockSecond });
            transactionSamples = []; operationSamples = [];
        } catch { errors++; }
    }, 1000);
    telemetry.unref(); channel.unref();
}
