import { expect, it } from 'vitest';
// @ts-expect-error Native executable release helper.
import { betaProfile, evaluateBetaPerformance } from '../scripts/beta-performance.mjs';
// @ts-expect-error Native executable release helper.
import { reference } from '../scripts/performance-helpers.mjs';

function report() {
    const sample = (i: number) => ({ phase: 'soak', elapsedMs: i * 1000, rss: 320 * 1024 ** 2, ready: true, deliveriesHealthy: true, bounds: { checks: 10, webhookPool: 2, databaseQueue: 10, sse: 10, ssePendingBytes: 100 }, manualQueued: 0 });
    return { samples: Array.from({ length: 901 }, (_, i) => sample(i)), overloadSamples: [sample(0)], measurements: { referenceObservedDurationMs: 900000, startup: { processMs: 60000 }, overloadStartup: { processMs: 59000 }, overloadShutdown: { exitCode: 0, ms: 100 }, ...Object.fromEntries(['monitors', 'history', 'summary', 'metrics', 'mutations'].map(n => [n, { count: 100, errors: [] }])) }, overload: { durationMs: 90000, maximumUnsettledDuplicates: 0 }, browser: { clients: 10, errors: [], interactions: Array(100).fill({}) }, budgets: { webhooks: true, shutdown: true }, betaIntegrity: { integrity: 'ok', foreignKeyViolations: 0 } };
}
it('keeps beta policy separate from unchanged stable criteria', () => {
    expect(reference.soakMs).toBe(7200000);
    expect(reference.measurementMs).toBe(1800000);
    expect(betaProfile.soakMs).toBe(900000);
    expect(evaluateBetaPerformance(report()).result).toBe('PASS');
});
it('rejects missing duration, samples and a start beyond sixty seconds', () => {
    const r = report(); r.measurements.startup.processMs = 60001;
    expect(evaluateBetaPerformance(r).checks.startup).toBe(false);
    r.measurements.referenceObservedDurationMs = 899999;
    expect(evaluateBetaPerformance(r).checks.complete).toBe(false);
    r.samples = [];
    expect(evaluateBetaPerformance(r).result).toBe('FAIL');
});
it('rejects peaks beyond 400 MiB and continued tail growth', () => {
    const r = report(); r.overloadSamples[0]!.rss = 400 * 1024 ** 2 + 1;
    expect(evaluateBetaPerformance(r).checks.memory).toBe(false);
    r.overloadSamples = [];
    r.samples.forEach((s, i) => { s.rss += i * 1024; });
    expect(evaluateBetaPerformance(r).checks.memory).toBe(false);
});
it('retains critical integrity, foreign-key and resource gates', () => {
    const r = report(); r.betaIntegrity.foreignKeyViolations = 1;
    expect(evaluateBetaPerformance(r).checks.integrity).toBe(false);
    r.samples[50]!.ready = false;
    expect(evaluateBetaPerformance(r).checks.resources).toBe(false);
});
it('does not waive basic flow failures as latency limitations', () => {
    const r = report(); r.browser.errors.push('PAGE_ERROR' as never);
    expect(evaluateBetaPerformance(r).checks.browser).toBe(false);
    r.budgets.webhooks = false;
    expect(evaluateBetaPerformance(r).result).toBe('FAIL');
});
