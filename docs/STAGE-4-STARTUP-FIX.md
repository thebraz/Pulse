# Stage 4 historical startup measurements

The six warm starts below passed in their recorded Windows and Ubuntu 24.04 userspace/WSL2 environments. A later diagnostic reproduced a 75.30-second restart, superseding the broad defect-closure claim. The owner subsequently revised startup acceptance to 60 seconds and then authorized renewed remediation. Bounded sequential validation reads produced a new 9.66s start and 8.30s post-load restart in a short diagnostic; final load, memory and stability acceptance remains incomplete. See the [current release status](STAGE-4-RELEASE-STATUS.md). Historical timings and their original ten-second evaluations are preserved below.

## Historical recorded measurements

| Measurement | Verified result |
| --- | --- |
| Historical Windows startup | 318.50 seconds |
| Recorded Windows startup | 9.02 / 9.82 / 7.81 seconds; 3/3 within 10 seconds |
| Recorded Ubuntu userspace startup | 7.78 / 6.40 / 6.58 seconds; 3/3 within 10 seconds |
| Dataset | 100 monitors, 4,320,000 checks, schema 5, 2,271,559,680 bytes |
| Separate migration/full preflight | Windows 42.28s; Ubuntu 30.61s |
| Final affected regressions | 60/60, four files, after the last runtime change |
| Complete suites before that final mapping adjustment | 233/233 on each platform, 28 files each; eight browser journeys each |

The complete startup timer includes configuration, database-worker creation, mandatory writable quick_check and foreign_key_check, exact recovery, API binding and readiness. Dependency installation, compilation, fixture copying and pending migrations are outside that ordinary-startup timer and are not represented as application startup. Migration/index preparation has its own reported timer. All six starts used the same compiled persistence SHA-256 `efae53e81328c8785579ec4c447ef1d0ffec7ccd022f68af1f9be4cb0f0cf020`. The original fixture still matches SHA-256 `c4c2b8e2f9e2e9b4f227393d59430fdecab45a21e472d7a298c77b09e3385586`.

## Causes and corrections

1. SQLite 3.53.3 rebuilt constant IN sets for persisted CHECK expressions. Guarded migration 4 replaces equivalent expressions without rewriting observations; full corruption/FK rejection remains mandatory.
2. Recovery and latest-observation projections scanned retained history. Indexed probes preserve the exact logical clock and highest completed sequence.
3. The 64MiB validation mapping left most of the database on synchronous Windows page reads. A later checks-only validation took 251.83s, including 69.27s of system CPU. Validation now temporarily requests SQLite's native approximately 2GiB mapping cap and releases it before admission. A component run completed full validation in 7.66s; RSS fell from 2,205,417,472 to 58,007,552 bytes after unmapping. Normal operation restores the 64MiB mapping and 16MiB page cache. No validation or timeout requirement was weakened.
4. Schema 5 provides covering analytics indexes. Metrics stream bounded rows and retain exact successful durations, preserving the accepted 100,000/rejected 100,001 boundary, nearest-rank percentiles, bucket arithmetic and degradation semantics. Index build time is separate from ordinary startup.

See [measured closure](evidence/stage-4-startup-fix.json), [Windows trials](evidence/stage-4-structural-startup.json), [Ubuntu trials](evidence/stage-4-linux-structural-startup.json) and ADR-015 through ADR-019 in the [decision record](specifications/ARCHITECTURAL-DECISIONS.md). These are shared-workstation measurements; OS cache was not forcibly flushed, and dedicated-host capacity is not certified.

## Remaining release boundaries

The full reference profile, final two-hour soak and final archive assembly/reverification remain incomplete. Earlier package/source archives and their verification manifest describe the prior candidate; they must not be presented as the corrected release. Real isolated ENOSPC/read-only/kernel-I/O fault cases and eleven nginx TLS/SSE checks passed in the earlier remediation runtime, but they do not certify physical hardware power loss or the operator's deployment. GitHub owner permissions, confidential reporting and npm CLI authentication have since been verified; final publication permission must be rechecked when the technical candidate is ready. No push, tag, GitHub release or npm publication occurred. MIT attribution remains **Copyright (c) 2026 braz**.
