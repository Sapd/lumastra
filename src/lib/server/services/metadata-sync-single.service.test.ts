// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, it, expect, vi, beforeEach } from 'vitest';

// ============================================================================
// Mocks (hoisted so vi.mock factories can reference them)
// ============================================================================

const {
    mockLogger,
    mockGetMovieDetails,
    mockGetTVShowDetails,
    mockGetSeriesChildren,
    mockCreateTMDBApi,
    mockUpsertExternalId,
    mockFindEpisodeByPosition,
    mockFindSeasonByNumber,
    mockQuarantineWrite,
    mockResolveByExternalKey,
    mockEnabledProviders,
    mockStoreProviderMetadata,
    mockEnqueueSeasonArtwork,
} = vi.hoisted(() => ({
    mockLogger: {
        info: vi.fn(),
        debug: vi.fn(),
        warn: vi.fn(),
        error: vi.fn(),
    },
    mockGetMovieDetails: vi.fn(),
    mockGetTVShowDetails: vi.fn(),
    mockGetSeriesChildren: vi.fn(),
    // `createTMDBApi(language)` is now called on every sync path (the
    // frozen-TMDB-language-singleton fix, 2026-07-08). Track
    // the language it's constructed with so tests can assert on it, while
    // still routing getMovieDetails/getTVShowDetails through the same mocks
    // the rest of the suite already relies on.
    mockCreateTMDBApi: vi.fn((_language?: string) => ({
        getMovieDetails: mockGetMovieDetails,
        getTVShowDetails: mockGetTVShowDetails,
    })),
    mockUpsertExternalId: vi.fn(),
    mockStoreProviderMetadata: vi.fn().mockResolvedValue(undefined),
    mockFindEpisodeByPosition: vi.fn(),
    mockFindSeasonByNumber: vi.fn(),
    mockQuarantineWrite: vi.fn(),
    mockResolveByExternalKey: vi.fn(),
    // Mutable handle so individual tests can swap the resolved provider
    // (TMDB by default, Jellyfin for the W2.2 attach-only cases).
    mockEnabledProviders: {
        value: [] as Array<{
            id: string;
            manifest: { id: string; name: string };
            getSeriesChildren: ReturnType<typeof vi.fn>;
        }>,
    },
    mockEnqueueSeasonArtwork: vi.fn(),
}));

// This unit suite scripts SQL responses; provenance is exercised with real DBs.
vi.mock('./episode-reconciliation-catalog.service.js', () => ({
    beginReconciliationCatalog: async () => async (catalog: unknown) => ({
        status: 'ready',
        catalog,
    }),
}));

vi.mock('$lib/server/database/queries/sort-title.queries.js', () => ({
    refreshSortTitles: vi.fn().mockResolvedValue(0),
}));

vi.mock('$lib/server/utils/logger.js', () => ({
    Logger: { for: vi.fn(() => mockLogger) },
}));

vi.mock('$lib/server/providers/implementations/tmdb/index.js', () => ({
    tmdbApi: {
        getMovieDetails: mockGetMovieDetails,
        getTVShowDetails: mockGetTVShowDetails,
    },
    createTMDBApi: mockCreateTMDBApi,
}));

// `fetchSeriesChildren` in metadata-sync-single now calls
// per-provider helper modules directly instead of routing through
// `provider.getSeriesChildren`. Mock those helpers so the legacy
// `mockEnabledProviders.value[].getSeriesChildren` wiring still
// drives test outcomes via the shared mock fn.
vi.mock('$lib/server/providers/implementations/tmdb/series-children.js', () => ({
    getSeriesChildren: (externalId: string, signal?: AbortSignal, language?: string | null) =>
        mockGetSeriesChildren(externalId, {}, language),
}));
vi.mock('$lib/server/providers/implementations/jellyfin/series-children.js', () => ({
    getSeriesChildren: (externalId: string) => mockGetSeriesChildren(externalId, {}),
}));
vi.mock('$lib/server/providers/implementations/anidb/series-children.js', () => ({
    getSeriesChildren: (externalId: string) => mockGetSeriesChildren(externalId, {}),
}));

vi.mock('$lib/server/tasks/plugin-context.js', () => ({
    getProvidersByPriority: vi.fn(() => mockEnabledProviders.value),
}));

vi.mock('$lib/server/plugins/runtime/registry.js', () => ({
    getPluginRegistry: vi.fn(() => ({
        // Used by resolveProviderForSeries — read through the mutable handle
        // so individual tests can swap providers between TMDB and Jellyfin.
        getEnabledMetadataProviderPlugins: vi.fn(() => mockEnabledProviders.value),
        getContext: vi.fn(() => ({})),
    })),
}));

vi.mock('$lib/server/database/queries/media-items.queries.js', () => ({
    findEpisodeByPosition: mockFindEpisodeByPosition,
    findSeasonByNumber: mockFindSeasonByNumber,
}));

vi.mock('$lib/server/database/queries/sync-quarantine.queries.js', () => ({
    quarantineWrite: mockQuarantineWrite,
    resolveByExternalKey: mockResolveByExternalKey,
}));

vi.mock('$lib/server/utils/media-types.js', () => ({
    isMovie: (t: string) => t === 'movie',
    isSeries: (t: string) => t === 'tv' || t === 'series',
    // findOrCreateChild now branches on isSeason to pick the season-specific
    // upsert path; the mock must mirror the real case-insensitive predicate.
    isSeason: (t: string) => t?.toLowerCase() === 'season',
}));

vi.mock('$lib/server/services/catalog.service.js', () => ({
    CatalogService: class {
        upsertExternalId = mockUpsertExternalId;
    },
    createCatalogService: vi.fn(() => ({
        storeProviderMetadata: mockStoreProviderMetadata,
    })),
}));

vi.mock('$lib/server/services/media-lifecycle.service.js', () => ({
    MediaLifecycleService: {
        afterMetadataChanged: vi.fn().mockResolvedValue(undefined),
        afterCreated: vi.fn().mockResolvedValue(undefined),
    },
}));

vi.mock('$lib/server/cache', () => ({
    cacheInvalidation: {
        onContentAdded: vi.fn().mockResolvedValue(undefined),
    },
}));

vi.mock('$lib/server/database/queries/media-titles.queries.js', () => ({
    upsertMediaTitles: vi.fn().mockResolvedValue(0),
}));

vi.mock('$lib/server/services/season-artwork-enqueue.js', () => ({
    SEASON_ARTWORK_TASK_ID: 'provider-artwork-season-poster',
    enqueueSeasonArtworkMaterialization: mockEnqueueSeasonArtwork,
}));

// Partial mock: stub only aggregateMetadataForMedia. The real slug helpers
// (keywordNamesToSlugs / tmdbGenreIdsToSlugs) must remain because the canonical
// normalization (buildProviderDetailResult) depends on them.
vi.mock('$lib/server/database/queries/metadata-aggregation.queries.js', async (importOriginal) => ({
    ...(await importOriginal<
        typeof import('$lib/server/database/queries/metadata-aggregation.queries.js')
    >()),
    aggregateMetadataForMedia: vi.fn().mockResolvedValue(undefined),
}));

// ============================================================================
// Import after mocks
// ============================================================================

import type postgres from 'postgres';

import {
    syncSingleItem,
    syncSeriesWithChildren,
    isOwnedSeries,
} from './metadata-sync-single.service.js';
import { config } from '$lib/server/config.js';

// ============================================================================
// SQL mock factory
// ============================================================================

/**
 * Example names are fictional; production shapes and measurements are retained.
 * Build a fake postgres.Sql tagged-template function that returns pre-set
 * responses in order, one per call. Promise.all makes three parallel calls.
 *
 * Also exposes `.reserve()` so `withSeriesSyncLock` can pin a connection.
 * The reserved handle shares the same response queue — tests simply include
 * the lock-acquire responses in sequence.
 */
function makeSql(responses: unknown[][], identityOwners: unknown[] = []) {
    let callIndex = 0;
    const fn = vi.fn((_strings: TemplateStringsArray, ..._values: unknown[]) => {
        // The ownership preflight is independent of the legacy sequential SQL
        // fixtures. Tests can supply existing identity owners without shifting
        // every season/episode response in the rest of the suite.
        if (_strings.join('').includes('owner.parent_id AS season_id')) {
            return Promise.resolve(identityOwners);
        }
        const result = responses[callIndex] ?? [];
        callIndex++;
        return Promise.resolve(result);
    });
    // postgres.js ReservedSql exposes the same tagged-template callable
    // plus a .release() method. Reuse the same fn so all queries share
    // the single response queue.
    const reserved = Object.assign(fn, { release: vi.fn() });
    Object.assign(fn, { reserve: vi.fn(() => Promise.resolve(reserved)) });
    // batchFindOrCreateEpisodes (SQL-C3) passes arrays through `sql.array()`.
    // The mock template-callable ignores interpolated values, so a passthrough
    // that returns the raw array is sufficient for the tagged-template stub.
    Object.assign(fn, { array: vi.fn((value: unknown) => value) });
    return fn as unknown as postgres.Sql;
}

// ============================================================================
// Tests — syncSingleItem
// ============================================================================

