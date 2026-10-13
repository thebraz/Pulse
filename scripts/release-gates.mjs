import { sameReleaseIdentity } from './release-identity.mjs';
import { reference, startupBudgetMs, startupWithinBudget } from './performance-helpers.mjs';

export const evidenceMatches = (report, identity) => sameReleaseIdentity(report?.releaseIdentity, identity);
export function suitePassed(report, identity) {
    return evidenceMatches(report, identity) && report.sourceUnchangedDuringRun === true && report.total >= 235 && report.files >= 28 && report.passed === report.total && report.failed === 0 && report.skipped === 0;
}
export function browserPassed(report) {
    return report?.stats?.expected === 8 && report.stats.unexpected === 0 && report.stats.flaky === 0 && report.stats.skipped === 0;
}
export function packagePassed(report, identity, archiveSha256) {
    return evidenceMatches(report, identity) && report.candidateUnchangedDuringRun === true && report.candidateSha256 === archiveSha256 && report.passed === 17 && report.failed === 0 && report.results?.length === 17 && report.results.every(item => item.result === 'PASS');
}
export function fullPerformancePassed(report, identity, platform) {
    const budgets = ['startup', 'monitors', 'history', 'summary', 'metrics', 'mutations', 'dispatch', 'transactions', 'eventLoop', 'rss', 'memoryTrend', 'readiness', 'resourceBounds', 'browser', 'webhooks', 'shutdown', 'browserTransfer', 'overload'];
    return evidenceMatches(report, identity) && report.result === 'PASS' && report.diagnostic === false && report.conditions?.os === platform && report.conditions.referenceHostVerified === true && report.conditions.startupBudgetMs === startupBudgetMs && Object.entries(reference).every(([key, value]) => report.conditions[key] === value) && budgets.every(key => report.budgets?.[key] === true) && startupWithinBudget([report.measurements?.startup?.processMs, report.measurements?.overloadStartup?.processMs]) && report.measurements.referenceDurationMs >= reference.measurementMs && report.measurements.referenceObservedDurationMs >= reference.soakMs && report.measurements.referenceLoadDurationMs >= reference.warmupMs + reference.soakMs && report.overload?.durationMs >= reference.overloadMs && ['monitors', 'history', 'summary', 'metrics', 'mutations'].every(key => report.measurements[key]?.count >= reference.apiSamples && report.measurements[key].errors?.length === 0);
}
export function sourcePassed(report, identity) {
    return evidenceMatches(report, identity) && sameReleaseIdentity(report.cleanReleaseIdentity, identity) && report.candidateUnchangedDuringRun === true && report.result === 'PASS' && report.frontendByteReproducibility === 'PASS' && report.frontendDifferences?.length === 0 && report.browser?.passed === 8 && report.browser.failed === 0 && report.browser.flaky === 0 && report.browser.skipped === 0;
}
export function storagePassed(report, identity, scenario) {
    const assertions = report?.assertions;
    return evidenceMatches(report, identity) && report.result === 'PASS' && report.scenario === scenario && report.candidateUnchangedDuringRun === true && report.schemaMigrations?.length === 5 && assertions?.dispatchStopped === true && assertions.noSyntheticDowntime === true && assertions.committedCheckPreserved === true && assertions.committedMonitorPreserved === true && assertions.noUncommittedIncidentOrDelivery === true && assertions.postRestartIntegrity === 'ok' && assertions.foreignKeyViolations === 0 && (scenario === 'readonly' ? report.fault?.startupRejected === true && report.fault.listenerAbsent === true : assertions.uncertainCheckRecoveredAbandoned === true && report.fault?.terminalObservationTransactionFailed === true && report.fault.readinessStatus === 503 && report.fault.liveStatus === 200);
}
export function nginxPassed(report, identity) {
    return evidenceMatches(report, identity) && report.result === 'PASS' && report.candidateUnchangedDuringRun === true && report.checks?.length === 11 && report.checks.every(check => check.result === 'PASS') && report.streams?.length === 20 && report.streams.every(stream => stream.heartbeatReceived === true);
}
