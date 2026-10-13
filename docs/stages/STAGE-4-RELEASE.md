# Stage 4 — Production Hardening & Public Release

For v0.1.0-beta.1 only, the owner explicitly authorized a separate experimental GitHub pre-release policy on 2026-10-12. See [beta acceptance and limitations](../guides/BETA.md). This does not change the future stable definition of done or waive security, integrity, installation and basic functionality.

## 1. Objective

Prepare and validate a self-hosted public release candidate with operational, security, performance and installation evidence. Stage 4 work and actual public publication remain separate authorizations.

## 2. Allowed scope

Root-cause hardening of completed features, reference benchmarks, real fault/recovery rehearsals, supported-platform validation, build/package assembly, dependency/license review, public operations/security/contribution documentation and a concrete validated candidate. Publication is allowed only after explicit candidate-specific user authorization.

## 3. Explicitly excluded scope

No new product feature families, cloud dependency, distributed architecture, unsupported platform/scale claims, unrelated project changes, automatic pushing/publishing/release creation or destructive production-data reset. Passing gates alone is not publication approval.

## 4. Dependencies on previous stages

Completed Stages 1–3 contracts/evidence and a usable real UI/backend/webhook flow. Read [performance](../specifications/14-PERFORMANCE-REQUIREMENTS.md), [distribution](../specifications/15-RELEASE-AND-DISTRIBUTION.md), [security](../specifications/10-SECURITY-MODEL.md), [database](../specifications/09-DATABASE-AND-PERSISTENCE.md) and the full [acceptance ledger](../specifications/ACCEPTANCE-CRITERIA.md).

## 5. Features to implement

No new monitoring features. Implement required operational diagnostics/recovery fixes, installable compiled runtime/assets, honest platform/version checks, reproducible candidate pipeline, supported upgrade/backup/restore procedures and complete public documentation/license attribution. Resolve actual package namespace/owner/security contact before public publication without inventing values.

## 6. Architecture requirements

Preserve one scheduler/database owner, secure transport, atomic result/outbox and shared contracts. Packaging serves built UI/API from one origin and does not depend on source checkout tools. Changes to established contracts require synchronized ADR/spec/traceability updates. Use independent artifact allowlisting; Git ignore alone is insufficient.

## 7. Detailed functional behavior

Clean-install the exact archive on required Windows/Linux targets, run a permitted target check, induce incident/recovery and receive actual webhook, then restart and verify stored state. Rehearse empty/previous-supported schema migration, rejected newer/checksum-mismatched schema, consistent backup and isolated restore. Benchmark reference/overload/browser budgets with exact context. Compute candidate digest and bind any publication authorization to those bytes, version and target account.

## 8. Failure and edge cases

Read-only/full/corrupt storage, failed migration, interrupted upgrade, uncertain delivery after snapshot restore, stale lock/second instance, missing secret file, invalid proxy/TLS path, no network registry access at runtime, unavailable platform and changed candidate bytes. Preserve data/evidence and fail explicitly; no silent reset/downgrade, fake support badge or tested-source/untested-archive substitution.

## 9. Security requirements

Review actual final runtime/dependencies and remote deployment path; verify proxy/auth/CSRF/CSP, permanent egress denial and all canary surfaces. Inspect tarball/source release for private agent instructions, `.env`, data/WAL/backups, secrets and logs. Preserve legitimate public `docs/` content. Verify package provenance/account/version and release digest immediately before authorized publication. Do not expose credentials in commands/evidence.

## 10. Mandatory automated tests

All applicable Stages 1–3 suites against final changes; fresh archive install/start/deep-link/API/target/webhook/restart; archive exclusion canaries; seeded large dataset query/performance tests; 2h leak soak; migration/backup/restore integrity/FKs/counts; signal/kill/disk/worker fault matrix; required Windows/Linux CI or equivalent recorded runs; final secret/dependency/license checks. Check actual artifacts after the last build change.

## 11. Manual acceptance tests

1. Follow public installation instructions on a clean supported environment using only the candidate archive and documented prerequisites.
2. Complete primary browser monitoring/failure/recovery/notification workflows and inspect local persistence after restart.
3. Configure authenticated HTTPS proxy operation; test direct/proxied unauthorized and hostile browser requests against the real route.
4. Back up and restore into a separate directory, compare representative IDs/counts/metrics and verify controlled restart delivery behavior.
5. Inspect final archive listing/public guides/license identity; confirm private exclusions and honest support/capacity wording.
6. Review the final candidate digest/gates and request publication authorization only for the concrete validated result, if publication is desired.

## 12. Definition of Done

All mandatory technical criteria pass against the final immutable candidate with platform/context evidence; operations guides reproduce actual behavior; no critical security/data-loss/release blocker remains. If public publication is separately authorized, verify the published artifact digest and fresh installation afterward. Without that authorization, report a validated release candidate and do not claim publication.

## 13. Deliverables

Validated runtime archive/digest, reproducible evidence and benchmark context, dependency/license inventory, public install/security/operations/API/contribution documentation, supported-version matrix, verified backup/upgrade/restore procedures, changelog and Stage 4 acceptance evidence. Publish only when additionally authorized.

## 14. Exit criteria

PASS for PULSE-S4-001 through PULSE-S4-007 in [acceptance criteria](../specifications/ACCEPTANCE-CRITERIA.md) and all carried-forward mandatory gates. Technical candidate completion may precede publication. Report any missing namespace/owner/contact/credential input as a release-time blocker without fabricating it or preventing unrelated local validation.

## 15. Known technical risks

Runtime-bundled SQLite patch drift, platform filesystem/lock differences, actual proxy exposure, artifact exclusions, high-history query cost, migration compatibility and backup-delivery replay. Test the final operational destination and artifact; a successful build is insufficient evidence.

## Historical stable candidate evidence

The stable candidate's results and remaining gates are indexed in [verification history](../VERIFICATION.md#historical-stable-candidate), the [stable verification manifest](../evidence/stage-4-verification.json) and acceptance ledger. Historical diagnostics include 25.96-second startup and 23.34-second restart within the revised 60-second startup limit; short runs do not establish full reference-load or two-hour stability acceptance. Stable latency, memory, browser/overload and final candidate gates retain their recorded outcomes.

Windows and Ubuntu 24.04 userspace/WSL2 package/browser evidence applies to its recorded candidate. Controlled storage faults and TLS/nginx fixtures do not certify physical power loss or an operator deployment. The subsequently published experimental v0.1.0-beta.1 has a [separate beta policy](../guides/BETA.md) and [release verification](../evidence/stage-4-beta-verification.json); publication does not establish stable readiness.
