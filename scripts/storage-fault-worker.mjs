import assert from 'node:assert/strict';
import { createServer } from 'node:net';
import { createServer as createHttpServer } from 'node:http';
import { existsSync } from 'node:fs';
import { readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { createHash } from 'node:crypto';
import { release as kernelRelease } from 'node:os';
import { loadConfig } from '../apps/server/dist/config/config.js';
import { createRuntime } from '../apps/server/dist/runtime/runtime.js';
import { releaseIdentity, sameReleaseIdentity } from './release-identity.mjs';

const [scenario, directory, control] = process.argv.slice(2);
assert.ok(['full', 'readonly', 'ioerr'].includes(scenario));
assert.match(resolve(directory), /^\/tmp\/pulse-storage-mount-[a-zA-Z0-9-]+\/data$/);
assert.match(resolve(control), /^\/tmp\/pulse-storage-control-[a-zA-Z0-9-]+\/[^/]+$/);
const startedAt = new Date().toISOString();
const identity = await releaseIdentity();
const server = createServer();
await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
const port = server.address().port;
await new Promise(resolve => server.close(resolve));
let receipts = 0;
const receiver = createHttpServer((req, res) => { receipts++; req.resume(); res.writeHead(204).end(); });
await new Promise((resolve, reject) => { receiver.once('error', reject); receiver.listen(0, '127.0.0.1', resolve); });
await writeFile(join(control, 'fault.url'), `http://127.0.0.1:${receiver.address().port}/events`, { mode: 0o600 });
const config = await loadConfig({ PULSE_PORT: String(port), PULSE_PUBLIC_ORIGIN: `http://127.0.0.1:${port}`, PULSE_DATA_DIR: directory, PULSE_SECRETS_DIR: control, PULSE_EGRESS_POLICY: 'allow-private', PULSE_ALLOWED_PRIVATE_CIDRS: '127.0.0.1/32' });
let calls = 0;
let releaseResult;
const pendingResult = new Promise(resolve => { releaseResult = resolve; });
const options = { autoStart: false, executor: async () => {
    calls++;
    if (calls === 2 && scenario !== 'readonly') {
        await pendingResult;
        return { outcome: 'HTTP_ERROR', httpStatus: 500, durationMs: 1, redirectCount: 0, errorCode: null };
    }
    return { outcome: 'SUCCESS', httpStatus: 200, durationMs: 1, redirectCount: 0, errorCode: null };
} };
let runtime = await createRuntime(config, options);
const request = (path, method = 'GET', body) => fetch(config.publicOrigin + path, { method, headers: { origin: config.publicOrigin, ...(body === undefined ? {} : { 'content-type': 'application/json' }) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
const until = async (fn, predicate, timeout = 15000) => {
    const deadline = Date.now() + timeout;
    while (true) {
        const value = await fn();
        if (predicate(value)) return value;
        assert.ok(Date.now() < deadline, 'STORAGE_FIXTURE_DEADLINE');
        await new Promise(resolve => setTimeout(resolve, 10));
    }
};
const signal = stage => writeFile(join(control, stage), 'ready\n');
const command = stage => until(() => existsSync(join(control, stage)), Boolean, 60000);
const assertRecovery = async (id, baseline) => {
    runtime = await createRuntime(config, options);
    await runtime.listen();
    assert.equal((await request('/health/ready')).status, 200);
    const found = await (await request(`/api/v1/monitors/${id}`)).json();
    assert.equal(found.data.name, 'Committed storage fixture');
    const history = await (await request(`/api/v1/monitors/${id}/checks`)).json();
    assert.equal(history.data.length, baseline.checks);
    assert.ok(history.data.some(check => check.outcome === 'SUCCESS' && check.lifecycle === 'COMPLETED'));
    if (baseline.unsettledId) {
        const abandoned = history.data.find(check => check.id === baseline.unsettledId);
        assert.equal(abandoned.lifecycle, 'ABANDONED');
        for (const field of ['outcome', 'httpStatus', 'durationMs']) assert.equal(abandoned[field], null);
    }
    const incidents = await (await request('/api/v1/incidents')).json();
    assert.equal(incidents.data.length, 0);
    await runtime.close();
    const db = new DatabaseSync(join(directory, 'pulse.sqlite'));
    db.function('pulse_lower', { deterministic: true }, value => String(value).toLowerCase());
    assert.deepEqual(db.prepare('PRAGMA integrity_check').all().map(row => row.integrity_check), ['ok']);
    assert.equal(db.prepare('PRAGMA foreign_key_check').all().length, 0);
    assert.equal(db.prepare('SELECT count(*) AS n FROM checks WHERE monitor_id=?').get(id).n, baseline.checks);
    assert.equal(db.prepare('SELECT count(*) AS n FROM incidents').get().n, 0);
    assert.equal(db.prepare('SELECT count(*) AS n FROM notification_deliveries').get().n, 0);
    assert.equal(db.prepare('SELECT count(*) AS n FROM notification_destinations WHERE enabled=1').get().n, 1);
    assert.equal(receipts, 0);
    const migrations = db.prepare('SELECT version,checksum FROM schema_migrations ORDER BY version').all();
    db.close();
    return migrations;
};
try {
    await runtime.listen();
    assert.equal((await request('/api/v1/notification-destinations', 'POST', { name: 'Storage transaction fixture', enabled: true, urlSecretRef: 'fault' })).status, 201);
    const response = await request('/api/v1/monitors', 'POST', { name: 'Committed storage fixture', url: 'https://example.com', failureThreshold: 1 });
    assert.equal(response.status, 201);
    const id = (await response.json()).data.id;
    runtime.scheduler.start();
    await until(async () => (await (await request(`/api/v1/monitors/${id}/checks`)).json()).data, rows => rows.some(row => row.lifecycle === 'COMPLETED'));
    const baseline = { checks: 1, dispatched: calls, unsettledId: null };
    assert.equal(calls, 1);
    if (scenario !== 'readonly') {
        const queued = await request(`/api/v1/monitors/${id}/checks`, 'POST', {});
        assert.equal(queued.status, 202);
        baseline.unsettledId = (await queued.json()).data.id;
        await until(() => calls, value => value === 2);
        baseline.checks++;
        baseline.dispatched = calls;
    }
    // SQLite maps its WAL index writable; Linux correctly refuses a live ro remount.
    // Close first and verify startup on a genuinely read-only filesystem instead.
    if (scenario === 'readonly') await runtime.close();
    await signal('ready');
    await command('verify');
    let failure = null;
    let readonlyError = null;
    if (scenario === 'readonly') {
        const probe = new DatabaseSync(join(directory, 'pulse.sqlite'));
        try { probe.exec('UPDATE check_commit_clock SET value=value+1 WHERE id=1'); }
        catch (error) { readonlyError = Number(error.errcode) & 255; }
        finally { probe.close(); }
        // WAL may need a fresh -shm/-wal after clean shutdown; a read-only volume
        // then reports CANTOPEN rather than READONLY. Both forbid the write.
        assert.ok([8, 14].includes(readonlyError), 'Read-only filesystem accepted a write or returned an unrelated SQLite fault');
        await assert.rejects(createRuntime(config, options), { code: 'DATABASE_UNAVAILABLE' });
        await assert.rejects(request('/health/live'));
        assert.equal(calls, baseline.dispatched);
    } else {
        // Release an actual in-flight failed observation into the incident transaction.
        // Storage must reject the whole terminal update, never synthesize target downtime.
        releaseResult();
        await until(() => runtime.db.fault, Boolean);
        const read = await request(`/api/v1/monitors/${id}`);
        assert.equal(read.status, 503);
        failure = await read.json();
        assert.equal(failure?.error?.code, 'DATABASE_UNAVAILABLE');
        assert.equal(runtime.db.fault, 'DATABASE_UNAVAILABLE');
        assert.equal(runtime.isReady(), false);
        const ready = await request('/health/ready');
        assert.equal(ready.status, 503);
        assert.equal((await ready.json()).code, 'DATABASE_UNAVAILABLE');
        assert.equal((await request('/health/live')).status, 200);
        assert.equal((await request('/api/v1/monitors', 'POST', { name: 'Rejected after fault', url: 'https://example.com', enabled: false })).status, 503);
        runtime.scheduler.wake();
        await new Promise(resolve => setTimeout(resolve, 250));
        assert.equal(calls, baseline.dispatched, 'Faulted storage dispatched a target');
        assert.equal(JSON.stringify(failure).includes(directory), false);
        await runtime.close().catch(() => {});
    }
    await signal('faulted');
    await command('recover');
    const migrations = await assertRecovery(id, baseline);
    const files = ['apps/server/dist/persistence/store.js', 'apps/server/dist/persistence/database.js', 'apps/server/dist/runtime/runtime.js'];
    const digest = createHash('sha256');
    for (const file of files) digest.update(await readFile(file));
    assert.ok(sameReleaseIdentity(await releaseIdentity(), identity), 'STORAGE_CANDIDATE_CHANGED');
    await writeFile(join(control, 'result.json'), JSON.stringify({ scenario, result: 'PASS', startedAt, completedAt: new Date().toISOString(), releaseIdentity: identity, candidateUnchangedDuringRun: true, environment: { os: 'Ubuntu 24.04 userspace', kernel: kernelRelease(), node: process.version, sqlite: process.versions.sqlite }, scope: 'Disposable local filesystem fault injection; no physical power-loss or hardware durability claim', runtimeSha256: digest.digest('hex'), schemaMigrations: migrations, fault: scenario === 'readonly' ? { nativeSqliteCode: readonlyError, startupRejected: true, listenerAbsent: true } : { terminalObservationTransactionFailed: true, writeStatus: 503, readinessStatus: 503, liveStatus: 200 }, assertions: { dispatchStopped: true, noSyntheticDowntime: true, committedCheckPreserved: true, committedMonitorPreserved: true, uncertainCheckRecoveredAbandoned: scenario !== 'readonly', noUncommittedIncidentOrDelivery: true, postRestartIntegrity: 'ok', foreignKeyViolations: 0 } }, null, 2) + '\n');
} catch (error) {
    console.error(error);
    releaseResult();
    await runtime.close().catch(() => {});
    await writeFile(join(control, 'result.json'), JSON.stringify({ scenario, result: 'FAIL', startedAt, completedAt: new Date().toISOString(), error: error.code ?? error.message }, null, 2) + '\n');
    process.exitCode = 1;
} finally {
    receiver.closeAllConnections();
    await new Promise(resolve => receiver.close(resolve));
    await signal('finished');
}
