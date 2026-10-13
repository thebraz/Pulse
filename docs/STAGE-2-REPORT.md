# Stage 2 reliability and incident engine

**Status: PASS on the measured Windows platform.** Stage 2 is complete. Stage 3 has not begun; nothing was published, pushed, deployed or released.

## Initial audit and changes

The Stage 1 report and public subsystem contracts were reviewed before implementation. The architecture remains Fastify + shared Zod contracts + a single SQLite worker + one bounded scheduler + Node's pinned HTTP/TLS transport. No runtime dependency was added. Existing application, security, network and persistence behavior is preserved except explicitly documented Stage 2 additions.

The initial unrestricted regression baseline was 89 passed, 1 failed, 0 skipped across 90 tests. Earlier sandbox-only runs could not access required temporary paths/listeners and are not product-regression evidence. The baseline failure was the unchanged Windows ACL probe timing out after five seconds; an isolated measurement took approximately 7.7 seconds. The final fixed probe prefers existing PowerShell 7, falls back to built-in Windows PowerShell when absent, has a ten-second execution bound and rejects remote startup when verification is unavailable. Original permission/startup assertions remain unchanged; actual broad-grant detection and unavailable-probe rejection have additional assertions.

Material gaps/defects addressed:

- Stage 1 always exposed UNKNOWN and had no persisted counters/incidents/coverage/retention. Schema 2 and pure domain functions now implement the accepted transition table without reconstructing old coverage from successful checks.
- The heartbeat readiness probe performed a no-op write. Actual ten-second heartbeats now establish conservative crash boundaries; readiness still probes the write path separately.
- Pending scheduler wakes could be lost during a pump; idle dispatch polled every 250ms even without eligible work. A pending-wake flag and adaptive single timer preserve changes, avoid full-pool polling and retain oldest-due/manual alternation.
- The 1,000-definition cap prevented the requested population test. It is now 10,000 definitions with bounded dispatch and no capacity guarantee.
- A new deletion test exposed cyclic incident cascades temporarily nulling a DOWN projection's required incident anchor. Explicit projection deletion precedes the confirmed owner cascade.
- Actual SQLite page-limit exhaustion can automatically roll back a transaction. Rollback now checks transaction ownership so it cannot hide the original FULL error.
- Shutdown stops new reservations before awaiting maintenance, and remains bounded by the command-process deadline.
- An unexpected executor error could leave an already active pump dispatching more definitions. Both the loop and post-reservation boundary now stop on operational faults; a population regression test asserts only the first execution reaches the faulty adapter.
- A fixed per-hour pruning budget could fall behind sustained traffic. Bounded maintenance groups now continue while backlog remains, yield between transactions and expose backlog diagnostics.
- Development startup missed its unchanged 15-second smoke deadline while compiling under workstation load. Root build now invokes the same two TypeScript projects in their existing order with native incremental caches, eliminating redundant npm wrappers/repeated compilation without relaxing strict checks or startup assertions. Missing generated outputs invalidate the corresponding cache; a real removal/rebuild test checks identical artifacts.

