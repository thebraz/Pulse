# Pulse API contracts

Normative HTTP JSON interface at `/api/v1`. Shared runtime schemas and DTOs live in `packages/contracts`; [domain models](03-DOMAIN-MODELS.md) define field validation. Endpoints become available only in their assigned stage. A registered later-stage resource returns 501 FEATURE_NOT_AVAILABLE with its required stage; unknown paths return 404. Health endpoints are outside the version prefix.

## Common rules

Requests and responses use UTF-8 JSON, except SSE and empty 204 responses. Reject unsupported media types with 415, bodies above 64 KiB with 413, extra object properties with 400, and invalid query keys/enums with 400. Never coerce arbitrary strings to booleans. UUID paths must validate before repository access. Server-generated fields are forbidden in create/patch input. Empty PATCH is invalid. Each response has a safe `X-Request-Id`; responses with operator data use `Cache-Control: no-store`.

Configuring PULSE_AUTH_TOKEN_FILE enables authenticated mode for either local or remote exposure; remote exposure requires it. Protected endpoints then require either a valid session cookie or an Authorization Bearer operator token. Local mode without a token file permits same-origin operator access with Host/Origin checks; it is not safe to expose publicly. Browser mutation requests require an exact allowed Origin. Cookie-authenticated mutations additionally require `X-Pulse-CSRF` from the current session. Bearer clients without Origin are allowed; if Origin is present it must match. Authentication failures are 401; authorization/origin/CSRF failures are 403. See [security](10-SECURITY-MODEL.md).

PUT/PATCH/DELETE on revisioned resources require `If-Match: "<revision>"`: missing returns 428 PRECONDITION_REQUIRED; stale returns 409 REVISION_CONFLICT. Successful single-resource GET/create/update responses return matching ETag. Object IDs are immutable. Mutation success is returned only after commit. API timeouts must not erase committed operations; clients reconcile by returned IDs or refetching before retrying a mutation.

### Envelopes

Single resources return `{ "data": <DTO> }`. Lists return `{ "data": [<DTO>], "page": { "nextCursor": <string|null>, "limit": <integer>, "asOf": <timestamp> } }`. Metadata is additive only within a version; removed/changed field semantics require a new API version or an explicitly documented pre-release change.

```json
{
  "error": {
    "code": "VALIDATION_ERROR",
    "message": "Request validation failed.",
    "requestId": "req-7a1f",
    "details": [{ "field": "timeoutMs", "rule": "integer_between_1000_and_30000" }]
  }
}
```

Details contain field names and rule codes only, never rejected values. Stable error codes: VALIDATION_ERROR (400), AUTH_REQUIRED (401), FORBIDDEN (403), NOT_FOUND (404), REVISION_CONFLICT/MONITOR_DISABLED/EXECUTION_CONFLICT (409), PRECONDITION_REQUIRED (428), TARGET_POLICY_REJECTED (422), QUERY_RANGE_TOO_LARGE (422), RATE_LIMITED/QUEUE_SATURATED (429), FEATURE_NOT_AVAILABLE (501), DATABASE_UNAVAILABLE/SERVICE_STOPPING (503), INTERNAL_ERROR (500). A valid HTTP check that fails at the target is a COMPLETED execution, not an HTTP 500 from this API. 429 and temporary 503 include integer `Retry-After` seconds.

### Pagination, ranges and sorting

List limit defaults to 50 and is 1–100. Cursors are bounded opaque base 64url-encoded validated JSON, not authorization tokens; cap 1,024 bytes and reject mismatched filters/sorts. Terminal check history uses immutable sequence ordering plus a persisted terminal-commit high-water mark and completion/asOf cutoff. The internal commit counter never resets when monitor deletion removes checks. This excludes work terminalized after the snapshot even in the same millisecond. Transition history will use its immutable sequence watermark from Stage 2. Concurrent retention may shorten later pages; this is documented, not compensated with invented records. Incident and monitor lists are live views; updates may move rows, so clients deduplicate IDs and refetch after mutations.

