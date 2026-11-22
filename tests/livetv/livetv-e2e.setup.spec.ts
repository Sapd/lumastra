// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { test, expect, missingFfmpeg, ffmpegSkipReason } from './fixtures';
import { expectHydrated } from '../helpers/hydration';
import { baseURL, identityHeaders } from './env';
import { fixtureState } from './harness';
import type { AdminChannelCategory } from '../../src/lib/schemas/livetv';

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

test('admin can renumber a category, hide its channels, and show just one @livetv', async ({
    browser,
}): Promise<void> => {
    test.skip(missingFfmpeg, ffmpegSkipReason);
    const context = await browser.newContext({
        baseURL,
        extraHTTPHeaders: identityHeaders('admin'),
        locale: 'en-US',
    });
    const channelsUrl = '/api/admin/livetv/channels';
    const headers = { Origin: new URL(baseURL).origin };
    let category: AdminChannelCategory | undefined;
    let numberStartChanged = false;
    const page = await context.newPage();
    try {
        const initial = await context.request.get(channelsUrl);
        expect(initial.ok()).toBe(true);
        const { categories } = (await initial.json()) as { categories: AdminChannelCategory[] };
        const { sourceId } = fixtureState();
        category = categories.find(
            (item) =>
                item.id !== 'uncategorized' &&
                item.isVisible &&
                item.channels.length > 1 &&
                item.channels.every(
                    (channel) => channel.sourceId === sourceId && channel.isVisible,
                ),
        );
        if (!category)
            throw new Error('Expected a category with multiple visible fixture channels');
        const [channel] = category.channels;
        await page.goto('/admin/settings/livetv?tab=channels');
        await expectHydrated(page);

        const group = page.locator(`[data-category-id="${category.id}"]`);
        const header = group.locator('.category-header');
        const row = group.locator(`[data-channel-id="${channel.id}"]`);
        await expect(header).toBeVisible();
        if (!(await row.isVisible())) await header.click();
        await expect(row).toBeVisible();

        const newNumber = group.getByTestId('channel-number').filter({ hasText: /^\s*700\s*$/ });
        await expect(newNumber).toHaveCount(0);
        await header.getByRole('button', { name: 'Category actions' }).click();
        page.once('dialog', async (dialog): Promise<void> => {
            await dialog.accept('700');
        });
        numberStartChanged = true;
        await group.getByRole('button', { name: 'Numbers start at…', exact: true }).click();
        await expect(newNumber.first()).toBeVisible();
        await expect(page.getByText(/channels renumbered from 700/)).toBeVisible();

        await header.getByRole('button', { name: 'Category actions' }).click();
        await group.getByRole('button', { name: 'Hide all channels', exact: true }).click();
        await expect(page.getByText(`${category.channels.length} channels hidden`)).toBeVisible();
        await expect(header.getByRole('button', { name: 'Hide', exact: true })).toBeVisible();

        const updated = page.waitForResponse(
            (response) =>
                response.request().method() === 'PUT' &&
                new URL(response.url()).pathname === `${channelsUrl}/${channel.id}`,
        );
        await row.getByRole('button', { name: 'Show', exact: true }).click();
        expect((await updated).ok()).toBe(true);
        const persisted = await context.request.get(channelsUrl);
        expect(persisted.ok()).toBe(true);
        const body = (await persisted.json()) as { categories: AdminChannelCategory[] };
        const saved = body.categories.find((item) => item.id === category?.id);
        expect(saved?.isVisible).toBe(true);
        expect(saved?.channels.filter((item) => item.isVisible).map((item) => item.id)).toEqual([
            channel.id,
        ]);
    } finally {
        try {
            await page.close();
            if (category) {
                const restored = await context.request.put(`${channelsUrl}/bulk`, {
                    headers,
                    data: { action: 'show', channelIds: category.channels.map((item) => item.id) },
                });
                expect(restored.ok()).toBe(true);
                if (numberStartChanged) {
                    const startRestored = await context.request.put(
                        `/api/admin/livetv/categories/${category.id}`,
                        { headers, data: { numberStart: category.numberStart ?? 0 } },
                    );
                    expect(startRestored.ok()).toBe(true);
                    const renumbered = await context.request.post(`${channelsUrl}/renumber`, {
                        headers,
                        data: {},
                    });
                    expect(renumbered.ok()).toBe(true);
                }
            }
        } finally {
            await context.close();
        }
    }
});
