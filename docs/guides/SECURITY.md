# Deployment security

Use loopback-only operation for a trusted local operator. All routes check the configured Host. Browser mutations require exact Origin and JSON; authenticated cookie mutations require CSRF. Never expose an unauthenticated local instance through port forwarding or a permissive reverse proxy.

To enable authenticated remote mode, provision a protected random operator-token file within the secret directory, then set:

```text
PULSE_EXPOSURE=remote
PULSE_PUBLIC_ORIGIN=https://pulse.example.com
PULSE_AUTH_TOKEN_FILE=/absolute/secrets/operator.key
PULSE_SECRETS_DIR=/absolute/secrets
```

The hostname and paths are examples to replace with your deployment. Keep `PULSE_HOST=127.0.0.1` with a proxy on the same host. Set `PULSE_TRUSTED_PROXY_CIDRS=127.0.0.1/32` only when that is the proxy's backend source address. This setting controls source-IP accounting, not authorization or Host/Origin acceptance. Pulse's HTTP backend does not terminate TLS or prove firewall/proxy correctness. Test unauthorized direct/proxied requests, browser login/CSRF and SSE routing on the actual destination before exposing it.

The shipped [nginx configuration](../../examples/nginx-pulse.conf) is included in nginx's `http` context, for example in a dedicated `conf.d` file. Replace the example hostname, certificate/key paths and backend port. Use a certificate trusted by your browser, protect its private key and validate configuration with `nginx -t` before a deliberate reload. The example keeps the public Host, replaces forwarding headers with nginx's connection values, disables response buffering/caching and upstream replay, and uses a sixty-second upstream read timeout above Pulse's fifteen-second SSE heartbeat. [nginx documents the corresponding proxy directives](https://nginx.org/en/docs/http/ngx_http_proxy_module.html).

Access logs are disabled in the example because even rejected request URLs can contain secrets; protect and review any proxy log policy before enabling it. Restrict the backend port to the proxy host and independently check that a remote client cannot connect to it. TLS/auth/SSE integration against the shipped nginx settings can be exercised in an isolated Ubuntu environment with `node scripts/proxy-nginx.mjs` from the source distribution after installing/building dependencies and provisioning nginx. It uses dummy certificates, ephemeral ports and credentials. A passing fixture does not certify your public certificate, DNS, network controls or deployed configuration.

Generate tokens and signing keys directly into protected files, never into chat, logs, environment values or CLI arguments. Use at least 32 cryptographically random bytes encoded as base64url. Set owner-only POSIX permissions; Windows remote mode fails closed on broad readable ACLs or a failed bounded ACL probe. Protect directories from replacement by other users. Rotate the operator file and restart to invalidate sessions. Sessions are capped at 100, expire after eight hours and are held in memory; permanent credentials are never saved in browser storage.

Outbound access defaults to public-only on ports 80/443. Explicit private CIDRs grant internal reachability only to intended addresses; never use a broad allowlist without understanding the endpoints it exposes. Metadata/link-local/multicast/unspecified addresses remain denied. Requests pin validated addresses, preserve TLS identity and revalidate every followed redirect. No user-supplied proxy, arbitrary headers, shell command or target body is executed.

SQL is parameterized and owned by one worker. Static assets use realpath containment. React renders operator strings as text; no target HTML is rendered. CSP restricts scripts, styles and connections to the same origin and forbids framing. Request bodies, queues, sockets, headers, streams and retries have explicit bounds. These controls reduce exposure; they are not a guarantee against all vulnerabilities.

Review [security reporting](../../SECURITY.md), locked dependencies, upstream Node/SQLite updates and the measured release report. Actual production proxy validation, required platform runs and residual capacity gates must remain visible before publication.
