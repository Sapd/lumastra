// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Example names are fictional; production shapes and measurements are retained.
 * metadata-translations-sync — unit tests.
 *
 * Covers the four scenarios from the Task 6 brief for the exported per-item
 * handler `syncTranslationsForItem` (movie/series/empty-admin-list/
 * season-fetch-failure), plus the "no TMDB id" skip case the Key
 * Requirements section calls out alongside it, and a manifest-shape smoke
 * test for both exported task definitions (id/coversStages/schedule),
 * which also exercises `defineTask`'s own manifest validation.
 *
 * `collectTmdbTranslations` is NOT mocked — it's pure and already unit
 * tested (`tmdb-translations-collect.test.ts`); using the real
 * implementation here verifies the DB-touching glue around it against
 * realistic TMDB fixture shapes. Everything that touches Postgres or TMDB
 * directly is mocked; `sql` itself is never called by `syncTranslationsForItem`
 * (every DB access is behind a mocked query-module function), so tests pass
 * an opaque stub.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type postgres from 'postgres';

const {
    mockResolveMediaTmdb,
    mockUpsertMediaTranslations,
    mockFindEpisodeDataByPosition,
    mockFindEpisodeDataByProviderEpisodeId,
    mockReEnrollCompletedStageForReset,
    mockTx,
} = vi.hoisted(() => ({
    mockResolveMediaTmdb: vi.fn(),
    mockUpsertMediaTranslations: vi.fn(),
    mockFindEpisodeDataByPosition: vi.fn(),
    mockFindEpisodeDataByProviderEpisodeId: vi.fn(),
    mockReEnrollCompletedStageForReset: vi.fn(),
    // Tagged-template stand-in for the seed transaction's `tx` handle.
    mockTx: vi.fn(),
}));

vi.mock('$lib/server/services/metadata-sync-single.service.js', () => ({
    resolveMediaTmdb: mockResolveMediaTmdb,
}));

vi.mock('$lib/server/database/queries/media-translations.queries.js', () => ({
    upsertMediaTranslations: mockUpsertMediaTranslations,
}));

vi.mock('$lib/server/database/queries/media-items.queries.js', () => ({
    findEpisodeDataByPosition: mockFindEpisodeDataByPosition,
    findEpisodeDataByProviderEpisodeId: mockFindEpisodeDataByProviderEpisodeId,
}));

vi.mock('$lib/server/database/queries/stage-state.queries.js', () => ({
    upsertCompletedRow: vi.fn().mockResolvedValue(undefined),
    reEnrollCompletedStageForReset: mockReEnrollCompletedStageForReset,
}));

vi.mock('$lib/server/database/with-tx.js', () => ({
    withTx: (_sql: unknown, fn: (tx: unknown) => Promise<unknown>) => fn(mockTx),
}));

import { runTask } from '@sapd/lumastra-plugin-sdk-testing';
import { config } from '$lib/server/config.js';
import {
    syncTranslationsForItem,
    metadataTranslationsSyncTask,
    metadataTranslationsSeedTask,
    type TranslationsApi,
} from '../metadata-translations-sync.js';

const fakeSql = {} as unknown as postgres.Sql;

function makeApi(overrides: Partial<TranslationsApi> = {}): TranslationsApi {
    return {
        getMovieDetails: vi.fn(),
        getTVShowDetails: vi.fn(),
        getSeasonEpisodesInLanguage: vi.fn(),
        ...overrides,
    };
}

beforeEach(() => {
    vi.clearAllMocks();
    mockUpsertMediaTranslations.mockResolvedValue(1);
});

