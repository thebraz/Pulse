# Pulse metrics and analytics

Stage 2 implements these semantics. Metrics describe observations from one Pulse instance, not continuous or global availability. Every response includes its window, asOf, counts, coverage and retention limitations. UI labels and webhook durations must use these same definitions.

Implementation details are recorded in [ADR-011](ARCHITECTURAL-DECISIONS.md#adr-011--stage-2-durable-evaluation-coverage-and-bounded-maintenance). `degradedCount` counts successful checks at or above their execution-time latency threshold, persisted without rewriting old checks when settings change. Pre-Stage-2 successes increment `unclassifiedDegradationCount` because their historical threshold classification is unavailable. Degraded is a subset of successful, never failed. Explicit `p95Sufficient`/`p99Sufficient` flags use 20/100 samples; low-sample percentiles remain descriptive values. Each coverage/history source is capped at 100,000 rows; queries above this cap return 422, never silently omit records.

## Sample selection and availability

The SQLite owner transfers the four analytical fields plus sequence in compact arrays of at most 4,096 rows, seeking the covering index by `(started_at, sequence)` inside one read snapshot. A subsequent batch uses that composite cursor as its lower bound, preserving equal timestamps and observations whose allocation order differs from start order. Only successful numeric durations survive between batches for exact nearest-rank sorting, together with at most 2,000 bucket accumulators; full history objects and filtered copies are excluded. The total transfer still stops at the unchanged 100,001-row sentinel: 100,000 counted samples are accepted exactly, while the next sample rejects the entire query with 422. Small native batches avoid per-row JavaScript/native crossings and large temporary object allocations. Migration 5 provides covering indexes for monitor analytics and global dashboard aggregation without changing counted predicates or stored observations. [Allocation profiling](../evidence/stage-4-metrics-allocation.json) and ADR-022 explain the correction; final reference-load measurement must still establish the 300MiB process RSS bound.

Use UTC half-open windows W=[from, to). Include counted COMPLETED checks whose startedAt belongs to W, completedAt <= asOf and whose row still exists. A completion after `to` may count if its start is inside W and completion is known by asOf. Exclude CANCELLED, ABANDONED, unsettled, stale-revision discarded and POLICY_BLOCKED attempts. Manual and automatic checks both count; the API must disclose this, because repeated manual checks can bias the sample. Never insert successes to fill missing schedule slots.

Let S be SUCCESS count and F be the sum of counted failed outcomes. `N = S + F`. Sampled availability is `100*S/N` if N>0; otherwise null. It is a percentage of observations, with no time weighting. Failures below the incident threshold still reduce sampled availability. DEGRADED slow successes remain successful samples. An UNKNOWN projection does not invalidate counted checks that preceded threshold detection.

Return raw precision as a finite JSON number; round for UI display only (normally 2 decimals). Never emit NaN or Infinity. Counts and window limits are validated before division. A 100% result with one sample must visibly disclose n=1 and cannot be called continuous uptime.

## Successful latency and percentiles

Latency summaries use durationMs from SUCCESS checks only. Failed attempts remain available in raw history but are not pooled into successful response latency. For n successful durations x1..xn:

```text
mean = sum(xi)/n
min = minimum(xi)
max = maximum(xi)
sorted values a1 <= ... <= an
nearest-rank percentile P(p) = a[max(1, ceil(p*n))], with 0 < p <= 1
P50 uses p=0.50; P95 uses p=0.95; P99 uses p=0.99
```

For n=0 all latency values are null and count=0. For n=1 every percentile equals that value; it is valid but not statistically representative. Do not interpolate or average bucket percentiles. Exact raw samples are used within the query cap; a future approximate algorithm requires a new contract and method metadata. `method="nearest-rank"`; `lowSample=true` if n<100. UI also notes P95 needs at least 20 and P99 at least 100 observations for minimally useful tail granularity; these are granularity warnings, not confidence guarantees.

## Coverage partition and observed downtime

Record service runs (readyAt through stoppedAt, or last durable heartbeat after a crash) and monitor enabled windows. Record health transitions sufficient to reconstruct known vs UNKNOWN intervals. An active healthy process can use server now as its open service-run end; after crash the end is conservatively lastHeartbeatAt, not restart time. Heartbeat defaults to 10s, so crash observation coverage can undercount by up to one heartbeat plus persistence delay. Do not bridge the service-offline gap.

Restrict W to the monitor lifetime (from createdAt); return effectiveFrom=min(to,max(from,createdAt)) and effectiveTo=to. This yields an empty effective window when to precedes creation. Return the effective lifetime window as metadata. Partition this effective window with precedence:

1. Paused: monitor disabled, regardless of service operation.
2. Service offline: enabled but no covered service-run interval.
3. UNKNOWN: enabled and service covered, but health context is UNKNOWN or its historical anchor is unavailable.
4. Known: enabled, service covered, reconstructible UP/DEGRADED/DOWN state.

`eligibleMs = effectiveWindowMs - pausedMs`. `knownMs + unknownMs + serviceOfflineMs = eligibleMs`. Intervals outside retained coverage are classified UNKNOWN with `incomplete=true`, never counted as observed downtime. Periods before monitor creation are outside the denominator and reported separately as notApplicableMs. The partition must remain nonnegative and sum exactly in integer milliseconds.

For each incident, observed outage span is [openedAt, observedEndAt) for RESOLVED, or [openedAt, asOf) for OPEN. Intersect with W and the known coverage set C, then union all intersections before summing:

```text
observedDowntimeMs = measure(union(incidentSpan_i intersect W intersect C))
```

Return null when knownMs=0 or incident history needed for the window is unavailable; return 0 when known coverage exists and complete retained evidence shows no outage. Detection latency can leave the first failed samples in UNKNOWN/UP/DEGRADED; this metric deliberately measures threshold-defined incidents only where coverage exists. It is not equivalent to failed-sample percentage. No overall time-based uptime percentage is exposed in v1; if later added, its denominator and excluded coverage must be explicit.

UNKNOWN is not DOWN. Paused/service-offline time is neither target uptime nor target downtime. Open incidents persist across pause/restart, but those gaps contribute no observed downtime. A slow service has successful availability samples and may be DEGRADED without any incident downtime.

Missing schedule slots add no samples. Known health between samples describes the persisted evaluator context during operation, not uninterrupted request observation. Before Stage 2's coverage inception or after coverage pruning, unavailable activity anchors are conservatively UNKNOWN and incomplete, not evidence of enablement or health. Incident details can use protected coverage for their one retained incident even when general incident-history retention makes broader metrics incomplete.

incidentCount is the number of distinct retained incidents whose observed outage spans have nonempty intersection with W, including an open incident that began before W. It is not the count of failed checks or incidents detected during W. Mark incomplete incident history with the retention disclosure rather than representing the count as exhaustive.

## Incident durations and historical retention

For a resolved incident, raw observed span duration is max(0, observedEndAt-openedAt). Detection delay is detectedAt-openedAt. Resolution confirmation delay is resolvedAt-observedEndAt. For an open incident, raw elapsed span is max(0, asOf-openedAt), explicitly labelled ongoing and potentially containing gaps. The incident detail view also returns coverage-clipped observedDowntimeMs and excludedGapMs for that span. `resolvedAt-openedAt` must not be labelled outage duration because it includes recovery confirmation delay.

Check retention, incident retention and coverage retention differ. Metrics include `retention:{checksFrom,incidentsFrom,coverageFrom}` (timestamps/null), plus the conservative `coverage.retainedFrom=max(incidentsFrom,coverageFrom)` and incomplete flag. Sampled metrics use only retained checks and report `sampleWindowIncomplete` when W begins before checksFrom. Coverage/incident calculations may remain valid for older periods where both histories exist. A retainedFrom value is the supported lower boundary, not proof that samples actually occurred there. Empty fresh databases return null boundaries and null summaries. Ranges outside monitor lifetime return zero effective time and null summaries, not synthetic uptime.

Default windows in UI are 1h, 24h, 7d, 30d. API explicit ranges are at most 90d and 100,000 counted samples per monitor. Bucket choice must stay within 2,000 buckets. Boundary buckets clip to W. Empty buckets contain count 0 and null availability/mean latency. Aggregate mean must weight bucket sums/counts; it is never the arithmetic mean of differently sized bucket means.

## Worked fixtures and expected results

| Fixture | Expected result |
| --- | --- |
| 4 successes with latency [100, 200, 300, 1000], 1 TIMEOUT | N=5, S=4, F=1, sampled availability 80%; successful mean 400, min 100, max 1000, P50=200, P95=1000, P99=1000, lowSample=true. |
| Success latency [10, 20, 30, 40, 50] | Mean 30; P50=30, P95=50, P99=50. |
| No counted checks; one cancelled and one policy-blocked | N=0; availability null; latency count 0 and all values null. |
| A single successful 125ms sample | Availability 100%, all latency summaries 125, lowSample=true; no continuous-uptime claim. |
| Check starts exactly from, completes within asOf | Included. |
| Check starts exactly to | Excluded. |
| W=60min, paused 10, serviceOffline 10, UNKNOWN 5 | eligible 50min, known 35min; partition sums 60min. |
| In preceding window, raw incident span 25min intersects known coverage 15min | observedDowntime 900000ms; gaps do not count; no inferred downtime in missing 20min of eligible coverage. |
| Incident opens 09:00, detected 09:02, first recovery 09:10, resolved 09:11 | Raw observed span 600000ms, detection delay 120000ms, confirmation delay 60000ms. |
| Bucket A: one 100ms success; B: three 300ms successes | Overall mean 250ms, not 200ms. |

Unit tests must assert exact integer coverage arithmetic, approximate finite floating arithmetic where necessary, day/timezone boundaries in UTC, clock correction, overlapping interval union, open incidents, retention cuts and enabled-state gaps. Integration tests must compare API summaries to actual stored fixtures, not mocked response bodies.

## Stage 3 chart coverage

Every metrics bucket now includes `knownMs`, the server-computed intersection with existing known covered-health intervals. It does not count samples or fill monitoring gaps. The dashboard requests at most 169 hourly buckets for seven days or 91 daily buckets for a custom range. Charts break paths across uncovered/partial buckets, while isolated dots disclose partial coverage. Aggregate values retain the original backend sample and interval semantics.
