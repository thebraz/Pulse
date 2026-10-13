import { afterEach, expect, it, vi } from 'vitest';
import { useEffect } from 'react';
import { QueryClient, QueryObserver, useQueryClient } from '@tanstack/react-query';
import { useLive } from '../apps/web/src/app/live.js';

vi.mock('react', () => ({ useEffect: vi.fn(), useState: vi.fn((value: unknown) => [value, vi.fn()]) }));
vi.mock('@tanstack/react-query', async () => ({
    ...await vi.importActual<typeof import('@tanstack/react-query')>('@tanstack/react-query'), useQueryClient: vi.fn()
}));

afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers(); vi.clearAllMocks(); });

it('live bursts do not abort slow reads and preserve one trailing refresh after completion', async () => {
    vi.useFakeTimers();
    const document = Object.assign(new EventTarget(), { hidden: false });
    const window = new EventTarget();
    class Source extends EventTarget {
        static current: Source;
        onopen: (() => void) | null = null;
        onerror: (() => void) | null = null;
        close = vi.fn();
        constructor() { super(); Source.current = this; }
    }
    vi.stubGlobal('document', document);
    vi.stubGlobal('window', window);
    vi.stubGlobal('navigator', { onLine: true });
    vi.stubGlobal('EventSource', Source);
    const client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } });
    vi.mocked(useQueryClient).mockReturnValue(client);
    const pending: { resolve: (value: number) => void; signal: AbortSignal }[] = [];
    const observer = new QueryObserver(client, {
        queryKey: ['dashboard'], initialData: 0,
        queryFn: ({ signal }) => new Promise<number>(resolve => { pending.push({ resolve, signal }); })
    });
    const unsubscribe = observer.subscribe(() => undefined);
    useLive();
    const cleanup = vi.mocked(useEffect).mock.calls[0]![0]();
    const event = () => Source.current.dispatchEvent(new MessageEvent('invalidate', {
        data: JSON.stringify({ version: 1, resource: 'monitors', ids: [], occurredAt: new Date().toISOString() })
    }));
    try {
        Source.current.onopen!();
        await vi.advanceTimersByTimeAsync(250);
        expect(pending).toHaveLength(1);
        for (let i = 0; i < 4; i++) { event(); await vi.advanceTimersByTimeAsync(1000); }
        expect(pending).toHaveLength(1);
        expect(pending[0]!.signal.aborted).toBe(false);
        pending[0]!.resolve(1);
        await vi.advanceTimersByTimeAsync(0);
        expect(client.getQueryData(['dashboard'])).toBe(1);
        await vi.advanceTimersByTimeAsync(250);
        expect(pending).toHaveLength(2);
        event();
        if (typeof cleanup === 'function') cleanup();
        expect(Source.current.close).toHaveBeenCalledOnce();
        pending[1]!.resolve(2);
        await vi.advanceTimersByTimeAsync(30000);
        expect(pending).toHaveLength(2);
        expect(pending[1]!.signal.aborted).toBe(false);
        expect(client.getQueryData(['dashboard'])).toBe(2);
    }
    finally {
        if (typeof cleanup === 'function') cleanup();
        unsubscribe(); client.clear();
    }
});
