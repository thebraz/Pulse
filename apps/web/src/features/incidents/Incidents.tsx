import { useState } from 'react';
import { Link, useParams, useSearchParams } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { incidentPageSchema, incidentDetailSchema, monitorPageSchema, monitorSchema } from '@pulse/contracts';
import { api, single, queryString } from '../../lib/api';
import { Empty, ErrorNotice, Loading, PageTitle, Panel, Status, Stats, Pager, time, duration } from '../../components/ui';
export default function Incidents() {
    const [params, setParams] = useSearchParams(), [search, setSearch] = useState(params.get('q') ?? '');
    const query = queryString({
        q: params.get('q') ?? undefined, failureCategory: params.get('failureCategory') ?? undefined, status: params.get('status') ?? undefined, monitorId: params.get('monitorId') ?? undefined, cursor: params.get('cursor') ?? undefined, sort: params.get('sort') ?? undefined, limit: '25'
    }), incidents = useQuery({
        queryKey: ['incidents', query], queryFn: ({ signal }) => api('/incidents' + query, incidentPageSchema, {
            signal
        })
    }), monitors = useQuery({
        queryKey: ['incident-monitors', search], queryFn: ({ signal }) => api('/monitors' + queryString({
            q: search, limit: '100'
        }), monitorPageSchema, {
            signal
        })
    });
    const set = (key: string, value: string) => {
        const p = new URLSearchParams(params);
        if (value)
            p.set(key, value);
        else
            p.delete(key);
        p.delete('cursor');
        setParams(p);
    };
    return <><PageTitle eyebrow="INCIDENT HISTORY" title="Investigate every interruption." description="Confirmed outages, their evidence, and the path to recovery."/><Panel title="Incidents"><div className="filters"><label>Incident state<select value={params.get('status') ?? ''} onChange={e => set('status', e.target.value)}><option value="">Active and resolved</option><option value="OPEN">Active</option><option value="RESOLVED">Resolved</option></select></label><label>Find monitor<input type="search" value={search} placeholder="Search monitor names…" onChange={e => { setSearch(e.target.value); set('q', e.target.value); }}/></label><label>Related monitor<select value={params.get('monitorId') ?? ''} onChange={e => set('monitorId', e.target.value)}><option value="">All monitors</option>{monitors.data?.data.map(m => <option key={m.id} value={m.id}>{m.name}</option>)}</select></label><label>Failure category<select value={params.get("failureCategory") ?? ""} onChange={e => set("failureCategory", e.target.value)}><option value="">All categories</option>{["HTTP_ERROR", "DNS_ERROR", "TLS_ERROR", "CONNECTION_ERROR", "TIMEOUT", "REDIRECT_ERROR"].map(c => <option key={c}>{c}</option>)}</select></label><label>Sort<select value={params.get('sort') ?? '-detectedAt'} onChange={e => set('sort', e.target.value)}><option value="-detectedAt">Newest first</option><option value="detectedAt">Oldest first</option></select></label></div>{incidents.isError && <ErrorNotice error={incidents.error} retry={() => void incidents.refetch()}/>} {incidents.isPending ? <Loading /> : incidents.data?.data.length ? <><div className="table-scroll" role="region" aria-label="Incident history" tabIndex={0}><table><thead><tr><th>Incident / monitor</th><th>State</th><th>Observed onset</th><th>Recovered</th><th>Raw observed span</th><th>Details</th></tr></thead><tbody>{incidents.data.data.map(i => <tr key={i.id}><td><Link className="resource-name" to={'/incidents/' + i.id}>{i.failureCategory.replaceAll('_', ' ')}</Link><Link className="target" to={'/monitors/' + i.monitorId}>{monitors.data?.data.find(m => m.id === i.monitorId)?.name ?? 'Inspect monitor'}</Link></td><td><Status state={i.status}/></td><td>{time(i.openedAt)}</td><td>{i.observedEndAt ? time(i.observedEndAt) : 'Ongoing · not recovered'}</td><td>{duration(i.durationMs)}<small>May include unobserved gaps</small></td><td><Link className="button secondary small" to={'/incidents/' + i.id}>Investigate →</Link></td></tr>)}</tbody></table></div><Pager next={incidents.data.page.nextCursor}/></> : <Empty title="No incidents match this view">Only confirmed outages appear here. <Link to="/incidents">Clear filters</Link></Empty>}</Panel></>;
}
export function IncidentDetail() {
    const { id } = useParams(), incident = useQuery({
        queryKey: ['incident', id], queryFn: ({ signal }) => api('/incidents/' + id, single(incidentDetailSchema), {
            signal
        })
    }), monitor = useQuery({
        queryKey: ['monitor', incident.data?.monitorId], queryFn: ({ signal }) => api('/monitors/' + incident.data?.monitorId, single(monitorSchema), {
            signal
        }), enabled: !!incident.data
    });
    if (incident.isPending)
        return <Loading />;
    if (!incident.data)
        return <ErrorNotice error={incident.error} retry={() => void incident.refetch()}/>;
    const i = incident.data;
    return <><PageTitle eyebrow="INCIDENT INVESTIGATION" title={i.failureCategory.replaceAll('_', ' ')} description={monitor.data?.name ?? 'Confirmed monitor incident'} action={<Status state={i.status}/>}/>{incident.isError && <ErrorNotice error={incident.error}/>}<p><Link to={'/monitors/' + i.monitorId}>← Inspect related monitor</Link></p><Stats items={[{
                label: 'Observed downtime', value: duration(i.observedDowntimeMs), hint: 'Intersected with known, enabled service coverage'
            }, {
                label: 'Excluded gaps', value: duration(i.excludedGapMs), hint: i.coverageIncomplete ? 'Coverage incomplete' : 'Unobserved intervals excluded'
            }, {
                label: 'Detection delay', value: duration(i.detectionDelayMs), hint: 'Onset to threshold confirmation'
            }, {
                label: 'Recovery confirmation', value: duration(i.resolutionConfirmationDelayMs), hint: i.ongoing ? 'Incident is still open' : 'First recovery to resolution'
            }]}/><Panel title="Observation timeline"><ol className="timeline">{[['First qualifying failure', i.openedAt], ['Outage confirmed', i.detectedAt], ['First qualifying recovery', i.observedEndAt], ['Recovery confirmed', i.resolvedAt]].map(([label, value]) => <li key={label}><strong>{label}</strong><span>{value ? time(value) : 'Not yet observed'}</span></li>)}</ol><p className="notice">{i.diagnosticSummary} {i.resolutionSummary ?? 'Recovery has not been confirmed. Pausing or restarting does not resolve this incident.'}</p></Panel><Panel title="Relevant state transitions"><ul className="timeline">{i.transitions.map(t => <li key={t.id}><strong>{t.fromState} → {t.toState}</strong><small>{time(t.occurredAt)} · {t.reason.replaceAll('_', ' ')}</small></li>)}</ul><p className="muted">Raw observed span: {duration(i.durationMs)}{i.ongoing ? ' (ongoing at ' + time(i.asOf) + ')' : ''}. This span can include observation gaps and does not establish continuous downtime.</p></Panel></>;
}
