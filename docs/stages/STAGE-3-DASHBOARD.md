# Stage 3 — Dashboard, Alerts & Developer Experience

## 1. Objective

Expose the reliable backend through a professional accessible dashboard and real incident webhooks, with a repeatable local developer workflow. Begin only with explicit Stage 3 authorization and accepted Stage 2 evidence.

## 2. Allowed scope

React/Vite/Tailwind routes/forms/charts, server-state integration, login, same-origin SSE invalidation, dashboard/history/incidents, destination settings, transactional outbox and finite persistent webhook delivery. Add documented development commands and representative safe fixtures.

## 3. Explicitly excluded scope

No public release, deployment, paid alert channels, user/team management, public status pages, full-state push protocol, exactly-once webhook claim, browser/script monitoring or automatic Stage 4. Do not redesign completed backend domain semantics in presentation code.

## 4. Dependencies on previous stages

Stage 2 state, incident, metrics and restart guarantees plus Stage 1 safe API/transport/auth. Read [API](../specifications/04-API-CONTRACTS.md), [notifications](../specifications/11-NOTIFICATION-SYSTEM.md), [frontend](../specifications/12-FRONTEND-ARCHITECTURE.md) and [testing](../specifications/13-TESTING-STRATEGY.md). Verify shared schema decoding against the running backend.

## 5. Features to implement

Dashboard and monitor create/edit/detail actions, incident list/detail, search/filter URL state, accessible chart summaries, masked destination settings, delivery outcomes, session login/logout, reconnect/refetch freshness handling, incident.opened/resolved enqueueing and signed optional generic webhook delivery. Write clear local development/setup/error guidance.

## 6. Architecture requirements

Feature-organized frontend with one API client/cache, shared DTO schemas and no duplicate evaluator/metrics logic. One SSE connection per tab and bounded server/client buffers. Extend existing incident transaction with outbox rows; separate delivery pool and persistent retry state. Migration does not backfill old notifications. Choose router/cache/chart dependencies only for concrete needs and document bundle impact.

## 7. Detailed functional behavior

Forms validate domain bounds and retain drafts on safe errors/revision conflicts. Manual 202 is shown pending until stored completion. Dashboard values use API numbers with sample/coverage/stale context. Missing chart buckets remain gaps. Reconnect/refocus refetches, 30s visible polling recovers missed events and 60s without success marks stale. Destinations accept provisioned aliases and return configured booleans. Jobs preserve eventId/exact body, send at most 5 attempts with 5/10/20/40s base backoff and prevent per-destination reordering. 2xx means receiver acknowledgment only.

## 8. Failure and edge cases

Handle no monitors, filtered-empty lists, unknown/paused status, null metrics, missing/pruned resources, 401 expiry, 409 edits, offline API, SSE disconnect/slow consumers, out-of-order invalidations and unmounted requests. Webhooks handle redirect/permanent/retriable status, missing signing key, destination edit/disable during send, kill-after-send, final-attempt uncertainty and opening DEAD before later resolution. Monitoring must continue under notification failure.

## 9. Security requirements

No browser token persistence, secret URL/key display, raw target HTML or unsafe links. Exact-origin session/CSRF and Host policies apply to UI/SSE. Serve CSP/security headers and same-origin assets without external tracking/fonts. Egress is validated per webhook attempt with redirects forbidden. Verify alias traversal/symlink/Windows paths and canary redaction across UI/errors/SSE/receiver diagnostics.

## 10. Mandatory automated tests

Frontend validation/loading/error/empty/stale/conflict tests; route/deep-link/filter integration; Playwright against real backend/target; keyboard/accessibility checks and 360/768/1440px/200% zoom tests; dropped-SSE event recovery in local and authenticated modes; real webhook bytes/HMAC/retry/ordering/permanent failures; outbox rollback/deduplication and kill/restart uncertainty; saturated receiver with continuing probes. Run relevant Stages 1–2 regression suites.

## 11. Manual acceptance tests

1. Create a monitor in the browser; observe actual target contact and persisted detail/history after reload.
2. Force threshold failure/recovery; verify dashboard counts, incident timestamps, qualified charts and actual receiver event IDs.
3. Disconnect SSE/API, restore it and refocus; verify visible staleness and correct refetched values without duplicate commands.
4. Configure masked destination aliases, disable during a delayed attempt and inspect finite outcomes; confirm raw secrets never appear.
5. Complete create/edit/pause/manual/delete and incident investigation by keyboard; review chart table alternatives and screen-reader labels.
6. Review narrow/wide/zoomed layouts and default dark contrast; confirm all controls/data remain reachable.

## 12. Definition of Done

Main browser journeys persist real backend state and actual notifications reach the controlled receiver. Visual/accessibility/freshness requirements pass; no mocked success stands in for end-to-end evidence. Every required new endpoint/event/DTO is documented, bounds are enforced and previous-stage behavior remains valid.

## 13. Deliverables

Built frontend workspace, real API/cache/SSE integration, destination/delivery API and worker/migration, component/browser/receiver tests, local developer guide, synchronized contracts/ADRs and Stage 3 evidence.

## 14. Exit criteria

PASS for PULSE-S3-001 through PULSE-S3-010 in [acceptance criteria](../specifications/ACCEPTANCE-CRITERIA.md) plus relevant Stages 1–2 regression gates. Actual notification receipt and primary accessibility flows are mandatory. Stage 4 requires separate explicit authorization.

## 15. Known technical risks

Cookie/SSE behavior across local/remote modes, cache races, chart bundle/rendering cost, accessible dense data, webhook uncertainty and secret-bearing URL diagnostics. Bound dependencies/caches and validate actual destinations rather than only enqueue state.

## Authorized implementation and evidence

The user supplied and authorized the complete Stage 3 prompt on 2026-10-11. Its fixed test-notification requirement supersedes the earlier omission; ADR-012 and the notification/API specifications document that extension. Implementation, final verification and the 25 requested scenarios are recorded in [Stage 3 report](../VERIFICATION.md#historical-stage-3), [verification](../evidence/stage-3-verification.json) and [acceptance evidence](../evidence/stage-3-acceptance.json). This authorization does not begin Stage 4 or permit publication.
