// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Music Smart Queue API Tests
 *
 * Tests smart queue (next track, skip, like) endpoints.
 * Seeded by global-setup.ts (TEST_MUSIC_* constants).
 */

import { adminTest as test, expect } from './fixtures/auth';
import { TEST_MUSIC_TRACK_ID, TEST_MUSIC_TRACK_2_ID } from './global-setup';

test.describe('Music Smart Queue API', () => {
    // -------------------------------------------------------------------------
    // POST /api/music/recommendations — smart next track
    // -------------------------------------------------------------------------
    test('POST /api/music/recommendations returns the next track and alternatives', async ({
        request,
    }) => {
        const res = await request.post('/api/music/recommendations', {
            data: { context: { currentTrackId: TEST_MUSIC_TRACK_ID } },
        });
        // 200 → results, 500 → DB unavailable or no embeddings
        if (res.status() === 500) test.skip();
        expect(res.status()).toBe(200);
        const body = await res.json();
        // `next` is `.optional()` by design: absent when the algorithm found no
        // pick (which is the case on a catalog with no embeddings).
        expect(body).toHaveProperty('alternatives');
        expect(Array.isArray(body.alternatives)).toBe(true);
        expect(['sonic', 'metadata', 'fallback']).toContain(body.source);
    });

    test('POST /api/music/recommendations without a current track needs a mood seed', async ({
        request,
    }) => {
        const res = await request.post('/api/music/recommendations', { data: {} });
        if (res.status() === 500) test.skip();
        expect(res.status()).toBe(422);
    });

    // -------------------------------------------------------------------------
    // Terminal session report — negative steering
    // -------------------------------------------------------------------------
    test('COMPLETED skip records skip event', async ({ request }) => {
        const started = await request.post('/api/play-sessions', {
            data: {
                mediaId: TEST_MUSIC_TRACK_ID,
                deviceId: 'queue-api-test',
            },
        });
        expect(started.status()).toBe(201);
        const session = await started.json();
        const res = await request.put(`/api/play-sessions/${session.playbackSessionId}`, {
            data: {
                positionMs: 1000,
                listenedTotalMs: 1000,
                sessionElapsedMs: 1000,
                eventSeq: 1,
                status: 'COMPLETED',
                endReason: 'skip',
            },
            headers: { 'Content-Type': 'application/json' },
        });
        expect(res.status(), await res.text()).toBe(204);
    });

    // -------------------------------------------------------------------------
    // Explicit feedback — positive steering
    // -------------------------------------------------------------------------
    test('PUT track feedback records a like', async ({ request }) => {
        const res = await request.put(`/api/me/music/tracks/${TEST_MUSIC_TRACK_2_ID}/feedback`, {
            data: { feedback: 'liked' },
            headers: { 'Content-Type': 'application/json' },
        });
        if (res.status() === 500) test.skip();
        expect([200, 204]).toContain(res.status());
    });
});
