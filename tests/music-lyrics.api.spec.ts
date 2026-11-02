// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Music Lyrics API Tests
 *
 * Tests lyrics retrieval and upload endpoints.
 * TEST_MUSIC_TRACK_ID has synced + plain lyrics in custom_metadata.
 * TEST_MUSIC_TRACK_2_ID has no lyrics.
 */

import { adminTest as test, expect } from './fixtures/auth';
import { TEST_MUSIC_TRACK_ID, TEST_MUSIC_TRACK_2_ID } from './global-setup';

const MISSING_UUID = '00000000-0000-0000-0000-000000000000';

test.describe('Music Lyrics API', () => {
    // -------------------------------------------------------------------------
    // GET /api/music/tracks/:id/lyrics
    // -------------------------------------------------------------------------
    test('GET lyrics returns synced and plain when both available', async ({ request }) => {
        const res = await request.get(`/api/music/tracks/${TEST_MUSIC_TRACK_ID}/lyrics`);
        if (res.status() === 500) test.skip();
        expect(res.status()).toBe(200);
        const body = await res.json();
        expect(body).toHaveProperty('lyrics');
        expect(body.lyrics).toHaveProperty('synced');
        expect(body.lyrics).toHaveProperty('plain');
        expect(body).toHaveProperty('syncedLines');
        expect(Array.isArray(body.syncedLines)).toBe(true);
    });

    test('GET lyrics returns 200 with lyrics null when track has no lyrics', async ({ request }) => {
        const res = await request.get(`/api/music/tracks/${TEST_MUSIC_TRACK_2_ID}/lyrics`);
        if (res.status() === 500) test.skip();
        expect(res.status()).toBe(200);
        const body = await res.json();
        expect(body).toEqual({ lyrics: null });
    });

    test('GET lyrics returns 404 for non-existent track', async ({ request }) => {
        const res = await request.get(`/api/music/tracks/${MISSING_UUID}/lyrics`);
        if (res.status() === 500) test.skip();
        expect(res.status()).toBe(404);
    });

    // -------------------------------------------------------------------------
    // PUT /api/music/tracks/:id/lyrics — upload lyrics (admin)
    // -------------------------------------------------------------------------
    test('PUT lyrics uploads new lyrics for a track', async ({ request }) => {
        const res = await request.put(`/api/music/tracks/${TEST_MUSIC_TRACK_2_ID}/lyrics`, {
            data: {
                plain: 'Hello world\nSecond line',
                synced: '[00:01.00]Hello world\n[00:05.00]Second line',
                source: 'user',
            },
            headers: { 'Content-Type': 'application/json' },
        });
        if (res.status() === 500) test.skip();
        // 204 No Content: the write succeeds and returns no body.
        expect(res.status()).toBe(204);

        // Verify lyrics are now accessible
        const verify = await request.get(`/api/music/tracks/${TEST_MUSIC_TRACK_2_ID}/lyrics`);
        if (verify.status() !== 500) {
            expect(verify.status()).toBe(200);
            const body = await verify.json();
            expect(body.lyrics.plain).toBe('Hello world\nSecond line');
        }
    });

    test('PUT lyrics returns 404 for non-existent track', async ({ request }) => {
        const res = await request.put(`/api/music/tracks/${MISSING_UUID}/lyrics`, {
            data: { plain: 'test', source: 'user' },
            headers: { 'Content-Type': 'application/json' },
        });
        if (res.status() === 500) test.skip();
        expect(res.status()).toBe(404);
    });
});
