# Stage 1 implementation report

**Status: PASS on the measured Windows platform.** Foundation and monitoring backend completed. Stage 2 has not begun. No publication, deployment, push or release was performed.

## Candidate and verification

Source/specification manifest SHA-256: `dbe408355f25af4ab1eb43ff1a46ed630c54c761caf9889da5c2b9853e59b4bb`.

Final verification: 2026-10-09, 20:50:46–20:52:06 UTC; Windows 10.0.26200 x64, Node.js 24.19.0, SQLite 3.53.3. See [exact command timestamps and manifest](evidence/stage-1-verification.json), [command result summary](evidence/stage-1-verification.json), [Vitest results](evidence/stage-1-tests.json) and [per-criterion evidence](evidence/stage-1-acceptance.json). The digest covers public source, tests, scripts, configuration and specifications; mutable acceptance/evidence/report files and generated builds are excluded to avoid circular references. The final build succeeded from the tested source.

| Command | Actual result |
| --- | --- |
| npm ci | PASS; audit reported 0 known vulnerabilities at execution time. This is not an independent security audit. |
| npm run typecheck | PASS; strict contracts, server and test types. |
| npm run lint | PASS; ESLint and workspace dependency boundaries. |
| npm test | PASS; **90 passed, 0 failed, 0 skipped; 11 files**. |
| npm run build | PASS; contracts and actual server/worker output. |
| npm start / npm run dev | PASS; real listener, target receipt and persisted observation. Dev also reloaded after a worker change and retained its monitor. |
| npm run example | PASS; real local 200/500 target with a configurable fixture port. |

## Architecture and functionality

