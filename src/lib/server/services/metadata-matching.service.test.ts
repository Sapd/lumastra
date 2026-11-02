// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { LibraryPathRow } from '../database/queries/library-paths.queries.js';

// Mock the new-SDK helpers used by metadata-matching.service. The mocks
// return raw provider items (shape doesn't matter — normalizeSearchResult
// is mocked to return whatever candidate we want).
vi.mock('$lib/server/tasks/plugin-context.js', () => ({
    invokeProviderSearch: vi.fn(),
}));

vi.mock('$lib/server/providers/normalize.js', () => ({
    normalizeSearchResult: vi.fn(),
}));

import { invokeProviderSearch } from '$lib/server/tasks/plugin-context.js';
import { normalizeSearchResult } from '$lib/server/providers/normalize.js';

const PROVIDER_ID = 'tmdb-metadata-provider';

const movieLibraryPath: LibraryPathRow = {
    id: 'lib-1',
    path: '/media/movies',
    media_type: 'movie',
    language: 'en',
    provider: 'tmdb',
    enabled: true,
    provider_path: null,
    library_group_id: 'lib-1',
    edition_label: null,
    scan_chapters: false,
    fallback_providers: [],
    source_prefix: null,
    created_at: new Date(),
    updated_at: new Date(),
};

const tvLibraryPath: LibraryPathRow = {
    ...movieLibraryPath,
    id: 'lib-2',
    path: '/media/tv',
    media_type: 'tv',
};

const mockContext = {
    logger: {
        info: vi.fn(),
        debug: vi.fn(),
        warn: vi.fn(),
        error: vi.fn(),
    },
} as never;