describe('syncTranslationsForItem', () => {
    it('empty admin list → skipped_permanent/translations-disabled, no DB/TMDB calls', async () => {
        const api = makeApi();
        const result = await syncTranslationsForItem(fakeSql, api, 'movie-1', []);

        expect(result).toEqual({
            disposition: 'skipped_permanent',
            reason: 'translations-disabled',
            itemsProcessed: 0,
        });
        expect(mockResolveMediaTmdb).not.toHaveBeenCalled();
        expect(api.getMovieDetails).not.toHaveBeenCalled();
    });

    it('no TMDB id → skipped_permanent/no-primary-external-id', async () => {
        mockResolveMediaTmdb.mockResolvedValue(null);
        const api = makeApi();

        const result = await syncTranslationsForItem(fakeSql, api, 'movie-1', ['de']);

        expect(result).toEqual({
            disposition: 'skipped_permanent',
            reason: 'no-primary-external-id',
            itemsProcessed: 0,
        });
        expect(api.getMovieDetails).not.toHaveBeenCalled();
    });

    it('movie: one detail call, upserts admin languages, returns completed', async () => {
        mockResolveMediaTmdb.mockResolvedValue({
            tmdbId: 550,
            current: {
                media_type: 'movie',
                title: 'Quiet Orbit',
                year: 1999,
                overview: '',
                metadata_locked: false,
            },
        });
        const api = makeApi({
            getMovieDetails: vi.fn().mockResolvedValue({
                translations: {
                    translations: [
                        { iso_639_1: 'de', data: { title: 'Der Titel', overview: 'Übersicht' } },
                    ],
                },
            }),
        });

        const result = await syncTranslationsForItem(fakeSql, api, 'movie-1', ['de']);

        expect(result).toEqual({ disposition: 'completed', itemsProcessed: 1 });
        expect(api.getMovieDetails).toHaveBeenCalledWith(550);
        expect(api.getTVShowDetails).not.toHaveBeenCalled();
        expect(api.getSeasonEpisodesInLanguage).not.toHaveBeenCalled();
        expect(mockUpsertMediaTranslations).toHaveBeenCalledTimes(1);
        expect(mockUpsertMediaTranslations).toHaveBeenCalledWith(fakeSql, 'movie-1', [
            { language: 'de', title: 'Der Titel', overview: 'Übersicht', tagline: null },
        ]);
    });

    it('series: fetches seasons per language with throwOnError and upserts episode rows keyed by TMDB episode id', async () => {
        mockResolveMediaTmdb.mockResolvedValue({
            tmdbId: 1399,
            current: {
                media_type: 'tv',
                title: 'Show',
                year: 2011,
                overview: '',
                metadata_locked: false,
            },
        });
        mockFindEpisodeDataByProviderEpisodeId.mockResolvedValue({
            id: 'episode-uuid-1',
            title: 'Ep1',
            seasonNumber: 1,
            episodeNumber: 1,
            runtimeSeconds: null,
        });
        const api = makeApi({
            getTVShowDetails: vi.fn().mockResolvedValue({
                translations: { translations: [{ iso_639_1: 'de', data: { title: 'Serie DE' } }] },
                seasons: [{ season_number: 1 }],
            }),
            getSeasonEpisodesInLanguage: vi.fn().mockResolvedValue([
                {
                    id: 78914,
                    name: 'Ep1 DE',
                    overview: 'ov',
                    episodeNumber: 1,
                    seasonNumber: 1,
                },
            ]),
        });

        const result = await syncTranslationsForItem(fakeSql, api, 'series-1', ['de']);

        expect(result.disposition).toBe('completed');
        expect(result.itemsProcessed).toBe(2); // series row + 1 episode row
        expect(api.getSeasonEpisodesInLanguage).toHaveBeenCalledWith(1399, 1, 'de', {
            throwOnError: true,
        });
        // Identity-stable lookup: resolve the local episode by its TMDB episode
        // id (stringified), NOT by (season, episode) position — position breaks
        // under TMDB re-numbering and active ordering overrides.
        expect(mockFindEpisodeDataByProviderEpisodeId).toHaveBeenCalledWith(
            fakeSql,
            'series-1',
            'tmdb',
            '78914',
        );
        // Id-match succeeded, so the positional fallback is never consulted.
        expect(mockFindEpisodeDataByPosition).not.toHaveBeenCalled();
        expect(mockUpsertMediaTranslations).toHaveBeenCalledWith(fakeSql, 'episode-uuid-1', [
            { language: 'de', title: 'Ep1 DE', overview: 'ov' },
        ]);
    });

    it('series: id-match attaches the German title to the right episode even when TMDB re-numbered (regression: Hafentage S2)', async () => {
        // Reproduces the prod bug: TMDB's *current* season 2 lists "Direktor
        // für einen Tag" at episode_number 24, but our local row for that
        // episode (tmdb id 78939, "Principal for a Day") is stored as ep22.
        // A positional match on episodeNumber=24 would resolve some OTHER local
        // row (or none); the id match must resolve id 78939 → our ep22 row.
        mockResolveMediaTmdb.mockResolvedValue({
            tmdbId: 1546,
            current: {
                media_type: 'tv',
                title: 'Hafentage',
                year: 1997,
                overview: '',
                metadata_locked: false,
            },
        });
        // Id-lookup returns the correct local row regardless of position.
        mockFindEpisodeDataByProviderEpisodeId.mockImplementation(
            async (_sql, _series, _provider, providerEpisodeId) =>
                providerEpisodeId === '78939'
                    ? {
                          id: 'principal-for-a-day-uuid',
                          title: 'Principal for a Day',
                          seasonNumber: 2,
                          episodeNumber: 22,
                          runtimeSeconds: null,
                      }
                    : null,
        );
        const api = makeApi({
            getTVShowDetails: vi.fn().mockResolvedValue({ seasons: [{ season_number: 2 }] }),
            getSeasonEpisodesInLanguage: vi.fn().mockResolvedValue([
                {
                    id: 78939,
                    name: 'Direktor für einen Tag',
                    overview: 'ov',
                    episodeNumber: 24, // TMDB's current number ≠ our stored 22
                    seasonNumber: 2,
                },
            ]),
        });

        await syncTranslationsForItem(fakeSql, api, 'series-hafentage', ['de']);

        expect(mockFindEpisodeDataByProviderEpisodeId).toHaveBeenCalledWith(
            fakeSql,
            'series-hafentage',
            'tmdb',
            '78939',
        );
        // The German title lands on the correct local episode, and the wrong
        // positional lookup is never even attempted.
        expect(mockFindEpisodeDataByPosition).not.toHaveBeenCalled();
        expect(mockUpsertMediaTranslations).toHaveBeenCalledWith(
            fakeSql,
            'principal-for-a-day-uuid',
            [{ language: 'de', title: 'Direktor für einen Tag', overview: 'ov' }],
        );
    });

    it('series: falls back to positional match when the episode has no local tmdb id', async () => {
        mockResolveMediaTmdb.mockResolvedValue({
            tmdbId: 1399,
            current: {
                media_type: 'tv',
                title: 'Show',
                year: 2011,
                overview: '',
                metadata_locked: false,
            },
        });
        mockFindEpisodeDataByProviderEpisodeId.mockResolvedValue(null);
        mockFindEpisodeDataByPosition.mockResolvedValue({
            id: 'episode-uuid-fallback',
            title: 'Ep1',
            seasonNumber: 1,
            episodeNumber: 1,
            runtimeSeconds: null,
        });
        const api = makeApi({
            getTVShowDetails: vi.fn().mockResolvedValue({ seasons: [{ season_number: 1 }] }),
            getSeasonEpisodesInLanguage: vi.fn().mockResolvedValue([
                {
                    id: 78914,
                    name: 'Ep1 DE',
                    overview: 'ov',
                    episodeNumber: 1,
                    seasonNumber: 1,
                },
            ]),
        });

        const result = await syncTranslationsForItem(fakeSql, api, 'series-1', ['de']);

        expect(result.disposition).toBe('completed');
        expect(mockFindEpisodeDataByProviderEpisodeId).toHaveBeenCalledWith(
            fakeSql,
            'series-1',
            'tmdb',
            '78914',
        );
        expect(mockFindEpisodeDataByPosition).toHaveBeenCalledWith(fakeSql, 'series-1', 1, 1);
        expect(mockUpsertMediaTranslations).toHaveBeenCalledWith(fakeSql, 'episode-uuid-fallback', [
            { language: 'de', title: 'Ep1 DE', overview: 'ov' },
        ]);
    });

    it('series: a malformed/zero TMDB episode id skips the id lookup and goes straight to positional fallback', async () => {
        mockResolveMediaTmdb.mockResolvedValue({
            tmdbId: 1399,
            current: {
                media_type: 'tv',
                title: 'Show',
                year: 2011,
                overview: '',
                metadata_locked: false,
            },
        });
        mockFindEpisodeDataByPosition.mockResolvedValue({
            id: 'episode-uuid-posonly',
            title: 'Ep1',
            seasonNumber: 1,
            episodeNumber: 1,
            runtimeSeconds: null,
        });
        const api = makeApi({
            getTVShowDetails: vi.fn().mockResolvedValue({ seasons: [{ season_number: 1 }] }),
            getSeasonEpisodesInLanguage: vi
                .fn()
                .mockResolvedValue([
                    { id: 0, name: 'Ep1 DE', overview: 'ov', episodeNumber: 1, seasonNumber: 1 },
                ]),
        });

        const result = await syncTranslationsForItem(fakeSql, api, 'series-1', ['de']);

        expect(result.disposition).toBe('completed');
        // id === 0 is not a usable tmdb id → the id lookup is never issued.
        expect(mockFindEpisodeDataByProviderEpisodeId).not.toHaveBeenCalled();
        expect(mockFindEpisodeDataByPosition).toHaveBeenCalledWith(fakeSql, 'series-1', 1, 1);
        expect(mockUpsertMediaTranslations).toHaveBeenCalledWith(fakeSql, 'episode-uuid-posonly', [
            { language: 'de', title: 'Ep1 DE', overview: 'ov' },
        ]);
    });

    it('series: logs a warning when the positional fallback actually resolves a row', async () => {
        mockResolveMediaTmdb.mockResolvedValue({
            tmdbId: 1399,
            current: {
                media_type: 'tv',
                title: 'Show',
                year: 2011,
                overview: '',
                metadata_locked: false,
            },
        });
        mockFindEpisodeDataByProviderEpisodeId.mockResolvedValue(null);
        mockFindEpisodeDataByPosition.mockResolvedValue({
            id: 'episode-uuid-fallback',
            title: 'Ep1',
            seasonNumber: 1,
            episodeNumber: 1,
            runtimeSeconds: null,
        });
        const api = makeApi({
            getTVShowDetails: vi.fn().mockResolvedValue({ seasons: [{ season_number: 1 }] }),
            getSeasonEpisodesInLanguage: vi.fn().mockResolvedValue([
                {
                    id: 78914,
                    name: 'Ep1 DE',
                    overview: 'ov',
                    episodeNumber: 1,
                    seasonNumber: 1,
                },
            ]),
        });
        const warn = vi.fn();

        await syncTranslationsForItem(fakeSql, api, 'series-1', ['de'], { warn });

        expect(warn).toHaveBeenCalledTimes(1);
        expect(warn.mock.calls[0][0]).toContain('positional fallback');
        expect(warn.mock.calls[0][1]).toMatchObject({
            mediaItemId: 'series-1',
            tmdbEpisodeId: 78914,
            resolvedEpisodeId: 'episode-uuid-fallback',
        });
    });

    it('series: episode with no locally-resolvable id (id OR position) is skipped, does not throw', async () => {
        mockResolveMediaTmdb.mockResolvedValue({
            tmdbId: 1399,
            current: {
                media_type: 'series',
                title: 'Show',
                year: 2011,
                overview: '',
                metadata_locked: false,
            },
        });
        mockFindEpisodeDataByProviderEpisodeId.mockResolvedValue(null);
        mockFindEpisodeDataByPosition.mockResolvedValue(null);
        const api = makeApi({
            getTVShowDetails: vi.fn().mockResolvedValue({ seasons: [{ season_number: 1 }] }),
            getSeasonEpisodesInLanguage: vi.fn().mockResolvedValue([
                {
                    id: 78914,
                    name: 'Ep1 DE',
                    overview: 'ov',
                    episodeNumber: 1,
                    seasonNumber: 1,
                },
            ]),
        });

        const result = await syncTranslationsForItem(fakeSql, api, 'series-1', ['de']);

        expect(result.disposition).toBe('completed');
        // Only the series-row upsert (0 rows written since no translations
        // block in this fixture) — the episode was skipped, not upserted.
        expect(mockUpsertMediaTranslations).toHaveBeenCalledTimes(1);
    });

    it('season fetch failure propagates (stage-state retry semantics)', async () => {
        mockResolveMediaTmdb.mockResolvedValue({
            tmdbId: 1399,
            current: {
                media_type: 'series',
                title: 'Show',
                year: 2011,
                overview: '',
                metadata_locked: false,
            },
        });
        const seasonError = new Error('tmdb 500');
        const api = makeApi({
            getTVShowDetails: vi.fn().mockResolvedValue({ seasons: [{ season_number: 1 }] }),
            getSeasonEpisodesInLanguage: vi.fn().mockRejectedValue(seasonError),
        });

        await expect(syncTranslationsForItem(fakeSql, api, 'series-1', ['de'])).rejects.toThrow(
            'tmdb 500',
        );
    });

    it('unsupported media_type → skipped_permanent/unsupported-media-type', async () => {
        mockResolveMediaTmdb.mockResolvedValue({
            tmdbId: 1,
            current: {
                media_type: 'album',
                title: 'X',
                year: null,
                overview: null,
                metadata_locked: false,
            },
        });
        const api = makeApi();

        const result = await syncTranslationsForItem(fakeSql, api, 'item-1', ['de']);

        expect(result).toEqual({
            disposition: 'skipped_permanent',
            reason: 'unsupported-media-type',
            itemsProcessed: 0,
        });
    });
});

