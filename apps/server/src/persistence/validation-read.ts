import { closeSync, fstatSync, openSync, readSync } from 'node:fs';
import { AppError } from '../application/errors.js';

// A large mapped prefix can still fault pages in random B-tree order, while the
// unmapped tail uses synchronous page reads. Prime the OS file cache sequentially
// before validation; this never substitutes for SQLite's integrity/FK checks.
export function preloadValidationPages(path: string, mappedBytes: number): void {
    let fd: number | undefined;
    try {
        fd = openSync(path, 'r');
        const initial = fstatSync(fd);
        if (!initial.isFile() || !Number.isSafeInteger(initial.size) || initial.size < 0 || !Number.isSafeInteger(mappedBytes) || mappedBytes < 0)
            throw new Error();
        let buffer: Buffer | undefined;
        const read = (descriptor: number, size: number) => {
            for (let position = 0; position < size;) {
                buffer ??= Buffer.allocUnsafe(1024 * 1024);
                const bytes = readSync(descriptor, buffer, 0, Math.min(buffer.length, size - position), position);
                if (bytes === 0)
                    throw new Error();
                position += bytes;
            }
            if (fstatSync(descriptor).size !== size)
                throw new Error();
        };
        if (initial.size > mappedBytes)
            read(fd, initial.size);
        // A crash can leave committed pages in WAL; prime those as well. The
        // exclusively owned SQLite connection remains the authoritative reader.
        let wal: number | undefined;
        try {
            try {
                wal = openSync(path + '-wal', 'r');
            } catch (error) {
                if ((error as NodeJS.ErrnoException).code !== 'ENOENT')
                    throw error;
            }
            if (wal !== undefined) {
                const file = fstatSync(wal);
                if (!file.isFile() || !Number.isSafeInteger(file.size) || file.size < 0)
                    throw new Error();
                read(wal, file.size);
            }
        } finally {
            if (wal !== undefined)
                closeSync(wal);
        }
    } catch {
        throw new AppError('DATABASE_UNAVAILABLE', 503);
    } finally {
        if (fd !== undefined)
            closeSync(fd);
    }
}
