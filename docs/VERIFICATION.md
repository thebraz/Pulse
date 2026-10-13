# Verification and engineering history

## Release status

Pulse [v0.1.0-beta.1](https://github.com/thebraz/Pulse/releases/tag/v0.1.0-beta.1) is a published experimental GitHub pre-release. It is not published on npm and is not recommended for critical monitoring. The [beta guide](guides/BETA.md) defines its separate acceptance policy and known limitations. Future stable performance acceptance remains incomplete; no historical failure is reclassified by this documentation.

The [beta verification](evidence/stage-4-beta-verification.json) records 256 automated tests, eight browser journeys and 17 installed-package scenarios on each recorded Windows and Ubuntu 24.04 userspace/WSL2 environment. These are historical release results, not tests performed by reading this document. Native Linux hardware capacity, macOS/ARM, physical power loss, production proxy deployment and a two-hour soak are not certified.

The final beta archive SHA-256 is `4679613261559f6f72a626686091329f0fe113e059263ff80cc97598fb25261a`. The [final install](evidence/stage-4-beta-final-install.json) and [artifact delta](evidence/stage-4-beta-artifact-delta.json) distinguish the final guide-only archive change from the earlier full package rehearsal. Documentation changes in later commits do not change the bytes of that published archive.

The initial tag CI passed Ubuntu but failed one of 256 Windows tests: its occupied-HTTP-port fixture used an unprobed child data directory. The [fixture correction](evidence/stage-4-windows-ci-fixture-fix.json) preserves the failed run and real-listener reproduction. Commit [119dcd3](https://github.com/thebraz/Pulse/commit/119dcd37d9407bd57836d0d84dc360c1e9ac1a8f) corrected only the test fixture and documentation. [Subsequent hosted CI](https://github.com/thebraz/Pulse/actions/runs/38439573865) passed Windows and Ubuntu. The original tag and uploaded archives retain their original bytes.

## Reproduce verification

Use Node 24.19.0 and npm 11.6.4. Run from a fresh checkout with writable temporary storage and loopback access:

```sh
npm ci --ignore-scripts
npm run typecheck
npm run lint
npm test
npx playwright install chromium
npm run test:e2e
npm run test:package
npm run test:hygiene
```

Package verification installs the built archive into an isolated prefix and exercises the CLI, real HTTP checks, incidents/recovery, actual signed webhook receipts, restart and backup/restore. Hygiene checks require public specifications and stage contracts in source archives while excluding credentials, operator data and private instructions. Tests can regenerate files under `docs/evidence/`; review those outputs separately from historical evidence before committing.

The full retained-history performance command and the distinct `--diagnostic` and `--beta` profiles are described in the [README](../README.md#running-tests) and [beta guide](guides/BETA.md). A short diagnostic cannot pass the stable profile. Use a controlled stopped reference copy and an exclusive host; never substitute an operator database or infer full-profile results from unit tests.

## Historical Stage 1

Foundation/backend verification on Windows x64, Node 24.19.0 and SQLite 3.53.3 recorded **90 passed, zero failed or skipped**, across 11 files, on 2026-10-09. That candidate implemented secure HTTP checks, scheduling, CRUD, history, revisions, persistence and recovery; health remained UNKNOWN until the reliability stage.

Retained evidence: [command/source manifest](evidence/stage-1-verification.json), [test results](evidence/stage-1-tests.json), [per-criterion acceptance](evidence/stage-1-acceptance.json). Module boundaries and adapters are preserved in [architecture](specifications/02-SYSTEM-ARCHITECTURE.md) and [ADR-010](specifications/ARCHITECTURAL-DECISIONS.md#adr-010--stage-1-adapters-and-runtime-evidence).

## Historical Stage 2

Reliability verification on the same recorded Windows/Node/SQLite platform recorded **161 passed, zero failed or skipped**, across 17 files, on 2026-10-11. It covered atomic observation/health/incident commits, threshold confirmation, crash recovery, coverage-qualified metrics, bounded retention and scheduler faults. The 25 required scenarios and twelve acceptance rows are retained in [acceptance evidence](evidence/stage-2-acceptance.json), alongside the [source/command manifest](evidence/stage-2-verification.json) and [test results](evidence/stage-2-tests.json).

The [synthetic benchmark](evidence/stage-2-benchmark.json) used 10,000 bulk-seeded definitions, 20 selection warmups, 1,000 measured selections and 500 gated completions at concurrency ten. It excluded real internet latency, large retained history and sustained saturation; it is not a production throughput guarantee. [Query plans](evidence/stage-2-query-plans.json) were regenerated during the subsequent precheck, so they are not immutable Stage 2 run evidence. Incident, analytics and retention semantics remain in their owning [specifications](specifications/).

## Historical Stage 3

Dashboard/webhook verification on Windows x64, Node 24.19.0, SQLite 3.53.3 and Chromium recorded **182 automated tests and seven browser journeys**, with no failures, on 2026-10-11. Three separate operational scenarios exercised actual signed receipt, credential rotation and offline sign-out. Responsive screenshots at 360/768/1440 widths, accessible controls and the 139.0KiB all-JavaScript gzip measurement describe this historical candidate only.

Retained evidence: [source/command/artifact manifest](evidence/stage-3-verification.json), [tests](evidence/stage-3-tests.json), [browser journeys](evidence/stage-3-browser.json), [operational checks](evidence/stage-3-operations.json), [bundle](evidence/stage-3-bundle.json), [acceptance/scenario matrix](evidence/stage-3-acceptance.json), [synthetic benchmark](evidence/stage-3-benchmark.json) and [query plans](evidence/stage-3-query-plans.json). Screenshots remain in [evidence](evidence/).

Automatic notifications cover confirmed incident opening/recovery, not a separate sustained-DEGRADED event. The fixed `notification.test` event, immutable outbox, signing, finite retries and possible duplicate delivery are documented in the [webhook guide](guides/WEBHOOKS.md) and notification contract. Observed screen sizes and automated accessibility checks do not establish an exhaustive screen-reader/browser audit.

## Historical stable candidate

The former Stage 4 implementation, remediation, startup and closeout reports described several superseded candidates. Their reusable technical material is covered here, in the public guides and in the [architectural decisions](specifications/ARCHITECTURAL-DECISIONS.md); structured measurements and failures remain under [evidence](evidence/). The acceptance ledger retains its stable statuses and original budgets.

The original retained-history fixture contained 100 monitors and 4,320,000 checks. A 318.50-second complete Windows startup failed the then-current ten-second target. Later warm runs below ten seconds did not erase a subsequent 75.30-second restart. The startup target was explicitly revised to 60 seconds in ADR-020; subsequent short diagnostics measured 25.96/23.34 seconds but did not establish the full load or two-hour soak. See [original performance failure](evidence/stage-4-performance.json), [phased startup](evidence/stage-4-remediation-startup-final.json), [warm Windows trials](evidence/stage-4-structural-startup.json), [warm Ubuntu trials](evidence/stage-4-linux-structural-startup.json), [requirement evaluation](evidence/stage-4-startup-requirement.json) and [preserved diagnostic](evidence/stage-4-performance-diagnostic-2026-10-12-170859.json).

Technical changes retained complete writable SQLite integrity and foreign-key checks before readiness: equivalent schema-4 CHECK expressions, indexed recovery and overview projections, covering analytics indexes, temporary validation mapping and bounded sequential database/WAL reads. Preparation/migration timings stay separate from ordinary startup. These changes are described in ADR-015 through ADR-021 and the [persistence contract](specifications/09-DATABASE-AND-PERSISTENCE.md). Recovery never resets a database; older backup deliveries can repeat and require receiver deduplication.

Earlier clean-source builds exposed duplicate Zod module identity through Windows path casing and CSS discovery outside declared sources. Explicit Vite deduplication and bounded Tailwind discovery addressed those differences; exact server/contracts/browser comparison remains enforced by `scripts/test-source.mjs`. [Clean-source evidence](evidence/stage-4-source-install.json) retains the measured candidate identity and browser results.

Security remediation addressed out-of-range cursor timestamps and unsupported HTTP peer statuses before they could fault persistence/readiness. [Security execution](evidence/stage-4-remediation-security.json) and the [original review](evidence/stage-4-final-security.json) retain their original scope, findings, remediation status and attribution. A focused later review is recorded in [beta live review](evidence/stage-4-beta-live-review.json); it is not a new exhaustive scan. Point-in-time [dependency](evidence/stage-4-dependencies.json), [production advisory](evidence/stage-4-production-audit.json) and [license](evidence/stage-4-licenses.json) records do not certify permanent security.

Isolated [storage-full](evidence/stage-4-storage-full.json), [read-only](evidence/stage-4-storage-readonly.json), [kernel I/O fault](evidence/stage-4-storage-ioerr.json) and [controlled nginx/TLS](evidence/stage-4-nginx-proxy.json) rehearsals retain their candidate/platform scope. They do not certify physical power loss or a production deployment. Earlier archive/install counts and platform checks remain in the [stable verification manifest](evidence/stage-4-verification.json), not as approval of later candidate bytes. Historical account/publication snapshots, including [pre-publication status](evidence/stage-4-publication.json), are dated evidence; the published beta linked above supersedes their repository-availability claims.

## Beta performance boundaries

The [final beta verification](evidence/stage-4-beta-verification.json) records 13.21-second startup, 12.12-second restart, approximately 15 minutes of observed load, 90 seconds of overload and 392.4MiB peak RSS on the recorded Windows fixture. Full post-load integrity returned `ok` with zero foreign-key violations. The original [before-fix](evidence/stage-4-beta-performance-windows-before-live-fix.json) and [final raw performance](evidence/stage-4-beta-performance-windows.json) reports are retained.

The conservative RSS-trend diagnostic remains FAIL: final-window quarter medians rose from 367.3 to 391.6MiB. Experimental acceptance disclosed that trend within the 400MiB beta budget; it does not waive the stable zero-growth rule or establish absence of long-term leaks. Stable latency, browser long tasks and overload fairness still fail. Separate tabs can duplicate overview queries, and checks/alerts can be delayed. Stable readiness and a two-hour soak are not claimed.
