// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { adminTest as test, expect } from './fixtures/auth';
import { gotoHydrated } from './helpers/cold-load';
import { expectServerFeature } from './helpers/server-features';
import { PendingRequestsResponseSchema } from '../src/lib/schemas/api-content-responses';
import { buildRequestDismissalExtKey } from '../src/lib/shared/request-dismissal-key';

test('more than twenty requests keep updating through download and availability', async ({
    page,
}) => {
    await expectServerFeature(
        page,
        'requests',
        'set FEATURE_REQUEST_MODAL=true, SEERRURL and SEERRAPIKEY (any values; the request APIs are stubbed) in the Playwright web server env',
    );
    await page.setViewportSize({ width: 1440, height: 1000 });
    const requests = Array.from({ length: 21 }, (_, i) => ({
        id: i + 1,
        dismissalKey: buildRequestDismissalExtKey({ tmdb: String(900000 + i) }, 'movie')!,
        externalIds: { tmdb: String(900000 + i) },
        mediaType: 'movie' as const,
        title: `Request progress fixture ${i + 1}`,
        posterPath: null,
        status: 'pending',
        requestedAt: new Date().toISOString(),
        is4k: false,
    }));
    let available = false;
    const batchSizes: number[] = [];
    await page.route('**/api/request/pending', (route) =>
        route.fulfill({
            json: PendingRequestsResponseSchema.parse({
                items: requests,
                dismissals: [],
                page: { limit: 50, offset: 0, hasMore: false, total: requests.length },
            }),
        }),
    );
    await page.route('**/api/request/status', async (route) => {
        const body = route.request().postDataJSON() as {
            requests: { externalIds: { tmdb: string }; mediaType: string }[];
        };
        batchSizes.push(body.requests.length);
        await route.fulfill({
            json: body.requests.map((request) => ({
                ...request,
                status: available ? 'available' : 'downloading',
                ...(available ? {} : { download: { percentage: 42, timeLeft: '1m' } }),
            })),
        });
    });
    // The request notification cards render only with `features.requests`
    // (FEATURE_REQUEST_MODAL plus a Seerr URL and key on the server).
    await gotoHydrated(page, '/');
    await expect(page.getByText('42%', { exact: true }).first()).toBeVisible({ timeout: 60_000 });
    await expect.poll(() => batchSizes.includes(1)).toBe(true);
    expect(batchSizes.every((size) => size <= 20)).toBe(true);
    available = true;
    await expect(page.getByRole('button', { name: 'Watch now' }).first()).toBeVisible({
        timeout: 45_000,
    });
    await expect(page.getByText('42%', { exact: true })).toHaveCount(0);
});
