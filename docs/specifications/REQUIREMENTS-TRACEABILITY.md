# Pulse requirements traceability

This matrix covers every mandatory requirement in [product requirements](01-PRODUCT-REQUIREMENTS.md). Acceptance IDs are unique. Categories define the minimum verification suite; combined suites and manual review may add evidence. No requirement is satisfied merely by appearing here.

Stage 2 mappings are backed by `state-machine.test.ts` (FR-008), `incident-persistence.test.ts` (FR-009/028, NFR-008/019), `metrics-retention.test.ts` (FR-010/012/029, NFR-009), `reliability-api.test.ts` (NFR-007/019/020), `scheduler.test.ts` (NFR-007), `process.test.ts` (FR-011/028) and `performance.test.ts` (synthetic scalability). Applicable foundation/security/transport suites remain in the full run. The [Stage 2 report](../STAGE-2-REPORT.md) maps all 25 requested scenarios to executable evidence; frontend/SSE/webhook clauses remain assigned to Stage 3 and reference-capacity/OS recovery gates to Stage 4.

| Requirement | Stage | Responsible subsystem | Acceptance criterion | Automated test category / additional review |
| --- | --- | --- | --- | --- |
| PULSE-FR-001 | 1 | API and monitor repository | [PULSE-S1-001](ACCEPTANCE-CRITERIA.md) | Integration/database |
| PULSE-FR-002 | 1 | HTTP executor | [PULSE-S1-002](ACCEPTANCE-CRITERIA.md) | Integration/security |
| PULSE-FR-003 | 1 | HTTP executor and persistence | [PULSE-S1-003](ACCEPTANCE-CRITERIA.md) | Unit/integration |
| PULSE-FR-004 | 1 | Scheduler | [PULSE-S1-004](ACCEPTANCE-CRITERIA.md) | Scheduler/concurrency |
| PULSE-FR-005 | 1 | Scheduler and API | [PULSE-S1-005](ACCEPTANCE-CRITERIA.md) | Integration/concurrency |
| PULSE-FR-006 | 1 | Monitor lifecycle | [PULSE-S1-006](ACCEPTANCE-CRITERIA.md) | Scheduler/integration |
| PULSE-FR-007 | 1 | Query API | [PULSE-S1-007](ACCEPTANCE-CRITERIA.md) | Integration/database |
| PULSE-FR-008 | 2 | Health evaluator | [PULSE-S2-001](ACCEPTANCE-CRITERIA.md) | Unit/state-machine |
| PULSE-FR-009 | 2 | Incident engine | [PULSE-S2-002](ACCEPTANCE-CRITERIA.md) | Unit/database |
| PULSE-FR-010 | 2 | Analytics | [PULSE-S2-003](ACCEPTANCE-CRITERIA.md) | Unit/integration |
| PULSE-FR-011 | 2 | Runtime recovery | [PULSE-S2-004](ACCEPTANCE-CRITERIA.md) | Restart/database |
| PULSE-FR-012 | 2 | Retention worker | [PULSE-S2-005](ACCEPTANCE-CRITERIA.md) | Database/integration |
| PULSE-FR-013 | 3 | Dashboard | [PULSE-S3-001](ACCEPTANCE-CRITERIA.md) | Frontend/end-to-end |
| PULSE-FR-014 | 3 | Monitor UI | [PULSE-S3-002](ACCEPTANCE-CRITERIA.md) | Frontend/end-to-end |
| PULSE-FR-015 | 3 | Incident UI | [PULSE-S3-003](ACCEPTANCE-CRITERIA.md) | Frontend/end-to-end |
| PULSE-FR-016 | 3 | SSE and server-state client | [PULSE-S3-004](ACCEPTANCE-CRITERIA.md) | Integration/end-to-end |
| PULSE-FR-017 | 3 | Notification outbox | [PULSE-S3-005](ACCEPTANCE-CRITERIA.md) | Database/integration |
| PULSE-FR-018 | 3 | Delivery worker | [PULSE-S3-006](ACCEPTANCE-CRITERIA.md) | Integration/restart |
| PULSE-FR-019 | 3 | Destination API and UI | [PULSE-S3-007](ACCEPTANCE-CRITERIA.md) | Security/end-to-end |
| PULSE-FR-020 | 3 | Query API and UI | [PULSE-S3-008](ACCEPTANCE-CRITERIA.md) | Integration/frontend |
| PULSE-FR-021 | 1 | Configuration loader | [PULSE-S1-008](ACCEPTANCE-CRITERIA.md) | Configuration/security |
| PULSE-FR-022 | 1 | Runtime and API | [PULSE-S1-009](ACCEPTANCE-CRITERIA.md) | Integration |
| PULSE-FR-023 | 4 | Distribution | [PULSE-S4-001](ACCEPTANCE-CRITERIA.md) | Package/end-to-end |
| PULSE-FR-024 | 4 | Operations | [PULSE-S4-002](ACCEPTANCE-CRITERIA.md) | Database/restart |
| PULSE-FR-025 | 4 | Migrations | [PULSE-S4-003](ACCEPTANCE-CRITERIA.md) | Database/package |
| PULSE-FR-026 | 4 | Release documentation | [PULSE-S4-004](ACCEPTANCE-CRITERIA.md) | Package/manual |
| PULSE-FR-027 | 1 | Runtime lifecycle | [PULSE-S1-010](ACCEPTANCE-CRITERIA.md) | Integration/restart |
| PULSE-FR-028 | 2 | Result processor | [PULSE-S2-006](ACCEPTANCE-CRITERIA.md) | Database/concurrency |
| PULSE-FR-029 | 2 | Coverage model | [PULSE-S2-007](ACCEPTANCE-CRITERIA.md) | Database/analytics |
| PULSE-NFR-001 | 1 | Runtime | [PULSE-S1-011](ACCEPTANCE-CRITERIA.md) | Integration/manual |
| PULSE-NFR-002 | 1 | All workspaces | [PULSE-S1-012](ACCEPTANCE-CRITERIA.md) | Static/integration |
| PULSE-NFR-003 | 1 | Architecture | [PULSE-S1-013](ACCEPTANCE-CRITERIA.md) | Static |
| PULSE-NFR-004 | 1 | Outbound transport | [PULSE-S1-014](ACCEPTANCE-CRITERIA.md) | Security/integration |
| PULSE-NFR-005 | 1 | API security | [PULSE-S1-015](ACCEPTANCE-CRITERIA.md) | Security/integration |
| PULSE-NFR-006 | 1 | Configuration and logging | [PULSE-S1-016](ACCEPTANCE-CRITERIA.md) | Security/package |
| PULSE-NFR-007 | 2 | Scheduler and workers | [PULSE-S2-008](ACCEPTANCE-CRITERIA.md) | Concurrency/load |
| PULSE-NFR-008 | 2 | Database worker | [PULSE-S2-009](ACCEPTANCE-CRITERIA.md) | Database/integration |
| PULSE-NFR-009 | 2 | Analytics | [PULSE-S2-010](ACCEPTANCE-CRITERIA.md) | Unit/frontend |
| PULSE-NFR-010 | 3 | Frontend | [PULSE-S3-009](ACCEPTANCE-CRITERIA.md) | Frontend/manual |
| PULSE-NFR-011 | 3 | Frontend | [PULSE-S3-010](ACCEPTANCE-CRITERIA.md) | Frontend/end-to-end |
| PULSE-NFR-012 | 4 | All runtime components | [PULSE-S4-005](ACCEPTANCE-CRITERIA.md) | Performance |
| PULSE-NFR-013 | 1 | Engineering quality | [PULSE-S1-017](ACCEPTANCE-CRITERIA.md) | Static/manual |
| PULSE-NFR-014 | 4 | Operations | [PULSE-S4-006](ACCEPTANCE-CRITERIA.md) | Restart/integration |
| PULSE-NFR-015 | 4 | Release process | [PULSE-S4-007](ACCEPTANCE-CRITERIA.md) | Package/manual |
| PULSE-NFR-016 | 1 | Development workflow | [PULSE-S1-018](ACCEPTANCE-CRITERIA.md) | Manual/governance |
| PULSE-NFR-017 | 1 | All workspaces | [PULSE-S1-019](ACCEPTANCE-CRITERIA.md) | Static/manual |
| PULSE-NFR-018 | 1 | Architecture and release | [PULSE-S1-020](ACCEPTANCE-CRITERIA.md) | Static/manual |
| PULSE-NFR-019 | 2 | Persistence and retention | [PULSE-S2-011](ACCEPTANCE-CRITERIA.md) | Database/integration |
| PULSE-NFR-020 | 2 | Runtime diagnostics | [PULSE-S2-012](ACCEPTANCE-CRITERIA.md) | Integration/security |

