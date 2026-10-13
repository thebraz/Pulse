# Pulse product requirements

Status: normative baseline, 2026-10-09, extended under Stages 2 and 3 authorization on 2026-10-11. MUST denotes a release-blocking requirement; SHOULD requires a documented exception with evidence. Requirements remain assigned by stage; actual verification is recorded in the [Stage 1 report](../VERIFICATION.md#historical-stage-1) [Stage 2 report](../VERIFICATION.md#historical-stage-2) and [Stage 3 report](../VERIFICATION.md#historical-stage-3), not implied by this specification.

## Vision and users

Pulse is a self-hosted HTTP application monitoring and incident platform for developers, small engineering teams and operators who need understandable evidence about the services they run. It records observations, applies explicit incident thresholds and presents qualified historical metrics. It is a single-instance operator tool, not a distributed global uptime authority or an SLA certification system.

Primary journeys are configuring an HTTP target, checking it automatically or manually, investigating a failure and its recovery, reviewing qualified availability and latency, and receiving incident webhooks. No hosted control plane, account registration, paid API or recurring infrastructure is required.

## Scope, lifecycle and boundaries

Stages are [Foundation](../stages/STAGE-1-FOUNDATION.md), [Reliability](../stages/STAGE-2-RELIABILITY.md), [Dashboard and alerts](../stages/STAGE-3-DASHBOARD.md), and [Release](../stages/STAGE-4-RELEASE.md). Each requires fresh explicit user authorization. A specification is not an implementation result.

A monitor is created enabled or paused, checked, edited under revision control, paused/resumed, then explicitly deleted. Pausing preserves history and unresolved incidents. Health and enablement are separate concepts. Stage 1 records outcomes but returns health UNKNOWN until Stage 2 implements the evaluator; it must not approximate DOWN from a single failed request.

The supported deployment is one Node.js process and one local SQLite database on a host, with a browser on the same origin. Remote access is opt-in and authenticated behind HTTPS. Private-network targets are opt-in through CIDR allowlists. The security boundary assumes the host administrator can read local files and control the process.

Excluded from Stages 1–4: multi-tenancy, user registration, team roles, distributed probes, active-active scheduling, ping/TCP/browser-script monitoring, request bodies, arbitrary monitor headers, email/SMS/Slack-specific integrations, public status pages, tracing/APM, billing and guaranteed continuous uptime. Optional future enhancements need a new requirement and explicit scope approval; they must not appear as required work in these stages.

## Mandatory functional requirements

| ID | Stage | Requirement | Verifiable acceptance condition |
| --- | --- | --- | --- |
| PULSE-FR-001 | 1 | **Monitor management.** Create, read, update and delete monitors with validated configuration and revision checks; deletion removes monitor-owned history only after explicit API confirmation. | CRUD round-trip succeeds; stale revisions return 409; unconfirmed deletion returns 400. |
| PULSE-FR-002 | 1 | **HTTP checks.** Execute GET and HEAD checks with an expected status-code set; enforce the shared outbound security policy at every connection and redirect. | Expected status succeeds; DNS, TLS, timeout, redirect and policy failures have distinct outcomes. |
| PULSE-FR-003 | 1 | **Timing and result fidelity.** Persist UTC start/completion timestamps and monotonic full-request duration; never store response bodies or credential-bearing URLs. | Duration includes DNS, connection, TLS and redirect time; interrupted checks have no fabricated latency. |
| PULSE-FR-004 | 1 | **Automatic scheduling.** Schedule enabled monitors at their configured interval with one unsettled execution per monitor and no missed-slot catch-up bursts. | Overdue monitors run once when capacity exists; concurrent runs for the same monitor never occur. |
| PULSE-FR-005 | 1 | **Manual checks.** Accept bounded asynchronous manual checks through the same executor and concurrency budget. | 202 returns an execution ID; repeated unsettled requests coalesce; saturation returns 429. |
| PULSE-FR-006 | 1 | **Pause and resume.** Disable future dispatch, cancel queued/running work, retain history, and resume with a fresh observation context. | Cancelled work cannot change health; resume makes one check eligible without replaying missed slots. |
| PULSE-FR-007 | 1 | **Check history.** Expose paginated, filtered check history with stable ordering and a deterministic cursor. | Pages have no duplicate rows within the declared snapshot; outcome filters match stored results. |
| PULSE-FR-008 | 2 | **Monitor health.** Derive UNKNOWN, UP, DEGRADED and DOWN using the specified failure, latency and recovery counters. | Every allowed conditional transition matches the state machine; invalid transitions are rejected. |
| PULSE-FR-009 | 2 | **Incident lifecycle.** Create and resolve incidents transactionally with checks; permit at most one unresolved incident per monitor. | Threshold crossing opens one incident; recovery resolves the same incident exactly once in storage. |
| PULSE-FR-010 | 2 | **Historical metrics.** Return sampled availability, latency summaries, nearest-rank percentiles and incident-based observed downtime with coverage metadata. | Results match the metric specification; empty denominators produce null instead of invented percentages. |
| PULSE-FR-011 | 2 | **Restart recovery.** Abandon unfinished work, retain unresolved incidents and recover overdue schedules without replay storms. | No abandoned attempt counts as a target failure; no duplicate unresolved incident is created. |
| PULSE-FR-012 | 2 | **Retention.** Delete expired terminal checks and resolved history in bounded batches while protecting unresolved incidents and pending deliveries. | Defaults and boundary rules match persistence policy; protected records survive pruning. |
| PULSE-FR-013 | 3 | **Dashboard.** Show monitor counts, current health, sampled availability, latency, coverage and recent incidents with explicit stale/error states. | Displayed values equal API values and unknown coverage remains visible. |
| PULSE-FR-014 | 3 | **Monitor workflow.** Provide validated create/edit/pause/resume/manual-check flows and monitor detail history and charts. | Actions reach the running backend and persisted results survive page reload. |
| PULSE-FR-015 | 3 | **Incident views.** Provide incident list/detail views with onset, detection, recovery, resolution and observation-gap context. | Open and resolved incident timestamps and durations use the analytics contract. |
| PULSE-FR-016 | 3 | **Live updates.** Use bounded same-origin SSE invalidations with polling recovery and no implied durable event replay. | A missed event is corrected by refetch; stale data is visibly labelled. |
| PULSE-FR-017 | 3 | **Webhook events.** Enqueue versioned incident.opened and incident.resolved events in the incident transaction for enabled destinations. | Committed transitions produce delivery rows; rolled-back transitions produce none. |
| PULSE-FR-018 | 3 | **Webhook delivery.** Deliver persistent webhook jobs with bounded concurrency, deterministic backoff, finite retries and stable event IDs. | Retry schedule and terminal outcomes match the contract; duplicate remote delivery remains possible and documented. |
| PULSE-FR-019 | 3 | **Destination settings.** Manage masked webhook destinations and write-only signing secrets; disabling cancels future pending delivery work. | Credentials never appear in reads; disabled destinations receive no new jobs. |
| PULSE-FR-020 | 3 | **Search and filtering.** Search monitor names and filter health/enabled state; filter incidents and history using shared query semantics. | Matching records and URL-backed filters agree across API and UI. |
| PULSE-FR-021 | 1 | **Configuration.** Load and validate typed startup settings with explicit defaults and secret-file references; reject unknown PULSE_ keys. | Invalid settings fail before traffic or outbound requests; secrets never appear in errors. |
| PULSE-FR-022 | 1 | **Health endpoints.** Expose sanitized liveness and dependency-aware readiness; readiness fails during startup, shutdown or persistent database faults. | Health responses expose no targets, secrets or paths; readiness reflects actual ability to persist checks. |
| PULSE-FR-023 | 4 | **Installation.** Distribute a tested npm workspace build and self-hosted runtime without paid services or mandatory accounts. | A clean supported machine can install the candidate archive and monitor a controlled target. |
| PULSE-FR-024 | 4 | **Backup and restore.** Document and validate a consistent SQLite backup/restore procedure with checksum and post-restore integrity checks. | Restored data, incidents and pending delivery IDs match the snapshot; recovery follows restart rules. |
| PULSE-FR-025 | 4 | **Safe upgrades.** Apply ordered transactional migrations, refuse unsupported/newer schemas and validate upgrade from each supported prior release. | Failure leaves a usable pre-migration database or documented verified restoration path; no silent downgrade occurs. |
| PULSE-FR-026 | 4 | **Public documentation.** Ship installation, configuration, security, operations, API and support documentation consistent with the validated archive. | Public guides work against the candidate; private agent instructions are absent from every release artifact. |
| PULSE-FR-027 | 1 | **Graceful shutdown.** Stop accepting new work, abort network activity, commit terminal outcomes, drain bounded persistence work and close resources within a deadline. | Shutdown ends within 15 seconds or exits unsuccessfully; unfinished work is recoverable as abandoned. |
| PULSE-FR-028 | 2 | **Atomic processing.** Commit completed checks, evaluator counters, state transitions and incident changes as one transaction with revision fencing. | Either all changes commit or none do; late cancelled/reconfigured results never affect health. |
| PULSE-FR-029 | 2 | **Observation coverage.** Record service operation and monitor enablement windows; identify UNKNOWN, paused and service-offline intervals in historical queries. | Downtime excludes unobserved intervals and API reports excluded time explicitly. |

## Mandatory non-functional requirements

| ID | Stage | Requirement | Verifiable acceptance condition |
| --- | --- | --- | --- |
| PULSE-NFR-001 | 1 | **Local operation.** Bind to 127.0.0.1 by default, use local persistence and operate with no mandatory external control plane. | Core monitoring of permitted local fixtures works with internet access disabled. |
| PULSE-NFR-002 | 1 | **Strict types.** Use strict TypeScript and runtime validation at every untrusted boundary; share public schemas and inferred types. | No implicit any or unchecked boundary input; schema mismatches fail predictably. |
| PULSE-NFR-003 | 1 | **Module boundaries.** Use directed workspace dependencies and keep network, persistence and UI business logic separate. | No circular workspace imports; frontend cannot import backend infrastructure. |
| PULSE-NFR-004 | 1 | **Outbound security.** Deny non-approved network targets, pin validated DNS addresses and revalidate every redirect and new connection. | Public-only mode blocks internal/reserved targets, rebinding and metadata endpoints; explicit CIDR exceptions are narrowly enforced. |
| PULSE-NFR-005 | 1 | **Remote access security.** Refuse remote exposure without configured authentication and declared HTTPS origin; enforce browser origin, host and CSRF controls. | Unauthenticated protected requests fail; untrusted proxy/origin/Host input cannot bypass checks. |
| PULSE-NFR-006 | 1 | **Secret handling.** Use secret files, redaction and write-only APIs; prohibit sensitive headers, payloads and full URLs in logs and live events. | Canaries are absent from logs, API reads, errors, SSE and build artifacts. |
| PULSE-NFR-007 | 2 | **Bounded work.** Bound all queues, network pools, SSE buffers and maintenance batches; give overdue automatic checks fair access. | Queue/memory limits hold; manual checks and webhooks cannot starve automatic scheduling. |
| PULSE-NFR-008 | 2 | **Persistence integrity.** Use SQLite foreign keys, unique constraints, WAL, explicit transactions and a single database owner on local storage. | Invalid relationships and duplicate unsettled work fail; outages never produce partial incident state. |
| PULSE-NFR-009 | 2 | **Honest analytics.** Expose sample counts, coverage, exclusions, percentile method and low-sample flags; make no SLA or continuous-uptime claims. | Missing samples never become success; absent coverage or latency yields null with explanatory metadata. |
| PULSE-NFR-010 | 3 | **Accessibility.** Support keyboard-only interaction, semantic labels, visible focus, reduced motion and WCAG AA contrast. | Primary workflows work without a mouse; status has text/icon meaning beyond color; no serious automated violations. |
| PULSE-NFR-011 | 3 | **Responsive UI.** Provide dark-first readable layouts at 360px, 768px and 1440px widths without inaccessible page overflow. | Controls, charts and table alternatives remain reachable at each width and 200% zoom. |
| PULSE-NFR-012 | 4 | **Measured capacity.** Meet the documented 100-monitor reference load and API/browser budgets with published hardware, dataset and measurement method. | All mandatory budgets pass; capacity claims stay within the tested envelope. |
| PULSE-NFR-013 | 1 | **Verification integrity.** Run stage-relevant automated and manual checks; record exact evidence and never weaken tests or fabricate results. | Each mandatory acceptance row has authentic evidence before PASS; unrun checks remain NOT TESTED. |
| PULSE-NFR-014 | 4 | **Operational recovery.** Survive process termination, read-only storage and restore/upgrade rehearsals with explicit failure signals and documented recovery. | No silent data reset; faulted readiness and nonzero exits identify unrecoverable conditions. |
| PULSE-NFR-015 | 4 | **Release control.** Validate immutable candidate artifacts, inspect exclusions and require explicit user authorization before publication. | Candidate passes all gates; publishing, pushing and releases do not occur on documentation/stage authorization alone. |
| PULSE-NFR-016 | 1 | **Stage authorization.** Treat documentation, each of Stages 1–4 and public publication as separate authorizations. | Implementation starts only after explicit Stage 1 authorization; no stage advances automatically. |
| PULSE-NFR-017 | 1 | **Language consistency.** Write code identifiers, comments, public documentation and default product UI in professional English. | Public artifacts contain consistent English terminology and no invented product claims. |
| PULSE-NFR-018 | 1 | **Cost and dependency discipline.** Require no paid API, mandatory SaaS account or recurring service; justify each runtime dependency. | Required components are locally runnable with open-source tooling and documented licenses. |
| PULSE-NFR-019 | 2 | **Storage pressure.** Keep maintenance bounded and fail safely on full/unwritable disks; never purge protected history to hide faults. | Readiness fails and dispatch pauses; retained history is not silently reset or overwritten. |
| PULSE-NFR-020 | 2 | **Operational diagnostics.** Expose structured sanitized logs and aggregate scheduler, database and delivery counters without high-cardinality secrets. | Each background failure has a safe code and context; queue lag and persistence failures are observable. |

## Configuration, usability and failures

Startup configuration uses validated PULSE_ environment keys plus file paths to secrets. Database, concurrency, exposure, egress and retention settings are startup-only; changes require a controlled restart. Monitor and destination settings use authenticated APIs. Defaults and limits are normative in [domain models](03-DOMAIN-MODELS.md); invalid configuration must never silently fall back.

Errors use the [API envelope](04-API-CONTRACTS.md), a stable safe code and request ID. Validation identifies fields without echoing submitted secrets. Database failure means an unavailable write path, not a failed target. The UI must distinguish unknown, paused, loading, stale, empty and failed states; destructive deletion names its consequences.

Raw checks default to 30 days; resolved incidents and transitions to 365 days; terminal webhook deliveries to 30 days. Pending deliveries and unresolved incidents are protected. Historical requests outside retained coverage must expose incomplete data. See [persistence](09-DATABASE-AND-PERSISTENCE.md) and [analytics](08-METRICS-AND-ANALYTICS.md).

## Completion and traceability

[Acceptance criteria](ACCEPTANCE-CRITERIA.md) define executable verification gates. [Traceability](REQUIREMENTS-TRACEABILITY.md) assigns every requirement to a subsystem and test category. Changes to scope or semantics require a linked [architectural decision](ARCHITECTURAL-DECISIONS.md) and synchronized contracts. Initial acceptance status is NOT TESTED.
