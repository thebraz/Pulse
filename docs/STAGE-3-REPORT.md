# Pulse — Stage 3 completion report

Status: **PASS for the tested local Windows scope**. All ten Stage 3 acceptance rows and the 25 requested workflow scenarios passed against candidate `4d161d64b0b45e88e4ffecc34f63826e3791bf534b6469ec2adfa3a6d9865b86`. Stage 4 and publication have not begun.

## Final verification

The source manifest stayed unchanged throughout verification, from 2026-10-11T15:05:46.776Z to 2026-10-11T15:10:05.868Z. Environment: Windows 10.0.26200 x64, Node v24.19.0, SQLite 3.53.3; Chromium 156.0.8078.4. All fixtures used temporary databases and controlled loopback servers, without paid services or external sites.

| Gate | Actual outcome |
| --- | --- |
| npm run typecheck | PASS; exit 0 |
| npm run lint | PASS; exit 0 |
| npm test -- --reporter=default --reporter=json --outputFile.json=docs/evidence/stage-3-tests.json | PASS; exit 0 |
| npm run build | PASS; exit 0 |
| npm run test:e2e | PASS; exit 0 |
| Vitest unit, frontend, integration, security and restart assertions | PASS — 182 tests in 22 files; 0 failed |
| Playwright real-browser journeys | PASS — 7 passed; 0 failed, skipped or flaky |
| Additional operational checks | PASS — URL/key rotation with real HMAC receipt, missing signing key refusal and offline/online sign-out |
| Initial JavaScript gzip budget | PASS — all JS chunks together 142305 bytes (139.0 KiB), including lazy routes/chart; upper bound below 350 KiB |

[Command/source/artifact manifest](evidence/stage-3-verification.json), [Vitest results](evidence/stage-3-tests.json), [browser results](evidence/stage-3-browser.json), [operational checks](evidence/stage-3-operations.json), [bundle sizes](evidence/stage-3-bundle.json), [per-criterion/scenario evidence](evidence/stage-3-acceptance.json).

## Implemented features

| Feature | Status | Delivered behavior |
| --- | --- | --- |
| Dashboard | PASS | Real totals, 24h sampled availability/mean latency, coverage qualifiers, recent incidents/transitions and paginated search/filter/sort |
| Monitor management | PASS | Validated create/edit, explicit revision conflict reload, confirmed deletion, pause/resume, immediate execution polling and overview quick actions |
| Monitor history | PASS | Real checks/configuration, 24h/7d/30d/custom ranges, D3 latency SVG and equivalent table; no interpolation across unknown coverage |
| Incidents | PASS | Search/filter/list/detail, onset/detection/recovery/resolution anchors and honest observed spans/gaps |
| Live updates | PASS | One same-origin SSE per tab, bounded streams/buffers, cleanup, coalesced invalidations, reconnect/refocus and visible 30s fallback |
| Persistent webhooks | PASS | Atomic outbox, enabled destination snapshots, stable event IDs/bytes, HMAC, fixed test action/cooldown, masked history and five-attempt bounded retry |
| Notification recovery | PASS | Independent delivery pool, per-destination ordering, cancellation, real kill-after-send recovery, uncertainty budget and protected retention |
| Authentication | PASS | Existing operator-token login, HttpOnly/Strict cookies, CSRF, protected HTML/API/SSE, expiry/restart logout and no browser credential storage |
| Diagnostics/CLI | PASS | Read-only Settings, health/configuration/engine/delivery diagnostics and local start/doctor/version/help |
| Responsive accessibility | PASS within exercised scope | 360/768/1440 layouts, keyboard actions, labelled scroll regions, visible focus, reduced motion, textual status and no serious/critical Axe violations |
| Sustained DEGRADED webhook | NOT IMPLEMENTED | Optional in the supplied prompt; automatic notifications cover confirmed opening/recovery only |

