import { cp, mkdir, mkdtemp, readFile, readdir, writeFile } from 'node:fs/promises';
import { join, relative, dirname, resolve, posix } from 'node:path';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { releaseIdentity } from './release-identity.mjs';

export const root = fileURLToPath(new URL('../', import.meta.url));
export async function files(dir) {
    return (await readdir(dir, { withFileTypes: true })).flatMap(entry => entry.isDirectory() ? [] : [join(dir, entry.name)]).concat(...await Promise.all((await readdir(dir, { withFileTypes: true })).filter(e => e.isDirectory()).map(e => files(join(dir, e.name)))));
}
export async function assemble(sourceRoot = root, output = join(root, 'release')) {
    await mkdir(output, { recursive: true });
    const stage = await mkdtemp(join(output, 'candidate-'));
    const workspace = JSON.parse(await readFile(join(sourceRoot, 'package.json'), 'utf8'));
    const server = JSON.parse(await readFile(join(sourceRoot, 'apps/server/package.json'), 'utf8'));
    const { ['@pulse/contracts']: internal, ...dependencies } = server.dependencies;
    if (!internal) throw new Error('CONTRACT_DEPENDENCY_MISSING');
    const manifest = {
        name: 'pulse-http-monitor', version: workspace.version, description: 'Self-hosted HTTP monitoring with incidents, qualified history and webhook alerts.',
        type: 'module', license: 'MIT', author: 'braz', engines: workspace.engines,
        bin: { pulse: 'bin/pulse.mjs' }, files: ['bin/', 'apps/server/dist/', 'apps/web/dist/', 'packages/contracts/dist/', 'docs/', 'examples/', 'THIRD-PARTY-NOTICES.md', 'CHANGELOG.md', 'CONTRIBUTING.md', 'SECURITY.md'],
        keywords: ['monitoring', 'http', 'uptime', 'sqlite', 'self-hosted'], dependencies,
        scripts: { start: 'node bin/pulse.mjs start' }
    };
    await writeFile(join(stage, 'package.json'), JSON.stringify(manifest, null, 2) + '\n');
    const lock = JSON.parse(await readFile(join(sourceRoot, 'package-lock.json'), 'utf8'));
    const packages = { '': { name: manifest.name, version: manifest.version, license: manifest.license, dependencies, engines: manifest.engines } };
    function collect(name, parent = '') {
        let location = parent, key;
        for (;;) {
            key = (location ? location + '/' : '') + 'node_modules/' + name;
            if (lock.packages[key]) break;
            if (!location) throw new Error('RUNTIME_LOCK_ENTRY_MISSING');
            const next = posix.dirname(location);
            location = next === '.' ? '' : next;
        }
        if (packages[key]) return;
        const entry = { ...lock.packages[key] };
        delete entry.dev;
        delete entry.devOptional;
        if (!entry.integrity || !entry.resolved?.startsWith('https://registry.npmjs.org/')) throw new Error('UNVERIFIED_RUNTIME_DEPENDENCY');
        packages[key] = entry;
        for (const dependency of Object.keys({ ...entry.dependencies, ...entry.optionalDependencies })) collect(dependency, key);
    }
    for (const name of Object.keys(dependencies)) collect(name);
    await writeFile(join(stage, 'npm-shrinkwrap.json'), JSON.stringify({ name: manifest.name, version: manifest.version, lockfileVersion: 3, requires: true, packages }, null, 2) + '\n');
    for (const path of ['bin', 'apps/server/dist', 'apps/web/dist', 'packages/contracts/dist', 'docs/guides', 'docs/images', 'examples', 'README.md', 'LICENSE', 'THIRD-PARTY-NOTICES.md', 'CHANGELOG.md', 'CONTRIBUTING.md', 'SECURITY.md']) {
        await mkdir(dirname(join(stage, path)), { recursive: true });
        await cp(join(sourceRoot, path), join(stage, path), { recursive: true, filter: source => !source.endsWith('.map') && !source.endsWith('.d.ts') });
    }
    // Resolve internal workspace imports inside the archive without unpublished registry packages.
    for (const path of await files(stage)) {
        const content = await readFile(path);
        if (/-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----|(?:ghp_[A-Za-z0-9]{36}|npm_[A-Za-z0-9]{36})/.test(content.toString('utf8'))) throw new Error('CREDENTIAL_PATTERN_IN_RUNTIME');
        if (!path.endsWith('.js')) continue;
        let specifier = relative(dirname(path), join(stage, 'packages/contracts/dist/index.js')).replaceAll('\\', '/');
        if (!specifier.startsWith('.')) specifier = './' + specifier;
        const source = await readFile(path, 'utf8');
        await writeFile(path, source.replaceAll("'@pulse/contracts'", JSON.stringify(specifier)).replaceAll(/\n\/\/# sourceMappingURL=.*$/gm, ''));
    }
    const npm = process.env.npm_execpath;
    if (!npm) throw new Error('USE_NPM_RUN_PACKAGE');
    const result = spawnSync(process.execPath, [npm, 'pack', '--json', '--ignore-scripts', '--pack-destination', output], { cwd: stage, encoding: 'utf8', windowsHide: true, timeout: 120000 });
    if (result.status !== 0) throw new Error('NPM_PACK_FAILED');
    const packed = JSON.parse(result.stdout)[0], tarball = join(output, packed.filename);
    const forbidden = /(^|\/)(?:AGENTS\.md|\.private|\.env(?:\..*)?|node_modules|data|secrets|backups|logs|test-results|playwright-report)(?:\/|$)|\.(?:sqlite(?:-(?:wal|shm))?|pem|log|map)$/i;
    if (packed.files.some(file => forbidden.test(file.path))) throw new Error('ARCHIVE_EXCLUSION_FAILED');
    const report = { recordedAt: new Date().toISOString(), name: manifest.name, version: manifest.version, sha256: createHash('sha256').update(await readFile(tarball)).digest('hex'), bytes: packed.size, files: packed.files.map(f => f.path), releaseIdentity: await releaseIdentity(root), accountOwnership: 'NOT VERIFIED; npm authentication is required before publication.' };
    await writeFile(join(output, 'package-manifest.json'), JSON.stringify(report, null, 2) + '\n');
    return { tarball, stage, report };
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
    const { report } = await assemble();
    console.log(JSON.stringify({ ...report, files: report.files.length }));
}
