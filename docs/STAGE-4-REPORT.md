# Stage 4 production-readiness report

Historical candidate snapshot before release remediation. The current results and decisions superseding this snapshot are in the [remediation report](STAGE-4-REMEDIATION.md) and [current verification manifest](evidence/stage-4-verification.json). The measurements below remain historical evidence.

Status: **FAIL — public release blocked.** Version 0.1.0 is an unreleased local candidate. No source was pushed and no GitHub release, tag or npm publication is claimed.

The final measured evidence and artifact identities are collected in [verification](evidence/stage-4-verification.json). PASS below applies only to the tested Windows/Node/Chromium scope, not an untested deployment or capacity envelope.

## Implementation and architecture

The existing monitor engine, central bounded scheduler, pure health/analytics rules, transactional SQLite worker/outbox, Fastify API, React dashboard and finite webhook worker are retained. The runtime package serves compiled API and browser assets from one origin without a development server or workspace compiler. Node 24.19.0, npm 11.6.4 and SQLite 3.53.3 were used locally on Windows x64, kernel 10.0.26200. Local disk and one process remain required. Optional authenticated remote access needs an operator-managed HTTPS proxy; actual production proxy validation remains unavailable.

SQLite uses WAL/FULL, foreign keys, immutable migration checksums and atomic observation/state/incident/outbox transactions. The default data directory is the OS home directory plus `.pulse`; explicit legacy paths remain supported without moving existing files. Offline backup/restore uses a stopped database, SHA-256, integrity/FK inspection, representative row equality and isolated restart. Restored pending deliveries retain IDs and can be sent again; receivers must deduplicate.

## Audit findings and corrections

| Severity | Finding and impact | Disposition and evidence |
| --- | --- | --- |
| High | The former ten-second worker bootstrap cutoff killed startup during mandatory integrity checks on a realistic retained database, making that database unusable by the service. | Corrected: finite ten-minute bootstrap and sixty-second recovery deadlines preserve integrity checks and pre-readiness isolation. Ordinary calls still fail after ten seconds. Fake-time regressions and actual 4.32-million-check recovery pass. The separate startup performance target still fails and blocks release. |
| Medium | The default relative data directory changed with the launch directory, presenting another database after a normal CLI restart elsewhere. | Corrected: stable home-directory default, explicit legacy override and migration warning; configuration and installed-package restart regressions. |
| Medium | Monitor detail omitted unresolved outages older than the default 90-day incident history window. | Corrected: separately retrieve OPEN incidents and merge by ID; actual browser regression with a 100-day-old unresolved incident. |
| Medium | Doctor could report a structurally readable database as healthy without checking whether its schema was supported by this runtime. | Corrected: verify ordered migration checksums and reject newer/altered schemas without writes; CLI/database regression. |
| Low | Compiler rebuild and development-start tests shared unrealistically short deadlines with runtime operations; disposable fixture lock ports could collide with unrelated listeners. | Corrected: bounded build-specific deadlines, readiness synchronization, retry only for a new disposable fixture's lock collision, and cleanup on failed fixture listener startup. Exact restart/lock fixtures and production lock policy remain unchanged. |

No confirmed critical security vulnerability was found in the direct source/behavior review. This is not a guarantee that none exists. Review covered egress classification, all-answer DNS checks/socket pinning, redirects, TLS identity, timeouts/response limits, Host/Origin/auth/CSRF, body/rate/queue bounds, parameterized SQL, secret containment/redaction, webhook signing/retries, CSP/static containment, React text rendering and build/archive boundaries. Existing real-network, hostile-input, fake-secret and process-crash regressions were retained. An attempted external automated security scan failed to initialize; no successful independent scan is claimed. The dependency advisory check reported zero known vulnerabilities at execution time; [dependency evidence](evidence/stage-4-dependencies.json) records its limits. Original notices for 58 runtime/browser dependency entries are included in [third-party attribution](../THIRD-PARTY-NOTICES.md).

## Verification

Final core suite: **189 passed, 0 failed, 0 skipped, 24 files**. Final workspace browser run: **8 passed, 0 failed**. Exact installed archive: **17 scenarios passed, 0 failed**. Archive exclusions: **4 scenarios passed**. The independent clean-source build runs the same **8 browser journeys** against its own generated assets; its separate result is recorded in the source-install evidence. Typecheck and lint pass.

Exact final test counts, command outcomes, timestamps, source/runtime identities and archive digests are recorded in the verification manifest. [Unit/integration results](evidence/stage-4-tests.json), [browser results](evidence/stage-4-browser.json), [installed-package scenarios](evidence/stage-4-package.json), [archive canaries](evidence/stage-4-hygiene.json) and [clean source build](evidence/stage-4-source-install.json) are separate evidence categories. Earlier failed attempts are retained in the test summary rather than hidden.

The package rehearsal installs the actual archive globally into a separate temporary prefix, checks its executable, starts its built runtime, opens the real dashboard, creates a local HTTP monitor, confirms success/failure/recovery, inspects metrics, verifies actual HMAC receipts, backs up/restores a pending retry, restarts from another directory, runs diagnostics and checks shutdown. It uses explicit loopback authorization and dummy secrets. No production database or operator credential is used.

Clean-source installation and compilation succeeded outside the checkout, and server/contracts output matched the local build. Frontend bytes differed across build directories despite matching selected dependency sources; exact frontend byte reproducibility remains NOT VERIFIED and is a release gate. The first strict byte-comparison attempt failed, and an early clean-source browser attempt passed seven of eight journeys because another fresh fixture could not start. Browser fixtures now preflight new data-directory lock ports; no product lock or performance budget was relaxed. Raw private logs are omitted from the source archive; historical log links point to structured command summaries, and host paths in historical JSON copies are sanitized.