## Specification ownership

| Contract | Authoritative specification |
| --- | --- |
| Scope and mandatory behavior | [Product requirements](01-PRODUCT-REQUIREMENTS.md) |
| Workspaces, startup and dependencies | [System architecture](02-SYSTEM-ARCHITECTURE.md) |
| Types, validation and defaults | [Domain models](03-DOMAIN-MODELS.md) |
| HTTP, errors and pagination | [API contracts](04-API-CONTRACTS.md) |
| Outbound request behavior | [Monitoring engine](05-MONITORING-ENGINE.md) |
| Dispatch and process lifecycle | [Scheduler reliability](06-SCHEDULER-RELIABILITY.md) |
| Health counters and incidents | [State machine](07-INCIDENT-STATE-MACHINE.md) |
| Formulas and coverage | [Metrics](08-METRICS-AND-ANALYTICS.md) |
| Storage, migrations and retention | [Database](09-DATABASE-AND-PERSISTENCE.md) |
| Trust boundaries and access | [Security](10-SECURITY-MODEL.md) |
| Events and retries | [Notifications](11-NOTIFICATION-SYSTEM.md) |
| Routes, UI and live invalidation | [Frontend](12-FRONTEND-ARCHITECTURE.md) |
| Fixtures and evidence | [Testing](13-TESTING-STRATEGY.md) |
| Capacity and budgets | [Performance](14-PERFORMANCE-REQUIREMENTS.md) |
| Archives, restore and publication | [Release](15-RELEASE-AND-DISTRIBUTION.md) |

