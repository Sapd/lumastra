// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Playback diagnostics — browser failure-path coverage.
 *
 * Uses the seeded, synthetic five-second video only.  The routes below are
 * intercepted in the test browser: no real stream, FFmpeg process, or
 * production viewer is interrupted. The negotiation request is changed only in
 * the test browser to select HLS, then the controlled 503 proves that the visible reconnect
 * explanation identifies an observed server/proxy response and the manifest
 * stage without making up a root cause.
 */

import { adminTest as test, expect } from './fixtures/auth';
import { TEST_MEDIA_ITEM_ID } from './global-setup';
import {
    PlaybackStartResponseSchema,
    type PlaybackStartRequest,
} from '../src/lib/schemas/playback-start';

test.describe('Playback diagnostics', () => {
    test('explains a controlled HLS manifest 503 without exposing the stream URL', async ({
        page,
    }) => {
        // Includes the cold compile/start budget and HLS retry/backoff budget below.
        test.setTimeout(120_000);
        let hlsRequests = 0;

        // Request HLS through the current negotiation contract, preserving the
        // real session and grant, then control the manifest response below.
        await page.route('**/api/play-sessions', async (route) => {
            if (route.request().method() !== 'POST') return route.continue();
            const body = route.request().postDataJSON() as PlaybackStartRequest;
            const response = await route.fetch({ postData: { ...body, requestedMethod: 'remux' } });
            expect(response.status(), await response.text()).toBe(201);
            const start = PlaybackStartResponseSchema.parse(await response.json());
            expect(start.delivery.kind).toBe('hls');
            // Keep the issued URL, grant and session binding intact.
            await route.fulfill({ response, json: start });
        });

        // The initial HLS request may be a master or a nested variant manifest,
        // depending on the delivery planner. Return an
        // intentionally generic 503: the UI must call it a gateway/upstream
        // response, never an FFmpeg failure, unless the server says so.
        //
        // The manifest lives at `/api/playback/<id>/hls?…` (info.utils.ts
        // `buildHlsUrl`, served by `[itemId]/hls/+server.ts`); the old
        // `hls-lumastra` route name this pattern carried until 2026-09-11 was
        // deleted in 7fcf0d616 and survives only in comments. With the stale
        // pattern nothing was intercepted, the REAL pipeline ran, the
        // open-source Chromium in CI has no H.264 decoder, hls.js surfaced
        // `bufferAddCodecError` as a terminal error — and PlayerOverlay hides
        // the reconnect badge behind any terminal error by design. So the
        // failure read as "badge missing" while the badge logic was fine.
        await page.route(`**/api/playback/${TEST_MEDIA_ITEM_ID}/hls**`, async (route) => {
            hlsRequests++;
            await route.fulfill({
                status: 503,
                contentType: 'application/vnd.apple.mpegurl',
                body: '#EXTM3U\n',
            });
        });

        // Two budgets, because two different clocks run before the badge can
        // exist, and a single 20 s window from `goto` covered neither in CI:
        //
        // 1. The dev server compiles /watch on demand. Measured in the CI image
        //    (playwright:v1.59.0-noble, fresh PG18): the player's first playability
        //    request left at 13.6 s warm and 26.9 s cold after `goto`. The
        //    first intercepted manifest request is the moment the player has
        //    actually started, so that is the barrier — not the elapsed time.
        // 2. hls.js retries the manifest on its own before going fatal
        //    (0.5 / 1 / 2 / 4 s: five requests over ~8 s, measured), and only
        //    the fatal error reaches the reconnect path that renders the badge.
        //    Measured badge-after-first-manifest: 9.2 s. 30 s leaves room for a
        //    loaded runner without hiding a regression to "never".
        const firstManifest = page.waitForRequest(
            (req) => req.url().includes(`/api/playback/${TEST_MEDIA_ITEM_ID}/hls`),
            { timeout: 60_000 },
        );
        await page.goto(`/watch/${TEST_MEDIA_ITEM_ID}`);
        await firstManifest;

        const reconnectBadge = page.locator('.reconnect-badge');
        await expect(reconnectBadge).toBeVisible({ timeout: 30_000 });
        await expect(reconnectBadge).toContainText('Connection problem — reconnecting…');
        await expect(reconnectBadge).toContainText(
            'Gateway or upstream stream service unavailable (HTTP 503)',
        );
        await expect(reconnectBadge).toContainText('failed while loading the playlist');

        expect(hlsRequests).toBeGreaterThan(0);
        await expect(reconnectBadge).not.toContainText(/stream_token|api_key|https?:\/\//i);
    });
});
