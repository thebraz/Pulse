import { readFile, writeFile, access } from 'node:fs/promises';
import { dirname, resolve, join } from 'node:path';
import { files, root } from './package.mjs';
import { releaseIdentity, sameReleaseIdentity, sha256 } from './release-identity.mjs';
import { evidenceMatches, suitePassed, browserPassed, packagePassed, fullPerformancePassed, sourcePassed, storagePassed, nginxPassed } from './release-gates.mjs';
import { startupBudgetMs } from './performance-helpers.mjs';
const read = async path => JSON.parse(await readFile(join(root, path), 'utf8'));
const optional = async path => { try { return await read(path); } catch (error) { if (error.code === 'ENOENT') return null; throw error; } };
const paths = {
    tests: 'docs/evidence/stage-4-tests.json', browser: 'docs/evidence/stage-4-browser.json', checks: 'docs/evidence/stage-4-checks.json',
    linuxTests: 'docs/evidence/stage-4-linux-tests.json', linuxBrowser: 'docs/evidence/stage-4-linux-browser.json', linuxChecks: 'docs/evidence/stage-4-linux-checks.json',
    installed: 'docs/evidence/stage-4-package.json', linuxInstalled: 'docs/evidence/stage-4-linux-package-final.json', hygiene: 'docs/evidence/stage-4-hygiene.json',
    source: 'docs/evidence/stage-4-source-install.json', windowsPerformance: 'docs/evidence/stage-4-performance-windows.json', linuxPerformance: 'docs/evidence/stage-4-performance-linux.json',
    proxy: 'docs/evidence/stage-4-nginx-proxy.json', storageFull: 'docs/evidence/stage-4-storage-full.json', storageReadonly: 'docs/evidence/stage-4-storage-readonly.json', storageIoerr: 'docs/evidence/stage-4-storage-ioerr.json',
    security: 'docs/evidence/stage-4-final-security.json', dependencies: 'docs/evidence/stage-4-dependencies.json', productionAudit: 'docs/evidence/stage-4-production-audit.json', licenses: 'docs/evidence/stage-4-licenses.json', external: 'docs/evidence/stage-4-external-gates.json'
};
const reports = Object.fromEntries(await Promise.all(Object.entries(paths).map(async ([key, path]) => [key, await optional(path)])));
const manifest = await read('release/package-manifest.json'), identity = await releaseIdentity(root);
const archiveBytes = await readFile(join(root, 'release', `${manifest.name}-${manifest.version}.tgz`)), digest = sha256(archiveBytes), lockSha256 = sha256(await readFile(join(root, 'package-lock.json')));
const browserBinding = async (checks, browser, path) => evidenceMatches(checks, identity) && checks.sourceUnchangedDuringRun === true && browserPassed(browser) && checks.browserEvidenceSha256 === sha256(await readFile(join(root, path)).catch(() => Buffer.alloc(0)));
const commandsPassed = checks => evidenceMatches(checks, identity) && checks.result === 'PASS' && checks.sourceUnchangedDuringRun === true && ['npm run typecheck', 'npm run lint', 'npm run test:e2e'].every(command => checks.commands?.some(item => item.command === command && item.exitCode === 0)) && checks.commands?.some(item => item.command.startsWith('npm run test -- ') && item.exitCode === 0);
const external = name => reports.external?.gates?.find(gate => gate.name === name)?.result === 'PASS';
const gates = {
    archiveIdentity: digest === manifest.sha256 && archiveBytes.length === manifest.bytes && sameReleaseIdentity(manifest.releaseIdentity, identity),
    windowsRegressions: suitePassed(reports.tests, identity), linuxRegressions: suitePassed(reports.linuxTests, identity),
    windowsBrowser: await browserBinding(reports.checks, reports.browser, paths.browser), linuxBrowser: await browserBinding(reports.linuxChecks, reports.linuxBrowser, paths.linuxBrowser),
    windowsTypeAndLint: commandsPassed(reports.checks), linuxTypeAndLint: commandsPassed(reports.linuxChecks),
    windowsInstalledPackage: packagePassed(reports.installed, identity, digest), linuxInstalledPackage: packagePassed(reports.linuxInstalled, identity, digest),
    cleanSource: sourcePassed(reports.source, identity),
    hygiene: evidenceMatches(reports.hygiene, identity) && reports.hygiene.candidateSha256 === digest && reports.hygiene.result === 'PASS' && reports.hygiene.candidateUnchangedDuringRun === true && reports.hygiene.scenarios?.length === 4,
    windowsFullReferenceAndSoak: fullPerformancePassed(reports.windowsPerformance, identity, 'win32'), linuxFullReferenceAndSoak: fullPerformancePassed(reports.linuxPerformance, identity, 'linux'),
    controlledTlsProxy: nginxPassed(reports.proxy, identity),
    storageFull: storagePassed(reports.storageFull, identity, 'full'), storageReadonly: storagePassed(reports.storageReadonly, identity, 'readonly'), storageIoerr: storagePassed(reports.storageIoerr, identity, 'ioerr'),
    finalIndependentSecurity: evidenceMatches(reports.security, identity) && reports.security.result === 'PASS' && reports.security.unresolvedReleaseBlockingFindings === 0 && reports.security.reviewedFiles?.length >= 10,
    dependencyAdvisories: reports.dependencies?.result === 'PASS' && reports.dependencies.lockSha256 === lockSha256 && reports.dependencies.advisories?.total === 0,
    productionAdvisories: reports.productionAudit?.result === 'PASS' && reports.productionAudit.lockSha256 === lockSha256 && reports.productionAudit.knownVulnerabilities?.total === 0,
    dependencyLicenses: reports.licenses?.result === 'PASS' && reports.licenses.lockSha256 === lockSha256 && reports.licenses.noticesSha256 === sha256(await readFile(join(root, 'THIRD-PARTY-NOTICES.md'))) && reports.licenses.packages?.length > 0,
    npmAccount: external('npmAccount'), githubRepositoryAccess: external('githubRepositoryAccess'), securityReportingChannel: external('securityReportingChannel'), productionProxyScope: external('productionProxy')
};
const publicMarkdown = [...await files(join(root, 'docs')), ...['README.md', 'CONTRIBUTING.md', 'SECURITY.md', 'CHANGELOG.md'].map(path => join(root, path))].filter(path => path.endsWith('.md'));
let links = 0;
for (const path of publicMarkdown) for (const match of (await readFile(path, 'utf8')).matchAll(/!?\[[^\]]*\]\(([^)]+)\)/g)) {
    const target = match[1].split('#')[0];
    if (!target || /^(?:https?:|mailto:)/.test(target)) continue;
    await access(resolve(dirname(path), decodeURIComponent(target))); links++;
}
const report = {
    recordedAt: new Date().toISOString(), version: manifest.version,
    candidate: { name: manifest.name, sha256: digest, bytes: archiveBytes.length, files: manifest.files.length, ...identity },
    counts: { vitest: reports.tests?.passed ?? 0, browser: reports.browser?.stats?.expected ?? 0, cleanSourceBrowser: reports.source?.browser?.passed ?? 0, package: reports.installed?.passed ?? 0, hygiene: reports.hygiene?.scenarios?.length ?? 0, linux: { vitest: reports.linuxTests?.passed ?? 0, browser: reports.linuxBrowser?.stats?.expected ?? 0, package: reports.linuxInstalled?.passed ?? 0 } },
    documentation: { relativeLinks: links, result: 'PASS' }, startup: { budgetMs: startupBudgetMs, windows: reports.windowsPerformance?.measurements?.startup, windowsRestart: reports.windowsPerformance?.measurements?.overloadStartup, linux: reports.linuxPerformance?.measurements?.startup, linuxRestart: reports.linuxPerformance?.measurements?.overloadStartup },
    gates, result: Object.values(gates).every(Boolean) ? 'PASS' : 'BLOCKED',
    evidence: Object.fromEntries(Object.entries(paths).map(([key, path]) => [key, { path, recordedAt: reports[key]?.completedAt ?? reports[key]?.recordedAt ?? null, identityMatches: evidenceMatches(reports[key], identity) }])),
    publication: 'This verifier does not publish. Publication requires explicit authorization, fresh target-account checks and the exact tested archive digest.'
};
await writeFile(join(root, 'docs/evidence/stage-4-verification.json'), JSON.stringify(report, null, 2) + '\n');
console.log(JSON.stringify(report)); if (report.result !== 'PASS') process.exitCode = 1;
