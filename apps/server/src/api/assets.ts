import { readFile, realpath, stat } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { relative, isAbsolute, resolve, extname } from 'node:path';
import type { FastifyInstance } from 'fastify';
import { AppError } from '../application/errors.js';
export function installAssets(app: FastifyInstance) {
    const root = fileURLToPath(new URL('../../../web/dist/', import.meta.url));
    app.get('/*', async (req, reply) => {
        const path = req.url.split('?')[0]!;
        if (path.startsWith('/api/') || path.startsWith('/health/'))
            throw new AppError('NOT_FOUND', 404);
        let target: string;
        try {
            const isAsset = path.startsWith('/assets/');
            if (!isAsset && extname(path))
                throw new Error();
            target = await realpath(isAsset ? resolve(root, '.' + decodeURIComponent(path)) : resolve(root, 'index.html'));
            const rel = relative(await realpath(root), target);
            if (!rel || rel.startsWith('..') || isAbsolute(rel) || (await stat(target)).size > 4 * 1024 * 1024)
                throw new Error();
        }
        catch {
            throw new AppError('NOT_FOUND', 404);
        }
        const type = ({
            '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml'
        } as Record<string, string>)[extname(target)];
        if (!type)
            throw new AppError('NOT_FOUND', 404);
        return reply.type(type).send(await readFile(target));
    });
}