describe('metadataTranslationsSyncTask.execute — writeSkippedPermanent UPSERT (finding 1)', () => {
    /** Reassemble a tagged-template mock call's SQL text for shape assertions. */
    function sqlTextOfCall(call: unknown[]): string {
        const strings = call[0] as readonly string[];
        return strings.join('?');
    }

    it('no pre-existing stage row + no TMDB id → INSERT ... ON CONFLICT DO UPDATE writes a skipped_permanent row', async () => {
        // Non-empty admin list so syncTranslationsForItem proceeds past the
        // 'translations-disabled' short-circuit and actually calls
        // resolveMediaTmdb.
        const langSpy = vi
            .spyOn(config, 'METADATA_ADDITIONAL_LANGUAGES', 'get')
            .mockReturnValue(['de']);
        mockResolveMediaTmdb.mockResolvedValue(null);

        // A bare tagged-template stand-in that just records what was issued —
        // simulating the "no wrapExecute seeded row yet" case the bug
        // report describes (unit tests, and any future caller that invokes
        // `execute()` without going through the runner's `wrapExecute`,
        // never get a pre-seeded `media_item_stage_state` row). A real
        // Postgres UPSERT would create the row from nothing; this fake just
        // has to prove the ISSUED statement is an UPSERT (INSERT ... ON
        // CONFLICT DO UPDATE) rather than the old UPDATE-only no-op.
        const sqlCalls: unknown[][] = [];
        const fakeExecSql = ((...args: unknown[]) => {
            sqlCalls.push(args);
            return Promise.resolve({ count: 1 });
        }) as unknown as postgres.Sql;

        try {
            const result = await runTask(
                metadataTranslationsSyncTask,
                { mediaItemId: 'item-no-row' },
                { sql: fakeExecSql, runId: 'run-1' },
            );

            expect(result.success).toBe(false);
            expect(sqlCalls).toHaveLength(1);
            const text = sqlTextOfCall(sqlCalls[0]);
            expect(text).toContain('INSERT INTO media_item_stage_state');
            expect(text).toContain('ON CONFLICT (media_item_id, stage_id) DO UPDATE');
            expect(text).toContain("status = 'skipped_permanent'");
            // The values array (everything after the strings array) carries
            // the interpolated params — confirm the reason and mediaItemId
            // actually made it into the statement.
            expect(sqlCalls[0]).toContain('no-primary-external-id');
            expect(sqlCalls[0]).toContain('item-no-row');
        } finally {
            langSpy.mockRestore();
        }
    });
});

