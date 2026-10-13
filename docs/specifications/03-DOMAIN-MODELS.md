# Pulse domain models

This is the authoritative field/default vocabulary for [API](04-API-CONTRACTS.md), [state](07-INCIDENT-STATE-MACHINE.md) and [storage](09-DATABASE-AND-PERSISTENCE.md). `?` means optional input; `null` is an explicit absent output. Public objects use camelCase; SQL uses snake_case. IDs are server-generated UUIDs. All timestamps are UTC RFC 3339 with millisecond precision at the API boundary. Durations are nonnegative finite milliseconds; counters are nonnegative safe integers.

## Monitor

| Field | Type / default | Validation and semantics |
| --- | --- | --- |
| id | UUID, generated | Immutable primary key. |
| name | string, required | Trimmed 1–120 characters; plain text, not unique. |
| url | string, required | Absolute http/https URL, at most 2,048 characters; no userinfo, query or fragment. Outbound policy also applies. |
| method | GET or HEAD / GET | No bodies or arbitrary headers in this roadmap. |
| expectedStatusCodes | integer[] / [200] | Sorted unique list, 1–50 elements in 200–599; informational responses are not final success. |
| intervalMs | integer / 60000 | 15000–3600000. |
| timeoutMs | integer / 10000 | 1000–30000; may exceed interval, without overlap or catch-up. |
| followRedirects | boolean / false | If true, at most 3 hops, each checked separately. |
| enabled | boolean / true | Administrative enablement, independent of health. |
| failureThreshold | integer / 3 | 1–10 consecutive counted failures. Stage 2 behavior. |
| recoveryThreshold | integer / 2 | 1–10 consecutive successful checks. Stage 2 behavior. |
| latencyThresholdMs | integer / 1000 | 1–30000; a successful observation at or above this duration is slow. |
| degradationThreshold | integer / 3 | 1–10 consecutive slow successes for UP to become DEGRADED. |
| revision | integer / 1 | Increments on each edit, including enabled change; optimistic concurrency fence. |
| createdAt, updatedAt | timestamp | Server-controlled. |
| nextDueAt | timestamp or null | Null when disabled; scheduling metadata, read-only. |
| lastCheckAt | timestamp or null | Start time of the latest retained COMPLETED check, by sequence; cancelled/abandoned attempts do not replace it. Read-only derived projection. |
| lastObservedOutcome | CheckResult outcome or null | Outcome of that same retained completed check; distinct from Stage 2 health. Read-only. |
| status | MonitorStatus | Read-only projection; UNKNOWN throughout Stage 1. |

Static URL/literal-address security is enforced at mutation time; DNS and actual-address policy are always enforced at execution, because records and configuration can change. An unresolvable hostname can be saved so its DNS failures can be observed. DELETE cascades monitor-owned checks, transitions, activity windows and incidents, and cancels/removes associated delivery rows atomically. The API requires explicit confirmation; no implicit archive behavior is promised. Renaming preserves historical state; changes to target/method/expected codes/timing/thresholds or enabled state cancel unsettled work, reset counters and move health to UNKNOWN. An unresolved incident is retained and labelled with its original monitor revision; it is never silently resolved by an edit.

## CheckResult

| Field | Type | Rules |
| --- | --- | --- |
| id, monitorId, serviceRunId | UUID | Required relationships; execution identity is allocated before dispatch. |
| sequence | integer | Database-generated increasing key; history pagination order. |
| monitorRevision, executionEpoch | integer | Revision and process/lifecycle fence captured at reservation. |
| trigger | automatic or manual | Required. |
| lifecycle | QUEUED, RUNNING, COMPLETED, CANCELLED, ABANDONED | Only COMPLETED is a health observation. |
| queuedAt | timestamp | Required on allocation. |
| scheduledAt, startedAt, completedAt | timestamp or null | scheduledAt is the slot consumed, if any; startedAt only after dispatch; completedAt for all terminal rows. |
| outcome | SUCCESS, HTTP_ERROR, DNS_ERROR, TLS_ERROR, CONNECTION_ERROR, TIMEOUT, REDIRECT_ERROR, POLICY_BLOCKED, or null | Required for COMPLETED; null for CANCELLED/ABANDONED and unsettled rows. |
| httpStatus | integer or null | Final response code if final headers were received; do not invent one on a transport failure. |
| durationMs | number or null | Monotonic duration through final headers; valid only for COMPLETED. Failures can have durations, but are excluded from successful-latency statistics. |
| redirectCount | integer / 0 | 0–3; count of followed hops. |
| errorCode | safe string or null | Stable classification, never raw network error text, URL or credentials. |

