import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, copyFile, stat, readdir } from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import { tmpdir, cpus, totalmem, platform, release, arch } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createServer } from 'node:http';
import { createHash, createHmac, randomUUID, randomBytes } from 'node:crypto';
import { fork } from 'node:child_process';
import { performance } from 'node:perf_hooks';
import { gzipSync } from 'node:zlib';
import { DatabaseSync } from 'node:sqlite';
import { chromium } from '@playwright/test';
import { Store } from '../apps/server/dist/persistence/store.js';
import { reference, diagnosticProfile, percentiles, fixtureCloneTarget, memoryTrend, classifyRun, startupBudgetMs, startupWithinBudget, operationEvidence, rebaseReferenceHistory, referenceHistorySnapshot } from './performance-helpers.mjs';
import { releaseIdentity, sameReleaseIdentity } from './release-identity.mjs';
import { betaProfile, evaluateBetaPerformance } from './beta-performance.mjs';

const args = process.argv.slice(2), sourceArg = args.indexOf('--source');
if (sourceArg < 0 || !args[sourceArg + 1]) throw new Error('BENCHMARK_SOURCE_REQUIRED: supply --source with a stopped controlled 4.32m-row SQLite fixture.');
const source = resolve(args[sourceArg + 1]), diagnostic = args.includes('--diagnostic'), exclusiveHost = args.includes('--exclusive-host');
const beta = args.includes('--beta');
assert.ok(!(beta && diagnostic), 'BETA_DIAGNOSTIC_FLAGS_CONFLICT');
const duration = beta ? betaProfile : diagnostic ? diagnosticProfile : reference;
const output = beta ? `docs/evidence/stage-4-beta-performance-${platform() === 'win32' ? 'windows' : 'linux'}.json` : diagnostic ? 'docs/evidence/stage-4-performance-diagnostic.json' : `docs/evidence/stage-4-performance-${platform() === 'win32' ? 'windows' : 'linux'}.json`, root = process.cwd(), directory = await mkdtemp(join(tmpdir(), 'pulse-reference-')), path = fixtureCloneTarget(source, directory, tmpdir());
const report = { startedAt: new Date().toISOString(), result: 'NOT TESTED', phase: 'clone', diagnostic, conditions: { os: platform(), release: release(), arch: arch(), node: process.version, cpu: cpus()[0]?.model, logicalCpus: cpus().length, ramBytes: totalmem(), ...reference, intervalMs: 60000, timeoutMs: 10000, concurrency: 10, fastTargets: 95, timeoutTargets: 5, eventLoopResolutionMs: 10, boundsSampleMs: 20, telemetrySampleMs: 1000, hostLoad: 'Shared workstation; no dedicated-host claim.', referenceHostVerified: false, cacheState: 'OS cache not flushed; clone checksums and migration preparation precede startup.', workloadInjection: 'A benchmark-only preload offers at most one controlled outbox fixture per 500ms slot, skipping a slot occupied by an actual incident event. Actual offers and receipts are measured separately; delayed worker timers do not prove two sends/second. Normal delivery, signing, retry and browser code is unchanged.' }, budgets: {}, measurements: {}, samples: [], overloadSamples: [], limitations: ['A shared workstation does not prove the dedicated reference-host requirement.'], browser: { clients: 0, interactions: [], heaps: [], longTasks: [], errors: [] }, receiver: { acknowledged: 0, failed: 0, invalidSignatures: 0, bytes: 0, receivedBySecond: {} } };
if (diagnostic) report.limitations.push('Diagnostic durations and sample counts cannot pass the release reference gate.');
if (beta) report.limitations.push('Explicit experimental beta policy: 400 MiB and a 15-minute observation. Stable performance criteria remain unchanged and separately evaluated.');
report.conditions.startupBudgetMs = startupBudgetMs;
report.conditions.executedProfile = duration;
if (exclusiveHost) {
    assert.ok(cpus().length >= 2 && totalmem() >= 4 * 1024 ** 3, 'REFERENCE_HOST_TOO_SMALL');
    report.conditions.hostLoad = 'Operator reserved this local-SSD workstation for this run without competing work; supported-platform runs are sequential.';
    report.conditions.referenceHostVerified = true;
    report.conditions.hostReservation = 'Explicit operator confirmation on 2026-10-12; this flag is an operator attestation, not automatic detection of unrelated processes.';
    report.limitations = report.limitations.filter(value => !value.startsWith('A shared workstation'));
}
await mkdir('docs/evidence', { recursive: true });
const save = () => writeFile(output, JSON.stringify(report, null, 2) + '\n');
const wait = ms => new Promise(r => setTimeout(r, ms));
async function deadline(promise, ms, code) {
    let timer;
    try { return await Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(code)), ms); })]); }
    finally { clearTimeout(timer); }
}
const hash = async file => { const digest = createHash('sha256'); for await (const chunk of createReadStream(file)) digest.update(chunk); return digest.digest('hex'); };
async function candidateDigest() {
    const files = {};
    async function walk(directory) { for (const entry of (await readdir(directory, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) { const file = join(directory, entry.name); if (entry.isDirectory()) await walk(file); else if (entry.isFile()) files[file.replaceAll('\\', '/')] = await hash(file); } }
    for (const directory of ['apps/server/dist', 'packages/contracts/dist', 'apps/web/dist', 'bin']) await walk(directory);
    files['package-lock.json'] = await hash('package-lock.json');
    return { sha256: createHash('sha256').update(JSON.stringify(files)).digest('hex'), files };
}
const size = async file => { try { return (await stat(file)).size; } catch (e) { if (e.code === 'ENOENT') return 0; throw e; } };
const listen = async server => { await new Promise((res, rej) => { server.once('error', rej); server.listen(0, '127.0.0.1', res); }); return server.address().port; };
let child, childExit, browser, pages = [], reader, failedReceiver = false, destinationId, ids = [];
const sockets = new Set(), receiverKey = randomBytes(32).toString('base64url');
const fixture = createServer((request, response) => { if (!request.url.startsWith('/slow/')) response.end('Controlled reference response'); });
fixture.on('connection', socket => { sockets.add(socket); socket.once('close', () => sockets.delete(socket)); });
const fixturePort = await listen(fixture);
const receiver = createServer(async (request, response) => {
    let body = ''; for await (const chunk of request) { body += chunk; if (body.length > 16384) { request.destroy(); return; } }
    const expected = 'v1=' + createHmac('sha256', Buffer.from(receiverKey, 'base64url')).update(request.headers['x-pulse-timestamp'] + '.' + body).digest('hex');
    if (request.headers['x-pulse-signature'] !== expected) report.receiver.invalidSignatures++;
    const second = Math.floor(Date.now() / 1000); report.receiver.receivedBySecond[second] = (report.receiver.receivedBySecond[second] ?? 0) + 1; report.receiver.bytes += Buffer.byteLength(body);
    report.receiver[failedReceiver ? 'failed' : 'acknowledged']++; response.writeHead(failedReceiver ? 503 : 204, failedReceiver ? { 'retry-after': '1' } : {}); response.end();
});
const receiverPort = await listen(receiver), reserved = createServer(), port = await listen(reserved);
await new Promise(r => reserved.close(r));
const origin = `http://127.0.0.1:${port}`;
const env = { ...process.env }; for (const key of Object.keys(env)) if (key.startsWith('PULSE_') || ['NODE_PATH', 'NODE_OPTIONS'].includes(key)) delete env[key];
Object.assign(env, { PULSE_DATA_DIR: directory, PULSE_SECRETS_DIR: join(directory, 'secrets'), PULSE_PORT: String(port), PULSE_PUBLIC_ORIGIN: origin, PULSE_EGRESS_POLICY: 'allow-private', PULSE_ALLOWED_PRIVATE_CIDRS: '127.0.0.1/32' });
function healthy() { if (!child || child.exitCode !== null || child.signalCode !== null) throw new Error('BENCHMARK_PROCESS_EXITED'); const samples = report.phase === 'overload' ? report.overloadSamples : report.samples; if (samples.at(-1)?.ready === false || samples.at(-1)?.deliveriesHealthy === false) throw new Error('BENCHMARK_RUNTIME_UNHEALTHY'); }
async function timedRequest(url, method = 'GET', body, revision) {
    const started = performance.now();
    try {
        const response = await fetch(origin + url, { method, signal: AbortSignal.timeout(12000), headers: { origin, ...(body === undefined ? {} : { 'content-type': 'application/json' }), ...(revision ? { 'if-match': `"${revision}"` } : {}) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
        const text = await response.text(); let value; try { value = JSON.parse(text).data; } catch { /* Safe status-only evidence for non-JSON failures. */ }
        return { ms: performance.now() - started, status: response.status, value };
    } catch { return { ms: performance.now() - started, status: 0 }; }
}
async function start(phase) {
    report.phase = phase; await save(); const before = performance.now();
    child = fork('scripts/performance-server.mjs', [], { env, execArgv: ['--import', pathToFileURL(join(root, 'scripts/performance-probe.mjs')).href], silent: true, windowsHide: true });
    child.stdout.resume(); let startupErrors = ''; child.stderr.on('data', chunk => { startupErrors = (startupErrors + String(chunk)).slice(-8192); }); childExit = new Promise(r => child.once('exit', (code, signal) => { report.measurements[phase + 'ProcessExit'] = { code, signal, errorCodes: [...new Set(startupErrors.match(/\b(?:[A-Z][A-Z0-9_]{3,}|TypeError|RangeError|SyntaxError)\b/g) ?? [])] }; r({ code, signal }); }));
    child.on('message', message => {
        if (message.type !== 'sample') return;
        const samples = report.phase === 'overload' ? report.overloadSamples : report.samples;
        samples.push({ elapsedMs: performance.now() - before, ...message, fixtureSockets: sockets.size });
    });
    const ready = await deadline(Promise.race([new Promise(res => child.on('message', message => { if (message.type === 'ready') res(message); })), childExit.then(() => { throw new Error('BENCHMARK_STARTUP_EXIT'); })]), 600000, 'BENCHMARK_STARTUP_DEADLINE');
    child.send({ type: 'phase', phase });
    return { processMs: performance.now() - before, applicationMs: ready.startupMs, sqliteVersion: ready.sqliteVersion };
}
async function stop(phase) {
    if (!child) return;
    const before = performance.now(); if (child.exitCode === null && child.signalCode === null) child.send('shutdown');
    const stopped = await deadline(childExit, 15000, 'BENCHMARK_SHUTDOWN_DEADLINE').catch(() => null);
    report.measurements[phase + 'Shutdown'] = { ms: performance.now() - before, exitCode: stopped?.code ?? null, deadlineExceeded: stopped === null };
    if (!stopped && child.exitCode === null) child.kill(); child = null;
}
async function runUntil(until) { let checkpoint = Date.now(); while (Date.now() < until) { await wait(Math.min(1000, until - Date.now())); healthy(); if (Date.now() - checkpoint >= 30000) { await save(); checkpoint = Date.now(); } } }
async function browserClients() {
    browser = await chromium.launch({ headless: true });
    for (let i = 0; i < reference.browserClients; i++) {
        const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
        page.on('pageerror', () => report.browser.errors.push('PAGE_ERROR'));
        await page.addInitScript(() => {
            window.__pulseLongTasks = { count: 0, maxMs: 0 }; window.__pulseInteraction = { count: 0, completed: 0, ms: null };
            const record = () => { const count = ++window.__pulseInteraction.count, before = window.performance.now(); window.requestAnimationFrame(() => window.requestAnimationFrame(() => { window.__pulseInteraction = { count, completed: count, ms: window.performance.now() - before }; })); };
            document.addEventListener('click', record, true); document.addEventListener('input', record, true);
            if (window.PerformanceObserver) new window.PerformanceObserver(entries => { for (const entry of entries.getEntries()) { window.__pulseLongTasks.count++; window.__pulseLongTasks.maxMs = Math.max(window.__pulseLongTasks.maxMs, entry.duration); } }).observe({ type: 'longtask', buffered: true });
        });
        await page.goto(origin, { waitUntil: 'domcontentloaded', timeout: 60000 });
        await page.locator(`a[href="/monitors/${ids[0]}"]`).first().waitFor({ timeout: 60000 });
        pages.push(page); report.browser.clients++;
    }
}
async function browserInteractions() {
    await Promise.all(pages.map(async (page, index) => {
        const session = await page.context().newCDPSession(page);
        for (let change = 0; change < 10; change++) {
            healthy(); const detail = change % 2 === 0, before = performance.now(), count = await page.evaluate(() => window.__pulseInteraction.count);
            if (detail) await page.locator(`a[href="/monitors/${ids[0]}"]`).first().click(); else await page.getByRole('link', { name: 'Overview', exact: true }).click();
            await page.waitForFunction(previous => window.__pulseInteraction.completed > previous, count);
            const interactionMs = await page.evaluate(() => window.__pulseInteraction.ms);
            if (detail) await page.locator('svg.history-chart').waitFor({ timeout: 60000 }); else await page.getByRole('heading', { name: 'Monitors', exact: true }).waitFor({ timeout: 60000 });
            report.browser.interactions.push({ client: index, routeChange: change + 1, kind: 'navigation', localInteractionMs: interactionMs, loadedMs: performance.now() - before });
            const heap = await session.send('Runtime.getHeapUsage'); report.browser.heaps.push({ client: index, routeChange: change + 1, page: detail ? 'detail-chart' : 'overview', bytes: heap.usedSize });
        }
        const input = page.getByRole('searchbox'), count = await page.evaluate(() => window.__pulseInteraction.count); await input.fill('Reference');
        await page.waitForFunction(previous => window.__pulseInteraction.completed > previous, count);
        report.browser.interactions.push({ client: index, kind: 'search', localInteractionMs: await page.evaluate(() => window.__pulseInteraction.ms) });
        const tasks = await page.evaluate(() => window.__pulseLongTasks); report.browser.longTasks.push({ client: index, count: tasks.count, ms: tasks.maxMs });
        await session.detach();
    }));
}
async function observeCategory(name, url, started) {
    const times = [], errors = [];
    await Promise.all(Array.from({ length: reference.apiConcurrency }, async (_, worker) => {
        for (let i = worker; i < duration.apiSamples; i += reference.apiConcurrency) {
            await wait(Math.max(0, started + Math.floor(i / 5) * (duration.measurementMs / 4 / Math.ceil(duration.apiSamples / 5)) + worker * 30 - Date.now())); healthy();
            const result = await timedRequest(url); times.push(result.ms); if (result.status !== 200) errors.push(result.status);
        }
    }));
    report.measurements[name] = { ...percentiles(times), errors, concurrency: 5 }; await save();
}
async function mutations(started) {
    const times = [], errors = [], kinds = {};
    await Promise.all(Array.from({ length: 5 }, async (_, worker) => {
        let monitor;
        for (let i = worker, step = 0; i < duration.apiSamples; i += 5, step++) {
            await wait(Math.max(0, started + Math.floor(i / 5) * (duration.measurementMs / Math.ceil(duration.apiSamples / 5)) + worker * 30 + 600 - Date.now())); healthy();
            const kind = ['create', 'patch', 'reserve', 'delete'][step % 4]; let result;
            if (kind === 'create') { result = await timedRequest('/api/v1/monitors', 'POST', { name: 'Mutation fixture ' + worker, url: `http://127.0.0.1:${fixturePort}/fast/mutation`, enabled: false }); monitor = result.value; }
            if (kind === 'patch' && monitor) { result = await timedRequest('/api/v1/monitors/' + monitor.id, 'PATCH', { name: 'Updated mutation fixture ' + worker }, monitor.revision); monitor = result.value; }
            if (kind === 'reserve') result = await timedRequest('/api/v1/monitors/' + ids[worker] + '/checks', 'POST', {});
            if (kind === 'delete' && monitor) { result = await timedRequest('/api/v1/monitors/' + monitor.id + '?confirm=true', 'DELETE', undefined, monitor.revision); monitor = null; }
            if (!result) { errors.push('PREREQUISITE_FAILED'); continue; }
            times.push(result.ms); kinds[kind] = (kinds[kind] ?? 0) + 1; if (result.status < 200 || result.status >= 300) errors.push(result.status);
        }
    }));
    report.measurements.mutations = { ...percentiles(times), errors, kinds, concurrency: 5, method: 'Actual CRUD/reservation acknowledgments, paced beneath the unchanged 60/minute operator mutation limit in the full reference profile.' }; await save();
}
async function requestWorkload(started) {
    const categories = [['monitors', '/api/v1/monitors?limit=50'], ['history', `/api/v1/monitors/${ids[0]}/checks?limit=50`], ['summary', '/api/v1/dashboard'], ['metrics', `/api/v1/monitors/${ids[0]}/metrics?window=30d`]];
    report.conditions.apiMethod = 'Four sequential read categories inside the 30-minute measurement, each with concurrency five and 1,000 requests. An independent concurrency-five mutation category is paced across all 30 minutes below the unchanged 60/minute limit. Ten browsers and normal monitoring/webhooks remain active throughout.';
    for (let index = 0; index < categories.length; index++) { const [name, url] = categories[index], from = started + index * duration.measurementMs / categories.length; await runUntil(from); await observeCategory(name, url, from); }
}
try {
    assert.equal(await size(source + '-wal'), 0, 'SOURCE_FIXTURE_MUST_BE_STOPPED_WITHOUT_NONEMPTY_WAL');
    const sourceHash = await hash(source); await copyFile(source, path); assert.equal(await hash(path), sourceHash, 'CLONE_CONTENT_MISMATCH');
    report.fixture = { sourceSha256: sourceHash, preservedOriginal: true, cloneSha256: sourceHash, bytes: await size(path), reuse: true };
    report.candidate = await candidateDigest();
    report.releaseIdentity = await releaseIdentity();
    report.phase = 'migration-preparation'; await save(); const before = performance.now(), prepared = new Store(path);
    try {
        report.measurements.migrationAndPreflightMs = performance.now() - before;
        const count = Number(prepared.db.prepare('SELECT count(*) n FROM checks').get().n); assert.equal(count, reference.historyRows, 'REFERENCE_ROW_COUNT_MISMATCH'); report.fixture.initialHistoryRows = count;
        report.phase = 'history-preparation'; await save(); const rebaseStarted = performance.now();
        report.fixture.historyTranslation = rebaseReferenceHistory(prepared.db, Date.now());
        report.measurements.historyPreparationMs = performance.now() - rebaseStarted;
        assert.equal(Number(prepared.db.prepare('SELECT count(*) n FROM checks').get().n), count, 'REFERENCE_HISTORY_CHANGED');
        report.fixture.preparedHistoryRows = count;
        ids = prepared.db.prepare('SELECT id FROM monitors ORDER BY id').all().map(row => String(row.id)); assert.equal(ids.length, 100);
        const update = prepared.db.prepare('UPDATE monitors SET name=?,url=?,interval_ms=60000,timeout_ms=10000,enabled=1,next_due_at=? WHERE id=?');
        prepared.db.exec('BEGIN'); for (let i = 0; i < ids.length; i++) update.run('Reference ' + String(i).padStart(3, '0'), `http://127.0.0.1:${fixturePort}/${i < 95 ? 'fast' : 'slow'}/${i}`, Date.now() + (diagnostic ? i * 60 : 60000 + i * 600), ids[i]); prepared.db.exec('COMMIT');
        report.fixture.schemaVersions = prepared.db.prepare('SELECT version FROM schema_migrations ORDER BY version').all().map(row => row.version);
    } finally { prepared.db.close(); }
    await mkdir(env.PULSE_SECRETS_DIR); await writeFile(join(env.PULSE_SECRETS_DIR, 'benchmark.url'), `http://127.0.0.1:${receiverPort}/events`, { mode: 0o600 }); await writeFile(join(env.PULSE_SECRETS_DIR, 'benchmark.key'), receiverKey, { mode: 0o600 });
    report.measurements.startup = await start('warmup'); report.conditions.sqlite = report.measurements.startup.sqliteVersion;
    report.budgets.startup = startupWithinBudget([report.measurements.startup.processMs]);
    const destination = await timedRequest('/api/v1/notification-destinations', 'POST', { name: 'Benchmark receiver', urlSecretRef: 'benchmark', signingSecretRef: 'benchmark' }); report.measurements.destinationCreateStatus = destination.status; assert.equal(destination.status, 201, 'BENCHMARK_DESTINATION_CREATE_FAILED'); destinationId = destination.value.id;
    child.send({ type: 'load', enabled: true, destinationId }); await browserClients();
    const loadStarted = Date.now(); await runUntil(loadStarted + duration.warmupMs);
    reader = new DatabaseSync(path, { readOnly: true }); report.fixture.measurementStartHistory = referenceHistorySnapshot(reader, ids, Date.now()); reader.close(); reader = null;
    report.phase = 'reference-measurement'; child.send({ type: 'phase', phase: report.phase }); const measuredFrom = Date.now(); report.measurements.referenceStartedAt = new Date(measuredFrom).toISOString(); await save();
    await Promise.all([requestWorkload(measuredFrom), mutations(measuredFrom), browserInteractions(), runUntil(measuredFrom + duration.measurementMs)]);
    const measuredTo = Date.now(); report.measurements.referenceDurationMs = measuredTo - measuredFrom;
    reader = new DatabaseSync(path, { readOnly: true });
    report.fixture.measurementEndHistory = referenceHistorySnapshot(reader, ids, measuredTo);
    report.measurements.dispatchLagMs = percentiles(reader.prepare(`SELECT started_at-scheduled_at lag FROM checks WHERE monitor_id IN(${ids.map(() => '?').join(',')}) AND started_at>=? AND started_at<? AND trigger='automatic' AND scheduled_at IS NOT NULL`).all(...ids, measuredFrom, measuredTo).map(row => Number(row.lag)));
    reader.close(); reader = null;
    report.phase = 'soak'; child.send({ type: 'phase', phase: report.phase }); await runUntil(measuredFrom + duration.soakMs); const soakTo = Date.now(); report.measurements.referenceLoadDurationMs = soakTo - loadStarted; report.measurements.referenceObservedDurationMs = soakTo - measuredFrom;
    report.memoryTrend = memoryTrend(report.samples.filter(s => ['reference-measurement', 'soak'].includes(s.phase)));
    for (let index = 0; index < pages.length; index++) { const page = pages[index], session = await page.context().newCDPSession(page), heap = await session.send('Runtime.getHeapUsage'), tasks = await page.evaluate(() => window.__pulseLongTasks); report.browser.heaps.push({ client: index, phase: 'soak-end', bytes: heap.usedSize }); report.browser.longTasks.push({ client: index, phase: 'soak-end', count: tasks.count, ms: tasks.maxMs }); await session.detach(); }
    await browser.close(); browser = null; pages = []; await stop('reference');
    const measured = report.samples.filter(s => s.phase === 'reference-measurement'), steady = report.samples.filter(s => ['reference-measurement', 'soak'].includes(s.phase));
    report.measurements.sqliteOperations = operationEvidence(report.samples, measuredFrom, soakTo).operations;
    const lastProbe = steady.at(-1), allOffered = (lastProbe?.enqueued ?? 0) + (lastProbe?.domainOffered ?? 0); report.measurements.webhookLoad = { controlledOffered: lastProbe?.enqueued ?? 0, domainOffered: lastProbe?.domainOffered ?? 0, offered: allOffered, acknowledged: report.receiver.acknowledged, observedThrough: lastProbe?.observedAt ?? null, firstOfferedAt: lastProbe?.firstOfferedAt ?? null, lastOfferedAt: lastProbe?.lastOfferedAt ?? null, offeredPerSecond: allOffered > 1 ? (allOffered - 1) * 1000 / (lastProbe.lastOfferedAt - lastProbe.firstOfferedAt) : null, maximumOfferedPerClockSecond: lastProbe?.maximumOfferedPerClockSecond ?? null, maximumReceiptsPerClockSecond: Math.max(0, ...Object.values(report.receiver.receivedBySecond)), method: 'Actual reference-load offers and receipts before overload; retries during failing-receiver overload are separate.' };
    report.measurements.transactions = { ...operationEvidence(report.samples, measuredFrom, measuredTo).transactions, method: 'Synchronous Store transaction duration for ordinary finish operations inside the actual SQLite worker, selected by actual completion timestamp in the measurement window; delayed telemetry is retained. Excludes IPC, network and queue delay.' };
    report.measurements.eventLoopP95Ms = measured.at(-1)?.loopP95Ms ?? null; report.measurements.eventLoopP99Ms = measured.at(-1)?.loopP99Ms ?? null;
    report.measurements.peakRssBytes = Math.max(0, ...steady.map(s => s.rss)); report.measurements.peakManualQueued = Math.max(0, ...steady.map(s => s.peakManualQueued ?? s.manualQueued));
    report.measurements.browserInteraction = { ...percentiles(report.browser.interactions.map(s => s.localInteractionMs)), method: 'Browser performance.now from the captured input/click event to two animation frames; actual content/network loading is recorded separately as loadedMs.' };
    for (const name of ['monitors', 'history', 'summary', 'metrics', 'mutations']) { const value = report.measurements[name]; report.budgets[name] = value.count >= reference.apiSamples && value.errors.length === 0 && value.p95 <= ({ monitors: 200, history: 200, summary: 500, metrics: 1000, mutations: 250 })[name]; }
    Object.assign(report.budgets, { dispatch: report.measurements.dispatchLagMs.count > 0 && report.measurements.dispatchLagMs.p95 <= 1000, transactions: report.measurements.transactions.count > 0 && report.measurements.transactions.p95 <= 50, eventLoop: measured.length > 0 && report.measurements.eventLoopP95Ms <= 50 && report.measurements.eventLoopP99Ms <= 200, rss: steady.length > 0 && report.measurements.peakRssBytes <= 300 * 1024 * 1024, memoryTrend: report.memoryTrend.result === 'PASS', readiness: steady.length > 0 && steady.every(s => s.ready && s.deliveriesHealthy), resourceBounds: steady.length > 0 && steady.every(s => s.bounds.checks <= 10 && s.bounds.webhookPool <= 2 && s.bounds.databaseQueue <= 1000 && s.manualQueued <= 100 && s.bounds.sse <= 20 && s.bounds.ssePendingBytes <= 65536), browser: report.browser.clients === 10 && report.browser.errors.length === 0 && report.browser.interactions.length >= 100 && report.measurements.browserInteraction.p95 <= 200 && report.browser.longTasks.every(s => s.ms <= 200) && report.browser.heaps.every(s => s.bytes <= 100 * 1024 * 1024), webhooks: report.receiver.acknowledged > 0 && report.receiver.invalidSignatures === 0 && steady.every(s => s.injectionErrors === 0), shutdown: report.measurements.referenceShutdown.exitCode === 0 && report.measurements.referenceShutdown.ms <= 15000 });
    const assets = (await readdir('apps/web/dist/assets')).filter(name => name.endsWith('.js')); report.measurements.allJavaScriptGzipBytes = (await Promise.all(assets.map(async name => gzipSync(await readFile(join('apps/web/dist/assets', name))).length))).reduce((a, b) => a + b, 0); report.budgets.browserTransfer = report.measurements.allJavaScriptGzipBytes <= 350 * 1024;
    // Overload is measured separately: it never substitutes for the reference profile.
    report.phase = 'overload-preparation'; await save(); const overloaded = new DatabaseSync(path);
    const manualIds = [];
    try {
        overloaded.exec('PRAGMA foreign_keys=ON; BEGIN IMMEDIATE'); overloaded.prepare('UPDATE monitors SET url=?,next_due_at=? WHERE enabled=1').run(`http://127.0.0.1:${fixturePort}/slow/overload`, Date.now());
        const template = overloaded.prepare('SELECT * FROM monitors WHERE id=?').get(ids[0]), columns = Object.keys(template), insert = overloaded.prepare(`INSERT INTO monitors(${columns.join(',')}) VALUES(${columns.map(() => '?').join(',')})`);
        for (let i = 0; i < 120; i++) { const id = randomUUID(), row = { ...template, id, name: 'Manual overload ' + i, next_due_at: Date.now() + 3600000 }; insert.run(...columns.map(column => row[column])); overloaded.prepare("INSERT INTO monitor_status(monitor_id,state,reason,state_changed_at) VALUES(?,'UNKNOWN','INITIAL',?)").run(id, Date.now()); overloaded.prepare('INSERT INTO monitor_activity_windows(id,monitor_id,enabled_at) VALUES(?,?,?)').run(randomUUID(), id, Date.now()); manualIds.push(id); }
        overloaded.exec('COMMIT');
    } finally { overloaded.close(); }
    failedReceiver = true; report.measurements.overloadStartup = await start('overload'); child.send({ type: 'load', enabled: true, destinationId }); const overloadFrom = Date.now();
    report.budgets.startup = startupWithinBudget([report.measurements.startup.processMs, report.measurements.overloadStartup.processMs]);
    const controlId = randomUUID(), responses = new Promise(res => child.on('message', message => { if (message.type === 'control-result' && message.id === controlId) res(message.responses); })); child.send({ type: 'manual-burst', id: controlId, ids: manualIds });
    report.overload = { automaticMonitors: 100, additionalManualDefinitions: 120, manualBurst: await deadline(responses, 30000, 'MANUAL_BURST_DEADLINE'), method: 'Manual queue pressure uses the actual scheduler domain entry point; HTTP rate-limit pressure is measured separately without bypassing its limit.' };
    const httpBurst = []; for (let i = 0; i < 80; i++) httpBurst.push((await timedRequest('/api/v1/monitors/' + ids[i % 100] + '/checks', 'POST', {})).status); report.overload.httpBurstStatuses = httpBurst;
    const controllers = Array.from({ length: 25 }, () => new AbortController());
    report.overload.sseStatuses = await Promise.all(controllers.map(async controller => { try { const response = await fetch(origin + '/api/v1/events', { signal: controller.signal }); return response.status; } catch { return 0; } })); controllers.forEach(controller => controller.abort());
    await runUntil(overloadFrom + duration.overloadMs); report.overload.durationMs = Date.now() - overloadFrom;
    const engine = await timedRequest('/api/v1/engine'); report.overload.engineStatus = engine.status; report.overload.lagDiagnostics = engine.value;
    await stop('overload'); reader = new DatabaseSync(path, { readOnly: true });
    const opportunities = reader.prepare(`SELECT monitor_id,count(*) n FROM checks WHERE monitor_id IN(${ids.map(() => '?').join(',')}) AND started_at>=? AND trigger='automatic' GROUP BY monitor_id`).all(...ids, overloadFrom), duplicate = reader.prepare("SELECT monitor_id,count(*) n FROM checks WHERE lifecycle IN('QUEUED','RUNNING') GROUP BY monitor_id HAVING count(*)>1").all();
    report.overload.automaticOpportunities = ids.map(id => Number(opportunities.find(row => row.monitor_id === id)?.n ?? 0)); report.overload.maximumUnsettledDuplicates = duplicate.length;
    const lastCompleted = ids.map(id => reader.prepare("SELECT monitors.next_due_at,checks.completed_at,checks.scheduled_at FROM monitors JOIN checks ON checks.sequence=(SELECT max(sequence) FROM checks WHERE monitor_id=? AND lifecycle='COMPLETED' AND trigger='automatic') WHERE monitors.id=?").get(id, id)).filter(Boolean);
    report.overload.missedSlotCheckCount = lastCompleted.filter(row => Number(row.completed_at) - Number(row.scheduled_at) >= 60000).length;
    report.overload.nextDueAfterLastCompletion = lastCompleted.length === 100 && lastCompleted.every(row => Number(row.next_due_at) > Number(row.completed_at));
    if (beta) report.betaIntegrity = { integrity: reader.prepare('PRAGMA integrity_check').all().map(row => row.integrity_check).join(';'), foreignKeyViolations: reader.prepare('PRAGMA foreign_key_check').all().length };
    reader.close(); reader = null;
    report.budgets.overload = report.overload.durationMs >= reference.overloadMs && report.overload.manualBurst.some(s => s.status === 429 && s.code === 'QUEUE_SATURATED') && httpBurst.includes(429) && report.overload.sseStatuses.includes(429) && duplicate.length === 0 && report.overload.automaticOpportunities.every(n => n > 0) && report.overload.missedSlotCheckCount > 0 && report.overload.nextDueAfterLastCompletion && report.overload.engineStatus === 200 && report.overload.lagDiagnostics.oldestDueLagMs > 0 && report.overloadSamples.length > 0 && report.overloadSamples.every(s => s.bounds.checks <= 10 && s.bounds.webhookPool <= 2 && s.bounds.databaseQueue <= 1000 && s.manualQueued <= 100 && s.bounds.sse <= 20 && s.ready && s.deliveriesHealthy) && report.receiver.failed > 0;
    report.storage = { databaseBytes: await size(path), walBytes: await size(path + '-wal'), backupBytes: 0, backup: 'NOT TESTED in load run; separate release backup verification remains required.' };
    assert.equal(await hash(source), sourceHash, 'ORIGINAL_FIXTURE_CHANGED'); assert.deepEqual(await candidateDigest(), report.candidate, 'COMPILED_CANDIDATE_CHANGED_DURING_RUN');
    assert.ok(sameReleaseIdentity(await releaseIdentity(), report.releaseIdentity), 'RELEASE_IDENTITY_CHANGED_DURING_RUN');
    const complete = !diagnostic && report.measurements.referenceDurationMs >= reference.measurementMs && report.measurements.referenceObservedDurationMs >= reference.soakMs && report.overload.durationMs >= reference.overloadMs;
    report.result = classifyRun(report.budgets, complete, report.conditions.referenceHostVerified);
    if (beta) report.betaAcceptance = evaluateBetaPerformance(report);
} catch (error) { report.result = 'FAIL'; report.failure = /^[A-Z_]+$/.test(error.message) ? error.message : 'BENCHMARK_INTERRUPTED_OR_ASSERTION_FAILED'; report.interruptedPhase = report.phase; }
finally {
    await browser?.close().catch(() => {}); reader?.close(); await stop('interrupted'); fixture.closeAllConnections(); receiver.closeAllConnections(); await Promise.all([new Promise(r => fixture.close(r)), new Promise(r => receiver.close(r))]);
    report.completedAt = new Date().toISOString(); report.phase = 'finished'; await save(); console.log(JSON.stringify({ result: report.result, betaResult: report.betaAcceptance?.result, report: output, completedReferenceLoadMs: report.measurements.referenceLoadDurationMs ?? 0 })); if ((beta ? report.betaAcceptance?.result : report.result) !== 'PASS') process.exitCode = 1;
}
