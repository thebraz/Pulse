import { StrictMode, lazy, Suspense, useEffect, useState, type FormEvent } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter, Routes, Route, NavLink, Link, useLocation, useNavigate } from 'react-router-dom';
import { QueryClient, QueryClientProvider, useQuery, useQueryClient } from '@tanstack/react-query';
import { z } from 'zod';
import { api, session, login, clearSession, ApiError, message } from './lib/api';
import { useLive } from './app/live';
import { Empty, Loading, ErrorNotice, time } from './components/ui';
import './styles.css';
const Dashboard = lazy(() => import('./features/dashboard/Dashboard'));
const MonitorForm = lazy(() => import('./features/monitors/MonitorForm'));
const MonitorDetail = lazy(() => import('./features/monitors/MonitorDetail'));
const Incidents = lazy(() => import('./features/incidents/Incidents'));
const IncidentDetail = lazy(() => import('./features/incidents/Incidents').then(m => ({
    default: m.IncidentDetail
})));
const Notifications = lazy(() => import('./features/notifications/Notifications'));
const Settings = lazy(() => import('./features/settings/Settings'));
const client = new QueryClient({
    defaultOptions: {
        queries: {
            staleTime: 10000, gcTime: 60000, retry: false, refetchOnWindowFocus: true
        }, mutations: {
            retry: false
        }
    }
});
function App() {
    const current = useQuery({
        queryKey: ['session'], queryFn: ({ signal }) => session(signal), retry: false, staleTime: Infinity
    }), queryClient = useQueryClient(), location = useLocation(), navigate = useNavigate();
    useEffect(() => {
        const expired = () => {
            queryClient.clear();
            void queryClient.invalidateQueries({
                queryKey: ['session']
            });
            navigate('/login', {
                replace: true
            });
        };
        window.addEventListener('pulse:unauthorized', expired);
        return () => window.removeEventListener('pulse:unauthorized', expired);
    }, [queryClient, navigate]);
    useEffect(() => { document.querySelector('h1')?.focus(); }, [location.pathname]);
    if (current.isPending)
        return <Loading />;
    if (current.error instanceof ApiError && current.error.status === 401 || location.pathname === '/login')
        return <Login />;
    if (current.isError)
        return <div className="login-card"><h1>Pulse is unavailable</h1><p role="alert">{message(current.error)}</p><button onClick={() => void current.refetch()}>Retry connection</button></div>;
    return <Layout authenticated={current.data?.mode === 'authenticated'}/>;
}
function Login() {
    const [token, setToken] = useState(''), [error, setError] = useState(''), [pending, setPending] = useState(false), navigate = useNavigate(), queryClient = useQueryClient();
    const submit = async (e: FormEvent) => {
        e.preventDefault();
        setPending(true);
        setError('');
        try {
            const data = await login(token);
            setToken('');
            queryClient.setQueryData(['session'], data);
            navigate('/', {
                replace: true
            });
        }
        catch (e) {
            setError(message(e));
        }
        finally {
            setPending(false);
        }
    };
    return <main className="login-card"><Logo /><h1>Welcome to Pulse.</h1><p className="muted">Use your administrator-provisioned operator token to sign in. It is exchanged for an HttpOnly session and never saved in browser storage.</p><form onSubmit={e => void submit(e)}><label>Operator token<input type="password" autoComplete="off" value={token} onChange={e => setToken(e.target.value)} required/></label>{error && <p className="notice error" role="alert">{error}</p>}<button disabled={pending}>{pending ? 'Signing in…' : 'Sign in'}</button></form></main>;
}
function Logo() { return <span className="logo"><svg viewBox="0 0 32 32" aria-hidden="true"><path d="M2 17h6l4-11 7 21 4-10h7"/></svg>pulse<span className="logo-dot">.</span></span>; }
function Layout({ authenticated }: {
    authenticated: boolean;
}) {
    const live = useLive(), location = useLocation(), navigate = useNavigate(), queryClient = useQueryClient(), [logoutError, setLogoutError] = useState<unknown>(null);
    const logout = async () => {
        setLogoutError(null);
        try {
            await api('/session', z.null(), {
                method: 'DELETE'
            });
            clearSession();
            queryClient.clear();
            navigate('/login');
        }
        catch (error) {
            setLogoutError(error);
        }
    };
    return <div className="app-shell"><a className="skip-link" href="#content">Skip to main content</a><aside className="sidebar"><Link to="/" aria-label="Pulse dashboard"><Logo /></Link><span className="sidebar-label">WORKSPACE</span><nav aria-label="Main navigation"><NavLink to="/" end><span aria-hidden="true">▦</span>Overview</NavLink><NavLink to="/incidents"><span aria-hidden="true">◷</span>Incidents</NavLink><NavLink to="/settings/notifications"><span aria-hidden="true">♧</span>Notifications</NavLink><NavLink to="/settings" end><span aria-hidden="true">⚙</span>Settings</NavLink></nav><div className="sidebar-bottom"><div className="local-badge"><span className="status-dot"/>Self-hosted instance</div><p>Monitoring that stays yours.</p><small>Pulse v0.1.0-beta.1 · Experimental</small>{authenticated && <button className="secondary" onClick={() => void logout()}>Sign out</button>}</div></aside><div className="workspace"><div className="topbar"><span><span className="muted">Workspace</span><span aria-hidden="true"> / </span>{location.pathname.includes('incidents') ? 'Incidents' : location.pathname.includes('settings') ? 'Settings' : location.pathname.includes('monitors') ? 'Monitors' : 'Overview'}</span><div className={'live-badge ' + (live.stale ? 'stale' : '')} role="status"><span className="status-dot"/>{live.stale ? 'Stale · reconnecting' : 'Live updates'}<span className="last-refresh"> · refreshed {time(new Date(live.lastSuccess).toISOString())}</span></div></div>{live.stale && <p className="stale-banner" role="status">Connection interrupted. Showing last known observations. Pulse will refetch after reconnection; unknown data remains unknown.</p>}<main id="content" tabIndex={-1}>{logoutError != null && <ErrorNotice error={logoutError}/>}<Suspense fallback={<Loading />}><Routes><Route path="/" element={<Dashboard />}/><Route path="/monitors/new" element={<MonitorForm />}/><Route path="/monitors/:id" element={<MonitorDetail />}/><Route path="/monitors/:id/edit" element={<MonitorForm />}/><Route path="/incidents" element={<Incidents />}/><Route path="/incidents/:id" element={<IncidentDetail />}/><Route path="/settings/notifications" element={<Notifications />}/><Route path="/settings" element={<Settings />}/><Route path="*" element={<Empty title="Page not found"><Link to="/">Return to the overview</Link></Empty>}/></Routes></Suspense></main><footer>Pulse · Local observations, honest signals.<span>All times shown in your browser timezone.</span></footer></div></div>;
}
createRoot(document.getElementById('root')!).render(<StrictMode><QueryClientProvider client={client}><BrowserRouter><App /></BrowserRouter></QueryClientProvider></StrictMode>);
