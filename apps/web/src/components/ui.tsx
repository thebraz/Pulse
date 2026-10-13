import { useEffect, useRef, type ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { message } from '../lib/api.js';
export const ms = (value: number | null | undefined) => value == null ? '—' : value.toLocaleString('en', {
    maximumFractionDigits: 1
}) + ' ms';
export const percent = (value: number | null | undefined) => value == null ? 'No samples' : value.toFixed(2) + '%';
export const time = (value: string | null | undefined) => value ? new Date(value).toLocaleString('en', {
    dateStyle: 'medium', timeStyle: 'medium'
}) : 'Not observed';
export const duration = (value: number | null | undefined) => value == null ? 'Not observed' : value < 1000 ? Math.round(value) + ' ms' : value < 60000 ? (value / 1000).toFixed(1) + ' sec' : value < 3600000 ? (value / 60000).toFixed(1) + ' min' : (value / 3600000).toFixed(1) + ' hr';
export function Status({ state, paused = false }: {
    state: string;
    paused?: boolean;
}) { return <span className={'status status-' + (paused ? 'PAUSED' : state)}><span aria-hidden="true" className="status-dot"/>{paused ? 'PAUSED' : state}</span>; }
export function PageTitle({ eyebrow, title, description, action }: {
    eyebrow: string;
    title: string;
    description: string;
    action?: ReactNode;
}) { return <header className="page-title"><div><p className="eyebrow">{eyebrow}</p><h1 tabIndex={-1}>{title}</h1><p className="muted">{description}</p></div>{action}</header>; }
export function Panel({ title, children, action }: {
    title: string;
    children: ReactNode;
    action?: ReactNode;
}) { return <section className="panel"><div className="panel-heading"><h2>{title}</h2>{action}</div>{children}</section>; }
export function ErrorNotice({ error, retry }: {
    error: unknown;
    retry?: () => void;
}) { return <div className="notice error" role="alert"><p>{message(error)}</p>{retry && <button onClick={retry}>Retry</button>}</div>; }
export function Empty({ title, children }: {
    title: string;
    children: ReactNode;
}) { return <div className="empty"><span aria-hidden="true" className="empty-symbol">⌁</span><h3>{title}</h3><p className="muted">{children}</p></div>; }
export function Loading() { return <div role="status" className="notice">Loading current data…</div>; }
export function Stats({ items }: {
    items: {
        label: string;
        value: ReactNode;
        hint?: string;
        className?: string;
    }[];
}) { return <div className="stats">{items.map(item => <article className={'stat ' + (item.className ?? '')} key={item.label}><span className="muted">{item.label}</span><strong>{item.value}</strong>{item.hint && <small className="muted">{item.hint}</small>}</article>)}</div>; }
export function Pager({ next }: {
    next: string | null | undefined;
}) { return <div className="pagination"><Link className="button secondary" to="?">First page</Link>{next && <PageNext next={next}/>}</div>; }
import { useSearchParams } from 'react-router-dom';
function PageNext({ next }: {
    next: string;
}) { const [params, setParams] = useSearchParams(); return <button onClick={() => { const p = new URLSearchParams(params); p.set('cursor', next); setParams(p); }}>Next page →</button>; }
export function Confirm({ name, description, onConfirm, onCancel, pending }: {
    name: string;
    description: string;
    onConfirm: () => void;
    onCancel: () => void;
    pending: boolean;
}) {
    const ref = useRef<HTMLDialogElement>(null);
    useEffect(() => {
        const previous = document.activeElement;
        ref.current?.showModal();
        return () => {
            ref.current?.close();
            if (previous instanceof HTMLElement)
                previous.focus();
        };
    }, []);
    return <dialog ref={ref} onCancel={e => {
            e.preventDefault();
            if (!pending)
                onCancel();
        }} aria-labelledby="confirm-title"><h2 id="confirm-title">Delete {name}?</h2><p>{description}</p><div className="actions"><button autoFocus className="secondary" disabled={pending} onClick={onCancel}>Cancel</button><button className="danger" disabled={pending} onClick={onConfirm}>{pending ? 'Deleting…' : 'Delete permanently'}</button></div></dialog>;
}
