# Pulse notification system

Stage 3 supports generic incident.opened and incident.resolved webhooks and a fixed notification.test action. The explicitly supplied Stage 3 prompt requires test delivery and supersedes the earlier omission. No arbitrary message body, email, SMS or destination-specific SaaS is supported. Use [destination/delivery models](03-DOMAIN-MODELS.md) and the same mandatory [egress policy](10-SECURITY-MODEL.md).

## Transactional event contract

Allocate one immutable eventId per incident transition, shared across its destination deliveries. When an incident opens/resolves, the result transaction snapshots all currently enabled destinations and inserts one unique (eventId, destinationId) delivery each. No destinations means zero jobs, not a failure. The event payload is immutable; retries reuse exact body bytes and eventId. A database rollback produces neither incident change nor delivery rows. No replay is generated for transitions that occurred before Stage 3 or before a destination was enabled.

```json
{
  "version": 1,
  "eventId": "1008c0b8-0b2d-4f89-811f-ef40d77808ce",
  "type": "incident.opened",
  "occurredAt": "2026-10-09T12:02:00.150Z",
  "monitor": {
    "id": "ea48a6d0-d4e5-4fd4-b8d0-bc638c2ca8a4",
    "name": "Public API health"
  },
  "incident": {
    "id": "b1aa1b96-7222-47f7-bef5-e9bdf1b6c537",
    "status": "OPEN",
    "openedAt": "2026-10-09T12:00:00.000Z",
    "detectedAt": "2026-10-09T12:02:00.150Z",
    "observedEndAt": null,
    "resolvedAt": null
  },
  "transition": {"fromState": "DEGRADED", "toState": "DOWN"}
}
```

Resolved events use the same fields with type incident.resolved, status RESOLVED, both recovery timestamps populated and occurredAt=resolvedAt. The monitor name is a bounded text snapshot; URL, secret aliases, headers, target response bodies and sensitive error messages are omitted. Event IDs are not secrets. Payload UTF-8 size is capped 16KiB; schema rejects anything beyond the specified contract.

## Delivery algorithm and outcomes

An independent loop claims the earliest due PENDING job ordered nextAttemptAt then id, subject to the per-destination sequence barrier. In one transaction mark IN_FLIGHT, increment attemptCount and record claimedAt before sending. Default pool 2, maximum 10; no delivery consumes monitoring slots. Resolve the current destination only if its enabled flag and revision still match. Read validated provisioned secret files under the secrets root; missing/invalid files produce DEAD with a safe configuration error. A destination edit/disable/delete cancels outstanding jobs, aborts active sends and prevents new enqueueing; an already transmitted request cannot be recalled.

POST exact JSON bytes with Content-Type application/json, User-Agent Pulse, `X-Pulse-Event-Id` and `X-Pulse-Attempt`. Total timeout 5s includes DNS/TLS/headers. Public destinations require HTTPS; explicitly approved private/loopback fixtures may use HTTP. Redirects are never followed: any 3xx is permanent failure. Response bodies are discarded and never persisted or logged. Header cap 16KiB. A final 2xx means SUCCEEDED, meaning receiver HTTP acknowledgment only, not proof of downstream action.

| Result | State / retry |
| --- | --- |
| 2xx | SUCCEEDED. |
| 408,429 or 5xx | Retry while attempts remain. |
| DNS/connect/reset/timeout error | Retry while attempts remain. |
| TLS trust/hostname error | DEAD; never disable verification. |
| 3xx, remaining 4xx, policy/configuration denial | DEAD. |
| Destination disabled/revision mismatch/deleted | CANCELLED; no further send. |
| Unknown internal/persistence error | Stop claims and expose safe delivery diagnostics; persistence faults additionally fail process readiness and dispatch. Do not invent acknowledgment. |

Maximum 5 actual-or-uncertain attempts. Attempt 1 is immediately eligible at enqueue time. After failed attempt n=1..4, delay is `min(300000,5000*2^(n-1))` milliseconds, measured from attempt completion. Base delays are 5s, 10s, 20s, 40s. No jitter in v1, to keep deterministic finite scheduling; bounded pools cap bursts. Valid integer Retry-After seconds on 429/503 increases delay to max(base, min(value*1000, 300000)); malformed/date-form headers are ignored. Failure on attempt 5 becomes DEAD with finishedAt. Do not retry permanent failures or silently reset attemptCount.

## Signing and secret management

If a signingSecretRef is configured, read at least 32 random bytes from its `.key` file. For each attempt compute HMAC-SHA256 over `<unixSeconds>.<rawJsonBytes>`. Send `X-Pulse-Timestamp` and `X-Pulse-Signature: v1=<lowercase hex>`. Timestamp/signature may differ on retries, but raw JSON/eventId stay identical. Receiver guidance requires constant-time signature comparison, timestamp freshness (normally 5min) and eventId deduplication across retries. Signing authenticates payload origin; it does not encrypt HTTP. Missing configured signing keys are fatal for that delivery; never silently send unsigned.

URLs may contain receiver-required path/query secrets and therefore exist only in administrator-provisioned `.url` files. They are validated before connect, masked from APIs and never snapshotted in payloads. API write-only references must pass realpath/regular-file containment, including symlinks and Windows drive/UNC cases. Do not include response bodies, URLs or raw transport errors in lastErrorCode. Key/URL rotation requires editing provisioned files and restarting; in-place secret changes without restart are unsupported to avoid ambiguous attempts.

## Ordering, deduplication and restart

Unique event/destination insertion deduplicates local enqueueing, not remote receipt. Claim only the earliest nonterminal delivery for a destination; at most one IN_FLIGHT per destination, so a later resolution waits until that destination's opening job reaches a terminal state. Different destinations can progress independently. A DEAD opening does not prevent the later resolution from being sent; the receiver may therefore see a resolution without a successful opening. Destination changes cancel outstanding work instead of routing old events to a different URL.

On restart, an IN_FLIGHT send has uncertain receipt. Its durable attempt number is consumed; reschedule PENDING at max(restartNow, claimedAt+5000+correspondingBackoffMs) if budget remains, otherwise DEAD with UNCERTAIN_LAST_ATTEMPT. Keep eventId/body unchanged so receivers can deduplicate. Finite retries and operator outages mean delivery is best effort; no exactly-once or eventual-delivery guarantee is claimed.

Shutdown stops claims, aborts requests and persists retry eligibility or uncertainty before the overall 15s process deadline. A crash before bookkeeping is handled by the same IN_FLIGHT recovery. Terminal jobs are retained 30d by default; pending/in-flight jobs are protected. Observability exposes counts by state, queue age, attempts and safe final codes, never secret-bearing payload content.

## Verification

Use a real controlled receiver that stores observed event IDs, exact bytes, timestamps and attempts. Test 2xx, permanent 4xx/3xx, retriable 408/429/5xx, malformed Retry-After, slow response, DNS/TLS/policy denial, receiver deduplication, destination edit/disable while sending, per-destination ordering, rollback, kill-after-send-before-commit, secret rotation and final-attempt uncertainty. Verify monitoring continues under a saturated webhook pool. Unit tests alone cannot prove actual delivery.

## Fixed test action

POST `/api/v1/notification-destinations/:id/test` accepts `{}` and returns 202 with the queued safe Delivery DTO. It uses the same persistent queue, signing, egress and finite retry rules. Disabled destinations reject the action. A one-minute per-destination cooldown rejects repeated submissions with 429. Its fixed payload is `{version:1,eventId,type:"notification.test",occurredAt}`; no operator text or target data can be injected. The delivery incidentId is null only for this event type.