At most one QUEUED/RUNNING row exists per monitor. Terminal rows are immutable. A result cancelled by pause, reconfiguration or shutdown cannot become COMPLETED afterward. A late transport callback loses its fence and is discarded; the existing terminal row stays unchanged. Restart changes unsettled rows to ABANDONED, not TIMEOUT. Every terminal update is committed before it is exposed as complete.

## MonitorStatus

| Field | Type | Invariant |
| --- | --- | --- |
| monitorId | UUID | One projection per monitor. |
| state | UNKNOWN, UP, DEGRADED, DOWN | Enablement is never encoded as a fifth state. |
| reason | INITIAL, HEALTHY, SLOW, PENDING_FAILURE, FAILURE_THRESHOLD, RECOVERING, PAUSED, RECONFIGURED, RESTARTED, POLICY_BLOCKED | Safe reason consistent with state and [transition rules](07-INCIDENT-STATE-MACHINE.md). |
| consecutiveFailures, consecutiveSuccesses, consecutiveSlow, consecutiveFast | integer | Reset semantics are defined in the evaluator. |
| failureRunStartedAt, recoveryRunStartedAt | timestamp or null | Earliest check startedAt in the current uninterrupted run. |
| lastCheckId | UUID or null | Latest counted result; nullable after history pruning. |
| stateChangedAt | timestamp | Last state transition, not every check. |
| openIncidentId | UUID or null | DOWN requires non-null; UNKNOWN after lifecycle reset may retain one. |

The projection is persisted with its responsible check. It is rebuilt/reset under explicit migration/restart rules, never by running frontend logic.

## Incident

| Field | Type | Invariant |
| --- | --- | --- |
| id, monitorId | UUID | Immutable identity and owner. |
| monitorRevision | integer | Revision when outage was first established. |
| status | OPEN or RESOLVED | RESOLVED implies observedEndAt and resolvedAt are non-null. |
| openedAt | timestamp | First failure startedAt in the qualifying run; observation onset, not proof of actual service failure time. |
| detectedAt | timestamp | Threshold-crossing check completedAt; openedAt <= detectedAt. |
| observedEndAt | timestamp or null | First success startedAt in the qualifying recovery run. |
| resolvedAt | timestamp or null | Recovery-threshold check completedAt; observedEndAt <= resolvedAt. |
| openingCheckId, resolvingCheckId | UUID or null | Origin evidence; nullable after raw-check retention. |
| openingTransitionId, resolvingTransitionId | UUID or null | Required opening link; resolving link only after resolution. Retention preserves these anchors. |
| failureCategory, diagnosticSummary | outcome enum, safe string | Counted failure on the confirming check and bounded server-generated diagnostic text; no raw transport errors. |
| durationMs, ongoing | nonnegative number, boolean | Computed raw observed span (end/on-going asOf minus openedAt), potentially including gaps. |
| resolutionSummary | string or null | Server-generated confirmation description after resolution. Detail includes coverage-clipped duration and anchor transitions. |

At most one OPEN incident exists per monitor, enforced in SQLite. Pausing/restarting/reconfiguring does not resolve it. Raw incident span may include observation gaps; observed downtime must intersect coverage. Deletion of the owning monitor explicitly deletes its incident history.

## StateTransition

| Field | Type | Invariant |
| --- | --- | --- |
| id, monitorId | UUID | Persisted append-only record. |
| fromState, toState | health enum | Different values; no row for an unchanged state. |
| reason | MonitorStatus reason | Deterministic cause. |
| occurredAt | timestamp | Completion time of causal check or administrative action time. |
| checkId | UUID or null | Null for administrative reset; nullable after pruning. |
| monitorRevision, executionEpoch | integer | Fencing context. |

A transition describes the health projection, not retroactive outage onset. Transition and incident IDs may cross-reference within the same deferred-constraint transaction. Unchanged-state incident recovery from UNKNOWN can still produce a transition to UP/DEGRADED. Duplicate processing of a terminal execution cannot insert another transition.

## NotificationDestination

| Field | Type / default | Rules |
| --- | --- | --- |
| id | UUID | Immutable. |
| name | string, required | Trimmed 1–120 characters. |
| enabled | boolean / true | Controls new enqueueing and pending-job cancellation. |
| urlSecretRef | string, required write-only | Alias matching [A-Za-z0-9_-]{1, 64}; resolves only inside the configured secrets directory to an administrator-provisioned `.url` file. No arbitrary paths. |
| signingSecretRef | string or null, write-only | Same alias rule; `.key` file with at least 32 random bytes, when configured. |
| urlConfigured, signingConfigured | boolean, output only | Safe replacement for secret values/references in read DTOs. |
| revision | integer / 1 | Increments on change; optimistic concurrency. |
| createdAt, updatedAt | timestamp | Server-owned. |