The prepared [CI workflow](../.github/workflows/validate.yml) pins official action commits and runs install, type/lint, full tests, browser, package and hygiene checks with temporary fixtures on Windows and Ubuntu 24.04. It has read-only repository permissions and no publication step. It has not executed on GitHub, so it cannot certify Linux. The available WSL installation is Ubuntu 26.04 without a Linux Node runtime, which does not meet the required Ubuntu 24.04 gate. Docker was not added: its local daemon was unavailable and it is optional.

## Performance and stability

The [synthetic 10,000-definition benchmark](evidence/stage-4-benchmark.json) tests indexed due selection and 500 controlled completions at concurrency ten. It establishes a bounded regression baseline, not the retained-history/reference workload or production capacity.

The retained-history test seeded 100 monitors and **4,320,000 checks** in approximately **797.2 seconds**, producing a **2,139,942,912-byte** database. The report's `seededRows` progress checkpoint was 3,931,200; a subsequent actual read-only count verified the completed 4,320,000 rows. [Read-only profiling](evidence/stage-4-startup-profile.json) measured count 16.43s, quick_check 199.96s, foreign-key check 5.28s and three clock-seed aggregate scans totaling 9.56s. These sequential timings have uncontrolled cache/competing-work effects and must not be summed as an independent startup benchmark.

The initial [reference attempt](evidence/stage-4-performance.json) failed before readiness. After the deadline correction, the [real recovery rehearsal](evidence/stage-4-startup-recovery.json) reached readiness in **231,433.77ms** and shut down in **40.66ms**. Recovery passes; the **10,000ms startup target fails**. The safety deadline change does not waive that budget.

The host was a shared Intel i7-1255U workstation with 12 logical CPUs and 16.89 GB RAM, Windows x64, Node v24.19.0 and SQLite 3.53.3. CPU allocation, disk isolation and competing workload were not controlled as required for a dedicated reference host. The full ten-browser/two-webhook-per-second load, 30-minute API/reference measurement, two-hour memory soak and ten-minute saturated slow-target profile were not completed after the blocking startup failure. Mutation/transaction/browser-memory and reference percentiles remain NOT VERIFIED. The supplied diagnostic harness explicitly cannot return PASS for the incomplete load profile.

## Distribution and remaining blockers

The proposed unscoped name is `pulse-http-monitor`; name lookup returned E404 at check time, which does not establish ownership. `npm whoami` returned E401, so a verified npm account is unavailable. The GitHub connector authenticated `thebraz`; lookup of the intended Pulse repository returned 404, and no public repository URL is claimed. A confidential security reporting channel also remains unverified.

Exact verified runtime archive: `pulse-http-monitor-0.1.0.tgz`, **320112 bytes**, **53 files**, SHA-256 `70fe513525d4239b1c5514019b7ded6446efbe679ec0a8086217fbeace885ea4`.

Local installation:

```sh
npm install --global ./release/pulse-http-monitor-0.1.0.tgz
pulse start
```

Source installation uses `npm ci`, `npm run build`, `npm start`. The exact runtime/source archive identities are in `release/package-manifest.json` and `release/source-manifest.json` alongside the local archives. MIT attribution is **Copyright (c) 2026 braz**. Proposed [release notes](RELEASE-NOTES-0.1.0.md) and metadata are prepared, without publishing.

Remaining release blockers: failed reference startup performance; unverified frontend byte reproducibility; incomplete capacity/soak/physical-storage fault evidence; required Ubuntu 24.04 validation; actual remote HTTPS proxy and independent security validation; verified private reporting channel; npm authentication/ownership and final publication verification. These gates were not waived. There is no unresolved claim that documentation, a small synthetic benchmark or a CI file proves production readiness.

## Final assessment

| Area | Result | Scope or reason |
| --- | --- | --- |
| Monitoring | PASS | Real permitted HTTP/HTTPS behavior and deterministic bounded execution regressions. |
| Reliability | FAIL | Large retained-history startup performance fails; long soak and physical storage matrix incomplete. |
| Incidents | PASS | Atomic lifecycle, crash recovery, flapping, retained unresolved incident and installed failure/recovery. |
| Analytics | PASS | Qualified coverage, unknown gaps, percentile/count boundaries and installed statistics; reference speed unverified. |
| Dashboard | PASS | Actual Chromium workflows, accessible/responsive fixtures and installed built assets; full reference heap budget unverified. |
| Notifications | PASS | Real signed receipt, finite retries, uncertain crash replay and restored pending delivery. |
| Security | NOT VERIFIED | Direct review/regressions/advisory checks complete locally; independent service and production proxy/platform validation incomplete. |
| Persistence | PASS | Transactional migrations, rollback, unsupported-schema rejection and isolated backup/restore in measured local fixtures; physical disk matrix incomplete. |
| CLI | PASS | Installed executable, startup, help/version, schema-aware read-only doctor and shutdown in Windows scope. |
| Documentation | PASS | English guides, genuine screenshot, examples, MIT identity and explicit limitations, subject to final link/contents validation. |
| Installation | PASS | Isolated Windows runtime archive and clean source build; Linux support remains unverified. |
| Publication | NOT VERIFIED | Technical gates and account/channel verification block any public release. |