The final accepted decisions are in [ADR-011](specifications/ARCHITECTURAL-DECISIONS.md#adr-011--stage-2-durable-evaluation-coverage-and-bounded-maintenance).

## Incident correctness and scheduler reliability

Each accepted observation commits terminal result, bounded counters, optional transition, incident change, historical slow classification and next due time in one SQLite transaction. Fences reject late cancelled/reconfigured/duplicate completions. A partial unique index permits only one OPEN incident per monitor. Rollback tests inject failure at each transaction step and recovery update. Actual subprocess kills inside and after the incident transaction verify rollback/restart and durable committed state, respectively.

Defaults are three failures, two successful recovery checks, three slow successes and 1000ms degradation latency; every threshold/timing value is independently validated and configurable. UNKNOWN needs evidence; pending failures never establish an outage below the configured threshold. DOWN recovery can become DEGRADED after mixed slow/fast successes. Pause, resume, restart, target-affecting edits and policy blocks reset context without resolving an incident. Rename-only changes preserve health/counters. Flapping in partial recovery retains one incident; unchanged states emit no transition.

Incident onset is the first startedAt in the qualifying failure run, detection the confirming completedAt; observed recovery is the first startedAt in the qualifying success run, resolution its confirming completedAt. These observed boundaries are not exact real-world outage times. Diagnostics are bounded, server-generated safe text with a failure category. Details include raw span duration, delays, resolution information, coverage-clipped downtime/gaps and transition anchors.

Automatic/manual work shares one pool (default 10, maximum 50), coalesces per monitor and alternates classes when both are eligible. Due order is nextDueAt then ID; missed slots are skipped. A slow/failing endpoint gets no priority bonus. The bounded persistent manual queue and optional-read queue protect result bookkeeping. Storage/worker faults stop dispatch and fail readiness; correction/restart is required without infinite retry or a reset database. The canonical directory lock still prevents competing owners and releases on actual forced death.

## Analytics assumptions and retention

UTC half-open ranges select completed counted checks by start time and completion <= asOf. Manual and automatic samples both count; policy blocks, cancellation, abandonment and missing slots do not. Sampled availability is success / (success + failure), returns null when empty and does not certify continuous uptime. Slow successful samples remain successful. Their execution-time classification is persisted; pre-feature successes disclose unavailable classification rather than using later settings.

Successful response-header latency uses exact nearest-rank P50/P95/P99, with raw counts, lowSample and n>=20/n>=100 tail-granularity flags. Insufficient samples remain descriptive, not confidence claims. Failed-check latency is excluded. Mean buckets are weighted through underlying sums/counts. Queries cap counted samples and each historical/coverage source at 100,000 and buckets at 2,000, returning 422 instead of truncating.

Coverage partitions the monitor lifetime into paused, enabled/service-offline, UNKNOWN and known context. Current service coverage ends at server now, crashed runs at their last durable heartbeat, clean runs at stop. Pre-feature/pruned anchors are UNKNOWN and incomplete. Known context between samples is not proof of uninterrupted observation. Incident downtime intersects and unions outage spans with known coverage, excludes pause/offline/UNKNOWN gaps and returns null when known or retained incident evidence is insufficient. Open incidents remain ongoing and can include excluded gaps. No general time-based uptime percentage is emitted.

Raw terminal checks default to 30 days; resolved incidents and coverage/transition history to 365 days. Maintenance deletes at most 1,000 rows per transaction, yields after each worker call, handles at most 20 batches before a short continuation and otherwise runs hourly. Strict cutoff equality survives. OPEN incidents and their coverage/transition anchors are protected; raw evidence links may become null. Required state predecessors and referenced service runs survive cleanup. No automatic VACUUM or disk-reset fallback occurs. Protected history can exceed nominal retention and is disclosed in diagnostics.

## API and files

Implemented persistent incident list/detail/active filters, paginated transition history, monitor health summary, qualified availability/latency/time-series metrics, engine diagnostics and configurable thresholds. Every collection has bounded limits/cursors; range, bucket, numerical and identifier validation use shared schemas. OPEN listing without explicit dates includes old unresolved incidents. Dashboard/SSE/notification resources still require Stage 3.

Created: `apps/server/src/domain/{health,metrics}.ts`; `tests/{state-machine,incident-persistence,metrics-retention,reliability-api,performance,build}.test.ts`; `tests/reliability-helpers.ts`; `tests/fixtures/transaction-crash.mjs`; `scripts/build.mjs`; this report and Stage 2 evidence.

Modified: server persistence migration/store/protocol/database, scheduler, configuration, runtime and API; shared contracts; existing API/persistence/process/helper tests; package scripts and verifier; README and owning specifications/ADR/traceability/acceptance records. The original Stage 1 evidence is preserved. No operator database, public repository, package registry or unrelated project was changed.

## Final verification

Final verification: **161 passed, 0 failed, 0 skipped; 17 files**. All 25 required scenarios and all twelve Stage 2 acceptance criteria are PASS within the measured scope. No unresolved Stage 2 integrity/security blocker remains.

Candidate manifest SHA-256: `f83410d5f5cbb80e1522fba4341ad40aa2405a07f739fde161d6175af1d2d442`. Source immutability was checked before and after the commands. UTC interval: 2026-10-11T13:03:18.707Z through 2026-10-11T13:07:09.837Z. Platform: Windows 10.0.26200 x64, Node v24.19.0, SQLite 3.53.3. No dependency installation/change was necessary in this stage.

| Command | Result |
| --- | --- |
| `npm run typecheck` | PASS |
| `npm run lint` | PASS |
| `npm test -- --reporter=default --reporter=json --outputFile.json=docs/evidence/stage-2-tests.json` | PASS |
| `npm run build` | PASS |

The full test command includes unit, API/database integration, real HTTP/TLS/security, scheduler/reliability, actual process restart/crash, generated-artifact recovery and synthetic performance tests. No separate human/browser/manual execution is claimed.

| Test file | Passed | Failed |
| --- | --- | --- |
| api.test.ts | 5 | 0 |
| build.test.ts | 1 | 0 |
| commands.test.ts | 3 | 0 |
| contracts-config.test.ts | 44 | 0 |
| history.test.ts | 1 | 0 |
| http.test.ts | 11 | 0 |
| incident-persistence.test.ts | 16 | 0 |
| metrics-retention.test.ts | 8 | 0 |
| performance.test.ts | 1 | 0 |
| persistence.test.ts | 7 | 0 |
| process.test.ts | 6 | 0 |
| reliability-api.test.ts | 7 | 0 |
| scheduler.test.ts | 7 | 0 |
| security.test.ts | 7 | 0 |
| snapshot.test.ts | 2 | 0 |
| state-machine.test.ts | 33 | 0 |
| tls-redirect.test.ts | 2 | 0 |

Evidence: [command timestamps and source manifest](evidence/stage-2-verification.json), [command result summary](evidence/stage-2-verification.json), [exact test results](evidence/stage-2-tests.json), [per-criterion acceptance](evidence/stage-2-acceptance.json), [benchmark conditions/results](evidence/stage-2-benchmark.json), and [21 actual index query plans](evidence/stage-2-query-plans.json).

## Final synthetic benchmark

Windows 10.0.26200 x64, 12th Gen Intel(R) Core(TM) i7-1255U, 12 logical CPUs, 16890978304 bytes host RAM; Node v24.19.0, SQLite 3.53.3, local disposable SQLite WAL/FULL database. Shared workstation, competing load uncontrolled. Bulk-seeded 10,000 definitions, 15s interval, 1s configured timeout, pool 10; explicit executor gates supply synthetic successes without internet requests. Twenty selection warm-up queries precede 1,000 measured queries; the pipeline has no warm-up and commits 500 checks.

| Measurement | Actual result |
| --- | --- |
| Definition seed | 1596.89 ms |
| Recovery/initialization | 3375.49 ms |
| Indexed due selection P50 / P95 / P99 | 0.0279 / 0.0792 / 0.2557 ms |
| 500-check pipeline duration | 6996.14 ms |
| Synthetic completed throughput | 71.47 checks/s |
| Peak check concurrency | 10; configured bound 10 |
| RSS before seed / after seed / after processing | 90.55 / 100.08 / 148.51 MiB |
| Event-loop delay P95 / P99, 10ms resolution | 16.73 / 21.33 ms |
| Real internet requests | 0 |

RSS includes Vitest, the runtime and database worker; snapshots do not prove steady-state memory or absence of leaks. The database queue's recorded maximum is sampled at wave barriers, not a continuous high-water mark. Query plans verify indexed due selection and 21 historical/retention/relationship access paths. Small check history, bulk loading and gated synthetic results exclude real DNS/HTTP/TLS latency, saturation duration and millions of retained records. These results are not a production or 10,000-endpoint capacity guarantee.

## Required adversarial scenarios

Every required scenario is PASS in the final immutable-source run. These are controlled automated harnesses using real local boundaries where required; no unrun manual/browser checks are claimed.

| # | Required scenario | Executable evidence | Result |
| --- | --- | --- | --- |
| 1 | Temporary failure followed by recovery | state-machine; incident-persistence transient sequence | PASS |
| 2 | Three failures open one incident | incident-persistence; actual HTTP reliability-api | PASS |
| 3 | Further failures do not duplicate incident | incident-persistence 20 additional failures | PASS |
| 4 | Threshold-confirmed recovery | state-machine; actual HTTP/process recovery | PASS |
| 5 | Flapping | state-machine 1000 partial-recovery cycles | PASS |
| 6 | High-latency DEGRADED | complete state table; actual delayed HTTP recovery; fixed metrics fixture | PASS |
| 7 | Timeout | real HTTP stalled headers; shared redirect deadline | PASS |
| 8 | HTTP/connection failure mix | actual HTTP 500/timeout/socket-reset sequence plus persistence run | PASS |
| 9 | Restart unresolved incident | forced-crash production-process scenario | PASS |
| 10 | Restart in-flight check | forced production-process death; transaction-boundary harness | PASS |
| 11 | Overdue schedule recovery | scheduler clock jump; restart without catch-up replay | PASS |
| 12 | Two monitors fail together | reliability-api two gated concurrent failures | PASS |
| 13 | Concurrency saturation | scheduler shared pool/queue; synthetic pool 10 | PASS |
| 14 | Manual during automatic check | scheduler/API coalescing with identical execution IDs | PASS |
| 15 | Pause DOWN monitor | incident-persistence unresolved lifecycle test | PASS |
| 16 | Resume | preserved incident, UNKNOWN then confirmed recovery | PASS |
| 17 | Fixed-window availability | exact 80%/weighted-bucket fixtures and actual API counts | PASS |
| 18 | Known percentiles | exact 4/5/100-sample nearest-rank fixtures | PASS |
| 19 | Missing/UNKNOWN evidence | empty/policy/cancelled/pre-creation samples; exact coverage gaps | PASS |
| 20 | Retention cleanup | bounded batch/cutoff/protected anchors; real periodic pruning | PASS |
| 21 | SQLite write failure | step triggers, page-limit FULL, query-only READONLY, actual writer BUSY and worker death | PASS |
| 22 | Graceful shutdown under load | gated shared pool + actual production process stop | PASS |
| 23 | Duplicate scheduler prevention | competing actual process; canonical lock; forced-death release | PASS |
| 24 | Unexpected timing/ordering | clock regression, backwards completion rollback, stale/duplicate fences and snapshot cursors | PASS |
| 25 | Large synthetic population | 10,000 definitions, 1000 indexed queries, 500 persisted gated checks | PASS |

## Remaining risks and Stage 4 quality work

The measured platform is Windows x64 with Node 24.19.0/SQLite 3.53.3. Linux, other runtime patches, real HTTPS-proxy operation, true physical disk/filesystem failure and long load/soak tests remain unverified. Fault injection exercises actual SQLite FULL/READONLY/BUSY semantics, not every possible host-storage failure. The hashed loopback lock can fail closed on unrelated port collisions. Windows ACL probe unavailability now rejects remote startup and requires operator correction. SQLite's Node API remains upstream release-candidate functionality.

Synthetic figures describe a short shared-workstation harness with bulk-seeded definitions, a small check history and no real HTTP cost; they are not production-capacity evidence. Stage 4 must verify the reference 100-monitor/4.32-million-history workload, two-hour memory/WAL trends, cross-platform operation, disk recovery, consistent backup/restore, supported upgrade rehearsals, dependency/advisory/license review, exact artifact exclusions and fresh installation. Protected incidents can retain old anchors indefinitely; operators still need storage monitoring. Remote contacts before a crash may be repeated even though local incident commits cannot duplicate. Dashboard, browser verification, SSE and notifications remain separately authorized Stage 3 work.
