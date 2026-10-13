import type { MonitorInput, Observation, Monitor } from '@pulse/contracts';
export type Health = Monitor['status'] & {
    failures: number;
    successes: number;
    slow: number;
    fast: number;
    failureStart: number | null;
    recoveryStart: number | null;
};
export const initialHealth = (reason: Health['reason'] = 'INITIAL'): Health => ({
    state: 'UNKNOWN', reason, failures: 0, successes: 0, slow: 0, fast: 0, failureStart: null, recoveryStart: null
});
export function evaluate(previous: Health, monitor: MonitorInput, observation: Observation, startedAt: number, open: boolean): {
    health: Health;
    incident: 'open' | 'resolve' | null;
} {
    if (observation.outcome === 'POLICY_BLOCKED')
        return {
            health: initialHealth('POLICY_BLOCKED'), incident: null
        };
    const h = {
        ...previous
    };
    let incident: 'open' | 'resolve' | null = null;
    if (observation.outcome !== 'SUCCESS') {
        h.failures = Math.min(monitor.failureThreshold, h.failures + 1);
        h.failureStart ??= startedAt;
        h.successes = h.slow = h.fast = 0;
        h.recoveryStart = null;
        if (open || h.failures >= monitor.failureThreshold) {
            h.state = 'DOWN';
            h.reason = 'FAILURE_THRESHOLD';
            if (!open)
                incident = 'open';
        }
        else {
            if (h.state === 'UP')
                h.state = 'DEGRADED';
            h.reason = 'PENDING_FAILURE';
        }
    }
    else {
        h.failures = 0;
        h.failureStart = null;
        h.successes = Math.min(monitor.recoveryThreshold, h.successes + 1);
        h.recoveryStart ??= startedAt;
        const slow = observation.durationMs >= monitor.latencyThresholdMs;
        h.slow = slow ? Math.min(monitor.degradationThreshold, h.slow + 1) : 0;
        h.fast = slow ? 0 : Math.min(monitor.recoveryThreshold, h.fast + 1);
        if (open) {
            if (h.successes < monitor.recoveryThreshold)
                h.reason = 'RECOVERING';
            else {
                incident = 'resolve';
                h.state = h.fast >= monitor.recoveryThreshold ? 'UP' : 'DEGRADED';
                h.reason = h.state === 'UP' ? 'HEALTHY' : 'SLOW';
            }
        }
        else if (h.state === 'UNKNOWN') {
            h.state = slow ? 'DEGRADED' : 'UP';
            h.reason = slow ? 'SLOW' : 'HEALTHY';
        }
        else if (h.state === 'UP') {
            if (h.slow >= monitor.degradationThreshold) {
                h.state = 'DEGRADED';
                h.reason = 'SLOW';
            }
            else
                h.reason = 'HEALTHY';
        }
        else if (h.state === 'DEGRADED') {
            if (h.fast >= monitor.recoveryThreshold) {
                h.state = 'UP';
                h.reason = 'HEALTHY';
            }
            else
                h.reason = slow ? 'SLOW' : 'RECOVERING';
        }
    }
    return {
        health: h, incident
    };
}