Default history sort is `-sequence`; also permit `sequence`. Monitor sort is `name` (case-insensitive normalized key then id), `-updatedAt`, or `status` (UNKNOWN, UP, DEGRADED, DOWN then id). Incident sort is `-detectedAt` or `detectedAt`, then id. Unsupported sort expressions are rejected; SQL column names come from an allowlist. Search `q` is trimmed, at most 120 characters, case-insensitive substring on names only; escape SQL LIKE wildcards for literal matching.

Time filters are UTC half-open `[from,to)`, from < to. Default check range is last 24h; requests are at most 90 days and metrics at most 100,000 retained counted checks per monitor. Larger calculations return 422 QUERY_RANGE_TOO_LARGE with safe bounds; never truncate silently. `to` cannot exceed server now. Responses include effective asOf and retention coverage.

History time filters use startedAt, falling back to queuedAt only for terminal attempts cancelled/abandoned before start. Transitions use occurredAt; incident lists filter detectedAt. Metrics select check startedAt and count incidents whose observed outage span intersects the window. Delivery lists have fixed descending createdAt then id ordering; destination lists default to ascending normalized name then id. No unlisted arbitrary sort is accepted.

## Endpoint inventory

All endpoints are protected unless explicitly marked public or login bootstrap. Login bootstrap verifies the submitted operator token rather than requiring a preexisting session. Read DTOs use domain fields except write-only secret references. Request schema names below are defined immediately after this table.

| Method and endpoint | Stage | Request / query | Successful response | Additional errors |
| --- | --- | --- | --- | --- |
| GET /health/live | 1 | none; public | 200 `{status:"alive"}` | none while process serves |
| GET /health/ready | 1 | none; public | 200 `{status:"ready"}` | 503 `{status:"not_ready",code:<safe code>}` |
| POST /api/v1/session | 1 | SessionCreate; login bootstrap, exact Origin | 200 SessionView + cookie | 401,429; 409 AUTH_DISABLED in local unauthenticated mode |
| GET /api/v1/session | 1 | cookie or bearer, or local operator | 200 SessionView | 401 |
| DELETE /api/v1/session | 1 | CSRF for cookie; no body | 204; expire cookie | 403 |
| POST /api/v1/monitors | 1 | MonitorCreate | 201 Monitor DTO + Location | 422 policy; 409 MONITOR_LIMIT_REACHED |
| GET /api/v1/monitors | 1 | limit, cursor, q, status, enabled, sort, include | 200 Monitor list | include=summary requires Stage 3 |
| GET /api/v1/monitors/summary | 2 | none | 200 current enabled-health counts + active incident count | 503 |
| GET /api/v1/engine | 2 | none | 200 safe engine counters, concurrency and maintenance diagnostics | 503 |
| GET /api/v1/monitors/:id | 1 | UUID | 200 Monitor DTO | 404 |
| PATCH /api/v1/monitors/:id | 1 | MonitorPatch; If-Match | 200 Monitor DTO | 409,422,428 |
| DELETE /api/v1/monitors/:id | 1 | confirm=true; If-Match | 204 | 400 if confirmation absent; 409,428 |
| POST /api/v1/monitors/:id/checks | 1 | empty object | 202 ExecutionView + Location | 409 disabled; 429 saturation |
| GET /api/v1/executions/:id | 1 | UUID | 200 ExecutionView | 404 if missing/pruned |
| GET /api/v1/monitors/:id/checks | 1 | limit, cursor, from, to, outcome, sort | 200 terminal CheckResult list | 422 range |
| GET /api/v1/monitors/:id/transitions | 2 | limit, cursor, from, to, sort | 200 StateTransition list | 404,422 |
| GET /api/v1/monitors/:id/metrics | 2 | from, to, window, bucket | 200 MetricsView | 404,422 |
| GET /api/v1/incidents | 2 | limit, cursor, monitorId, status, from, to, sort | 200 Incident list | 422 range |
| GET /api/v1/incidents/:id | 2 | UUID | 200 Incident + duration/coverage view | 404 |
| GET /api/v1/dashboard | 3 | window=24h only | 200 DashboardView | 503 |
| GET /api/v1/events | 3 | session cookie in authenticated mode; local Host/Origin checks otherwise; no query credentials | 200 text/event-stream | 401,429 client limit |
| POST /api/v1/notification-destinations | 3 | DestinationCreate | 201 masked Destination DTO | 422 invalid secret reference/policy |
| GET /api/v1/notification-destinations | 3 | limit, cursor, sort=name | 200 masked Destination list | 400 |
| GET /api/v1/notification-destinations/:id | 3 | UUID | 200 masked Destination DTO | 404 |
| PATCH /api/v1/notification-destinations/:id | 3 | DestinationPatch; If-Match | 200 masked Destination DTO | 409,422,428 |
| DELETE /api/v1/notification-destinations/:id | 3 | confirm=true; If-Match | 204; cancels jobs and removes destination-owned deliveries | 400,409,428 |
| POST /api/v1/notification-destinations/:id/test | 3 | {}; exact Origin and CSRF when authenticated | 202 safe queued Delivery DTO | 404,409 disabled,429 cooldown |
| GET /api/v1/notifications/diagnostics | 3 | none | 200 bounded delivery statistics | 503 |
| GET /api/v1/notification-deliveries | 3 | limit, cursor, destinationId, incidentId, state | 200 safe Delivery list | 400 |
| GET /api/v1/configuration | 1 | none | 200 SafeConfigurationView | 503 |