## Contract change control

Stage 1 ADR-010 resolves the adapters and adds last-check/outcome projections under PULSE-FR-001 (PULSE-S1-001), plus the durable terminal snapshot watermark under PULSE-FR-007 (PULSE-S1-007). Tests cover persisted projection, deletion/reconfiguration fences and same-millisecond snapshot exclusion. No requirement is moved to a later stage by these refinements.

An implementation-changing decision must update its owning specification, relevant stage, acceptance rows and this matrix in one change. IDs remain stable: retire rather than repurpose an ID. Add new IDs monotonically within FR/NFR; document retirement reason. A conflicting contract is a documentation defect to resolve before implementing that behavior. Security constraints and data integrity invariants cannot be weakened by an implementation convenience.

## Stage 3 implementation evidence

PULSE-FR-013 through PULSE-FR-020 and PULSE-NFR-010/011 are implemented by apps/web, API assets/events, NotificationStore/DeliveryWorker and migration 3. ADR-012 records the chosen dependencies and fixed notification.test contract extension. Tests include browser journeys, frontend rendering, SSE guards, real signed receivers, finite retries and a real kill-after-send/restart subprocess. The final candidate, per-criterion outcomes and limitations are linked from the acceptance ledger and Stage 3 report. Stage 4 rows remain NOT TESTED.

## Stage 4 candidate refinements

ADR-013 records the stable home-directory default and explicit legacy override (PULSE-FR-023 / PULSE-S4-001), integrity-first bounded bootstrap/recovery (PULSE-FR-024/025, PULSE-NFR-014 / PULSE-S4-002/003/006), archive allowlisting and isolated installation (PULSE-FR-026, PULSE-NFR-015 / PULSE-S4-004/007), and unresolved historical-incident visibility (PULSE-FR-016 / PULSE-S3-004). These refinements do not waive PULSE-NFR-012 / PULSE-S4-005 performance targets. The Stage 4 report and ledger distinguish measured Windows evidence from unavailable Linux, deployment and publication validation.

ADR-014 and the [remediation report](../STAGE-4-REMEDIATION.md) supersede the initial candidate's build/security/platform status. Cursor and peer-status isolation preserve API/worker security contracts; integrity regressions preserve PULSE-NFR-008/014. Exact clean-source bytes and platform package evidence refine PULSE-S4-001/007 without waiving the failed PULSE-S4-005 performance gate. Production proxy, physical-storage/soak and publication-account limitations remain explicit.

ADR-015 removes retained-history scans from exact recovery clocks and overview latest-observation projection (PULSE-NFR-012/014, PULSE-S4-005/006). Existing index plans on 4.32 million rows and lifecycle/latest-observation regressions preserve result semantics. Complete integrity validation remains required; the original ten-second target was later revised only by the explicit owner authorization in ADR-020. Component improvements do not mark the reference gate PASS.

ADR-016 implements guarded equivalent schema 4 CHECK expressions with full precommit integrity/FK validation and unchanged migrations 1–3 (PULSE-FR-025, PULSE-NFR-008/012/014, PULSE-S4-003/005/006). ADR-017 preserves authenticated SSE across its actual heartbeat while retaining finite idle, buffer, session and stream bounds (PULSE-FR-016, PULSE-NFR-008, PULSE-S3-004). Final evidence distinguishes component, repeated startup, load/soak, isolated filesystem and controlled nginx outcomes from external infrastructure/publication gates.

ADR-018 adds covering analytics indexes and streams bounded exact metrics in schema 5 (PULSE-FR-014/025, PULSE-NFR-012/014, PULSE-S4-003/005). Raw-row allocation, index/table lookup cost and new migration/index overhead require final performance evidence; no acceptance budget changes.

ADR-019 distinguishes full-validation I/O from recovery/application setup and releases the larger temporary SQLite mapping before readiness (PULSE-NFR-008/012/014, PULSE-S4-005/006). The existing integrity/corruption/FK assertions and steady memory bounds remain mandatory. Repeated final-runtime startup evidence supersedes earlier schema-4 warm starts only for the tested context.

ADR-020 records the owner's explicit revision of PULSE-NFR-012 / PULSE-S4-005 startup acceptance to 60 seconds and subsequent authorization to resume remediation and release. No other target or security property is revised. Historical ten-second reports and the failed 75.30-second restart retain their original results.

ADR-021 adds bounded sequential database/WAL reads before unchanged full writable validation (PULSE-NFR-008/012/014, PULSE-S4-005/006). A subsequent diagnostic measured 9.66s initial startup and 8.30s post-load restart; it also exposed excess steady RSS and future-dated seed metadata. Neither the short diagnostic nor historical passing suites establish final reference/soak or artifact acceptance.
