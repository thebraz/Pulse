import { AxeBuilder } from '@axe-core/playwright';
import { test, expect } from './fixture.js';
import type { Page } from '@playwright/test';
test.describe('unresolved historical incidents', () => {
    test.use({ oldIncident: true });
    test('monitor detail retains an open incident older than the default 90-day history window', async ({ page, pulse }) => {
        await page.goto(pulse.origin + '/monitors/' + pulse.oldIncidentMonitorId);
        await expect(page.getByRole('heading', { name: 'Long unresolved outage', exact: true })).toBeVisible();
        await expect(page.locator('.status-OPEN')).toBeVisible();
        await expect(page.getByRole('link', { name: 'HTTP_ERROR', exact: true })).toBeVisible();
    });
});
async function create(page: Page, url: string, name = 'Local API') {
    await page.getByRole('link', {
        name: '＋ Create monitor'
    }).click();
    await page.getByLabel('Monitor name', {
        exact: true
    }).fill(name);
    await page.getByLabel('Target URL').fill(url);
    await page.getByLabel('Interval (ms)', {
        exact: true
    }).fill('15000');
    await page.getByLabel('Timeout (ms)', {
        exact: true
    }).fill('1000');
    await page.getByLabel('Failure threshold', {
        exact: true
    }).fill('1');
    await page.getByLabel('Recovery threshold', {
        exact: true
    }).fill('1');
    await page.getByRole('button', {
        name: 'Create monitor', exact: true
    }).click();
    await expect(page).toHaveURL(/\/monitors\/[0-9a-f-]+$/);
    await expect(page.getByRole('heading', {
        name, exact: true
    })).toBeVisible();
}
test('complete real browser workflow: create, observe, outage, recovery, notify, restart and manage', async ({ page, pulse }) => {
    await page.goto(pulse.origin);
    await expect(page.getByText('Pulse v0.1.0-beta.1 · Experimental', { exact: true })).toBeVisible();
    const errors: string[] = [];
    page.on('pageerror', error => errors.push(error.message));
    page.on('console', m => {
        if (m.type() === 'error')
            errors.push(m.text());
    });
    await page.goto(pulse.origin);
    await expect(page.getByRole('heading', {
        name: 'Start with your first monitor'
    })).toBeVisible();
    await create(page, pulse.targetUrl);
    const id = page.url().split('/').at(-1)!;
    await expect(page.locator('.status-UP').first()).toBeVisible();
    await expect(page.getByRole('img', {
        name: 'Historical response latency'
    })).toBeVisible();
    await page.getByLabel('Historical period').selectOption('7d');
    await expect(page).toHaveURL(/window=7d/);
    await page.getByLabel('Historical period').selectOption('30d');
    await expect(page).toHaveURL(/window=30d/);
    const localDate = (date: Date) => new Date(date.getTime() - date.getTimezoneOffset() * 60000).toISOString().slice(0, 19);
    await page.getByLabel('From time').fill(localDate(new Date(Date.now() - 86400000)));
    await page.getByLabel('To time').fill(localDate(new Date(Date.now() - 1000)));
    await page.getByRole('button', {
        name: 'Apply range'
    }).click();
    await expect(page).toHaveURL(/from=/);
    await expect(page.getByRole('img', {
        name: 'Historical response latency'
    })).toBeVisible();
    await page.getByRole('link', {
        name: 'Notifications', exact: true
    }).click();
    await page.getByLabel('Destination name').fill('Operations');
    await page.getByLabel('URL file alias').fill('ops');
    await page.getByLabel('Signing key alias (optional)').fill('ops');
    await page.getByRole('button', {
        name: 'Add destination', exact: true
    }).click();
    await expect(page.getByText('Destination saved.', {
        exact: false
    })).toBeVisible();
    await page.getByRole('button', {
        name: 'Send test', exact: true
    }).click();
    await expect.poll(() => pulse.receipts.filter(r => r.type === 'notification.test').length).toBe(1);
    await expect(page.getByText('Receiver acknowledged', {
        exact: true
    })).toBeVisible();
    await page.goto(pulse.origin + '/monitors/' + id);
    pulse.setFailure(true);
    await page.getByRole('button', {
        name: 'Run check now'
    }).click();
    await expect(page.locator('.status-DOWN').first()).toBeVisible();
    await expect.poll(() => pulse.receipts.filter(r => r.type === 'incident.opened').length).toBe(1);
    await page.getByRole('link', {
        name: 'Overview', exact: true
    }).click();
    await expect(page.locator('.stat').filter({
        hasText: /^Down/
    }).locator('strong')).toHaveText('1');
    await page.getByRole('link', {
        name: 'Incidents', exact: true
    }).click();
    await page.getByRole('link', {
        name: 'Investigate →'
    }).first().click();
    await expect(page.getByText('Not yet observed', {
        exact: true
    })).toHaveCount(2);
    await expect(page.getByText('Excluded gaps', {
        exact: true
    })).toBeVisible();
    await page.goto(pulse.origin + '/monitors/' + id);
    pulse.setFailure(false);
    await page.getByRole('button', {
        name: 'Run check now'
    }).click();
    await expect(page.locator('.status-UP').first()).toBeVisible();
    await expect.poll(() => pulse.receipts.filter(r => r.type === 'incident.resolved').length).toBe(1);
    const metrics = await (await page.request.get(pulse.origin + '/api/v1/monitors/' + id + '/metrics')).json() as {
        data: {
            sampleCount: number;
            sampledAvailabilityPercent: number;
        };
    };
    expect(metrics.data.sampleCount).toBeGreaterThanOrEqual(3);
    expect(metrics.data.sampledAvailabilityPercent).toBeLessThan(100);
    await page.getByRole('button', {
        name: 'Pause monitor'
    }).click();
    await expect(page.getByRole('button', {
        name: 'Resume monitor'
    })).toBeVisible();
    await page.getByRole('button', {
        name: 'Resume monitor'
    }).click();
    await page.getByRole('link', {
        name: 'Edit configuration'
    }).click();
    await page.getByLabel('Monitor name', {
        exact: true
    }).fill('Renamed API');
    await page.getByRole('button', {
        name: 'Save changes'
    }).click();
    await expect(page.getByRole('heading', {
        name: 'Renamed API', exact: true
    })).toBeVisible();
    await page.reload();
    await expect(page.getByRole('heading', {
        name: 'Renamed API', exact: true
    })).toBeVisible();
    await pulse.restart();
    await page.evaluate(() => window.dispatchEvent(new Event('focus')));
    await expect(page.getByText('Live updates', {
        exact: false
    })).toBeVisible();
    await page.reload();
    await expect(page.getByRole('heading', {
        name: 'Renamed API', exact: true
    })).toBeVisible();
    expect(pulse.receipts.filter(r => r.type === 'incident.opened')).toHaveLength(1);
    expect(pulse.receipts.filter(r => r.type === 'incident.resolved')).toHaveLength(1);
    await page.getByRole('button', {
        name: 'Delete monitor', exact: true
    }).click();
    await expect(page.getByRole('dialog')).toBeVisible();
    await page.getByRole('button', {
        name: 'Cancel', exact: true
    }).press('Enter');
    await expect(page.getByRole('dialog')).toHaveCount(0);
    await page.getByRole('button', {
        name: 'Delete monitor', exact: true
    }).click();
    let deleteCommitted = false;
    const readsAfterDelete: string[] = [];
    page.on('request', request => { if (deleteCommitted && request.method() === 'GET' && request.url().includes(id)) readsAfterDelete.push(new URL(request.url()).pathname); });
    await page.route('**/api/v1/monitors/' + id + '?confirm=true', async route => {
        const response = await route.fetch();
        expect(response.status()).toBe(204);
        deleteCommitted = true;
        await page.evaluate(() => window.dispatchEvent(new Event('focus')));
        // Hold the successful response through the live invalidation's maximum 1s coalescing window.
        await new Promise(resolve => setTimeout(resolve, 1250));
        await route.fulfill({ response });
    });
    await page.getByRole('button', {
        name: 'Delete permanently'
    }).press('Enter');
    await expect(page.getByRole('heading', {
        name: 'Start with your first monitor'
    })).toBeVisible();
    expect(readsAfterDelete).toEqual([]);
    expect(errors.filter(e => !e.includes('ERR_CONNECTION_REFUSED') && !e.includes('Failed to fetch'))).toEqual([]);
});
for (const width of [360, 768, 1440])
    test(`responsive, keyboard and accessibility at ${width}px`, async ({ page, pulse }) => {
        await page.setViewportSize({
            width, height: 1000
        });
        await page.goto(pulse.origin);
        await create(page, pulse.targetUrl);
        await page.getByRole('button', {
            name: 'Run check now'
        }).focus();
        await page.keyboard.press('Enter');
        await expect(page.getByText(/Check completed:/)).toBeVisible();
        await page.getByRole('link', {
            name: 'Edit configuration'
        }).focus();
        await page.keyboard.press('Enter');
        await expect(page.getByLabel('Monitor name', {
            exact: true
        })).toBeVisible();
        await page.getByLabel('Monitor name', {
            exact: true
        }).fill('Keyboard API');
        await page.getByRole('button', {
            name: 'Save changes'
        }).focus();
        await page.keyboard.press('Enter');
        await expect(page.getByRole('heading', {
            name: 'Keyboard API', exact: true
        })).toBeVisible();
        await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
        const a11y = await new AxeBuilder({
            page
        }).analyze();
        expect(a11y.violations.filter(v => ['serious', 'critical'].includes(v.impact ?? ''))).toEqual([]);
        await page.screenshot({
            path: `docs/evidence/${process.env.TEST_EVIDENCE_PREFIX ?? 'stage-3'}-detail-${width}.png`, fullPage: true
        });
        await page.getByRole('link', {
            name: 'Overview', exact: true
        }).click();
        const overview = await new AxeBuilder({
            page
        }).analyze();
        expect(overview.violations.filter(v => ['serious', 'critical'].includes(v.impact ?? ''))).toEqual([]);
        await page.getByRole('button', {
            name: 'Pause Keyboard API', exact: true
        }).click();
        await expect(page.locator('.status-PAUSED')).toBeVisible();
        await page.getByRole('button', {
            name: 'Resume Keyboard API', exact: true
        }).click();
        await page.screenshot({
            path: `docs/evidence/${process.env.TEST_EVIDENCE_PREFIX ?? 'stage-3'}-dashboard-${width}.png`, fullPage: true
        });
        if (width === 1440) {
            await page.evaluate(() => { document.documentElement.style.zoom = '2'; });
            await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
            await expect(page.getByRole('link', {
                name: '＋ Create monitor'
            })).toBeVisible();
        }
    });