There is no API to change startup configuration, run arbitrary SQL, export secrets, acknowledge incidents, force health state, or trigger arbitrary webhook bodies. API health is not a public listing of monitored services.

## Request and response schemas

**MonitorCreate:** name and url required; remaining mutable Monitor fields optional with domain defaults. **MonitorPatch:** nonempty subset of mutable fields (name, url, method, expectedStatusCodes, intervalMs, timeoutMs, followRedirects, enabled, failureThreshold, recoveryThreshold, latencyThresholdMs, degradationThreshold). Reject null for all of them. Stage 2 applies the persisted thresholds. Pause/resume use PATCH enabled=false/true, no second competing lifecycle endpoint. Limit to 10,000 definitions; real-endpoint capacity is unverified beyond the measured workloads. Identical validated mutations return the existing revision without cancelling work.

**SessionCreate:** `{token:string}` only, maximum 512 bytes, compared in constant time; body logging is prohibited. **SessionView:** `{mode:"local"|"authenticated",authenticated:boolean,csrfToken:string|null,expiresAt:timestamp|null}`. Cookie login yields an 8h non-sliding session; sessions are memory-only and invalidated on restart/token rotation. Bearer reads return csrfToken null. Local mode returns authenticated=true, no session cookie and csrfToken null, with Origin protection still mandatory for browser mutations.

**ExecutionView:** `{id,monitorId,lifecycle,trigger,queuedAt,startedAt,completedAt,outcome,httpStatus,durationMs,errorCode}` with domain nullability. A repeated request while the monitor already has unsettled work returns the same execution ID and 202; it never starts a duplicate. `Location` points to `/api/v1/executions/:id`.

**DestinationCreate:** `{name,urlSecretRef,signingSecretRef?,enabled?}`; signingSecretRef null disables signing explicitly. **DestinationPatch:** nonempty subset, revisioned; omitted reference retains its value. Read DTO exposes `{id,name,enabled,urlConfigured,signingConfigured,revision,createdAt,updatedAt}` only. Limit 50 destinations. Delivery reads expose IDs, eventType, state, attemptCount, timestamps and sanitized last status/error; payloads and secret aliases are omitted.

