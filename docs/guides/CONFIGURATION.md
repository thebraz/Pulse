# Configuration

Settings are read once at startup from `PULSE_` environment variables. Unknown names and invalid values reject startup. There is no automatic `.env` loader. Use your shell or service manager. Do not put token or webhook URL values into environment variables.

| Variable | Default | Meaning |
| --- | --- | --- |
| PULSE_HOST | 127.0.0.1 | Listener address; local mode requires a loopback IP. |
| PULSE_PORT | 3000 | Port, 1–65535. |
| PULSE_PUBLIC_ORIGIN | http://127.0.0.1:3000 | Exact browser origin. Set explicitly when changing host/port. |
| PULSE_DATA_DIR | ~/.pulse | Persistent local directory; contains pulse.sqlite. Relative overrides resolve from the working directory. |
| PULSE_SECRETS_DIR | ./secrets | Provisioned secret root, outside served assets. Prefer an absolute directory. |
| PULSE_EXPOSURE | local | local or remote; remote requires HTTPS origin and token file. |
| PULSE_AUTH_TOKEN_FILE | unset | Token file inside the secret root; optional locally, required remotely. |
| PULSE_EGRESS_POLICY | public-only | public-only or allow-private. |
| PULSE_ALLOWED_PRIVATE_CIDRS | empty | Comma-separated private/loopback CIDRs; required for allow-private. |
| PULSE_TRUSTED_PROXY_CIDRS | empty | Proxy CIDRs used for source-IP accounting only. |
| PULSE_CHECK_CONCURRENCY | 10 | 1–50 simultaneous checks. |
| PULSE_MANUAL_QUEUE_LIMIT | 100 | 1–1000 queued manual checks. |
| PULSE_DB_QUEUE_LIMIT | 1000 | 10–10000 commands; must exceed check pool + webhook pool + 2. |
| PULSE_WEBHOOK_CONCURRENCY | 2 | 1–10 simultaneous deliveries; independent of checks. |
| PULSE_CHECK_RETENTION_DAYS | 30 | 1–365 days of terminal checks. |
| PULSE_INCIDENT_RETENTION_DAYS | 365 | 30–3650 days of resolved incident/coverage history. |
| PULSE_DELIVERY_RETENTION_DAYS | 30 | 1–365 days of terminal deliveries. |
| PULSE_LOG_LEVEL | info | debug, info, warn or error. |

Public targets use ports 80/443. Explicitly permitted private addresses may use other ports. Metadata, link-local, unspecified and multicast addresses remain denied even with a private-network allowlist. Every A/AAAA answer and redirect is checked before the actual socket is pinned. HTTPS verification stays enabled. Proxy environment variables do not redirect monitoring traffic.

Monitor URLs support HTTP/HTTPS without credentials, query strings or fragments. Requests use GET or HEAD, fixed headers and no body. Monitor defaults: interval 60000ms, timeout 10000ms, expected status 200, failure threshold 3, recovery threshold 2, latency threshold 1000ms, slow-success threshold 3. Interval range is 15000–3600000ms; timeout 1000–30000ms; thresholds 1–10; expected status set 1–50 codes in 200–599. Redirect following is optional and limited to three hops.

To change ports in PowerShell:

```powershell
$env:PULSE_PORT='3100'
$env:PULSE_PUBLIC_ORIGIN='http://127.0.0.1:3100'
pulse start
```

One scheduler owns a canonical data directory through an OS-released exclusive lock. A second process or lock-port collision fails closed. Use local storage; network shares and cloud-synced directories are unsupported.
