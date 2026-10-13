# API overview

The JSON API is under `/api/v1`. Successful single-resource responses use `{ "data": ... }`; collections add `page` with `nextCursor`, `limit` and `asOf`. Errors contain a safe `error.code`, generic message and request ID. No stack traces, secret paths or webhook credentials are returned.

| Operation | Endpoint |
| --- | --- |
| Liveness / writable readiness | GET /health/live, GET /health/ready |
| List / create monitors | GET /api/v1/monitors, POST /api/v1/monitors |
| Read / edit / confirmed delete | GET/PATCH/DELETE /api/v1/monitors/:id |
| Request manual check / read history | POST/GET /api/v1/monitors/:id/checks |
| Poll asynchronous execution | GET /api/v1/executions/:id |
| Sampled metrics / state history | GET /api/v1/monitors/:id/metrics, GET /api/v1/monitors/:id/transitions |
| Incidents / incident detail | GET /api/v1/incidents, GET /api/v1/incidents/:id |
| Dashboard / totals / diagnostics | GET /api/v1/dashboard, GET /api/v1/monitors/summary, GET /api/v1/engine |
| Safe startup configuration | GET /api/v1/configuration |
| Session login / inspection / logout | POST/GET/DELETE /api/v1/session |
| Live invalidation stream | GET /api/v1/events |
| Destinations | GET/POST /api/v1/notification-destinations |
| Destination read / edit / delete | GET/PATCH/DELETE /api/v1/notification-destinations/:id |
| Fixed notification test | POST /api/v1/notification-destinations/:id/test |
| Delivery history / counters | GET /api/v1/notification-deliveries, GET /api/v1/notifications/diagnostics |

Local unauthenticated mutations require an exact `Origin` header and JSON content type for POST/PATCH/PUT. All requests require the configured Host. Authenticated scripts use `Authorization: Bearer <operator token>` through a secure client; do not put tokens in shell history. An Origin supplied by a bearer client must still match. Browser cookie mutations also require `X-Pulse-CSRF` from session bootstrap. Remote cookies are Secure/HttpOnly/SameSite=Strict; sessions expire after eight hours or restart.

Example with a permitted loopback target:

```sh
curl -X POST http://127.0.0.1:3000/api/v1/monitors \
  -H 'Origin: http://127.0.0.1:3000' -H 'Content-Type: application/json' \
  -d '{"name":"Local example","url":"http://127.0.0.1:8081/health","intervalMs":15000}'
```

Creation returns 201, UUID and ETag. Edits require `If-Match: "<revision>"`; missing revisions return 428 and stale revisions 409. Deletion also needs `?confirm=true` and removes owned history permanently. Manual checks accept `{}` and return 202 with an execution ID; poll until terminal. Concurrent requests for one unsettled monitor share an ID. Paused monitors reject checks.

Collection `limit` is 1–100. Use returned cursors with the same filters. History accepts UTC `from`, `to`, `outcome` and sequence ordering; ranges are capped at 90 days. Monitor filtering accepts `q`, `status`, `enabled`, `sort` and `include=summary`. Metrics accepts `window=24h|7d|30d` or explicit UTC dates, optional `bucket=1m|5m|1h|1d`, at most 2000 buckets and 100000 source rows. Oversized requests fail explicitly. `status=OPEN` without dates includes old unresolved incidents.

Request bodies are capped at 64KiB. Operator mutations are limited to 60/minute and reads to 3000/minute; login allows 5/minute per source and 30/minute globally. Limits use token buckets. Saturation returns 429 or 503 with Retry-After. The SSE stream carries bounded resource invalidations, never observations or secrets; reconnect by refetching current API state.
