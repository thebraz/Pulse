import { readFile, readdir } from 'node:fs/promises';
import { join, relative } from 'node:path';
import { createHash } from 'node:crypto';

// Exclude reports/documentation so recording evidence cannot change the code it certifies.
const sourcePaths = ['apps/server/src', 'apps/web/src', 'packages/contracts/src', 'bin', 'apps/server/package.json', 'apps/web/package.json', 'packages/contracts/package.json', 'package.json', 'package-lock.json', 'tsconfig.json', 'apps/server/tsconfig.json', 'apps/web/tsconfig.json', 'apps/web/vite.config.ts', 'apps/web/index.html', 'packages/contracts/tsconfig.json'];
const compiledPaths = ['apps/server/dist', 'apps/web/dist', 'packages/contracts/dist'];
const validationPaths = ['tests', 'scripts', 'vitest.config.ts', 'playwright.config.ts', 'eslint.config.mjs'];
export const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
export async function treeEntries(root, paths, exclude = () => false) {
    const entries = [];
    async function visit(path) {
        let children;
        try { children = await readdir(path, { withFileTypes: true }); }
        catch (error) {
            if (error.code !== 'ENOTDIR') throw error;
            const name = relative(root, path).replaceAll('\\', '/');
            if (!exclude(name)) entries.push({ path: name, sha256: sha256(await readFile(path)) });
            return;
        }
        for (const child of children) {
            if (child.isSymbolicLink()) throw new Error('RELEASE_IDENTITY_SYMLINK');
            await visit(join(path, child.name));
        }
    }
    for (const path of paths) await visit(join(root, path));
    return entries.sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
}
export async function releaseIdentity(root = process.cwd()) {
    const [source, compiled, validation] = await Promise.all([
        treeEntries(root, sourcePaths),
        treeEntries(root, compiledPaths, path => /\.(?:map|d\.ts)$/.test(path)),
        treeEntries(root, validationPaths)
    ]);
    return { runtimeSourceDigest: sha256(JSON.stringify(source)), compiledDigest: sha256(JSON.stringify(compiled)), testSuiteDigest: sha256(JSON.stringify(validation)) };
}
export function sameReleaseIdentity(actual, expected, includeTests = true) {
    return !!actual && !!expected && ['runtimeSourceDigest', 'compiledDigest', ...(includeTests ? ['testSuiteDigest'] : [])].every(key => /^[a-f0-9]{64}$/.test(expected[key] ?? '') && actual[key] === expected[key]);
}
