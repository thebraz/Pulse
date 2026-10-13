# Changelog

## Unreleased Stage 4 structural remediation

- Apply the owner's approved 60-second startup acceptance limit, including subsequent restarts; retain historical measurements and all other budgets. Renewed remediation follows the reproduced 75.30-second restart; release requires final load and stability evidence.
- Prevent live detail refreshes from racing a committed monitor deletion while its response is in transit.
- Preserve full startup integrity validation while migrating equivalent CHECK expressions without rewriting retained observations or changing original migration checksums.
- Use existing indexes for exact recovery clocks and latest-observation overview projections, eliminating two retained-history scans.
- Keep authenticated SSE connections alive through their fifteen-second heartbeat with a finite thirty-second stream timeout; verify the shipped nginx configuration with real TLS, auth, CSRF, stream limits and invalidations.
- Add actual isolated disk-full, read-only and kernel I/O fault rehearsals; keep power-loss and operator deployment claims bounded to available evidence.
- Preserve historical repeated warm starts below ten seconds on the 4.32-million-check fixture; later measurements reproduced a slower restart. Full reference/soak and publication gates remain separate.
- Release the larger temporary SQLite validation mapping before readiness, restoring the normal 64MiB mapping and 16MiB page cache.
- Append schema 5 covering analytics indexes and read compact metric projections in batches of at most 4,096 with composite keyset seeks, retaining exact successful durations and rejecting the 100,001st counted observation. This bounds temporary allocations without approximating results.
- Prime large database and WAL reads sequentially with a reusable 1MiB buffer before mandatory writable integrity/foreign-key validation, failing closed on I/O errors or truncation and restoring steady mapping limits before readiness.
- Preserve delayed SQLite telemetry with actual completion timestamps and prepare reused reference history on an immutable-source clone; bind release evidence to the exact source, compiled runtime, validation code and installed archive.

## 0.1.0-beta.1 — experimental GitHub pre-release

First experimental beta. The beta-only policy permits 400MiB, retains 60-second startup/restart limits and records latency, scheduling and overload limitations. It does not waive security, data integrity, installation or basic functionality checks. Stable criteria remain unchanged. This version is distributed on GitHub only, without npm publication; see the [beta guide](docs/guides/BETA.md).

- HTTP GET/HEAD monitoring with bounded concurrency, DNS pinning and explicit private-network access.
- Persistent monitor configuration, threshold incidents and restart recovery in SQLite.
- Qualified sampled availability, response-header latency and observation coverage.
- Responsive React dashboard, incident history and signed, persistent webhook delivery.
- One-process startup, local-only defaults, optional operator authentication and diagnostics.
- Installable compiled runtime and browser assets, clean-install checks and recovery documentation.
- Reject malformed pagination dates without faulting the database worker; isolate unsupported target/receiver HTTP status codes from unrelated monitoring and delivery work.
- Deduplicate browser workspace dependencies and constrain CSS source discovery for consistent production assets across clean builds.
- Bound SQLite mapped reads/page cache, migrate equivalent CHECK expressions and use existing indexes for recovery clocks, preserving full integrity/foreign-key validation. The latest diagnostic measured a 25.96s startup and 23.34s restart, within the approved 60s limit; load latency, memory and browser/overload budgets still fail. Final reference-load/soak and release gates remain separate.

The default data directory is now `~/.pulse`, independent of the working directory. Existing source-checkout users must set `PULSE_DATA_DIR=./data` (or their existing absolute directory) to continue using their previous database. No data is moved or deleted automatically. Database migrations 1–3 retain their original checksums; guarded migration 4 preserves their rows, indexes and physical layout.
