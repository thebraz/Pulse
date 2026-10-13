import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { sha256 } from './release-identity.mjs';
const npm = process.env.npm_execpath ?? process.argv[2];
assert.ok(npm, 'NPM_CLI_PATH_REQUIRED');
const lock = await readFile('package-lock.json'), lockSha256 = sha256(lock);
for (const production of [false, true]) {
    const args = ['audit', ...(production ? ['--omit=dev'] : []), '--json'];
    const run = spawnSync(process.execPath, [npm, ...args], { encoding: 'utf8', windowsHide: true, timeout: 120000, maxBuffer: 4 * 1024 * 1024 });
    let audit;
    try { audit = JSON.parse(run.stdout); } catch { audit = {}; }
    const vulnerabilities = audit.metadata?.vulnerabilities ?? null;
    const report = { recordedAt: new Date().toISOString(), command: 'npm ' + args.join(' '), platform: process.platform, node: process.version, lockSha256, result: run.status === 0 && vulnerabilities?.total === 0 ? 'PASS' : 'FAIL', exitCode: run.status, scope: 'Actual npm registry advisory query for the immutable workspace lockfile; known-advisory checks cannot prove absence of vulnerabilities.' };
    if (production) Object.assign(report, { knownVulnerabilities: vulnerabilities, productionDependencies: audit.metadata?.dependencies?.prod ?? null });
    else Object.assign(report, { advisories: vulnerabilities, dependencyCounts: audit.metadata?.dependencies ?? null });
    assert.equal(sha256(await readFile('package-lock.json')), lockSha256, 'AUDIT_LOCKFILE_CHANGED');
    await writeFile(`docs/evidence/${production ? 'stage-4-production-audit' : 'stage-4-dependencies'}.json`, JSON.stringify(report, null, 2) + '\n');
    console.log(JSON.stringify({ command: report.command, result: report.result, advisories: vulnerabilities?.total ?? null }));
    if (report.result !== 'PASS') process.exitCode = 1;
}
