import { expect, it } from 'vitest';
// @ts-expect-error Native ESM release tools are intentionally JavaScript.
import { evidenceMatches, suitePassed, browserPassed, packagePassed, fullPerformancePassed } from '../scripts/release-gates.mjs';
// @ts-expect-error Native ESM benchmark contract is intentionally JavaScript.
import { reference } from '../scripts/performance-helpers.mjs';
const identity = { runtimeSourceDigest: 'a'.repeat(64), compiledDigest: 'b'.repeat(64), testSuiteDigest: 'c'.repeat(64) };
it('rejects passing historical reports when any candidate or validation bytes changed', () => {
    for (const key of Object.keys(identity)) expect(evidenceMatches({ result: 'PASS', releaseIdentity: { ...identity, [key]: 'd'.repeat(64) } }, identity)).toBe(false);
    expect(evidenceMatches({ result: 'PASS' }, identity)).toBe(false);
    const suite = { releaseIdentity: identity, sourceUnchangedDuringRun: true, total: 235, passed: 235, failed: 0, skipped: 0, files: 28 };
    expect(suitePassed(suite, identity)).toBe(true);
    expect(suitePassed({ ...suite, sourceUnchangedDuringRun: false }, identity)).toBe(false);
    expect(suitePassed({ ...suite, total: 236, skipped: 1 }, identity)).toBe(false);
});
it('requires the same installed archive and all eight non-flaky browser journeys', () => {
    const archive = 'e'.repeat(64), installed = { releaseIdentity: identity, candidateUnchangedDuringRun: true, candidateSha256: archive, passed: 17, failed: 0, results: Array.from({ length: 17 }, () => ({ result: 'PASS' })) };
    expect(packagePassed(installed, identity, archive)).toBe(true);
    expect(packagePassed(installed, identity, 'f'.repeat(64))).toBe(false);
    expect(packagePassed({ ...installed, results: installed.results.slice(1) }, identity, archive)).toBe(false);
    expect(browserPassed({ stats: { expected: 8, unexpected: 0, flaky: 0, skipped: 0 } })).toBe(true);
    expect(browserPassed({ stats: { expected: 8, unexpected: 0, flaky: 1, skipped: 0 } })).toBe(false);
});
it('cannot certify a diagnostic, incomplete soak or missing required performance budget', () => {
    const names = ['startup', 'monitors', 'history', 'summary', 'metrics', 'mutations', 'dispatch', 'transactions', 'eventLoop', 'rss', 'memoryTrend', 'readiness', 'resourceBounds', 'browser', 'webhooks', 'shutdown', 'browserTransfer', 'overload'];
    const report = { releaseIdentity: identity, result: 'PASS', diagnostic: false, conditions: { ...reference, os: 'win32', startupBudgetMs: 60000, referenceHostVerified: true }, budgets: Object.fromEntries(names.map(name => [name, true])), measurements: { startup: { processMs: 30000 }, overloadStartup: { processMs: 59999 }, referenceDurationMs: reference.measurementMs, referenceObservedDurationMs: reference.soakMs, referenceLoadDurationMs: reference.warmupMs + reference.soakMs, ...Object.fromEntries(['monitors', 'history', 'summary', 'metrics', 'mutations'].map(name => [name, { count: 1000, errors: [] }])) }, overload: { durationMs: reference.overloadMs } };
    expect(fullPerformancePassed(report, identity, 'win32')).toBe(true);
    expect(fullPerformancePassed({ ...report, diagnostic: true }, identity, 'win32')).toBe(false);
    expect(fullPerformancePassed({ ...report, budgets: { ...report.budgets, transactions: undefined } }, identity, 'win32')).toBe(false);
    expect(fullPerformancePassed({ ...report, measurements: { ...report.measurements, referenceObservedDurationMs: 30000 } }, identity, 'win32')).toBe(false);
    expect(fullPerformancePassed({ ...report, measurements: { ...report.measurements, overloadStartup: { processMs: 60000.01 } } }, identity, 'win32')).toBe(false);
});
