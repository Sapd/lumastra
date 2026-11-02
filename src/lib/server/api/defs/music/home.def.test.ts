// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Guards the published contract of the music-home def, mounted at BOTH
 * /api/music (internal) and /api/v1/music (public/bearer).
 *
 * The def declares `MusicHomeSectionsResponseSchema` = `{ sections:
 * PageSection[] }`, so every emitted section must carry a `type` from the
 * SectionType enum and items shaped as UniversalMediaItem (externalIds,
 * mediaType, image, isAvailable, canRequest). The handler used to push raw
 * snake_case DB rows straight into `items` and never set `type` at all,
 * which tripped mount()'s response-conformance check in production and
 * would make a strict generated client (Swift/tvOS) reject the WHOLE
 * response.
 *
 * These tests validate the real emitted body against the real declared
 * schema — not a hand-copied expectation — so any future drift between the
 * emitter and the contract fails here rather than in prod logs.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { RequestEvent } from '@sveltejs/kit';
import { MusicHomeSectionsResponseSchema } from '$lib/schemas/api-music-responses.js';

const mockGetSql = vi.fn();
const mockGetRecentlyPlayed = vi.fn();
const mockGetAlbums = vi.fn();
const mockGetTracksByGenre = vi.fn();
const mockBuildSearchAccessContext = vi.fn();
const mockSearchAccessBoundary = vi.fn();
const mockFilterAccessibleRows = vi.fn();
const mockLoadLibraryGenreRows = vi.fn();
const mockGetPinnedGenreNames = vi.fn();
const mockLoadGenreRails = vi.fn();

vi.mock('$lib/server/services/database.service.js', () => ({
    aiDbService: { getSql: (...args: unknown[]) => mockGetSql(...args) },
}));

vi.mock('$lib/server/database/queries/music.queries.js', () => ({
    getRecentlyPlayed: (...args: unknown[]) => mockGetRecentlyPlayed(...args),
    getAlbums: (...args: unknown[]) => mockGetAlbums(...args),
    getTracksByGenre: (...args: unknown[]) => mockGetTracksByGenre(...args),
}));

// Curation is stubbed to a plain slice: what this file asserts is the SECTION
// contract (ids, type, item shape), and genre-plan.service has its own tests
// for variant collapsing and the album cap. A stub also keeps the rail order
// deterministic without pinning the seeded shuffle.
vi.mock('$lib/server/services/music/genre-plan.service.js', () => ({
    selectGenreTrackBatch: (rows: unknown[], limit: number) => (rows ?? []).slice(0, limit),
    genreBatchRng: () => () => 0.5,
}));

// The real resolver only yields ImageSets for UUID media ids, and these fixture
// ids are not UUIDs. Stub it to return what it returns for a real item on each
// surface, so the surface-prefix assertions below still exercise the wiring.
vi.mock('$lib/server/services/image-descriptor/index.js', () => ({
    resolveImageSets: vi.fn(async (_sql: unknown, surface: string, items: { id: string }[]) => {
        const base = surface === 'internal' ? '/api/media' : '/api/v1/media';
        return new Map(
            items.map(({ id }) => [
                id,
                {
                    primary: {
                        href: `${base}/${id}/images/primary?v=r1`,
                        revision: 'r1',
                        source: 'self' as const,
                        variants: { thumb: `${base}/${id}/images/primary?size=thumb&v=r1` },
                    },
                },
            ]),
        );
    }),
}));

vi.mock('$lib/server/utils/search-access-context.js', () => ({
    buildSearchAccessContext: (...args: unknown[]) => mockBuildSearchAccessContext(...args),
    searchAccessBoundary: (...args: unknown[]) => mockSearchAccessBoundary(...args),
}));

vi.mock('$lib/server/utils/media-access-batch.js', () => ({
    filterAccessibleRows: (...args: unknown[]) => mockFilterAccessibleRows(...args),
}));

vi.mock('$lib/server/utils/music-explore-loader.js', () => ({
    loadLibraryGenreRows: (...args: unknown[]) => mockLoadLibraryGenreRows(...args),
}));

vi.mock('$lib/server/database/queries/user-pinned-genres.queries.js', () => ({
    getPinnedGenreNames: { all: (...args: unknown[]) => mockGetPinnedGenreNames(...args) },
}));

