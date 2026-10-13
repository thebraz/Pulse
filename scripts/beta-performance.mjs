import { memoryTrend, startupWithinBudget } from './performance-helpers.mjs';

// Experimental policy only; the stable reference profile and budgets are unchanged.
export const betaProfile = Object.freeze({ warmupMs: 60000, measurementMs: 180000, soakMs: 900000, overloadMs: 90000, apiSamples: 100 });
export function evaluateBetaPerformance(report) {
    const steady = report.samples.filter(s => ['reference-measurement', 'soak'].includes(s.phase));
    const all = [...steady, ...report.overloadSamples];
    const end = steady.at(-1)?.elapsedMs ?? 0;
    const tail = steady.filter(s => s.elapsedMs >= end - 600000);
    const trend = memoryTrend(tail);
    const peakRssBytes = Math.max(0, ...all.map(s => s.rss));
    const checks = {
        complete: !report.failure && report.measurements.referenceObservedDurationMs >= betaProfile.soakMs && report.overload?.durationMs >= betaProfile.overloadMs && steady.length >= 600 && tail.length >= 300,
        startup: startupWithinBudget([report.measurements.startup?.processMs, report.measurements.overloadStartup?.processMs]),
        memory: all.length > 0 && all.every(s => Number.isFinite(s.rss) && s.rss > 0) && peakRssBytes <= 400 * 1024 ** 2 && trend.result === 'PASS',
        readWriteFlows: ['monitors', 'history', 'summary', 'metrics', 'mutations'].every(name => report.measurements[name]?.count >= betaProfile.apiSamples && report.measurements[name]?.errors.length === 0),
        resources: all.length > 0 && all.every(s => s.ready && s.deliveriesHealthy && s.bounds.checks <= 10 && s.bounds.webhookPool <= 2 && s.bounds.databaseQueue <= 1000 && s.manualQueued <= 100 && s.bounds.sse <= 20 && s.bounds.ssePendingBytes <= 65536),
        browser: report.browser.clients === 10 && report.browser.errors.length === 0 && report.browser.interactions.length >= 100,
        webhooks: report.budgets.webhooks === true,
        shutdown: report.budgets.shutdown === true && report.measurements.overloadShutdown?.exitCode === 0 && report.measurements.overloadShutdown?.ms <= 15000,
        integrity: report.betaIntegrity?.integrity === 'ok' && report.betaIntegrity?.foreignKeyViolations === 0 && report.overload?.maximumUnsettledDuplicates === 0
    };
    return { result: Object.values(checks).every(Boolean) ? 'PASS' : 'FAIL', policy: 'v0.1.0-beta.1 only; not stable acceptance', checks, peakRssBytes, tailMemoryTrend: trend, tailWindowMs: 600000, limitations: 'A 15-minute load observation and 90-second overload do not establish long-term stability, capacity or production suitability. Stable latency, fairness and overload failures remain recorded.' };
}
