import { useEffect, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { invalidationSchema } from '@pulse/contracts';
export function useLive() {
    const client = useQueryClient(), [connected, setConnected] = useState(false), [lastSuccess, setLastSuccess] = useState(Date.now()), [now, setNow] = useState(Date.now());
    useEffect(() => {
        let source: EventSource | null = null, flush: ReturnType<typeof setTimeout> | null = null, lastFlush = 0, dirty = false, refreshing = false, disposed = false;
        const invalidate = async () => {
            if (!dirty || document.hidden || refreshing || disposed)
                return;
            dirty = false;
            lastFlush = Date.now();
            refreshing = true;
            try {
                // SQLite work cannot be cancelled by aborting its HTTP response.
                await client.invalidateQueries({
                    predicate: q => q.queryKey[0] !== 'session', refetchType: 'active'
                }, { cancelRefetch: false });
            }
            finally {
                refreshing = false;
                if (dirty && !disposed)
                    schedule();
            }
        };
        const schedule = () => {
            dirty = true;
            if (!flush && !refreshing && !disposed)
                flush = setTimeout(() => {
                    flush = null;
                    void invalidate();
                }, Math.max(250, 1000 - (Date.now() - lastFlush)));
        };
        const open = () => {
            source?.close();
            if (document.hidden || !navigator.onLine) {
                setConnected(false);
                return;
            }
            source = new EventSource('/api/v1/events');
            source.onopen = () => { setConnected(true); schedule(); };
            source.onerror = () => setConnected(false);
            source.addEventListener('invalidate', event => {
                try {
                    if (invalidationSchema.safeParse(JSON.parse((event as MessageEvent<string>).data)).success)
                        schedule();
                }
                catch { /* Malformed invalidations never replace API data. */ }
            });
        };
        const visible = () => {
            if (document.hidden) {
                source?.close();
                setConnected(false);
            }
            else {
                open();
                schedule();
            }
        };
        open();
        document.addEventListener('visibilitychange', visible);
        const focus = () => schedule();
        window.addEventListener('focus', focus);
        const offline = () => { source?.close(); setConnected(false); };
        const online = () => { open(); schedule(); };
        window.addEventListener('offline', offline);
        window.addEventListener('online', online);
        const polling = setInterval(() => {
            if (!document.hidden)
                schedule();
        }, 30000), clock = setInterval(() => setNow(Date.now()), 1000);
        const unsubscribe = client.getQueryCache().subscribe(event => {
            if (event.type === 'updated' && event.query.state.status === 'success' && event.query.queryKey[0] !== 'session')
                setLastSuccess(event.query.state.dataUpdatedAt);
        });
        return () => {
            disposed = true;
            dirty = false;
            source?.close();
            if (flush)
                clearTimeout(flush);
            clearInterval(polling);
            clearInterval(clock);
            unsubscribe();
            document.removeEventListener('visibilitychange', visible);
            window.removeEventListener('focus', focus);
            window.removeEventListener('offline', offline);
            window.removeEventListener('online', online);
        };
    }, [client]);
    return {
        connected, stale: !connected || now - lastSuccess > 60000, lastSuccess
    };
}
