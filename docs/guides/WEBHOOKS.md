# Webhooks

Provision URL and optional signing-key files inside `PULSE_SECRETS_DIR`. Each alias is 1–64 letters, digits, underscores or hyphens. `<alias>.url` contains only the full receiver URL; `<alias>.key` contains a base64url key generated from at least 32 random bytes. Files are bounded to 4096 bytes, checked for regular-file/realpath containment and require protected permissions. Use mode 0600 on POSIX. Remote Windows deployments reject broad readable ACL grants or an unverifiable ACL probe.

Set `PULSE_SECRETS_DIR` to your provisioned directory. In Notifications add a destination with the aliases, enable it and choose Send test. The browser sees only configured booleans and delivery metadata. Do not paste credentials into names or aliases. Restart after rotating files. Editing/disabling/deleting a destination cancels outstanding jobs and cannot recall bytes already sent.

Payloads are capped at 16KiB. Test payloads contain `version:1`, UUID `eventId`, `type:"notification.test"` and UTC `occurredAt`. Incident events add the bounded monitor ID/name, incident ID/status/timestamps and from/to states. Target URL, response body, credential aliases and raw errors are omitted. Event types are `incident.opened` and `incident.resolved`.

Requests send exact immutable JSON bytes with Content-Type application/json, X-Pulse-Event-Id and X-Pulse-Attempt. Signing adds Unix-seconds X-Pulse-Timestamp and `X-Pulse-Signature: v1=<hex HMAC-SHA256>`, over `<timestamp>.<raw body>`, using decoded base64url key bytes. Verify the signature in constant time, enforce timestamp freshness (normally five minutes), and durably deduplicate event IDs. HMAC authenticates the payload; TLS protects its transport.

All DNS answers and pinned sockets use the monitoring egress policy. Public receivers require HTTPS. Private HTTP receivers require a literal explicitly allowed IP at provisioning. Redirects are never followed. One five-second total deadline covers DNS, connect, TLS and headers; response headers are capped at 16KiB and response bodies discarded.

2xx means HTTP acknowledgment, not downstream action. 408/429/5xx and transient connection/DNS/timeout errors retry within five attempts. Base waits after attempts 1–4 are 5/10/20/40 seconds; valid integer Retry-After on 429/503 can increase them to five minutes. TLS, policy, invalid secret, redirect and remaining 4xx failures are permanent. Later events wait behind earlier nonterminal deliveries to that destination; separate destinations progress independently.

Crash uncertainty consumes the claimed attempt. A restart may resend identical bytes/event ID when attempts remain. An uncertain fifth attempt becomes DEAD. Receivers can therefore see duplicates or a resolution after an opening exhausted its retries. No eventual-delivery guarantee is claimed. Inspect actual persisted delivery history and receiver logs during verification.
