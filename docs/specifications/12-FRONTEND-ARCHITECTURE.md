# Pulse frontend architecture

Stage 3 adds the React/Vite/Tailwind application. Stages 1–2 expose backend contracts only. The browser is an operator interface to the same-origin Fastify API; it does not execute probes, calculate independent incident state or store credentials in localStorage.

## Organization, routing and data ownership

`app/` contains route setup, layout and providers. `features/monitors`, `features/incidents`, `features/dashboard` and `features/notifications` own their screens and API hooks. `components/` holds shared accessible controls, status labels and chart primitives. `lib/api` owns fetch, decoding, safe errors and session/CSRF handling. Avoid feature-to-feature circular imports; shared contracts supply DTOs, not business logic.

| Route | Purpose and required behavior |
| --- | --- |
| /login | Token submission only when authentication is enabled; never persist the token after successful login. |
| / | Dashboard counts, paginated monitor overview and recent incidents. |
| /monitors/new | Validated monitor creation with documented defaults and inline safe field errors. |
| /monitors/:id | Status/reason, last observation, interval, latency/availability, coverage, history, transition/incident links and actions. |
| /monitors/:id/edit | Revisioned edit form; 409 conflict offers refetch without silently overwriting. |
| /incidents | Paginated filterable incident list with open/resolved state and observation context. |
| /incidents/:id | Onset/detection/recovery/resolution timeline, observed downtime, gaps and monitor link. |
| /settings/notifications | Masked destination settings, provisioned secret-alias inputs and delivery states/errors. |
| /settings | Read-only health, database readiness, safe startup configuration, engine and delivery diagnostics. |
| Unmatched | Accessible not-found page with navigation; missing resources remain 404, not empty successes. |

Use one router and one server-state cache library or an equivalently bounded existing solution; choose during Stage 3 and record dependency rationale. Do not implement a generic state framework. Query keys include all filters/windows/pages. Keep remote data in the query cache; only drafts, disclosure state and chart selection are local UI state. No Redux-style global duplication of server records is needed.

Fetch uses shared runtime schema decoding, same-origin credentials and current CSRF header on mutations. HTTP 401 invalidates session and displays login with a safe same-origin return path. Expected 4xx errors retain unsaved inputs; unexpected failures show a request ID and retry. Do not automatically retry destructive mutations or duplicate manual-check submission. After mutation, reconcile the committed resource and invalidate related lists/metrics. Poll the returned execution ID until terminal or cancel polling when unmounted; a 202 response is not proof the target was checked.

## Live updates and freshness

Before deleting a monitor, disable its detail/execution queries and cancel their in-flight requests. Keep them disabled until navigation after the committed deletion; restore refreshes if deletion fails. This prevents SSE or focus invalidation from requesting a removed monitor while the DELETE response is still in transit. The real-browser workflow holds that response through a full coalescing window and rejects any resource reads after commit.

Use one EventSource connection per browser tab, with cookie authentication in authenticated mode and guarded local access otherwise. SSE messages invalidate affected cache keys; they are not trusted replacement domain objects. Coalesce bursts within 250ms and refetch each active resource at most once per second, retaining a trailing invalidation for fresh data. Always refetch active queries on reconnect, tab refocus and mutation completion. Poll every 30s while visible as recovery; stop background polling when hidden, reconnect/refetch on return. Avoid multiplying intervals per card.

Automatic live refresh awaits the active refetch batch without cancelling existing reads. Events received during that batch retain one trailing refresh, still subject to the one-second rate limit. Aborting an HTTP read cannot cancel SQLite work already admitted, so repeated cancellation must not create redundant queued work or prevent a slow response from reaching the cache. Unmount cancels scheduled trailing work; explicit filter changes and deletion retain their own cancellation behavior.

Display last successful fetch time and a stale indicator when no successful refresh has occurred for 60s or the connection/readiness fails. Preserve last known data with a visible stale label; never replace it with invented zero counts. Unknown health and paused enablement are distinct. The UI must correct a dropped event by refetch, because SSE has no durable replay guarantee. Slow-client disconnection and session expiry follow [API limits](04-API-CONTRACTS.md).

An admitted SSE socket has a finite 30s idle timeout, above the 15s heartbeat interval; ordinary HTTP sockets retain their 10s idle timeout. Admission still enforces authentication/session expiry, twenty streams and 64KiB per-stream pending bytes. The real nginx fixture waits for heartbeats and post-idle committed invalidations; production operators must preserve unbuffered streaming and a proxy timeout above the heartbeat interval.

## Screens, charts and search

