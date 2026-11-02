// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * Regression coverage for the frozen-singleton language bug: `getSeriesChildren`
 * used to call the module-level `tmdbApi` singleton, whose `language` field is
 * set once from `config.TMDB_LANGUAGE` at process boot (client.ts constructor
 * default param, evaluated exactly once when `new TMDBApiService()` runs at
 * import time). A config change made after boot (e.g. admin flips
 * TMDB_LANGUAGE from 'de-DE' back to 'en-US') never reached that singleton,
 * so episode/season text kept syncing in whatever language was configured at
 * boot. The fix constructs a fresh client per call via `createTMDBApi()`,
 * reading `config.TMDB_LANGUAGE` (a live getter) on every invocation.
 */

const { mockCreateTMDBApi, mockGetTVShowDetails, mockGetSeasonsEpisodes, mockConfig } = vi.hoisted(
    () => ({
        mockCreateTMDBApi: vi.fn(),
        mockGetTVShowDetails: vi.fn(),
        mockGetSeasonsEpisodes: vi.fn(),
        // Mutable so individual tests can flip the "currently configured"
        // language mid-suite, proving the value is read fresh per call
        // rather than captured once.
        mockConfig: { TMDB_LANGUAGE: 'en-US' },
    }),
);

vi.mock('./client.js', () => ({
    createTMDBApi: mockCreateTMDBApi,
}));

vi.mock('$lib/server/config.js', () => ({
    config: mockConfig,
}));

vi.mock('$lib/server/utils/logger.js', () => ({
    Logger: {
        for: vi.fn(() => ({ info: vi.fn(), warn: vi.fn(), debug: vi.fn(), error: vi.fn() })),
    },
}));

import { getSeriesChildren } from './series-children.js';

