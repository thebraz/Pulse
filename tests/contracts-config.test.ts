import { describe, it, expect, vi } from 'vitest';
import { writeFile, mkdir, symlink, chmod } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { join } from 'node:path';
import { monitorCreateSchema, monitorPatchSchema, historyQuerySchema } from '@pulse/contracts';
import { loadConfig, readSecretFile, windowsAclReadable } from '../apps/server/src/config/config.js';
import { parseTarget, addressAllowed, type EgressPolicy } from '../apps/server/src/monitoring/policy.js';
import { LogicalClock, nextDue } from '../apps/server/src/scheduler/clock.js';
import { temp, dispose } from './helpers.js';
const publicOnly: EgressPolicy = {
    mode: 'public-only', cidrs: []
};
describe('shared input contracts', () => {
    it('applies defaults and normalizes name/status codes', () => {
        const m = monitorCreateSchema.parse({
            name: ' Test ', url: 'https://example.com', expectedStatusCodes: [204, 200, 204]
        });
        expect(m.name).toBe('Test');
        expect(m.expectedStatusCodes).toEqual([200, 204]);
        expect(m.intervalMs).toBe(60000);
    });
    it('patch preserves omitted fields and rejects empty/server fields/coercion', () => {
        expect(monitorPatchSchema.parse({
            name: 'Renamed'
        })).toEqual({
            name: 'Renamed'
        });
        for (const p of [{}, {
                id: 'bad'
            }, {
                enabled: 'false'
            }, {
                timeoutMs: 999
            }, {
                timeoutMs: 30001
            }, {
                intervalMs: 14999
            }, {
                intervalMs: 3600001
            }, {
                failureThreshold: 11
            }, {
                name: '  '
            }, {
                url: null
            }])
            expect(monitorPatchSchema.safeParse(p).success).toBe(false);
    });
    it('accepts timing boundaries and rejects malformed pagination', () => {
        expect(monitorCreateSchema.safeParse({
            name: 'x', url: 'https://example.com', intervalMs: 3600000, timeoutMs: 30000
        }).success).toBe(true);
        for (const q of [{
                limit: '0'
            }, {
                limit: '101'
            }, {
                limit: '1.5'
            }, {
                wat: 'x'
            }, {
                sort: 'DROP TABLE'
            }])
            expect(historyQuerySchema.safeParse(q).success).toBe(false);
    });
});
describe('static SSRF and address classification', () => {
    it.each(['ftp://example.com', 'http://user:pass@example.com', 'http://@example.com', 'http://example.com/?secret=x', 'http://example.com/#x', 'http://0x7f000001', 'http://2130706433', 'http://127.1', 'http://0177.0.0.1', 'http://169.254.169.254', 'http://[::ffff:127.0.0.1]', 'http://metadata.google.internal', 'http://instance-data', 'http://example.local'])('rejects unsafe target %s', url => { expect(() => parseTarget(url, publicOnly)).toThrow(); });
    it.each(['0.0.0.0', '127.0.0.1', '10.0.0.1', '100.64.0.1', '192.168.1.1', '169.254.1.1', '192.0.2.1', '198.18.0.1', '224.0.0.1', '240.0.0.1', '::', '::1', 'fc00::1', 'fe80::1', 'ff02::1', '2001:db8::1', '2002:7f00:1::', '64:ff9b::7f00:1', '::ffff:127.0.0.1'])('denies non-global IP %s', address => { expect(addressAllowed(address, 80, publicOnly)).toBe(false); });
    it('allows public ports only and narrow private opt-in', () => {
        expect(addressAllowed('8.8.8.8', 443, publicOnly)).toBe(true);
        expect(addressAllowed('8.8.8.8', 8080, publicOnly)).toBe(false);
        const privatePolicy: EgressPolicy = {
            mode: 'allow-private', cidrs: ['127.0.0.1/32', '0.0.0.0/0', '::/0']
        };
        expect(addressAllowed('127.0.0.1', 8080, privatePolicy)).toBe(true);
        for (const a of ['169.254.169.254', '100.100.100.200', '168.63.129.16', 'fd00:ec2::254', '0.0.0.0', 'ff00::1'])
            expect(addressAllowed(a, 80, privatePolicy)).toBe(false);
    });
});
describe('startup configuration and secret containment', () => {
    it('remote Windows secrets fail closed when no ACL probe is available', async () => {
        const dir = await temp();
        try {
            const file = join(dir, 'operator.key');
            await writeFile(file, 'A'.repeat(43), {
                mode: 0o600
            });
            if (process.platform === 'win32') {
                vi.stubEnv('PATH', dir);
                expect(await windowsAclReadable(file)).toBeNull();
                await expect(readSecretFile(file, dir, true)).rejects.toThrow('SECRET_FILE_INVALID');
            }
            expect(await readSecretFile(file, dir)).toBe('A'.repeat(43));
        }
        finally {
            vi.unstubAllEnvs();
            await dispose(dir);
        }
    });
    it('remote startup rejects a fixture file with broadly readable platform permissions', async () => {
        const dir = await temp();
        try {
            const file = join(dir, 'operator.key');
            await writeFile(file, 'A'.repeat(43), {
                mode: 0o600
            });
            if (process.platform === 'win32')
                await promisify(execFile)('icacls.exe', [file, '/grant', '*S-1-1-0:R'], {
                    windowsHide: true
                });
            else
                await chmod(file, 0o644);
            if (process.platform === 'win32')
                expect(await windowsAclReadable(file)).toBe(true);
            await expect(readSecretFile(file, dir, true)).rejects.toThrow('SECRET_FILE_INVALID');
        }
        finally {
            await dispose(dir);
        }
    });
    it('safe defaults and unknown/invalid settings fail', async () => {
        const c = await loadConfig({});
        expect(c.host).toBe('127.0.0.1');
        expect(c.egress.mode).toBe('public-only');
        for (const e of [{
                PULSE_NO_SUCH_SETTING: 'x'
            }, {
                PULSE_PORT: '1.5'
            }, {
                PULSE_HOST: '0.0.0.0'
            }, {
                PULSE_EXPOSURE: 'remote'
            }, {
                PULSE_EGRESS_POLICY: 'allow-private'
            }, {
                PULSE_ALLOWED_PRIVATE_CIDRS: 'nonsense'
            }, {
                PULSE_CHECK_CONCURRENCY: '51'
            }])
            await expect(loadConfig(e)).rejects.toThrow();
    });
    it('reads bounded administrator token files and denies traversal, directories and weak files', async () => {
        const dir = await temp();
        try {
            const root = join(dir, 'secrets');
            await mkdir(root);
            await writeFile(join(root, 'operator.key'), 'A'.repeat(43), {
                mode: 0o600
            });
            expect(await readSecretFile(join(root, 'operator.key'), root)).toBe('A'.repeat(43));
            await writeFile(join(dir, 'outside'), 'B'.repeat(43));
            await expect(readSecretFile(join(dir, 'outside'), root)).rejects.toThrow('SECRET_FILE_INVALID');
            await writeFile(join(root, 'weak'), 'weak');
            await expect(readSecretFile(join(root, 'weak'), root)).rejects.toThrow();
            await writeFile(join(root, 'large'), 'x'.repeat(4097));
            await expect(readSecretFile(join(root, 'large'), root)).rejects.toThrow();
            await expect(readSecretFile(root, root)).rejects.toThrow();
            const remote = await loadConfig({
                PULSE_EXPOSURE: 'remote', PULSE_PUBLIC_ORIGIN: 'https://pulse.example', PULSE_AUTH_TOKEN_FILE: join(root, 'operator.key'), PULSE_SECRETS_DIR: root
            });
            expect(remote.token).toBe('A'.repeat(43));
        }
        finally {
            await dispose(dir);
        }
    });
    it('denies symlink escape using a directory junction on Windows', async () => {
        const dir = await temp();
        try {
            const root = join(dir, 'secrets'), outside = join(dir, 'outside');
            await mkdir(root);
            await mkdir(outside);
            await writeFile(join(outside, 'token'), 'A'.repeat(43), {
                mode: 0o600
            });
            await symlink(outside, join(root, 'escape'), process.platform === 'win32' ? 'junction' : 'dir');
            await expect(readSecretFile(join(root, 'escape', 'token'), root)).rejects.toThrow('SECRET_FILE_INVALID');
        }
        finally {
            await dispose(dir);
        }
    });
});
describe('clock and due slots', () => {
    it('skips missed slots and leaves future manual slots intact', () => { expect(nextDue(1000, 76000, 15000)).toBe(91000); expect(nextDue(10000, 9999, 15000)).toBe(10000); expect(nextDue(1000, 1000, 15000)).toBe(16000); });
    it('clamps regressing clock at persisted seed', () => { let raw = 100; const clock = new LogicalClock(200, () => raw); expect(clock.now()).toBe(200); raw = 300; expect(clock.now()).toBe(300); raw = 250; expect(clock.now()).toBe(300); });
});
