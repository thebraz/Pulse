import { resolve, dirname, basename } from 'node:path';

export const reference = Object.freeze({ monitors: 100, historyRows: 4320000, warmupMs: 300000, measurementMs: 1800000, soakMs: 7200000, overloadMs: 600000, apiSamples: 1000, apiConcurrency: 5, browserClients: 10, webhookRate: 2 });
export const diagnosticProfile = Object.freeze({ warmupMs: 60000, measurementMs: 180000, soakMs: 210000, overloadMs: 90000, apiSamples: 100 });
export const startupBudgetMs = 60000;
export function startupWithinBudget(trials) {
    return trials.length > 0 && trials.every(ms => Number.isFinite(ms) && ms > 0 && ms <= startupBudgetMs);
}
export function percentiles(values) {
    const sorted = values.filter(Number.isFinite).sort((a, b) => a - b);
    const at = p => sorted.length ? sorted[Math.ceil(sorted.length * p) - 1] : null;
    return { count: sorted.length, p50: at(.5), p95: at(.95), p99: at(.99), max: sorted.at(-1) ?? null };
}
export function fixtureCloneTarget(source, directory, temporaryRoot) {
    const original = resolve(source), clone = resolve(directory);
    if (dirname(clone).toLowerCase() !== resolve(temporaryRoot).toLowerCase() || !basename(clone).startsWith('pulse-reference-') || original.toLowerCase() === resolve(clone, 'pulse.sqlite').toLowerCase()) throw new Error('UNSAFE_BENCHMARK_CLONE');
    return resolve(clone, 'pulse.sqlite');
}
export function memoryTrend(samples) {
    if (samples.length < 8) return { result: 'NOT TESTED', firstQuarterMedianBytes: null, lastQuarterMedianBytes: null, slopeBytesPerSecond: null };
    const width = Math.floor(samples.length / 4), first = percentiles(samples.slice(0, width).map(s => s.rss)).p50, last = percentiles(samples.slice(-width).map(s => s.rss)).p50;
    const t = samples.map(s => s.elapsedMs / 1000), avgT = t.reduce((a, b) => a + b) / t.length, avgR = samples.reduce((a, s) => a + s.rss, 0) / samples.length;
    const denominator = t.reduce((a, x) => a + (x - avgT) ** 2, 0), slope = denominator ? samples.reduce((a, s, i) => a + (t[i] - avgT) * (s.rss - avgR), 0) / denominator : 0;
    return { result: last <= first || slope <= 0 ? 'PASS' : 'FAIL', firstQuarterMedianBytes: first, lastQuarterMedianBytes: last, slopeBytesPerSecond: slope };
}
export function classifyRun(budgets, complete, referenceHostVerified) {
    if (Object.values(budgets).some(v => v === false)) return 'FAIL';
    return complete && referenceHostVerified && Object.values(budgets).every(v => v === true) ? 'PASS' : 'NOT VERIFIED';
}
// Arrival phase is deliberately irrelevant: delayed worker messages retain the
// operation's real half-open completion window rather than being lost or relabelled.
export function operationEvidence(samples, from, to) {
    const operations = {}, transactions = [];
    for (const sample of samples) {
        for (const observed of sample.operationSamples ?? []) {
            if (observed.completedAt < from || observed.completedAt >= to) continue;
            const total = operations[observed.operation] ??= { count: 0, totalMs: 0, maxMs: 0 };
            total.count++; total.totalMs += observed.ms; total.maxMs = Math.max(total.maxMs, observed.ms);
        }
        for (const observed of sample.transactionSamples ?? [])
            if (observed.completedAt >= from && observed.completedAt < to) transactions.push(observed.ms);
    }
    return { operations, transactions: percentiles(transactions) };
}
export function rebaseReferenceHistory(db, anchor) {
    if (!Number.isSafeInteger(anchor) || anchor <= 0) throw new Error('INVALID_REFERENCE_ANCHOR');
    // This helper is used only on the already verified private clone. Reusing an
    // old seed without rebasing falsely benchmarks a large expired-data backlog.
    const latest = db.prepare("SELECT completed_at t FROM checks WHERE lifecycle IN('COMPLETED','CANCELLED','ABANDONED') ORDER BY completed_at DESC LIMIT 1").get();
    if (!latest) throw new Error('REFERENCE_HISTORY_MISSING');
    if (Number(db.prepare('SELECT count(*) n FROM notification_deliveries').get().n)) throw new Error('REFERENCE_FIXTURE_HAS_DELIVERIES');
    const shiftMs = anchor - Number(latest.t);
    const columns = {
        service_runs: ['started_at', 'ready_at', 'last_heartbeat_at', 'stopped_at'],
        monitors: ['created_at', 'updated_at', 'next_due_at'],
        checks: ['queued_at', 'scheduled_at', 'started_at', 'completed_at'],
        reliability_meta: ['coverage_from', 'checks_from', 'incidents_from'],
        monitor_status: ['failure_run_started_at', 'recovery_run_started_at', 'first_observation_at', 'state_changed_at'],
        monitor_activity_windows: ['enabled_at', 'disabled_at'],
        state_transitions: ['occurred_at'],
        incidents: ['opened_at', 'detected_at', 'observed_end_at', 'resolved_at'],
        notification_destinations: ['created_at', 'updated_at']
    };
    db.exec('BEGIN IMMEDIATE');
    let excludedPostHistoryServiceRuns;
    try {
        // The reusable synthetic seed acquired later startup-rehearsal runs with
        // no observations. They lie outside its modeled history, not in a gap
        // within that history; translating them would put recovery in the future.
        excludedPostHistoryServiceRuns = Number(db.prepare('DELETE FROM service_runs WHERE started_at>? AND stopped_at IS NOT NULL AND NOT EXISTS(SELECT 1 FROM checks WHERE service_run_id=service_runs.id)').run(Number(latest.t)).changes);
        for (const [table, fields] of Object.entries(columns))
            db.prepare(`UPDATE ${table} SET ${fields.map(column => `${column}=${column}+?`).join(',')}`).run(...fields.map(() => shiftMs));
        const recoveryClock = Number(db.prepare("SELECT max(t) t FROM (SELECT max(completed_at) t FROM checks WHERE lifecycle IN('COMPLETED','CANCELLED','ABANDONED') UNION ALL SELECT max(queued_at) FROM checks WHERE lifecycle='QUEUED' UNION ALL SELECT max((SELECT max(started_at) FROM checks WHERE monitor_id=monitors.id)) FROM monitors UNION ALL SELECT max(last_heartbeat_at) FROM service_runs UNION ALL SELECT max(updated_at) FROM monitors UNION ALL SELECT max(occurred_at) FROM state_transitions UNION ALL SELECT coverage_from FROM reliability_meta UNION ALL SELECT max(updated_at) FROM notification_destinations UNION ALL SELECT max(updated_at) FROM notification_deliveries)").get().t ?? 0);
        if (recoveryClock > anchor) throw new Error('REFERENCE_FIXTURE_HAS_POST_HISTORY_CLOCKS');
        db.exec('COMMIT');
    } catch (error) { db.exec('ROLLBACK'); throw error; }
    return { anchorUtc: new Date(anchor).toISOString(), shiftMs, originalLatestCompletedAt: Number(latest.t), latestCompletedAt: anchor, excludedPostHistoryServiceRuns, method: 'On the disposable synthetic clone only, exclude closed startup-rehearsal runs after the last modeled observation which have no check references. Preserve all historical runs and observation links, including actual gaps. One common timestamp translation then preserves every observation, duration, ordering, ID, relation and historical coverage interval. Reject any remaining recovery clock beyond the anchor. The original fixture and schema migration metadata are unchanged; normal retention remains enabled.' };
}
export function referenceHistorySnapshot(db, ids, now) {
    const from = now - 30 * 86400000;
    const read = db.prepare("SELECT count(*) n,min(started_at) earliest,max(started_at) latest FROM checks WHERE monitor_id=? AND started_at>=? AND started_at<? AND completed_at<=? AND lifecycle='COMPLETED' AND outcome!='POLICY_BLOCKED'");
    db.exec('BEGIN');
    try {
        const monitors = ids.map(id => {
            const row = read.get(id, from, now, now);
            return { monitorId: id, countedRows: Number(row.n), earliestStartedAt: row.earliest === null ? null : Number(row.earliest), latestStartedAt: row.latest === null ? null : Number(row.latest) };
        });
        return { at: new Date(now).toISOString(), from: new Date(from).toISOString(), retainedRows: Number(db.prepare('SELECT count(*) n FROM checks').get().n), countedRowsIn30d: monitors.reduce((total, monitor) => total + monitor.countedRows, 0), monitors };
    } finally { db.exec('ROLLBACK'); }
}
