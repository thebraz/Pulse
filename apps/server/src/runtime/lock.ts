import { mkdir, realpath } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { createServer, type Server } from 'node:net';
import { AppError } from '../application/errors.js';
export async function acquireLock(directory: string): Promise<{
    directory: string;
    release: () => Promise<void>;
}> {
    await mkdir(directory, {
        recursive: true, mode: 0o700
    });
    const canonical = await realpath(directory);
    const key = process.platform === 'win32' ? canonical.toLowerCase() : canonical;
    const port = 40000 + createHash('sha256').update(key).digest().readUInt32BE(0) % 20000;
    const server: Server = createServer(socket => socket.destroy());
    await new Promise<void>((resolve, reject) => {
        server.once('error', () => reject(new AppError('DATA_DIRECTORY_LOCKED', 503)));
        server.listen({
            host: '127.0.0.1', port, exclusive: true
        }, () => resolve());
    });
    return {
        directory: canonical, release: () => new Promise<void>((resolve, reject) => server.close(e => e ? reject(new AppError('LOCK_RELEASE_FAILED', 500)) : resolve()))
    };
}
