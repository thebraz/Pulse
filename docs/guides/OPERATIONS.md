# Operations and recovery

## Persistent data

The default database is `~/.pulse/pulse.sqlite`. Set `PULSE_DATA_DIR` to an absolute directory for a service or a deliberately shared backup workflow. Pulse does not write into its installed package. Earlier source versions defaulted to `./data`; set that directory explicitly to continue using existing data. Nothing is moved or deleted automatically.

SQLite uses WAL, FULL synchronization and foreign keys. Startup applies ordered transactional migrations and verifies checksums. Unsupported, newer, corrupt and checksum-mismatched databases are rejected without resetting them. Version 0.1.0-beta.1 is the first public experimental release: compatibility tests use empty and schemas 1–4 fixtures, upgrading to schema 5; there is no claimed earlier public release history. Migration 4 preserves stored rows/indexes and replaces equivalent enum/lifecycle CHECK expressions to avoid per-row temporary-set construction during integrity validation. It requires the exact known prior definition and completes full writable validation before committing. Migration 5 rebuilds two analytics indexes with covering columns; allow its separately measured index-build time and keep a consistent backup before upgrading.

## Backup and restore

Stop Pulse with Ctrl+C and wait for process exit. Confirm it has stopped before copying data. A clean close checkpoints WAL; never copy a live SQLite database alone. Protect the backup because target names, paths and secret aliases can be sensitive. Secret files must be backed up and protected separately.

PowerShell example, after a clean stop:

```powershell
$pulseData=Join-Path $HOME '.pulse'
$pulseBackup=Join-Path $HOME ('pulse-backup-'+(Get-Date -Format 'yyyyMMdd-HHmmss'))
New-Item -ItemType Directory -Path $pulseBackup
Copy-Item -LiteralPath (Join-Path $pulseData 'pulse.sqlite') -Destination $pulseBackup
Get-FileHash -Algorithm SHA256 -LiteralPath (Join-Path $pulseBackup 'pulse.sqlite')
```

Keep the checksum with the snapshot UTC time and Pulse version. Restore into a new empty directory first; compare its checksum to the saved value. Do not replace the current database or discard WAL from an uncertain shutdown. Preserve the old directory and evidence until the restore is verified.

```powershell
$env:PULSE_DATA_DIR=$pulseBackup
pulse doctor
pulse start
```

Doctor performs a read-only structural, foreign-key and schema-checksum inspection; an offline backend is reported separately. SQLite 3.53.3 omits persisted CHECK-expression evaluation on an OS-read-only connection, so doctor alone cannot certify those constraints. For complete offline validation, open the isolated restore copy with writable filesystem permissions and immediately enable SQL query-only mode:

```sh
node --input-type=module -e "import {DatabaseSync} from 'node:sqlite'; const db=new DatabaseSync(process.argv[1]); db.exec('PRAGMA query_only=ON'); console.log(db.prepare('PRAGMA integrity_check').all()); console.log(db.prepare('PRAGMA foreign_key_check').all()); db.close();" /absolute/restore/pulse.sqlite
```

`integrity_check` must be `ok` and the foreign-key result empty. Verify representative monitor, incident, check and delivery IDs/counts in the isolated restore. Start with controlled outbound access, confirm monitoring and notification behavior, then deliberately switch your service to the verified directory. Pending deliveries from an older snapshot can be sent again; receivers must deduplicate event IDs.

## Upgrade

Read the changelog and runtime requirements, ensure disk space for the database/WAL and a full backup, stop the old process, and rehearse the new candidate against a backup copy. Only switch the operational directory after migration, doctor, monitoring and notification checks pass. If migration fails, preserve the failed state and use a verified backup with its compatible old runtime. Never downgrade a migrated database in place.

## Shutdown and faults

Ctrl+C or SIGTERM stops admissions, fences reservations, aborts sockets, drains persistence and closes SQLite. A supervised Node process can send the fixed IPC message `shutdown` on Windows. The production entry point enforces a 15-second deadline and nonzero exit on failed drain. Forced death leaves uncertain work for restart: unfinished checks become ABANDONED, health becomes UNKNOWN and unresolved incidents remain open. Requests or webhooks might already have reached their target.

Storage-full, read-only, lock, corrupt-schema and worker failures must be corrected before restart. Preserve files and logs; do not delete the database to make readiness pass. Retention is bounded and protects unresolved incidents and pending deliveries. It does not guarantee a fixed disk footprint or automatically VACUUM. Use an offline verified backup before any planned space reclamation.

## Troubleshooting

| Symptom | Check |
| --- | --- |
| CONFIG_INVALID | Unknown PULSE_ variable, invalid limits, or host/port without matching public origin. |
| TARGET_POLICY_REJECTED | Explicit private CIDR authorization, permanently denied address, URL query/credentials or port policy. |
| DATA_DIRECTORY_LOCKED | Another owner or lock-port collision; do not steal/delete locks. |
| SCHEMA_UNSUPPORTED | Newer or altered schema; restore/rehearse with a compatible runtime. |
| SECRET_FILE_INVALID | Containment, format, permissions and bounded Windows ACL probe. |
| DESTINATION_SECRET_INVALID | Missing/invalid URL or signing file; never remove signing to hide a credential fault. |
| 429 / 503 | Rate or queue backpressure, stopping service, or persistent storage failure. |
| Stale dashboard | Connection/session failure; restore connectivity and refetch. |
| No history / null availability | No counted samples or retained/known coverage; gaps are not successful observations. |

`pulse doctor`, `/health/ready`, engine diagnostics and notification diagnostics separate configuration, persistence, monitoring and delivery faults. Logs use safe codes and omit credentials, target bodies and raw transport errors.

Startup performs complete writable quick integrity and foreign-key checks before binding the API. The original 4.32-million-check fixture took 318.5 seconds on the recorded Windows workstation. Equivalent CHECK expressions, indexed recovery, temporary validation mapping and bounded sequential database/WAL reads address measured validation costs. A later short diagnostic measured 9.66s initial startup and 8.30s post-load restart without pending migrations; its migration/full preflight took 24.98s separately. OS caches were not forcibly flushed, and this short run does not certify final capacity or stability. See the source distribution's Stage 4 evidence for the current candidate. Validation may temporarily map up to SQLite's native approximately 2GiB cap; it releases that mapping and restores the 64MiB mapping/16MiB page cache before admission. Steady RSS retains its 300MiB release budget. Bootstrap fails after ten minutes; recovery fails after sixty seconds; ordinary commands fail after ten seconds. These finite safety deadlines are separate from the owner-approved sixty-second release startup target. Preserve the database and investigate slow storage/size rather than bypass validation.
