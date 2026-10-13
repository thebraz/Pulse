import { afterEach, describe, expect, it, vi } from 'vitest';
import { writeFile, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import * as fs from 'node:fs';
import { preloadValidationPages } from '../apps/server/src/persistence/validation-read.js';
import { temp, dispose } from './helpers.js';

vi.mock('node:fs', async importOriginal => {
    const actual = await importOriginal<typeof import('node:fs')>();
    return { ...actual, readSync: vi.fn(actual.readSync), openSync: vi.fn(actual.openSync), closeSync: vi.fn(actual.closeSync) };
});
afterEach(() => vi.clearAllMocks());

describe('bounded validation pre-reading', () => {
    it('reads the complete large file and committed WAL with at most one MiB per read without changing bytes', async () => {
        const dir = await temp(), path = join(dir, 'pulse.sqlite');
        const database = Buffer.alloc(2 * 1024 * 1024 + 17, 0x5a), wal = Buffer.alloc(1024 * 1024 + 9, 0xa5);
        try {
            await writeFile(path, database);
            await writeFile(path + '-wal', wal);
            preloadValidationPages(path, 1024 * 1024);
            const reads: readonly (readonly unknown[])[] = vi.mocked(fs.readSync).mock.calls;
            expect(reads.length).toBeGreaterThan(2);
            expect(reads.every(call => typeof call[3] === 'number' && call[3] <= 1024 * 1024)).toBe(true);
            expect(new Set(reads.map(call => call[1])).size).toBe(1);
            expect(vi.mocked(fs.readSync).mock.results.reduce((n, result) => n + Number(result.value), 0)).toBe(database.length + wal.length);
            expect((await readFile(path)).equals(database)).toBe(true);
            expect((await readFile(path + '-wal')).equals(wal)).toBe(true);
            expect(vi.mocked(fs.closeSync).mock.calls.length).toBe(2);
        } finally {
            await dispose(dir);
        }
    });
    it('uses the effective mapping limit and accepts a missing WAL', async () => {
        const dir = await temp(), path = join(dir, 'pulse.sqlite');
        try {
            await writeFile(path, 'a small database');
            preloadValidationPages(path, 1024);
            expect(fs.readSync).not.toHaveBeenCalled();
            preloadValidationPages(path, 0);
            expect(fs.readSync).toHaveBeenCalled();
        } finally {
            await dispose(dir);
        }
    });
    it('pre-reads an existing WAL even when the main database fits in its mapping', async () => {
        const dir = await temp(), path = join(dir, 'pulse.sqlite');
        const wal = Buffer.alloc(1024 * 1024 + 3, 0x5a);
        try {
            await writeFile(path, 'small main file');
            await writeFile(path + '-wal', wal);
            preloadValidationPages(path, 2147418112);
            expect(vi.mocked(fs.readSync).mock.results.reduce((n, result) => n + Number(result.value), 0)).toBe(wal.length);
            expect((await readFile(path + '-wal')).equals(wal)).toBe(true);
            expect(fs.closeSync).toHaveBeenCalledTimes(2);
        } finally {
            await dispose(dir);
        }
    });
    it('rejects truncation before SQLite validation and closes the descriptor', async () => {
        const dir = await temp(), path = join(dir, 'pulse.sqlite');
        try {
            await writeFile(path, 'committed pages');
            vi.mocked(fs.readSync).mockReturnValueOnce(0);
            expect(() => preloadValidationPages(path, 0)).toThrow('DATABASE_UNAVAILABLE');
            expect(fs.closeSync).toHaveBeenCalledTimes(1);
        } finally {
            await dispose(dir);
        }
    });
    it('fails closed for read or WAL access errors without exposing the underlying message', async () => {
        const dir = await temp(), path = join(dir, 'pulse.sqlite');
        try {
            await writeFile(path, 'committed pages');
            vi.mocked(fs.readSync).mockImplementationOnce(() => { throw new Error('private path and secret'); });
            expect(() => preloadValidationPages(path, 0)).toThrow(/^DATABASE_UNAVAILABLE$/);
            // Use a real descriptor for the database; only WAL access fails.
            const actual = await vi.importActual<typeof import('node:fs')>('node:fs');
            vi.mocked(fs.openSync).mockReset().mockImplementationOnce(actual.openSync).mockImplementationOnce(() => { throw Object.assign(new Error('private WAL'), { code: 'EACCES' }); });
            expect(() => preloadValidationPages(path, 0)).toThrow(/^DATABASE_UNAVAILABLE$/);
            vi.mocked(fs.openSync).mockImplementation(actual.openSync);
        } finally {
            await dispose(dir);
        }
    });
});
