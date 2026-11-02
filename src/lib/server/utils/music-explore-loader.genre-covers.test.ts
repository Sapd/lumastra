// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Regression tests for loadGenreCovers' cache key.
 *
 * `scopedCacheKey` is NOT mocked here — it is the thing that broke. It reserves
 * `|` (access-suffix separator) and throws on a prefix containing one, so an
 * earlier version that interpolated `genres.join('|')` into the prefix raised
 * on every library with two or more genres. Inside a SvelteKit `load()` with no
 * catch, that renders the error page for the whole /music/explore route, so
 * this has to be asserted against the real implementation.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { SearchAccessContext } from './search-access-context.js';

const mockGetGenreCoverAlbums = vi.fn();
const mockCacheGet = vi.fn();
const mockCacheSet = vi.fn();

vi.mock('$lib/server/database/queries/music.queries.js', () => ({
    getDistinctMusicGenres: vi.fn(),
    getGenreCoverAlbums: (...args: unknown[]) => mockGetGenreCoverAlbums(...args),
}));

vi.mock('$lib/server/cache/index.js', () => ({
    cacheManager: { for: () => ({ get: mockCacheGet, set: mockCacheSet }) },
    CACHE_NAMESPACES: { musicLibraryGenres: { name: 'music-library-genres', l2TTL: 60_000 } },
}));

vi.mock('$lib/server/database/queries/user-pinned-genres.queries.js', () => ({
    getPinnedGenreNames: vi.fn(),
}));
vi.mock('$lib/server/services/music/genre-plan-cached.service', () => ({
    computeGenrePlanCached: vi.fn(),
}));
vi.mock('$lib/server/services/music/genre-ranker.service.js', () => ({ loadGenreRails: vi.fn() }));
vi.mock('$lib/server/cache/single-flight.js', () => ({ getOrComputeSingleFlight: vi.fn() }));

import { loadGenreCovers } from './music-explore-loader.js';

const sql = {} as never;

function ctx(over: Partial<SearchAccessContext> = {}): SearchAccessContext {
    return {
        username: 'denis',
        deniedGroupIds: null,
        ageRating: null,
        liveTvAllowed: true,
        showUnavailableMedia: true,
        ...over,
    } as SearchAccessContext;
}

beforeEach(() => {
    vi.clearAllMocks();
    mockCacheGet.mockResolvedValue(null);
    mockCacheSet.mockResolvedValue(undefined);
    mockGetGenreCoverAlbums.mockResolvedValue([]);
});

describe('loadGenreCovers cache key', () => {
    it('does not throw for an ordinary multi-genre library', async () => {
        await expect(
            loadGenreCovers(sql, ctx(), ['Rock', 'Electronic', 'Pop', 'Trance']),
        ).resolves.toBeDefined();
        expect(mockGetGenreCoverAlbums).toHaveBeenCalledOnce();
    });

    it('survives genre names containing the reserved key characters', async () => {
        // Genre strings are operator data straight out of file tags.
        await expect(
            loadGenreCovers(sql, ctx(), ['Drum|Bass', 'Nu:Jazz', 'Rock']),
        ).resolves.toBeDefined();
    });

    it('puts a fixed-width digest in the prefix, not the genre names', async () => {
        await loadGenreCovers(sql, ctx(), ['Rock', 'Pop']);
        const key = mockCacheGet.mock.calls[0][0] as string;
        // scopedCacheKey appends `|<access suffix>`; everything before that
        // first `|` is the part we control and the part that used to throw.
        const prefix = key.split('|')[0];
        expect(prefix).toMatch(/music-genre-covers:[0-9a-f]{16}$/);
        expect(prefix).not.toContain('Rock');
    });

    it('keys differently when the library gains a genre', async () => {
        await loadGenreCovers(sql, ctx(), ['Rock', 'Pop']);
        await loadGenreCovers(sql, ctx(), ['Rock', 'Pop', 'Techno']);
        const [first, second] = mockCacheGet.mock.calls.map((c) => c[0] as string);
        expect(first).not.toBe(second);
    });

    it('keys differently for two users with different access', async () => {
        await loadGenreCovers(sql, ctx(), ['Rock']);
        await loadGenreCovers(
            sql,
            ctx({ deniedGroupIds: ['11111111-1111-4111-8111-111111111111'] }),
            ['Rock'],
        );
        const [open, restricted] = mockCacheGet.mock.calls.map((c) => c[0] as string);
        expect(open).not.toBe(restricted);
    });
});

describe('loadGenreCovers behaviour', () => {
    it('groups rows into a genre -> album-id map', async () => {
        mockGetGenreCoverAlbums.mockResolvedValue([
            { genre: 'Rock', album_id: 'a1' },
            { genre: 'Rock', album_id: 'a2' },
            { genre: 'Pop', album_id: 'b1' },
        ]);

        const covers = await loadGenreCovers(sql, ctx(), ['Rock', 'Pop']);

        expect(covers).toEqual({ Rock: ['a1', 'a2'], Pop: ['b1'] });
    });

    it('short-circuits an empty genre list without querying', async () => {
        expect(await loadGenreCovers(sql, ctx(), [])).toEqual({});
        expect(mockGetGenreCoverAlbums).not.toHaveBeenCalled();
        expect(mockCacheGet).not.toHaveBeenCalled();
    });

    it('serves a cache hit without querying', async () => {
        mockCacheGet.mockResolvedValue({ Rock: ['cached'] });

        expect(await loadGenreCovers(sql, ctx(), ['Rock'])).toEqual({ Rock: ['cached'] });
        expect(mockGetGenreCoverAlbums).not.toHaveBeenCalled();
    });

    it('forwards the viewer access filters to the query', async () => {
        const age = { maxAgeRating: 12, allowUnrated: false };
        await loadGenreCovers(sql, ctx({ deniedGroupIds: ['g1'], ageRating: age }), ['Rock']);

        expect(mockGetGenreCoverAlbums).toHaveBeenCalledWith(
            sql,
            ['Rock'],
            { deniedGroupIds: ['g1'], ageRating: age },
            4,
        );
    });
});