Two directed npm workspaces: browser-compatible Zod contracts and a Fastify server. Application services coordinate changes; one SQLite worker owns SQL, migration checksums, WAL/FULL transactions and reservations. One central scheduler/pool serves automatic and manual checks. Node facilities handle DNS, pinned HTTP/TLS sockets, monotonic timing and lifecycle; ipaddr.js classifies addresses/CIDRs. See [ADR-010](specifications/ARCHITECTURAL-DECISIONS.md#adr-010--stage-1-adapters-and-runtime-evidence).

Implemented: strict configuration; CRUD, revisions and confirmed deletion; pause/resume and cancellation fencing; GET/HEAD, expected codes, header latency and normalized errors; bounded secure redirects; public-only egress with narrow private opt-in; durable history with terminal snapshot cursors; last-check/outcome projections; bounded/coalesced manual work; concurrency limits and missed-slot skipping; restart abandonment; liveness/readiness; Host/Origin, bearer/session/CSRF, expiry/rate controls; contained bounded secret files with platform permission checks; safe-code logging; graceful shutdown and a 15s command-process deadline.

Checks classify observations. Monitor health stays **UNKNOWN** throughout Stage 1; UP/DEGRADED/DOWN evaluation belongs to Stage 2. Cancelled/abandoned work has no invented outcome or latency. Later-stage resources return 501.

Relevant created/updated paths: [server](../apps/server/src/), [contracts](../packages/contracts/src/index.ts), [tests](../tests/), [scripts](../scripts/), [example](../examples/local-target.mjs), [root commands](../package.json), [operating guide](../README.md), specifications/ADRs/traceability and evidence. The web directory reserves Stage 3 without a UI. Private development instructions and runtime credentials are excluded from public scope.

## Running

Use Node 24.19+ within the 24.x LTS line. This machine's default Node was 22.14.0; validation explicitly selected the available Node 24.19.0 runtime. Node 22 is rejected. No global runtime installation was changed.

```sh
npm ci
npm run build
npm start
```

Development: `npm run dev`. Quality: `npm run typecheck`, `npm run lint`, `npm test`; consolidated evidence: `npm run verify`. The [README](../README.md) documents configuration, a real local example, API operations, authentication and shutdown. Default bind: 127.0.0.1:3000. Private targets require explicit CIDRs. Runtime tests use loopback/injected DNS and no external website; installation uses the npm registry/cache. The host network adapter was not disabled.

## Stage 1 acceptance checklist

All rows refer to the common candidate, UTC interval and platform above. Runtime scenarios were executed by controlled harnesses against real listeners, sockets, files and processes; no unperformed browser/manual action is claimed.

| Criterion | Actual verification | Status |
| --- | --- | --- |
| PULSE-S1-001 | API CRUD/ETag/conflicts/confirmation; disk persistence; last outcome retained through pause. | PASS |
| PULSE-S1-002 | Actual GET/HEAD, HTTP 500, refusal/reset, TLS, DNS, timeout and redirects. | PASS |
| PULSE-S1-003 | Real header latency, shared redirect deadline, no body retention or cancelled latency. | PASS |
| PULSE-S1-004 | Controlled-clock intervals, blocked executor, no overlap or catch-up bursts. | PASS |
| PULSE-S1-005 | Concurrent requests coalesce; shared pool and bounded queue reject overload with 429. | PASS |
| PULSE-S1-006 | Pause/edit/delete cancellation races; history retained; one resume opportunity. | PASS |
| PULSE-S1-007 | Pages/filters/limits, mismatched cursors, same-millisecond snapshot and durable deletion watermark. | PASS |
| PULSE-S1-008 | Defaults/invalid settings, containment/junction escape, size and broad ACL rejection. | PASS |
| PULSE-S1-009 | Dependency-aware readiness; real worker death blocks mutations while liveness remains available. | PASS |
| PULSE-S1-010 | Built process platform shutdown, bounded elapsed time, cancellation and restart. | PASS |
| PULSE-S1-011 | Real loopback target receipt and local storage; no external target required. | PASS |
| PULSE-S1-012 | Strict TypeScript, shared decoders and malformed-boundary tests. | PASS |
| PULSE-S1-013 | Directed imports checked; SQL confined to persistence; source inspected. | PASS |
| PULSE-S1-014 | Non-global/metadata ranges, mixed DNS, actual pinned IP/Host/SNI, redirect denial. | PASS |
| PULSE-S1-015 | Unsafe startup; real local/remote-mode auth, Secure cookie, CSRF, expiry, Host/Origin/proxy guards. | PASS |
| PULSE-S1-016 | Generated canaries, safe errors/DTOs and build scans; no real credentials used. | PASS |
| PULSE-S1-017 | Final commands/runtime scenarios, manifest and authentic evidence reviewed. | PASS |
| PULSE-S1-018 | Explicit Stage 1 authorization; no later-stage implementation or publication. | PASS |
| PULSE-S1-019 | Public code, documentation and API text reviewed in English; no promotional assets. | PASS |
| PULSE-S1-020 | Local operation/dependencies inspected: Fastify, Zod, ipaddr.js (MIT), Node/SQLite; no mandatory service/account. | PASS |

## Limitations, risks and postponed work

- Measured platform: Windows x64/Node 24.19.0 only. Linux, other patches, long soak, reference capacity and full/read-only disk rehearsals remain unverified release work. An earlier process run hit its unchanged startup wait deadline; isolated and final complete reruns passed. Sustained startup/load stability is not certified.
- The canonical data-directory lock uses an OS-released hashed loopback port. Unrelated collisions fail closed and may require clearing the conflicting listener or selecting another directory.
- Remote guard behavior was tested against a controlled backend listener. A real HTTPS proxy/network deployment remains unverified. If the Windows ACL probe is unavailable, it cannot certify protection; operator permission verification remains necessary. Broad-readable ACL rejection was exercised successfully.
- Node's SQLite API remains release-candidate upstream. Runtime upgrades require integration validation. npm audit is not a complete security or supply-chain assessment.
- History pruning is not active in Stage 1. Explicit deletion removes monitor-owned history; pause preserves it. Formal backup/upgrade/archive validation and license-owner attribution remain Stage 4 work.
- Incidents, thresholds, coverage/analytics, retention, dashboard, SSE and notifications are postponed to their assigned stages. No Stage 1 blocker remains within the measured scope. Stop here pending separate Stage 2 authorization.
