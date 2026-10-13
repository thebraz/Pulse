import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { sessionCreateSchema, emptySchema } from '@pulse/contracts';
import type { Config } from '../config/config.js';
import { AppError } from '../application/errors.js';
type Session = {
    csrf: string;
    expires: number;
};
type Bucket = {
    tokens: number;
    updated: number;
};
export class Security {
    private readonly sessions = new Map<string, Session>();
    private readonly buckets = new Map<string, Bucket>();
    private readonly origin: URL;
    constructor(private readonly config: Config) { this.origin = new URL(config.publicOrigin); }
    private equal(value: string): boolean {
        if (!this.config.token || value.length > 512)
            return false;
        return timingSafeEqual(createHash('sha256').update(value).digest(), createHash('sha256').update(this.config.token).digest());
    }
    private consume(key: string, limit: number) {
        const now = Date.now();
        if (this.buckets.size >= 1000) {
            for (const [k, b] of this.buckets)
                if (now - b.updated > 60000)
                    this.buckets.delete(k);
            if (!this.buckets.has(key) && this.buckets.size >= 1000)
                throw new AppError('RATE_LIMITED', 429);
        }
        const bucket = this.buckets.get(key) ?? {
            tokens: limit, updated: now
        };
        bucket.tokens = Math.min(limit, bucket.tokens + (now - bucket.updated) * limit / 60000);
        bucket.updated = now;
        this.buckets.set(key, bucket);
        if (bucket.tokens < 1)
            throw new AppError('RATE_LIMITED', 429);
        bucket.tokens--;
        return;
    }
    private getSession(req: FastifyRequest): {
        id: string;
        session: Session;
    } | null {
        const cookie = req.headers.cookie?.split(';').map(s => s.trim()).find(s => s.startsWith('pulse_session='))?.slice(14);
        if (!cookie || !/^[A-Za-z0-9_-]{43}$/.test(cookie))
            return null;
        const session = this.sessions.get(cookie);
        if (!session)
            return null;
        if (session.expires <= Date.now()) {
            this.sessions.delete(cookie);
            return null;
        }
        return {
            id: cookie, session
        };
    }
    private bearer(req: FastifyRequest) {
        const auth = req.headers.authorization;
        if (!auth)
            return false;
        if (!auth.startsWith('Bearer ') || !this.equal(auth.slice(7)))
            throw new AppError('AUTH_REQUIRED', 401);
        return true;
    }
    expiresAt(req: FastifyRequest) { return this.config.token ? this.getSession(req)?.session.expires ?? Date.now() : null; }
    install(app: FastifyInstance, isReady: () => boolean) {
        app.addHook('preHandler', async (req) => {
            if (!['GET', 'HEAD', 'OPTIONS'].includes(req.method) && !isReady())
                throw new AppError('SERVICE_STOPPING', 503);
        });
        app.addHook('preValidation', async (req) => {
            if (req.url.split('?')[0] === '/api/v1/session' && !emptySchema.safeParse(req.query).success)
                throw new AppError('VALIDATION_ERROR', 400);
        });
        app.addHook('onRequest', async (req, reply) => {
            reply.header('X-Request-Id', req.id).header('Cache-Control', 'no-store').header('X-Content-Type-Options', 'nosniff').header('Referrer-Policy', 'no-referrer').header('Content-Security-Policy', "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; font-src 'self'; img-src 'self' data:; object-src 'none'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'");
            if (req.headers.host?.toLowerCase() !== this.origin.host.toLowerCase())
                throw new AppError('FORBIDDEN', 403);
            if (req.headers.origin && req.headers.origin !== this.origin.origin)
                throw new AppError('FORBIDDEN', 403);
            const mutation = !['GET', 'HEAD', 'OPTIONS'].includes(req.method), path = req.url.split('?')[0];
            if (path?.startsWith('/health/'))
                return;
            const staticAsset = req.method === 'GET' && (path === '/login' || path?.startsWith('/assets/'));
            if (staticAsset)
                return;
            const login = path === '/api/v1/session' && req.method === 'POST';
            const bearer = login ? false : this.bearer(req), session = this.getSession(req);
            if (mutation && !isReady())
                throw new AppError('SERVICE_STOPPING', 503);
            if (mutation && !bearer && req.headers.origin !== this.origin.origin)
                throw new AppError('FORBIDDEN', 403);
            if (mutation && ['POST', 'PATCH', 'PUT'].includes(req.method) && !/^application\/json(?:\s*;|$)/i.test(req.headers['content-type'] ?? ''))
                throw new AppError('UNSUPPORTED_MEDIA_TYPE', 415);
            if (login) {
                this.consume('login:global', 30);
                this.consume('login:' + req.ip, 5);
                return;
            }
            if (this.config.token && !bearer && !session) {
                if (req.method === 'GET' && !path?.startsWith('/api/'))
                    return reply.redirect('/login');
                throw new AppError('AUTH_REQUIRED', 401);
            }
            if (path === '/api/v1/events' && this.config.token && !session)
                throw new AppError('AUTH_REQUIRED', 401);
            if (mutation && session && !bearer && req.headers['x-pulse-csrf'] !== session.session.csrf)
                throw new AppError('FORBIDDEN', 403);
            this.consume((this.config.token ? 'operator' : req.ip) + (mutation ? ':mutate' : ':read'), mutation ? 60 : 3000);
        });
        app.post('/api/v1/session', async (req, reply) => {
            const parsed = sessionCreateSchema.safeParse(req.body);
            if (!parsed.success)
                throw new AppError('VALIDATION_ERROR', 400);
            if (!this.config.token)
                throw new AppError('AUTH_DISABLED', 409);
            if (!this.equal(parsed.data.token))
                throw new AppError('AUTH_REQUIRED', 401);
            for (const [id, s] of this.sessions)
                if (s.expires <= Date.now())
                    this.sessions.delete(id);
            if (this.sessions.size >= 100)
                throw new AppError('QUEUE_SATURATED', 429);
            const id = randomBytes(32).toString('base64url'), session = {
                csrf: randomBytes(32).toString('base64url'), expires: Date.now() + 8 * 3600000
            };
            this.sessions.set(id, session);
            reply.header('Set-Cookie', `pulse_session=${id}; Path=/; HttpOnly; SameSite=Strict; Max-Age=28800${this.config.exposure === 'remote' ? '; Secure' : ''}`);
            return {
                data: {
                    mode: 'authenticated', authenticated: true, csrfToken: session.csrf, expiresAt: new Date(session.expires).toISOString()
                }
            };
        });
        app.get('/api/v1/session', async (req) => {
            const session = req.headers.authorization ? null : this.getSession(req);
            return {
                data: {
                    mode: this.config.token ? 'authenticated' : 'local', authenticated: true, csrfToken: session?.session.csrf ?? null, expiresAt: session ? new Date(session.session.expires).toISOString() : null
                }
            };
        });
        app.delete('/api/v1/session', async (req, reply) => {
            const session = this.getSession(req);
            if (session)
                this.sessions.delete(session.id);
            return reply.header('Set-Cookie', 'pulse_session=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0').code(204).send();
        });
    }
}
