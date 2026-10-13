# Pulse architectural decisions

Status legend: Accepted means the design baseline is selected, not implemented or verified. Conditional means a bounded implementation choice still needs evidence. Material changes require a new superseding ADR; do not silently rewrite an accepted decision to conceal an incompatibility. No earlier roadmap files existed in this workspace; allocation below follows the user's four named stages without claiming access to an earlier detailed plan.

## ADR-001 — Single-host TypeScript workspaces

- **Status:** Accepted for Stages 1–4.
- **Context:** Self-hosting and zero mandatory service costs are primary requirements; backend/frontend contracts must stay consistent.
- **Decision:** npm workspaces, strict TypeScript, Fastify server, React/Vite/Tailwind browser and a small public contracts package. One deployable runtime serves API and built UI on the same origin.
- **Alternatives considered:** Independently deployed SPA/API; microservices; external broker/database.
- **Reasoning:** Shared schemas and one operational process reduce drift, cross-origin complexity and installation burden.
- **Consequences:** Import-direction checks and clear domain/adapters are mandatory; frontend cannot import Node infrastructure.
- **Tradeoffs:** One-host capacity and availability limits are explicit; scaling out needs a separate design, not accidental multiple schedulers.

## ADR-002 — Node 24 LTS and SQLite owner thread

