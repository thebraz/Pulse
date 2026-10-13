export type Interval = readonly [
    number,
    number
];
export function union(intervals: readonly Interval[]): Interval[] {
    const sorted = intervals.filter(([a, b]) => b > a).map(([a, b]) => [a, b] as [
        number,
        number
    ]).sort((a, b) => a[0] - b[0]);
    const result: [
        number,
        number
    ][] = [];
    for (const [a, b] of sorted) {
        const last = result.at(-1);
        if (last && a <= last[1])
            last[1] = Math.max(last[1], b);
        else
            result.push([a, b]);
    }
    return result;
}
export function intersect(a: readonly Interval[], b: readonly Interval[]): Interval[] {
    const left = union(a), right = union(b), result: Interval[] = [];
    let i = 0, j = 0;
    while (i < left.length && j < right.length) {
        const x = left[i]!, y = right[j]!, start = Math.max(x[0], y[0]), end = Math.min(x[1], y[1]);
        if (end > start)
            result.push([start, end]);
        if (x[1] < y[1])
            i++;
        else
            j++;
    }
    return result;
}
export const measure = (intervals: readonly Interval[]) => union(intervals).reduce((n, [a, b]) => n + b - a, 0);
export function latency(values: number[]) {
    const sorted = [...values].sort((a, b) => a - b), n = sorted.length;
    const percentile = (p: number) => n ? sorted[Math.max(0, Math.ceil(p * n) - 1)]! : null;
    return {
        count: n, meanMs: n ? sorted.reduce((a, b) => a + b, 0) / n : null, minMs: n ? sorted[0]! : null,
        maxMs: n ? sorted[n - 1]! : null, p50Ms: percentile(.5), p95Ms: percentile(.95), p99Ms: percentile(.99),
        method: 'nearest-rank' as const, lowSample: n < 100, p95Sufficient: n >= 20, p99Sufficient: n >= 100
    };
}
