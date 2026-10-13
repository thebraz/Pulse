import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { randomBytes, createHash } from 'node:crypto';
import { readFile, writeFile, mkdtemp, mkdir, rm } from 'node:fs/promises';
import { createServer, request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { tmpdir, release } from 'node:os';
import { join, resolve, dirname, basename } from 'node:path';
import { once } from 'node:events';
import { performance } from 'node:perf_hooks';
import { loadConfig } from '../apps/server/dist/config/config.js';
import { createRuntime } from '../apps/server/dist/runtime/runtime.js';
import { releaseIdentity, sameReleaseIdentity } from './release-identity.mjs';

assert.equal(process.platform, 'linux', 'The nginx fixture runs in the isolated Ubuntu userspace');
const recordedAt = new Date().toISOString(), directory = await mkdtemp(join(tmpdir(), 'pulse-proxy-nginx-'));
const checks = [], streams = [];
let child, runtime;
const step = name => checks.push({ name, result: 'PASS' });
const freePort = async () => {
    const server = createServer();
    await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
    const port = server.address().port;
    await new Promise(resolve => server.close(resolve));
    return port;
};
const until = async (fn, predicate, timeout = 5000) => {
    const deadline = Date.now() + timeout;
    while (true) {
        const value = await fn();
        if (predicate(value)) return value;
        assert.ok(Date.now() < deadline, 'NGINX_FIXTURE_DEADLINE');
        await new Promise(resolve => setTimeout(resolve, 10));
    }
};
const report = { recordedAt, platform: { os: 'Ubuntu 24.04 userspace', kernel: release(), node: process.version, sqlite: process.versions.sqlite }, scope: 'Isolated loopback nginx TLS proxy; no operator deployment, public certificate or external firewall is certified', checks };
report.releaseIdentity = await releaseIdentity();
try {
    const version = spawnSync('/usr/sbin/nginx', ['-v'], { encoding: 'utf8' });
    assert.equal(version.status, 0);
    report.nginx = version.stderr.trim();
    const backendPort = await freePort(), proxyPort = await freePort(), origin = `https://fixture.example:${proxyPort}`;
    const secrets = join(directory, 'secrets');
    await mkdir(secrets, { mode: 0o700 });
    const token = randomBytes(32).toString('base64url');
    const tokenFile = join(secrets, 'operator.key');
    await writeFile(tokenFile, token, { mode: 0o600 });
    const cert = await readFile('tests/fixtures/localhost-cert.pem');
    const production = await readFile('examples/nginx-pulse.conf', 'utf8');
    report.productionConfigSha256 = createHash('sha256').update(production).digest('hex');
    for (const required of ['proxy_buffering off;', 'proxy_read_timeout 60s;', 'proxy_next_upstream off;', 'proxy_set_header Host $http_host;', 'proxy_set_header X-Forwarded-For $remote_addr;']) assert.ok(production.includes(required));
    const conf = production.replace('listen 443 ssl;', `listen 127.0.0.1:${proxyPort} ssl;`).replace('server_name pulse.example.com;', 'server_name fixture.example;').replace('/etc/ssl/pulse/fullchain.pem', resolve('tests/fixtures/localhost-cert.pem')).replace('/etc/ssl/pulse/private-key.pem', resolve('tests/fixtures/localhost-key.pem')).replace('/var/log/nginx/pulse-error.log', join(directory, 'proxy-error.log')).replace('http://127.0.0.1:3000', `http://127.0.0.1:${backendPort}`);
    const confFile = join(directory, 'nginx.conf');
    await writeFile(confFile, `daemon off;\nmaster_process off;\npid ${join(directory, 'nginx.pid')};\nerror_log ${join(directory, 'nginx-main-error.log')} crit;\nevents { worker_connections 128; }\nhttp { client_body_temp_path ${join(directory, 'body')}; proxy_temp_path ${join(directory, 'proxy')}; fastcgi_temp_path ${join(directory, 'fastcgi')}; uwsgi_temp_path ${join(directory, 'uwsgi')}; scgi_temp_path ${join(directory, 'scgi')}; ${conf} }\n`);
    const syntax = spawnSync('/usr/sbin/nginx', ['-t', '-c', confFile, '-p', directory], { encoding: 'utf8' });
    assert.equal(syntax.status, 0, syntax.stderr);
    step('nginx validates the shipped production configuration with fixture paths and ports');
    const config = await loadConfig({ PULSE_PORT: String(backendPort), PULSE_DATA_DIR: join(directory, 'data'), PULSE_EXPOSURE: 'remote', PULSE_PUBLIC_ORIGIN: origin, PULSE_SECRETS_DIR: secrets, PULSE_AUTH_TOKEN_FILE: tokenFile, PULSE_TRUSTED_PROXY_CIDRS: '127.0.0.1/32' });
    runtime = await createRuntime(config, { autoStart: false });
    await runtime.listen();
    child = spawn('/usr/sbin/nginx', ['-c', confFile, '-p', directory], { stdio: ['ignore', 'ignore', 'pipe'] });
    let processError = '';
    child.stderr.setEncoding('utf8'); child.stderr.on('data', chunk => { processError += chunk; });
    const request = (path, method = 'GET', headers = {}, body, servername = 'fixture.example') => new Promise((resolve, reject) => {
        const payload = body === undefined ? undefined : JSON.stringify(body);
        httpsRequest({ hostname: '127.0.0.1', port: proxyPort, servername, ca: cert, path, method, headers: { host: `fixture.example:${proxyPort}`, origin, ...(payload ? { 'content-type': 'application/json', 'content-length': String(Buffer.byteLength(payload)) } : {}), ...headers }, timeout: 4000 }, response => {
            const tls = response.socket.getProtocol();
            let text = ''; response.setEncoding('utf8'); response.on('data', chunk => { text += chunk; });
            response.on('end', () => resolve({ status: response.statusCode, headers: response.headers, body: text, tls }));
        }).on('timeout', function () { this.destroy(new Error('NGINX_REQUEST_DEADLINE')); }).on('error', reject).end(payload);
    });
    await until(async () => { assert.equal(child.exitCode, null, processError); return request('/health/live').catch(() => null); }, value => value?.status === 200);
    const live = await request('/health/live');
    assert.ok(['TLSv1.2', 'TLSv1.3'].includes(live.tls)); report.negotiatedTls = live.tls;
    await assert.rejects(request('/health/live', 'GET', {}, undefined, 'attacker.example'), error => error.code === 'ERR_TLS_CERT_ALTNAME_INVALID');
    step('TLS peer identity and CA verification stay enabled');
    assert.equal((await request('/api/v1/monitors')).status, 401);
    assert.equal((await request('/api/v1/monitors', 'GET', { 'x-forwarded-for': '8.8.8.8', 'x-forwarded-proto': 'https' })).status, 401);
    const direct = await new Promise((resolve, reject) => httpRequest({ hostname: '127.0.0.1', port: backendPort, path: '/api/v1/monitors', headers: { host: `fixture.example:${proxyPort}` } }, response => { response.resume(); response.on('end', () => resolve(response.statusCode)); }).on('error', reject).end());
    assert.equal(direct, 401);
    step('unauthorized proxied and direct backend requests remain denied, including spoofed forwarding headers');
    assert.equal((await request('/health/live', 'GET', { host: 'attacker.example' })).status, 403);
    assert.equal((await request('/health/live', 'GET', { origin: 'https://attacker.example' })).status, 403);
    step('nginx preserves exact public Host and browser Origin enforcement');
    const login = await request('/api/v1/session', 'POST', {}, { token });
    assert.equal(login.status, 200);
    const setCookie = login.headers['set-cookie'][0];
    for (const flag of ['HttpOnly', 'SameSite=Strict', 'Secure']) assert.ok(setCookie.includes(flag));
    const cookie = setCookie.split(';')[0], csrf = JSON.parse(login.body).data.csrfToken;
    assert.equal((await request('/api/v1/monitors', 'GET', { cookie })).status, 200);
    step('authenticated login issues a Secure HttpOnly SameSite cookie and permits protected reads');
    assert.equal((await request('/api/v1/events', 'GET', { authorization: 'Bearer ' + token })).status, 401);
    assert.equal((await request('/api/v1/events?token=FAKE_PROXY_QUERY_SECRET', 'GET', { cookie })).status, 400);
    step('SSE requires the session cookie and rejects credentials in query strings or bearer-only streams');
    const connectedAt = performance.now();
    for (let i = 0; i < 20; i++) {
        const stream = { text: '', response: null, connectedAt: performance.now(), endedAfterMs: null, closedAfterMs: null, error: null };
        await new Promise((resolve, reject) => {
            httpsRequest({ hostname: '127.0.0.1', port: proxyPort, servername: 'fixture.example', ca: cert, path: '/api/v1/events', headers: { host: `fixture.example:${proxyPort}`, origin, cookie } }, response => {
                try {
                    assert.equal(response.statusCode, 200);
                    assert.equal(response.headers['content-type'], 'text/event-stream');
                    response.setEncoding('utf8'); stream.response = response;
                    response.on('data', chunk => { stream.text += chunk; if (stream.text.includes(': connected\n\n')) resolve(); });
                    response.on('end', () => { stream.endedAfterMs = performance.now() - stream.connectedAt; });
                    response.on('close', () => { stream.closedAfterMs = performance.now() - stream.connectedAt; });
                    response.on('error', error => { stream.error = error.code; reject(error); });
                } catch (error) { reject(error); }
            }).on('error', reject).end();
        });
        streams.push(stream);
    }
    report.twentyStreamConnectionMs = performance.now() - connectedAt;
    assert.ok(report.twentyStreamConnectionMs < 3000);
    assert.equal((await request('/api/v1/events', 'GET', { cookie })).status, 429);
    step('twenty authenticated streams connect without buffering; the twenty-first receives 429');
    await until(() => streams, values => values.every(value => value.text.includes(': heartbeat\n\n')), 18000);
    report.allStreamHeartbeatMs = performance.now() - connectedAt;
    step('the real fifteen-second heartbeat reaches all twenty clients through nginx');
    const monitor = { name: 'FAKE_PROXY_MONITOR_NAME', url: 'https://example.com/fixture', enabled: false };
    assert.equal((await request('/api/v1/monitors', 'POST', { cookie }, monitor)).status, 403);
    const mutatedAt = performance.now();
    assert.equal((await request('/api/v1/monitors', 'POST', { cookie, 'x-pulse-csrf': csrf }, monitor)).status, 201);
    await until(() => streams, values => values.every(value => value.text.includes('event: invalidate\n') && value.text.includes('"resource":"monitors"')), 3000);
    report.committedInvalidationMs = performance.now() - mutatedAt;
    step('after an idle heartbeat, mutations require CSRF and their committed invalidation reaches every stream promptly');
    for (const stream of streams) for (const secret of [token, csrf, cookie, monitor.url, monitor.name]) assert.equal(stream.text.includes(secret), false);
    const page = await request('/monitors/fixture', 'GET', { cookie });
    assert.equal(page.status, 200); assert.ok(page.headers['content-security-policy'].includes("default-src 'none'"));
    step('SSE contains no target or credentials; SPA responses retain their CSP');
    for (const name of ['proxy-error.log', 'nginx-main-error.log']) {
        const log = await readFile(join(directory, name), 'utf8').catch(error => error.code === 'ENOENT' ? '' : Promise.reject(error));
        for (const secret of [token, csrf, cookie, 'FAKE_PROXY_QUERY_SECRET']) assert.equal(log.includes(secret), false);
    }
    step('fixture proxy logs contain no credential canaries');
    const hash = createHash('sha256');
    for (const file of ['apps/server/dist/api/security.js', 'apps/server/dist/api/events.js', 'apps/server/dist/runtime/runtime.js']) hash.update(await readFile(file));
    report.runtimeSha256 = hash.digest('hex');
    assert.ok(sameReleaseIdentity(await releaseIdentity(), report.releaseIdentity), 'PROXY_CANDIDATE_CHANGED');
    report.candidateUnchangedDuringRun = true;
    report.result = 'PASS';
} catch (error) {
    report.result = 'FAIL'; report.failure = error.code ?? error.message;
    console.error(error); process.exitCode = 1;
} finally {
    report.streams = streams.map(stream => ({ endedAfterMs: stream.endedAfterMs, closedAfterMs: stream.closedAfterMs, error: stream.error, heartbeatReceived: stream.text.includes(': heartbeat\n\n') }));
    streams.forEach(stream => stream.response?.destroy());
    await runtime?.close().catch(() => {});
    if (child && child.exitCode === null) { child.kill('SIGQUIT'); await once(child, 'exit'); }
    report.completedAt = new Date().toISOString();
    await writeFile('docs/evidence/stage-4-nginx-proxy.json', JSON.stringify(report, null, 2) + '\n');
    assert.equal(dirname(resolve(directory)), resolve(tmpdir())); assert.ok(basename(directory).startsWith('pulse-proxy-nginx-'));
    await rm(directory, { recursive: true });
}
