# Stage 1 — Foundation & Monitoring Core

## 1. Objective

Build a locally runnable, secure HTTP monitoring backend with persisted observations. Stage 1 was explicitly authorized on 2026-10-09. Health remains UNKNOWN until Stage 2. This contract does not authorize later stages or publication; see the [implementation report](../VERIFICATION.md#historical-stage-1) for actual evidence.

## 2. Allowed scope

npm workspace foundation, strict TypeScript, shared schemas, Fastify API, SQLite ownership/migrations, startup configuration, default loopback guards, remote auth, secure HTTP checks, automatic/manual scheduling, pause/resume, history and graceful shutdown. Basic recovery abandons unfinished work.

## 3. Explicitly excluded scope

No incident evaluator, historical metrics engine, retention worker, browser dashboard, SSE, webhook jobs, public package/release/push or automatic Stage 2. Do not add a placeholder UI or unsupported endpoint implementations that look complete.

## 4. Dependencies on previous stages

Requires explicit Stage 1 authorization and this accepted specification system. No earlier application exists. Read [architecture](../specifications/02-SYSTEM-ARCHITECTURE.md), [models](../specifications/03-DOMAIN-MODELS.md), [API](../specifications/04-API-CONTRACTS.md), [engine](../specifications/05-MONITORING-ENGINE.md) and [security](../specifications/10-SECURITY-MODEL.md) before implementation.

## 5. Features to implement

Create/edit/read/delete monitors with revision protection and confirmed deletion; validated defaults; GET/HEAD checks with expected codes, header latency and distinct failures; central bounded scheduling; coalesced manual 202 executions and polling; pause/resume cancellation; terminal history pagination; typed configuration and safe health endpoints. Store threshold fields without pretending the Stage 2 evaluator is active.

## 6. Architecture requirements

Set up apps/server and packages/contracts with directed imports; reserve apps/web for Stage 3 without implementing it. Use one database worker, exclusive data-directory lock, typed parameterized commands and real on-disk migrations. Resolve exact runtime/SQLite, schema and cross-platform lock/egress adapters with smoke evidence and ADR updates. No external service is allowed to become mandatory.

## 7. Detailed functional behavior

Create enabled monitors due immediately; interval phase advances by skipping missed slots. One unsettled execution per monitor, at most configured checks active. GET/HEAD completes at final headers and discards bodies. Manual work shares pool/security rules and returns execution identity before completion. Editing cancels stale work; pause retains history and disables dispatch; resume queues one opportunity. Terminal persistence precedes API acknowledgment. Later-stage registered resources report FEATURE_NOT_AVAILABLE. GET configuration returns safe values only.

## 8. Failure and edge cases

Handle DNS/TLS/reset/timeout/status/redirect/policy outcomes separately; no raw transport errors in DTOs. Race manual with automatic checks, pause/edit/delete with completion and timeout with cancellation. Crash leaves unfinished rows recoverable as ABANDONED; no target-failure fabrication. Reject invalid/newer database schema and second writable instance. An unavailable database fails readiness and stops dispatch; never recreate it silently.

## 9. Security requirements

Public-only validated/pinned egress is mandatory immediately, not deferred hardening. Deny metadata/rebinding/unsafe redirects; private fixtures require explicit CIDRs. Default loopback, exact Host/Origin, remote startup authentication/HTTPS requirements, cookie/CSRF session lifecycle, request/body/rate limits, write-only secret files and canary-tested logging are required. No TLS-disable switch, shell execution, arbitrary request headers or query credentials.

## 10. Mandatory automated tests

Run strict typecheck/lint/build; validators and shared DTO decoding; actual Fastify CRUD/revision/error tests; actual controlled HTTP/TLS target contact; actual-IP DNS/redirect security fixtures; on-disk SQLite constraints/rollback/WAL; reservation coalescing/capacity/due formulas; cancellation and shutdown subprocess; startup/auth/Origin/Host matrices and canary scans. Test boundary intervals/timeouts and malformed pagination. Use fake clock for timing plus real socket/process tests for enforcement.

## 11. Manual acceptance tests

1. Start from a clean temporary data directory with default exposure; confirm liveness/readiness and loopback listener.
2. Configure a narrowly allowed controlled target, create a monitor through API, wait for actual target receipt and retrieve the terminal stored check.
3. Trigger concurrent manual requests; verify one unsettled execution/ID and eventual actual observation.
4. Pause during a delayed request; verify cancellation, retained history and no additional target contacts until resume.
5. Stop and restart; confirm persisted monitors/history and abandoned unsettled work, then one overdue opportunity.
6. Try remote startup without authentication/HTTPS declaration, hostile Host/Origin and denied target addresses; confirm fail-closed behavior without secret output.

## 12. Definition of Done

All Stage 1 criteria and relevant tests pass against the final revision; actual-target behavior is verified. Commands, configuration, error contracts and resolved adapter choices are documented. No source secrets, swallowed background errors or unsupported health claims. Implementation acceptance rows may change from NOT TESTED only with authentic evidence.

## 13. Deliverables

Runnable core workspaces and shared contracts, migration 1, tests/fixtures, safe configuration/runtime instructions, updated ADRs/specifications and Stage 1 evidence. Do not create publication artifacts as a substitute for backend proof.

## 14. Exit criteria

PASS for PULSE-S1-001 through PULSE-S1-020 in [acceptance criteria](../specifications/ACCEPTANCE-CRITERIA.md), including governance/quality checks. No critical security/data-integrity blocker. Stop after the report; Stage 2 requires new explicit authorization.

## 15. Known technical risks

Address classification/pinned DNS correctness, Windows ACL/locking behavior, runtime SQLite patch/API support, cancellation callback races and real-socket tests under restricted loopback environments. Document observed limitations rather than weakening production controls or reporting unexecuted tests as passing.
