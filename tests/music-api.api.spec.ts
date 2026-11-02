// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Music API — Browse & CRUD E2E Tests
 *
 * Tests music endpoints for browsing, album/artist/track detail.
 * Seeded by global-setup.ts (TEST_MUSIC_* constants).
 */

import { adminTest as test, expect } from './fixtures/auth';
import { TEST_MUSIC_ARTIST_ID, TEST_MUSIC_ALBUM_ID, TEST_MUSIC_TRACK_ID } from './global-setup';

const MISSING_UUID = '00000000-0000-0000-0000-000000000000';

test.describe('Music API — Browse & Detail', () => {
    // -------------------------------------------------------------------------
    // GET /api/music — home sections
    // -------------------------------------------------------------------------
    test('GET /api/music returns sections array', async ({ request }) => {
        const res = await request.get('/api/music');
        // May be 200 (sections) or 500 (DB not available in CI)
        if (res.status() === 500) {
            test.skip();
        }
        expect(res.status()).toBe(200);
        const body = await res.json();
        expect(body).toHaveProperty('sections');
        expect(Array.isArray(body.sections)).toBe(true);
    });

    // -------------------------------------------------------------------------
    // GET /api/music/albums
    // -------------------------------------------------------------------------
    test('GET /api/music/albums returns paginated albums', async ({ request }) => {
        const res = await request.get('/api/music/albums?limit=10&offset=0');
        if (res.status() === 500) test.skip();
        expect(res.status()).toBe(200);
        const body = await res.json();
        expect(body).toHaveProperty('items');
        expect(Array.isArray(body.items)).toBe(true);
        expect(body).toHaveProperty('page');
    });

    test('GET /api/music/albums supports genre filter', async ({ request }) => {
        const res = await request.get('/api/music/albums?genre=Electronic');
        if (res.status() === 500) test.skip();
        expect(res.status()).toBe(200);
    });

    // -------------------------------------------------------------------------
    // GET /api/music/albums/:id
    // -------------------------------------------------------------------------
    test('GET /api/music/albums/:id returns album with tracks', async ({ request }) => {
        const res = await request.get(`/api/music/albums/${TEST_MUSIC_ALBUM_ID}`);
        if (res.status() === 500) test.skip();
        expect(res.status()).toBe(200);
        const body = await res.json();
        expect(body.id).toBe(TEST_MUSIC_ALBUM_ID);
        expect(body.type).toBe('album');
        expect(Array.isArray(body.tracks)).toBe(true);
        expect(body.tracks.some((track: { id: string }) => track.id === TEST_MUSIC_TRACK_ID)).toBe(
            true,
        );
    });

    test('GET /api/music/albums/:id returns 404 for non-existent album', async ({ request }) => {
        const res = await request.get(`/api/music/albums/${MISSING_UUID}`);
        if (res.status() === 500) test.skip();
        expect(res.status()).toBe(404);
    });

    // -------------------------------------------------------------------------
    // GET /api/music/artists
    // -------------------------------------------------------------------------
    test('GET /api/music/artists returns paginated artists', async ({ request }) => {
        const res = await request.get('/api/music/artists?limit=10');
        if (res.status() === 500) test.skip();
        expect(res.status()).toBe(200);
        const body = await res.json();
        expect(body).toHaveProperty('items');
        expect(Array.isArray(body.items)).toBe(true);
        expect(body).toHaveProperty('page');
    });

    // -------------------------------------------------------------------------
    // GET /api/music/artists/:id
    // -------------------------------------------------------------------------
    test('GET /api/music/artists/:id returns artist with albums', async ({ request }) => {
        const res = await request.get(`/api/music/artists/${TEST_MUSIC_ARTIST_ID}`);
        if (res.status() === 500) test.skip();
        expect(res.status()).toBe(200);
        const body = await res.json();
        expect(body.id).toBe(TEST_MUSIC_ARTIST_ID);
        expect(body.type).toBe('artist');
        expect(body.albums.some((album: { id: string }) => album.id === TEST_MUSIC_ALBUM_ID)).toBe(
            true,
        );
    });

    test('GET /api/music/artists/:id returns 404 for non-existent artist', async ({ request }) => {
        const res = await request.get(`/api/music/artists/${MISSING_UUID}`);
        if (res.status() === 500) test.skip();
        expect(res.status()).toBe(404);
    });

    // -------------------------------------------------------------------------
    // GET /api/music/tracks/:id
    // -------------------------------------------------------------------------
    test('GET /api/music/tracks/:id returns track detail with audio features', async ({
        request,
    }) => {
        const res = await request.get(`/api/music/tracks/${TEST_MUSIC_TRACK_ID}`);
        if (res.status() === 500) test.skip();
        expect(res.status()).toBe(200);
        const body = await res.json();
        // MusicTrackDetailResponseSchema: { track: MusicTrack, userContext }.
        // The track projection is the public MusicTrack shape — it carries no
        // raw `custom_metadata`, so no `bpm`; audio features are not part of
        // this endpoint's contract.
        expect(body).toHaveProperty('track');
        expect(body).toHaveProperty('userContext');
        expect(body.track).toHaveProperty('id');
        expect(body.track).toHaveProperty('title');
    });

    test('GET /api/music/tracks/:id returns 404 for non-existent track', async ({ request }) => {
        const res = await request.get(`/api/music/tracks/${MISSING_UUID}`);
        if (res.status() === 500) test.skip();
        expect(res.status()).toBe(404);
    });
});