vi.mock('$lib/server/services/music/genre-ranker.service.js', () => ({
    loadGenreRails: (...args: unknown[]) => mockLoadGenreRails(...args),
    // Real implementation, not a stub: the def seeds the genre rails' item
    // ordering with it, and a partial mock that omits it makes every request
    // throw `dayKey is not a function` — which is how this mock failed when
    // the seed was added.
    dayKey: (now: Date) => now.toISOString().slice(0, 10),
}));

const { def } = await import('./home.js');

/** A realistic RecentTrackRow, exactly as the SQL SELECT returns it. */
function trackRow(id: string, title: string) {
    return {
        id,
        title,
        sort_order: 1,
        runtime_seconds: 210,
        custom_poster_url: null,
        custom_metadata: {},
        album_id: `al-${id}`,
        album_title: 'Some Album',
        album_custom_poster_url: null,
        artist_id: `ar-${id}`,
        artist_title: 'Some Artist',
        last_played_at: '2026-08-20T10:00:00Z',
        hours_since_played: 3,
        file_path: '/music/x.flac',
    };
}

/** A realistic MusicAlbumRow — what getAlbums actually returns. */
function albumRow(id: string, title: string) {
    return {
        id,
        title,
        overview: null,
        custom_poster_url: null,
        custom_backdrop_url: null,
        custom_metadata: {},
        year: 2013,
        artist_id: `ar-${id}`,
        artist_title: 'Johann Sebastian Bach',
        track_count: 23,
        total_duration: 4000,
        created_at: '2026-09-15T08:28:04Z',
    };
}

/** A realistic GenreTrackRow — what getTracksByGenre actually returns. */
function genreTrackRow(id: string, title: string) {
    return {
        id,
        title,
        custom_poster_url: null,
        custom_metadata: {},
        runtime_seconds: 200,
        album_id: `al-${id}`,
        album_title: 'Some Album',
        album_custom_poster_url: null,
        artist_id: `ar-${id}`,
        artist_title: 'Track Artist',
        year: 1999,
        file_path: null,
    };
}

function makeEvent(): RequestEvent {
    return {
        locals: { user: { userId: 'u1', username: 'alice' } },
        url: new URL('http://localhost/api/v1/music'),
        params: {},
        request: new Request('http://localhost/api/v1/music'),
    } as unknown as RequestEvent;
}

const ctx = { surface: 'v1', input: { body: undefined, query: undefined, params: undefined } };

