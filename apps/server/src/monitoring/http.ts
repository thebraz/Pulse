import { Resolver } from 'node:dns/promises';
import http from 'node:http';
import https from 'node:https';
import { isIP } from 'node:net';
import { performance } from 'node:perf_hooks';
import type { MonitorInput, Observation } from '@pulse/contracts';
import { AppError } from '../application/errors.js';
import { addressAllowed, parseTarget, type EgressPolicy } from './policy.js';
export type ResolverFn = (host: string, signal: AbortSignal) => Promise<string[]>;
export const resolveAddresses: ResolverFn = async (host, signal) => {
    const resolver = new Resolver({
        timeout: 1000, tries: 2
    });
    const cancel = () => resolver.cancel();
    signal.addEventListener('abort', cancel, {
        once: true
    });
    try {
        signal.throwIfAborted();
        const results = await Promise.allSettled([resolver.resolve4(host), resolver.resolve6(host)]);
        const addresses = results.flatMap(r => r.status === 'fulfilled' ? r.value : []);
        if (!addresses.length)
            throw new AppError('DNS_FAILED', 500);
        return addresses;
    }
    finally {
        signal.removeEventListener('abort', cancel);
        resolver.cancel();
    }
};
type HeaderResult = {
    status: number;
    location: string | undefined;
    upgrade: boolean;
};
function headers(url: URL, address: string, method: 'GET' | 'HEAD', signal: AbortSignal): Promise<HeaderResult> {
    return new Promise((resolve, reject) => {
        const hostname = url.hostname.replace(/^\[|\]$/g, '');
        const request = (url.protocol === 'https:' ? https : http).request({
            protocol: url.protocol, hostname: address, port: url.port || undefined, path: url.pathname, method, agent: false, signal, maxHeaderSize: 16384, headers: {
                host: url.host, 'user-agent': 'Pulse/0.1.0', connection: 'close'
            }, ...(url.protocol === 'https:' ? {
                servername: isIP(hostname) ? '' : hostname, rejectUnauthorized: true, checkServerIdentity: (_host: string, cert: import('node:tls').PeerCertificate) => importedCheckIdentity(hostname, cert)
            } : {})
        }, response => {
            const result = {
                status: response.statusCode ?? 0, location: response.headers.location, upgrade: false
            };
            response.destroy();
            request.destroy();
            resolve(result);
        });
        request.once('upgrade', (response, socket) => {
            socket.destroy();
            request.destroy();
            resolve({
                status: response.statusCode ?? 101, location: undefined, upgrade: true
            });
        });
        request.once('error', reject);
        request.end();
    });
}
import { checkServerIdentity as importedCheckIdentity } from 'node:tls';
export type Executor = (monitor: MonitorInput, signal: AbortSignal) => Promise<Observation | null>;
export function createExecutor(policy: EgressPolicy, resolve: ResolverFn = resolveAddresses): Executor {
    return async (monitor, external) => {
        const started = performance.now(), controller = new AbortController();
        let timedOut = false, redirectCount = 0, stage: 'dns' | 'request' = 'request';
        const cancel = () => controller.abort();
        external.addEventListener('abort', cancel, {
            once: true
        });
        const timer = setTimeout(() => { timedOut = true; controller.abort(); }, monitor.timeoutMs);
        const finish = (outcome: Observation['outcome'], httpStatus: number | null, errorCode: string | null): Observation => ({
            outcome, httpStatus, errorCode, redirectCount, durationMs: Math.max(0, performance.now() - started)
        });
        try {
            if (external.aborted)
                return null;
            let url = parseTarget(monitor.url, policy);
            const visited = new Set<string>();
            while (true) {
                controller.signal.throwIfAborted();
                if (visited.has(url.href))
                    return finish('REDIRECT_ERROR', null, 'REDIRECT_LOOP');
                visited.add(url.href);
                const hostname = url.hostname.replace(/^\[|\]$/g, '');
                stage = 'dns';
                let abortDns: (() => void) | undefined;
                let addresses: string[];
                try {
                    addresses = isIP(hostname) ? [hostname] : await Promise.race([resolve(hostname, controller.signal), new Promise<never>((_r, reject) => {
                            abortDns = () => reject(new AppError('REQUEST_ABORTED', 500));
                            if (controller.signal.aborted)
                                abortDns();
                            else
                                controller.signal.addEventListener('abort', abortDns, {
                                    once: true
                                });
                        })]);
                }
                finally {
                    if (abortDns)
                        controller.signal.removeEventListener('abort', abortDns);
                }
                controller.signal.throwIfAborted();
                const port = Number(url.port || (url.protocol === 'https:' ? 443 : 80));
                if (addresses.length === 0)
                    return finish('DNS_ERROR', null, 'DNS_FAILED');
                if (addresses.some(a => !addressAllowed(a, port, policy)))
                    return finish('POLICY_BLOCKED', null, 'TARGET_POLICY_REJECTED');
                stage = 'request';
                const result = await headers(url, [...addresses].sort()[0]!, monitor.method, controller.signal);
                if (performance.now() - started >= monitor.timeoutMs)
                    return finish('TIMEOUT', null, 'REQUEST_TIMEOUT');
                if (external.aborted)
                    return null;
                if (result.status < 100 || result.status > 599)
                    return finish('HTTP_ERROR', null, 'INVALID_HTTP_STATUS');
                if (result.upgrade)
                    return finish('HTTP_ERROR', 101, 'UNSUPPORTED_UPGRADE');
                if (monitor.followRedirects && [301, 302, 303, 307, 308].includes(result.status)) {
                    if (!result.location || redirectCount >= 3)
                        return finish('REDIRECT_ERROR', result.status, 'REDIRECT_INVALID');
                    let target: URL;
                    try {
                        target = new URL(result.location, url);
                    }
                    catch {
                        return finish('REDIRECT_ERROR', result.status, 'REDIRECT_INVALID');
                    }
                    if (url.protocol === 'https:' && target.protocol !== 'https:')
                        return finish('POLICY_BLOCKED', result.status, 'HTTPS_DOWNGRADE');
                    url = parseTarget(target.href, policy);
                    redirectCount++;
                    continue;
                }
                return monitor.expectedStatusCodes.includes(result.status) ? finish('SUCCESS', result.status, null) : finish('HTTP_ERROR', result.status, 'UNEXPECTED_STATUS');
            }
        }
        catch (error) {
            if (external.aborted)
                return null;
            if (timedOut || performance.now() - started >= monitor.timeoutMs)
                return finish('TIMEOUT', null, 'REQUEST_TIMEOUT');
            if (error instanceof AppError && ['TARGET_POLICY_REJECTED', 'VALIDATION_ERROR'].includes(error.code))
                return finish('POLICY_BLOCKED', null, 'TARGET_POLICY_REJECTED');
            const code = typeof error === 'object' && error !== null && 'code' in error ? String(error.code) : '';
            if (stage === 'dns')
                return finish('DNS_ERROR', null, 'DNS_FAILED');
            if (/^(ERR_TLS_|ERR_SSL_|CERT_|DEPTH_|SELF_SIGNED|UNABLE_TO_)/.test(code))
                return finish('TLS_ERROR', null, 'TLS_FAILED');
            return finish('CONNECTION_ERROR', null, 'CONNECTION_FAILED');
        }
        finally {
            clearTimeout(timer);
            external.removeEventListener('abort', cancel);
            controller.abort();
        }
    };
}