**SafeConfigurationView:** effective interval defaults, non-secret concurrency/retention bounds, exposure mode, egress policy name, feature-stage availability and application version. Exclude filesystem paths, secret references, token hashes, target allowlist contents and proxy internals.

**MetricsView:** `{monitorId,from,to,asOf,effectiveFrom,effectiveTo,notApplicableMs,sampleCount,successfulCount,failedCount,degradedCount,unclassifiedDegradationCount,sampledAvailabilityPercent,sampleWindowIncomplete,includesManualChecks:true,latency:{count,meanMs,minMs,maxMs,p50Ms,p95Ms,p99Ms,method,lowSample,p95Sufficient,p99Sufficient},coverage:{eligibleMs,knownMs,unknownMs,pausedMs,serviceOfflineMs,retainedFrom,incomplete},retention:{checksFrom,incidentsFrom,coverageFrom},observedDowntimeMs,incidentCount,buckets:[...]}`. Null semantics and coverage partition are defined in [metrics](08-METRICS-AND-ANALYTICS.md). window is 24h (default), 7d or 30d and cannot accompany explicit from/to. bucket is 1m, 5m, 1h or 1d; default 1h; maximum 2,000 UTC-aligned clipped buckets or 422. Buckets include start/end/count/success/failure/availability/meanLatency and knownMs (the intersection of that bucket with known covered health); all empty summaries are null, counts zero. At most 100,000 rows from each coverage/history source are loaded in addition to the counted-sample cap.

**IncidentView:** domain incident fields plus failureCategory, diagnosticSummary, durationMs (raw observed span), ongoing, detectionDelayMs, resolutionConfirmationDelayMs and resolutionSummary. Detail adds asOf, coverage-clipped observedDowntimeMs, excludedGapMs, coverageIncomplete and the two opening/resolving transition anchors at most. Further transitions use the monitor's paginated history. No raw target error or URL appears in diagnostic text. `status=OPEN` without explicit from/to lists unresolved incidents regardless of age; ordinary history defaults to 90 days. Incident lists remain live views.

**SummaryView:** `{asOf,total,enabled,paused,unknown,up,degraded,down,activeIncidents}`; the four health counts partition enabled monitors only. **EngineView:** `{asOf,running,queued,due,oldestDueLagMs,cancelled,abandoned,databaseQueueLength,checkConcurrency,lastBackgroundFailure,retentionProtectedIncidents,retentionDeleted,retentionBacklog}`. Cancellation/abandonment counts describe retained rows; maintenance deletion is a process-local cumulative counter. Due counts include unsettled monitors whose due slot has not yet been advanced. This is an aggregate resource, not a collection. Storage faults can make database-backed diagnostics unavailable with 503; liveness and safe readiness remain available.

**DashboardView:** `{asOf,window:"24h",counts:SummaryViewWithoutAsOf,sampleCount,sampledAvailabilityPercent,meanLatencyMs,recentIncidents:[IncidentView],recentTransitions:[StateTransition]}` with at most 10 recent incidents and 10 transitions. counts includes activeIncidents; the outer asOf is the snapshot timestamp. The overall sample ratio includes all retained counted checks started in the last 24h, including manual checks; latency uses successful response headers only. Health counts partition enabled monitors only; paused is separate. `include=summary` on paginated monitor list adds `summary:{sampleCount,sampledAvailabilityPercent,meanLatencyMs,latestLatencyMs,knownMs,eligibleMs,coverageIncomplete}` for the last 24h, alongside the existing lastCheckAt; it must use batched queries rather than one request per card. Status filters refer to health even when paused; enabled is a separate filter.

## Examples

```json
{
  "name": "Public API health",
  "url": "https://example.com/health",
  "method": "GET",
  "expectedStatusCodes": [200,204],
  "intervalMs": 60000,
  "timeoutMs": 10000,
  "followRedirects": false,
  "failureThreshold": 3,
  "recoveryThreshold": 2
}
```

