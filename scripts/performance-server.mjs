import { monitorEventLoopDelay, performance } from 'node:perf_hooks';
import { BroadcastChannel } from 'node:worker_threads';
import { loadConfig } from '../apps/server/dist/config/config.js';
import { createRuntime } from '../apps/server/dist/runtime/runtime.js';
const loop = monitorEventLoopDelay({ resolution: 10 }), started = performance.now();
const channel = new BroadcastChannel('pulse-performance-' + process.pid);
let phase = 'startup', probe = { transactionSamples: [], operationSamples: [], manualQueued: 0, injectionErrors: 0, enqueued: 0 }, peakQueue = 0, peakActive = 0, peakWebhooks = 0, peakSse = 0, peakSseBytes = 0, peakSockets = 0;
function receiveProbe(data) {
    probe = { ...data, transactionSamples: [...probe.transactionSamples, ...(data.transactionSamples ?? [])], operationSamples: [...probe.operationSamples, ...(data.operationSamples ?? [])] };
}
channel.onmessage = ({ data }) => receiveProbe(data);
const runtime = await createRuntime(await loadConfig()), streams = new Set();
const call = runtime.db.call;
runtime.db.call = function (...args) { const result = call.apply(this, args); peakQueue = Math.max(peakQueue, this.queueLength); return result; };
runtime.api.addHook('preHandler', async (request, reply) => {
    if (request.url !== '/api/v1/events') return;
    const writeHead = reply.raw.writeHead;
    reply.raw.writeHead = function (status, ...args) {
        if (status === 200) { streams.add(this); this.once('close', () => streams.delete(this)); }
        return writeHead.call(this, status, ...args);
    };
});
await runtime.listen(); loop.enable();
process.send?.({ type: 'ready', startupMs: performance.now() - started, sqliteVersion: runtime.sqliteVersion });
const sampleBounds = setInterval(() => {
    peakQueue = Math.max(peakQueue, runtime.db.queueLength); peakActive = Math.max(peakActive, runtime.scheduler.running);
    peakWebhooks = Math.max(peakWebhooks, runtime.deliveries.active.size); peakSse = Math.max(peakSse, streams.size);
    peakSseBytes = Math.max(peakSseBytes, 0, ...[...streams].map(s => s.writableLength));
    peakSockets = Math.max(peakSockets, process.getActiveResourcesInfo().filter(s => s === 'TCPSocketWrap').length);
}, 20);
const timer = setInterval(() => {
    // The main process owns phase boundaries; a delayed worker sample cannot relabel them.
    const mainMemory = process.memoryUsage();
    process.send?.({ type: 'sample', rss: mainMemory.rss, mainMemory, active: runtime.scheduler.running, dbQueue: runtime.db.queueLength, ready: runtime.isReady(), deliveriesHealthy: runtime.deliveries.fault === null, loopP95Ms: loop.percentile(95) / 1e6, loopP99Ms: loop.percentile(99) / 1e6, loopCount: loop.count, ...probe, phase, bounds: { checks: peakActive, databaseQueue: peakQueue, webhookPool: peakWebhooks, sse: peakSse, ssePendingBytes: peakSseBytes, tcpSockets: peakSockets } });
    probe.transactionSamples = []; probe.operationSamples = [];
}, 1000);
process.on('message', async message => {
    // Regression fixtures enter through IPC because BroadcastChannel does not cross processes.
    if (message?.type === 'probe-fixture') { receiveProbe(message.sample); return; }
    if (message?.type === 'phase') { phase = message.phase; loop.reset(); channel.postMessage(message); return; }
    if (message?.type === 'load') { channel.postMessage(message); return; }
    if (message?.type === 'manual-burst') {
        const responses = await Promise.all(message.ids.map(async id => { try { await runtime.scheduler.manual(id); return { status: 202 }; } catch (e) { return { status: e.status ?? 500, code: /^[A-Z_]+$/.test(e.code ?? '') ? e.code : 'UNEXPECTED_ERROR' }; } }));
        process.send?.({ type: 'control-result', id: message.id, responses }); return;
    }
    if (message !== 'shutdown') return;
    clearInterval(timer); clearInterval(sampleBounds); loop.disable(); channel.postMessage({ type: 'stop' }); channel.close();
    try { await runtime.close(); process.disconnect(); } catch { process.exitCode = 1; process.disconnect(); }
});
