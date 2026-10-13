import { it, expect } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { Status, ms, percent, time, duration, ErrorNotice } from '../apps/web/src/components/ui.js';
import { ApiError } from '../apps/web/src/lib/api.js';
import { destinationPatchSchema } from '@pulse/contracts';
import HistoryChart from '../apps/web/src/components/HistoryChart.js';
import { fixture, epoch } from './reliability-helpers.js';
it('absent measurements stay absent, zero measurements remain zero and statuses have text beyond color', () => {
    expect(ms(null)).toBe('—');
    expect(ms(0)).toBe('0 ms');
    expect(percent(null)).toBe('No samples');
    expect(percent(0)).toBe('0.00%');
    expect(time(null)).toBe('Not observed');
    expect(duration(null)).toBe('Not observed');
    for (const state of ['UP', 'DOWN', 'UNKNOWN', 'DEGRADED'])
        expect(renderToStaticMarkup(createElement(Status, {
            state
        }))).toContain('>' + state + '</span>');
    expect(renderToStaticMarkup(createElement(Status, {
        state: 'DOWN', paused: true
    }))).toContain('PAUSED');
});
it('safe errors retain a request ID without rendering target content, and destination edits preserve omitted settings', () => {
    const html = renderToStaticMarkup(createElement(ErrorNotice, {
        error: new ApiError('REVISION_CONFLICT', 409, 'safe-id')
    }));
    expect(html).toContain('Reload the current version');
    expect(html).toContain('safe-id');
    expect(destinationPatchSchema.parse({
        name: 'Renamed'
    })).toEqual({
        name: 'Renamed'
    });
    expect(destinationPatchSchema.parse({
        enabled: false
    })).toEqual({
        enabled: false
    });
});
it('the rendered chart breaks latency lines across unknown covered-health gaps and exposes its real samples as a table', async () => {
    const f = await fixture();
    try {
        const m = f.create();
        f.check(m.id);
        const metrics = f.s.execute('metrics', {
            id: m.id, now: f.now, query: {}
        });
        const bucket = metrics.buckets.at(-1)!;
        metrics.buckets = [0, 1, 2].map(i => ({
            ...bucket, start: new Date(epoch + i * 1000).toISOString(), end: new Date(epoch + (i + 1) * 1000).toISOString(), meanLatency: 100, knownMs: i === 1 ? 0 : 1000
        }));
        const html = renderToStaticMarkup(createElement(HistoryChart, {
            metrics
        }));
        const path = /<path d="([^"]+)" class="chart-line"/.exec(html)?.[1];
        expect(path).toBeDefined();
        expect(path).not.toContain('L');
        expect(html).toContain('Chart data table');
        expect(html).toContain('100 ms');
        expect(html.match(/<circle /g)).toHaveLength(3);
    }
    finally {
        await f.close();
    }
});
