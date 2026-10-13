# Stage 2 — Reliability & Incident Engine

## 1. Objective

Make durable checks produce trustworthy health, incidents and qualified historical analytics under concurrency, restart and storage faults. Stage 2 starts only after explicit authorization and Stage 1 evidence review.

## 2. Allowed scope

UNKNOWN/UP/DEGRADED/DOWN evaluator, threshold runs, transactional incident processing, coverage windows, sampled/latency/downtime metrics, bounded retention, restart hardening, fairness/backpressure and safe diagnostics. Extend existing core rather than replace it.

## 3. Explicitly excluded scope

No React dashboard, SSE, webhook enqueue/send, email/SaaS integrations, package publication, distributed scheduling or automatic Stage 3. Notification transaction extension is reserved architecturally but no phantom notification evidence is created.

## 4. Dependencies on previous stages

Stage 1 executable contracts, persistent execution IDs/fences, secure transport and passing applicable tests. Read [scheduler](../specifications/06-SCHEDULER-RELIABILITY.md), [state machine](../specifications/07-INCIDENT-STATE-MACHINE.md), [metrics](../specifications/08-METRICS-AND-ANALYTICS.md) and [database](../specifications/09-DATABASE-AND-PERSISTENCE.md). Resolve incompatible foundation behavior before layering health on it.

## 5. Features to implement

Pure evaluator/counters, one unresolved incident per monitor, transition history, incident API, historical metrics with coverage/retention qualifiers, persisted service heartbeat and enablement windows, restart reconciliation, protected bounded pruning and aggregate queue/fault diagnostics.

## 6. Architecture requirements

All accepted-result effects share one SQLite transaction. Enforce uniqueness/foreign keys plus revision/epoch checks; no domain decisions in SQL routes or UI. Seed Stage 2 projections/windows at migration time without fabricated prior observation coverage. Reserve the existing transaction boundary for future Stage 3 outbox insertion. Keep one scheduler and database owner.

## 7. Detailed functional behavior

Apply the complete transition table with defaults F=3, R=2, D=3 and L=1000; failures below F remain pending, latency-only degradation opens no incident, and recovery requires R successes. Incident onset/recovery use first starts in qualifying runs; detection/resolution use confirming completions. Pause/restart/edit resets health to UNKNOWN and preserves unresolved incident. Metrics use counted samples, successful header latency, nearest-rank percentiles and coverage intersections; missing denominators return null. Hourly bounded retention protects open/pending evidence and coverage anchors.

## 8. Failure and edge cases

Handle min/max thresholds, flapping, mixed slow/fast recovery, retained incident after pause/restart, stale results, transaction failure at every step, crash between network/commit, forward/backward wall-clock changes, empty history, retained-only anchors, all-timeout saturation, full/read-only disk and dead database worker. No duplicate incident, fabricated latency, reset database or missing-sample success is allowed.

## 9. Security requirements

Carry forward all Stage 1 auth/egress/secrets controls. POLICY_BLOCKED is a configuration/security obstruction, not target-failure evidence. New filters/analytics queries use validated range/sample caps and allowlisted SQL. Operational logs expose safe codes/counts/IDs, not raw URLs/DNS answers. Protected retention cannot be bypassed to conceal disk faults.

## 10. Mandatory automated tests

Every transition-table row and important forbidden condition; state/counter/incident/outbox-reserved rollback; uniqueness and duplicate completion; exact worked metrics, gap partitions, nearest-rank and boundary/retention cases; migration from Stage 1; kill/restart at reservation and commit boundaries; manual/auto fairness, bounded queues and storage/worker faults. Run applicable Stage 1 regression suites, including actual transport/security and shutdown.

## 11. Manual acceptance tests

1. Make a controlled target fail three checks; verify one incident, first-failure onset and third-completion detection.
2. Recover twice, including a mixed slow/fast case; verify same-incident resolution and final health classification.
3. Pause during an open incident, restart Pulse, resume and recover; verify preserved incident and excluded observation gaps.
4. Query a seeded history with known failures/latencies; compare counts, 80% fixture availability and percentile values to stored records.
5. Advance retention time on a disposable dataset; verify expired terminal rows are removed and protected records/anchors survive.
6. Cause controlled storage failure; verify unready state and paused dispatch while original database/history remains intact.

## 12. Definition of Done

Real durable scenarios and pure tests agree with the authoritative state/metric contracts. No duplicate open incident, misleading coverage or unbounded recovery exists. Stage 1 regressions and new required checks pass with exact evidence; updated docs reflect actual supported behavior.

## 13. Deliverables

Evaluator/incident/analytics modules, Stage 2 migration, retention/coverage/recovery logic, query APIs, deterministic and real subprocess tests, safe diagnostics, updated specifications/ADRs and Stage 2 evidence.

## 14. Exit criteria

PASS for PULSE-S2-001 through PULSE-S2-012 in [acceptance criteria](../specifications/ACCEPTANCE-CRITERIA.md) plus applicable Stage 1 regressions. No unresolved integrity/security blocker. Stage 3 is separately authorized and does not begin automatically.

## 15. Known technical risks

Backdated incident onset vs detection, recovering retained incidents across UNKNOWN gaps, transaction/fence ordering, conservative crash coverage, index/retention cost and disk fault reproduction. Use actual on-disk evidence; mocked repository success cannot close these risks.
