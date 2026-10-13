import { it, expect } from 'vitest';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { instance } from './helpers.js';
const run = promisify(execFile);
it('local CLI reports health through the built runtime and rejects invalid commands without printing secrets', async () => {
    const p = await instance();
    const env = {
        ...process.env
    };
    for (const key of Object.keys(env))
        if (key.startsWith('PULSE_'))
            delete env[key];
    Object.assign(env, {
        PULSE_DATA_DIR: p.dir, PULSE_PORT: String(p.config.port), PULSE_PUBLIC_ORIGIN: p.config.publicOrigin
    });
    try {
        const options = {
            env, windowsHide: true, timeout: 6000
        };
        expect((await run(process.execPath, ['bin/pulse.mjs', 'version'], options)).stdout).toBe('Pulse 0.1.0-beta.1\n');
        expect((await run(process.execPath, ['bin/pulse.mjs', 'help'], options)).stdout).toContain('pulse doctor');
        const doctor = await run(process.execPath, ['bin/pulse.mjs', 'doctor'], options);
        expect(doctor.stdout).toContain('Database: healthy (read-only inspection)');
        expect(doctor.stdout).toContain('Backend: ready');
        await expect(run(process.execPath, ['bin/pulse.mjs', 'unknown'], options)).rejects.toMatchObject({
            code: 1
        });
        await expect(run(process.execPath, ['bin/pulse.mjs', 'doctor'], {
            ...options, env: {
                ...env, PULSE_PORT: 'FAKE_SECRET_INVALID'
            }
        })).rejects.toMatchObject({
            code: 1, stderr: 'Doctor failed. Check runtime, configuration, local storage and secret-file permissions.\n'
        });
    }
    finally {
        await p.close();
    }
});
