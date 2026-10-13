import { lazy, Suspense, useState, useEffect } from 'react';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { z } from 'zod';
import { monitorSchema, executionSchema, metricsSchema, checkPageSchema, transitionPageSchema, incidentPageSchema } from '@pulse/contracts';
import { api, single, queryString } from '../../lib/api';
import { Confirm, Empty, ErrorNotice, Loading, PageTitle, Panel, Stats, Status, ms, percent, time, duration } from '../../components/ui';
const HistoryChart = lazy(() => import('../../components/HistoryChart'));
export default function MonitorDetail() {
    const { id } = useParams(), [params, setParams] = useSearchParams(), client = useQueryClient(), navigate = useNavigate(), [confirm, setConfirm] = useState(false), [deleting, setDeleting] = useState(false), [execution, setExecution] = useState<string | null>(null), [completed, setCompleted] = useState(false), [from, setFrom] = useState(params.get('from') ?? ''), [to, setTo] = useState(params.get('to') ?? ''), [rangeError, setRangeError] = useState('');
    const query = queryString({
        window: params.get('from') ? undefined : params.get('window') ?? '24h', from: params.get('from') ?? undefined, to: params.get('to') ?? undefined, bucket: params.get('from') || params.get('window') === '30d' ? '1d' : '1h'
    }), dateQuery = queryString({
        from: params.get('from') ?? undefined, to: params.get('to') ?? undefined
    });
    const monitor = useQuery({
        enabled: !deleting, queryKey: ['monitor', id], queryFn: ({ signal }) => api('/monitors/' + id, single(monitorSchema), {
            signal
        })
    }), metrics = useQuery({
        enabled: !deleting, queryKey: ['metrics', id, query], queryFn: ({ signal }) => api('/monitors/' + id + '/metrics' + query, single(metricsSchema), {
            signal
        })
    }), latest = useQuery({
        enabled: !deleting, queryKey: ['checks', id, 'latest'], queryFn: ({ signal }) => api('/monitors/' + id + '/checks?limit=1', checkPageSchema, {
            signal
        })
    }), checks = useQuery({
        enabled: !deleting, queryKey: ['checks', id, dateQuery], queryFn: ({ signal }) => api('/monitors/' + id + '/checks' + dateQuery, checkPageSchema, {
            signal
        })
    }), transitions = useQuery({
        enabled: !deleting, queryKey: ['transitions', id], queryFn: ({ signal }) => api('/monitors/' + id + '/transitions', transitionPageSchema, {
            signal
        })
    }), incidents = useQuery({
        enabled: !deleting, queryKey: ['incidents', id], queryFn: ({ signal }) => api('/incidents?monitorId=' + id, incidentPageSchema, {
            signal
        })
    }), activeIncidents = useQuery({
        enabled: !deleting, queryKey: ['incidents', id, 'open'], queryFn: ({ signal }) => api('/incidents?status=OPEN&monitorId=' + id, incidentPageSchema, {
            signal
        })
    });
    const refresh = () => client.invalidateQueries();
    const pause = useMutation({
        mutationFn: () => api('/monitors/' + id, single(monitorSchema), {
            method: 'PATCH', revision: monitor.data!.revision, body: {
                enabled: !monitor.data!.enabled
            }
        }), onSuccess: refresh
    }), remove = useMutation({
        onMutate: async () => {
            // Stop live refreshes before DELETE can commit and invalidate the still-mounted detail.
            setDeleting(true);
            await client.cancelQueries({ predicate: q => q.queryKey.includes(id) || (q.queryKey[0] === 'execution' && q.queryKey[1] === execution) });
        },
        mutationFn: () => api('/monitors/' + id + '?confirm=true', z.null(), {
            method: 'DELETE', revision: monitor.data!.revision
        }), onSuccess: () => {
            navigate('/');
            void client.invalidateQueries({
                predicate: q => !q.queryKey.includes(id) && q.queryKey[0] !== 'execution'
            });
        }, onError: () => { setDeleting(false); void refresh(); }
    }), check = useMutation({
        mutationFn: () => api('/monitors/' + id + '/checks', single(executionSchema), {
            method: 'POST', body: {}
        }), onSuccess: e => { setCompleted(false); setExecution(e.id); }
    }), pending = useQuery({
        queryKey: ['execution', execution], queryFn: ({ signal }) => api('/executions/' + execution, single(executionSchema), {
            signal
        }), enabled: !!execution && !deleting, refetchInterval: q => q.state.data && ['COMPLETED', 'CANCELLED', 'ABANDONED'].includes(q.state.data.lifecycle) ? false : 1000
    });
    useEffect(() => {
        if (pending.data && ['COMPLETED', 'CANCELLED', 'ABANDONED'].includes(pending.data.lifecycle) && !completed) {
            setCompleted(true);
            void client.invalidateQueries({
                predicate: q => q.queryKey[0] !== 'execution'
            });
        }
    }, [pending.data, completed, client]);
    if (monitor.isPending)
        return <Loading />;
    if (!monitor.data)
        return <ErrorNotice error={monitor.error} retry={() => void monitor.refetch()}/>;
    const m = monitor.data, v = metrics.data;
    const visibleIncidents = [...new Map([...(activeIncidents.data?.data ?? []), ...(incidents.data?.data ?? [])].map(incident => [incident.id, incident])).values()];
    const window = (value: string) => { const p = new URLSearchParams(); p.set('window', value); setParams(p); };
    return <><PageTitle eyebrow="MONITOR DETAIL" title={m.name} description={m.url} action={<Status state={m.status.state} paused={!m.enabled}/>}/><div className="actions"><button disabled={!m.enabled || check.isPending || (!!execution && !completed && !pending.isError)} onClick={() => check.mutate()}>Run check now</button><button className="secondary" disabled={pause.isPending} onClick={() => pause.mutate()}>{pause.isPending ? 'Saving…' : m.enabled ? 'Pause monitor' : 'Resume monitor'}</button><Link className="button secondary" to={'/monitors/' + id + '/edit'}>Edit configuration</Link><button className="danger quiet" onClick={() => setConfirm(true)}>Delete monitor</button></div>{[monitor, pause, remove, check, pending].filter(q => q.isError).map((q, i) => <ErrorNotice key={i} error={q.error} retry={() => void refresh()}/>)}{execution && <p role="status" className="notice">{completed ? 'Check ' + pending.data?.lifecycle.toLowerCase() + ': ' + (pending.data?.outcome ?? 'No target observation') : 'Immediate check accepted. Waiting for its stored result…'}</p>}
 <Stats items={[{
                label: 'Current health', value: <Status state={m.status.state}/>, hint: m.status.reason.replaceAll('_', ' ')
            }, {
                label: 'Latest response', value: ms(latest.data?.data[0]?.durationMs), hint: m.lastObservedOutcome ?? 'No observation'
            }, {
                label: 'Last check', value: <span className="stat-time">{time(m.lastCheckAt)}</span>, hint: 'Stored target observation'
            }, {
                label: 'Interval / timeout', value: (m.intervalMs / 1000) + 's / ' + (m.timeoutMs / 1000) + 's', hint: m.method + ' · ' + (m.enabled ? 'enabled' : 'paused')
            }]}/>
 <Panel title="Historical performance"><div className="filters range-filters"><label>Period<select aria-label="Historical period" value={params.get('from') ? 'custom' : params.get('window') ?? '24h'} onChange={e => e.target.value === 'custom' ? setParams({
            from: from || new Date(Date.now() - 86400000).toISOString(), to: to || new Date().toISOString()
        }) : window(e.target.value)}><option value="24h">24 hours</option><option value="7d">7 days</option><option value="30d">30 days</option><option value="custom">Custom range</option></select></label><label>From (local time)<input type="datetime-local" aria-label="From time" value={from ? localDate(from) : ''} onChange={e => setFrom(e.target.value ? new Date(e.target.value).toISOString() : '')}/></label><label>To (local time)<input type="datetime-local" aria-label="To time" value={to ? localDate(to) : ''} onChange={e => setTo(e.target.value ? new Date(e.target.value).toISOString() : '')}/></label><button className="secondary" onClick={() => {
            if (!from || !to || Date.parse(from) >= Date.parse(to) || Date.parse(to) > Date.now() || Date.parse(to) - Date.parse(from) > 90 * 86400000) {
                setRangeError('Choose a past range of at most 90 days, with start before end.');
                return;
            }
            setRangeError('');
            setParams({
                from, to
            });
        }}>Apply range</button></div>{rangeError && <p role="alert" className="notice error">{rangeError}</p>}{metrics.isError && <ErrorNotice error={metrics.error} retry={() => void metrics.refetch()}/>} {v ? <><Stats items={[{
                    label: 'Sampled availability', value: percent(v.sampledAvailabilityPercent), hint: 'n=' + v.sampleCount + ' · includes manual checks'
                }, {
                    label: 'Mean / P95 latency', value: ms(v.latency.meanMs) + ' / ' + ms(v.latency.p95Ms), hint: v.latency.p95Sufficient ? 'Nearest-rank · n=' + v.latency.count : 'Low tail granularity · n=' + v.latency.count
                }, {
                    label: 'Observed downtime', value: duration(v.observedDowntimeMs), hint: v.incidentCount + ' intersecting incidents'
                }, {
                    label: 'Known coverage', value: duration(v.coverage.knownMs), hint: 'Eligible ' + duration(v.coverage.eligibleMs)
                }]}/><p className="muted">Unknown: {duration(v.coverage.unknownMs)} · paused: {duration(v.coverage.pausedMs)} · service offline: {duration(v.coverage.serviceOfflineMs)}. {v.coverage.incomplete || v.sampleWindowIncomplete ? 'Retained history is incomplete. ' : ''}Missing samples never count as success.</p><Suspense fallback={<Loading />}><HistoryChart metrics={v}/></Suspense></> : metrics.isPending ? <Loading /> : null}</Panel>
 <div className="split"><Panel title="Health timeline">{transitions.isError ? <ErrorNotice error={transitions.error}/> : transitions.data?.data.length ? <ul className="timeline">{transitions.data.data.map(t => <li key={t.id}><strong>{t.fromState} → {t.toState}</strong><small>{time(t.occurredAt)} · {t.reason.replaceAll('_', ' ')}</small></li>)}</ul> : <Empty title="No status changes yet">Transitions appear when the stored health changes.</Empty>}</Panel><Panel title="Incidents">{incidents.isError || activeIncidents.isError ? <ErrorNotice error={incidents.error ?? activeIncidents.error}/> : visibleIncidents.length ? <ul className="resource-list">{visibleIncidents.map(i => <li key={i.id}><div><Link to={'/incidents/' + i.id}>{i.failureCategory}</Link><small>{time(i.detectedAt)} · {duration(i.durationMs)}{i.ongoing ? ' ongoing' : ''}</small></div><Status state={i.status}/></li>)}</ul> : <Empty title="No incidents in this view">Confirmed incidents from the last 90 days and all unresolved incidents appear here.</Empty>}</Panel></div>
 <Panel title="Recent individual checks">{checks.isError ? <ErrorNotice error={checks.error}/> : checks.data?.data.length ? <div className="table-scroll" role="region" aria-label="Recent checks" tabIndex={0}><table><thead><tr><th>Started</th><th>Result / category</th><th>HTTP status</th><th>Latency</th><th>Trigger</th></tr></thead><tbody>{checks.data.data.map(c => <tr key={c.id}><td>{time(c.startedAt ?? c.queuedAt)}</td><td>{c.outcome ?? c.lifecycle}</td><td>{c.httpStatus ?? '—'}</td><td>{ms(c.durationMs)}</td><td>{c.trigger}</td></tr>)}</tbody></table></div> : <Empty title="No checks in this period">Run a check or wait for the next scheduled observation.</Empty>}</Panel><Panel title="Monitoring configuration"><dl className="config-grid">{[['Method', m.method], ['Expected status', m.expectedStatusCodes.join(', ')], ['Failure threshold', m.failureThreshold], ['Recovery threshold', m.recoveryThreshold], ['Slow threshold', ms(m.latencyThresholdMs)], ['Degradation threshold', m.degradationThreshold], ['Follow redirects', m.followRedirects ? 'Yes, up to 3' : 'No'], ['Revision', m.revision], ['Next due', time(m.nextDueAt)]].map(([k, value]) => <div key={k}><dt>{k}</dt><dd>{value}</dd></div>)}</dl></Panel>{confirm && <Confirm name={m.name} description="This permanently deletes this monitor and its checks, incidents, transitions and related delivery history." pending={remove.isPending} onCancel={() => setConfirm(false)} onConfirm={() => remove.mutate()}/>}</>;
}
function localDate(iso: string) { const date = new Date(iso); return new Date(date.getTime() - date.getTimezoneOffset() * 60000).toISOString().slice(0, 16); }
