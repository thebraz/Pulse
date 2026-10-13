# Pulse scheduler reliability

The scheduler is single-process and capacity-bounded. Stage 1 implements dispatch, reservation and cancellation; Stage 2 adds fault/restart hardening, fairness evidence and operational diagnostics. It never promises exactly-once network execution.

## Scheduling algorithm

Use one wake-up loop, no interval timer per monitor. Wake at the next due time or at most 250ms while work is due, and on configuration/manual/capacity changes. No overlapping scheduler-loop invocations are allowed. Automatic candidates are enabled monitors without unsettled work, ordered by nextDueAt ascending then monitor ID. Reserve only when execution capacity is available; no in-memory backlog per missed interval.

Stage 2 uses one adaptive timeout: 25ms minimum when due work is temporarily excluded, up to 10s while idle, and no scheduler polling timer while the pool is full. Capacity release wakes dispatch. A pending-wake flag preserves changes arriving during an active pump. The separate single maintenance timer serializes heartbeats and retention; it is never allocated per monitor.

Creation/resume makes nextDueAt=now. A dispatch consumes at most one due slot. At terminal completion, if the stored due time d is <= completion time t, advance it to `d + (floor((t-d)/intervalMs)+1)*intervalMs`, strictly later than t. A manual execution consumes the overdue slot if d <= its completion time; otherwise it leaves d unchanged. Interval edits establish a new phase at now. Cancelled work while still enabled is rescheduled to the first future slot; disabled monitors have null due time. Crash recovery makes each overdue monitor eligible once, preserving order; it never allocates a job for each missed slot.

The persisted wall clock determines due slots. Use monotonic time for sleeping/deadlines and a nondecreasing process logical UTC clock (`max(rawUtc,lastEmittedUtc)`) for lifecycle ordering, seeded at startup with at least the latest persisted lifecycle timestamp. Log a safe clock-regression code and recompute wake delay; never generate negative durations. A forward jump skips missed slots under the same formula. Logical clamping does not certify accurate wall time; operators must maintain the host clock.

## Capacity, fairness and backpressure

The default check pool has 10 slots, maximum 50. Automatic and manual work share it; one monitor can own only one QUEUED or RUNNING row. Manual requests coalesce with any unsettled row for that monitor, returning the same ID. Persist a manual QUEUED row only if the manual queue has capacity (default 100); otherwise return 429 without allocating work. Queue limit counts all queued manual jobs, excluding RUNNING jobs. Automatic work is reserved only at dispatch, not queued indefinitely.

When both classes are eligible, alternate one automatic and one manual dispatch; never dispatch two manuals consecutively while an automatic is due. Within automatic work use oldest due first; within manual use queuedAt then ID. A failing target uses no priority bonus. A manual job cannot jump a running check. Fairness guarantees dispatch opportunity under finite work and available persistence, not a precise start deadline under arbitrary saturation.

The database command queue defaults to 1,000. At saturation reject new API mutations with 503 and pause new network dispatch. Reserve bookkeeping capacity for in-flight terminal commits; use at most half the command queue for optional reads/maintenance. Terminal commit failures stop dispatch and fail readiness. Do not drop results silently or maintain an unbounded retry buffer. Notification pool defaults to 2 and is independent; retention deletes at most 1,000 rows per transaction and yields between batches.

## Reservation and fencing

A reservation transaction validates enabled state and monitor revision, inserts execution identity and checks the unique unsettled-per-monitor constraint. The in-memory slot is granted only after reservation succeeds. Completion commands include execution ID, captured revision and epoch; the transaction rechecks that the row is RUNNING and the context is current before evaluating it.

Pause or target-affecting edit increments revision/epoch, terminalizes unsettled work as CANCELLED, clears transient counters and updates due metadata atomically; its AbortController is signalled immediately after commit. Late results cannot overwrite CANCELLED. Rename-only edits still increment revision but must either preserve the execution fence explicitly or cancel it consistently; the chosen baseline cancels unsettled work on every edit while retaining health for rename-only edits. Delete uses the same cancellation fence before cascading history.

## Restart and shutdown

Startup holds the exclusive data-directory lock before opening writable storage. In one recovery transaction: close the previous service run at its last heartbeat, ABANDON queued/running checks, reset health to UNKNOWN/RESTARTED with counters zero, retain unresolved incidents, and recover delivery claims by [notification rules](11-NOTIFICATION-SYSTEM.md). Stage 1 performs abandonment but has no incident/coverage tables yet. Commit recovery before accepting dispatch. It is possible that a pre-crash request reached the target without a persisted result; a later check may contact it again. GET/HEAD requests must therefore be observational and operators should avoid targets with side effects.

Shutdown has a 15-second total budget. Stop mutation admission and new reservations first; close SSE; terminalize queued work as CANCELLED; abort running requests and persist cancellation without health evaluation. Allow up to 10 seconds for persistence/delivery bookkeeping, then close resources within the remaining budget. If storage cannot record a cancellation, keep the row unsettled for startup abandonment and exit unsuccessfully. Never forcibly mark a target DOWN to make shutdown appear complete.

## Invariants and prohibited states

| Invariant | Enforcement / prohibited result |
| --- | --- |
| One unsettled execution per monitor | Partial unique index plus transaction; no overlapping auto/manual run. |
| Active checks <= configured capacity | One central semaphore; no bypass for manual checks. |
| Every reservation reaches a terminal state or restart recovery | No lost promise or swallowed background exception. |
| Stale work cannot affect health | Revision/epoch check in commit transaction. |
| Network calls outside transactions | No lock held during HTTP or DNS. |
| Enabled monitor eventually receives an opportunity | Oldest-due ordering and manual alternation; no per-failure starvation. |
| Queue lengths remain within hard bounds | Reject/pause at limits; no recursive unbounded resubmission. |
| Durable status follows durable result | No SSE or notification enqueue before commit. |

Expose safe counters for running/queued work, due-monitor count, oldest due lag, cancelled/abandoned checks, database queue length and last safe background failure code. Log bounded IDs, never URLs or secret values. Validate with fake-clock simulation plus real concurrent subprocess/SQLite/network tests in [testing](13-TESTING-STRATEGY.md).
