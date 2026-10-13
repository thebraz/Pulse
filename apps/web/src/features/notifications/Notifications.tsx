import { useState, type FormEvent } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { z } from 'zod';
import { destinationPageSchema, destinationSchema, destinationCreateSchema, deliveryPageSchema, deliverySchema } from '@pulse/contracts';
import { api, single } from '../../lib/api';
import { Confirm, Empty, ErrorNotice, Loading, PageTitle, Panel, Status, time } from '../../components/ui';
export default function Notifications() {
    const client = useQueryClient(), [editing, setEditing] = useState<z.infer<typeof destinationSchema> | null>(null), [deleting, setDeleting] = useState<z.infer<typeof destinationSchema> | null>(null), [name, setName] = useState(''), [urlRef, setUrlRef] = useState(''), [keyRef, setKeyRef] = useState(''), [unsigned, setUnsigned] = useState(false), [formError, setFormError] = useState(''), [success, setSuccess] = useState(''), [cursor, setCursor] = useState('');
    const destinations = useQuery({
        queryKey: ['destinations'], queryFn: ({ signal }) => api('/notification-destinations', destinationPageSchema, {
            signal
        })
    }), deliveries = useQuery({
        queryKey: ['deliveries', cursor], queryFn: ({ signal }) => api('/notification-deliveries?limit=25' + (cursor ? '&cursor=' + encodeURIComponent(cursor) : ''), deliveryPageSchema, {
            signal
        })
    });
    const refresh = () => client.invalidateQueries();
    const save = useMutation({
        mutationFn: (body: unknown) => api('/notification-destinations' + (editing ? '/' + editing.id : ''), single(destinationSchema), {
            method: editing ? 'PATCH' : 'POST', body, ...(editing ? {
                revision: editing.revision
            } : {})
        }), onSuccess: async () => { setEditing(null); setName(''); setUrlRef(''); setKeyRef(''); setUnsigned(false); setSuccess('Destination saved. URL and key remain hidden.'); await refresh(); }
    }), toggle = useMutation({
        mutationFn: (d: z.infer<typeof destinationSchema>) => api('/notification-destinations/' + d.id, single(destinationSchema), {
            method: 'PATCH', revision: d.revision, body: {
                enabled: !d.enabled
            }
        }), onSuccess: refresh
    }), test = useMutation({
        mutationFn: (id: string) => api('/notification-destinations/' + id + '/test', single(deliverySchema), {
            method: 'POST', body: {}
        }), onSuccess: async () => { setSuccess('Test notification queued. Delivery history shows the actual receiver acknowledgment.'); await refresh(); }
    }), remove = useMutation({
        mutationFn: () => api('/notification-destinations/' + deleting!.id + '?confirm=true', z.null(), {
            method: 'DELETE', revision: deleting!.revision
        }), onSuccess: async () => { setDeleting(null); await refresh(); }
    });
    const submit = (e: FormEvent) => {
        e.preventDefault();
        const value = editing ? {
            name, ...(urlRef ? {
                urlSecretRef: urlRef
            } : {}), ...(unsigned ? {
                signingSecretRef: null
            } : keyRef ? {
                signingSecretRef: keyRef
            } : {})
        } : {
            name, urlSecretRef: urlRef, signingSecretRef: keyRef || null
        };
        if (!editing && !destinationCreateSchema.safeParse(value).success || !name.trim() || [urlRef, keyRef].some(v => v && !/^[A-Za-z0-9_-]{1,64}$/.test(v))) {
            setFormError('Enter a name and valid provisioned aliases (letters, digits, underscores or hyphens).');
            return;
        }
        setFormError('');
        save.mutate(value);
    };
    return <><PageTitle eyebrow="ALERT SETTINGS" title="Send the right signal." description="Generic outgoing webhooks for confirmed incidents and recovery. Free and self-hosted."/>{success && <p role="status" className="notice">{success}</p>}{[destinations, deliveries, save, toggle, test, remove].filter(q => q.isError).map((q, i) => <ErrorNotice key={i} error={q.error} retry={() => void refresh()}/>)}<div className="split"><Panel title="Webhook destinations">{destinations.isPending ? <Loading /> : destinations.data?.data.length ? <ul className="resource-list destinations">{destinations.data.data.map(d => <li key={d.id}><div><strong>{d.name}</strong><small>{d.enabled ? 'Enabled' : 'Disabled'} · URL configured · {d.signingConfigured ? 'Signing configured' : 'Unsigned'}</small><div className="actions"><button className="secondary small" disabled={toggle.isPending} onClick={() => toggle.mutate(d)}>{d.enabled ? 'Disable' : 'Enable'}</button><button className="secondary small" disabled={test.isPending || !d.enabled} onClick={() => test.mutate(d.id)}>Send test</button><button className="secondary small" onClick={() => { setEditing(d); setName(d.name); setUrlRef(''); setKeyRef(''); setUnsigned(false); }}>Edit</button><button className="danger quiet small" onClick={() => setDeleting(d)}>Delete</button></div></div></li>)}</ul> : <Empty title="No alert destinations">Add a provisioned webhook alias to receive incident notifications.</Empty>}</Panel><Panel title={editing ? 'Edit destination' : 'Add destination'}><form className="destination-form" onSubmit={submit}><label>Destination name<input value={name} onChange={e => setName(e.target.value)} maxLength={120}/></label><label>URL file alias<input value={urlRef} onChange={e => setUrlRef(e.target.value)} placeholder={editing ? 'Leave blank to keep current URL' : 'e.g. ops-webhook'} autoComplete="off"/><small>Resolves to &lt;alias&gt;.url in the administrator secrets directory. Enter the alias only.</small></label><label>Signing key alias (optional)<input value={keyRef} onChange={e => setKeyRef(e.target.value)} placeholder={editing ? 'Leave blank to retain signing' : 'e.g. ops-signing'} autoComplete="off"/><small>Provision a base64url key from at least 32 random bytes in &lt;alias&gt;.key.</small></label>{editing && <label className="check-label"><input type="checkbox" checked={unsigned} onChange={e => setUnsigned(e.target.checked)}/>Remove signing key</label>}{formError && <p role="alert" className="notice error">{formError}</p>}<div className="actions"><button disabled={save.isPending}>{save.isPending ? 'Saving…' : editing ? 'Save destination' : 'Add destination'}</button>{editing && <button type="button" className="secondary" onClick={() => { setEditing(null); setName(''); }}>Cancel edit</button>}</div></form></Panel></div><p className="notice">Provision files outside the browser and restart after rotating credentials. Editing or disabling a destination cancels outstanding jobs. An already transmitted request cannot be recalled. Test notifications have a one-minute cooldown.</p><Panel title="Delivery history" action={<span className="muted">At most 5 attempts · independent delivery pool</span>}>{deliveries.isPending ? <Loading /> : deliveries.data?.data.length ? <><div className="table-scroll" tabIndex={0} role="region" aria-label="Notification deliveries"><table><thead><tr><th>Event</th><th>Destination</th><th>Outcome</th><th>Attempts</th><th>Last result</th><th>Created / next attempt</th></tr></thead><tbody>{deliveries.data.data.map(d => <tr key={d.id}><td>{d.eventType}<small className="mono">{d.eventId}</small></td><td>{destinations.data?.data.find(v => v.id === d.destinationId)?.name ?? 'Destination'}</td><td><Status state={d.state}/></td><td>{d.attemptCount} / 5</td><td>{d.lastHttpStatus ?? '—'}<small>{d.lastErrorCode ?? (d.state === 'SUCCEEDED' ? 'Receiver acknowledged' : 'Awaiting delivery')}</small></td><td>{time(d.createdAt)}<small>{d.nextAttemptAt ? 'Next: ' + time(d.nextAttemptAt) : d.finishedAt ? 'Finished: ' + time(d.finishedAt) : 'In progress'}</small></td></tr>)}</tbody></table></div><div className="pagination"><button className="secondary" onClick={() => setCursor('')}>Latest deliveries</button>{deliveries.data.page.nextCursor && <button onClick={() => setCursor(deliveries.data!.page.nextCursor!)}>Older deliveries →</button>}</div></> : <Empty title="No deliveries yet">A confirmed incident or a test notification creates a persisted delivery.</Empty>}</Panel><p className="muted">2xx means receiver acknowledgment. Remote duplicates are possible after uncertain receipt; receivers should deduplicate event IDs and verify HMAC signatures. Retries use 5, 10, 20 and 40 second base delays.</p>{deleting && <Confirm name={deleting.name} description="This cancels outstanding sends and permanently removes the destination and its delivery history." pending={remove.isPending} onCancel={() => setDeleting(null)} onConfirm={() => remove.mutate()}/>}</>;
}
