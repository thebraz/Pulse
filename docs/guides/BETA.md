# Experimental beta v0.1.0-beta.1

Pulse is experimental software for local evaluation. **Do not use this beta for critical production monitoring, guaranteed alert delivery or SLA certification.** Distribution is through the official [GitHub pre-release](https://github.com/thebraz/Pulse/releases/tag/v0.1.0-beta.1), not npm.

## Installation and operation

Use Node.js 24.19.0 (patched Node 24.x from this version is accepted; other major versions are rejected) and writable local SSD storage. Download the runtime `.tgz` and `SHA256SUMS.txt` from the release. Verify the SHA-256 with `Get-FileHash -Algorithm SHA256` on PowerShell or `sha256sum` on Ubuntu, then run `npm install --global ./pulse-http-monitor-0.1.0-beta.1.tgz` and `pulse start`. Open http://127.0.0.1:3000. `pulse version` must print `Pulse 0.1.0-beta.1`.

Source installation uses `npm ci`, `npm run build`, then `npm start`. The runtime archive contains built assets; it needs no compiler at startup. Registry access is needed for dependency installation, not normal operation. Data defaults to `~/.pulse`; use `PULSE_DATA_DIR` to select an existing directory deliberately. No automatic data reset is performed. Follow the [README](../../README.md), [configuration](CONFIGURATION.md), [operations](OPERATIONS.md) and [security](SECURITY.md) guides.

The initial beta scope is local-only, one operator, one process and local SQLite. Windows x64 and Ubuntu 24.04 x64 userspace on WSL2 are the functional verification targets. Native Linux hardware capacity, macOS, ARM, public HTTPS deployments and other Node patches are not certified. Remote security configuration remains documented, but does not constitute deployment certification.

## Separate beta acceptance policy

The owner authorized this policy on 2026-10-12 specifically for v0.1.0-beta.1. The official future stable criteria in [performance requirements](https://github.com/thebraz/Pulse/blob/main/docs/specifications/14-PERFORMANCE-REQUIREMENTS.md), the stable verifier and their tests remain unchanged.

| Beta requirement | Verification |
| --- | --- |
| Startup and restart | Each measured complete process start, including SQLite validation/recovery and listener readiness, must finish within 60 seconds. Installation, compilation, fixture translation and pending migrations are separately timed. |
| Memory | At most 400MiB process RSS including the SQLite worker during the measured load and overload. Record actual memory observations and the RSS trend. The owner's 2026-10-13 clarification accepts modest RSS increases as an experimental limitation, without imposing the stable zero-growth diagnostic on this beta. An observed budget breach, memory-related process failure, loss of readiness or unbounded admitted work remains blocking. No long-term memory guarantee is claimed. |
| Core functionality | Repeat automated and browser journeys, install the exact runtime archive into a clean directory and verify real checks, incident/recovery, signed webhook receipt, restart, backup and restore. Basic flow errors remain blocking. |
| Integrity and security | Mandatory writable SQLite integrity/FK checks, post-load full `integrity_check` and `foreign_key_check`, security regression tests, dependency audit and exact public-artifact inspection. Corruption, unsafe disclosure or broken installation remains blocking. |
| Performance limitations | Existing API latency, scheduling lag, browser long tasks and overload fairness failures may be documented for this experimental release. Bounded resources, usable core workflows and data/security invariants remain mandatory. |

`--beta` uses the same 100-monitor, 4.32-million-check fixture, ten real browsers and controlled signed webhooks as the reference harness. It runs 60 seconds of warm-up, 180 seconds of API measurement (100 requests per category), 900 seconds of observation including measurement, and 90 seconds of overload. The stable `result` is retained separately from `betaAcceptance`; beta PASS cannot certify stable readiness. The short final-memory window can detect ongoing growth during that observation; it cannot rule out long-term leaks. No two-hour soak is required or claimed for this beta. Large-fixture capacity is measured only on the platform identified in its actual report; functional validation on another platform is not capacity evidence.

The harness's initial `betaAcceptance` also includes a conservative zero-positive-RSS-trend diagnostic. Its original result is preserved, including failures. The final beta verification applies the owner's clarified policy above: a positive trend alone is disclosed rather than treated as a critical release failure when the 400MiB limit, readiness, bounded work and essential flows pass. The official stable trend requirement and its tests are unchanged.

## Known limitations

- Under 100-monitor/30-day history load, API latency and dispatch lag exceed stable targets. Automatic checks and alerts can be late, particularly during manual overload or heavy dashboard activity.
- Automatic live updates now await slow reads and retain a trailing refresh instead of repeatedly cancelling them. Separate tabs still issue redundant dashboard/list queries; ten concurrent browser clients amplify database queues and transient heap allocation. Cross-tab query coalescing is not implemented.
- Browser tasks can exceed 200ms. Initial history preparation can take minutes; it is fixture work, separate from application startup.
- RSS varies with SQLite/OS caches and V8 heap capacity. A peak below 400MiB alone does not prove safe long-term operation. Memory observations are bounded to the published run.
- Webhook delivery is finite best effort, can be duplicated and is not an independent alerting service. Receivers must deduplicate event IDs.
- Only observed intervals and counted samples support metrics. Missing checks, service-offline periods and UNKNOWN states cannot prove uptime.
- Physical power-loss, all storage hardware, untested operating systems and production proxy deployments are not certified. Keep backups and protect credentials separately.

The release notes and [beta verification report](https://github.com/thebraz/Pulse/blob/main/docs/evidence/stage-4-beta-verification.json) contain the actual final counts, identities and measured outcomes. Historical Stage 4 stable reports retain their failures and report-specific scope. An experimental beta release does not change the stable acceptance ledger to PASS.