describe('matchFileToMetadata', () => {
    beforeEach(() => {
        vi.clearAllMocks();
    });

    it('searches movie for a movie library path', async () => {
        vi.mocked(invokeProviderSearch).mockResolvedValueOnce([{ id: 123 }]);
        vi.mocked(normalizeSearchResult).mockReturnValueOnce({
            externalId: 'tmdb-123',
            provider: 'tmdb',
            title: 'Movie Name',
            year: 2020,
            mediaType: 'movie',
            confidence: 0.9,
        });

        const { matchFileToMetadata } = await import('./metadata-matching.service.js');
        const result = await matchFileToMetadata(
            '/media/movies/Movie.Name.2020.1080p.mkv',
            movieLibraryPath,
            PROVIDER_ID,
            mockContext,
        );

        expect(invokeProviderSearch).toHaveBeenCalledWith(
            PROVIDER_ID,
            expect.objectContaining({
                type: 'movie',
                query: 'Movie Name',
                year: 2020,
            }),
        );
        expect(result.matched).toBe(true);
        expect(result.candidate?.externalId).toBe('tmdb-123');
    });

    it('searches series for a tv library path', async () => {
        vi.mocked(invokeProviderSearch).mockResolvedValueOnce([{ id: 456 }]);
        vi.mocked(normalizeSearchResult).mockReturnValueOnce({
            externalId: 'tmdb-456',
            provider: 'tmdb',
            title: 'Show Name',
            year: 2019,
            mediaType: 'tv',
            confidence: 0.85,
        });

        const { matchFileToMetadata } = await import('./metadata-matching.service.js');
        await matchFileToMetadata(
            '/media/tv/Show.Name.2019.S01E03.mkv',
            tvLibraryPath,
            PROVIDER_ID,
            mockContext,
        );

        expect(invokeProviderSearch).toHaveBeenCalledWith(
            PROVIDER_ID,
            expect.objectContaining({ type: 'tv' }),
        );
    });

    it('returns matched: false when no candidates', async () => {
        vi.mocked(invokeProviderSearch).mockResolvedValueOnce([]);

        vi.resetModules();
        const { matchFileToMetadata } = await import('./metadata-matching.service.js');
        const result = await matchFileToMetadata(
            '/media/movies/Completely Unknown Film.mkv',
            movieLibraryPath,
            PROVIDER_ID,
            mockContext,
        );

        expect(result.matched).toBe(false);
        expect(result.candidate).toBeUndefined();
    });

    it('picks candidate with highest confidence when multiple results', async () => {
        vi.mocked(invokeProviderSearch).mockResolvedValueOnce([{ id: 'low' }, { id: 'high' }]);
        vi.mocked(normalizeSearchResult)
            .mockReturnValueOnce({
                externalId: 'tmdb-low',
                provider: 'tmdb',
                title: 'Movie Name',
                year: 2020,
                mediaType: 'movie',
                confidence: 0.4,
            })
            .mockReturnValueOnce({
                externalId: 'tmdb-high',
                provider: 'tmdb',
                title: 'Movie Name',
                year: 2020,
                mediaType: 'movie',
                confidence: 0.95,
            });

        const { matchFileToMetadata } = await import('./metadata-matching.service.js');
        const result = await matchFileToMetadata(
            '/media/movies/Movie.Name.2020.mkv',
            movieLibraryPath,
            PROVIDER_ID,
            mockContext,
        );

        expect(result.candidate?.externalId).toBe('tmdb-high');
    });

    it('matches a back-catalog title with low provider popularity confidence', async () => {
        // Regression test: TMDB's `confidence` is derived from live popularity
        // (trending buzz), not match quality — a decade-old catalog title can
        // score as low as 0.05-0.1 there even though its title/year are an
        // exact match. The service must combine confidence with title/year
        // similarity rather than gating on raw provider confidence alone.
        vi.mocked(invokeProviderSearch).mockResolvedValueOnce([{ id: 70160 }]);
        vi.mocked(normalizeSearchResult).mockReturnValueOnce({
            externalId: 'tmdb-70160',
            provider: 'tmdb',
            title: 'The Hunger Games',
            year: 2012,
            mediaType: 'movie',
            confidence: 0.075, // e.g. Math.min(popularity=7.5 / 100, 1)
        });

        const { matchFileToMetadata } = await import('./metadata-matching.service.js');
        const result = await matchFileToMetadata(
            '/media/movies/The Hunger Games (2012)/The Hunger Games (2012).mkv',
            movieLibraryPath,
            PROVIDER_ID,
            mockContext,
        );

        expect(result.matched).toBe(true);
        expect(result.candidate?.externalId).toBe('tmdb-70160');
    });

    it('rejects a popular-but-wrong-title candidate despite high provider confidence', async () => {
        // A currently-trending title with a high provider confidence must not
        // steamroll the title-similarity floor just because it's popular.
        vi.mocked(invokeProviderSearch).mockResolvedValueOnce([{ id: 'popular-but-wrong' }]);
        vi.mocked(normalizeSearchResult).mockReturnValueOnce({
            externalId: 'tmdb-wrong',
            provider: 'tmdb',
            title: 'Completely Different Movie',
            year: 2012,
            mediaType: 'movie',
            confidence: 1.0,
        });

        const { matchFileToMetadata } = await import('./metadata-matching.service.js');
        const result = await matchFileToMetadata(
            '/media/movies/The Hunger Games (2012)/The Hunger Games (2012).mkv',
            movieLibraryPath,
            PROVIDER_ID,
            mockContext,
        );

        expect(result.matched).toBe(false);
    });

    it('returns matched: false for providers without title search', async () => {
        // mdblist (and any other provider without a `search` method) is now
        // handled inside `invokeProviderSearch` itself, which returns `[]`
        // for absent search. The matching service no longer special-cases
        // mdblist by id — it just gets an empty candidate list and returns
        // matched: false.
        vi.mocked(invokeProviderSearch).mockResolvedValueOnce([]);

        const { matchFileToMetadata } = await import('./metadata-matching.service.js');
        const result = await matchFileToMetadata(
            '/media/movies/Movie.mkv',
            movieLibraryPath,
            'mdblist-metadata-provider',
            mockContext,
        );
        expect(result.matched).toBe(false);
    });
});

