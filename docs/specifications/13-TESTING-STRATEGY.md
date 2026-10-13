# Pulse testing strategy

Vitest covers pure logic and integration harnesses; Playwright covers browser workflows from Stage 3. Strict TypeScript, runtime schema validation and import-boundary checks are mandatory from Stage 1. Tests verify observable contracts and real failure modes, not implementation-shaped assertions. [Traceability](REQUIREMENTS-TRACEABILITY.md) links every mandatory behavior to its minimum verification category.

## Required suites and fixtures

| Suite | Mandatory evidence | First stage |
| --- | --- | --- |
| Unit | Validator boundaries, outcome classification, due-time formula, later counters/transitions, interval unions, exact metric fixtures and backoff | 1, expanded 2–3 |
| API integration | Real Fastify listener, shared schemas, CRUD/revisions, manual execution polling, safe errors, auth/Origin/Host/limits and history pagination | 1 |
| Database | Temporary on-disk SQLite, foreign keys/checks/indexes, migrations, rollback and read-after-write; no memory-only substitute for WAL behavior | 1 |
| Scheduler/concurrency | Fake clock dispatch plus real async executor gates, manual/auto races, pause/edit/delete, bound checks, fairness and no overlap | 1, hardened 2 |
| Security | Adversarial URL/IP/DNS/redirect/TLS tests, actual connected address, private policy, secret canaries, SQL/XSS and browser-origin tests | 1, expanded 3–4 |
| Incident/analytics | Complete transition-table fixtures, default and min/max thresholds, sparse/empty metrics, coverage/retention boundaries | 2 |
| Restart | Subprocess kill at reservation, response/commit boundary, incident/outbox transaction and delivery receipt; assert reopened disk state | 2, expanded 3–4 |
| Notification integration | Real receiver exact bytes/HMAC/event IDs, retries/permanent failures, per-destination order, crash uncertainty and saturation independence | 3 |
| Frontend | Component accessibility, forms/conflicts, safe errors, stale states, filters and metric formatting using shared DTO fixtures | 3 |
| End-to-end | Browser to real API to actual fixture target and database; create, fail, recover, pause, reload, investigate and notify | 3 |
| Package installation | Build exact archive; clean unpack/install/start; actual target check, assets/API/auth, restart, upgrade and exclusions | 4 |
| Performance/faults | Reference workload, overload, query plans, memory/latency/lag, full/read-only disk and backup/restore | 4 |

Use temporary per-test directories and ephemeral loopback ports. Fixture destinations are allowed only by a test-instance private CIDR policy; do not weaken public-only production defaults. Certificates/DNS responses are controlled; tests do not depend on public internet services or real credentials. Generated fake secrets must be clearly non-production canaries. Tests never touch an operator's database or unrelated project.

For an occupied-API-port startup test, hold the API listener first, then allocate the actual data directory through the lock-probed temporary-fixture helper. Probing a parent directory does not validate a child directory: each canonical path hashes to its own lock port, which can be occupied or unavailable on Windows. Preserve the strict STARTUP_FAILED assertion; an earlier DATA_DIRECTORY_LOCKED exit does not test API binding. Tests of competing owners and crash recovery retain their exact data directory and must never retry or bypass its production lock.

## Determinism and mock boundaries

Inject monotonic/UTC clocks and deterministic ID sources into pure services. Fake timers test scheduling/backoff without sleeping minutes. Use explicit promise barriers for races, seeded generated schedules for concurrency and one terminal assertion after all work settles. Never rely only on arbitrary sleeps. A real-signal subprocess harness is still required because fake timers cannot prove process shutdown/restart or OS lock behavior.

Mocks are acceptable for pure evaluators, UI loading/error fixtures and fault injection at controlled adapter boundaries. They cannot prove DNS pinning, actual webhook receipt, SQLite rollback/WAL, cross-platform locks, cookie/CSRF behavior, installation or browser-to-backend integration. At least one real integration test must cover each such boundary. Use safe transport stubs to simulate difficult network errors in addition to actual socket fixtures, and identify what was simulated.

