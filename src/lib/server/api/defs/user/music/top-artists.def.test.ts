// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

vi.mock('$lib/server/database/queries/image-descriptor.queries.js', async () => {
    const { musicImageOwnerFixture } =
        await import('$lib/server/services/music/__tests__/image-fixtures.js');
    return {
        getImageDescriptorOwners: vi.fn(async (_sql: unknown, ids: string[]) =>
            ids.map((id) => musicImageOwnerFixture(id)),
        ),
    };
});

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { RequestEvent } from '@sveltejs/kit';

const mockGetSql = vi.fn();
const mockGetMostPlayedArtists = vi.fn();
const mockGetTopArtistsByAlbumCount = vi.fn();
const mockBuildSearchAccessContext = vi.fn();
const mockCheckRateLimit = vi.fn();

vi.mock('$lib/server/services/database.service.js', () => ({
    aiDbService: { getSql: (...args: unknown[]) => mockGetSql(...args) },
}));

vi.mock('$lib/server/database/queries/music.queries.js', () => ({
    getArtistSummaries: async (_sql: unknown, ids: string[]) =>
        ids.map((id) => ({
            id,
            title: id === 'a1' ? 'Artist One' : 'Artist Two',
            custom_poster_url: null,
            album_count: id === 'a1' ? 2 : 5,
            track_count: 12,
            is_various_artists: false,
        })),
    getMostPlayedArtists: (...args: unknown[]) => mockGetMostPlayedArtists(...args),
    getTopArtistsByAlbumCount: (...args: unknown[]) => mockGetTopArtistsByAlbumCount(...args),
}));

vi.mock('$lib/server/utils/search-access-context.js', () => ({
    buildSearchAccessContext: (...args: unknown[]) => mockBuildSearchAccessContext(...args),
    searchAccessBoundary: () => ({}),
}));

vi.mock('$lib/server/middleware/valkey-rate-limit.js', () => ({
    checkRateLimit: (...args: unknown[]) => mockCheckRateLimit(...args),
    // Faithful stand-in for the real helper: it sets the X-RateLimit-*
    // headers on the response it is handed and returns that same response.
    withRateLimitHeaders: (
        response: Response,
        result: { total: number; remaining: number; resetAt: number },
    ) => {
        response.headers.set('X-RateLimit-Limit', String(result.total));
        response.headers.set('X-RateLimit-Remaining', String(result.remaining));
        response.headers.set('X-RateLimit-Reset', String(result.resetAt));
        return response;
    },
}));

const { def } = await import('./top-artists.js');

function makeEvent(): RequestEvent {
    return {
        locals: { user: { userId: 'u1', username: 'alice' } },
        url: new URL('http://localhost/api/v1/me/music/top-artists'),
        params: {},
        request: new Request('http://localhost/api/v1/me/music/top-artists'),
    } as unknown as RequestEvent;
}

describe('top-artists published contract', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        mockGetSql.mockResolvedValue({});
        mockBuildSearchAccessContext.mockResolvedValue({ deniedGroupIds: null, ageRating: null });
        mockCheckRateLimit.mockResolvedValue({ allowed: true, resetAt: 0 });
    });

    it('returns personal results with source:"personal" when the user has play history', async () => {
        mockGetMostPlayedArtists.mockResolvedValue([
            {
                id: 'a1',
                title: 'Artist One',
                custom_poster_url: null,
                album_count: 2,
                play_count: 10,
            },
        ]);
        const res = await def.handlers.GET!(makeEvent(), { surface: 'v1' } as never);
        const body = await res.json();
        expect(res.status).toBe(200);
        expect(body.items[0].source).toBe('personal');
        expect(mockGetTopArtistsByAlbumCount).not.toHaveBeenCalled();
    });

    it('falls back to catalog results with source:"catalog" when the user has no play history', async () => {
        mockGetMostPlayedArtists.mockResolvedValue([]);
        mockGetTopArtistsByAlbumCount.mockResolvedValue([
            {
                id: 'a2',
                title: 'Artist Two',
                custom_poster_url: null,
                album_count: 5,
                play_count: 0,
            },
        ]);
        const res = await def.handlers.GET!(makeEvent(), { surface: 'v1' } as never);
        const body = await res.json();
        expect(res.status).toBe(200);
        expect(body.items[0].source).toBe('catalog');
    });

    it('never returns a raw custom_poster_url column value', async () => {
        mockGetMostPlayedArtists.mockResolvedValue([
            {
                id: 'a1',
                title: 'Artist One',
                custom_poster_url: '/data/media/libraries/music/artist/cover.jpg',
                album_count: 2,
                play_count: 10,
            },
        ]);
        const res = await def.handlers.GET!(makeEvent(), { surface: 'v1' } as never);
        const body = await res.json();
        expect(JSON.stringify(body)).not.toContain('/data/media');
        expect(body.items[0].images.primary?.href).toContain('/api/v1/media/a1/images/poster');
    });

    it('returns 429 when the per-user limit is exceeded', async () => {
        mockCheckRateLimit.mockResolvedValue({
            allowed: false,
            resetAt: Date.now() / 1000 + 30,
        });
        const res = await def.handlers.GET!(makeEvent(), { surface: 'v1' } as never);
        expect(res.status).toBe(429);
        expect(mockCheckRateLimit).toHaveBeenCalledWith(
            expect.stringContaining('u1'),
            expect.any(Number),
            expect.any(Number),
        );
        expect(mockGetMostPlayedArtists).not.toHaveBeenCalled();
    });

    it('fetches one extra row and reports page.truncated', async () => {
        mockGetMostPlayedArtists.mockResolvedValue([
            { id: 'a1', title: 'Artist', custom_poster_url: null, album_count: 2, play_count: 10 },
            { id: 'a2', title: 'Artist', custom_poster_url: null, album_count: 2, play_count: 10 },
        ]);
        const event = {
            ...makeEvent(),
            url: new URL('http://localhost/api/v1/me/music/top-artists?limit=1'),
        } as unknown as RequestEvent;
        const res = await def.handlers.GET!(event, { surface: 'v1' } as never);
        const body = await res.json();
        expect(mockGetMostPlayedArtists).toHaveBeenCalledWith(
            expect.anything(),
            'u1',
            2,
            null,
            null,
        );
        expect(body.items).toHaveLength(1);
        expect(body.page).toEqual({ limit: 1, truncated: true });
    });
});
