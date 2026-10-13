import { z } from 'zod';
import { errorSchema, sessionViewSchema } from '@pulse/contracts';
export class ApiError extends Error {
    constructor(readonly code: string, readonly status: number, readonly requestId = '') { super(code); }
}
let csrf: string | null = null;
export function clearSession() { csrf = null; }
export async function api<T>(path: string, schema: z.ZodType<T>, options: {
    method?: string;
    body?: unknown;
    revision?: number;
    signal?: AbortSignal;
} = {}): Promise<T> {
    let response: Response;
    try {
        response = await fetch('/api/v1' + path, {
            method: options.method ?? 'GET', credentials: 'same-origin', headers: {
                ...(options.body === undefined ? {} : {
                    'content-type': 'application/json'
                }), ...(csrf ? {
                    'x-pulse-csrf': csrf
                } : {}), ...(options.revision ? {
                    'if-match': `"${options.revision}"`
                } : {})
            }, ...(options.body === undefined ? {} : {
                body: JSON.stringify(options.body)
            }), ...(options.signal ? {
                signal: options.signal
            } : {})
        });
    }
    catch (error) {
        if (options.signal?.aborted)
            throw error;
        throw new ApiError('CONNECTION_UNAVAILABLE', 0);
    }
    if (!response.ok) {
        let id = '', code = 'REQUEST_FAILED';
        try {
            const parsed = errorSchema.safeParse(await response.json());
            if (parsed.success) {
                id = parsed.data.error.requestId;
                code = parsed.data.error.code;
            }
        }
        catch { /* A non-JSON proxy response is still a safe connection failure. */ }
        if (response.status === 401) {
            csrf = null;
            if (path !== '/session')
                window.dispatchEvent(new Event('pulse:unauthorized'));
        }
        throw new ApiError(code, response.status, id);
    }
    if (response.status === 204)
        return schema.parse(null);
    const parsed = schema.safeParse(await response.json());
    if (!parsed.success)
        throw new ApiError('INVALID_SERVER_RESPONSE', 502);
    return parsed.data;
}
export const single = <T,>(schema: z.ZodType<T>) => z.strictObject({
    data: schema
}).transform(v => v.data);
export async function session(signal?: AbortSignal) {
    const result = await api('/session', single(sessionViewSchema), signal ? {
        signal
    } : {});
    csrf = result.csrfToken;
    return result;
}
export async function login(token: string) {
    const result = await api('/session', single(sessionViewSchema), {
        method: 'POST', body: {
            token
        }
    });
    csrf = result.csrfToken;
    return result;
}
export function queryString(values: Record<string, string | undefined>) {
    const q = new URLSearchParams();
    for (const [k, v] of Object.entries(values))
        if (v)
            q.set(k, v);
    return q.size ? '?' + q.toString() : '';
}
export function message(error: unknown) {
    if (!(error instanceof ApiError))
        return 'The request could not be completed. Please retry.';
    const messages: Record<string, string> = {
        REVISION_CONFLICT: 'This resource changed elsewhere. Reload the current version before saving.', TARGET_POLICY_REJECTED: 'This target is blocked by the outbound policy. Private targets require an approved startup CIDR.', VALIDATION_ERROR: 'Check the configuration values and try again.', DESTINATION_SECRET_INVALID: 'The provisioned URL or signing key could not be validated. Check its alias, permissions and outbound policy.', AUTH_REQUIRED: 'Your session expired. Sign in again.', TEST_COOLDOWN: 'Wait one minute before sending another test notification.', CONNECTION_UNAVAILABLE: 'Pulse is unavailable. Check the connection and retry.', NOT_FOUND: 'This resource was deleted or its retained history is no longer available.', QUERY_RANGE_TOO_LARGE: 'This range exceeds the query limits. Select a shorter period.', MONITOR_DISABLED: 'Resume the monitor before running a check.'
    };
    return (messages[error.code] ?? 'The request could not be completed. Please retry.') + (error.requestId ? ' Request ID: ' + error.requestId : '');
}