Webhook URLs may contain query/path credentials and are therefore never returned by read APIs. Raw values are held only during delivery and are not persisted in job payloads. HTTPS is mandatory for public destinations; explicitly permitted private/loopback test receivers may use HTTP. Changing a destination cancels its pending jobs rather than delivering an old event to a new URL. The destination API provisions references, not arbitrary filesystem content.

## NotificationDelivery

| Field | Type | Rules |
| --- | --- | --- |
| id, eventId, destinationId, incidentId | UUID; incidentId nullable for fixed tests | Stable IDs; unique eventId + destinationId. |
| destinationRevision | integer | Enqueue-time revision; a mismatch cancels delivery. |
| eventType | incident.opened, incident.resolved or notification.test | Versioned payload defined in [notifications](11-NOTIFICATION-SYSTEM.md). |
| payloadJson | validated JSON | Immutable safe snapshot; no target URL or secrets. |
| state | PENDING, IN_FLIGHT, SUCCEEDED, DEAD, CANCELLED | Only PENDING is claimable when due. |
| attemptCount | integer | Incremented durably before outbound send; maximum 5. |
| nextAttemptAt, claimedAt | timestamp or null | Due time or current attempt ownership. |
| lastHttpStatus | integer or null | Sanitized result metadata. |
| lastErrorCode | safe string or null | Never response body or raw transport text. |
| createdAt, updatedAt, finishedAt | timestamp or null | finishedAt only for terminal states. |

Delivery uses finite best-effort retries and can duplicate remote receipt; receipt is not guaranteed. An uncertain attempt after crash consumes its attempt number and may be retried. Terminal records are immutable except retention/deletion. Recovered IN_FLIGHT jobs are rescheduled or DEAD if their budget is exhausted.

## MonitoringConfiguration

Typed startup configuration is immutable for the process. Environment names below are exact. Integer parsing rejects fractions, NaN and out-of-range values; booleans accept only `true` or `false`. Paths resolve once against the startup directory, not a later working directory.

| Key | Default | Constraints |
| --- | --- | --- |
| PULSE_HOST | 127.0.0.1 | Loopback unless exposure is remote. |
| PULSE_PORT | 3000 | Integer 1–65535. |
| PULSE_DATA_DIR | OS home directory + /.pulse | Writable local filesystem; canonical exclusive lock. Explicit relative overrides resolve from the working directory. |
| PULSE_EXPOSURE | local | local or remote; local rejects non-loopback bind. |
| PULSE_PUBLIC_ORIGIN | http://127.0.0.1:3000 | Exact origin; remote requires https; explicit setting when port/host differ. |
| PULSE_AUTH_TOKEN_FILE | unset | Required in remote mode; at least 32 cryptographically random bytes. Never accept token values in env/CLI. |
| PULSE_SECRETS_DIR | ./secrets | Administrator-owned, outside served assets; realpath containment required. |
| PULSE_TRUSTED_PROXY_CIDRS | empty | Explicit list; never trust all forwarded headers. |
| PULSE_EGRESS_POLICY | public-only | public-only or allow-private. |
| PULSE_ALLOWED_PRIVATE_CIDRS | empty | Required for allow-private; metadata/link-local/unspecified/multicast still forbidden. |
| PULSE_CHECK_CONCURRENCY | 10 | Integer 1–50. |
| PULSE_MANUAL_QUEUE_LIMIT | 100 | Integer 1–1000. |
| PULSE_DB_QUEUE_LIMIT | 1000 | Integer 10–10000; must exceed checkConcurrency+webhookConcurrency+2 to reserve in-flight completion and shutdown bookkeeping capacity. |
| PULSE_WEBHOOK_CONCURRENCY | 2 | Integer 1–10; Stage 3. |
| PULSE_CHECK_RETENTION_DAYS | 30 | Integer 1–365; Stage 2. |
| PULSE_INCIDENT_RETENTION_DAYS | 365 | Integer 30–3650; Stage 2. |
| PULSE_DELIVERY_RETENTION_DAYS | 30 | Integer 1–365; Stage 3. |
| PULSE_LOG_LEVEL | info | debug, info, warn or error; redaction always applies. |

Unknown PULSE_ settings are startup errors. Defaults do not permit private targets, remote access or anonymous public operation. Hard bounds not exposed as configuration are specified in their owning documents. The process persists a non-secret effective-configuration fingerprint per service run for diagnostics, not a copy of secret files.
