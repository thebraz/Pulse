import { describe, it, expect } from 'vitest';
import { fork, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { randomUUID } from 'node:crypto';
import { Store } from '../apps/server/src/persistence/store.js';
import { temp, dispose, freePort, target, until, monitorResponse, executionResponse } from './helpers.js';
type Child = {
    child: ChildProcess;
    output: () => string;
    exited: Promise<[
        number | null,
        NodeJS.Signals | null
    ]>;
    origin: string;
};
function child(dir: string, port: number, extra: NodeJS.ProcessEnv = {}): Child {
    const env = {
        ...process.env
    };
    for (const key of Object.keys(env))
        if (key.startsWith('PULSE_'))
            delete env[key];
    Object.assign(env, {
        PULSE_DATA_DIR: dir, PULSE_PORT: String(port), PULSE_PUBLIC_ORIGIN: `http://127.0.0.1:${port}`, PULSE_EGRESS_POLICY: 'allow-private', PULSE_ALLOWED_PRIVATE_CIDRS: '127.0.0.1/32', ...extra
    });
    const child = fork(join(process.cwd(), 'apps/server/dist/main.js'), {
        execPath: process.execPath, execArgv: [], env, stdio: ['ignore', 'pipe', 'pipe', 'ipc']
    });
    let output = '';
    child.stdout?.on('data', (b: Buffer) => { output += b.toString(); });
    child.stderr?.on('data', (b: Buffer) => { output += b.toString(); });
    const exited = once(child, 'exit') as Promise<[
        number | null,
        NodeJS.Signals | null
    ]>;
    return {
        child, output: () => output, exited, origin: `http://127.0.0.1:${port}`
    };
}
async function waitReady(c: Child) {
    try {
        await until(() => c.output(), text => text.includes('PULSE_READY'));
    }
    catch {
        throw new Error('PROCESS_START_FAILED: ' + c.output());
    }
    expect(c.child.exitCode).toBeNull();
}
async function stop(c: Child) {
    if (c.child.exitCode === null && c.child.signalCode === null)
        c.child.send('shutdown');
    const [code] = await c.exited;
    expect(code).toBe(0);
}
describe('built production process lifecycle', () => {
    it.each(['inside', 'after'])('kill %s the incident transaction recovers atomically without duplicate incidents', async (boundary) => {
        const dir = await temp(), c = fork(join(process.cwd(), 'tests/fixtures/transaction-crash.mjs'), [dir, boundary], {
            execPath: process.execPath, execArgv: [], stdio: ['ignore', 'pipe', 'pipe', 'ipc']
        });
        let output = '';
        c.stderr?.on('data', (b: Buffer) => { output += b.toString(); });
        try {
            const [code, signal] = await once(c, 'exit');
            expect(code === null || code !== 0 || signal !== null).toBe(true);
            expect(output).not.toContain('Error:');
            const db = new DatabaseSync(join(dir, 'pulse.sqlite'));
            let id: string;
            try {
                id = String(db.prepare('SELECT id FROM monitors').get()?.id);
                expect(db.prepare('SELECT lifecycle FROM checks').get()?.lifecycle).toBe(boundary === 'inside' ? 'RUNNING' : 'COMPLETED');
                expect(db.prepare('SELECT count(*) AS n FROM incidents').get()?.n).toBe(boundary === 'inside' ? 0 : 1);
                expect(db.prepare('SELECT count(*) AS n FROM state_transitions').get()?.n).toBe(boundary === 'inside' ? 0 : 1);
                db.exec('DROP TRIGGER IF EXISTS crash_boundary');
                expect(db.prepare('PRAGMA integrity_check').get()?.integrity_check).toBe('ok');
            }
            finally {
                db.close();
            }
            const store = new Store(join(dir, 'pulse.sqlite'));
            try {
                const now = Date.now() + 100;
                store.execute('initialize', {
                    now, runId: randomUUID(), fingerprint: 'b'.repeat(64)
                });
                expect(store.execute('get', {
                    id
                }).status.state).toBe('UNKNOWN');
                const queued = store.execute('manual', {
                    id, now, limit: 10
                });
                store.execute('dispatch', {
                    now, preferManual: true
                });
                store.execute('finish', {
                    id: queued.id, now: now + 1, observation: {
                        outcome: 'HTTP_ERROR', httpStatus: 500, durationMs: 1, redirectCount: 0, errorCode: 'UNEXPECTED_STATUS'
                    }
                });
                expect(store.db.prepare('SELECT count(*) AS n FROM incidents').get()?.n).toBe(1);
                expect(store.db.prepare('PRAGMA foreign_key_check').all()).toEqual([]);
            }
            finally {
                store.execute('close', {});
            }
        }
        finally {
            c.kill();
            await dispose(dir);
        }
    });
    it('forced crash with an unresolved incident preserves its identity and requires confirmed recovery after restart', async () => {
        const dir = await temp(), port = await freePort();
        let mode: 'fail' | 'stall' | 'success' = 'fail', contacts = 0;
        const s = await target((_req, res) => {
            contacts++;
            if (mode === 'stall')
                return;
            res.statusCode = mode === 'fail' ? 500 : 200;
            res.end();
        }), first = child(dir, port);
        let second: Child | undefined;
        const request = (c: Child, path: string, method = 'GET', body?: unknown) => fetch(c.origin + path, {
            method, headers: {
                origin: c.origin, 'content-type': 'application/json'
            }, ...(body === undefined ? {} : {
                body: JSON.stringify(body)
            })
        });
        const check = async (c: Child, id: string) => {
            const e = await executionResponse(await request(c, `/api/v1/monitors/${id}/checks`, 'POST', {}));
            return until(() => request(c, `/api/v1/executions/${e.id}`).then(executionResponse), e => e.lifecycle === 'COMPLETED');
        };
        try {
            await waitReady(first);
            const m = await monitorResponse(await request(first, '/api/v1/monitors', 'POST', {
                name: 'Incident crash', url: s.url, timeoutMs: 30000
            }));
            await until(() => request(first, `/api/v1/monitors/${m.id}`).then(monitorResponse), m => m.lastObservedOutcome === 'HTTP_ERROR');
            await check(first, m.id);
            await check(first, m.id);
            const open = await request(first, '/api/v1/incidents?status=OPEN').then(r => r.json()) as {
                data: {
                    id: string;
                }[];
            };
            expect(open.data).toHaveLength(1);
            mode = 'stall';
            const active = await executionResponse(await request(first, `/api/v1/monitors/${m.id}/checks`, 'POST', {}));
            await until(() => contacts, n => n === 4);
            first.child.kill('SIGKILL');
            await first.exited;
            second = child(dir, port);
            await waitReady(second);
            expect(await request(second, `/api/v1/executions/${active.id}`).then(executionResponse)).toMatchObject({
                lifecycle: 'ABANDONED', outcome: null, durationMs: null
            });
            expect((await request(second, `/api/v1/monitors/${m.id}`).then(monitorResponse)).status.state).toBe('UNKNOWN');
            mode = 'success';
            await check(second, m.id);
            expect((await request(second, `/api/v1/monitors/${m.id}`).then(monitorResponse)).status.state).toBe('UNKNOWN');
            await check(second, m.id);
            const detail = await request(second, `/api/v1/incidents/${open.data[0]!.id}`).then(r => r.json()) as {
                data: {
                    status: string;
                    id: string;
                };
            };
            expect(detail.data).toMatchObject({
                id: open.data[0]!.id, status: 'RESOLVED'
            });
            await stop(second);
            const db = new DatabaseSync(join(dir, 'pulse.sqlite'), {
                readOnly: true
            });
            try {
                expect(db.prepare('SELECT count(*) AS n FROM incidents').get()?.n).toBe(1);
                expect(db.prepare('PRAGMA integrity_check').get()?.integrity_check).toBe('ok');
                expect(db.prepare("SELECT count(*) AS n FROM checks WHERE lifecycle='ABANDONED'").get()?.n).toBe(1);
            }
            finally {
                db.close();
            }
        }
        finally {
            first.child.kill();
            second?.child.kill();
            await s.close();
            await dispose(dir);
        }
    });
    it('actual target receipt, graceful platform stop, persisted history and restart', async () => {
        const dir = await temp(), port = await freePort(), s = await target(), first = child(dir, port);
        let second: Child | undefined;
        try {
            await waitReady(first);
            expect((await fetch(first.origin + '/health/ready')).status).toBe(200);
            const m = await monitorResponse(await fetch(first.origin + '/api/v1/monitors', {
                method: 'POST', headers: {
                    origin: first.origin, 'content-type': 'application/json'
                }, body: JSON.stringify({
                    name: 'Restart', url: s.url
                })
            }));
            const exec = await executionResponse(await fetch(first.origin + `/api/v1/monitors/${m.id}/checks`, {
                method: 'POST', headers: {
                    origin: first.origin, 'content-type': 'application/json'
                }, body: '{}'
            }));
            await until(() => fetch(first.origin + `/api/v1/executions/${exec.id}`).then(executionResponse), e => e.lifecycle === 'COMPLETED');
            const start = Date.now();
            await stop(first);
            expect(Date.now() - start).toBeLessThan(15000);
            second = child(dir, port);
            await waitReady(second);
            const persisted = await monitorResponse(await fetch(second.origin + `/api/v1/monitors/${m.id}`));
            expect(persisted.id).toBe(m.id);
            expect((await executionResponse(await fetch(second.origin + `/api/v1/executions/${exec.id}`))).outcome).toBe('SUCCESS');
            await stop(second);
        }
        finally {
            first.child.kill();
            second?.child.kill();
            await s.close();
            await dispose(dir);
        }
    });
    it('forced death releases OS lock and recovery abandons running work', async () => {
        const dir = await temp(), port = await freePort();
        let contacts = 0;
        const s = await target(() => { contacts++; }), first = child(dir, port);
        let second: Child | undefined;
        try {
            await waitReady(first);
            const m = await monitorResponse(await fetch(first.origin + '/api/v1/monitors', {
                method: 'POST', headers: {
                    origin: first.origin, 'content-type': 'application/json'
                }, body: JSON.stringify({
                    name: 'Crash', url: s.url, timeoutMs: 30000
                })
            }));
            const exec = await executionResponse(await fetch(first.origin + `/api/v1/monitors/${m.id}/checks`, {
                method: 'POST', headers: {
                    origin: first.origin, 'content-type': 'application/json'
                }, body: '{}'
            }));
            await until(() => contacts, n => n === 1);
            const competitor = child(dir, await freePort());
            const [code] = await competitor.exited;
            expect(code).toBe(1);
            expect(competitor.output()).toContain('DATA_DIRECTORY_LOCKED');
            first.child.kill('SIGKILL');
            await first.exited;
            second = child(dir, port);
            await waitReady(second);
            const recovered = await executionResponse(await fetch(second.origin + `/api/v1/executions/${exec.id}`));
            expect(recovered).toMatchObject({
                lifecycle: 'ABANDONED', outcome: null, durationMs: null
            });
            await until(() => contacts, n => n === 2);
            await stop(second);
            const db = new DatabaseSync(join(dir, 'pulse.sqlite'), {
                readOnly: true
            });
            try {
                const rows = db.prepare('SELECT lifecycle,outcome,duration_ms FROM checks ORDER BY sequence').all();
                expect(rows).toHaveLength(2);
                expect(rows[1]).toMatchObject({
                    lifecycle: 'CANCELLED', outcome: null, duration_ms: null
                });
            }
            finally {
                db.close();
            }
        }
        finally {
            first.child.kill();
            second?.child.kill();
            await s.close();
            await dispose(dir);
        }
    });
    it('unsafe startup and occupied API port exit unsuccessfully without lingering resources', async () => {
        const dir = await temp(), s = await target();
        try {
            const unsafe = child(join(dir, 'unsafe'), await freePort(), {
                PULSE_EXPOSURE: 'remote'
            });
            expect((await unsafe.exited)[0]).toBe(1);
            expect(unsafe.output()).toContain('UNSAFE_EXPOSURE');
            const occupied = child(join(dir, 'occupied'), s.port);
            expect((await occupied.exited)[0]).toBe(1);
            expect(occupied.output()).toContain('STARTUP_FAILED');
        }
        finally {
            await s.close();
            await dispose(dir);
        }
    });
});