test('invalid draft and revision conflicts retain user input; search, pagination and API errors recover', async ({ page, pulse }) => {
    await page.goto(pulse.origin);
    await page.getByRole('link', {
        name: '＋ Create monitor'
    }).click();
    await page.getByLabel('Monitor name', {
        exact: true
    }).fill('Invalid draft');
    await page.getByLabel('Target URL').fill('javascript:alert(1)');
    await page.getByRole('button', {
        name: 'Create monitor', exact: true
    }).click();
    await expect(page.getByText('Correct the highlighted fields before saving.')).toBeVisible();
    await expect(page.getByLabel('Target URL')).toBeFocused();
    await page.getByLabel('Target URL').fill(pulse.targetUrl);
    await page.getByRole('button', {
        name: 'Create monitor', exact: true
    }).click();
    await expect(page).toHaveURL(/\/monitors\/[0-9a-f-]+$/);
    const id = page.url().split('/').at(-1)!;
    await page.getByRole('link', {
        name: 'Edit configuration'
    }).click();
    await page.getByLabel('Monitor name', {
        exact: true
    }).fill('Unsaved conflict');
    const response = await page.request.patch(pulse.origin + '/api/v1/monitors/' + id, {
        headers: {
            origin: pulse.origin, 'if-match': '"1"'
        }, data: {
            name: 'External edit'
        }
    });
    expect(response.status()).toBe(200);
    await page.getByRole('button', {
        name: 'Save changes'
    }).click();
    await expect(page.getByText('This resource changed elsewhere.', {
        exact: false
    })).toBeVisible();
    await expect(page.getByLabel('Monitor name', {
        exact: true
    })).toHaveValue('Unsaved conflict');
    await page.getByRole('button', {
        name: 'Reload current version'
    }).click();
    await expect(page.getByLabel('Monitor name', {
        exact: true
    })).toHaveValue('External edit');
    for (let n = 0; n < 35; n++)
        expect((await page.request.post(pulse.origin + '/api/v1/monitors', {
            headers: {
                origin: pulse.origin
            }, data: {
                name: 'Population ' + String(n).padStart(2, '0'), url: pulse.targetUrl, enabled: false
            }
        })).ok()).toBe(true);
    await page.goto(pulse.origin);
    await expect(page.locator('tbody tr')).toHaveCount(25);
    await page.getByRole('button', {
        name: 'Next page →'
    }).click();
    await expect(page.locator('tbody tr')).toHaveCount(11);
    await page.getByLabel('Search monitors').fill('Population 34');
    await expect(page.locator('tbody tr')).toHaveCount(1);
    await page.reload();
    await expect(page.getByLabel('Search monitors')).toHaveValue('Population 34');
    await page.getByLabel('Health', {
        exact: true
    }).selectOption('DOWN');
    await expect(page.getByText('No matching monitors', {
        exact: true
    })).toBeVisible();
    await page.getByRole('link', {
        name: 'Clear filters'
    }).click();
    await page.context().setOffline(true);
    await expect(page.getByText('Stale · reconnecting', {
        exact: false
    })).toBeVisible();
    const missed = await fetch(pulse.origin + '/api/v1/monitors', {
        method: 'POST', headers: {
            origin: pulse.origin, 'content-type': 'application/json'
        }, body: JSON.stringify({
            name: 'Missed while offline', url: pulse.targetUrl, enabled: false
        })
    });
    expect(missed.status).toBe(201);
    await page.context().setOffline(false);
    await page.evaluate(() => window.dispatchEvent(new Event('focus')));
    await expect(page.getByText('Live updates', {
        exact: false
    })).toBeVisible();
    await expect(page.locator('tbody tr')).toHaveCount(25);
    await expect(page.getByRole('link', {
        name: 'Missed while offline', exact: true
    })).toBeVisible();
});
test('webhook failures and a real retry are visible without exposing secrets', async ({ page, pulse }) => {
    await page.goto(pulse.origin + '/settings/notifications');
    pulse.setReceiverStatus(400);
    await page.getByLabel('Destination name').fill('Permanent failure');
    await page.getByLabel('URL file alias').fill('ops');
    await page.getByRole('button', {
        name: 'Add destination', exact: true
    }).click();
    await page.getByRole('button', {
        name: 'Send test', exact: true
    }).click();
    await expect(page.getByText('DEAD', {
        exact: true
    })).toBeVisible();
    await expect(page.getByText('RECEIVER_HTTP_ERROR', {
        exact: false
    })).toBeVisible();
    pulse.setReceiverStatus(503);
    await page.getByLabel('Destination name').fill('Retry receiver');
    await page.getByLabel('URL file alias').fill('ops');
    await page.getByRole('button', {
        name: 'Add destination', exact: true
    }).click();
    const retryDestination = page.locator('li').filter({
        hasText: 'Retry receiver'
    });
    await expect(retryDestination).toBeVisible();
    await retryDestination.getByRole('button', {
        name: 'Send test', exact: true
    }).click();
    await expect.poll(() => pulse.receipts.length).toBe(2);
    pulse.setReceiverStatus(204);
    await expect(page.getByText('Receiver acknowledged', {
        exact: true
    })).toBeVisible();
    expect(pulse.receipts[1]?.id).toBe(pulse.receipts[2]?.id);
    expect(pulse.receipts[1]?.body).toBe(pulse.receipts[2]?.body);
    expect(pulse.receipts[2]?.attempt).toBe(2);
    expect(await page.locator('body').innerText()).not.toContain('FAKE_BROWSER_CANARY');
});
test.describe('authenticated same-origin session', () => {
    test.use({
        authenticated: true
    });
    test('login, cookie/CSRF protection, one SSE connection and restart expiry', async ({ page, pulse }) => {
        let streams = 0;
        page.on('request', request => {
            if (request.url() === pulse.origin + '/api/v1/events')
                streams++;
        });
        await page.goto(pulse.origin);
        await expect(page.getByRole('heading', {
            name: 'Welcome to Pulse.'
        })).toBeVisible();
        await page.getByLabel('Operator token').fill(pulse.token);
        await page.getByRole('button', {
            name: 'Sign in', exact: true
        }).click();
        await expect(page.getByRole('heading', {
            name: 'Your systems, at a glance.'
        })).toBeVisible();
        const cookies = await page.context().cookies();
        expect(cookies.find(c => c.name === 'pulse_session')).toMatchObject({
            httpOnly: true, sameSite: 'Strict'
        });
        await create(page, pulse.targetUrl);
        await expect(page.locator('.status-UP').first()).toBeVisible();
        await page.getByRole('link', {
            name: 'Overview', exact: true
        }).click();
        expect((await page.request.post(pulse.origin + '/api/v1/monitors', {
            headers: {
                origin: pulse.origin
            }, data: {
                name: 'Missing CSRF', url: pulse.targetUrl
            }
        })).status()).toBe(403);
        expect(streams).toBe(1);
        await page.context().setOffline(true);
        await expect(page.getByText('Stale · reconnecting', {
            exact: false
        })).toBeVisible();
        const missed = await fetch(pulse.origin + '/api/v1/monitors', {
            method: 'POST', headers: {
                authorization: 'Bearer ' + pulse.token, 'content-type': 'application/json'
            }, body: JSON.stringify({
                name: 'Authenticated missed event', url: pulse.targetUrl, enabled: false
            })
        });
        expect(missed.status).toBe(201);
        await page.context().setOffline(false);
        await page.evaluate(() => window.dispatchEvent(new Event('focus')));
        await expect(page.getByRole('link', {
            name: 'Authenticated missed event', exact: true
        })).toBeVisible();
        await pulse.restart();
        await page.evaluate(() => window.dispatchEvent(new Event('focus')));
        await expect(page.getByRole('heading', {
            name: 'Welcome to Pulse.'
        })).toBeVisible();
        await page.getByLabel('Operator token').fill(pulse.token);
        await page.getByRole('button', {
            name: 'Sign in', exact: true
        }).click();
        await expect(page.getByRole('link', {
            name: 'Local API', exact: true
        })).toBeVisible();
    });
});