- **Status:** Accepted runtime/storage direction; exact patched runtime/API adapter is Conditional until Stage 1 smoke tests.
- **Context:** SQLite must remain simple and local, while synchronous database work must not stall checks/UI API.
- **Decision:** Node 24 LTS, SQLite on local disk, one dedicated database worker owning serialized commands, WAL/FULL synchronization and explicit migrations. Prefer the runtime SQLite facility after verifying supported APIs and patches; introduce an external SQLite adapter only for a demonstrated blocking limitation and record a superseding adapter decision.
- **Alternatives considered:** Main-thread synchronous SQL; native third-party binding as an automatic default; PostgreSQL service; ORM.
- **Reasoning:** The owner worker isolates bounded database latency without adding a distributed component or unnecessary database service.
- **Consequences:** Typed bounded worker commands, worker-fault readiness and cross-platform tests are required. Verify actual SQLite patch fixes in the selected runtime.
- **Tradeoffs:** Message/worker plumbing is real complexity; one serialized writer limits throughput. [Node LTS schedule](https://nodejs.org/en/about/previous-releases) and [SQLite WAL constraints](https://sqlite.org/wal.html) inform this choice.

## ADR-003 — Due-time dispatch and observational semantics

- **Status:** Accepted.
- **Context:** Outages and restarts must not trigger unbounded catch-up or overlapping checks.
- **Decision:** Persist next due times, one unsettled execution per monitor, bounded shared auto/manual pool, oldest-due fairness and skip missed slots. GET/HEAD observations have one total deadline and no automatic network retries.
- **Alternatives considered:** Timer per monitor; in-memory jobs for every missed interval; a distributed queue; exactly-once execution claims.
- **Reasoning:** Small deterministic state is recoverable and honest about crash uncertainty.
- **Consequences:** Execution/revision/epoch fences and actual network tests are mandatory; operators should avoid side-effectful endpoints.
- **Tradeoffs:** Cadence can slip under saturation, and a pre-crash request may be repeated. [Scheduler](06-SCHEDULER-RELIABILITY.md) owns the exact algorithm.

## ADR-004 — Atomic health, incidents and outbox

- **Status:** Accepted.
- **Context:** Duplicate incidents and lost alerts can mislead operators; notifications must not delay monitoring.
- **Decision:** Pure threshold evaluator; one OPEN incident per monitor; result/state/incident/outbox changes commit atomically. Stage 3 adds persistent finite-retry webhook jobs on the existing transaction boundary.
- **Alternatives considered:** One incident per failure; frontend health inference; synchronous send within result processing; ephemeral event bus.
- **Reasoning:** Constraints and transactional enqueueing protect local consistency while separate delivery isolates remote latency.
- **Consequences:** Pause/restart retains incidents but resets health context; receivers deduplicate stable event IDs. No retroactive jobs are generated on Stage 3 migration.
- **Tradeoffs:** More explicit persisted state and recovery logic; finite retries may still fail, and uncertain remote receipt is unavoidable.

## ADR-005 — Qualified metrics and conservative coverage

- **Status:** Accepted.
- **Context:** Sparse samples and Pulse downtime cannot support a continuous-uptime claim.
- **Decision:** Sample-count availability, successful-header latency, exact nearest-rank percentiles under bounded query size, coverage-clipped incident downtime, and null for unavailable denominators. Persist service/enablement/state windows from Stage 2.
- **Alternatives considered:** Treating missing checks as successful; time interpolation; average of bucket percentiles; using incident elapsed wall time as observed downtime.
- **Reasoning:** Operators must see what was observed and what is unknown.
- **Consequences:** API/UI disclose sample sizes, exclusions and source retention boundaries; crash coverage ends conservatively at last durable heartbeat.
- **Tradeoffs:** Extra metadata and explicit unknown states are less visually simple but prevent false certainty. [Metrics](08-METRICS-AND-ANALYTICS.md) is authoritative.

## ADR-006 — Fail-closed egress and remote administration

- **Status:** Accepted.
- **Context:** Monitoring is an SSRF-capable operation; loopback apps are reachable through hostile browser requests.
- **Decision:** Public-only egress by default, all-answer IP classification and actual-address pinning, redirect revalidation, explicit private CIDRs, permanent metadata denial; local Host/Origin protection; authenticated remote HTTPS with session/CSRF controls. Secrets are provisioned as files, not exposed in DTOs.
- **Alternatives considered:** Trusting submitted hostnames, blocking only RFC1918 strings, anonymous LAN bind, browser-held permanent token, encrypted secret-management service.
- **Reasoning:** Controls must apply to real sockets and browser authority without mandatory external infrastructure.
- **Consequences:** Unsupported monitor query credentials/headers and narrow private access are documented; address/lock/ACL adapters require evidence. See [security model](10-SECURITY-MODEL.md).
- **Tradeoffs:** Some legitimate internal/credentialed endpoints require future explicitly approved features; host administrator compromise remains outside isolation guarantees.

## ADR-007 — SSE invalidation and bounded browser state

- **Status:** Accepted protocol; router/cache/chart implementation selection is Conditional until Stage 3.
- **Context:** The dashboard needs fresh data without turning browser messages into another source of truth.
- **Decision:** Same-origin SSE invalidations, refetch on reconnect, 30s visible polling fallback, bounded client buffers and server-state cache. Use schema-driven fetch and accessible dark-first screens.
- **Alternatives considered:** WebSocket command channel; full-state push; durable replay log; ad hoc timer per card.
- **Reasoning:** Invalidation keeps the database/API authoritative and tolerates lost events with a small protocol.
- **Consequences:** Stale state is visible; tests must prove missed-event recovery and local/authenticated SSE modes.
- **Tradeoffs:** Some redundant reads and up to polling-interval freshness after missed signals; no guaranteed real-time delivery.

## ADR-008 — Roadmap gates and private agent instructions

- **Status:** Accepted.
- **Context:** The initial task authorized documentation only. Explicit Stage 1 authorization was subsequently received on 2026-10-09; later stages and public release remain separate acts. Internal coding instructions must not become public package content.
- **Decision:** Stage 1 core/API/security; Stage 2 health/incidents/metrics/recovery; Stage 3 dashboard/SSE/webhooks; Stage 4 hardening/distribution. Each stage requires explicit authorization. Private instructions use a dedicated ignored directory plus local bootstrap, with independent npm/package allowlist inspection.
- **Alternatives considered:** Implementing immediately after specification; moving alerts into foundation; relying solely on Git ignore for packages; excluding all docs.
- **Reasoning:** Keeps scope reviewable, preserves legitimate engineering documentation and prevents accidental publication of private material.
- **Consequences:** Initial implementation criteria remain NOT TESTED; publication requires exact candidate evidence and authorization. Public docs stay in source-release scope.
- **Tradeoffs:** Local ignored instructions need deliberate provisioning for an authorized development checkout; they are not a public contribution prerequisite.

## ADR-009 — MIT intent and immutable release candidate

- **Status:** Accepted distribution intent; owner attribution/namespace and release credentials are release-time inputs.
- **Context:** The project is open source and must remain self-hosted without recurring costs.
- **Decision:** Intended MIT license, tested installable archive, explicit supported-platform matrix, checksum-bound validation and separate publication authorization. Do not invent owner names or claim registry availability.
- **Alternatives considered:** Hosted-only deployment; automatic publication on a passing build; untested source-checkout installation as release proof.
- **Reasoning:** Users need a usable tested artifact and truthful support claims.
- **Consequences:** Fresh install, final archive inspection, backup/restore/upgrade and dependency-license checks gate Stage 4.
- **Tradeoffs:** Release validation costs time; namespace/identity must be resolved by the actual owner before publication. [Release contract](15-RELEASE-AND-DISTRIBUTION.md) is authoritative.

## ADR-010 — Stage 1 adapters and runtime evidence

- **Status:** Accepted for Stage 1; measured Windows scope, not a multi-platform release claim. Completes the bounded adapter choices in ADR-002/006.
- **Decision:** Node.js 24.19.0 with runtime SQLite 3.53.3, synchronous connection isolated in one worker; no ORM/native addon. Zod is the single browser-compatible runtime schema/type representation, decoded directly at the Fastify boundary. Fastify request logging is disabled; only explicit safe-code logs are emitted. ipaddr.js classifies addresses; policy adds permanent metadata denial, narrow private CIDRs and public-port rules. Node HTTP/HTTPS connects to the validated literal address with original Host/SNI and standard certificate/hostname checks.
- **Runtime evidence:** The actual worker reports SQLite 3.53.3 and verifies WAL, FULL and foreign keys. The [Node 24.19.0 release](https://nodejs.org/en/blog/release/v24.19.0) records this SQLite update. [SQLite 3.53.3 release notes](https://www.sqlite.org/releaselog/3_53_3.html) and [WAL constraints](https://www.sqlite.org/wal.html) were consulted. This is adapter smoke/integration evidence, not a complete dependency-security audit or approval to use an outdated runtime at publication time.
- **Lock:** Canonicalize the data directory (case folded on Windows), hash it to a loopback port in 40000–59999 and bind exclusively before opening SQLite. The OS releases it on forced process death. A second owner and an unrelated port collision both fail closed; no PID-file stealing/stale-lock deletion exists. This avoids mandatory native lock dependencies. Different directories may collide and require clearing the conflicting listener or choosing another directory; do not bypass the lock. Windows simultaneous-owner/forced-death tests are mandatory; Linux validation remains a release gate.
- **Snapshot correction:** A durable singleton terminal-commit counter fences terminal history snapshots independently of allocation sequence and millisecond timestamps. Every terminalization advances it in the same transaction. Deletion never resets it. This prevents a previously running check from appearing on a later ascending page under the same timestamp. Public ordering remains sequence-based.
- **Monitor projection:** Add read-only lastCheckAt/lastObservedOutcome from the latest retained completed check. SQL joins retrieve projections together in paginated reads; no duplicate outcome/state is stored on monitors. Health remains UNKNOWN until Stage 2. Public additions are explicit pre-release contract additions, not a new evaluator.
- **ACL:** POSIX owner-only file permissions are checked. Windows remote startup uses a bounded fixed PowerShell ACL query to reject broad readable grants, with no input-derived command code or token arguments. If unavailable, the probe cannot certify ACL protection; administrators must verify permissions. Canonical containment and regular-file/size checks always apply. No notification secret-alias API is introduced before Stage 3.
- **Shutdown:** SIGINT/SIGTERM where delivered, plus the fixed child-process IPC shutdown message for Windows supervisors. The actual built process is exercised with IPC shutdown and forced termination/restart. Linux signal behavior and real remote HTTPS-proxy operation remain unverified.
- **Consequences:** Keep adapter security fixtures, real destination receipt, worker-fault readiness and revision fencing in every affected test run. Exact evidence belongs to the Stage 1 report; later-stage performance, retention, incidents and publication remain outside scope.

## ADR-011 — Stage 2 durable evaluation, coverage and bounded maintenance

- **Status:** Accepted under explicit Stage 2 authorization on 2026-10-11. No Stage 3 or publication authorization is implied.
- **Decision:** Preserve Fastify, shared Zod contracts, the central execution pool, pinned transport and the exclusively owned SQLite worker. Add pure health/interval/percentile functions and checksummed schema version 2. The existing finish transaction owns terminalization, counters, health transition, incident opening/resolution, historical slow classification and due advancement. A partial unique index guarantees one OPEN incident per monitor. Deferred transition links and nullable raw-check links preserve incident history under retention.
- **Lifecycle:** Recovery seeds projections/activity windows at the first Stage 2 initialization, before traffic, using a durable metadata marker. It does not backfill coverage from old successful checks. Crash between schema migration and initialization safely retries initialization. Pause, resume, target-affecting edits, policy blocks and restart reset context without resolving outages. Rename-only edits preserve counters. Repeated identical mutations are no-ops. DOWN owner deletion explicitly removes its projection before cyclic incident cascades, preventing an intermediate null-anchor constraint violation.
- **Timing and coverage:** Ready coverage begins after listener binding; a single maintenance timer persists ten-second heartbeats. Running service coverage ends at query now, crashed coverage at last durable heartbeat, clean coverage at recorded stop. UTC half-open windows and interval unions partition paused/offline/UNKNOWN/known time and clip incident downtime. Sample ratios include manual checks, never fill missing slots and never imply continuous uptime. P95/P99 are computed with explicit n>=20/n>=100 granularity flags. Pre-feature successful checks have an unclassified degradation count; their current configuration cannot rewrite history.
- **Bounded work:** Keep at most one scheduler wake timer, use persisted next-due ordering, wake on changes/capacity, and avoid polling a full pool. A pending wake flag prevents configuration/completion events from being lost during dispatch. Idle wake delay is bounded between 25ms and 10s. Maintenance deletes at most 1,000 rows per transaction, yields after each worker call and processes at most 20 batches before a 100ms continuation when backlog remains. Ordinary maintenance runs hourly. Open incident coverage and transition anchors are protected. Database saturation pauses optional maintenance; actual faults stop dispatch and require correction/restart. SQLite can automatically roll back on FULL; rollback checks isTransaction so the original fault is preserved.
- **Pre-release API changes:** Raise the definition cap from 1,000 to 10,000 for the requested synthetic population; this is not a supported endpoint-capacity claim. Add monitor summary and engine diagnostics resources, 24h/7d/30d metric windows, persistent incident/transition queries, and bounded time-series buckets. OPEN incidents without explicit dates ignore the ordinary 90-day default so old unresolved incidents remain visible. Explicit date ranges retain the 90-day cap. Full internal projection counters remain private.
- **Index evidence:** Timestamp/queue/incident/evidence-link indexes are exercised with actual SQLite EXPLAIN QUERY PLAN. Small partial CANCELLED/ABANDONED indexes avoid scanning all retained checks for diagnostics. No aggregation approximation or new dependency is introduced.
- **Foundation defects:** The Windows fixed ACL probe exceeded its original five-second deadline on this host (measured approximately 7.7 seconds), returning unavailable and failing broad-grant rejection. The fixed Get-Acl script now prefers existing PowerShell 7, falls back to built-in Windows PowerShell only when absent, has a ten-second execution bound and rejects remote startup whenever verification is unavailable. Tests assert actual broad-grant detection and fail-closed unavailable probes. No shell is installed. Root build invokes the same two TypeScript projects in the same order with native incremental caches under node_modules, removing redundant npm wrappers and repeated unchanged compilation after development startup missed its unchanged 15-second smoke deadline. The builder checks every expected JS/map/declaration output and invalidates its cache if one is missing. A real artifact-removal/rebuild test asserts identical restored contents. Strict compiler settings, dependency order and readiness assertions are unchanged.
- **Alternatives rejected:** Replacing the foundation, per-monitor timers, distributed coordination, arbitrary forced states, success-ratio uptime claims, retrospective coverage synthesis, unbounded maintenance and automatic retries after storage faults.
- **Tradeoffs and limits:** Short synthetic benchmarks include test-harness memory and exclude real network latency, large retained histories and sustained load. Protected history can outlive nominal retention. Long-range queries above 100,000 samples or source rows fail with 422. Physical disk/OS failures, Linux, long soak, reference capacity, backup/restore, artifact installation and HTTPS proxy validation remain Stage 4 work. See the [Stage 2 report](../VERIFICATION.md#historical-stage-2).

## ADR-012 — Stage 3 dashboard and persistent webhooks

- **Status:** Accepted within the explicitly authorized Stage 3 prompt; Stage 4 and publication remain excluded.
- **UI:** React/Vite/Tailwind, React Router and TanStack Query meet the required workflow without a second domain engine or generic state framework. D3 shape replaces the suggested Recharts with a small equivalent open-source chart primitive; native semantic controls/dialogs plus shared styled components avoid an extra widget dependency. Exact versions are locked; gzip evidence covers the actual built assets.
- **Live data:** One same-origin cookie-authenticated EventSource invalidates authoritative queries. A 250ms coalescing window, one-second refetch floor and visible 30s fallback bound work. Reconnect/refocus corrects lost messages; streams are not a durable event log.
- **Notifications:** Migration 3 adds a transactional outbox, stable event IDs/bytes, a five-attempt independent pool and per-destination sequence ordering. Current revision changes cancel old jobs. HMAC signing is optional, verification/pinning and secret alias containment are mandatory. Receipt is best effort with possible duplicates after uncertain crash.
- **Requested contract extension:** The supplied Stage 3 prompt explicitly requires a test notification action. Add a fixed notification.test event without monitor/incident/transition fields and a one-minute cooldown, superseding the earlier specification omission without allowing arbitrary payloads.
- **Authentication:** Reuse the existing random operator-token login and HttpOnly sessions rather than introduce passwords or default credentials. API/HTML/SSE guards remain enforced server-side. Remote HTTPS proxy deployment is not validated by local browser evidence and remains a Stage 4 gate.
- **Recovery and retention:** Pending and in-flight deliveries survive restart; uncertain attempts consume budget. Terminal delivery pruning precedes incident pruning and retained jobs protect incident/coverage anchors. Prior migration checksums are unchanged.
- **Limits:** No optional sustained DEGRADED notification, public status page, team management or production capacity claim. Packaging, supported-platform matrix, restore rehearsals and deployment hardening require Stage 4 authorization.

## ADR-013 — Stage 4 runtime distribution and integrity-first startup

- **Status:** Implemented in the unreleased 0.1.0 candidate; publication remains blocked by the recorded release gates.
- **Distribution:** Assemble a separate pulse-http-monitor CLI package from an explicit runtime allowlist. Compile browser/server/contracts once, replace workspace-only import specifiers inside the staged output, and ship a registry-integrity-locked npm shrinkwrap. Installation requires no workspace or development compiler. A separate source archive retains the public specifications, tests and CI while excluding local instructions, data and credentials; historical evidence paths are sanitized in that copy.
- **Persistence location:** Default to the operator's OS home directory plus .pulse, independent of the launch directory. Earlier development installations using ./data must explicitly retain their old absolute PULSE_DATA_DIR; no automatic move, merge or reset occurs.
- **Startup correction:** A 4.32-million-check, 2.14 GB fixture exposed the former ten-second database-worker startup cutoff. Full quick_check and foreign-key validation remain mandatory before readiness. Allow at most ten minutes for worker bootstrap and sixty seconds for the one pre-readiness recovery command; ordinary commands retain their ten-second deadline. This prevents premature termination while preserving finite failure bounds. It does not satisfy or change the separate ten-second reference startup performance target. A failed target still blocks publication.
- **Dashboard correction:** Monitor detail queries unresolved incidents independently of the default 90-day history window and merges by ID, retaining one unresolved historical outage without duplicate rows. The historical window continues to bound resolved-incident history.
- **Verification:** Fake-time worker tests cover slow validation, finite timeout and unchanged ordinary-operation failure. Real prior-schema fixtures preserve observations and exercise rollback; the installed archive exercises monitoring, signed receipt, backup/restore and restart. The large-history rehearsal and all remaining platform/security/performance limitations are recorded in the Stage 4 report.

## ADR-014 — Release remediation at existing trust boundaries

- **Status:** Implemented in the unreleased candidate; failed performance and remaining operational gates still block publication.
- **Startup, historical first remediation:** Retain complete writable SQLite quick_check/FK validation before admission. Bound mapped reads to 64MiB/page cache to 16MiB and combine three check-history clock maxima in one scan, including nullable unfinished rows. Faster read-only validation omits CHECK-expression evaluation and cannot substitute for the required integrity check. That attempt remained above ten seconds. ADR-015/016 subsequently replace the history scan and equivalent CHECK representation while preserving complete validation; no safety deadline or smaller dataset counts as a performance fix.
- **Input isolation:** Decode unsigned pagination dates within ISO years 0000–9999 and enforce bound cursor identity/ranges, returning an expected 400. Normalize peer HTTP status outside 100–599 to null/INVALID_HTTP_STATUS in both transports before strict persistence contracts. These local boundary fixes preserve shared worker failure for actual persistence faults.
- **Build consistency:** Explicit Vite Zod/React/ReactDOM deduplication handles Windows workspace path identity. Explicit Tailwind source discovery excludes generated directories. Clean-source verification treats missing/extra/different browser assets as a release failure and runs the clean build's actual browser journeys.
- **Platform verification:** Windows command launchers and POSIX executable links have different representations. Package verification checks the Windows launcher reference or the canonical POSIX link destination/executable mode plus direct execution, and runs the installed CLI on both. Ubuntu 24.04 userspace execution on WSL2 is recorded explicitly, without claiming native hardware performance or physical fault validation.

## ADR-015 — Indexed recovery and latest-observation probes

- **Status:** Implemented in the unreleased candidate. Full validation and all release budgets remain mandatory.
- **Recovery:** After writable quick_check and full foreign_key_check, derive the exact check clock using the existing terminal-completion index, QUEUED index and each monitor's covering started-time index. Lifecycle constraints prove that every other queued clock is bounded by a started/completed value. No new index, stored clock, data rewrite or asynchronous admission is needed. Five lifecycle regressions and actual 4.32-million-row query plans cover this proof.
- **Overview:** Replace grouped latest-sequence aggregation across retained history with one SQL query containing an indexed maximum probe per selected monitor and rowid lookup. Latest means highest COMPLETED sequence, including failed observations; unsettled/cancelled rows cannot replace it. Monitors without observations retain null latency. The original query took 16,915.79ms and exceeded the ordinary worker deadline; the equivalent probe took 1.51ms on the same fixture with identical results.
- **Evidence:** [Recovery plans](../evidence/stage-4-indexed-recovery.json), [overview comparison](../evidence/stage-4-indexed-overview.json) and release regressions. Isolated component timings do not establish reference-load or startup acceptance.

## ADR-016 — Equivalent persisted CHECK expressions without history rewriting

- **Status:** Implemented as checksummed migration 4 in the unreleased candidate.
- **Cause:** SQLite 3.53.3 writable quick_check constructs temporary IN-list sets inside the row loop for the existing lifecycle/enum CHECKs. Read-only validation omits CHECK expressions and cannot replace it.
- **Decision:** Replace only those constant IN predicates with logically equivalent OR equalities in the exact known checks definition. Use the guarded transactional schema-edit procedure in the persistence specification, preserving the physical table and every index. Original migrations 1–3 remain immutable. Full writable CHECK/FK validation finishes before migration COMMIT and before every ordinary readiness admission.
- **Tradeoff:** Direct schema editing demands stricter controls than ordinary DDL. Exact old SQL, empty-database parse/layout comparisons, exactly-one-row update, schema invalidation, restored defensive controls and full precommit validation are mandatory. Unknown layouts fail closed. A table-copy migration would rewrite 4.32 million rows and every index while risking dependent links without improving the final representation.
- **Verification:** Twenty migration regressions cover all fifteen CHECK corruption cases, FK corruption, NULL/lifecycle equivalence, preserved rowids/sequences/rootpages/links/checksums, unknown schemas and rollback/defensive restoration. Three full starts per platform use the unchanged reference-size history without pending migrations; migration/preflight has a separate timer.

## ADR-017 — Finite SSE timeout above its heartbeat interval

- **Status:** Implemented after real nginx reproduction.
- **Cause and correction:** The ordinary ten-second socket idle timeout terminated SSE before its fifteen-second heartbeat. After authorization, query validation and the twenty-stream admission cap, an SSE socket uses a finite thirty-second idle timeout. Other traffic keeps the ten-second timeout; heartbeat, session expiry, 64KiB backpressure and stream limits remain enforced.
- **Verification:** Real TLS nginx and direct proxy fixtures wait for the actual heartbeat and then observe a committed invalidation. Controlled deployment evidence does not certify an operator's public certificate or external firewall.

## ADR-018 — Covering analytics indexes and bounded metrics

- **Status:** Implemented in unreleased schema 5; full performance acceptance remains required.
- **Cause:** On the retained-history clone, analytics read table pages for each indexed observation. Isolated means were 223.84ms for 30-day metrics, 130.13ms for a fifty-card overview and 335.63ms for the global dashboard; five serialized dashboard requests already exceed the 500ms budget. Raw metric objects and filtered copies drove the process to 355.49MiB. Shared-host timings are diagnostic evidence, not reference-host certification.
- **Decision:** Append migration 5, preserving migrations 1–4. Replace the existing monitor/start prefix and dashboard index with covering forms containing the projection/filter fields. Transfer only four metric fields in one bounded native call with the unchanged 100,001-row sentinel, exact successful durations and bounded bucket accumulators. On the controlled retained-history clone, four-field bulk transfer took 125–187ms versus 292–341ms for per-row iteration over approximately 42,000 observations; these are isolated diagnostic timings. Full history objects and filtered copies remain excluded. No approximate percentiles, truncation, response cache or additional database connection is introduced.
- **Tradeoff:** The indexes use more disk and incur larger commit/index-build work. Migration time, ordinary commit latency, database/WAL sizes, full startup validation and memory must be measured separately on the final candidate. Failed migration steps roll back; startup never admits an incompletely validated database.
- **Verification:** Exact metrics, clipping, outcome/degradation semantics and the accepted 100,000/rejected 100,001 boundary are exercised by persistence/API tests. All prior schema fixtures through 4 upgrade without changing observations. Component timings do not waive the reference, overload or two-hour stability gates.

## ADR-019 — Release validation mappings before admission

- **Status:** Implemented; repeated complete startup and regressions determine acceptance.
- **Cause:** Equivalent CHECK expressions removed temporary-set construction, but a 64MiB mapping still left most of the multi-gigabyte database using synchronous Windows page reads. A later checks-only validation took 251.83s, including 69.27s of system CPU; the disk snapshot showed 8.8MB/s. Shared-host/cache conditions explain why earlier warm starts passed while later starts failed. These are actual validation costs, separate from installation, compilation and migration.
- **Decision:** During mandatory writable quick_check and foreign_key_check, request at most 2,147,418,112 bytes of SQLite mapping, subject to its native compile-time cap. Restore the 64MiB mapping and retain the 16MiB page cache before the constructor returns and before readiness. No read-only substitute, deferred validation, ignored constraint, timeout increase or extra connection is used.
- **Memory and verification:** A controlled complete validation took 7.66s and reduced RSS from 2,205,417,472 to 58,007,552 bytes when unmapped. Startup mapping has a temporary resident cost distinct from the unchanged steady 300MiB budget. Required supported-schema regressions verify that native mapping/cache limits are restored after validation. Ordinary complete starts and migration time are reported separately.
- **Platform boundary:** SQLite maps the leading file region and clamps unsupported requests; it may use ordinary reads beyond the mapping. There is no automatic VACUUM/truncation while mapped. See SQLite's [memory mapping documentation](https://www.sqlite.org/mmap.html). Dedicated-host capacity, sustained load and physical hardware durability remain separate release gates.

## ADR-020 — Owner-approved sixty-second startup requirement

- **Status:** Approved by the owner on 2026-10-12. The owner initially deferred further optimization and subsequently authorized renewed remediation and release; the 60-second limit remains unchanged.
- **Decision:** Change only the reference startup acceptance target from 10,000ms to 60,000ms. Include both the initial process start and measured subsequent restarts. Do not change HTTP/worker safety deadlines, integrity/FK validation, history size, other latency/resource budgets, overload assertions or soak duration.
- **Evidence:** Preserve historical reports with their original ten-second evaluations. In the latest diagnostic, process readiness took 21,154.66ms initially and 75,300.24ms on the overload restart. Re-evaluation against the approved limit passes the initial start and fails the restart. A separate 119,171.28ms quick_check probe is component profiling, not another complete startup measurement. Diagnostic durations cannot establish reference-load acceptance.
- **Release consequence:** The revision is a requirement change, not evidence of a performance improvement or release readiness. PULSE-S4-005 remains blocked by the measured restart and incomplete full reference/soak validation. GitHub/npm authentication and the verified confidential reporting channel are separate from these technical gates. See the [current release status](../VERIFICATION.md#release-status).

## ADR-021 — Sequential page pre-reading before complete validation

- **Status:** Implemented in the release candidate; repeated post-load and supported-platform verification remains mandatory.
- **Problem:** A 2,272,485,376-byte load-mutated database exceeds SQLite's effective 2,147,418,112-byte mapping cap. A later complete writable quick_check took 119,171.28ms, while warm probes on that same controlled clone took 3,080.92ms without pre-reading. Filesystem cache state materially affects validation; the cap alone does not make every restart fast. No global cache flush or artificial host-memory pressure was used, so these component probes do not establish a causal cold-cache comparison.
- **Decision:** For a main database larger than the effective PRAGMA mmap_size, read its complete file sequentially with a reusable 1MiB buffer before full validation. Pre-read any existing WAL too, even for a small main database. The mapping remains capped by SQLite; no entire-file JavaScript allocation or second SQLite connection is introduced. Read failures, premature EOF and size changes fail closed with DATABASE_UNAVAILABLE. Descriptor cleanup is unconditional. The optimization primes filesystem pages; complete writable quick_check and foreign_key_check still determine validity. Ordinary migrations, transactional rollback, recovery ordering, the 16MiB page cache and restoration of mmap_size=64MiB before readiness remain unchanged.
- **Measured scope:** Pre-reading the complete 2.27GB controlled clone took 593.87ms in a warm component probe, followed by quick_check 3,067.10ms and foreign-key validation 522.22ms. Three real process starts with the new candidate reached HTTP readiness in 5,159.89ms, 5,669.27ms and 6,532.32ms, with clean shutdowns and stable compiled digests. These warm starts used the previously load-mutated clone with no pending migration, and are not a full reference-load or cold-cache certification. See [startup evidence](../evidence/stage-4-validation-read-startup.json).
- **Verification boundary:** A fresh post-load restart, the full reference and two-hour stability runs, both supported platforms and the final packaged distribution must still pass. One warm start cannot cancel a slower measured failure. No security check, timing target or storage-fault requirement is waived.

## ADR-022 — Compact keyset batches for exact analytics

- **Status:** Implemented allocation correction, superseding ADR-018's single object-batch transfer; full runtime reference and soak validation remains required.
- **Cause:** The diagnostic process reached 379,256,832 bytes RSS during retained-30d metrics. That RSS belongs to the Pulse process including its SQLite worker; the parent harness and Chromium are separate processes. A controlled component comparison reproduced expansion of the worker's V8 heap capacity from temporary result objects, while main-thread heap and worker external memory remained small. This does not establish a memory leak: retained heap capacity can remain resident after temporary objects are collected.
- **Decision:** Transfer four analytical columns plus the existing sequence key through StatementSync.setReturnArrays(true), at most 4,096 rows per native call. Seek the covering index by `(started_at,sequence)` and keep all batches inside the existing read transaction. The first batch applies the inclusive requested lower time bound; each following composite cursor already proves that bound, so repeating it is omitted to prevent prefix rescans. Reduce the final batch limit to the remaining 100,001-row sentinel. Accept exactly 100,000 counted rows and reject the next row with 422. Preserve every counted predicate, half-open time bound, successful/degraded/unclassified count, weighted bucket value and exact nearest-rank percentile. Only the bounded numeric latency array and bucket accumulators survive between batches; no cache, additional connection or approximate aggregate is introduced.
- **Measured component:** Four fresh worker/process profiles used the same stopped disposable post-load clone, fixed query instant and 42,898 counted observations per request, 40 requests paced at five per second and five idle seconds, without forced GC or cache flushing. All 160 response hashes matched. The original object batch peaked at 277,397,504 bytes process RSS with mean 47.77ms; the selected compact keyset batches peaked at 135,778,304 bytes with mean 25.60ms and P95 40.53ms. A whole compact-array batch reduced CPU but still retained a much larger heap; a repeated original time lower bound caused prefix rescans and was rejected. [Exact component evidence and query plans](../evidence/stage-4-metrics-allocation.json) preserve all four profiles and their limits.
- **Regression and acceptance:** Tests cover more than 4,096 equal timestamps, earlier starts with later allocation sequences, mixed successes/failures and degradation classes, exact bucket sums and percentiles, and the existing 100,000/100,001 boundary. Component timings exclude HTTP, live clients and dispatch load; they do not replace the unchanged 300MiB full-process RSS and two-hour stability requirements.