describe('getSeriesChildren (TMDB) — language resolution', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        mockConfig.TMDB_LANGUAGE = 'en-US';
        mockCreateTMDBApi.mockImplementation(() => ({
            getTVShowDetails: mockGetTVShowDetails,
            getSeasonsEpisodes: mockGetSeasonsEpisodes,
        }));
        mockGetTVShowDetails.mockResolvedValue({ seasons: [] });
        mockGetSeasonsEpisodes.mockResolvedValue(new Map());
    });

    it('constructs a fresh client with the CURRENT config.TMDB_LANGUAGE when no language is passed', async () => {
        mockConfig.TMDB_LANGUAGE = 'de-DE';

        await getSeriesChildren('1396', undefined, undefined);

        expect(mockCreateTMDBApi).toHaveBeenCalledWith('de-DE');
    });

    it('re-reads config.TMDB_LANGUAGE on every call instead of caching a boot-time value', async () => {
        mockConfig.TMDB_LANGUAGE = 'de-DE';
        await getSeriesChildren('1396', undefined, undefined);
        expect(mockCreateTMDBApi).toHaveBeenLastCalledWith('de-DE');

        // Simulate an admin flipping the setting back after "boot" — a real
        // frozen singleton would still report 'de-DE' here.
        mockConfig.TMDB_LANGUAGE = 'en-US';
        await getSeriesChildren('1396', undefined, undefined);
        expect(mockCreateTMDBApi).toHaveBeenLastCalledWith('en-US');
    });

    it('prefers an explicit per-library language over config.TMDB_LANGUAGE', async () => {
        mockConfig.TMDB_LANGUAGE = 'en-US';

        await getSeriesChildren('1396', undefined, 'fr-FR');

        expect(mockCreateTMDBApi).toHaveBeenCalledWith('fr-FR');
    });

    it('never imports the frozen tmdbApi singleton', async () => {
        // If the module under test still imported `tmdbApi`, the `./client.js`
        // mock above (which exports ONLY `createTMDBApi`) would make that
        // import `undefined` and calling any method on it would throw. Seasons
        // are present here specifically to exercise the per-season fetch path
        // (getSeasonsEpisodes), not just getTVShowDetails.
        mockGetTVShowDetails.mockResolvedValue({
            seasons: [{ season_number: 1, name: 'Season 1' }],
        });
        mockGetSeasonsEpisodes.mockResolvedValue(
            new Map([
                [
                    1,
                    [
                        {
                            seasonNumber: 1,
                            episodeNumber: 1,
                            name: 'Pilot',
                            overview: 'ov',
                            airDate: '2020-01-01',
                            runtimeMinutes: 30,
                            id: 1,
                            stillPath: null,
                        },
                    ],
                ],
            ]),
        );

        const result = await getSeriesChildren('1396', undefined, 'de-DE');

        expect(result.seasons).toHaveLength(1);
        expect(result.seasons[0].episodes[0].title).toBe('Pilot');
        expect(mockCreateTMDBApi).toHaveBeenCalledWith('de-DE');
    });

    it('fetches every listed season in ONE batched call when no selector is given (forced/full sync)', async () => {
        mockGetTVShowDetails.mockResolvedValue({
            seasons: [1, 2, 3].map((n) => ({ season_number: n, name: `S${n}` })),
        });
        mockGetSeasonsEpisodes.mockResolvedValue(
            new Map([1, 2, 3].map((n) => [n, [] as unknown[]])),
        );

        const result = await getSeriesChildren('1396');

        expect(mockGetSeasonsEpisodes).toHaveBeenCalledTimes(1);
        expect(mockGetSeasonsEpisodes).toHaveBeenCalledWith(1396, [1, 2, 3], undefined);
        expect(result.seasons.map((s) => s.seasonNumber)).toEqual([1, 2, 3]);
    });

    it('fetches and returns only the seasons the selector picks (routine re-sync)', async () => {
        mockGetTVShowDetails.mockResolvedValue({
            seasons: [1, 2, 3, 4].map((n) => ({ season_number: n, name: `S${n}` })),
        });
        mockGetSeasonsEpisodes.mockResolvedValue(new Map([3, 4].map((n) => [n, [] as unknown[]])));

        const result = await getSeriesChildren('1396', undefined, undefined, {
            selectSeasons: () => new Set([3, 4]),
        });

        expect(mockGetSeasonsEpisodes).toHaveBeenCalledWith(1396, [3, 4], undefined);
        expect(result.seasons.map((s) => s.seasonNumber)).toEqual([3, 4]);
    });

    it('marks a season the provider could not deliver as incomplete instead of an empty season', async () => {
        mockGetTVShowDetails.mockResolvedValue({
            seasons: [1, 2].map((n) => ({ season_number: n, name: `S${n}` })),
        });
        mockGetSeasonsEpisodes.mockResolvedValue(
            new Map<number, unknown[] | null>([
                [1, [{ id: 1, name: 'A', episodeNumber: 1, seasonNumber: 1 }]],
                [2, null],
            ]),
        );

        const result = await getSeriesChildren('1396');

        expect(result.seasons.map((s) => s.seasonNumber)).toEqual([1]);
        expect(result.incompleteSeasons).toEqual([2]);
    });

    it('reports partial=true only when the selector left seasons out', async () => {
        mockGetTVShowDetails.mockResolvedValue({
            seasons: [1, 2].map((n) => ({ season_number: n })),
        });
        mockGetSeasonsEpisodes.mockResolvedValue(new Map([[2, [] as unknown[]]]));
        const partial = await getSeriesChildren('1396', undefined, undefined, {
            selectSeasons: () => new Set([2]),
        });
        expect(partial.partial).toBe(true);

        mockGetSeasonsEpisodes.mockResolvedValue(
            new Map([
                [1, [] as unknown[]],
                [2, [] as unknown[]],
            ]),
        );
        const full = await getSeriesChildren('1396');
        expect(full.partial).toBeUndefined();
    });

    it('passes the abort signal to the season fetch', async () => {
        mockGetTVShowDetails.mockResolvedValue({ seasons: [{ season_number: 1 }] });
        mockGetSeasonsEpisodes.mockResolvedValue(new Map([[1, [] as unknown[]]]));
        const signal = new AbortController().signal;
        await getSeriesChildren('1396', signal);
        expect(mockGetSeasonsEpisodes).toHaveBeenCalledWith(1396, [1], signal);
    });

    it('lets a rejected season fetch (429 / failed batch) fail the step', async () => {
        mockGetTVShowDetails.mockResolvedValue({
            seasons: [1, 2].map((n) => ({ season_number: n })),
        });
        mockGetSeasonsEpisodes.mockRejectedValue(new Error('429'));
        await expect(getSeriesChildren('1396')).rejects.toThrow('429');
    });

    it('returns an empty result (caller sees signal.aborted) when aborted mid-fetch', async () => {
        mockGetTVShowDetails.mockResolvedValue({ seasons: [{ season_number: 1 }] });
        const ac = new AbortController();
        mockGetSeasonsEpisodes.mockImplementation(async () => {
            ac.abort();
            throw new Error('TMDB season fetch aborted');
        });
        await expect(getSeriesChildren('1396', ac.signal)).resolves.toEqual({ seasons: [] });
    });
});