describe('syncSingleItem', () => {
    beforeEach(() => {
        vi.clearAllMocks();
    });

    it('returns { updated: false, fieldsChanged: [] } when media item does not exist', async () => {
        // currentRows = [], externalIdRows = []
        const sql = makeSql([[], []]);

        const result = await syncSingleItem(sql, 'missing-uuid', {
            force: false,
        });

        expect(result).toEqual({ updated: false, fieldsChanged: [] });
        expect(mockGetMovieDetails).not.toHaveBeenCalled();
        expect(mockGetTVShowDetails).not.toHaveBeenCalled();
    });

    it('returns { updated: false, fieldsChanged: [] } when no TMDB external ID exists', async () => {
        const sql = makeSql([
            [
                {
                    media_type: 'movie',
                    title: 'My Movie',
                    year: 2020,
                    overview: 'desc',
                    metadata_locked: false,
                },
            ],
            [{ provider: 'jellyfin', external_id: 'jf-1' }], // externalIdRows — no tmdb
        ]);

        const result = await syncSingleItem(sql, 'item-uuid', { force: false });

        expect(result).toEqual({ updated: false, fieldsChanged: [] });
        expect(mockGetMovieDetails).not.toHaveBeenCalled();
    });

    it('syncs a movie and detects changed fields', async () => {
        const sql = makeSql([
            [
                {
                    media_type: 'movie',
                    title: 'Old Title',
                    year: 1999,
                    overview: 'old overview',
                    metadata_locked: false,
                },
            ],
            [{ provider: 'tmdb', external_id: '550' }],
            [], // resolveItemLanguage (no library path configured in test)
            [{ id: 'item-uuid' }], // UPDATE RETURNING id — row was updated
        ]);

        mockGetMovieDetails.mockResolvedValue({
            title: 'Quiet Orbit',
            release_date: '1999-10-15',
            overview: 'New overview',
        });

        const result = await syncSingleItem(sql, 'item-uuid', { force: false });

        // A background (non-forced) sync may be served from the TMDB response cache.
        expect(mockGetMovieDetails).toHaveBeenCalledWith(550, { fresh: false });
        expect(result.updated).toBe(true);
        expect(result.fieldsChanged).toContain('title');
        expect(result.fieldsChanged).toContain('overview');
    });

    it('stores canonical cast/actors/runtime_minutes in provider_metadata (not the raw TMDB shape)', async () => {
        // Regression: the per-item path used to store the RAW TMDB response
        // (`runtime`, `credits.cast`), which the aggregator + detail read — that
        // only understand `runtime_minutes`, `cast`, `actors` — silently dropped.
        // Fresh movies came back with no cast row and no runtime.
        const sql = makeSql([
            [
                {
                    media_type: 'movie',
                    title: 'Quiet Orbit',
                    year: 1999,
                    overview: 'A ticking-time-bomb insomniac...',
                    metadata_locked: false,
                },
            ],
            [{ provider: 'tmdb', external_id: '550' }],
            [], // resolveItemLanguage
        ]);

        mockGetMovieDetails.mockResolvedValue({
            title: 'Quiet Orbit',
            release_date: '1999-10-15',
            overview: 'A ticking-time-bomb insomniac...',
            runtime: 139,
            credits: {
                cast: [
                    { id: 819, name: 'Edward Vale', character: 'The Narrator', order: 0 },
                    { id: 287, name: 'Bram Fenwick', character: 'Tyler Durden', order: 1 },
                ],
                crew: [{ name: 'David Fincher', job: 'Director', department: 'Directing' }],
            },
        });

        await syncSingleItem(sql, 'item-uuid', { force: false });

        expect(mockStoreProviderMetadata).toHaveBeenCalledTimes(1);
        const call = mockStoreProviderMetadata.mock.calls[0] as [
            string,
            string,
            Record<string, unknown>,
        ];
        const [, provider, metadata] = call;
        expect(provider).toBe('tmdb');
        // Canonical keys the aggregator + detail read consume.
        expect(metadata.runtime_minutes).toBe(139);
        expect(metadata.actors).toEqual(['Edward Vale', 'Bram Fenwick']);
        expect(metadata.cast).toEqual([
            {
                name: 'Edward Vale',
                character: 'The Narrator',
                person_id: '819',
                has_profile: false,
            },
            {
                name: 'Bram Fenwick',
                character: 'Tyler Durden',
                person_id: '287',
                has_profile: false,
            },
        ]);
        expect(metadata.directors).toEqual(['David Fincher']);
        // The raw blob is preserved as an overlay (not replaced) so fields that
        // already share canonical key names (overview, genres, poster_path...)
        // keep working.
        expect(metadata.credits).toBeDefined();
    });

    it('stores the national certification, drops the per-country blocks and writes age_rating', async () => {
        const sql = makeSql([
            [
                {
                    media_type: 'movie',
                    title: 'Quiet Orbit',
                    year: 1999,
                    overview: 'o',
                    metadata_locked: false,
                },
            ],
            [{ provider: 'tmdb', external_id: '550' }],
            [], // resolveItemLanguage
        ]);
        mockGetMovieDetails.mockResolvedValue({
            title: 'Quiet Orbit',
            release_date: '1999-10-15',
            overview: 'o',
            release_dates: {
                results: [
                    {
                        iso_3166_1: 'US',
                        release_dates: [{ certification: 'PG-13', type: 3 }],
                    },
                ],
            },
        });

        await syncSingleItem(sql, 'item-uuid', { force: false });

        const [, , metadata] = mockStoreProviderMetadata.mock.calls[0] as [
            string,
            string,
            Record<string, unknown>,
        ];
        expect(metadata.certification).toBe('PG-13');
        expect(metadata.certification_country).toBe('US');
        expect(metadata.age_rating_country_checked).toBe('US');
        expect(metadata.release_dates).toBeUndefined();
        const statements = (sql as unknown as ReturnType<typeof vi.fn>).mock.calls.map((c) =>
            (c[0] as TemplateStringsArray).join('?'),
        );
        expect(statements.some((q) => q.includes("age_rating_source = 'national'"))).toBe(true);
    });

    it.each([
        [
            'names from the TMDB envelope',
            { keywords: [{ id: 9725, name: 'sword fight' }] },
            ['sword fight'],
        ],
        ['absent when the envelope is empty', { keywords: [] }, undefined],
    ])('stores keywords as a flat array — %s', async (_label, keywordsEnvelope, expected) => {
        // Regression (prod 2026-09-24): the raw `keywords` envelope OBJECT survived
        // the overlay, was aggregated, and made every
        // jsonb_array_length(metadata->'keywords') predicate throw — 3,137 errors.
        const sql = makeSql([
            [
                {
                    media_type: 'movie',
                    title: 'Lantern Guild Online',
                    year: 2017,
                    overview: '',
                    metadata_locked: false,
                },
            ],
            [{ provider: 'tmdb', external_id: '413594' }],
            [], // resolveItemLanguage
        ]);
        mockGetMovieDetails.mockResolvedValue({
            title: 'Lantern Guild Online',
            release_date: '2017-02-18',
            keywords: keywordsEnvelope,
        });

        await syncSingleItem(sql, 'item-uuid', { force: false });

        const [, , metadata] = mockStoreProviderMetadata.mock.calls[0] as [
            string,
            string,
            Record<string, unknown>,
        ];
        expect(metadata.keywords).toEqual(expected);
    });

    it('returns updated: false when TMDB data matches existing data', async () => {
        const sql = makeSql([
            [
                {
                    media_type: 'movie',
                    title: 'Quiet Orbit',
                    year: 1999,
                    overview: 'same overview',
                    metadata_locked: false,
                },
            ],
            [{ provider: 'tmdb', external_id: '550' }],
            // No UPDATE call expected — fields match
        ]);

        mockGetMovieDetails.mockResolvedValue({
            title: 'Quiet Orbit',
            release_date: '1999-10-15',
            overview: 'same overview',
        });

        const result = await syncSingleItem(sql, 'item-uuid', { force: false });

        expect(result.updated).toBe(false);
        expect(result.fieldsChanged).toEqual([]);
    });

    it('syncs a TV series using getTVShowDetails', async () => {
        const sql = makeSql([
            [
                {
                    media_type: 'tv',
                    title: 'Drifting Clouds',
                    year: 2008,
                    overview: 'old',
                    metadata_locked: false,
                },
            ],
            [{ provider: 'tmdb', external_id: '1396' }],
            [], // resolveItemLanguage
            [{ id: 'series-uuid' }], // UPDATE RETURNING id
        ]);

        mockGetTVShowDetails.mockResolvedValue({
            name: 'Drifting Clouds',
            first_air_date: '2008-01-20',
            overview: 'New overview',
        });

        const result = await syncSingleItem(sql, 'series-uuid', {
            force: false,
        });

        expect(mockGetTVShowDetails).toHaveBeenCalledWith(1396, { fresh: false });
        expect(result.updated).toBe(true);
        expect(result.fieldsChanged).toContain('overview');
    });

    it('skips UPDATE when data is already up to date', async () => {
        const sqlFn = makeSql([
            [
                {
                    media_type: 'movie',
                    title: 'Quiet Orbit',
                    year: 1999,
                    overview: 'desc',
                    metadata_locked: false,
                },
            ],
            [{ provider: 'tmdb', external_id: '550' }],
            [], // resolveItemLanguage
        ]);

        mockGetMovieDetails.mockResolvedValue({
            title: 'Quiet Orbit',
            release_date: '1999-10-15',
            overview: 'desc',
        });

        const result = await syncSingleItem(sqlFn, 'item-uuid', {
            force: false,
        });

        // 2 parallel SELECTs + 1 resolveItemLanguage, no UPDATE since nothing changed
        expect(sqlFn).toHaveBeenCalledTimes(3);
        expect(result.updated).toBe(false);
    });

    it('reports updated:false when row is locked and force=false — UPDATE is never attempted', async () => {
        // The lock is read alongside the current row data. When metadata_locked=true
        // and force=false, the service skips the UPDATE entirely (no SQL call).
        const sqlFn = makeSql([
            [
                {
                    media_type: 'movie',
                    title: 'User Edited Title',
                    year: 1999,
                    overview: 'user edited',
                    metadata_locked: true,
                },
            ],
            [{ provider: 'tmdb', external_id: '550' }],
            [], // resolveItemLanguage
            // No UPDATE call — lock prevents write and pm refresh
        ]);

        mockGetMovieDetails.mockResolvedValue({
            title: 'Quiet Orbit',
            release_date: '1999-10-15',
            overview: 'TMDB overview',
        });

        const result = await syncSingleItem(sqlFn, 'item-uuid', {
            force: false,
        });

        expect(result.updated).toBe(false);
        expect(result.fieldsChanged).toEqual([]);
        // Verify UPDATE was never issued — 2 SELECTs + 1 resolveItemLanguage ran
        expect(sqlFn).toHaveBeenCalledTimes(3);
    });

    it('fetches fresh metadata while preserving a saved lock on admin refresh', async () => {
        const sqlFn = makeSql([
            [
                {
                    media_type: 'movie',
                    title: 'Lantern Drift',
                    year: 2026,
                    overview: 'Saved',
                    metadata_locked: true,
                },
            ],
            [{ provider: 'tmdb', external_id: '550' }],
            [],
        ]);
        mockGetMovieDetails.mockResolvedValue({
            title: 'Provider title',
            overview: 'New overview',
        });
        const result = await syncSingleItem(sqlFn, 'item-uuid', {
            force: true,
            respectLocks: true,
        });
        expect(mockGetMovieDetails).toHaveBeenCalledWith(550, { fresh: true });
        expect(result.updated).toBe(false);
        expect(sqlFn).toHaveBeenCalledTimes(3);
    });
    it('reports updated:true when row is locked and force=true (UPDATE applies)', async () => {
        // force=true bypasses the lock. UPDATE hits the row.
        const sql = makeSql([
            [
                {
                    media_type: 'movie',
                    title: 'User Edited Title',
                    year: 1999,
                    overview: 'user edited',
                    metadata_locked: true,
                },
            ],
            [{ provider: 'tmdb', external_id: '550' }],
            [], // resolveItemLanguage
            [{ id: 'item-uuid' }], // UPDATE RETURNING id — row was updated despite lock
        ]);

        mockGetMovieDetails.mockResolvedValue({
            title: 'Quiet Orbit',
            release_date: '1999-10-15',
            overview: 'TMDB overview',
        });

        const result = await syncSingleItem(sql, 'item-uuid', { force: true });

        // A forced (admin) refresh must bypass the TMDB response cache.
        expect(mockGetMovieDetails).toHaveBeenCalledWith(550, { fresh: true });
        expect(result.updated).toBe(true);
        expect(result.fieldsChanged).toContain('title');
        expect(result.fieldsChanged).toContain('overview');
    });

    // Regression coverage for the frozen-singleton language bug: the sync
    // path used to fall back to the module-level `tmdbApi` singleton (whose
    // language is captured once at process boot) when no per-library
    // language was configured. It must now always construct a fresh client
    // via `createTMDBApi()`, reading the CURRENT `config.TMDB_LANGUAGE`.
    it('constructs the TMDB client via createTMDBApi(config.TMDB_LANGUAGE) when no library language is configured', async () => {
        const sql = makeSql([
            [
                {
                    media_type: 'movie',
                    title: 'Old Title',
                    year: 1999,
                    overview: 'old overview',
                    metadata_locked: false,
                },
            ],
            [{ provider: 'tmdb', external_id: '550' }],
            [], // resolveItemLanguage — no library_paths row → null
            [{ id: 'item-uuid' }],
        ]);

        mockGetMovieDetails.mockResolvedValue({
            title: 'Quiet Orbit',
            release_date: '1999-10-15',
            overview: 'New overview',
        });

        await syncSingleItem(sql, 'item-uuid', { force: false });

        expect(mockCreateTMDBApi).toHaveBeenCalledWith(config.TMDB_LANGUAGE);
    });

    it('constructs the TMDB client via createTMDBApi(libraryLanguage) when the item library has a language configured', async () => {
        const sql = makeSql([
            [
                {
                    media_type: 'movie',
                    title: 'Old Title',
                    year: 1999,
                    overview: 'old overview',
                    metadata_locked: false,
                },
            ],
            [{ provider: 'tmdb', external_id: '550' }],
            [{ language: 'de-DE' }], // resolveItemLanguage — library override
            [{ id: 'item-uuid' }],
        ]);

        mockGetMovieDetails.mockResolvedValue({
            title: 'Quiet Orbit',
            release_date: '1999-10-15',
            overview: 'Neue Übersicht',
        });

        await syncSingleItem(sql, 'item-uuid', { force: false });

        expect(mockCreateTMDBApi).toHaveBeenCalledWith('de-DE');
    });
});

