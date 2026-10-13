import { useQuery } from '@tanstack/react-query';
import { configurationSchema, engineSchema } from '@pulse/contracts';
import { z } from 'zod';
import { Link } from 'react-router-dom';
import { api, single } from '../../lib/api';
import { ErrorNotice, Loading, PageTitle, Panel, Stats, time } from '../../components/ui';
export default function Settings() {
    const config = useQuery({
        queryKey: ['configuration'], queryFn: ({ signal }) => api('/configuration', single(configurationSchema), {
            signal
        })
    }), engine = useQuery({
        queryKey: ['engine'], queryFn: ({ signal }) => api('/engine', single(engineSchema), {
            signal
        })
    }), notifications = useQuery({
        queryKey: ['notification-diagnostics'], queryFn: ({ signal }) => api('/notifications/diagnostics', single(z.strictObject({
            pending: z.number(), inFlight: z.number(), succeeded: z.number(), dead: z.number(), cancelled: z.number(), oldestPendingAgeMs: z.number(), workerFailure: z.string().nullable()
        })), {
            signal
        })
    }), health = useQuery({
        queryKey: ['ready'], queryFn: async ({ signal }) => {
            const response = await fetch('/health/ready', {
                signal
            });
            if (!response.ok)
                throw new Error('Not ready');
            return z.strictObject({
                status: z.literal('ready')
            }).parse(await response.json());
        }
    });
    return <><PageTitle eyebrow="APPLICATION SETTINGS" title="A clear view of your instance." description="Read-only startup configuration and live application diagnostics."/>{[config, engine, notifications, health].filter(q => q.isError).map((q, i) => <ErrorNotice key={i} error={q.error} retry={() => { void config.refetch(); void engine.refetch(); void health.refetch(); }}/>)}{config.isPending ? <Loading /> : config.data && <><Stats items={[{
                    label: 'Backend health', value: health.data?.status ?? 'Unavailable', hint: 'Database write path checked'
                }, {
                    label: 'Exposure', value: config.data.exposure, hint: config.data.exposure === 'local' ? 'Restricted to loopback' : 'Authentication required · HTTPS proxy'
                }, {
                    label: 'Outbound policy', value: config.data.egressPolicy, hint: 'DNS and actual socket address validated'
                }, {
                    label: 'Version', value: config.data.version, hint: 'Self-hosted · single operator'
                }]}/><Panel title="Configuration"><dl className="config-grid">{[['Check concurrency', config.data.checkConcurrency], ['Manual queue limit', config.data.manualQueueLimit], ['Check retention', config.data.retention.checksDays + ' days'], ['Incident retention', config.data.retention.incidentsDays + ' days'], ['Delivery retention', config.data.retention.deliveriesDays + ' days']].map(([label, value]) => <div key={label}><dt>{label}</dt><dd>{value}</dd></div>)}</dl><p className="muted">Startup configuration is validated and immutable until restart. Filesystem paths, secret aliases and private allowlists are hidden.</p></Panel></>}{engine.data && <Panel title="Engine and database"><dl className="config-grid">{Object.entries(engine.data).map(([key, value]) => <div key={key}><dt>{key.replace(/([A-Z])/g, ' $1')}</dt><dd>{key === 'asOf' ? time(String(value)) : value == null ? 'None' : String(value)}</dd></div>)}</dl></Panel>}{notifications.data && <Panel title="Notification diagnostics"><dl className="config-grid">{Object.entries(notifications.data).map(([key, value]) => <div key={key}><dt>{key.replace(/([A-Z])/g, ' $1')}</dt><dd>{value == null ? 'None' : String(value)}</dd></div>)}</dl><Link to="/settings/notifications">Manage destinations and deliveries →</Link></Panel>}<p className="notice">Keep storage on a local disk. Do not copy a live SQLite file without its WAL. Stop Pulse before an offline backup and verify the snapshot before restoration. Production capacity remains subject to measured release gates.</p></>;
}
