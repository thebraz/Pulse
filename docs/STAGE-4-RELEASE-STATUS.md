# Stage 4 current release status

**Experimental beta exception:** the owner subsequently authorized a GitHub-only v0.1.0-beta.1 pre-release with a separate 400MiB budget and shorter observation, while preserving all essential security, integrity, installation and basic-function gates. See the [beta policy](guides/BETA.md) and [beta verification](evidence/stage-4-beta-verification.json). The stable status and historical failures below remain unchanged; they do not prohibit a beta that passes its explicitly authorized policy. No npm or stable publication is authorized by that exception.

The owner explicitly approved a **60-second** startup acceptance limit on 2026-10-12 and subsequently authorized renewed remediation and release. All other performance targets, mandatory integrity/FK checks, security requirements and release gates remain unchanged. Publication remains blocked while final technical verification is incomplete.

## Startup evidence

| Measurement | Actual time | Evaluation |
| --- | --- | --- |
| Historical complete Windows startup | 318.50s | Failed the original 10s limit. |
| Previous diagnostic initial complete startup | 21.15s | Within the revised 60s limit. |
| Previous diagnostic complete overload restart | 75.30s | Failed the revised 60s limit. |
| Separate previous SQLite quick_check probe | 119.17s | Component profile; not another complete startup measurement. |
| Earlier short diagnostic initial complete startup | 9.66s | Passed the revised limit in that measured run. |
| Earlier short diagnostic complete overload restart | 8.30s | Passed the revised limit in that measured run. |
| Latest diagnostic initial complete startup | 25.96s | Passed the revised 60s limit in this measured run. |
| Latest diagnostic complete overload restart | 23.34s | Passed the revised 60s limit in this measured run. |

Complete process timings include application startup and listener readiness. Dependency installation, build, fixture setup and pending migration preparation are separately timed. The latest diagnostic separately measured 26.41s migration/full preflight and 773.41s history preparation; neither is represented as application startup. OS caches were not forcibly flushed. Its actual profile was 60s warmup, 180s measurement, 210s soak and 90s overload, with 100 API samples per category. It cannot establish full reference or two-hour stability acceptance. See the [previous requirement evaluation](evidence/stage-4-startup-requirement.json), [previous diagnostic](evidence/stage-4-performance-diagnostic-2026-10-12-140633.json), [earlier short diagnostic](evidence/stage-4-performance-diagnostic-2026-10-12-164504.json), [latest preserved diagnostic](evidence/stage-4-performance-diagnostic-2026-10-12-170859.json) and ADR-020/021.

## Release gates

- Bounded sequential validation reads preserved mandatory SQLite integrity/FK checks. The latest diagnostic produced a 25.96s start and 23.34s post-load restart. Final full-profile starts and restarts must independently satisfy the approved 60s limit.
- Future-dated rehearsal service metadata is corrected only on the reference clone; production monotonic-clock safeguards remain intact. The latest diagnostic recorded 276 automatic dispatch samples during measurement.
- The latest diagnostic remains FAIL: peak RSS was 338.95MiB against 300MiB, memory grew, API latency and dispatch lag exceeded their budgets, browser long tasks exceeded 200ms, and overload acceptance failed. Dashboard and monitor-list reads accounted for 1,868 and 1,869 worker operations over the 210-second steady period. Investigation identified unconditional live-query invalidation, repeated cancellation/restart of pending refetches and redundant concurrent reads as remaining actionable paths. Their proposed corrections have not been implemented or validated.
- Full final reference-load, overload and two-hour soak evidence remains incomplete on the supported platforms. The shorter diagnostic cannot substitute for those runs.
- The browser deletion race has been corrected with a real delayed-response regression. Current platform test outcomes are recorded separately in the Windows and Ubuntu evidence files.
- Final archive installation, clean-source asset reproducibility, exclusions and operational/security checks must be bound to the final candidate bytes before publication. Prior passing archive rehearsals do not certify later changes.
- Actual isolated storage-full, read-only and kernel I/O-fault rehearsals and controlled real TLS/nginx tests have recorded results. Their final-candidate scope must be reverified before release. No physical power-loss claim is made.

## External status

The public [thebraz/Pulse repository](https://github.com/thebraz/Pulse) exists and is empty. Owner admin/push permissions have been verified. GitHub private vulnerability reporting is enabled and verified; SECURITY.md points to that real confidential channel.

Official npm CLI authentication succeeded and `npm whoami` verified `thebraz`. Credentials remain outside the repository. Package publication permission, namespace/version availability and any required 2FA challenge must be checked immediately before a technically ready publication; no password or token is requested in chat.

Initial publication is explicitly **local-only**. An actual operator HTTPS deployment is outside that initial operating scope; controlled proxy/auth/CSRF security checks remain required. The owner reserved the current SSD workstation for sequential supported-platform load tests; those full final runs have not completed.

No product code push, tag, GitHub release or npm publication has been performed. No additional owner authorization is currently needed: remaining release blockers are technical. The [verification manifest](evidence/stage-4-verification.json) records blocked readiness and report-specific evidence; historical passing counts are not a final-candidate release approval.

## Current automated verification

Before the latest validation-read, metrics and release-evidence changes, Windows passed **235/235 automated tests and 8/8 browser journeys**, and Ubuntu 24.04 userspace on WSL2 passed **235/235 automated tests and 8/8 browser journeys**. These historical results do not certify subsequent changes. Final complete suites must be rerun; dates, runtime and identity are recorded in the [Windows tests](evidence/stage-4-tests.json), [Windows checks](evidence/stage-4-checks.json), [Ubuntu tests](evidence/stage-4-linux-tests.json) and [Ubuntu checks](evidence/stage-4-linux-checks.json).

The production dependency audit found **zero known advisories**; see the [audit evidence](evidence/stage-4-production-audit.json). An independent read-only review found no defect in the 60-second requirement revision. These checks do not substitute for the pending full performance/soak and final archive/security gates.

Archive hygiene: **4/4 exclusion scenarios passed**, recorded at 2026-10-12T15:31:51.932Z. These controlled source/package canary fixtures verify the current exclusion rules; they do not replace the pending exact final archive install and reproducibility checks.

## Session closeout

The owner requested session closure on 2026-10-12. Existing corrections and evidence are preserved; no additional runtime or test edits were made after the latest diagnostic. Its source, compiled-runtime and test-suite identity was rechecked and still matches the workspace. The latest diagnostic is preserved byte-for-byte. The full final suites, exact final archive checks and sequential supported-platform reference/soak runs remain pending. Release readiness remains **BLOCKED**. No publication was attempted, and no additional owner input is needed to address the remaining technical defects.
