import { open, realpath } from 'node:fs/promises';
import { join, relative, isAbsolute } from 'node:path';
import { isIP } from 'node:net';
import { aliasSchema } from '@pulse/contracts';
import { windowsAclReadable, type Config } from '../config/config.js';
import { AppError } from '../application/errors.js';
import { parseTarget, addressAllowed } from '../monitoring/policy.js';
export async function provisioned(config: Config, alias: string, extension: 'url' | 'key') {
    try {
        aliasSchema.parse(alias);
        const root = await realpath(config.secretsDir), path = await realpath(join(root, alias + '.' + extension)), rel = relative(root, path);
        if (!rel || rel.startsWith('..') || isAbsolute(rel))
            throw new Error();
        const file = await open(path, 'r');
        try {
            const stat = await file.stat();
            if (!stat.isFile() || stat.size > 4096 || (process.platform !== 'win32' && (stat.mode & 0o077) !== 0))
                throw new Error();
            if (config.exposure === 'remote' && process.platform === 'win32' && await windowsAclReadable(path) !== false)
                throw new Error();
            const buffer = Buffer.alloc(4097), { bytesRead } = await file.read(buffer, 0, 4097, 0);
            if (bytesRead > 4096)
                throw new Error();
            const value = buffer.subarray(0, bytesRead).toString('utf8').trim();
            if (extension === 'key') {
                if (!/^[A-Za-z0-9_-]{43,512}$/.test(value) || Buffer.from(value, 'base64url').length < 32)
                    throw new Error();
            }
            else {
                const url = parseTarget(value, config.egress, true), host = url.hostname.replace(/^\[|\]$/g, '');
                if (url.protocol !== 'https:' && (!isIP(host) || !addressAllowed(host, Number(url.port || 80), config.egress)))
                    throw new Error();
            }
            return value;
        }
        finally {
            await file.close();
        }
    }
    catch {
        throw new AppError('DESTINATION_SECRET_INVALID', 422);
    }
}