Test uncertainty explicitly: killing after a network send can result in duplicate external contact, but must not create duplicate local terminal commits/open incidents. Receiver deduplication verifies stable eventId; it does not prove exactly-once delivery. Stage 1 health remains UNKNOWN; do not fabricate Stage 2 incident results in Stage 1 tests.

## Quality gates and failure handling

Required Stage 1 commands are defined in the root manifest: `npm ci`, `npm run typecheck`, `npm run lint`, `npm test`, `npm run build`. Stage 2 adds focused `npm run test:reliability` and synthetic `npm run test:performance`; both are included in the complete test suite. Stage 3 adds `npm run test:e2e`; Stage 4 adds package and reference-capacity verification. `npm test` builds the actual worker/runtime before Vitest. Suites are individually selectable by test file. Actual commands, digests, outcomes and platform are in the [Stage 1 report](../STAGE-1-REPORT.md) and [Stage 2 report](../STAGE-2-REPORT.md). Current `npm run verify` writes Stage 2 evidence and preserves Stage 1 files.

No implicit any, unchecked public input, swallowed exceptions, fire-and-forget unbounded work, hardcoded real secrets, weakening assertions to obtain green results, unrelated refactors or speculative dependency frameworks. Coverage percentage is a diagnostic, not a substitute for meaningful branch/invariant tests. A new nontrivial rule needs a test of its externally meaningful outcome; trivial reversible documentation edits do not require fabricated application tests.

On failure, preserve sanitized reproduction/evidence, fix the root cause and rerun the affected suite plus appropriate integration boundary. Expand testing only when the change or unresolved concern justifies it. A test that cannot execute is NOT TESTED or BLOCKED with the actual reason, never PASS. Build/typecheck alone is insufficient for runtime acceptance. A sandbox permission failure must be distinguished from an application defect using the actual error and authorized rerun where appropriate.

## Evidence and stage sign-off

For every acceptance criterion record exact revision/artifact digest, platform/runtime, fixture dataset, command/test names, UTC timestamp, expected/actual result and sanitized report path. Manual checks record the actual action and observed outcome, not a restated expected behavior. The final changed candidate is the tested candidate; changes after validation invalidate affected evidence. Existing implementation results carry forward only with identified revision and continued relevance.

The [acceptance ledger](ACCEPTANCE-CRITERIA.md) remains NOT TESTED until evidence exists. Stage exit requires its rows and applicable previous-stage regression rows to pass, specifications/ADRs to match implementation, and critical blockers to be resolved. Completing one stage never authorizes the next stage or public release.

## Documentation validation

Inspect every Markdown file; resolve all relative links/anchors; validate unique requirement/acceptance IDs and full traceability; parse all illustrative JSON; check complete stage sections, terminology, numerical worked examples and protected private paths. Parse/render Mermaid with an already available trusted tool if possible; if none exists, inspect structure manually and report the parser limitation. Do not install dependencies or run development servers merely to validate this documentation task.

## Stage 3 execution

`npm run verify` records an immutable source manifest and runs strict typechecking, lint/boundaries, all Vitest tests, production build and real Playwright journeys. `npm run test:e2e` uses the installed Playwright Chromium; install it locally with `npx playwright install chromium` when preparing a development machine. Tests start isolated backend subprocesses, loopback targets/receivers and temporary databases/secret files. No third-party site or paid account is contacted. The test suite writes stage-3-prefixed reports. The original Stage 2 test/source manifests remain intact; its query-plan sidecar was regenerated during the initial regression precheck and is explicitly marked as such. Current query plans have their own Stage 3 evidence.

Browser checks exercise 360/768/1440 widths, keyboard operations, Axe serious/critical violations and 200% zoom, plus screenshots for visual inspection. Accessibility evidence is bounded to those checks; it does not claim a manual screen-reader audit. Notification tests verify signed bytes, transaction rollback, stable IDs, actual failures, finite retry scheduling, uncertainty and independent monitor progress. Stage 4 supported Linux/remote-proxy/long-soak/package rehearsal remains untested.
