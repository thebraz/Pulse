import { randomUUID } from 'node:crypto';
import type { DatabaseSync, SQLInputValue, SQLOutputValue } from 'node:sqlite';
import { z } from 'zod';
import { destinationSchema, deliverySchema, webhookPayloadSchema, destinationCreateSchema, type Monitor } from '@pulse/contracts';
import type { Input } from './protocol.js';
import { AppError } from '../application/errors.js';
type Row = Record<string, SQLOutputValue>;
const iso = (v: SQLOutputValue | undefined) => v == null ? null : new Date(Number(v)).toISOString();
export const retryDelay = (attempt: number) => Math.min(300000, 5000 * 2 ** Math.max(0, attempt - 1));
const cursorSchema = z.strictObject({
    filter: z.string().max(2048), key: z.union([z.string().max(120), z.number().int().nonnegative()]), id: z.uuid()
});
export class NotificationStore {
    constructor(private readonly db: DatabaseSync) { }
    private one(sql: string, ...p: SQLInputValue[]) { return this.db.prepare(sql).get(...p); }
    private all(sql: string, ...p: SQLInputValue[]) { return this.db.prepare(sql).all(...p); }
    private run(sql: string, ...p: SQLInputValue[]) { return this.db.prepare(sql).run(...p); }
    private require(id: string) {
        const r = this.one('SELECT * FROM notification_destinations WHERE id=?', id);
        if (!r)
            throw new AppError('NOT_FOUND', 404);
        return r;
    }
    private view(r: Row) {
        return destinationSchema.parse({
            id: r.id, name: r.name, enabled: r.enabled === 1, urlConfigured: true, signingConfigured: r.signing_secret_ref != null, revision: r.revision, createdAt: iso(r.created_at), updatedAt: iso(r.updated_at)
        });
    }
    private delivery(r: Row) {
        return deliverySchema.parse({
            id: r.id, eventId: r.event_id, destinationId: r.destination_id, incidentId: r.incident_id, eventType: r.event_type, state: r.state, attemptCount: r.attempt_count, nextAttemptAt: iso(r.next_attempt_at), claimedAt: iso(r.claimed_at), lastHttpStatus: r.last_http_status, lastErrorCode: r.last_error_code, createdAt: iso(r.created_at), updatedAt: iso(r.updated_at), finishedAt: iso(r.finished_at)
        });
    }
    create({ now, input }: Input<'destinationCreate'>) {
        if (Number(this.one('SELECT count(*) AS n FROM notification_destinations')?.n) >= 50)
            throw new AppError('DESTINATION_LIMIT_REACHED', 409);
        const id = randomUUID();
        this.run('INSERT INTO notification_destinations VALUES(?,?,?,?,?,1,?,?)', id, input.name, Number(input.enabled), input.urlSecretRef, input.signingSecretRef, now, now);
        return this.view(this.require(id));
    }
    get(id: string) { return this.view(this.require(id)); }
    secret(id: string) {
        const r = this.require(id);
        return {
            id: String(r.id), enabled: r.enabled === 1, revision: Number(r.revision), urlSecretRef: String(r.url_secret_ref), signingSecretRef: r.signing_secret_ref == null ? null : String(r.signing_secret_ref)
        };
    }
    patch({ id, revision, now, input }: Input<'destinationPatch'>) {
        const r = this.require(id);
        if (r.revision !== revision)
            throw new AppError('REVISION_CONFLICT', 409);
        const next = destinationCreateSchema.parse({
            name: r.name, enabled: r.enabled === 1, urlSecretRef: r.url_secret_ref, signingSecretRef: r.signing_secret_ref, ...input
        });
        if (next.name === r.name && Number(next.enabled) === r.enabled && next.urlSecretRef === r.url_secret_ref && next.signingSecretRef === r.signing_secret_ref)
            return this.view(r);
        this.cancel(id, now);
        this.run('UPDATE notification_destinations SET name=?,enabled=?,url_secret_ref=?,signing_secret_ref=?,revision=revision+1,updated_at=? WHERE id=?', next.name, Number(next.enabled), next.urlSecretRef, next.signingSecretRef, now, id);
        return this.view(this.require(id));
    }
    delete({ id, revision, now }: Input<'destinationDelete'>) {
        if (this.require(id).revision !== revision)
            throw new AppError('REVISION_CONFLICT', 409);
        this.cancel(id, now);
        this.run('DELETE FROM notification_destinations WHERE id=?', id);
        return null;
    }
    private cancel(id: string, now: number) { this.run("UPDATE notification_deliveries SET state='CANCELLED',next_attempt_at=NULL,last_error_code='DESTINATION_CHANGED',updated_at=?,finished_at=? WHERE destination_id=? AND state IN('PENDING','IN_FLIGHT')", now, now, id); }
    private enqueue(destination: Row, payload: unknown, incidentId: string | null, now: number) {
        const value = webhookPayloadSchema.parse(payload), body = JSON.stringify(value);
        if (Buffer.byteLength(body) > 16384)
            throw new AppError('PAYLOAD_TOO_LARGE', 500);
        const id = randomUUID();
        this.run("INSERT OR IGNORE INTO notification_deliveries(id,event_id,destination_id,incident_id,destination_revision,event_type,payload_json,state,next_attempt_at,created_at,updated_at) VALUES(?,?,?,?,?,?,?,'PENDING',?,?,?)", id, value.eventId, destination.id!, incidentId, destination.revision!, value.type, body, now, now, now);
        return id;
    }
    incident(monitor: Monitor, incidentId: string, type: 'incident.opened' | 'incident.resolved', fromState: string, toState: string, now: number) {
        const r = this.one('SELECT * FROM incidents WHERE id=?', incidentId)!;
        const payload = {
            version: 1, eventId: randomUUID(), type, occurredAt: new Date(now).toISOString(), monitor: {
                id: monitor.id, name: monitor.name
            }, incident: {
                id: incidentId, status: r.status, openedAt: iso(r.opened_at), detectedAt: iso(r.detected_at), observedEndAt: iso(r.observed_end_at), resolvedAt: iso(r.resolved_at)
            }, transition: {
                fromState, toState
            }
        };
        for (const d of this.all('SELECT * FROM notification_destinations WHERE enabled=1'))
            this.enqueue(d, payload, incidentId, now);
    }
    test({ id, now }: Input<'destinationTest'>) {
        const d = this.require(id);
        if (d.enabled !== 1)
            throw new AppError('DESTINATION_DISABLED', 409);
        if (this.one("SELECT id FROM notification_deliveries WHERE destination_id=? AND event_type='notification.test' AND created_at>?", id, now - 60000))
            throw new AppError('TEST_COOLDOWN', 429);
        const deliveryId = this.enqueue(d, {
            version: 1, eventId: randomUUID(), type: 'notification.test', occurredAt: new Date(now).toISOString()
        }, null, now);
        return this.delivery(this.one('SELECT * FROM notification_deliveries WHERE id=?', deliveryId)!);
    }
    list(now: number, q: Input<'destinations'>['query'] | Input<'deliveries'>['query'], destinations: boolean) {
        const filter = JSON.stringify({
            ...q, cursor: undefined, limit: undefined
        }), params: SQLInputValue[] = [], clauses: string[] = [];
        let cursor: z.infer<typeof cursorSchema> | null = null;
        if (q.cursor) {
            try {
                if (!/^[\w-]{1,1024}$/.test(q.cursor))
                    throw new Error();
                cursor = cursorSchema.parse(JSON.parse(Buffer.from(q.cursor, 'base64url').toString()));
                if (cursor.filter !== filter)
                    throw new Error();
            }
            catch {
                throw new AppError('VALIDATION_ERROR', 400);
            }
        }
        const d = q as Input<'deliveries'>['query'];
        for (const [key, column] of [['destinationId', 'destination_id'], ['incidentId', 'incident_id'], ['state', 'state']] as const)
            if (!destinations && d[key]) {
                clauses.push(column + '=?');
                params.push(d[key]);
            }
        const key = destinations ? 'pulse_lower(name)' : 'created_at', op = destinations ? '>' : '<';
        if (cursor) {
            clauses.push(`(${key}${op}? OR (${key}=? AND id>?))`);
            params.push(cursor.key, cursor.key, cursor.id);
        }
        const limit = Number(q.limit ?? 50), rows = this.all(`SELECT * FROM ${destinations ? 'notification_destinations' : 'notification_deliveries'} ${clauses.length ? 'WHERE ' + clauses.join(' AND ') : ''} ORDER BY ${key} ${destinations ? 'ASC' : 'DESC'},id LIMIT ?`, ...params, limit + 1), last = rows[limit - 1];
        return {
            data: rows.slice(0, limit).map(r => destinations ? this.view(r) : this.delivery(r)), page: {
                limit, asOf: new Date(now).toISOString(), nextCursor: rows.length > limit && last ? Buffer.from(JSON.stringify({
                    filter, key: destinations ? String(last.name).toLowerCase() : Number(last.created_at), id: last.id
                })).toString('base64url') : null
            }
        };
    }
    recover(now: number) {
        for (const r of this.all("SELECT * FROM notification_deliveries WHERE state='IN_FLIGHT'")) {
            const exhausted = Number(r.attempt_count) >= 5;
            this.run('UPDATE notification_deliveries SET state=?,next_attempt_at=?,last_error_code=?,updated_at=?,finished_at=? WHERE id=?', exhausted ? 'DEAD' : 'PENDING', exhausted ? null : Math.max(now, Number(r.claimed_at) + 5000 + retryDelay(Number(r.attempt_count))), exhausted ? 'UNCERTAIN_LAST_ATTEMPT' : 'UNCERTAIN_RECEIPT', now, exhausted ? now : null, r.id!);
        }
    }
    claim(now: number) {
        const r = this.one("SELECT d.* FROM notification_deliveries d WHERE state='PENDING' AND next_attempt_at<=? AND NOT EXISTS(SELECT 1 FROM notification_deliveries older WHERE older.destination_id=d.destination_id AND older.sequence<d.sequence AND older.state IN('PENDING','IN_FLIGHT')) ORDER BY next_attempt_at,id LIMIT 1", now);
        if (!r)
            return null;
        this.run("UPDATE notification_deliveries SET state='IN_FLIGHT',attempt_count=attempt_count+1,claimed_at=?,next_attempt_at=NULL,updated_at=? WHERE id=?", now, now, r.id!);
        return {
            ...this.delivery(this.one('SELECT * FROM notification_deliveries WHERE id=?', r.id!)!), destinationRevision: Number(r.destination_revision), payloadJson: String(r.payload_json)
        };
    }
    finish(p: Input<'deliveryFinish'>) {
        const r = this.one("SELECT * FROM notification_deliveries WHERE id=? AND state='IN_FLIGHT' AND attempt_count=?", p.id, p.attempt);
        if (!r)
            return null;
        const retry = p.retry && Number(r.attempt_count) < 5, state = p.cancel ? 'CANCELLED' : p.status != null && p.status >= 200 && p.status < 300 ? 'SUCCEEDED' : retry ? 'PENDING' : 'DEAD';
        this.run('UPDATE notification_deliveries SET state=?,next_attempt_at=?,last_http_status=?,last_error_code=?,updated_at=?,finished_at=? WHERE id=?', state, state === 'PENDING' ? p.now + Math.max(retryDelay(p.attempt), p.retryAfterMs) : null, p.status, p.code, p.now, state === 'PENDING' ? null : p.now, p.id);
        return null;
    }
    stats(now: number) {
        const counts = {
            pending: 0, inFlight: 0, succeeded: 0, dead: 0, cancelled: 0, oldestPendingAgeMs: 0
        };
        for (const r of this.all('SELECT state,count(*) AS n,min(created_at) AS oldest FROM notification_deliveries GROUP BY state')) {
            const key = ({
                PENDING: 'pending', IN_FLIGHT: 'inFlight', SUCCEEDED: 'succeeded', DEAD: 'dead', CANCELLED: 'cancelled'
            } as const)[r.state as 'PENDING'];
            counts[key] = Number(r.n);
            if (r.state === 'PENDING')
                counts.oldestPendingAgeMs = Math.max(0, now - Number(r.oldest));
        }
        return counts;
    }
}