describe('music home published contract', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        mockGetSql.mockResolvedValue({});
        mockBuildSearchAccessContext.mockResolvedValue({ deniedGroupIds: null, ageRating: null });
        mockSearchAccessBoundary.mockReturnValue({});
        mockGetPinnedGenreNames.mockResolvedValue([]);
        mockLoadLibraryGenreRows.mockResolvedValue([]);
        mockLoadGenreRails.mockResolvedValue([
            { key: 'rock', title: 'Rock', variants: ['rock'], discovery: false },
            { key: 'jazz', title: 'Jazz', variants: ['jazz'], discovery: true },
        ]);
        mockGetRecentlyPlayed.mockResolvedValue([trackRow('t1', 'Played One')]);
        mockSearchAccessBoundary.mockReturnValue({ boundary: 'viewer' });
        mockGetAlbums.mockResolvedValue([
            albumRow('al1', 'Goldberg Variations'),
            albumRow('al2', 'Selected Works'),
        ]);
        mockGetTracksByGenre
            .mockResolvedValueOnce([genreTrackRow('g1', 'Rock Track')])
            .mockResolvedValueOnce([genreTrackRow('g2', 'Jazz Track')]);
        // The access filter is a pure pass-through filter in production.
        mockFilterAccessibleRows.mockImplementation(
            async (_sql: unknown, rows: unknown[]) => rows ?? [],
        );
    });

    it('returns 401 when unauthenticated', async () => {
        const event = { ...makeEvent(), locals: { user: null } } as unknown as RequestEvent;
        const res = await def.handlers.GET!(event, ctx as never);
        expect(res.status).toBe(401);
    });

    it('returns 503 when the database is unavailable', async () => {
        mockGetSql.mockResolvedValue(null);
        const res = await def.handlers.GET!(makeEvent(), ctx as never);
        expect(res.status).toBe(503);
    });

    it('emits a body that satisfies its own declared response schema', async () => {
        const res = await def.handlers.GET!(makeEvent(), ctx as never);
        expect(res.status).toBe(200);
        const body = await res.json();

        const parsed = MusicHomeSectionsResponseSchema.safeParse(body);
        // Surface the actual issues on failure — this is the exact check
        // mount() runs in production before logging RESPONSE CONFORMANCE.
        expect(parsed.success, JSON.stringify(parsed.error?.issues, null, 2)).toBe(true);
    });

    it('gives every section a valid SectionType', async () => {
        const res = await def.handlers.GET!(makeEvent(), ctx as never);
        const body = await res.json();

        expect(body.sections.length).toBeGreaterThan(0);
        for (const section of body.sections) {
            expect(section.type).toBe('carousel');
        }
    });

    it('emits UniversalMediaItem-shaped items, not raw DB rows', async () => {
        const res = await def.handlers.GET!(makeEvent(), ctx as never);
        const body = await res.json();

        for (const section of body.sections) {
            for (const item of section.items) {
                expect(item).toMatchObject({
                    mediaType: expect.any(String),
                    image: expect.any(String),
                    isAvailable: expect.any(Boolean),
                    canRequest: expect.any(Boolean),
                    id: expect.any(String),
                    itemKey: expect.any(String),
                });
                // Raw snake_case columns must not leak onto the wire.
                expect(item).not.toHaveProperty('custom_poster_url');
                expect(item).not.toHaveProperty('custom_metadata');
                expect(item.externalIds?.internal).toBeUndefined();
                expect(item).not.toHaveProperty('file_path');
            }
        }
    });

    it('emits v1-surface image URLs on the v1 mount', async () => {
        const res = await def.handlers.GET!(makeEvent(), ctx as never);
        const body = await res.json();

        const images = body.sections.flatMap((s: { items: { image: string }[] }) =>
            s.items.map((i) => i.image),
        );
        expect(images.length).toBeGreaterThan(0);
        for (const image of images) {
            // A bearer client handed an /api/media/... href cannot fetch it —
            // the internal surface's auth gates reject the token.
            expect(image).toContain('/api/v1/media/');
        }
    });

    it('emits internal-surface image URLs on the internal mount', async () => {
        const internalCtx = { ...ctx, surface: 'internal' };
        const res = await def.handlers.GET!(makeEvent(), internalCtx as never);
        const body = await res.json();

        const images = body.sections.flatMap((s: { items: { image: string }[] }) =>
            s.items.map((i) => i.image),
        );
        expect(images.length).toBeGreaterThan(0);
        for (const image of images) {
            expect(image).toContain('/api/media/');
            expect(image).not.toContain('/api/v1/');
        }
    });

    it('lists recently added ALBUMS, scoped by the viewer’s boundary in the query', async () => {
        // Tracks let one big import (a 23-track album) fill the whole rail
        // with the same cover.
        const res = await def.handlers.GET!(makeEvent(), ctx as never);
        const body = await res.json();

        const rail = body.sections.find((s: { id: string }) => s.id === 'music-recently-added');
        expect(
            rail.items.map((i: { id: string; mediaType: string }) => [i.id, i.mediaType]),
        ).toEqual([
            ['al1', 'album'],
            ['al2', 'album'],
        ]);
        expect(rail.items.map((i: { itemKey: string }) => i.itemKey)).toEqual([
            'new:al1',
            'new:al2',
        ]);
        expect(rail.items[0].image).toContain('/api/v1/media/al1/');
        expect(mockGetAlbums).toHaveBeenCalledWith(expect.anything(), {
            sort: 'recent',
            limit: 20,
            access: { boundary: 'viewer' },
        });
    });

    it('keeps the discovery genre rail distinguishable from a proven-taste rail', async () => {
        const res = await def.handlers.GET!(makeEvent(), ctx as never);
        const body = await res.json();

        const ids = body.sections.map((s: { id: string }) => s.id);
        expect(ids).toContain('music-genre-rock');
        expect(ids).toContain('music-genre-discovery-jazz');
    });
});
