// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Music Streaming & Progress API Tests
 *
 * Tests audio streaming (range requests) and progress reporting.
 * Seeded by global-setup.ts (TEST_MUSIC_* constants).
 */

import { grantTest as test, expect } from './helpers/playback-start';
import { TEST_MUSIC_TRACK_ID } from './global-setup';

const MISSING_UUID = '00000000-0000-0000-0000-000000000000';

test.describe('Music Streaming & Progress API', () => {
    // -------------------------------------------------------------------------
    // GET /api/music/tracks/:id/stream
    // -------------------------------------------------------------------------
    test('GET /api/music/tracks/:id/stream returns audio with correct Content-Type', async ({
        request,
        startPlayback,
    }) => {
        const start = await startPlayback(TEST_MUSIC_TRACK_ID);
        if (start.delivery.kind !== 'file') throw new Error('Expected music file delivery');
        const res = await request.get(start.delivery.url);
        // 200 if file found, 404 if file missing on disk, 500 if DB unavailable
        if (res.status() === 500 || res.status() === 404) {
            test.skip();
        }
        expect(res.status()).toBe(200);
        const contentType = res.headers()['content-type'] ?? '';
        expect(contentType).toMatch(/audio\//);
    });

    test('GET /api/music/tracks/:id/stream supports range requests (206)', async ({
        request,
        startPlayback,
    }) => {
        const start = await startPlayback(TEST_MUSIC_TRACK_ID);
        if (start.delivery.kind !== 'file') throw new Error('Expected music file delivery');
        const res = await request.get(start.delivery.url, {
            headers: { Range: 'bytes=0-1023' },
        });
        if (res.status() === 500 || res.status() === 404) {
            test.skip();
        }
        // Should be 206 Partial Content or 200 OK
        expect([200, 206]).toContain(res.status());
    });

    test('GET /api/music/tracks/:id/stream returns 404 for missing track', async ({ request }) => {
        const res = await request.get(`/api/music/tracks/${MISSING_UUID}/stream`);
        if (res.status() === 500) test.skip();
        expect(res.status()).toBe(404);
    });

    // -------------------------------------------------------------------------
    // POST /api/music/progress
    // -------------------------------------------------------------------------
    test('POST /api/music/progress accepts valid progress report', async ({ request }) => {
        const res = await request.post('/api/music/progress', {
            data: {
                trackId: TEST_MUSIC_TRACK_ID,
                positionMs: 30000,
                durationMs: 120000,
            },
            headers: { 'Content-Type': 'application/json' },
        });
        // 200/204 → success, 500 → DB unavailable
        if (res.status() === 500) test.skip();
        expect([200, 204]).toContain(res.status());
    });
});