Illustrative 201 response (not evidence of a running implementation):

```json
{
  "data": {
    "id": "ea48a6d0-d4e5-4fd4-b8d0-bc638c2ca8a4",
    "name": "Public API health",
    "url": "https://example.com/health",
    "method": "GET",
    "expectedStatusCodes": [200,204],
    "intervalMs": 60000,
    "timeoutMs": 10000,
    "followRedirects": false,
    "enabled": true,
    "failureThreshold": 3,
    "recoveryThreshold": 2,
    "latencyThresholdMs": 1000,
    "degradationThreshold": 3,
    "revision": 1,
    "lastCheckAt": null,
    "lastObservedOutcome": null,
    "status": {"state": "UNKNOWN", "reason": "INITIAL"},
    "createdAt": "2026-10-09T12:00:00.000Z",
    "updatedAt": "2026-10-09T12:00:00.000Z",
    "nextDueAt": "2026-10-09T12:00:00.000Z"
  }
}
```

The embedded Monitor `status` is the compact `{state,reason}` view. Full persisted MonitorStatus counters are internal; transitions and incident links supply operator history without exposing execution fencing internals.

```json
{
  "data": [{
    "id": "22d58f21-33ae-4ab1-ad65-f313665e196d",
    "monitorId": "ea48a6d0-d4e5-4fd4-b8d0-bc638c2ca8a4",
    "sequence": 41,
    "serviceRunId": "3b2244c0-7ed1-49ba-82c7-c83a1f8cbd68",
    "monitorRevision": 1,
    "executionEpoch": 1,
    "trigger": "automatic",
    "lifecycle": "COMPLETED",
    "queuedAt": "2026-10-09T12:01:00.000Z",
    "scheduledAt": "2026-10-09T12:01:00.000Z",
    "startedAt": "2026-10-09T12:01:00.005Z",
    "completedAt": "2026-10-09T12:01:00.125Z",
    "outcome": "SUCCESS",
    "httpStatus": 200,
    "durationMs": 120,
    "redirectCount": 0,
    "errorCode": null
  }],
  "page": {"nextCursor": null, "limit": 50, "asOf": "2026-10-09T12:02:00.000Z"}
}
```

## Live invalidation and API limits

SSE event `invalidate` carries `{version:1,resource:"monitors"|"incidents"|"deliveries",ids:[UUID],occurredAt:timestamp}`. IDs are limited to 100 per message. Event IDs are process-local advisory IDs, not a durable replay cursor. On reconnect always refetch current queries; Last-Event-ID does not promise replay. Heartbeats every 15 seconds contain no operator data. Admitted SSE sockets use a finite 30-second idle timeout so the heartbeat can arrive; ordinary HTTP sockets retain ten seconds. Limit 20 connected streams process-wide, 64 KiB pending bytes per connection; drop slow clients so they reconnect and refetch. Authenticate at connection and close at session expiry. See [frontend](12-FRONTEND-ARCHITECTURE.md).

Process-wide token-bucket limits: 3,000 reads/minute and 60 mutations/minute per authenticated operator or local client IP, burst equal to one minute. Login is 5 attempts/minute per trustworthy source IP and 30/minute globally. Manual queue and execution limits apply in addition. Trusted-proxy parsing must precede source-IP rate limiting. No limiter is a DDoS guarantee; remote deployments need host/proxy controls.

## Stage 3 implemented additions

Incident listing additionally accepts `q` (trimmed monitor-name substring, at most 120 characters) and `failureCategory` (shared outcome enum; unmatched categories return an empty list). These fields are cursor-bound like existing filters. Notification diagnostics returns `{pending,inFlight,succeeded,dead,cancelled,oldestPendingAgeMs,workerFailure}` inside the usual data envelope. History and delivery pages default to 50 and remain capped at 100; the dashboard explicitly requests 25 monitors. Delivery reads omit payloadJson, secret aliases and URL/key values.
