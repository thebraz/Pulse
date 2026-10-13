# Pulse performance requirements

These are Stage 4 acceptance targets, not benchmark claims. Stages 1–3 must preserve bounded architecture and add regression checks for their relevant paths. Publish a result only with exact hardware, OS, runtime/SQLite version, configuration, dataset, load profile, warm-up, measurement duration and candidate digest.

Stage 2 includes a separate synthetic 10,000-definition benchmark: one transactional bulk seed, 20 warm-up and 1,000 measured indexed due selections, then 500 controlled successful observations through the real worker/scheduler with concurrency 10. It records seed/recovery time, selection percentiles/query plan, short-run throughput, process RSS snapshots, event-loop delay and observed bounds. It makes zero internet requests and does not establish the reference load, retained-history, real-network or soak budgets below. See [benchmark evidence](../evidence/stage-2-benchmark.json).

## Reference envelope and mandatory budgets

Reference host: at least 2 dedicated logical CPU cores, 4GiB RAM and local SSD, one Pulse process, no intentional competing heavy workloads. Test Linux and Windows supported release targets. Reference load:100 enabled monitors, 60s interval, 10s timeout, pool 10; 95 return headers within 200ms and 5 time out at 10s. Retain 30d of equivalent history (4.32 million checks across 100 monitors) using a deterministic seeded dataset, with 10 browser clients and 2 webhook sends/second at most. Capacity beyond this envelope is unverified unless separately measured.

| Measurement | Mandatory target and method |
| --- | --- |
| Due dispatch lag | P95<=1000ms under reference load, after 5min warm-up and for 30min measurement; measure scheduledAt to startedAt. |
| Event-loop delay | P95<=50ms and P99<=200ms in same run; record monitor sampling resolution. |
| Active resource bounds | Checks<=10, webhook pool<=2, manual queue<=100, DB queue<=1000, SSE<=20 and pending bytes<=64KiB/client with defaults. |
| Read API | P95<=200ms for paginated monitor/history reads, P95<=500ms for dashboard summaries; local API latency excludes client internet/proxy delay. |
| Single-monitor metrics | P95<=1000ms for retained 30d/60s history and <=100000 counted rows; record sorting/allocation cost. |
| Mutation acknowledgment | P95<=250ms for CRUD/reservation under reference load, excluding outbound network completion. |
| SQLite transaction | P95<=50ms for ordinary result commits on reference host; no network wait included. |
| Server memory | Steady RSS including DB worker<=300MiB under reference load; no persistent upward trend in a 2h soak. |
| Startup | Ready within 60s for the reference dataset without pending migrations, including subsequent restarts; separately measure recovery/migration time. |
| Shutdown | <=15s under healthy storage with running checks and deliveries; unsuccessful exit on failed drain. |
| Browser initial transfer | Initial JS<=350KiB gzip, excluding separately lazy-loaded chart/detail chunks; inspect built archive. |
| Browser interaction | P95 search/filter/navigation response<=200ms on a documented midrange machine; avoid long main-thread tasks>200ms. |
| Browser memory | Heap<=100MiB for a 100-monitor overview and one detail chart after 10 route changes; inspect retained listeners/timers. |

Reference request measurement uses at least 1000 observations per API category with concurrency 5, reports P50/P95/P99 and errors, and includes database/cache state. Browser timings distinguish network loading from local interaction and use real built assets. Do not compare unrelated hosts as proof of regression or success. A reproducible smaller baseline may guide development, but it cannot be reported as the mandatory reference result.

On 2026-10-12 the owner explicitly revised only the startup acceptance limit from 10s to 60s, initially deferred further optimization, and subsequently authorized renewed remediation and release. Historical measurements retain their original budgets and results. The timer still includes mandatory writable SQLite integrity/foreign-key validation, recovery and listener readiness; dependency installation, compilation, fixture setup and pending migrations remain separately timed. All other budgets, datasets, durations and security requirements are unchanged. Every measured ordinary start or restart must meet the revised limit; one fast cached start cannot cancel a slower failure. See ADR-020 and the [current release status](../STAGE-4-RELEASE-STATUS.md).

The reference harness verifies and copies an immutable stopped synthetic seed into a controlled temporary directory. Closed startup-rehearsal service runs which begin after the seed's last modeled observation and have no check references are explicitly excluded from that clone's reference model; runs within the historical window, observation links and actual historical gaps remain intact. Otherwise a rehearsal heartbeat later than the modeled checks would move recovery into the future when translated. Any remaining recovery clock beyond the anchor rejects preparation rather than clamping the production clock or inventing coverage. The reused seed's remaining historical timestamps are translated uniformly to the run's current anchor, preserving every observation, ID, relation, duration, ordering and historical coverage interval. Reports disclose the excluded run count. History translation and index maintenance are separately timed preparation; normal runtime retention remains enabled. Reports include actual retained and counted 30-day rows at measurement boundaries, so natural aging during preparation and the run is visible. The original seed is checksummed before and after the run.

Worker telemetry records operation completion timestamps. Measurement selects the actual half-open time window rather than the later message-arrival phase; delayed samples are neither discarded nor relabelled. Webhook reports distinguish controlled offers, domain-generated offers, actual acknowledgments and clock-second receipt peaks. A 500ms injection timer is a workload target, not evidence of two actual sends every second, and yields its slot when a domain notification was just queued. Neither instrumentation nor fixture preparation is imported by the production entry point.

## Saturation, fairness and capacity arithmetic

Average offered execution demand is `sum(meanExecutionSeconds_i / intervalSeconds_i)` occupied slots. If it exceeds the pool, on-time dispatch cannot be promised. For 100 targets all timing out after 10s every 60s, demand 16.67 exceeds pool 10; the overload test must show bounded memory/work, skipped missed slots and fair eventual opportunities, not claim the 1s reference lag budget holds. Failures do not spawn immediate retries or unlimited catch-up jobs.

Run overload with 100 simultaneous slow targets plus manual submissions beyond queue capacity and a failing webhook receiver. Assert documented 429/503 responses, one unsettled check per monitor, oldest-due fairness, no monitoring starvation from delivery jobs and explicit lag diagnostics. Duration 10min is sufficient for bound assertions; use a 2h soak for leak trends. Record actual maximum queue lengths and socket counts, not only final emptiness.

## Storage, query and maintenance limits

Estimate storage with measured bytes per retained check including indexes/WAL: `monitors * 86400/intervalSeconds * days * measuredBytesPerCheck`. At the reference envelope, sample count is 4.32 million; no fixed disk-size promise follows without measurement. Protected open incidents/deliveries can retain anchors beyond nominal limits. Report live DB, WAL and backup sizes separately.

Use index-backed keyset pagination. Inspect query plans on the reference dataset, avoid unbounded scans in overview paths and N+1 database/API queries. Percentiles may sort at most 100000 values per monitor request; never allocate all monitors' raw history in the browser. Retention batches<=1000 rows, yield to result commits and do not block the event loop. Long readers/WAL growth are visible in diagnostics. Automatic full VACUUM and unbounded export are outside scope.

Record unavailable budget results honestly. A failed capacity target requires a bounded root-cause fix or a documented user-approved requirement revision before release; reducing the test dataset without changing the claim is prohibited. See [testing](13-TESTING-STRATEGY.md) and [release](15-RELEASE-AND-DISTRIBUTION.md).