describe('task manifests', () => {
    it('metadataTranslationsSyncTask exposes the expected stage contract', () => {
        expect(metadataTranslationsSyncTask.id).toBe('metadata-translations-sync');
        // registry.registerTask() applies the Wave 8.5 legacy-class compat
        // shim in place ('bulk' → physical 'io') at import time, so by the
        // time this test file imports the module the field already reflects
        // the physical class, not the declared one.
        expect(metadataTranslationsSyncTask.resourceClass).toBe('io');
        expect(metadataTranslationsSyncTask.schedule).toBeUndefined();
        expect(metadataTranslationsSyncTask.coversStages).toHaveLength(1);
        expect(metadataTranslationsSyncTask.coversStages?.[0]).toMatchObject({
            id: 'metadata-translations-sync',
            appliesTo: ['movie', 'series'],
            enqueueable: true,
        });
    });

    it('metadataTranslationsSeedTask is scheduled (not manualOnly) and self-guards on empty config', () => {
        expect(metadataTranslationsSeedTask.id).toBe('metadata-translations-seed');
        expect(metadataTranslationsSeedTask.schedule).toEqual({ every: '24h' });
        expect(metadataTranslationsSeedTask.manualOnly).toBeUndefined();
        expect(metadataTranslationsSeedTask.exclusiveWith).toEqual({ scope: 'global', ttl: '20m' });
    });
});

