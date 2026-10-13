import { isIP } from 'node:net';
import ipaddr from 'ipaddr.js';
import { AppError } from '../application/errors.js';
export type EgressPolicy = {
    mode: 'public-only' | 'allow-private';
    cidrs: string[];
};
const permanent = ['0.0.0.0/8', '169.254.0.0/16', '224.0.0.0/4', '240.0.0.0/4', '::/128', 'ff00::/8', 'fe80::/10', 'fd00:ec2::254/128', '100.100.100.200/32', '168.63.129.16/32'];
const privateRanges = new Set(['private', 'loopback', 'uniqueLocal']);
export function inCidrs(address: string, cidrs: readonly string[]): boolean {
    try {
        const parsed = ipaddr.process(address);
        return cidrs.some(c => { const [net, bits] = ipaddr.parseCIDR(c); return parsed.kind() === net.kind() && parsed.match(net, bits); });
    }
    catch {
        return false;
    }
}
export function validateCidrs(cidrs: string[]): void {
    for (const c of cidrs) {
        try {
            ipaddr.parseCIDR(c);
        }
        catch {
            throw new AppError('CONFIG_INVALID', 500);
        }
    }
}
export function isLoopback(address: string): boolean {
    try {
        return ipaddr.process(address).range() === 'loopback';
    }
    catch {
        return false;
    }
}
export function addressAllowed(address: string, port: number, policy: EgressPolicy): boolean {
    if (!isIP(address) || inCidrs(address, permanent))
        return false;
    const addr = ipaddr.process(address);
    const range = addr.range();
    // Only native IPv6 global-unicast space; translated, tunnel and special ranges stay denied.
    const publicAddress = range === 'unicast' && (addr.kind() === 'ipv4' || inCidrs(address, ['2000::/3']));
    const explicitlyPrivate = policy.mode === 'allow-private' && privateRanges.has(range) && inCidrs(address, policy.cidrs);
    return (publicAddress && (port === 80 || port === 443)) || explicitlyPrivate;
}
export function parseTarget(raw: string, policy: EgressPolicy, webhook = false): URL {
    let url: URL;
    try {
        url = new URL(raw);
    }
    catch {
        throw new AppError('VALIDATION_ERROR', 400);
    }
    const host = url.hostname.replace(/^\[|\]$/g, '');
    const authority = raw.match(/^https?:\/\/([^/\\?#]+)/i)?.[1];
    if (raw.length > 2048 || !authority || authority.includes('@') || /[\s\\]/.test(raw) || !['http:', 'https:'].includes(url.protocol) || url.username || url.password || (!webhook && raw.includes('?')) || raw.includes('#') || host.includes('%'))
        throw new AppError('VALIDATION_ERROR', 400);
    const inputHost = authority.replace(/:\d+$/, '').replace(/^\[|\]$/g, '');
    if (isIP(host) && !isIP(inputHost))
        throw new AppError('VALIDATION_ERROR', 400);
    if (/(^|\.)(metadata|metadata\.google\.internal)$/.test(host) || host === 'instance-data' || host.endsWith('.localhost') || host.endsWith('.local'))
        throw new AppError('TARGET_POLICY_REJECTED', 422);
    const port = Number(url.port || (url.protocol === 'https:' ? 443 : 80));
    if (isIP(host) && !addressAllowed(host, port, policy))
        throw new AppError('TARGET_POLICY_REJECTED', 422);
    if (!isIP(host) && !/^[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$/i.test(host))
        throw new AppError('VALIDATION_ERROR', 400);
    return url;
}