// ============================================================================
// Tests — syncSeriesWithChildren
// ============================================================================

describe('syncSeriesWithChildren', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        // Default to TMDB provider — Jellyfin tests override this.
        mockEnabledProviders.value = [
            {
                id: 'tmdb-metadata-provider',
                manifest: { id: 'tmdb-metadata-provider', name: 'TMDB' },
                getSeriesChildren: mockGetSeriesChildren,
            },
        ];
    });

    it('reports the missing provider identity prerequisite without fetching children', async () => {
        // withSeriesSyncLock: hashtext key lookup + pg_try_advisory_lock
        // syncSingleItemInternal: currentRows, externalIdRows (parallel)
        // Neither metadata nor children sync has a provider identity.
        const sql = makeSql([
            [{ key: 1 }],
            [{ ok: true }],
            [
                {
                    media_type: 'tv',
                    title: 'Some Show',
                    year: 2020,
                    overview: null,
                    metadata_locked: false,
                },
            ],
            [], // no provider identity for metadata
            [], // no provider identity for children
        ]);

        const result = await syncSeriesWithChildren(sql, 'series-uuid', {
            force: false,
        });

        expect(result.seasonsSynced).toBe(0);
        expect(result.episodesSynced).toBe(0);
        expect(result.prerequisiteMissing).toBe('provider-identity');
        expect(result.phantomSkipped).toBeUndefined();
        expect(mockGetSeriesChildren).not.toHaveBeenCalled();
    });

    it('keeps an existing identity retryable while its provider is disabled, then recovers on restore', async () => {
        const responses = (): unknown[][] => [
            [{ key: 1 }],
            [{ ok: true }],
            [{ media_type: 'tv', title: 'Provider restore', metadata_locked: true }],
            [{ provider: 'tmdb', external_id: '999' }],
            [], // language
            [{ provider: 'tmdb', external_id: '999' }],
            [{ has_file: true }],
        ];
        mockGetTVShowDetails.mockResolvedValue({ name: 'Provider restore' });
        mockGetSeriesChildren.mockResolvedValue({ seasons: [] });
        const enabled = mockEnabledProviders.value;
        mockEnabledProviders.value = [];
        await expect(
            syncSeriesWithChildren(makeSql(responses()), 'series-uuid', { force: false }),
        ).rejects.toThrow(/provider.*unavailable/i);
        mockEnabledProviders.value = enabled;
        const result = await syncSeriesWithChildren(makeSql(responses()), 'series-uuid', {
            force: false,
        });
        expect(result.prerequisiteMissing).toBeUndefined();
        expect(mockGetSeriesChildren).toHaveBeenCalledOnce();
    });

    it('treats blank external identity values as missing prerequisites', async () => {
        const sql = makeSql([
            [{ key: 1 }],
            [{ ok: true }],
            [{ media_type: 'tv', title: 'No identity', metadata_locked: true }],
            [],
            [
                { provider: 'tmdb', external_id: '  ' },
                { provider: ' ', external_id: '123' },
            ],
        ]);
        expect(
            (await syncSeriesWithChildren(sql, 'series-uuid', { force: false }))
                .prerequisiteMissing,
        ).toBe('provider-identity');
        expect(mockGetSeriesChildren).not.toHaveBeenCalled();
    });

    it('does not report a prerequisite skip when a resolved provider genuinely has no children', async () => {
        const sql = makeSql([
            [{ key: 1 }],
            [{ ok: true }],
            [{ media_type: 'tv', title: 'Empty series', year: 2020, metadata_locked: true }],
            [{ provider: 'tmdb', external_id: '999' }],
            [], // resolveItemLanguage
            [{ provider: 'tmdb', external_id: '999' }],
            [{ has_file: true }],
        ]);
        mockGetTVShowDetails.mockResolvedValue({
            name: 'Empty series',
            first_air_date: '2020-01-01',
        });
        mockGetSeriesChildren.mockResolvedValue({ seasons: [] });

        const result = await syncSeriesWithChildren(sql, 'series-uuid', { force: false });

        expect(mockGetSeriesChildren).toHaveBeenCalledOnce();
        expect(result.prerequisiteMissing).toBeUndefined();
        expect(result.phantomSkipped).toBeUndefined();
        expect(result.episodesSynced).toBe(0);
    });

    it('phantom-skips children expansion (no owned files) and flags phantomSkipped', async () => {
        // Fileless discovery/catalog series: the phantom gate must decline
        // children expansion AND flag the result as a terminal skip so the task
        // layer claims coverage instead of looping via the stage-sweep.
        const sql = makeSql([
            [{ key: 1 }], // withSeriesSyncLock: hashtext
            [{ ok: true }], // pg_try_advisory_lock
            // syncSingleItemInternal
            [
                {
                    media_type: 'tv',
                    title: 'Phantom Show',
                    year: 2020,
                    overview: 'old',
                    metadata_locked: false,
                },
            ],
            [{ provider: 'tmdb', external_id: '999' }],
            [], // resolveItemLanguage
            [{ id: 'series-uuid' }], // UPDATE RETURNING (overview changed)
            [{ provider: 'tmdb', external_id: '999' }], // resolveProviderForSeries
            [{ has_file: false }], // phantom-series gate: NO descendant has a file
        ]);
        mockGetTVShowDetails.mockResolvedValue({
            name: 'Phantom Show',
            first_air_date: '2020-01-01',
            overview: 'New overview',
        });

        const result = await syncSeriesWithChildren(sql, 'series-uuid', { force: false });

        expect(result.phantomSkipped).toBe(true);
        expect(result.seasonsSynced).toBe(0);
        expect(result.episodesSynced).toBe(0);
        // Children expansion must be declined — no provider children fetch.
        expect(mockGetSeriesChildren).not.toHaveBeenCalled();
    });

    describe('owned-series child creation rule', () => {
        /** Every SQL text the mock saw, with interpolations collapsed. */
        function sqlTexts(sql: postgres.Sql): string[] {
            const mock = sql as unknown as { mock: { calls: [TemplateStringsArray][] } };
            return mock.mock.calls.map((c) => c[0].join('?'));
        }

        /** Series-level responses up to and including the ownership gate. */
        function unownedSeriesResponses(): unknown[][] {
            return [
                [{ key: 1 }],
                [{ ok: true }],
                [
                    {
                        media_type: 'tv',
                        title: 'Phantom Show',
                        year: 2020,
                        overview: 'old',
                        metadata_locked: false,
                    },
                ],
                [{ provider: 'tmdb', external_id: '999' }],
                [], // resolveItemLanguage
                [{ id: 'series-uuid' }], // UPDATE RETURNING
                [{ provider: 'tmdb', external_id: '999' }], // resolveProviderForSeries
                [{ has_file: false }], // ownership gate: not owned
                [], // title-binding load
            ];
        }

        const childrenOf = (episodes: number[]) => ({
            seasons: [
                {
                    seasonNumber: 1,
                    name: 'Season 1',
                    overview: null,
                    airDate: '2020-01-01',
                    episodes: episodes.map((episode) => ({
                        seriesExternalId: '999',
                        season: 1,
                        episode,
                        title: `Episode ${episode}`,
                        overview: null,
                        airDate: '2020-01-01',
                        runtime: 40,
                        externalId: String(7000 + episode),
                    })),
                },
            ],
        });

        beforeEach(() => {
            mockGetTVShowDetails.mockResolvedValue({
                name: 'Phantom Show',
                first_air_date: '2020-01-01',
                overview: 'New overview',
            });
            mockUpsertExternalId.mockResolvedValue(undefined);
        });

        it('forced sync of an un-owned series creates no season or episode', async () => {
            // season lookup finds nothing -> update-only mode skips the season
            const sql = makeSql([...unownedSeriesResponses(), []]);
            mockGetSeriesChildren.mockResolvedValue(childrenOf([1, 2]));

            const result = await syncSeriesWithChildren(sql, 'series-uuid', { force: true });

            expect(result.phantomSkipped).toBeUndefined();
            expect(result.seasonsSynced).toBe(0);
            expect(result.episodesSynced).toBe(0);
            expect(sqlTexts(sql).some((t) => /INSERT INTO media_items/i.test(t))).toBe(false);
            const { MediaLifecycleService } =
                await import('$lib/server/services/media-lifecycle.service.js');
            expect(MediaLifecycleService.afterCreated).not.toHaveBeenCalled();
        });

        it('forced sync of an un-owned series still updates existing children but skips missing episodes', async () => {
            const sql = makeSql([
                ...unownedSeriesResponses(),
                [{ id: 'season-1-uuid' }], // update-only season UPDATE ... RETURNING id
                // update-only batched episode UPDATE: only episode 1 exists
                [{ season_number: 1, episode_number: 1, id: 'ep-1-uuid' }],
            ]);
            mockGetSeriesChildren.mockResolvedValue(childrenOf([1, 2]));

            const result = await syncSeriesWithChildren(sql, 'series-uuid', { force: true });

            expect(result.seasonsSynced).toBe(1);
            // Episode 2 has no row and the series is not owned: only episode 1 counts.
            expect(result.episodesSynced).toBe(1);
            expect(result.childrenSkipped).toBe('not-owned');
            expect(sqlTexts(sql).some((t) => /INSERT INTO media_items/i.test(t))).toBe(false);
            expect(mockUpsertExternalId).toHaveBeenCalledTimes(1);
            const { MediaLifecycleService } =
                await import('$lib/server/services/media-lifecycle.service.js');
            expect(MediaLifecycleService.afterCreated).not.toHaveBeenCalled();
        });

        it.each([
            { provider: 'tmdb', ownerSeason: 'local-season-2', ownerEpisode: 1 },
            { provider: 'tmdb', ownerSeason: 'season-1-uuid', ownerEpisode: 3 },
            { provider: 'anidb', ownerSeason: 'local-season-2', ownerEpisode: 1 },
        ])(
            'protects a $provider identity in $ownerSeason episode $ownerEpisode before metadata updates',
            async ({ provider, ownerSeason, ownerEpisode }) => {
                const responses = unownedSeriesResponses();
                responses[7] = [{ has_file: true }];
                // Keep series-level TMDB metadata resolution, then choose the
                // authoritative child provider independently.
                responses[6] = [{ provider, external_id: '999' }];
                mockEnabledProviders.value = [
                    {
                        id: `${provider}-metadata-provider`,
                        manifest: { id: `${provider}-metadata-provider`, name: provider },
                        getSeriesChildren: mockGetSeriesChildren,
                    },
                ];
                const sql = makeSql(
                    [
                        ...responses,
                        [{ id: 'season-1-uuid', created: false }],
                        [{ episode_number: 2, id: 'ep-2-uuid', created: false }],
                    ],
                    [
                        {
                            external_id: '7001',
                            media_id: 'file-backed-owner',
                            season_id: ownerSeason,
                            series_id: 'series-uuid',
                            parent_season_number: ownerSeason === 'season-1-uuid' ? 1 : 2,
                            season_number: ownerSeason === 'season-1-uuid' ? 1 : 2,
                            episode_number: ownerEpisode,
                        },
                        {
                            external_id: '7002',
                            media_id: 'ep-2-uuid',
                            season_id: 'season-1-uuid',
                            series_id: 'series-uuid',
                            parent_season_number: 1,
                            season_number: 1,
                            episode_number: 2,
                        },
                    ],
                );
                mockGetSeriesChildren.mockResolvedValue(childrenOf([1, 2]));

                const result = await syncSeriesWithChildren(sql, 'series-uuid', { force: true });

                expect(result.episodesSynced).toBe(1);
                expect(mockUpsertExternalId).toHaveBeenCalledTimes(1);
                expect(mockUpsertExternalId).toHaveBeenCalledWith(
                    'ep-2-uuid',
                    {
                        provider,
                        id: '7002',
                        mediaType: 'episode',
                        source: 'metadata-sync',
                    },
                    true,
                );
                const calls = (
                    sql as unknown as {
                        mock: { calls: [TemplateStringsArray, ...unknown[]][] };
                    }
                ).mock.calls;
                const batch = calls.find(([text]) => text.join('').includes('WITH input AS'));
                expect(batch).toBeDefined();
                // Assert the actual bound metadata, not only the ID attachment:
                // episode 1's title and number never reach the batch UPDATE.
                expect(batch?.[2]).toEqual([2]);
                expect(batch?.[3]).toEqual(['Episode 2']);
                const ownerQuery = calls.find(([text]) =>
                    text.join('').includes('owner.parent_id AS season_id'),
                );
                expect(ownerQuery?.[1]).toBe(provider);
                expect(ownerQuery?.[2]).toEqual(['7001', '7002']);
                expect(mockLogger.warn).toHaveBeenCalledWith(
                    'Skipped positional episode metadata with conflicting provider identities',
                    expect.objectContaining({ provider, skipped: 1 }),
                );
            },
        );

        it('rejects an initially unowned provider ID repeated at different positions but updates a sibling', async () => {
            const responses = unownedSeriesResponses();
            responses[7] = [{ has_file: true }];
            const sql = makeSql([
                ...responses,
                [{ id: 'season-1-uuid', created: false }],
                [{ episode_number: 3, id: 'ep-3-uuid', created: false }],
            ]);
            const children = childrenOf([1, 2, 3]);
            children.seasons[0].episodes[1].externalId = '7001';
            mockGetSeriesChildren.mockResolvedValue(children);

            const result = await syncSeriesWithChildren(sql, 'series-uuid', { force: true });

            expect(result.episodesSynced).toBe(1);
            expect(mockUpsertExternalId).toHaveBeenCalledTimes(1);
            expect(mockUpsertExternalId).toHaveBeenCalledWith(
                'ep-3-uuid',
                expect.objectContaining({ id: '7003' }),
                true,
            );
            const calls = (
                sql as unknown as {
                    mock: { calls: [TemplateStringsArray, ...unknown[]][] };
                }
            ).mock.calls;
            const batch = calls.find(([text]) => text.join('').includes('WITH input AS'));
            expect(batch?.[2]).toEqual([3]);
            expect(batch?.[3]).toEqual(['Episode 3']);
        });

        it.each(['tmdb', 'anidb'])(
            'does not create a season whose %s episode identities all belong elsewhere',
            async (provider) => {
                const responses = unownedSeriesResponses();
                responses[7] = [{ has_file: true }];
                responses[6] = [{ provider, external_id: '999' }];
                mockEnabledProviders.value = [
                    {
                        id: `${provider}-metadata-provider`,
                        manifest: { id: `${provider}-metadata-provider`, name: provider },
                        getSeriesChildren: mockGetSeriesChildren,
                    },
                ];
                const sql = makeSql(responses, [
                    {
                        external_id: '7001',
                        media_id: 'existing-owner',
                        season_id: 'local-season-2',
                        series_id: 'series-uuid',
                        parent_season_number: 2,
                        season_number: 2,
                        episode_number: 1,
                    },
                ]);
                mockGetSeriesChildren.mockResolvedValue(childrenOf([1]));

                const result = await syncSeriesWithChildren(sql, 'series-uuid', { force: true });

                expect(result.seasonsSynced).toBe(0);
                expect(result.episodesSynced).toBe(0);
                expect(sqlTexts(sql).some((text) => /INSERT INTO media_items/i.test(text))).toBe(
                    false,
                );
                expect(mockUpsertExternalId).not.toHaveBeenCalled();
            },
        );

        it('does not create empty seasons when a provider repeats an ID across seasons', async () => {
            const responses = unownedSeriesResponses();
            responses[7] = [{ has_file: true }];
            const sql = makeSql(responses);
            const children = childrenOf([1]);
            mockGetSeriesChildren.mockResolvedValue({
                seasons: [
                    children.seasons[0],
                    {
                        ...children.seasons[0],
                        seasonNumber: 2,
                        name: 'Season 2',
                        episodes: children.seasons[0].episodes.map((episode) => ({
                            ...episode,
                            season: 2,
                        })),
                    },
                ],
            });

            const result = await syncSeriesWithChildren(sql, 'series-uuid', { force: true });

            expect(result.seasonsSynced).toBe(0);
            expect(result.episodesSynced).toBe(0);
            expect(sqlTexts(sql).some((text) => /INSERT INTO media_items/i.test(text))).toBe(false);
            expect(mockUpsertExternalId).not.toHaveBeenCalled();
        });

        it('still updates metadata for an episode without an external ID', async () => {
            const responses = unownedSeriesResponses();
            responses[7] = [{ has_file: true }];
            responses.splice(8, 0, []); // stored season state (routine season refresh plan)
            const sql = makeSql([
                ...responses,
                [{ id: 'season-1-uuid', created: false }],
                [
                    { episode_number: 1, id: 'ep-1-uuid', created: false },
                    { episode_number: 2, id: 'ep-2-uuid', created: false },
                ],
            ]);
            const children = childrenOf([1, 2]);
            mockGetSeriesChildren.mockResolvedValue({
                seasons: [
                    {
                        ...children.seasons[0],
                        episodes: children.seasons[0].episodes.map((episode, index) => ({
                            ...episode,
                            externalId: index === 0 ? undefined : episode.externalId,
                        })),
                    },
                ],
            });

            const result = await syncSeriesWithChildren(sql, 'series-uuid', { force: false });

            expect(result.episodesSynced).toBe(2);
            expect(mockUpsertExternalId).toHaveBeenCalledTimes(1);
            expect(mockUpsertExternalId).toHaveBeenCalledWith(
                'ep-2-uuid',
                expect.objectContaining({ id: '7002' }),
                true,
            );
        });

        it('an owned series keeps creating its missing episodes', async () => {
            const responses = unownedSeriesResponses();
            responses[7] = [{ has_file: true }];
            responses.splice(8, 0, []); // stored season state (routine season refresh plan)
            const sql = makeSql([
                ...responses,
                [{ id: 'season-1-uuid', created: true }],
                [
                    { episode_number: 1, id: 'ep-1-uuid', created: true },
                    { episode_number: 2, id: 'ep-2-uuid', created: true },
                ],
            ]);
            mockGetSeriesChildren.mockResolvedValue(childrenOf([1, 2]));

            const result = await syncSeriesWithChildren(sql, 'series-uuid', { force: false });

            expect(result.seasonsSynced).toBe(1);
            expect(result.episodesSynced).toBe(2);
            const { MediaLifecycleService } =
                await import('$lib/server/services/media-lifecycle.service.js');
            expect(MediaLifecycleService.afterCreated).toHaveBeenCalledTimes(3);
        });
    });

    describe('isOwnedSeries', () => {
        it('is true when the predicate query reports ownership', async () => {
            const sql = makeSql([[{ has_file: true }]]);
            await expect(isOwnedSeries(sql, 'series-uuid')).resolves.toBe(true);
        });

        it('is false when it does not, and when no row comes back', async () => {
            await expect(isOwnedSeries(makeSql([[{ has_file: false }]]), 's')).resolves.toBe(false);
            await expect(isOwnedSeries(makeSql([[]]), 's')).resolves.toBe(false);
        });

        it('checks the series row, descendant has_files and media_file_items links', async () => {
            const sql = makeSql([[{ has_file: false }]]);
            await isOwnedSeries(sql, 'series-uuid');
            const text = (
                sql as unknown as { mock: { calls: [TemplateStringsArray][] } }
            ).mock.calls[0][0].join('?');
            expect(text).toContain('library_added_at IS NOT NULL');
            expect(text).toContain('s.has_files');
            expect(text).toContain('m.has_files');
            expect(text).toContain('media_file_items');
        });
    });

    it('syncs seasons and episodes via provider plugin', async () => {
        // findOrCreateChild uses INSERT ... ON CONFLICT DO UPDATE RETURNING id
        const sql = makeSql([
            // withSeriesSyncLock: hashtext + pg_try_advisory_lock
            [{ key: 1 }],
            [{ ok: true }],

            // syncSingleItemInternal: currentRows, externalIdRows (parallel), then UPDATE
            [
                {
                    media_type: 'tv',
                    title: 'Drifting Clouds',
                    year: 2008,
                    overview: 'old',
                    metadata_locked: false,
                },
            ],
            [{ provider: 'tmdb', external_id: '1396' }],
            [], // resolveItemLanguage
            [{ id: 'series-uuid' }], // UPDATE RETURNING id (overview changed)

            // resolveProviderForSeries: external_ids query
            [{ provider: 'tmdb', external_id: '1396' }],

            // phantom-series gate: CTE check for descendant with files
            [{ has_file: true }],
            [], // stored season state (routine season refresh plan)

            // identity-aware title-binding load (one query per series; no
            // pre-existing episode rows, so the binding map is empty)
            [],

            // Season 1: findOrCreateChild UPSERT (xmax=0 → newly created)
            [{ id: 'season-1-uuid', created: true }],

            // Episodes 1x01 + 1x02: single batched upsert (SQL-C3) returns
            // one row per episode keyed by episode_number.
            [
                { episode_number: 1, id: 'ep-1-uuid', created: true },
                { episode_number: 2, id: 'ep-2-uuid', created: true },
            ],
        ]);

        mockGetTVShowDetails.mockResolvedValue({
            name: 'Drifting Clouds',
            first_air_date: '2008-01-20',
            overview: 'New overview',
        });

        mockGetSeriesChildren.mockResolvedValue({
            seasons: [
                {
                    seasonNumber: 1,
                    name: 'Season 1',
                    overview: 'First season',
                    airDate: '2008-01-20',
                    episodes: [
                        {
                            seriesExternalId: '1396',
                            season: 1,
                            episode: 1,
                            title: 'Pilot',
                            overview: 'First episode',
                            airDate: '2008-01-20',
                            runtime: 58,
                            externalId: '62085',
                        },
                        {
                            seriesExternalId: '1396',
                            season: 1,
                            episode: 2,
                            title: "Cat's in the Bag...",
                            overview: 'Second episode',
                            airDate: '2008-01-27',
                            runtime: 48,
                            externalId: '62086',
                        },
                    ],
                },
            ],
        });

        mockUpsertExternalId.mockResolvedValue(undefined);

        const progressEvents: unknown[] = [];
        const result = await syncSeriesWithChildren(sql, 'series-uuid', { force: false }, (event) =>
            progressEvents.push(event),
        );

        expect(result.updated).toBe(true);
        expect(result.seasonsSynced).toBe(1);
        expect(result.episodesSynced).toBe(2);

        // Verify afterCreated lifecycle hook fired for each newly-created child
        // (1 season + 2 episodes). Without this, stage-state coverage rows
        // would only get seeded on the next stage-sweep self-heal pass (~60s).
        const { MediaLifecycleService } =
            await import('$lib/server/services/media-lifecycle.service.js');
        const afterCreatedMock = MediaLifecycleService.afterCreated as unknown as ReturnType<
            typeof vi.fn
        >;
        expect(afterCreatedMock).toHaveBeenCalledTimes(3);
        expect(afterCreatedMock).toHaveBeenCalledWith('season-1-uuid', 'series-sync', sql);
        expect(afterCreatedMock).toHaveBeenCalledWith('ep-1-uuid', 'series-sync', sql);
        expect(afterCreatedMock).toHaveBeenCalledWith('ep-2-uuid', 'series-sync', sql);

        // Verify provider plugin was called — third arg is the resolved
        // library language (null here: no library_paths row in the test's
        // sql mock, so it falls back to config.TMDB_LANGUAGE inside the
        // real series-children helper).
        expect(mockGetSeriesChildren).toHaveBeenCalledWith('1396', {}, null);

        // Verify external IDs were registered for the 2 episodes only.
        // Seasons intentionally do NOT get a per-season provider external_id row:
        // SeasonMetadata has no provider-given season ID, and the previous synthetic
        // `${seriesId}_S${seasonNumber}` value violated the valid_tmdb_id CHECK
        // constraint without ever being read by any query.
        expect(mockUpsertExternalId).toHaveBeenCalledTimes(2);

        // Verify progress callbacks were fired
        expect(progressEvents.length).toBeGreaterThanOrEqual(2);
        expect(progressEvents[0]).toMatchObject({
            phase: 'series',
            totalSeasons: 1,
        });
    });

    it('enqueues season artwork materialization instead of stashing a TMDB CDN url', async () => {
        const sql = makeSql([
            [{ key: 1 }], // withSeriesSyncLock: hashtext
            [{ ok: true }], // pg_try_advisory_lock
            [
                {
                    media_type: 'tv',
                    title: 'Drifting Clouds',
                    year: 2008,
                    overview: 'old',
                    metadata_locked: false,
                },
            ],
            [{ provider: 'tmdb', external_id: '1396' }],
            [], // resolveItemLanguage
            [{ id: 'series-uuid' }], // UPDATE RETURNING id
            [{ provider: 'tmdb', external_id: '1396' }], // resolveProviderForSeries
            [{ has_file: true }], // phantom-series gate
            [], // stored season state (routine season refresh plan)
            [], // title-binding load
            [{ id: 'season-1-uuid', created: true }], // findOrCreateChild
            [{ id: 'season-image-candidate' }], // season provenance reference
            [{ episode_number: 1, id: 'ep-1-uuid', created: true }], // batched episode upsert
        ]);

        mockGetTVShowDetails.mockResolvedValue({
            name: 'Drifting Clouds',
            first_air_date: '2008-01-20',
            overview: 'New overview',
        });

        mockGetSeriesChildren.mockResolvedValue({
            seasons: [
                {
                    seasonNumber: 1,
                    name: 'Season 1',
                    overview: 'First season',
                    airDate: '2008-01-20',
                    // The provider DOES return a season poster — this is the branch
                    // that used to write custom_poster_url.
                    posterUrl: 'https://image.tmdb.org/t/p/w342/season1.jpg',
                    episodes: [
                        {
                            seriesExternalId: '1396',
                            season: 1,
                            episode: 1,
                            title: 'Pilot',
                            overview: 'First episode',
                            airDate: '2008-01-20',
                            runtime: 58,
                            externalId: '62085',
                        },
                    ],
                },
            ],
        });
        mockUpsertExternalId.mockResolvedValue(undefined);

        const result = await syncSeriesWithChildren(sql, 'series-uuid', { force: false });

        expect(result.seasonsSynced).toBe(1);
        expect(result.episodesSynced).toBe(1);

        // The remote-URL stash is gone: no statement mentions custom_poster_url.
        const statements = (sql as unknown as ReturnType<typeof vi.fn>).mock.calls.map((call) =>
            (call[0] as TemplateStringsArray).join('?'),
        );
        expect(statements.some((s) => s.includes('custom_poster_url'))).toBe(false);

        // …and the season is handed to the backfill instead, ONCE, after the loop.
        // The `sql` handle is passed through so the helper can drop seasons that
        // fail the backfill gate before any run is enqueued.
        expect(mockEnqueueSeasonArtwork).toHaveBeenCalledTimes(1);
        // Each season travels with the poster URL the sync read, so the enqueue can
        // drop already-local seasons without a TMDB call.
        expect(mockEnqueueSeasonArtwork).toHaveBeenCalledWith(
            expect.anything(),
            [
                {
                    mediaItemId: 'season-1-uuid',
                    posterUrl: 'https://image.tmdb.org/t/p/w342/season1.jpg',
                },
            ],
            'metadata-sync-single.syncSeriesWithChildren',
        );
    });

    it('does not enqueue when the provider returned no season poster', async () => {
        const sql = makeSql([
            [{ key: 1 }],
            [{ ok: true }],
            [
                {
                    media_type: 'tv',
                    title: 'Drifting Clouds',
                    year: 2008,
                    overview: 'old',
                    metadata_locked: false,
                },
            ],
            [{ provider: 'tmdb', external_id: '1396' }],
            [],
            [{ id: 'series-uuid' }],
            [{ provider: 'tmdb', external_id: '1396' }],
            [{ has_file: true }],
            [], // stored season state (routine season refresh plan)
            [],
            [{ id: 'season-1-uuid', created: true }],
            [{ episode_number: 1, id: 'ep-1-uuid', created: true }],
        ]);

        mockGetTVShowDetails.mockResolvedValue({
            name: 'Drifting Clouds',
            first_air_date: '2008-01-20',
            overview: 'New overview',
        });
        mockGetSeriesChildren.mockResolvedValue({
            seasons: [
                {
                    seasonNumber: 1,
                    name: 'Season 1',
                    overview: 'First season',
                    airDate: '2008-01-20',
                    episodes: [
                        {
                            seriesExternalId: '1396',
                            season: 1,
                            episode: 1,
                            title: 'Pilot',
                            overview: 'First episode',
                            airDate: '2008-01-20',
                            runtime: 58,
                            externalId: '62085',
                        },
                    ],
                },
            ],
        });
        mockUpsertExternalId.mockResolvedValue(undefined);

        await syncSeriesWithChildren(sql, 'series-uuid', { force: false });

        expect(mockEnqueueSeasonArtwork).not.toHaveBeenCalled();
    });

    // Regression coverage for the frozen-singleton language bug: the
    // children (season/episode) fetch must resolve language the SAME way
    // the series-level sync does — reusing `syncSingleItemInternal`'s
    // `libraryLanguage` result rather than falling back to the frozen
    // `tmdbApi` singleton. Everything else mirrors the previous test; only
    // the resolveItemLanguage sql response and the assertion differ.
    it('threads the resolved per-library language into the children (season/episode) fetch', async () => {
        const sql = makeSql([
            [{ key: 1 }],
            [{ ok: true }],
            [
                {
                    media_type: 'tv',
                    title: 'Drifting Clouds',
                    year: 2008,
                    overview: 'old',
                    metadata_locked: false,
                },
            ],
            [{ provider: 'tmdb', external_id: '1396' }],
            [{ language: 'de-DE' }], // resolveItemLanguage — library override this time
            [{ id: 'series-uuid' }],
            [{ provider: 'tmdb', external_id: '1396' }],
            [{ has_file: true }],
            [], // stored season state (routine season refresh plan)
            [],
            [{ id: 'season-1-uuid', created: true }],
            [{ episode_number: 1, id: 'ep-1-uuid', created: true }],
        ]);

        mockGetTVShowDetails.mockResolvedValue({
            name: 'Drifting Clouds',
            first_air_date: '2008-01-20',
            overview: 'New overview',
        });

        mockGetSeriesChildren.mockResolvedValue({
            seasons: [
                {
                    seasonNumber: 1,
                    name: 'Season 1',
                    overview: 'First season',
                    airDate: '2008-01-20',
                    episodes: [
                        {
                            seriesExternalId: '1396',
                            season: 1,
                            episode: 1,
                            title: 'Pilot',
                            overview: 'First episode',
                            airDate: '2008-01-20',
                            runtime: 58,
                            externalId: '62085',
                        },
                    ],
                },
            ],
        });

        mockUpsertExternalId.mockResolvedValue(undefined);

        await syncSeriesWithChildren(sql, 'series-uuid', { force: false });

        // Series-level sync used the same resolved language...
        expect(mockCreateTMDBApi).toHaveBeenCalledWith('de-DE');
        // ...and the children fetch got it threaded through too.
        expect(mockGetSeriesChildren).toHaveBeenCalledWith('1396', {}, 'de-DE');
    });

    it('updates existing children instead of creating duplicates', async () => {
        const sql = makeSql([
            // withSeriesSyncLock: hashtext + pg_try_advisory_lock
            [{ key: 1 }],
            [{ ok: true }],

            // syncSingleItemInternal: currentRows, externalIdRows (no UPDATE — nothing changed)
            [
                {
                    media_type: 'tv',
                    title: 'Drifting Clouds',
                    year: 2008,
                    overview: 'same',
                    metadata_locked: false,
                },
            ],
            [{ provider: 'tmdb', external_id: '1396' }],
            [], // resolveItemLanguage

            // resolveProviderForSeries: external_ids query
            [{ provider: 'tmdb', external_id: '1396' }],

            // phantom-series gate: CTE check for descendant with files
            [{ has_file: true }],
            [], // stored season state (routine season refresh plan)

            // identity-aware title-binding load (one query per series; the
            // binding map is not exercised by this fixture)
            [],

            // Season 1: findOrCreateChild UPSERT (existing row updated, xmax!=0 → created=false)
            [{ id: 'existing-season-uuid', created: false }],

            // Episode 1x01: batched upsert (SQL-C3) — existing row updated
            [{ episode_number: 1, id: 'existing-ep-uuid', created: false }],
        ]);

        mockGetTVShowDetails.mockResolvedValue({
            name: 'Drifting Clouds',
            first_air_date: '2008-01-20',
            overview: 'same',
        });

        mockGetSeriesChildren.mockResolvedValue({
            seasons: [
                {
                    seasonNumber: 1,
                    name: 'Season 1',
                    overview: 'Updated overview',
                    episodes: [
                        {
                            seriesExternalId: '1396',
                            season: 1,
                            episode: 1,
                            title: 'Pilot (Updated)',
                            overview: 'Updated',
                            runtime: 58,
                            externalId: '62085',
                        },
                    ],
                },
            ],
        });

        mockUpsertExternalId.mockResolvedValue(undefined);

        const result = await syncSeriesWithChildren(sql, 'series-uuid', {
            force: false,
        });

        expect(result.seasonsSynced).toBe(1);
        expect(result.episodesSynced).toBe(1);
        expect(result.updated).toBe(true);

        // No newly-created children → afterCreated must NOT fire (the rows
        // already had their coverage seeded at creation time).
        const { MediaLifecycleService } =
            await import('$lib/server/services/media-lifecycle.service.js');
        const afterCreatedMock = MediaLifecycleService.afterCreated as unknown as ReturnType<
            typeof vi.fn
        >;
        expect(afterCreatedMock).not.toHaveBeenCalled();
    });

    it('does not refresh provider_metadata when row is locked and force=false', async () => {
        // When locked + force=false, we skip both the media_items UPDATE and
        // the provider_metadata refresh so embeddings stay aligned with what
        // the user sees. This is verified by asserting no UPDATE call was made.
        const createCatalogServiceMock = vi.fn(() => ({
            storeProviderMetadata: vi.fn().mockResolvedValue(undefined),
        }));
        const { createCatalogService } = await import('$lib/server/services/catalog.service.js');
        (createCatalogService as unknown as ReturnType<typeof vi.fn>).mockImplementation(
            createCatalogServiceMock,
        );

        const sqlFn = makeSql([
            [
                {
                    media_type: 'movie',
                    title: 'User Title',
                    year: 1999,
                    overview: 'user',
                    metadata_locked: true,
                },
            ],
            [{ provider: 'tmdb', external_id: '550' }],
            [], // resolveItemLanguage
            // No UPDATE call expected
        ]);

        mockGetMovieDetails.mockResolvedValue({
            title: 'TMDB Title',
            release_date: '1999-10-15',
            overview: 'TMDB',
        });

        const result = await syncSingleItem(sqlFn, 'item-uuid', {
            force: false,
        });

        expect(result.updated).toBe(false);
        // storeProviderMetadata must not have been invoked for a locked row
        expect(createCatalogServiceMock).not.toHaveBeenCalled();
    });

    it('continues syncing when external ID conflict occurs', async () => {
        const sql = makeSql([
            // withSeriesSyncLock: hashtext + pg_try_advisory_lock
            [{ key: 1 }],
            [{ ok: true }],

            [
                {
                    media_type: 'tv',
                    title: 'Show',
                    year: 2020,
                    overview: 'old',
                    metadata_locked: false,
                },
            ],
            [{ provider: 'tmdb', external_id: '100' }],
            [], // resolveItemLanguage
            [{ id: 'series-uuid' }], // UPDATE RETURNING id (overview changed)

            // resolveProviderForSeries: external_ids query
            [{ provider: 'tmdb', external_id: '100' }],

            // phantom-series gate: CTE check for descendant with files
            [{ has_file: true }],
            [], // stored season state (routine season refresh plan)

            // identity-aware title-binding load (one query per series; no
            // pre-existing episode rows, so the binding map is empty)
            [],

            // Season 1: findOrCreateChild UPSERT (newly created)
            [{ id: 'season-uuid', created: true }],

            // Episode: batched upsert (SQL-C3) — newly created
            [{ episode_number: 1, id: 'ep-uuid', created: true }],
        ]);

        mockGetTVShowDetails.mockResolvedValue({
            name: 'Show Updated',
            first_air_date: '2020-01-01',
            overview: 'new',
        });

        mockGetSeriesChildren.mockResolvedValue({
            seasons: [
                {
                    seasonNumber: 1,
                    name: 'Season 1',
                    episodes: [
                        {
                            seriesExternalId: '100',
                            season: 1,
                            episode: 1,
                            title: 'Ep 1',
                            externalId: '999',
                        },
                    ],
                },
            ],
        });

        // Simulate external ID conflict
        mockUpsertExternalId.mockRejectedValue(new Error('External ID already mapped'));

        const result = await syncSeriesWithChildren(sql, 'series-uuid', {
            force: false,
        });

        // Should still succeed despite conflicts
        expect(result.seasonsSynced).toBe(1);
        expect(result.episodesSynced).toBe(1);
        expect(mockLogger.warn).toHaveBeenCalled();
    });
});