describe('metadataTranslationsSeedTask.execute', () => {
    /** Reassemble a tagged-template mock call's SQL text for shape assertions. */
    function sqlTextOfCall(call: unknown[]): string {
        const strings = call[0] as readonly string[];
        return strings.join('?');
    }

    beforeEach(() => {
        mockTx.mockResolvedValue({ count: 0 });
        mockReEnrollCompletedStageForReset.mockResolvedValue(0);
    });

    it('no admin languages → no-op without opening a transaction', async () => {
        const langSpy = vi
            .spyOn(config, 'METADATA_ADDITIONAL_LANGUAGES', 'get')
            .mockReturnValue([]);
        try {
            const result = await runTask(metadataTranslationsSeedTask, {});
            expect(result.success).toBe(true);
            expect(result.itemsProcessed).toBe(0);
            expect(mockTx).not.toHaveBeenCalled();
            expect(mockReEnrollCompletedStageForReset).not.toHaveBeenCalled();
        } finally {
            langSpy.mockRestore();
        }
    });

    it('scheduled run (no reEnroll input) seeds + un-skips but NEVER re-enrolls completed rows', async () => {
        const langSpy = vi
            .spyOn(config, 'METADATA_ADDITIONAL_LANGUAGES', 'get')
            .mockReturnValue(['de']);
        try {
            const result = await runTask(metadataTranslationsSeedTask, {});
            expect(result.success).toBe(true);
            // INSERT (seed) + UPDATE (un-skip translations-disabled) — and no
            // reEnrollCompletedStageForReset, or the daily schedule would
            // re-fetch the whole completed catalog from TMDB every 24h.
            expect(mockTx).toHaveBeenCalledTimes(2);
            expect(mockReEnrollCompletedStageForReset).not.toHaveBeenCalled();

            // Seed INSERT shape: concurrent-enroll race guard + item-status
            // guard mirroring findSweepCandidates.
            const insertSql = sqlTextOfCall(mockTx.mock.calls[0]);
            expect(insertSql).toContain('ON CONFLICT (media_item_id, stage_id) DO NOTHING');
            expect(insertSql).toContain("mi.status = 'active'");
            expect(insertSql).toContain('COALESCE(mi.is_dismissed, false) = false');
        } finally {
            langSpy.mockRestore();
        }
    });

    it('reEnroll: true additionally re-enrolls completed rows (settings-save hook path)', async () => {
        const langSpy = vi
            .spyOn(config, 'METADATA_ADDITIONAL_LANGUAGES', 'get')
            .mockReturnValue(['de']);
        try {
            mockReEnrollCompletedStageForReset.mockResolvedValue(7);
            const result = await runTask(metadataTranslationsSeedTask, { reEnroll: true });
            expect(result.success).toBe(true);
            expect(mockReEnrollCompletedStageForReset).toHaveBeenCalledTimes(1);
            expect(mockReEnrollCompletedStageForReset).toHaveBeenCalledWith(
                mockTx,
                'metadata-translations-sync',
            );
            expect(result.itemsProcessed).toBe(7);
        } finally {
            langSpy.mockRestore();
        }
    });
});
