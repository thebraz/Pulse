# Pulse 0.1.0 candidate

Unreleased. Publication is blocked by the Stage 4 report; these are proposed release notes.

Pulse provides local HTTP/HTTPS monitoring, bounded scheduling, consecutive-failure incident confirmation, qualified availability/history, a React dashboard and persistent optional HMAC webhook alerts. One Node process serves the built dashboard and API and owns a local SQLite database through a dedicated worker.

The candidate adds an installable CLI archive with locked runtime dependencies, a source distribution, integrity-aware diagnostics, transactional upgrade/rollback fixtures, tested offline backup/restore and signed pending-delivery recovery. Public guides cover configuration, API use, secrets, deployment and recovery. CI is prepared for Windows and Ubuntu 24.04.

Data now defaults to the OS home directory plus `.pulse`. Existing development users must explicitly retain the absolute path of their earlier `./data` directory; no files are moved automatically. Monitor detail now retains unresolved incidents older than the default history window. Integrity validation can take minutes on large retained histories; the measured startup budget is still unmet.

The license is MIT, copyright 2026 braz. No GitHub tag/release, registry package, remote deployment or supported capacity claim is implied by this candidate. See the [release report](STAGE-4-REPORT.md) for exact results and blockers.