describe('matchFileToMetadata — series folder year', () => {
    beforeEach(() => {
        vi.clearAllMocks();
    });

    const tvCandidate = (id: string, year: number | undefined) => ({
        externalId: id,
        provider: 'tmdb',
        title: 'Shorefolk',
        year,
        mediaType: 'tv' as const,
        confidence: 0.9,
    });

    it('rejects a same-title series whose first-air year clearly disagrees with the folder', async () => {
        vi.mocked(invokeProviderSearch).mockResolvedValueOnce([{ id: 4556 }]);
        vi.mocked(normalizeSearchResult).mockReturnValueOnce(tvCandidate('4556', 2001));

        const { matchFileToMetadata } = await import('./metadata-matching.service.js');
        const result = await matchFileToMetadata(
            '/media/tv/Shorefolk (2026) (2026) [imdbid-tt37017338]/Season 01/Shorefolk - S01E01.mkv',
            tvLibraryPath,
            PROVIDER_ID,
            mockContext,
        );

        expect(result.matched).toBe(false);
    });

    it('prefers the same-title series from the folder year', async () => {
        vi.mocked(invokeProviderSearch).mockResolvedValueOnce([{ id: 4556 }, { id: 9999 }]);
        vi.mocked(normalizeSearchResult)
            .mockReturnValueOnce(tvCandidate('4556', 2001))
            .mockReturnValueOnce(tvCandidate('9999', 2026));

        const { matchFileToMetadata } = await import('./metadata-matching.service.js');
        const result = await matchFileToMetadata(
            '/media/tv/Shorefolk (2026)/Season 01/Shorefolk - S01E01.mkv',
            tvLibraryPath,
            PROVIDER_ID,
            mockContext,
        );

        expect(result.candidate?.externalId).toBe('9999');
    });

    it('still accepts a first-air year one or two years off the folder year', async () => {
        vi.mocked(invokeProviderSearch).mockResolvedValueOnce([{ id: 4556 }]);
        vi.mocked(normalizeSearchResult).mockReturnValueOnce(tvCandidate('4556', 2001));

        const { matchFileToMetadata } = await import('./metadata-matching.service.js');
        const result = await matchFileToMetadata(
            '/media/tv/Shorefolk (2003)/Season 01/Shorefolk - S01E01.mkv',
            tvLibraryPath,
            PROVIDER_ID,
            mockContext,
        );

        expect(result.candidate?.externalId).toBe('4556');
    });

    it('does not pass the folder year to the provider query', async () => {
        vi.mocked(invokeProviderSearch).mockResolvedValueOnce([]);

        const { matchFileToMetadata } = await import('./metadata-matching.service.js');
        await matchFileToMetadata(
            '/media/tv/Shorefolk (2026)/Season 01/Shorefolk - S01E01.mkv',
            tvLibraryPath,
            PROVIDER_ID,
            mockContext,
        );

        expect(invokeProviderSearch).toHaveBeenCalledWith(PROVIDER_ID, {
            type: 'tv',
            query: 'Shorefolk',
            language: 'en',
        });
    });
});

describe('matchFileToMetadata — rejected provider key (S5)', () => {
    beforeEach(async () => {
        vi.clearAllMocks();
        const { resetProviderAuthStateForTests } =
            await import('$lib/server/providers/provider-auth-state.js');
        resetProviderAuthStateForTests();
    });

    it('returns providerError "auth" instead of an error per file', async () => {
        const { ProviderAuthError } = await import('$lib/server/providers/provider-auth-state.js');
        vi.mocked(invokeProviderSearch).mockRejectedValue(
            new ProviderAuthError(PROVIDER_ID, 'TMDB API key rejected (401)'),
        );

        const { matchFileToMetadata } = await import('./metadata-matching.service.js');
        const first = await matchFileToMetadata(
            '/media/movies/A (2001)/A (2001).mkv',
            movieLibraryPath,
            PROVIDER_ID,
            mockContext,
        );
        const second = await matchFileToMetadata(
            '/media/movies/B (2002)/B (2002).mkv',
            movieLibraryPath,
            PROVIDER_ID,
            mockContext,
        );

        expect(first).toMatchObject({ matched: false, providerError: 'auth' });
        expect(second).toMatchObject({ matched: false, providerError: 'auth' });
    });

    it("reports other provider failures as 'unavailable' — no answer, not a miss", async () => {
        vi.mocked(invokeProviderSearch).mockRejectedValueOnce(new Error('socket hang up'));
        const { matchFileToMetadata } = await import('./metadata-matching.service.js');
        const result = await matchFileToMetadata(
            '/media/movies/C (2003)/C (2003).mkv',
            movieLibraryPath,
            PROVIDER_ID,
            mockContext,
        );
        expect(result.matched).toBe(false);
        expect(result.providerError).toBe('unavailable');
    });

    it('a clean search with no confident candidate is a plain miss (no providerError)', async () => {
        vi.mocked(invokeProviderSearch).mockResolvedValueOnce([]);
        const { matchFileToMetadata } = await import('./metadata-matching.service.js');
        const result = await matchFileToMetadata(
            '/media/movies/D (2004)/D (2004).mkv',
            movieLibraryPath,
            PROVIDER_ID,
            mockContext,
        );
        expect(result.matched).toBe(false);
        expect(result.providerError).toBeUndefined();
    });
});
