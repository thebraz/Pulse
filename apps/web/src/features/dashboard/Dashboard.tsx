import { useEffect, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { dashboardSchema, monitorPageSchema, monitorSchema, type Monitor } from '@pulse/contracts';
import { api, single, queryString } from '../../lib/api';
import { Empty, ErrorNotice, Loading, PageTitle, Panel, Stats, Status, ms, percent, time, Pager } from '../../components/ui';
export default function Dashboard() {
    const [params, setParams] = useSearchParams(), [search, setSearch] = useState(params.get('q') ?? '');
    useEffect(() => { setSearch(params.get('q') ?? ''); }, [params]);
    useEffect(() => {
        if (search === (params.get('q') ?? ''))
            return;
        const timer = setTimeout(() => {
            const p = new URLSearchParams(params);
            if (search)
                p.set('q', search);
            else
                p.delete('q');
            p.delete('cursor');
            setParams(p, {
                replace: true
            });
        }, 250);
        return () => clearTimeout(timer);
    }, [search, params, setParams]);
    const query = queryString({
        q: params.get('q') ?? undefined, status: params.get('status') ?? undefined, enabled: params.get('enabled') ?? undefined, sort: params.get('sort') ?? undefined, cursor: params.get('cursor') ?? undefined, include: 'summary', limit: '25'
    }), dashboard = useQuery({
        queryKey: ['dashboard'], queryFn: ({ signal }) => api('/dashboard', single(dashboardSchema), {
            signal
        })
    }), monitors = useQuery({
        queryKey: ['monitors', query], queryFn: ({ signal }) => api('/monitors' + query, monitorPageSchema, {
            signal
        })
    });
    const filter = (key: string, value: string) => {
        const p = new URLSearchParams(params);
        if (value)
            p.set(key, value);
        else
            p.delete(key);
        p.delete('cursor');
        setParams(p);
    };
    const d = dashboard.data;
    return <><PageTitle eyebrow="WORKSPACE OVERVIEW" title="Your systems, at a glance." description="Live observations. Clear signals. Everything in one place." action={<Link className="button" to="/monitors/new">＋ Create monitor</Link>}/>{dashboard.isError && <ErrorNotice error={dashboard.error} retry={() => void dashboard.refetch()}/>} {!d && dashboard.isPending ? <Loading /> : d && <><Stats items={[{
                    label: 'Total monitors', value: d.counts.total, hint: d.counts.enabled + ' actively monitored'
                }, {
                    label: 'Up', value: d.counts.up, hint: 'Healthy observations', className: 'good'
                }, {
                    label: 'Down', value: d.counts.down, hint: d.counts.activeIncidents + ' active incidents', className: 'bad'
                }, {
                    label: 'Degraded', value: d.counts.degraded, hint: 'Slow or pending failure', className: 'warning'
                }, {
                    label: 'Unknown / paused', value: d.counts.unknown + ' / ' + d.counts.paused, hint: 'Health / administrative state'
                }]}/><div className="metric-strip"><div><span className="muted">24h sampled availability</span><strong>{percent(d.sampledAvailabilityPercent)}</strong><small>{d.sampleCount} observations · includes manual checks</small></div><div><span className="muted">24h mean response latency</span><strong>{ms(d.meanLatencyMs)}</strong><small>Successful response headers only</small></div><p className="muted">Samples describe recorded checks, not continuous uptime. Unknown and offline time remains unobserved.</p></div></>}
 <Panel title="Monitors" action={<span className="muted">24h sample summaries</span>}><div className="filters"><label className="search-label">Search monitors<input type="search" placeholder="Search by name…" value={search} onChange={e => setSearch(e.target.value)}/></label><label>Health<select aria-label="Health" value={params.get('status') ?? ''} onChange={e => filter('status', e.target.value)}><option value="">All health states</option>{['UP', 'DOWN', 'DEGRADED', 'UNKNOWN'].map(s => <option key={s}>{s}</option>)}</select></label><label>Monitoring<select value={params.get('enabled') ?? ''} onChange={e => filter('enabled', e.target.value)}><option value="">All monitors</option><option value="true">Enabled</option><option value="false">Paused</option></select></label><label>Sort<select value={params.get('sort') ?? 'name'} onChange={e => filter('sort', e.target.value)}><option value="name">Name A–Z</option><option value="status">Health</option><option value="-updatedAt">Recently updated</option></select></label></div>{monitors.isError && <ErrorNotice error={monitors.error} retry={() => void monitors.refetch()}/>} {monitors.isPending ? <Loading /> : monitors.data?.data.length ? <><div className="table-scroll" role="region" aria-label="Monitors table" tabIndex={0}><table><thead><tr><th>Monitor / target</th><th>Status</th><th>Latest latency</th><th>24h availability</th><th>Last check</th><th>Actions</th></tr></thead><tbody>{monitors.data.data.map(m => <tr key={m.id}><td><Link className="resource-name" to={'/monitors/' + m.id}>{m.name}</Link><small className="target">{m.url}</small></td><td><Status state={m.status.state} paused={!m.enabled}/><small>{m.status.reason.replaceAll('_', ' ').toLowerCase()}</small></td><td className="mono">{ms(m.summary?.latestLatencyMs)}</td><td><span className="mono">{percent(m.summary?.sampledAvailabilityPercent)}</span><small>n={m.summary?.sampleCount ?? 0} · known {Math.round((m.summary?.knownMs ?? 0) / 1000)}s{m.summary?.coverageIncomplete ? ' · incomplete' : ''}</small></td><td><small>{time(m.lastCheckAt)}</small></td><td><div className="actions"><Link className="button secondary small" to={'/monitors/' + m.id}>Inspect →</Link><QuickToggle monitor={m}/></div></td></tr>)}</tbody></table></div><Pager next={monitors.data.page.nextCursor}/></> : <Empty title={params.get('q') || params.get('status') || params.get('enabled') ? 'No matching monitors' : 'Start with your first monitor'}>{params.get('q') || params.get('status') || params.get('enabled') ? <Link to="/">Clear filters</Link> : <>Add a website or API endpoint to start recording checks. <Link to="/monitors/new">Create a monitor →</Link></>}</Empty>}</Panel>
 <div className="split"><Panel title="Recent incidents" action={<Link to="/incidents">View all →</Link>}>{d?.recentIncidents.length ? <ul className="resource-list">{d.recentIncidents.map(i => <li key={i.id}><div><Link to={'/incidents/' + i.id}>{i.failureCategory.replaceAll('_', ' ')}</Link><small>Detected {time(i.detectedAt)}</small></div><Status state={i.status}/></li>)}</ul> : <Empty title="No incidents recorded">Confirmed outages will appear here.</Empty>}</Panel><Panel title="Recent status changes">{d?.recentTransitions.length ? <ul className="resource-list">{d.recentTransitions.map(t => <li key={t.id}><div><Link to={'/monitors/' + t.monitorId}>{t.fromState} → {t.toState}</Link><small>{time(t.occurredAt)} · {t.reason.replaceAll('_', ' ').toLowerCase()}</small></div></li>)}</ul> : <Empty title="Waiting for observations">Status changes appear after recorded checks.</Empty>}</Panel></div></>;
}
function QuickToggle({ monitor }: {
    monitor: Monitor;
}) {
    const client = useQueryClient(), mutation = useMutation({
        mutationFn: () => api('/monitors/' + monitor.id, single(monitorSchema), {
            method: 'PATCH', revision: monitor.revision, body: {
                enabled: !monitor.enabled
            }
        }), onSuccess: () => client.invalidateQueries()
    });
    return <><button className="secondary small" aria-label={(monitor.enabled ? 'Pause ' : 'Resume ') + monitor.name} disabled={mutation.isPending} onClick={() => mutation.mutate()}>{mutation.isPending ? 'Saving…' : monitor.enabled ? 'Pause' : 'Resume'}</button>{mutation.isError && <ErrorNotice error={mutation.error}/>}</>;
}
