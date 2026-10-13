import http from 'node:http';
import https from 'node:https';
import { isIP } from 'node:net';
import { checkServerIdentity } from 'node:tls';
import { createHmac } from 'node:crypto';
import { AppError } from '../application/errors.js';
import { parseTarget, addressAllowed, type EgressPolicy } from '../monitoring/policy.js';
import { resolveAddresses, type ResolverFn } from '../monitoring/http.js';
export type DeliveryResult = {
    status: number | null;
    code: string | null;
    retry: boolean;
    retryAfterMs: number;
    cancel: boolean;
};
export async function sendWebhook(policy: EgressPolicy, urlText: string, key: string | null, body: string, eventId: string, attempt: number, signal: AbortSignal, resolver: ResolverFn = resolveAddresses): Promise<DeliveryResult> {
    const controller = new AbortController(), abort = () => controller.abort();
    signal.addEventListener('abort', abort, {
        once: true
    });
    const timer = setTimeout(abort, 5000);
    const result = (status: number | null, code: string | null, retry = false, retryAfterMs = 0): DeliveryResult => ({
        status, code, retry, retryAfterMs, cancel: signal.aborted
    });
    try {
        if (signal.aborted)
            return result(null, 'DELIVERY_CANCELLED');
        const url = parseTarget(urlText, policy, true), hostname = url.hostname.replace(/^\[|\]$/g, ''), port = Number(url.port || (url.protocol === 'https:' ? 443 : 80));
        const addresses = isIP(hostname) ? [hostname] : await resolver(hostname, controller.signal);
        controller.signal.throwIfAborted();
        if (!addresses.length)
            return result(null, 'DNS_FAILED', true);
        if (addresses.some(a => !addressAllowed(a, port, policy)) || (url.protocol !== 'https:' && addresses.some(a => !policy.cidrs.length || policy.mode !== 'allow-private' || !addressAllowed(a, port, {
            mode: 'allow-private', cidrs: policy.cidrs
        }) || addressAllowed(a, port, {
            mode: 'public-only', cidrs: []
        }))))
            return result(null, 'TARGET_POLICY_REJECTED');
        const timestamp = String(Math.floor(Date.now() / 1000));
        return await new Promise<DeliveryResult>((resolve, reject) => {
            const req = (url.protocol === 'https:' ? https : http).request({
                hostname: [...addresses].sort()[0]!, port, path: url.pathname + url.search, method: 'POST', agent: false, signal: controller.signal, maxHeaderSize: 16384, headers: {
                    host: url.host, 'content-type': 'application/json', 'content-length': Buffer.byteLength(body), 'user-agent': 'Pulse/0.1.0', 'x-pulse-event-id': eventId, 'x-pulse-attempt': String(attempt), ...(key ? {
                        'x-pulse-timestamp': timestamp, 'x-pulse-signature': 'v1=' + createHmac('sha256', Buffer.from(key, 'base64url')).update(timestamp + '.' + body).digest('hex')
                    } : {})
                }, ...(url.protocol === 'https:' ? {
                    servername: isIP(hostname) ? '' : hostname, rejectUnauthorized: true, checkServerIdentity: (_host: string, cert: import('node:tls').PeerCertificate) => checkServerIdentity(hostname, cert)
                } : {})
            }, res => { const status = res.statusCode ?? 0; res.destroy(); req.destroy();
                if (status < 100 || status > 599) { resolve(result(null, 'INVALID_HTTP_STATUS', true)); return; }
                const retry = [408, 429].includes(status) || status >= 500, header = res.headers['retry-after']; const retryAfterMs = [429, 503].includes(status) && typeof header === 'string' && /^\d+$/.test(header) ? Math.min(300000, Number(header) * 1000) : 0;
                resolve(result(status, status >= 200 && status < 300 ? null : status >= 300 && status < 400 ? 'REDIRECT_FORBIDDEN' : 'RECEIVER_HTTP_ERROR', retry, retryAfterMs)); });
            req.on('upgrade', (_res, socket) => { socket.destroy(); req.destroy(); resolve(result(101, 'UNSUPPORTED_UPGRADE')); });
            req.once('error', reject);
            req.end(body);
        });
    }
    catch (error) {
        if (error instanceof AppError && ['VALIDATION_ERROR', 'TARGET_POLICY_REJECTED'].includes(error.code))
            return result(null, 'TARGET_POLICY_REJECTED');
        const code = typeof error === 'object' && error !== null && 'code' in error ? String(error.code) : '';
        return result(null, signal.aborted ? 'DELIVERY_CANCELLED' : controller.signal.aborted ? 'DELIVERY_TIMEOUT' : /^(ERR_TLS_|ERR_SSL_|CERT_|DEPTH_|SELF_SIGNED|UNABLE_TO_)/.test(code) ? 'TLS_FAILED' : 'CONNECTION_FAILED', !signal.aborted && !/^(ERR_TLS_|ERR_SSL_|CERT_|DEPTH_|SELF_SIGNED|UNABLE_TO_)/.test(code));
    }
    finally {
        clearTimeout(timer);
        signal.removeEventListener('abort', abort);
        controller.abort();
    }
}
