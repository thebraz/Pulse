# Pulse documentation

Start with the [project README](../README.md) for installation and a first monitor. Pulse v0.1.0-beta.1 is an experimental GitHub pre-release; it is not a stable release or an npm package.

| Guide | Contents |
| --- | --- |
| [Beta scope](guides/BETA.md) | Experimental acceptance policy, measured limits and unsupported deployments. |
| [Configuration](guides/CONFIGURATION.md) | Startup variables, monitor limits and explicit private-network access. |
| [API](guides/API.md) | Routes, authentication, revisions, pagination and request limits. |
| [Operations](guides/OPERATIONS.md) | Persistence, migrations, backups, restore, shutdown and troubleshooting. |
| [Webhooks](guides/WEBHOOKS.md) | Credential provisioning, immutable payloads, signatures and finite retries. |
| [Deployment security](guides/SECURITY.md) | Local/remote access, proxy configuration and security boundaries. |
| [Verification and engineering history](VERIFICATION.md) | Current release status, historical results, reproducible commands and retained evidence. |

## Engineering contracts

[Specifications](specifications/) contain domain models, API contracts, architecture decisions, security requirements and requirement traceability. [Acceptance criteria](specifications/ACCEPTANCE-CRITERIA.md) retain their recorded outcomes; the separate experimental beta policy does not turn failed stable gates into PASS.

[Stage contracts](stages/) preserve the detailed acceptance scenarios and implementation boundaries used by the source verifier and archive hygiene checks. They describe historical development stages, not commands for visitors or proof of current stable readiness. Current operation is documented in the guides above.

Tests, schemas, disposable TLS fixtures, licenses, third-party notices and structured evidence remain part of the source project. Machine-readable evidence belongs to its recorded candidate, platform and time; a historical PASS does not validate a later checkout.
