// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { test, expect, missingFfmpeg, ffmpegSkipReason } from './fixtures';
import { expectHydrated } from '../helpers/hydration';
import { baseURL, identityHeaders } from './env';
import { fixtureState } from './harness';

test('admin source setup validates feeds, imports edits and clears XMLTV @livetv', async ({
    browser,
}) => {
    test.skip(missingFfmpeg, ffmpegSkipReason);
    const context = await browser.newContext({
        baseURL,
        extraHTTPHeaders: identityHeaders('admin'),
        locale: 'en-US',
    });
    try {
        const page = await context.newPage();
        await page.goto('/admin/settings/livetv');
        await expectHydrated(page);
        const card = page.locator('div.p-5').filter({
            has: page.getByRole('heading', { name: 'Live TV E2E synthetic', exact: true }),
        });
        await expect(card).toHaveCount(1);
        const { sourceId, provider } = fixtureState();
        await card.getByRole('button', { name: 'Edit Source', exact: true }).click();
        await page.locator('#xmltv-url').fill(`${provider.xmltvUrl}?setup-regression=1`);
        const changed = page.waitForResponse(
            (response) =>
                response.request().method() === 'PUT' &&
                response.url().endsWith(`/sources/${sourceId}`),
        );
        await page.getByRole('button', { name: 'Save Changes', exact: true }).last().click();
        const response = await changed;
        expect(response.status()).toBe(200);
        const body = (await response.json()) as { taskIds?: { epg?: string; m3u?: string } };
        expect(body.taskIds?.epg).toBeTruthy();
        expect(body.taskIds?.m3u).toBeUndefined();
        await expect
            .poll(
                async () => {
                    const run = await context.request.get(`/api/runs/${body.taskIds!.epg!}`);
                    expect(run.ok()).toBe(true);
                    return ((await run.json()) as { state: string }).state;
                },
                { timeout: 120_000 },
            )
            .toBe('completed');

        await card.getByRole('button', { name: 'Edit Source', exact: true }).click();
        await page.getByRole('checkbox', { name: 'Remove the XMLTV URL' }).check();
        const cleared = page.waitForResponse(
            (r) => r.request().method() === 'PUT' && r.url().endsWith(`/sources/${sourceId}`),
        );
        await page.getByRole('button', { name: 'Save Changes', exact: true }).last().click();
        const clearedResponse = await cleared;
        expect(clearedResponse.status()).toBe(200);
        expect(clearedResponse.request().postDataJSON()).toMatchObject({ xmltvUrl: '' });

        await page.getByRole('button', { name: 'Add Source', exact: true }).click();
        await page.locator('#source-name').fill('Invalid setup probe');
        await page
            .locator('#m3u-url')
            .fill(`${provider.baseUrl}/not-a-playlist?password=setup-probe-secret`);
        const rejected = page.waitForResponse(
            (r) => r.request().method() === 'POST' && r.url().endsWith('/livetv/sources'),
        );
        await page.getByRole('button', { name: 'Create Source', exact: true }).click();
        const rejectedResponse = await rejected;
        expect(rejectedResponse.status()).toBe(422);
        expect(await rejectedResponse.text()).not.toContain('setup-probe-secret');
        await expect(page.getByText(/Could not read the M3U feed/)).toBeVisible();
    } finally {
        await context.close();
    }
});
