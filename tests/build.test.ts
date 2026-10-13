import { it, expect } from 'vitest';
import { readFile, unlink, writeFile } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
it('cached builds restore missing worker and contract artifacts with identical compiled contents', async () => {
    const files = ['apps/server/dist/persistence/worker.js', 'packages/contracts/dist/index.d.ts', 'apps/web/dist/index.html'];
    const originals = await Promise.all(files.map(file => readFile(file)));
    try {
        for (const file of files)
            await unlink(file);
        await promisify(execFile)(process.execPath, ['scripts/build.mjs'], {
            windowsHide: true, timeout: 90000, maxBuffer: 1024 * 1024
        });
        for (const [i, file] of files.entries())
            expect(await readFile(file)).toEqual(originals[i]);
    }
    finally {
        for (const [i, file] of files.entries())
            await writeFile(file, originals[i]!);
    }
}, 120000);
