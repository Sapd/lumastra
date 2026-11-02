// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, test, expect, vi, beforeEach } from 'vitest';

vi.mock('$lib/server/cache/index.js', () => ({
    cacheManager: { for: () => ({ get: async () => null, set: async () => undefined }) },
    CACHE_NAMESPACES: new Proxy({}, { get: (_t, k) => String(k) }),
}));

vi.mock('$lib/server/services/database.service.js', () => ({
    aiDbService: { getSql: vi.fn(() => Promise.resolve({})) },
}));

vi.mock('$lib/server/database/queries/music.queries.js', () => ({
    getRecentlyPlayed: vi.fn(),
}));

vi.mock('$lib/server/database/queries/music-recommendations.queries.js', () => ({
    getMusicBecauseYouListened: vi.fn(),
}));

vi.mock('$lib/server/database/queries/music-quick-picks.queries.js', () => ({
    getDislikedTrackIds: vi.fn().mockResolvedValue([]),
}));

vi.mock('$lib/server/services/image-descriptor/index.js', () => ({
    resolveImageSets: vi.fn(async () => new Map()),
}));

// Deliberately NOT stubbed. The previous hand-rolled stub returned the raw
// query rows as `items`, so the response carried DB columns (artist_id,
// album_title, similarity, …) that PageSectionSchema does not declare — and
// mount()'s response-contract gate rejected the whole response, since the
// generated spec is additionalProperties:false. Production was never wrong:
// the real builder maps rows through becauseYouListenedToMediaItem into clean
// UniversalMediaItems. Using the real one makes this test prove the shape the
// endpoint actually ships, instead of a stub's shape that only it can satisfy.
// Its sole runtime dependency, getCatalogPosterUrl, is mocked below.
vi.mock('$lib/server/utils/music-section-builder.js', async (importOriginal) =>
    importOriginal<typeof import('$lib/server/utils/music-section-builder.js')>(),
);

vi.mock('$lib/server/utils/logger.js', () => ({
    Logger: {
        for: vi.fn(() => ({
            debug: vi.fn(),
            info: vi.fn(),
            warn: vi.fn(),
            error: vi.fn(),
        })),
    },
}));

vi.mock('$lib/server/utils/search-access-context.js', () => ({
    buildSearchAccessContext: vi.fn().mockResolvedValue({
        deniedGroupIds: [],
        ageRating: null,
    }),
    // The route also imports scopedCacheKey from this module. A vi.mock factory
    // replaces the module wholesale, so omitting it left the route calling
    // undefined() inside its try block — surfacing as a 503 from the catch
    // rather than as the TypeError it actually was.
    scopedCacheKey: vi.fn((prefix: string) => `${prefix}:test`),
}));

vi.mock('$lib/server/middleware/media-access.js', () => ({
    checkMediaAccess: vi.fn().mockResolvedValue(true),
}));

vi.mock('$lib/utils/image-utils.js', () => ({
    getCatalogPosterUrl: vi.fn().mockReturnValue('/img/poster.jpg'),
}));

import { getRecentlyPlayed } from '$lib/server/database/queries/music.queries';
import { getMusicBecauseYouListened } from '$lib/server/database/queries/music-recommendations.queries';
import { resolveImageSets } from '$lib/server/services/image-descriptor/index.js';
import { GET } from './+server';

type Event = Parameters<NonNullable<typeof GET>>[0];

function mkEvent(user?: { username: string; userId?: string }): Event {
    const url = new URL('http://x/api/music/sections/because-you-listened');
    return {
        params: {},
        url,
        request: new Request(url),
        locals: {
            user: user
                ? {
                      userId: user.userId ?? 'user-1',
                      userGroups: [],
                      isAdmin: false,
                      maxAgeRating: null,
                      ...user,
                  }
                : undefined,
        },
    } as unknown as Event;
}

describe('GET /api/music/sections/because-you-listened', () => {
    beforeEach(() => vi.clearAllMocks());

    test('401 when unauthenticated', async () => {
        const res = await GET!(mkEvent(undefined));
        expect(res.status).toBe(401);
    });

    test('returns null when user has no recently played', async () => {
        vi.mocked(getRecentlyPlayed).mockResolvedValue([]);
        const res = await GET!(mkEvent({ username: 'denis' }));
        expect(res.status).toBe(200);
        expect(await res.json()).toBeNull();
    });

    test('returns 503 dependency_unavailable when recommendation query throws', async () => {
        // The endpoint catches AI-DB/embedding errors and returns 503 dependency_unavailable
        // rather than masking a dependency failure as a 200 empty response.
        vi.mocked(getRecentlyPlayed).mockResolvedValue([
            {
                id: 'seed',
                title: 'Seed',
                artist_title: 'Artist',
                album_title: 'Album',
                runtime_seconds: 180,
                custom_poster_url: null,
                last_played_at: new Date(),
            },
        ] as never);
        vi.mocked(getMusicBecauseYouListened).mockRejectedValue(
            new Error('embedding lookup failed'),
        );
        const res = await GET!(mkEvent({ username: 'denis' }));
        expect(res.status).toBe(503);
        const body = await res.json();
        expect(body).toHaveProperty('code', 'dependency_unavailable');
    });

    test('returns a BYL section when seed track and recs exist', async () => {
        vi.mocked(getRecentlyPlayed).mockResolvedValue([
            {
                id: 'seed',
                title: 'Seed Song',
                artist_title: 'Artist',
                album_title: 'Album',
                runtime_seconds: 180,
                custom_poster_url: null,
                last_played_at: new Date(),
            },
        ] as never);
        vi.mocked(getMusicBecauseYouListened).mockResolvedValue([
            {
                id: 'rec1',
                title: 'Rec',
                artist_id: 'artist-1',
                artist_title: 'Other',
                album_id: 'album-1',
                album_title: 'Other',
                runtime_seconds: 180,
                custom_poster_url: null,
                similarity: 0.9,
            },
        ]);
        const imageSet = {
            primary: {
                href: '/api/media/rec1/images/primary?v=r1',
                revision: 'r1',
                source: 'self',
            },
        };
        vi.mocked(resolveImageSets).mockResolvedValue(new Map([['rec1', imageSet]]) as never);
        const res = await GET!(mkEvent({ username: 'denis' }));
        expect(res.status).toBe(200);
        const body = await res.json();
        expect(body).not.toBeNull();
        expect(body.id).toMatch(/^music-byl-/);

        // Images are resolved for the endpoint's own surface (internal here) and
        // carried as the shared ImageSet, not a legacy hand-built URL string.
        expect(resolveImageSets).toHaveBeenCalledWith(expect.anything(), 'internal', [
            { id: 'rec1', mediaType: 'track' },
        ]);

        // Rows must arrive MAPPED, not passed through. Raw columns on an item
        // are rejected wholesale by a strict decoder (the response contract is
        // additionalProperties:false), so assert the mapped shape and the
        // absence of the DB column names rather than trusting the gate alone.
        const item = body.items[0];
        expect(item).toMatchObject({
            id: 'rec1',
            itemKey: 'byl:rec1',
            title: 'Rec',
            subtitle: 'Other',
            mediaType: 'track',
            externalIds: {},
            images: imageSet,
            image: '/api/media/rec1/images/primary?v=r1',
        });
        for (const col of [
            'artist_id',
            'artist_title',
            'album_id',
            'album_title',
            'runtime_seconds',
            'custom_poster_url',
            'similarity',
        ]) {
            expect(item).not.toHaveProperty(col);
        }
    });
});
