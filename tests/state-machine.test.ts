import { describe, it, expect } from 'vitest';
import { evaluate, initialHealth, type Health } from '../apps/server/src/domain/health.js';
import { input, success } from './helpers.js';
import type { Observation } from '@pulse/contracts';
const failure: Observation = {
    ...success, outcome: 'HTTP_ERROR', httpStatus: 500, errorCode: 'UNEXPECTED_STATUS'
};
const observations: Record<string, Observation> = {
    h: success, s: {
        ...success, durationMs: 1000
    }, f: failure, p: {
        ...failure, outcome: 'POLICY_BLOCKED'
    }
};
function run(sequence: string, health = initialHealth(), open = false, thresholds = {}) {
    const states: string[] = [], events: string[] = [];
    let firstFailure: number | null = null, firstRecovery: number | null = null;
    for (const [i, key] of [...sequence].entries()) {
        const result = evaluate(health, {
            ...input(), ...thresholds
        }, observations[key]!, i * 100, open);
        health = result.health;
        states.push(health.state);
        if (result.incident === 'open') {
            open = true;
            firstFailure = health.failureStart;
            events.push('open');
        }
        if (result.incident === 'resolve') {
            open = false;
            firstRecovery = health.recoveryStart;
            events.push('resolve');
        }
    }
    return {
        health, states, events, open, firstFailure, firstRecovery
    };
}
describe('complete deterministic health transition model', () => {
    it.each([
        ['h', ['UP']], ['s', ['DEGRADED']], ['ff', ['UNKNOWN', 'UNKNOWN']], ['fff', ['UNKNOWN', 'UNKNOWN', 'DOWN']],
        ['hff', ['UP', 'DEGRADED', 'DEGRADED']], ['hfff', ['UP', 'DEGRADED', 'DEGRADED', 'DOWN']],
        ['hfhh', ['UP', 'DEGRADED', 'DEGRADED', 'UP']], ['hsss', ['UP', 'UP', 'UP', 'DEGRADED']],
        ['hssshh', ['UP', 'UP', 'UP', 'DEGRADED', 'DEGRADED', 'UP']], ['sh', ['DEGRADED', 'DEGRADED']],
        ['sff', ['DEGRADED', 'DEGRADED', 'DEGRADED']], ['sfff', ['DEGRADED', 'DEGRADED', 'DEGRADED', 'DOWN']],
        ['fffff', ['UNKNOWN', 'UNKNOWN', 'DOWN', 'DOWN', 'DOWN']], ['fffh', ['UNKNOWN', 'UNKNOWN', 'DOWN', 'DOWN']],
        ['fffhh', ['UNKNOWN', 'UNKNOWN', 'DOWN', 'DOWN', 'UP']], ['fffhs', ['UNKNOWN', 'UNKNOWN', 'DOWN', 'DOWN', 'DEGRADED']],
        ['fffss', ['UNKNOWN', 'UNKNOWN', 'DOWN', 'DOWN', 'DEGRADED']], ['fffhfhh', ['UNKNOWN', 'UNKNOWN', 'DOWN', 'DOWN', 'DOWN', 'DOWN', 'UP']],
        ['hpfff', ['UP', 'UNKNOWN', 'UNKNOWN', 'UNKNOWN', 'DOWN']], ['ffh', ['UNKNOWN', 'UNKNOWN', 'UP']],
        ['hsh', ['UP', 'UP', 'UP']], ['hshshs', ['UP', 'UP', 'UP', 'UP', 'UP', 'UP']]
    ] as [
        string,
        string[]
    ][])('sequence %s produces exact states', (sequence, states) => expect(run(sequence).states).toEqual(states));
    it('retained incident after reset reuses outage and requires two successes', () => {
        expect(run('f', initialHealth('RESTARTED'), true)).toMatchObject({
            states: ['DOWN'], events: [], open: true
        });
        expect(run('h', initialHealth('INITIAL'), true)).toMatchObject({
            states: ['UNKNOWN'], events: [], open: true
        });
        expect(run('hh', initialHealth('INITIAL'), true)).toMatchObject({
            states: ['UNKNOWN', 'UP'], events: ['resolve'], open: false
        });
        expect(run('hs', initialHealth('INITIAL'), true).states).toEqual(['UNKNOWN', 'DEGRADED']);
    });
    it('thresholds are independent and support their minimum/maximum', () => {
        expect(run('f', undefined, false, {
            failureThreshold: 1
        }).events).toEqual(['open']);
        expect(run('h', {
            ...initialHealth(), state: 'DOWN'
        } as Health, true, {
            recoveryThreshold: 1
        }).events).toEqual(['resolve']);
        expect(run('f'.repeat(9), undefined, false, {
            failureThreshold: 10
        }).open).toBe(false);
        expect(run('f'.repeat(10), undefined, false, {
            failureThreshold: 10
        }).open).toBe(true);
        expect(run('h'.repeat(9), initialHealth(), true, {
            recoveryThreshold: 10
        }).open).toBe(true);
        expect(run('h'.repeat(10), initialHealth(), true, {
            recoveryThreshold: 10
        }).open).toBe(false);
        expect(run('hs', undefined, false, {
            degradationThreshold: 1
        }).states).toEqual(['UP', 'DEGRADED']);
        expect(run('h' + 's'.repeat(9), undefined, false, {
            degradationThreshold: 10
        }).health.state).toBe('UP');
        expect(run('h' + 's'.repeat(10), undefined, false, {
            degradationThreshold: 10
        }).health.state).toBe('DEGRADED');
        expect(run('h', undefined, false, {
            latencyThresholdMs: 1
        }).health.state).toBe('DEGRADED');
        expect(run('s', undefined, false, {
            latencyThresholdMs: 30000
        }).health.state).toBe('UP');
    });
    it('records onset and uninterrupted recovery starts, not confirmation times', () => {
        expect(run('hfffhfhh')).toMatchObject({
            firstFailure: 100, firstRecovery: 600, events: ['open', 'resolve']
        });
    });
    it('flapping below failure/recovery thresholds cannot emit unlimited incident transitions', () => {
        const r = run('fff' + 'hf'.repeat(1000));
        expect(r.events).toEqual(['open']);
        expect(r.states.filter(s => s !== 'DOWN')).toHaveLength(2);
        expect(r.health.failures).toBeLessThanOrEqual(3);
    });
    it.each(['HTTP_ERROR', 'DNS_ERROR', 'TLS_ERROR', 'CONNECTION_ERROR', 'TIMEOUT', 'REDIRECT_ERROR'] as const)('counts %s consistently', outcome => {
        let h = initialHealth();
        for (let i = 0; i < 3; i++)
            h = evaluate(h, input(), {
                ...failure, outcome
            }, i * 100, false).health;
        expect(h.state).toBe('DOWN');
        expect(h.failureStart).toBe(0);
    });
    it('policy block clears pending counters and preserves an unresolved incident', () => {
        const r = evaluate({
            ...initialHealth(), state: 'DOWN', failures: 3
        }, input(), observations.p!, 400, true);
        expect(r).toEqual({
            health: initialHealth('POLICY_BLOCKED'), incident: null
        });
    });
});
