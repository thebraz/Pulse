# Pulse monitoring engine

The executor performs bounded HTTP observations, not browser execution or content validation. It is shared by automatic and manual checks; webhook sending shares the validated transport but has a separate pool. [Security policy](10-SECURITY-MODEL.md) is mandatory from Stage 1.

## Request algorithm

1. Reserve a persisted execution through the scheduler and capture monitor revision, lifecycle epoch and an AbortSignal. Mark RUNNING only when a network slot is acquired.
2. Start one monotonic deadline and UTC startedAt. Parse the URL with the platform URL parser, reject unsupported components, normalize hostname and validate the destination policy. Static policy checks also run when the monitor is saved.
3. Resolve all A/AAAA answers under the same deadline; reject the whole set if any answer is forbidden. Select a validated address deterministically and pin the actual socket to that address. Preserve original hostname for Host, TLS SNI and certificate verification. Never validate one resolution and let a library resolve again.
4. Send GET or HEAD using HTTP/1.1, normal certificate verification, a fixed Pulse User-Agent and no ambient credentials, cookies, proxy environment or arbitrary monitor headers. Do not use user-supplied shell commands or external executables.
5. Wait for final response headers, with a 16 KiB header cap and the original total deadline. Do not buffer, persist or parse response bodies; cancel/destroy the body stream and release the socket after headers. A successful HEAD and GET use identical status/timing rules.
6. Apply redirect rules below. Classify final expected status as SUCCESS and any other final status as HTTP_ERROR. Record safe status/error metadata and monotonic duration. Commit through the result processor before releasing the logical execution reservation.

No connection pooling or retry is required for monitoring requests; closing each socket makes DNS validation per request explicit and prevents idle connections bypassing new policy. A later keep-alive optimization needs connection-policy tests and an ADR. A failed address does not trigger an unbounded address-selection retry. The next scheduled check is the retry opportunity. TLS verification cannot be disabled through monitor input.

## Timing, redirect and classification contract

`durationMs = monotonic(finalHeadersOrFailure) - monotonic(startBeforeDns)`. It includes DNS, TCP, TLS, request transmission and all followed redirects, and excludes queue wait, database time and body download. Public UI must call it response-header latency, not page-load time. Store unrounded finite duration; display rounding is presentation-only. UTC timestamp arithmetic is never the latency source.

Timeout defaults to 10 seconds, maximum 30 seconds. One absolute deadline covers resolution, every hop and headers; redirects cannot reset it. Timeout aborts the request and produces COMPLETED/TIMEOUT, unless administrative cancellation won the fence first. Headers arriving at/after the deadline lose to timeout. Network callbacks may race; one terminal transition is permitted.

Informational 1xx responses do not terminate the check. An unsolicited 101 protocol upgrade is closed immediately and recorded as HTTP_ERROR with safe code UNSUPPORTED_UPGRADE; no upgraded protocol or WebSocket is supported. Expected status lists therefore begin at 200.

Redirects are not automatically followed. When followRedirects=false, 3xx is evaluated against expectedStatusCodes like any other response. When true, only 301/302/303/307/308 with Location are followed. Resolve relative Location against the current URL; preserve GET/HEAD method. Revalidate URL, DNS, pinned address and policy for every hop; no HTTPS-to-HTTP downgrade, cross-origin credentials, userinfo or monitor query parameters are allowed. More than 3 hops, repeated normalized URL, or missing/malformed Location on a redirect to be followed produces REDIRECT_ERROR. A forbidden destination produces POLICY_BLOCKED and sends no request to it.

| Condition | Outcome | Counts as target observation? |
| --- | --- | --- |
| Final expected status | SUCCESS | Yes, successful. |
| Final unexpected status, including 4xx/5xx | HTTP_ERROR | Yes, failed. |
| NXDOMAIN/no valid records/resolver failure | DNS_ERROR | Yes, failed; Pulse cannot infer the target is globally down. |
| Certificate mismatch/expiry/trust or TLS handshake error | TLS_ERROR | Yes, failed. |
| Refusal/reset/unreachable/premature close before headers | CONNECTION_ERROR | Yes, failed. |
| Total deadline expires | TIMEOUT | Yes, failed. |
| Redirect loop/limit/invalid Location | REDIRECT_ERROR | Yes, failed. |
| Egress policy denies address/URL | POLICY_BLOCKED | No; configuration/security obstruction, not evidence of target failure. |
| Pause/edit/shutdown cancellation | lifecycle CANCELLED, outcome null | No. |
| Process dies with unfinished work | lifecycle ABANDONED, outcome null | No. |
| Database/worker failure | operational error, no invented terminal observation | No. |

POLICY_BLOCKED resets health context to UNKNOWN with reason POLICY_BLOCKED from Stage 2, retains any unresolved incident, and appears as an operator-visible safe error. A DNS failure is different: no policy decision could authorize a connection, but the failed resolution itself is a counted observation. Error classification must use tested error codes and execution stage; raw stack/message strings cannot enter API history or logs.

## Cancellation and resource guarantees

Each execution has one AbortController linked to deadline and lifecycle cancellation. Cancellation closes pending resolution where supported and always prevents socket creation afterward; non-cancellable DNS completion is ignored under the fence. Any remaining resolver operation is bounded by the deadline and must not spawn a new request. Abort removes listeners, timers and sockets. A cancellation during result commit is serialized: either the valid result commits before the lifecycle mutation, or the mutation fences it out; no partial evaluation is allowed.

The implementation must not hold a SQLite transaction while resolving or connecting. Headers, redirect count, sockets and in-memory payloads are bounded. Manual requests do not create an independent executor. See [scheduler invariants](06-SCHEDULER-RELIABILITY.md).

## Required verification

Use local controlled HTTP/HTTPS/DNS fixtures for expected/unexpected statuses, delayed headers, slow bodies, resets, NXDOMAIN, TLS faults, missing Location, loops, relative redirects and deadline sharing. Verify actual contacted IP and SNI, redirect denial before a second request, timeout/cancel races, zero body retention and socket cleanup. Adversarial tests use an explicitly scoped fixture egress policy; production public-only defaults must not be relaxed to make tests pass.