Dashboard status counts partition enabled monitors, with paused shown separately. Each monitor row/card shows name, safe target origin/path, textual health/reason, last check time, 24h sampled availability with n, successful response-header latency and coverage qualifier. Use paginated summaries, not one request per card. Recent incidents link to their source.

Creation/edit expose GET/HEAD, expected status codes, interval, timeout, redirect opt-in, enablement and threshold fields. Explain that private destinations need startup CIDR authorization and that query credentials/request bodies/custom headers are unsupported. Local validation helps the operator; backend validation remains authoritative. Disable duplicate submit while pending, preserve errors and focus the first invalid field. Pause/resume must reflect the committed backend state. Delete uses a confirmation dialog naming the monitor and the history/incident/delivery loss; cancellation changes nothing.

Monitor charts show bucketed successful latency and sampled availability for 24h/7d/30d and custom past ranges up to 90 days, with gap breaks for missing data. Do not draw missing samples as 0 or connect through uncovered intervals. Tooltips include timestamp, sample count, units and coverage. Provide an equivalent accessible data summary/table. Do not average percentiles or infer frontend thresholds. Server caps 2,000 buckets; display at most 500 plotted points after explicitly labelled visual aggregation that does not alter reported numerical summaries. No chart-library choice is mandatory before a real dependency/size review.

Search/filter/sort/window values live in URL query state and survive reload/back navigation. Debounce name search 250ms and cancel stale reads. Filtered empty states say no matching results and offer clear filters; a new empty installation offers monitor creation. Empty history and unavailable metrics explain why there is no data. Notification settings accept aliases for pre-provisioned files, display configured booleans and safe delivery outcomes, and never reveal URLs/signing keys or imply that a DEAD job was delivered.

## Visual and accessibility standards

Use a professional dark-first interface: deep navy/charcoal surfaces, restrained blue for primary actions, neutral readable text, minimal decoration and one consistent spacing/typography scale. Avoid rigid page dimensions. Status colors supplement labels/icons; DOWN must be recognizable without red perception. Use system/local fonts; no mandatory external font/CDN requests. Light mode is optional, not a release dependency.

Meet WCAG AA text contrast (4.5:1 normal, 3:1 large text), visible keyboard focus and 3:1 important control boundaries where applicable. Use semantic headings, labels, button/link roles, accessible dialogs with focus trapping/return, announced safe form errors and reduced-motion preferences. Skeletons must not trap focus; live region updates should summarize changes without reading every monitoring tick. Tooltip-only essential information is prohibited.

Verify 360px, 768px and 1440px viewports plus 200% zoom. No page-wide inaccessible horizontal overflow. Wide tables use an explicitly labelled keyboard-accessible scroll region or responsive row cards, preserving all essential columns. Navigation, dialogs, charts and actions must remain reachable. Touch targets should normally be at least 44px; do not force an entire desktop grid onto a narrow screen.

## Browser security and performance

Escape all operator/target strings through normal React rendering; no target HTML, body preview, script execution, unsafe URL schemes or raw exception rendering. CSP and secure headers follow [security](10-SECURITY-MODEL.md). Keep tokens in memory only long enough to create the HttpOnly session. Logout clears cache/session UI and closes SSE. Avoid analytics/tracking calls and external runtime assets.

Lazy-load detail/chart routes where it reduces initial cost; cap cache lifetime/page retention and dispose requests, charts, observers and event listeners on unmount. Use stable keys by IDs, paginate long histories and avoid 1000-row unbounded DOM lists. Verify actual browser interaction and bundle budgets in [performance](14-PERFORMANCE-REQUIREMENTS.md), with controlled data and the running backend.

## Implemented Stage 3 choices

React 19, strict TypeScript, Vite/Tailwind 4, React Router and one TanStack Query cache provide the same-origin application. D3 shape is the small open-source chart dependency: SVG rendering supplies gap-aware latency paths, timestamp/sample/coverage tooltips and an equivalent data table. Hourly 24h/7d and daily 30d/custom requests stay below 170 plotted buckets, so no undisclosed frontend aggregation is needed. Only fully known buckets are connected; partially known buckets may show isolated sample dots. Numerical availability and incident statistics come exclusively from shared validated API contracts. The server serves the built dist directory under the existing security guards and CSP.

Latest response uses an independent one-row history query so changing the historical range cannot turn an older measurement into the current observation. Forms freeze the loaded revision until successful save or an explicit conflict reload. Successful monitor deletion navigates before invalidating lists, avoiding requests for the deleted resource. Cache garbage collection is 60s; route/chart modules are loaded on demand. Actual compressed output and tested browser conditions are recorded in Stage 3 evidence, not inferred from dependency names.