React, strict TypeScript, Vite, Tailwind, React Router, TanStack Query and D3 shape meet the requested stack with no additional widget/global-state framework. [ADR-012](specifications/ARCHITECTURAL-DECISIONS.md#adr-012--stage-3-dashboard-and-persistent-webhooks) explains choices and the explicitly requested fixed notification.test extension. All default UI, CLI, source and public documents are English.

## Required workflow checklist

| # | Requested verification | Status | Actual evidence |
| --- | --- | --- | --- |
| 1 | Dashboard loads correctly | PASS | Real built SPA, API totals and live status |
| 2 | Empty state is useful | PASS | Empty installation links to Create monitor |
| 3 | Monitor creation succeeds | PASS | Real target contact and persisted detail |
| 4 | Invalid configuration is rejected | PASS | Invalid URL stays in draft with focused error; backend malformed-input tests |
| 5 | Monitor editing persists | PASS | Rename survives reload and process restart; 409 retains unsaved input |
| 6 | Monitor deletion works | PASS | Named confirmation cancel and keyboard permanent-delete flow |
| 7 | Pause and resume work | PASS | Detail and overview actions commit backend enablement |
| 8 | Immediate check updates data | PASS | 202 execution is polled to its real stored terminal result |
| 9 | Live updates reflect backend changes | PASS | Real outage/recovery SSE plus offline missed events in both auth modes |
| 10 | Status indicators match actual backend states | PASS | Real target produces UP/DOWN, overview counts and UNKNOWN/paused states |
| 11 | Latency chart displays real data | PASS | Real successful checks; qualified buckets and explicit gap-breaking render test |
| 12 | Historical time ranges work | PASS | 24h/7d/30d/custom range against actual metrics API |
| 13 | Incident list displays correct history | PASS | Confirmed HTTP outage appears and resolves |
| 14 | Incident detail view is accurate | PASS | Open recovery fields remain absent; backend onset/detection/recovery/coverage math |
| 15 | Search and filters work | PASS | URL-backed name search, health filtering, clear/reload and backend shared queries |
| 16 | Large monitor lists remain usable | PASS | 36 real records paginate 25/11; backend separately tests 10,000 definitions |
| 17 | Navigation works | PASS | Overview, monitor forms/detail, incidents/detail and notifications routes; protected login |
| 18 | Webhook test notification is delivered | PASS | Actual receiver HTTP acknowledgment, immutable JSON and valid HMAC |
| 19 | Webhook failures are recorded | PASS | Real 400 DEAD and 503 pending/retry histories; timeout/TLS/policy failures |
| 20 | Retries are bounded and deduplicated | PASS | Exactly five attempts through real worker/fake clock; stable IDs/bytes; crash uncertainty |
| 21 | Dashboard recovers after backend restart | PASS | Persisted checks/incidents/destinations and no repeated incident enqueueing; session expiry |
| 22 | Empty and error states remain usable | PASS | Filtered empty state, invalid/conflicting drafts, offline/reconnect and offline sign-out error |
| 23 | No unexpected horizontal overflow | PASS | Document width checks plus labelled keyboard-scroll table regions |
| 24 | Mobile and desktop layouts are functional | PASS | 360/768/1440 screenshots, accessibility checks and 200% zoom |
| 25 | Browser console contains no unexpected errors | PASS | Complete journey rejects unexpected console/page errors, allowing intentional restart connection failures; operational sign-out produces no page exceptions |

The complete end-to-end scenario ran against the built server: create a real local API monitor, observe success, force HTTP failures, confirm DOWN/open incident and signed receiver receipt, restore success, confirm resolution and qualified historical samples, restart Pulse, and verify retained data with no duplicate incident notification enqueueing. The receiver stores actual event IDs/body bytes; a queued 202 alone is never treated as delivery proof.

## Files created or changed

The [acceptance evidence](evidence/stage-3-acceptance.json) lists every public source/configuration/document file differing from the Stage 2 manifest (74 files). Main areas:

| Area | Paths | Change |
| --- | --- | --- |
| Frontend | apps/web/src, apps/web/index.html, apps/web/vite.config.ts, apps/web/tsconfig.json | Application, forms, chart, cache/SSE, responsive CSS and strict build |
| Server presentation/security | apps/server/src/api/assets.ts, events.ts, security.ts, server.ts | Same-origin assets/SSE, protected routes and real dashboard/destination/delivery APIs |
| Delivery and persistence | apps/server/src/notifications, persistence/notifications.ts, migration.ts, store.ts, protocol.ts, database.ts | Independent transport/worker, migration 3 and transactional outbox/retention |
| Runtime | apps/server/src/config/config.ts, runtime/runtime.ts, main.ts, bin/pulse.mjs | Delivery lifecycle, reserved database capacity, startup diagnostics and local CLI |
| Contracts | packages/contracts/src/index.ts | Shared destination/delivery/dashboard/query schemas and bucket knownMs |
| Verification | tests/e2e, tests/notifications.test.ts, delivery-restart.test.ts, events.test.ts, frontend.test.ts, cli.test.ts, playwright.config.ts, scripts | Real fixtures, regressions, production build cache and checksummed reports |
| Public guidance | README.md, apps/web/README.md, docs/specifications, docs/stages/STAGE-3-DASHBOARD.md | Synchronized contracts, stage scope, dependency decisions, local workflow and acceptance |

Prior migrations 1/2 remain unchanged. Migration 3 adds delivery tables/indexes without historical notification backfill. The Stage 2 query-plan sidecar was accidentally regenerated during the initial regression precheck and is explicitly marked as current precheck evidence; its original source manifest/test report remain intact. Current final query plans are separately retained in [Stage 3 query plans](evidence/stage-3-query-plans.json).

## Performance and limitations

The real browser requests 25 monitor summaries in a batch; no per-row API fan-out is used. Plotted history uses fewer than 170 buckets, route/chart code is lazy, and inactive query garbage collection is 60s. The actual gzip upper bound above includes every JS chunk.

The retained synthetic backend regression uses 10,000 monitor definitions, 20 selection warmups, 1,000 indexed selection measurements and 500 gated successful observations through the real worker/WAL/FULL pipeline at concurrency 10. On this shared 12th Gen Intel(R) Core(TM) i7-1255U workstation, selection P95 was 0.018ms, recovery 1007ms and short-run throughput 111.6 observations/s. Process RSS after processing was 173.6MiB; event-loop P95 21.0ms. These are short synthetic measurements, not the 100-real-monitor reference workload, long retained-history benchmark, browser heap/interaction budget or soak proof. [Full conditions and measurements](evidence/stage-3-benchmark.json).

No blocking UX issue or Stage 1/2 regression was observed in the final suite. No exhaustive manual screen-reader/browser matrix audit is claimed. Remote HTTPS proxy/network deployment, Linux, sustained memory/receiver overload, installation archives and formal backup/restore/upgrade rehearsals remain **NOT TESTED** and require Stage 4 authorization. Webhook receipt is best effort: a crash can repeat the same event ID, and a 2xx acknowledges the receiver only. Operators must deduplicate/verify signatures. Provisioned secret rotation requires restart; already transmitted bytes cannot be recalled.

Vite reports upstream use-client directive warnings when bundling the client-only React libraries; production output and browser checks pass. The build explicitly sets NODE_ENV=production so missing-file rebuilds during Vitest reproduce the production artifact instead of silently bundling development React. Initial defects in form revision preservation, deletion refetches, offline freshness, omitted destination settings and SQLite expression-index portability were fixed and their relevant checks pass.

## Using this checkout

Use Node 24.19.0 and the root commands in [README](../README.md). Build, then start; open the configured localhost origin. The existing instance on 127.0.0.1:3000 was read-only checked and remained ready with schema versions 1/2 and its existing monitor. It was left running. Stop it normally and restart with the built Stage 3 runtime to load the dashboard and apply migration 3; do not run two processes against its database. Test/operational checks did not migrate or reset that operator database.

No package, GitHub release, push, deployment or public publication was performed. Stage 4 requires separate authorization.
