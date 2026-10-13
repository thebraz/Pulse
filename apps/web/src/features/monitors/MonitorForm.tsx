import { useState, type FormEvent } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { monitorCreateSchema, monitorSchema, type Monitor, type MonitorInput } from '@pulse/contracts';
import { api, single, ApiError } from '../../lib/api';
import { ErrorNotice, Loading, PageTitle } from '../../components/ui';
const defaults: MonitorInput = monitorCreateSchema.parse({
    name: 'New monitor', url: 'https://example.com'
});
export default function MonitorForm() {
    const { id } = useParams(), [generation, setGeneration] = useState(0);
    const current = useQuery({
        queryKey: ['monitor', id], queryFn: ({ signal }) => api('/monitors/' + id, single(monitorSchema), {
            signal
        }), enabled: !!id
    });
    if (id && current.isPending)
        return <Loading />;
    if (id && !current.data && current.isError)
        return <ErrorNotice error={current.error} retry={() => void current.refetch()}/>;
    return <>{current.isError && <ErrorNotice error={current.error} retry={() => void current.refetch()}/>}<Form key={(id ?? 'new') + ':' + generation} current={current.data} reload={() => { void current.refetch().then(() => setGeneration(n => n + 1)); }}/></>;
}
function Form({ current: resource, reload }: {
    current: Monitor | undefined;
    reload: () => void;
}) {
    const [current] = useState(resource);
    const navigate = useNavigate(), client = useQueryClient(), [draft, setDraft] = useState<MonitorInput>(current ? monitorCreateSchema.parse(Object.fromEntries(Object.entries(current).filter(([key]) => key in monitorCreateSchema.shape))) : {
        ...defaults, name: '', url: ''
    }), [codes, setCodes] = useState((current?.expectedStatusCodes ?? [200]).join(', ')), [errors, setErrors] = useState<Record<string, string>>({});
    const save = useMutation({
        mutationFn: (input: MonitorInput) => api(current ? '/monitors/' + current.id : '/monitors', single(monitorSchema), {
            method: current ? 'PATCH' : 'POST', body: input, ...(current ? {
                revision: current.revision
            } : {})
        }), onSuccess: async (value) => { client.setQueryData(['monitor', value.id], value); await client.invalidateQueries(); navigate('/monitors/' + value.id); }
    });
    const update = <K extends keyof MonitorInput>(key: K, value: MonitorInput[K]) => setDraft(d => ({
        ...d, [key]: value
    }));
    function submit(e: FormEvent) {
        e.preventDefault();
        const parsedCodes = codes.split(',').flatMap(s => {
            const text = s.trim(), range = /^(\d{3})\s*-\s*(\d{3})$/.exec(text);
            return range ? Array.from({
                length: Math.max(0, Math.min(51, Number(range[2]) - Number(range[1]) + 1))
            }, (_, i) => Number(range[1]) + i) : [Number(text)];
        });
        const value = monitorCreateSchema.safeParse({
            ...draft, expectedStatusCodes: parsedCodes
        }), issues: Record<string, string> = {};
        if (!value.success)
            for (const issue of value.error.issues)
                issues[String(issue.path[0])] = 'Enter a valid value within the stated bounds.';
        try {
            const url = new URL(draft.url);
            if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || draft.url.includes('?') || draft.url.includes('#'))
                throw new Error();
        }
        catch {
            issues.url = 'Use an absolute HTTP or HTTPS URL without credentials, query or fragment.';
        }
        if (!codes.trim() || parsedCodes.some(v => !Number.isInteger(v)) || parsedCodes.length > 50)
            issues.expectedStatusCodes = 'Enter 1–50 status codes (200–599), separated by commas, or a bounded range.';
        setErrors(issues);
        if (Object.keys(issues).length) {
            document.getElementById(Object.keys(issues)[0]!)?.focus();
            return;
        }
        if (value.success)
            save.mutate(value.data);
    }
    const numeric = (key: 'intervalMs' | 'timeoutMs' | 'failureThreshold' | 'recoveryThreshold' | 'latencyThresholdMs' | 'degradationThreshold', label: string, min: number, max: number, hint: string) => <label htmlFor={key}>{label}<input id={key} aria-label={label} type="number" min={min} max={max} step="1" value={draft[key]} onChange={e => update(key, Number(e.target.value))} aria-invalid={!!errors[key]} aria-describedby={key + '-hint'}/><small id={key + '-hint'}>{errors[key] ?? hint}</small></label>;
    return <><PageTitle eyebrow="MONITOR CONFIGURATION" title={current ? 'Edit monitor' : 'Create a monitor'} description="Configure one reliable signal for your website or API."/><form className="form-panel" onSubmit={submit} noValidate>{save.isError && <ErrorNotice error={save.error}/>} {save.error instanceof ApiError && save.error.status === 409 && <button type="button" className="secondary" onClick={reload}>Reload current version</button>}<fieldset><legend>Target</legend><p className="muted">Pulse contacts this endpoint from the server. Private targets require an approved startup CIDR.</p><div className="form-grid"><label htmlFor="name">Monitor name<input id="name" value={draft.name} maxLength={120} onChange={e => update('name', e.target.value)} aria-invalid={!!errors.name}/>{errors.name && <small role="alert">{errors.name}</small>}</label><label htmlFor="url">Target URL<input id="url" type="url" placeholder="https://api.example.com/health" value={draft.url} onChange={e => update('url', e.target.value)} aria-invalid={!!errors.url} aria-describedby="url-hint"/><small id="url-hint">{errors.url ?? 'No query credentials, request bodies or custom headers.'}</small></label><label htmlFor="method">HTTP method<select id="method" value={draft.method} onChange={e => update('method', e.target.value as 'GET' | 'HEAD')}><option>GET</option><option>HEAD</option></select></label><label htmlFor="expectedStatusCodes">Expected status codes<input id="expectedStatusCodes" value={codes} onChange={e => setCodes(e.target.value)} aria-invalid={!!errors.expectedStatusCodes}/><small>{errors.expectedStatusCodes ?? 'Examples: 200, 204 or 200-205. At most 50 codes.'}</small></label></div></fieldset><fieldset><legend>Check schedule</legend><div className="form-grid">{numeric('intervalMs', 'Interval (ms)', 15000, 3600000, '15,000–3,600,000 ms. Missed slots are never replayed.')}{numeric('timeoutMs', 'Timeout (ms)', 1000, 30000, '1,000–30,000 ms. Checks never overlap.')}</div></fieldset><fieldset><legend>Health thresholds</legend><p className="muted">An incident opens after confirmed failures and resolves after confirmed recovery.</p><div className="form-grid">{numeric('failureThreshold', 'Failure threshold', 1, 10, '1–10 consecutive failed checks.')}{numeric('recoveryThreshold', 'Recovery threshold', 1, 10, '1–10 consecutive successful checks.')}{numeric('latencyThresholdMs', 'Latency degradation threshold (ms)', 1, 30000, 'Successful checks at or above this value are slow.')}{numeric('degradationThreshold', 'Degradation threshold', 1, 10, '1–10 consecutive slow successes.')}</div></fieldset><fieldset><legend>Behavior</legend><label className="check-label"><input type="checkbox" checked={draft.enabled} onChange={e => update('enabled', e.target.checked)}/>Enable monitoring</label><label className="check-label"><input type="checkbox" checked={draft.followRedirects} onChange={e => update('followRedirects', e.target.checked)}/>Follow redirects (maximum 3; every destination is validated)</label></fieldset>{Object.keys(errors).length > 0 && <p className="notice error" role="alert">Correct the highlighted fields before saving.</p>}<div className="actions"><button disabled={save.isPending}>{save.isPending ? 'Saving…' : current ? 'Save changes' : 'Create monitor'}</button><Link className="button secondary" to={current ? '/monitors/' + current.id : '/'}>Cancel</Link></div></form></>;
}