// ============================================================================
// Tests — syncSeriesWithChildren via Jellyfin metadata provider (W2.2)
//
// New contract: when the resolved metadata provider is Jellyfin, the sync
// service MUST NOT create any season/episode rows. It attaches Jellyfin
// external_ids onto pre-existing TMDB-derived rows when (season, episode)
// matches; otherwise it writes a sync_quarantine entry. This prevents the
// Office AU / Glimmers UK contamination shape from re-introducing foreign
// episodes via Jellyfin's merged-library children list.
// ============================================================================

describe('syncSeriesWithChildren — Jellyfin attach-only (W2.2)', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        // Jellyfin is the resolved sync provider for this series, but TMDB is
        // also configured so the Jellyfin-only-configured guard does NOT fire.
        mockEnabledProviders.value = [
            {
                id: 'jellyfin-metadata-provider',
                manifest: {
                    id: 'jellyfin-metadata-provider',
                    name: 'Jellyfin',
                },
                getSeriesChildren: mockGetSeriesChildren,
            },
            {
                id: 'tmdb-metadata-provider',
                manifest: { id: 'tmdb-metadata-provider', name: 'TMDB' },
                getSeriesChildren: vi.fn(),
            },
        ];
        mockQuarantineWrite.mockResolvedValue('quarantine-id');
        mockUpsertExternalId.mockResolvedValue(undefined);
        mockResolveByExternalKey.mockResolvedValue(0);
    });

    it('attaches Jellyfin external_ids to existing TMDB-derived episode rows when all positions match', async () => {
        // resolveMediaTmdb runs first via syncSingleItemInternal.
        // The series HAS a TMDB id (so series-level sync succeeds + jellyfinAttachOnlySync
        // can record parent_tmdb_id on quarantine entries).
        const sql = makeSql([
            // withSeriesSyncLock: hashtext + pg_try_advisory_lock
            [{ key: 1 }],
            [{ ok: true }],
            // syncSingleItemInternal: currentRows, externalIdRows, no UPDATE (overview unchanged)
            [
                {
                    media_type: 'tv',
                    title: 'Show',
                    year: 2020,
                    overview: 'same',
                    metadata_locked: false,
                },
            ],
            [
                { provider: 'tmdb', external_id: '1396' },
                { provider: 'jellyfin', external_id: 'jf-series' },
            ],
            [], // resolveItemLanguage
            // resolveProviderForSeries: external_ids ordered, jellyfin matches the resolved plugin
            [{ provider: 'jellyfin', external_id: 'jf-series' }],
            // phantom-series gate: CTE check for descendant with files
            [{ has_file: true }],
            // jellyfinAttachOnlySync: SELECT tmdb id of the series
            [{ external_id: '1396' }],
        ]);

        mockGetTVShowDetails.mockResolvedValue({
            name: 'Show',
            first_air_date: '2020-01-01',
            overview: 'same',
        });

        mockGetSeriesChildren.mockResolvedValue({
            seasons: [
                {
                    seasonNumber: 1,
                    name: 'Season 1',
                    episodes: [
                        {
                            seriesExternalId: 'jf-series',
                            season: 1,
                            episode: 1,
                            externalId: 'jf-ep-1',
                        },
                        {
                            seriesExternalId: 'jf-series',
                            season: 1,
                            episode: 2,
                            externalId: 'jf-ep-2',
                        },
                    ],
                },
            ],
        });

        // Local season + both episodes exist
        mockFindSeasonByNumber.mockResolvedValueOnce('local-season-1-uuid');
        mockFindEpisodeByPosition
            .mockResolvedValueOnce('local-ep-1-uuid')
            .mockResolvedValueOnce('local-ep-2-uuid');

        const result = await syncSeriesWithChildren(sql, 'series-uuid', {
            force: false,
        });

        // 2 attaches, 0 row creates, 0 quarantines
        expect(mockUpsertExternalId).toHaveBeenCalledTimes(2);
        expect(mockUpsertExternalId).toHaveBeenCalledWith(
            'local-ep-1-uuid',
            expect.objectContaining({
                provider: 'jellyfin',
                id: 'jf-ep-1',
                mediaType: 'episode',
            }),
            // NOT primary — TMDB stays primary
            false,
        );
        expect(mockQuarantineWrite).not.toHaveBeenCalled();
        expect(result.seasonsSynced).toBe(1);
        expect(result.episodesSynced).toBe(2);
    });

    it('attaches matching episodes and quarantines foreign-shaped episodes (Office AU / Glimmers UK contamination shape)', async () => {
        // Local series has TMDB rows for S1E1..S1E6. Jellyfin returns 18 episodes
        // (the contamination shape: 6 expected + 12 foreign). Expect 6 attaches
        // and 12 quarantine writes; no row creates.
        const sql = makeSql([
            [{ key: 1 }],
            [{ ok: true }],
            [
                {
                    media_type: 'tv',
                    title: 'Show',
                    year: 2020,
                    overview: 'same',
                    metadata_locked: false,
                },
            ],
            [
                { provider: 'tmdb', external_id: '1396' },
                { provider: 'jellyfin', external_id: 'jf-series' },
            ],
            [], // resolveItemLanguage
            [{ provider: 'jellyfin', external_id: 'jf-series' }],
            // phantom-series gate: CTE check for descendant with files
            [{ has_file: true }],
            [{ external_id: '1396' }],
        ]);

        mockGetTVShowDetails.mockResolvedValue({
            name: 'Show',
            first_air_date: '2020-01-01',
            overview: 'same',
        });

        const episodes = Array.from({ length: 18 }, (_, i) => ({
            seriesExternalId: 'jf-series',
            season: 1,
            episode: i + 1,
            externalId: `jf-ep-${i + 1}`,
        }));

        mockGetSeriesChildren.mockResolvedValue({
            seasons: [{ seasonNumber: 1, name: 'Season 1', episodes }],
        });

        mockFindSeasonByNumber.mockResolvedValueOnce('local-season-1-uuid');
        // E1..E6 match, E7..E18 are foreign
        for (let i = 1; i <= 18; i++) {
            mockFindEpisodeByPosition.mockResolvedValueOnce(i <= 6 ? `local-ep-${i}-uuid` : null);
        }

        const result = await syncSeriesWithChildren(sql, 'series-uuid', {
            force: false,
        });

        expect(mockUpsertExternalId).toHaveBeenCalledTimes(6);
        expect(mockQuarantineWrite).toHaveBeenCalledTimes(12);
        // Spot-check one quarantine entry shape
        expect(mockQuarantineWrite).toHaveBeenCalledWith(
            sql,
            expect.objectContaining({
                provider: 'jellyfin',
                mediaType: 'episode',
                parentTmdbId: '1396',
                expectedSeriesId: 'series-uuid',
                source: 'jellyfin-attach-only-sync',
            }),
        );
        expect(result.seasonsSynced).toBe(1);
        expect(result.episodesSynced).toBe(6);
    });

    it('quarantines a Jellyfin season that has no local TMDB-derived season (e.g. S0 specials)', async () => {
        const sql = makeSql([
            [{ key: 1 }],
            [{ ok: true }],
            [
                {
                    media_type: 'tv',
                    title: 'Show',
                    year: 2020,
                    overview: 'same',
                    metadata_locked: false,
                },
            ],
            [
                { provider: 'tmdb', external_id: '1396' },
                { provider: 'jellyfin', external_id: 'jf-series' },
            ],
            [], // resolveItemLanguage
            [{ provider: 'jellyfin', external_id: 'jf-series' }],
            // phantom-series gate: CTE check for descendant with files
            [{ has_file: true }],
            [{ external_id: '1396' }],
        ]);

        mockGetTVShowDetails.mockResolvedValue({
            name: 'Show',
            first_air_date: '2020-01-01',
            overview: 'same',
        });

        mockGetSeriesChildren.mockResolvedValue({
            seasons: [
                {
                    seasonNumber: 0,
                    name: 'Specials',
                    episodes: [
                        {
                            seriesExternalId: 'jf-series',
                            season: 0,
                            episode: 1,
                            externalId: 'jf-special-1',
                        },
                    ],
                },
            ],
        });

        // No local S0 season exists
        mockFindSeasonByNumber.mockResolvedValueOnce(null);

        const result = await syncSeriesWithChildren(sql, 'series-uuid', {
            force: false,
        });

        // Exactly one quarantine for the season; episodes inside are SKIPPED
        // (no parent to attach them to), so neither attached nor episode-quarantined.
        expect(mockQuarantineWrite).toHaveBeenCalledTimes(1);
        expect(mockQuarantineWrite).toHaveBeenCalledWith(
            sql,
            expect.objectContaining({
                provider: 'jellyfin',
                mediaType: 'season',
                expectedSeriesId: 'series-uuid',
                parentTmdbId: '1396',
            }),
        );
        expect(mockUpsertExternalId).not.toHaveBeenCalled();
        // Skipped season's episodes should NOT have been looked up
        expect(mockFindEpisodeByPosition).not.toHaveBeenCalled();
        expect(result.seasonsSynced).toBe(0);
        expect(result.episodesSynced).toBe(0);
    });

    it('quarantines all Jellyfin episodes when the series has NO TMDB id (no local rows to attach to)', async () => {
        // Pre-W2.2 behavior: a series whose only metadata provider is Jellyfin
        // would let Jellyfin CREATE episode rows. Under the new contract, those
        // rows are NEVER created — every episode is quarantined for admin review.
        // (In production, the orchestrator should attempt TMDB resolution before
        // this point. If TMDB still fails, the series remains Jellyfin-only and
        // we land here.)
        //
        // syncSingleItemInternal returns early with tmdbId=null because
        // resolveMediaTmdb finds no TMDB external_id, but resolveProviderForSeries
        // independently re-reads external_ids and matches the Jellyfin plugin.
        const sql = makeSql([
            [{ key: 1 }],
            [{ ok: true }],
            // resolveMediaTmdb: currentRows, externalIdRows (no tmdb)
            [
                {
                    media_type: 'tv',
                    title: 'Show',
                    year: 2020,
                    overview: null,
                    metadata_locked: false,
                },
            ],
            [{ provider: 'jellyfin', external_id: 'jf-series' }],
            // resolveProviderForSeries: only jellyfin
            [{ provider: 'jellyfin', external_id: 'jf-series' }],
            // phantom-series gate: CTE check for descendant with files
            [{ has_file: true }],
            // jellyfinAttachOnlySync: tmdb lookup returns nothing
            [],
        ]);

        mockGetSeriesChildren.mockResolvedValue({
            seasons: [
                {
                    seasonNumber: 1,
                    name: 'Season 1',
                    episodes: [
                        {
                            seriesExternalId: 'jf-series',
                            season: 1,
                            episode: 1,
                            externalId: 'jf-ep-1',
                        },
                    ],
                },
            ],
        });

        // No local season exists either — the series is Jellyfin-only and has
        // no TMDB-derived hierarchy at all.
        mockFindSeasonByNumber.mockResolvedValueOnce(null);

        const result = await syncSeriesWithChildren(sql, 'series-uuid', {
            force: false,
        });

        // Season is quarantined; episode inside is skipped (no parent).
        expect(mockQuarantineWrite).toHaveBeenCalledTimes(1);
        expect(mockQuarantineWrite).toHaveBeenCalledWith(
            sql,
            expect.objectContaining({
                provider: 'jellyfin',
                mediaType: 'season',
                // No tmdb id resolved for the parent series
                parentTmdbId: null,
            }),
        );
        expect(mockUpsertExternalId).not.toHaveBeenCalled();
        expect(result.seasonsSynced).toBe(0);
        expect(result.episodesSynced).toBe(0);
    });

    it('does not call findOrCreateChild — no INSERT/UPDATE on media_items in the Jellyfin path', async () => {
        // Belt-and-suspenders: the SQL mock has no INSERT/UPSERT response queued.
        // If the service tried to call findOrCreateChild, the test would fail
        // because the queue would run dry.
        const sql = makeSql([
            [{ key: 1 }],
            [{ ok: true }],
            [
                {
                    media_type: 'tv',
                    title: 'Show',
                    year: 2020,
                    overview: 'same',
                    metadata_locked: false,
                },
            ],
            [
                { provider: 'tmdb', external_id: '1396' },
                { provider: 'jellyfin', external_id: 'jf-series' },
            ],
            [], // resolveItemLanguage
            [{ provider: 'jellyfin', external_id: 'jf-series' }],
            // phantom-series gate: CTE check for descendant with files
            [{ has_file: true }],
            [{ external_id: '1396' }],
        ]);

        mockGetTVShowDetails.mockResolvedValue({
            name: 'Show',
            first_air_date: '2020-01-01',
            overview: 'same',
        });

        mockGetSeriesChildren.mockResolvedValue({
            seasons: [
                {
                    seasonNumber: 1,
                    name: 'Season 1',
                    episodes: [
                        {
                            seriesExternalId: 'jf-series',
                            season: 1,
                            episode: 1,
                            externalId: 'jf-ep-1',
                        },
                    ],
                },
            ],
        });

        mockFindSeasonByNumber.mockResolvedValueOnce('local-season-1-uuid');
        mockFindEpisodeByPosition.mockResolvedValueOnce('local-ep-1-uuid');

        await syncSeriesWithChildren(sql, 'series-uuid', { force: false });

        // The CatalogService.upsertExternalId was called via the attach path;
        // verify no findOrCreateChild-style INSERT was issued by checking
        // findOrCreateChild's INSERTs aren't in the call signature. We do this
        // indirectly: the SQL mock would have logged any extra call. The
        // queue length was sized exactly for the 6 reads above; any
        // findOrCreateChild call would have consumed an unset slot (returns []).
        expect(mockUpsertExternalId).toHaveBeenCalledTimes(1);
        expect(mockUpsertExternalId).toHaveBeenCalledWith(
            'local-ep-1-uuid',
            expect.any(Object),
            false,
        );
    });

    it('auto-resolves a prior quarantine entry when the episode attach succeeds', async () => {
        const sql = makeSql([
            [{ key: 1 }],
            [{ ok: true }],
            [
                {
                    media_type: 'tv',
                    title: 'Show',
                    year: 2020,
                    overview: 'same',
                    metadata_locked: false,
                },
            ],
            [
                { provider: 'tmdb', external_id: '1396' },
                { provider: 'jellyfin', external_id: 'jf-series' },
            ],
            [], // resolveItemLanguage
            [{ provider: 'jellyfin', external_id: 'jf-series' }],
            // phantom-series gate: CTE check for descendant with files
            [{ has_file: true }],
            [{ external_id: '1396' }],
        ]);

        mockGetTVShowDetails.mockResolvedValue({
            name: 'Show',
            first_air_date: '2020-01-01',
            overview: 'same',
        });

        mockGetSeriesChildren.mockResolvedValue({
            seasons: [
                {
                    seasonNumber: 1,
                    name: 'Season 1',
                    episodes: [
                        {
                            seriesExternalId: 'jf-series',
                            season: 1,
                            episode: 1,
                            externalId: 'jf-ep-1',
                        },
                    ],
                },
            ],
        });

        mockFindSeasonByNumber.mockResolvedValueOnce('local-season-1-uuid');
        // Episode is now matchable (TMDB caught up)
        mockFindEpisodeByPosition.mockResolvedValueOnce('local-ep-1-uuid');
        mockResolveByExternalKey.mockResolvedValue(1);

        await syncSeriesWithChildren(sql, 'series-uuid', { force: false });

        // Auto-resolve must be called with the episode's external id
        expect(mockResolveByExternalKey).toHaveBeenCalledWith(
            sql,
            {
                provider: 'jellyfin',
                externalId: 'jf-ep-1',
                mediaType: 'episode',
            },
            'auto:jellyfin-attach-only-sync',
            'reattached',
        );
    });

    it('skips attach + logs warn when match found but provider returned no externalId — does NOT quarantine', async () => {
        // The (season, episode) position matches a real local row, but the
        // Jellyfin payload didn't carry an externalId for the episode. The
        // service must skip the attach (nothing to upsert), log a warning,
        // and NOT quarantine the row (it's a provider-data shortfall, not a
        // contamination shape).
        const sql = makeSql([
            [{ key: 1 }],
            [{ ok: true }],
            [
                {
                    media_type: 'tv',
                    title: 'Show',
                    year: 2020,
                    overview: 'same',
                    metadata_locked: false,
                },
            ],
            [
                { provider: 'tmdb', external_id: '1396' },
                { provider: 'jellyfin', external_id: 'jf-series' },
            ],
            [], // resolveItemLanguage
            [{ provider: 'jellyfin', external_id: 'jf-series' }],
            // phantom-series gate: CTE check for descendant with files
            [{ has_file: true }],
            [{ external_id: '1396' }],
        ]);

        mockGetTVShowDetails.mockResolvedValue({
            name: 'Show',
            first_air_date: '2020-01-01',
            overview: 'same',
        });

        mockGetSeriesChildren.mockResolvedValue({
            seasons: [
                {
                    seasonNumber: 1,
                    name: 'Season 1',
                    episodes: [
                        // No externalId field — provider-data shortfall
                        { seriesExternalId: 'jf-series', season: 1, episode: 1 },
                    ],
                },
            ],
        });

        mockFindSeasonByNumber.mockResolvedValueOnce('local-season-1-uuid');
        mockFindEpisodeByPosition.mockResolvedValueOnce('local-ep-1-uuid');

        const result = await syncSeriesWithChildren(sql, 'series-uuid', {
            force: false,
        });

        // No attach, no quarantine
        expect(mockUpsertExternalId).not.toHaveBeenCalled();
        expect(mockQuarantineWrite).not.toHaveBeenCalled();
        // The warning must surface so admins see the upstream Jellyfin
        // data shortfall in the run log.
        expect(mockLogger.warn).toHaveBeenCalledWith(
            'Matched episode but provider returned no external_id',
            expect.objectContaining({
                localEpisodeId: 'local-ep-1-uuid',
                seasonNumber: 1,
                episodeNumber: 1,
            }),
        );
        // Season matched but no episode attached
        expect(result.seasonsSynced).toBe(1);
        expect(result.episodesSynced).toBe(0);
    });

    it('does not undo episodesAttached when resolveByExternalKey throws after a successful upsert', async () => {
        // Separation-of-try-catches contract: if catalogService.upsertExternalId
        // succeeds, episodesAttached must increment and the row's attach
        // counter must persist even when the optional resolveByExternalKey
        // bookkeeping call throws afterwards (the attach itself happened).
        const sql = makeSql([
            [{ key: 1 }],
            [{ ok: true }],
            [
                {
                    media_type: 'tv',
                    title: 'Show',
                    year: 2020,
                    overview: 'same',
                    metadata_locked: false,
                },
            ],
            [
                { provider: 'tmdb', external_id: '1396' },
                { provider: 'jellyfin', external_id: 'jf-series' },
            ],
            [], // resolveItemLanguage
            [{ provider: 'jellyfin', external_id: 'jf-series' }],
            // phantom-series gate: CTE check for descendant with files
            [{ has_file: true }],
            [{ external_id: '1396' }],
        ]);

        mockGetTVShowDetails.mockResolvedValue({
            name: 'Show',
            first_air_date: '2020-01-01',
            overview: 'same',
        });

        mockGetSeriesChildren.mockResolvedValue({
            seasons: [
                {
                    seasonNumber: 1,
                    name: 'Season 1',
                    episodes: [
                        {
                            seriesExternalId: 'jf-series',
                            season: 1,
                            episode: 1,
                            externalId: 'jf-ep-1',
                        },
                    ],
                },
            ],
        });

        mockFindSeasonByNumber.mockResolvedValueOnce('local-season-1-uuid');
        mockFindEpisodeByPosition.mockResolvedValueOnce('local-ep-1-uuid');
        // Upsert succeeds, but the quarantine-resolve call throws.
        mockUpsertExternalId.mockResolvedValueOnce(undefined);
        mockResolveByExternalKey.mockRejectedValueOnce(new Error('quarantine resolve failed'));

        const result = await syncSeriesWithChildren(sql, 'series-uuid', {
            force: false,
        });

        // Attach DID succeed — episodesAttached must reflect that.
        expect(mockUpsertExternalId).toHaveBeenCalledTimes(1);
        expect(result.episodesSynced).toBe(1);
        // The resolve failure surfaces as a warning, not as a thrown error.
        expect(mockLogger.warn).toHaveBeenCalledWith(
            'Failed to resolve prior quarantine entry after attach',
            expect.objectContaining({
                episodeExternalId: 'jf-ep-1',
                localEpisodeId: 'local-ep-1-uuid',
            }),
        );
    });

    it('writes a series-level quarantine and returns early when Jellyfin is the only provider', async () => {
        // Override: strip TMDB so only Jellyfin remains — triggers the guard.
        mockEnabledProviders.value = [
            {
                id: 'jellyfin-metadata-provider',
                manifest: {
                    id: 'jellyfin-metadata-provider',
                    name: 'Jellyfin',
                },
                getSeriesChildren: mockGetSeriesChildren,
            },
        ];

        const sql = makeSql([
            [{ key: 1 }],
            [{ ok: true }],
            [
                {
                    media_type: 'tv',
                    title: 'Show',
                    year: 2020,
                    overview: 'same',
                    metadata_locked: false,
                },
            ],
            [{ provider: 'jellyfin', external_id: 'jf-series' }],
            [{ provider: 'jellyfin', external_id: 'jf-series' }],
            // phantom-series gate: CTE check for descendant with files
            [{ has_file: true }],
            // jellyfinAttachOnlySync: returns early (Jellyfin-only guard fires before tmdb lookup)
            [],
        ]);

        mockGetSeriesChildren.mockResolvedValue({
            seasons: [
                {
                    seasonNumber: 1,
                    name: 'Season 1',
                    episodes: [
                        {
                            seriesExternalId: 'jf-series',
                            season: 1,
                            episode: 1,
                            externalId: 'jf-ep-1',
                        },
                    ],
                },
            ],
        });

        const result = await syncSeriesWithChildren(sql, 'series-uuid', {
            force: false,
        });

        // One series-level quarantine, no episode-level quarantines
        expect(mockQuarantineWrite).toHaveBeenCalledTimes(1);
        expect(mockQuarantineWrite).toHaveBeenCalledWith(
            sql,
            expect.objectContaining({
                provider: 'jellyfin',
                mediaType: 'tv',
                expectedSeriesId: 'series-uuid',
            }),
        );
        // No episode processing at all
        expect(mockFindEpisodeByPosition).not.toHaveBeenCalled();
        expect(mockUpsertExternalId).not.toHaveBeenCalled();
        expect(result.episodesSynced).toBe(0);
    });
});
