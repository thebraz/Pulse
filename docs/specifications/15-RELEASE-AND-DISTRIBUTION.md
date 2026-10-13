# Pulse release and distribution

Stage 4 prepares a validated public release candidate. Documentation authorization and completion of any stage do not authorize push, npm publication, GitHub release creation or deployment. Those require explicit user authorization tied to the concrete reviewed candidate. Publication additionally requires all technical gates and verified target-account access; failed or unverified gates block publication.

## Runtime and package contract

Use TypeScript, Node.js 24 LTS, Fastify, SQLite, React/Vite/Tailwind, Vitest/Playwright and npm workspaces. Node 24 is the selected supported LTS baseline; patch versions, npm version and SQLite API/patch suitability are pinned and verified during implementation, not inferred from this document. Runtime support is checked against the [official Node.js release schedule](https://nodejs.org/en/about/previous-releases). Do not adopt a Current-only runtime as the production default.

Required release targets are current supported Windows 11 x64 and Ubuntu 24.04 LTS x64 with a supported Node 24 patch. Record the exact patch/platform tested. macOS/ARM support is optional until tested and documented; no implied support badge. A local SQLite filesystem and sufficient disk for backups/upgrades are prerequisites. No mandatory container runtime, external database, SaaS account, paid API or internet control plane may be added. Dependency download requires registry access during install; installed core operation must not require it.

The root workspace build must assemble one installable runtime package containing compiled server code, contracts and built browser assets. Serve assets from the same Fastify origin and support deep-link fallback only for frontend routes, never API paths. Provide a CLI/start entry accepting configuration through documented environment names/file references. Startup may create its configured data directory but must never write into installed package/source folders or overwrite an existing database on schema mismatch.

Stages 1–3 do not set a real published package name or claim availability. Stage 4 resolves registry namespace ownership, version and actual license-holder identity with the authorized owner before publication. The intended open-source license is MIT, subject to accurate owner attribution and dependency-license compatibility. Do not invent a person, company, registry namespace or existing release. These are release-time inputs, not blockers to this specification task.

## Candidate build and archive validation

1. From the candidate revision, perform a clean reproducible install, strict typecheck/lint, required tests and production build using pinned lockfile/runtime.
2. Assemble and pack the runtime; inspect the exact archive file listing and contents, not only source configuration. Use an explicit package `files` allowlist for built runtime/assets, intended public docs, license and necessary manifests. Manifest fields that npm always includes must also be inspected.
3. Compute SHA-256 and record revision, archive digest, dependency inventory/licenses, platform/runtime and gate results. Any change to archive bytes requires affected checks and a new digest.
4. Unpack/install that exact archive into a new temporary directory without workspace/source/node_modules access. Start it using a separate temporary data directory and explicitly permitted fixture target. Verify health, auth, static/deep-link routes, real checks, fail/recover incidents, actual webhook receipt, process restart and persistence.
5. Rehearse supported migration/backup/restore/fault procedures against the same candidate and realistic retained dataset. Verify resource and browser budgets. Scan logs/build/archive contents for fake-secret canaries.
6. Present the validated candidate and remaining risks for explicit publication authorization. Immediately before publishing, recheck digest/target/version/account and exclusions. Never rebuild a different untested archive and call it the approved candidate.

A draft candidate is not a public release. Missing real credentials/namespace/license identity prevents publication, not local validation. A package test that starts from the source checkout is insufficient. Network fixture failures must be diagnosed from actual output; do not fabricate receipt because the delivery job was enqueued.

The release verifier binds new evidence to three deterministic SHA-256 digests: runtime source/configuration, compiled runtime/browser assets and the public test/validation tools. Documentation and generated reports are excluded from these digests to avoid a circular evidence dependency. Full suite runners additionally bind the exact browser report and detect source changes during execution. Installed-package evidence must match the actual tarball digest on both platforms. Passing historical reports without these identities remain historical evidence and cannot pass final-candidate gates. A short diagnostic or a partial soak cannot substitute for the full Windows and Ubuntu reference profiles; the verifier checks required budgets, sample counts and measured durations directly.

## Private material and public documentation

The current private instruction directory is `.private/development/`; root `AGENTS.md` is its local bootstrap. Root `.gitignore` and `.npmignore` exclude those paths. Future package allowlisting must exclude them independently, because git ignore does not protect an npm archive or an already tracked file. Inspect Git's tracked listing before a source release; ignore rules do not untrack existing content.

All 22 Markdown documents under `docs/specifications/` and `docs/stages/` are legitimate public engineering documentation and must remain eligible for public source distribution. Never ignore `docs/`, all Markdown, or generic `*RULES*` patterns. Also exclude real data directories, SQLite/WAL/SHM/backups, secret directories, `.env` files, credentials, private validation evidence and local logs from every archive/container/source-release path. Test exact paths with canary files and inspect final artifacts. Do not place private paths/contents into generated public guides.

Public Stage 4 deliverables include truthful README/install guide, configuration reference, API/security/operations guidance, upgrade/backup/restore instructions, contribution guidance, license/attribution, changelog and support/reporting policy. They must link to these specifications where useful and reflect tested behavior/platforms. Security reporting contact is supplied by the owner before public release; do not invent an email. No telemetry, account setup or commercial service is required by the installation guide.

## Backup, restore and upgrade runbooks

**Backup:** stop Pulse cleanly and verify the exclusive lock is released, or use a tested consistent SQLite backup facility. Never copy a live database without its consistency protocol. Store backup outside public/build folders, calculate checksum, and verify integrity/FKs/migration version/representative counts on a copy. Record snapshot UTC time and candidate version without secret contents. Secret files are provisioned/protected separately; a database backup alone does not restore receiver credentials.

**Restore:** stop the runtime; preserve the current database/WAL and diagnostic evidence; verify the selected backup checksum and supported schema; restore into a separate data directory first; run integrity and representative count checks; start with recovery rules and controlled egress; validate checks/incidents/delivery IDs; only then explicitly switch the operational directory. Never replace uncertain files or start two schedulers on the same data. Pending deliveries from an older snapshot may be sent again; receivers must deduplicate eventId and operators must understand this replay risk.

**Upgrade:** read compatibility/changelog and free-space requirements, back up, stop old process, validate migration path and run the new candidate against a copy first. Ordered transactional migrations must succeed before readiness. Refuse newer/unsupported schema and checksum mismatches. On failure, preserve failed state and restore using the verified backup/old compatible runtime; never automatically downgrade a migrated database. Document supported prior versions explicitly; the first release uses empty-schema fixtures and seeded migration fixtures rather than claiming an existing public upgrade history.

## Release gates and residual limitations

All Stages 1–4 acceptance rows and final artifact tests must pass; security/data-loss/recovery blockers are not optional. Independent review of the final changed runtime is expected before public release. Archive exclusion, actual destination delivery and final installation behavior are release gates. Publish only the authorized version/artifact and attach release notes grounded in evidence.

Residual limits must be visible: one host/process, no exactly-once requests/notifications, finite retries, sampled observations, unknown gaps, explicit private-network risk, local-disk/administrator trust and tested capacity/platform boundaries. Supported runtime/dependency security patches require reassessment over time; do not promise permanent safety or unlimited scale.
