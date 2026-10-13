import { resolve, relative, isAbsolute, join } from 'node:path';
import { homedir } from 'node:os';
import { realpath, open } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { z } from 'zod';
import { AppError } from '../application/errors.js';
import { isLoopback, validateCidrs, type EgressPolicy } from '../monitoring/policy.js';
const int = (def: string, min: number, max: number) => z.string().regex(/^\d+$/).transform(Number).pipe(z.number().int().min(min).max(max)).prefault(def);
const configSchema = z.strictObject({
    PULSE_HOST: z.string().default('127.0.0.1'), PULSE_PORT: int('3000', 1, 65535), PULSE_DATA_DIR: z.string().min(1).default(join(homedir(), '.pulse')),
    PULSE_EXPOSURE: z.enum(['local', 'remote']).default('local'), PULSE_PUBLIC_ORIGIN: z.string().default('http://127.0.0.1:3000'),
    PULSE_AUTH_TOKEN_FILE: z.string().min(1).optional(), PULSE_SECRETS_DIR: z.string().min(1).default('./secrets'),
    PULSE_TRUSTED_PROXY_CIDRS: z.string().default(''), PULSE_EGRESS_POLICY: z.enum(['public-only', 'allow-private']).default('public-only'), PULSE_ALLOWED_PRIVATE_CIDRS: z.string().default(''),
    PULSE_CHECK_CONCURRENCY: int('10', 1, 50), PULSE_MANUAL_QUEUE_LIMIT: int('100', 1, 1000), PULSE_DB_QUEUE_LIMIT: int('1000', 10, 10000),
    PULSE_WEBHOOK_CONCURRENCY: int('2', 1, 10), PULSE_CHECK_RETENTION_DAYS: int('30', 1, 365), PULSE_INCIDENT_RETENTION_DAYS: int('365', 30, 3650), PULSE_DELIVERY_RETENTION_DAYS: int('30', 1, 365),
    PULSE_LOG_LEVEL: z.enum(['debug', 'info', 'warn', 'error']).default('info')
});
export type Config = {
    host: string;
    port: number;
    dataDir: string;
    exposure: 'local' | 'remote';
    publicOrigin: string;
    token: string | null;
    secretsDir: string;
    trustedProxyCidrs: string[];
    egress: EgressPolicy;
    concurrency: number;
    manualQueueLimit: number;
    dbQueueLimit: number;
    checkRetentionDays: number;
    incidentRetentionDays: number;
    webhookConcurrency: number;
    deliveryRetentionDays: number;
    fingerprint: string;
    logLevel: string;
};
const split = (v: string) => v ? v.split(',').map(s => s.trim()) : [];
export async function windowsAclReadable(path: string): Promise<boolean | null> {
    if (process.platform !== 'win32')
        return null;
    // Fixed administrator-side ACL query: file contents and user-supplied code never enter the command.
    const script = "$ErrorActionPreference='Stop'; $rules=(Get-Acl -LiteralPath $env:PULSE_SECRET_ACL_PATH).Access; $unsafe=$false; foreach($r in $rules) { $sid=$r.IdentityReference.Translate([System.Security.Principal.SecurityIdentifier]).Value; if($sid -in @('S-1-1-0','S-1-5-11','S-1-5-32-545') -and $r.AccessControlType -eq 'Allow' -and ([int]$r.FileSystemRights -band 1)) { $unsafe=$true } }; if($unsafe){'UNSAFE'}else{'SAFE'}";
    for (const executable of ['pwsh.exe', 'powershell.exe'])
        try {
            const { stdout } = await promisify(execFile)(executable, ['-NoProfile', '-NonInteractive', '-Command', script], {
                env: {
                    ...process.env, PULSE_SECRET_ACL_PATH: path
                }, windowsHide: true, timeout: 10000, maxBuffer: 1024
            });
            return stdout.trim() === 'UNSAFE' ? true : stdout.trim() === 'SAFE' ? false : null;
        }
        catch (error) {
            if (typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT')
                continue;
            return null;
        }
    return null;
}
export async function readSecretFile(path: string, root: string, remote = false): Promise<string> {
    try {
        const canonicalRoot = await realpath(root), canonicalPath = await realpath(path);
        const rel = relative(canonicalRoot, canonicalPath);
        if (!rel || rel.startsWith('..') || isAbsolute(rel))
            throw new Error();
        const handle = await open(canonicalPath, 'r');
        try {
            const info = await handle.stat();
            if (!info.isFile() || info.size > 4096 || (process.platform !== 'win32' && (info.mode & 0o077) !== 0))
                throw new Error();
            if (remote && process.platform === 'win32' && await windowsAclReadable(canonicalPath) !== false)
                throw new Error();
            const buffer = Buffer.alloc(4097);
            const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
            if (bytesRead > 4096)
                throw new Error();
            const token = buffer.subarray(0, bytesRead).toString('utf8').trim();
            if (Buffer.byteLength(token) > 512 || !/^[A-Za-z0-9_-]+$/.test(token) || Buffer.from(token, 'base64url').length < 32)
                throw new Error();
            return token;
        }
        finally {
            await handle.close();
        }
    }
    catch {
        throw new AppError('SECRET_FILE_INVALID', 500);
    }
}
export async function loadConfig(env: NodeJS.ProcessEnv = process.env, cwd = process.cwd()): Promise<Config> {
    const settings = Object.fromEntries(Object.entries(env).filter(([k]) => k.startsWith('PULSE_')));
    const parsed = configSchema.safeParse(settings);
    if (!parsed.success)
        throw new AppError('CONFIG_INVALID', 500);
    const c = parsed.data;
    if (c.PULSE_DB_QUEUE_LIMIT <= c.PULSE_CHECK_CONCURRENCY + c.PULSE_WEBHOOK_CONCURRENCY + 2)
        throw new AppError('CONFIG_INVALID', 500);
    let origin: URL;
    try {
        origin = new URL(c.PULSE_PUBLIC_ORIGIN);
    }
    catch {
        throw new AppError('CONFIG_INVALID', 500);
    }
    if (origin.origin !== c.PULSE_PUBLIC_ORIGIN || !['http:', 'https:'].includes(origin.protocol) || origin.username || origin.password)
        throw new AppError('CONFIG_INVALID', 500);
    if (c.PULSE_EXPOSURE === 'local' && (!isLoopback(c.PULSE_HOST) || !isLoopback(origin.hostname.replace(/^\[|\]$/g, ''))))
        throw new AppError('UNSAFE_EXPOSURE', 500);
    if (c.PULSE_EXPOSURE === 'local' && (origin.hostname.replace(/^\[|\]$/g, '') !== c.PULSE_HOST || Number(origin.port || (origin.protocol === 'https:' ? 443 : 80)) !== c.PULSE_PORT))
        throw new AppError('CONFIG_INVALID', 500);
    if (c.PULSE_EXPOSURE === 'remote' && (!c.PULSE_AUTH_TOKEN_FILE || origin.protocol !== 'https:' || !settings.PULSE_PUBLIC_ORIGIN))
        throw new AppError('UNSAFE_EXPOSURE', 500);
    const cidrs = split(c.PULSE_ALLOWED_PRIVATE_CIDRS), trusted = split(c.PULSE_TRUSTED_PROXY_CIDRS);
    validateCidrs(cidrs);
    validateCidrs(trusted);
    if (c.PULSE_EGRESS_POLICY === 'allow-private' && cidrs.length === 0)
        throw new AppError('CONFIG_INVALID', 500);
    const secretsDir = resolve(cwd, c.PULSE_SECRETS_DIR);
    let token: string | null = null;
    if (c.PULSE_AUTH_TOKEN_FILE) {
        const tokenPath = resolve(cwd, c.PULSE_AUTH_TOKEN_FILE);
        token = await readSecretFile(tokenPath, secretsDir, c.PULSE_EXPOSURE === 'remote');
    }
    // Fingerprint contains only non-secret settings, including neither paths nor token values.
    const fingerprint = createHash('sha256').update(JSON.stringify({
        host: c.PULSE_HOST, port: c.PULSE_PORT, exposure: c.PULSE_EXPOSURE, egress: c.PULSE_EGRESS_POLICY, concurrency: c.PULSE_CHECK_CONCURRENCY
    })).digest('hex');
    return {
        host: c.PULSE_HOST, port: c.PULSE_PORT, dataDir: resolve(cwd, c.PULSE_DATA_DIR), exposure: c.PULSE_EXPOSURE, publicOrigin: origin.origin, token, secretsDir, trustedProxyCidrs: trusted, egress: {
            mode: c.PULSE_EGRESS_POLICY, cidrs
        }, concurrency: c.PULSE_CHECK_CONCURRENCY, manualQueueLimit: c.PULSE_MANUAL_QUEUE_LIMIT, dbQueueLimit: c.PULSE_DB_QUEUE_LIMIT,
        checkRetentionDays: c.PULSE_CHECK_RETENTION_DAYS, incidentRetentionDays: c.PULSE_INCIDENT_RETENTION_DAYS, webhookConcurrency: c.PULSE_WEBHOOK_CONCURRENCY, deliveryRetentionDays: c.PULSE_DELIVERY_RETENTION_DAYS, fingerprint, logLevel: c.PULSE_LOG_LEVEL
    };
}
