import { it, expect } from 'vitest';
import { createServer } from 'node:https';
import { readFile } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { createExecutor } from '../apps/server/src/monitoring/http.js';
import { input, listen, target } from './helpers.js';
it('pinned TLS socket preserves SNI and normal hostname verification with a fixture-only trust root', async () => {
    const key = await readFile(new URL('./fixtures/localhost-key.pem', import.meta.url)), certPath = fileURLToPath(new URL('./fixtures/localhost-cert.pem', import.meta.url)), cert = await readFile(certPath);
    let sni: string | undefined, host: string | undefined;
    const server = createServer({
        key, cert
    }, (req, res) => {
        host = req.headers.host;
        sni = (req.socket as unknown as {
            servername: string;
        }).servername;
        res.end('ok');
    }), port = await listen(server);
    try {
        const { stdout } = await promisify(execFile)(process.execPath, [fileURLToPath(new URL('./fixtures/tls-client.mjs', import.meta.url)), String(port)], {
            env: {
                ...process.env, NODE_EXTRA_CA_CERTS: certPath
            }, windowsHide: true, timeout: 10000
        });
        expect(JSON.parse(stdout)).toMatchObject({
            outcome: 'SUCCESS', httpStatus: 200
        });
        expect(sni).toBe('fixture.example');
        expect(host).toBe(`fixture.example:${port}`);
    }
    finally {
        server.closeAllConnections();
        await new Promise<void>(r => server.close(() => r()));
    }
});
it('redirect hops share one absolute timeout and the fourth hop is not contacted', async () => {
    const timers: ReturnType<typeof setTimeout>[] = [];
    let contacts = 0;
    const s = await target((req, res) => {
        contacts++;
        if (req.url?.startsWith('/delay')) {
            timers.push(setTimeout(() => {
                res.writeHead(302, {
                    location: '/delay-next'
                });
                res.end();
            }, 600));
        }
        else {
            const hop = Number(req.url?.slice(1) ?? 0);
            res.writeHead(302, {
                location: `/${hop + 1}`
            });
            res.end();
        }
    }), run = createExecutor({
        mode: 'allow-private', cidrs: ['127.0.0.1/32']
    });
    try {
        const timed = await run({
            ...input(`http://127.0.0.1:${s.port}/delay`), followRedirects: true
        }, new AbortController().signal);
        expect(timed?.outcome).toBe('TIMEOUT');
        expect(timed!.durationMs).toBeLessThan(1600);
        contacts = 0;
        const hops = await run({
            ...input(`http://127.0.0.1:${s.port}/0`), followRedirects: true
        }, new AbortController().signal);
        expect(hops).toMatchObject({
            outcome: 'REDIRECT_ERROR', redirectCount: 3
        });
        expect(contacts).toBe(4);
    }
    finally {
        timers.forEach(clearTimeout);
        await s.close();
    }
});
