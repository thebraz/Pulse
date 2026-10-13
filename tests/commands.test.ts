import { it, expect } from 'vitest';
import { spawn, execFile, type ChildProcess } from 'node:child_process';
import { promisify } from 'node:util';
import { once } from 'node:events';
import { utimes } from 'node:fs/promises';
import { temp, dispose, freePort, target, until, monitorResponse, executionResponse } from './helpers.js';
async function killOwnedTree(child: ChildProcess) {
    if (!child.pid || child.exitCode !== null)
        return;
    if (process.platform === 'win32')
        await promisify(execFile)('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], {
            windowsHide: true
        });
    else
        process.kill(-child.pid, 'SIGTERM');
}
it('documented npm run example serves a real configurable local target', async () => {
    const npm = process.env.npm_execpath;
    if (!npm)
        throw new Error('RUN_WITH_NPM_TEST');
    const port = await freePort(), child = spawn(process.execPath, [npm, 'run', 'example'], {
        env: {
            ...process.env, PORT: String(port)
        }, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true, detached: process.platform !== 'win32'
    });
    let output = '';
    child.stdout.on('data', (b: Buffer) => { output += b.toString(); });
    const exited = once(child, 'exit');
    try {
        await until(() => output, text => text.includes('Example target listening'));
        const response = await fetch(`http://127.0.0.1:${port}/health`);
        expect(response.status).toBe(200);
        expect(await response.json()).toEqual({
            status: 'ok'
        });
        expect((await fetch(`http://127.0.0.1:${port}/fail`)).status).toBe(500);
    }
    finally {
        await killOwnedTree(child);
        await exited;
    }
});
it.each(['start', 'dev'])('documented npm run %s launches a backend that contacts the fixture and persists the observation', async (command) => {
    const npm = process.env.npm_execpath;
    if (!npm)
        throw new Error('RUN_WITH_NPM_TEST');
    const dir = await temp(), port = await freePort(), origin = `http://127.0.0.1:${port}`;
    let contacts = 0;
    const targetServer = await target((_req, res) => { contacts++; res.end(); });
    const env = {
        ...process.env
    };
    for (const key of Object.keys(env))
        if (key.startsWith('PULSE_'))
            delete env[key];
    Object.assign(env, {
        PULSE_DATA_DIR: dir, PULSE_PORT: String(port), PULSE_PUBLIC_ORIGIN: origin, PULSE_EGRESS_POLICY: 'allow-private', PULSE_ALLOWED_PRIVATE_CIDRS: '127.0.0.1/32'
    });
    const child = spawn(process.execPath, [npm, 'run', command], {
        env, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true, detached: process.platform !== 'win32'
    });
    let output = '';
    child.stdout.on('data', (b: Buffer) => { output += b.toString(); });
    child.stderr.on('data', (b: Buffer) => { output += b.toString(); });
    const exited = once(child, 'exit');
    try {
        try {
            // Development startup includes compilation, separate from the runtime readiness budget.
            await until(() => output, text => text.includes('PULSE_READY'), command === 'dev' ? 120000 : 15000);
        }
        catch {
            throw new Error('COMMAND_START_FAILED: ' + output);
        }
        const m = await monitorResponse(await fetch(origin + '/api/v1/monitors', {
            method: 'POST', headers: {
                origin, 'content-type': 'application/json'
            }, body: JSON.stringify({
                name: 'Command smoke', url: targetServer.url
            })
        }));
        const exec = await executionResponse(await fetch(origin + `/api/v1/monitors/${m.id}/checks`, {
            method: 'POST', headers: {
                origin, 'content-type': 'application/json'
            }, body: '{}'
        }));
        expect((await until(() => fetch(origin + `/api/v1/executions/${exec.id}`).then(executionResponse), e => e.lifecycle === 'COMPLETED')).outcome).toBe('SUCCESS');
        expect(contacts).toBeGreaterThan(0);
        if (command === 'dev') {
            const before = (output.match(/PULSE_READY/g) ?? []).length;
            await utimes('apps/server/dist/persistence/worker.js', new Date(), new Date());
            await until(() => output, text => (text.match(/PULSE_READY/g) ?? []).length > before, 6000);
            expect((await fetch(origin + '/health/ready')).status).toBe(200);
            expect((await monitorResponse(await fetch(origin + `/api/v1/monitors/${m.id}`))).id).toBe(m.id);
        }
    }
    finally {
        await killOwnedTree(child);
        await exited;
        await targetServer.close();
        await dispose(dir);
    }
}, 180000);
