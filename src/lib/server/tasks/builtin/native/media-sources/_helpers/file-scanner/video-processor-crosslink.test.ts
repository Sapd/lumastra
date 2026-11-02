// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Unit tests for the Jellyfin cross-link deduplication in resolveOrCreateMediaItem.
 *
 * When a Jellyfin candidate carries ProviderIds.Tmdb/Imdb/Tvdb in its
 * externalIds map, resolveOrCreateMediaItem must find the existing row keyed
 * by one of those cross-provider IDs instead of inserting a new duplicate row.
 *
 * All heavy collaborators (DB queries, catalog service, ffprobe, etc.) are
 * stubbed so the test runs without a real database or filesystem.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// ---------------------------------------------------------------------------
// Hoisted spy refs
// ---------------------------------------------------------------------------

const resolveExternalIdToUuidSpy = vi.hoisted(() =>
    vi.fn<
        (
            sql: unknown,
            extId: string,
            mediaType: string,
            provider?: string,
        ) => Promise<string | null>
    >(),
);
const upsertExternalIdSpy = vi.hoisted(() => vi.fn<() => Promise<void>>());
const setRuntimeSecondsIfNullSpy = vi.hoisted(() => vi.fn<() => Promise<void>>());
const insertScannedMediaItemSpy = vi.hoisted(() => vi.fn<() => Promise<string>>());
const backfillLibraryGroupIdIfNullSpy = vi.hoisted(() => vi.fn<() => Promise<void>>());
const findAdoptableDiscoveryRowByTitleSpy = vi.hoisted(() => vi.fn<() => Promise<string | null>>());

// ---------------------------------------------------------------------------
// Module mocks — must precede the import under test
// ---------------------------------------------------------------------------

vi.mock('../../../../../../database/queries/media-lookup.queries.js', () => ({
    resolveExternalIdToUuid: resolveExternalIdToUuidSpy,
}));

vi.mock('../../../../../../services/catalog.service.js', () => ({
    createCatalogService: vi.fn(() => ({
        upsertExternalId: upsertExternalIdSpy,
    })),
}));

vi.mock('../../../../../../database/queries/media-items.queries.js', () => ({
    insertScannedMediaItem: insertScannedMediaItemSpy,
    findPersonalMediaItemByTitleYear: vi.fn().mockResolvedValue(null),
    normalizeTitleForVersionDedupe: vi.fn((title: string) => title.toLowerCase()),
    getMediaItemType: vi.fn().mockResolvedValue(null),
    findOrCreatePersonalSeason: vi.fn().mockResolvedValue('season-uuid'),
    findOrCreatePersonalEpisode: vi.fn().mockResolvedValue({ id: 'ep-uuid', created: false }),
    getNextEpisodeNumber: vi.fn().mockResolvedValue(1),
    seasonHasCanonicalEpisodes: vi.fn().mockResolvedValue(false),
    listCanonicalEpisodeTitles: vi.fn().mockResolvedValue([]),
    findOrCreateSeries: vi.fn().mockResolvedValue('series-uuid'),
    setRuntimeSecondsIfNull: setRuntimeSecondsIfNullSpy,
    // Default: no adoptable discovery row → resolution falls through to the
    // create path (the adoption branch is exercised in its own focused test).
    findAdoptableDiscoveryRowByTitle: findAdoptableDiscoveryRowByTitleSpy,
    backfillLibraryGroupIdIfNull: backfillLibraryGroupIdIfNullSpy,
}));

vi.mock('../../../../../../database/with-tx.js', () => ({
    // Immediately invoke the callback with a fake tx so we can inspect calls.
    withTx: vi.fn(async (_sql: unknown, cb: (tx: unknown) => Promise<unknown>) => {
        const fakeTx = Object.assign(vi.fn().mockResolvedValue([]), {
            unsafe: vi.fn(),
            array: vi.fn((v: unknown[]) => v),
            json: vi.fn((v: unknown) => v),
            begin: vi.fn(),
            savepoint: vi.fn(),
        });
        // Expose the tx as a function so template-tag calls succeed.
        const tx = new Proxy(fakeTx, {
            apply: (_target, _thisArg, args) => fakeTx(...args),
        });
        return cb(tx);
    }),
}));

// Stub out the remaining heavy imports that video-processor pulls in.
vi.mock('node:path', async (importOriginal) => {
    return importOriginal();
});
vi.mock('$lib/server/tasks/plugin-context.js', () => ({
    invokeProviderDetail: vi.fn(),
    isProviderConfigured: vi.fn().mockResolvedValue(false),
}));
vi.mock('$lib/server/providers/normalize.js', () => ({
    normalizeDetail: vi.fn().mockReturnValue(null),
}));
vi.mock('$lib/server/providers/encode-id.js', () => ({
    encodeDetailId: vi.fn().mockReturnValue('encoded-id'),
}));
vi.mock('$lib/server/providers/implementations/tmdb/resolve-external.js', () => ({
    tmdbResolveExternalId: vi.fn().mockResolvedValue(null),
}));
vi.mock('../../../../../../utils/filename-parser.js', () => ({
    parseMediaFilename: vi.fn().mockReturnValue({ title: 'Test', year: 2020 }),
    editionCanonicalToDisplayName: vi.fn().mockReturnValue(''),
}));
vi.mock('$lib/server/utils/media-types.js', () => ({
    isNonEntertainment: vi.fn().mockReturnValue(false),
    isMusic: vi.fn().mockReturnValue(false),
    isMovie: vi.fn().mockReturnValue(true),
    isSeries: vi.fn().mockReturnValue(false),
}));
vi.mock('$lib/shared/library-type-templates.js', () => ({
    getLibraryTypeTemplate: vi.fn().mockReturnValue(null),
}));
vi.mock('../../../../../../database/queries/media-files.queries.js', () => ({
    upsertMediaFile: vi.fn().mockResolvedValue({ id: 'file-uuid', created: true }),
    attachFileToItem: vi.fn().mockResolvedValue(undefined),
    touchLibraryAddedAt: vi.fn().mockResolvedValue(undefined),
    isFileLinkedToMediaItem: vi.fn().mockResolvedValue(false),
    getLinkedEpisodeNumbersForFile: vi.fn().mockResolvedValue(new Set()),
    detachAndClearAwaitingMatchForFile: vi.fn().mockResolvedValue(0),
    findAwaitingMatchItemIdsForFile: vi.fn().mockResolvedValue([]),
    clearAwaitingMatchFlag: vi.fn().mockResolvedValue(undefined),
    findAllLinkedMediaItemsByFilePath: vi.fn().mockResolvedValue([]),
    findParentMediaItemByFolder: vi.fn().mockResolvedValue(null),
    getFilesForMediaItem: vi.fn().mockResolvedValue([]),
    findMediaFileByPath: vi.fn().mockResolvedValue(null),
    updateFileStat: vi.fn().mockResolvedValue(undefined),
    mediaItemHasFile: vi.fn().mockResolvedValue(false),
    linkFileAsVersion: vi.fn().mockResolvedValue(undefined),
    deleteStaleMediaFile: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('../../../../../../services/metadata-matching.service.js', () => ({
    matchFileToMetadata: vi.fn().mockResolvedValue({ matched: false }),
}));
vi.mock('../../../../../../utils/ffprobe.js', () => ({
    probeChapters: vi.fn().mockResolvedValue({ chapters: [] }),
    probeMediaFile: vi.fn().mockResolvedValue({ success: true, duration: 120 }),
}));
vi.mock('../../../../../../utils/nfo-parser.js', () => ({
    readNfoForVideo: vi.fn().mockResolvedValue({ kind: 'none' }),
}));
vi.mock('../../../../../../utils/walk-directory.js', () => ({
    isAudioFile: vi.fn().mockReturnValue(false),
}));
vi.mock('../../../../../../utils/file-presence.js', () => ({
    assessFilePresence: vi.fn().mockResolvedValue('present'),
}));
vi.mock('../../../../../../services/media-lifecycle.service.js', () => ({
    MediaLifecycleService: {
        afterMatched: vi.fn().mockResolvedValue(undefined),
        afterReclaimed: vi.fn().mockResolvedValue(undefined),
        onFileContentChanged: vi.fn().mockResolvedValue({ invalidatedMediaItemIds: [] }),
    },
}));
vi.mock('./shared.js', () => ({
    toDbMediaType: vi.fn((t: string) => (t === 'movie' ? 'movie' : 'tv')),
    initFileChangeDetection: vi.fn().mockResolvedValue(undefined),
    tryHashFileHead: vi.fn().mockResolvedValue(undefined),
    episodeTitleFromPath: vi.fn().mockReturnValue('Episode'),
    extractSeriesTitleFromPath: vi.fn().mockReturnValue('Series'),
    extractSeasonNumberFromPath: vi.fn().mockReturnValue(undefined),
    resolveSeasonNumber: (
        fs: number | undefined,
        folderS: number | undefined,
        et: string | undefined,
    ) => fs ?? folderS ?? (et === 'special' || et === 'ova' || et === 'ona' ? 0 : 1),
}));
vi.mock('./change-detection.js', () => ({
    detectFileChanges: vi.fn().mockResolvedValue({ status: 'unchanged' }),
}));
vi.mock('./audio-processor.js', () => ({
    processAudioFile: vi.fn().mockResolvedValue('skipped'),
}));
vi.mock('$lib/server/config.js', () => ({
    config: {
        RECENTLY_ADDED_PROPAGATE_TO_SERIES: false,
        IMAGE_SYNC_AUTO_VIDEO_EXTRACTION: false,
    },
}));
vi.mock('$lib/server/utils/file-hash.js', () => ({
    hashFileHead: vi.fn().mockRejectedValue(new Error('skip')),
}));
vi.mock('../../../../../../database/queries/file-rematch.queries.js', () => ({
    findReclaimableByHash: vi.fn().mockResolvedValue(null),
    undismissMediaItem: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('../../../../../../database/queries/episode-chapters.queries.js', () => ({
    upsertChaptersForFile: vi.fn().mockResolvedValue(undefined),
    hasChaptersForFile: vi.fn().mockResolvedValue(false),
}));
vi.mock('../../../../../../utils/media-path-resolver.js', () => ({
    resolveMediaPath: vi.fn().mockResolvedValue(null),
}));

// ---------------------------------------------------------------------------
// Import under test (after all mocks are in place)
// ---------------------------------------------------------------------------

import { resolveOrCreateMediaItem } from './video-processor.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Minimal fake postgres.Sql that satisfies template-tag usage in withTx. */
function makeFakeSql() {
    const fn = vi.fn().mockResolvedValue([]);
    // Attach postgres-compatible helpers; cast to any to avoid complex overload matching.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (fn as any).array = (v: unknown[]) => v;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (fn as any).json = (v: unknown) => v;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (fn as any).unsafe = vi.fn();
    return fn;
}

const fakeContext = {
    logger: {
        debug: vi.fn(),
        info: vi.fn(),
        warn: vi.fn(),
        error: vi.fn(),
    },
};

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('resolveOrCreateMediaItem — cross-link via externalIds', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        insertScannedMediaItemSpy.mockResolvedValue('new-uuid');
        setRuntimeSecondsIfNullSpy.mockResolvedValue(undefined);
        upsertExternalIdSpy.mockResolvedValue(undefined);
        backfillLibraryGroupIdIfNullSpy.mockResolvedValue(undefined);
        findAdoptableDiscoveryRowByTitleSpy.mockResolvedValue(null);
    });

    it('returns existing TMDB-keyed row when candidate.externalIds.tmdb matches, without inserting', async () => {
        const EXISTING_UUID = 'existing-tmdb-uuid';

        // Step 1: IMDB lookup — miss (no imdbId passed)
        // Step 2: provider lookup (jellyfin) — miss
        // Step 2b: tmdb cross-link — HIT
        resolveExternalIdToUuidSpy
            .mockResolvedValueOnce(null) // step 2: jellyfin miss
            .mockResolvedValueOnce(EXISTING_UUID); // step 2b: tmdb hit

        const sql = makeFakeSql();
        const result = await resolveOrCreateMediaItem(
            sql as unknown as import('postgres').Sql,
            {
                externalId: 'jellyfin-item-uuid',
                provider: 'jellyfin',
                title: 'Daydream',
                year: 2010,
                mediaType: 'movie',
                confidence: 0.7,
                externalIds: { tmdb: '27205', imdb: 'tt1375666' },
            },
            undefined, // no imdbId param
            fakeContext as unknown as import('./shared.js').FileScannerContext,
            undefined,
            undefined,
            undefined,
        );

        expect(result).toBe(EXISTING_UUID);
        // Must NOT insert a new row
        expect(insertScannedMediaItemSpy).not.toHaveBeenCalled();
        // Must attach the Jellyfin alias onto the existing row
        expect(upsertExternalIdSpy).toHaveBeenCalledWith(
            EXISTING_UUID,
            expect.objectContaining({
                provider: 'jellyfin',
                id: 'jellyfin-item-uuid',
                mediaType: 'movie',
                source: 'scanner',
            }),
            false,
        );
    });

    it('creates a new row when no cross-link match is found', async () => {
        const NEW_UUID = 'brand-new-uuid';
        insertScannedMediaItemSpy.mockResolvedValue(NEW_UUID);

        // All lookups miss
        resolveExternalIdToUuidSpy.mockResolvedValue(null);

        const sql = makeFakeSql();
        const result = await resolveOrCreateMediaItem(
            sql as unknown as import('postgres').Sql,
            {
                externalId: 'jellyfin-item-new',
                provider: 'jellyfin',
                title: 'Unknown Movie',
                year: 2023,
                mediaType: 'movie',
                confidence: 0.7,
                externalIds: { tmdb: '99999' },
            },
            undefined,
            fakeContext as unknown as import('./shared.js').FileScannerContext,
            undefined,
            undefined,
            undefined,
        );

        expect(result).toBe(NEW_UUID);
        expect(insertScannedMediaItemSpy).toHaveBeenCalledOnce();
    });

    it('skips cross-link when candidate has no externalIds', async () => {
        const NEW_UUID = 'plain-new-uuid';
        insertScannedMediaItemSpy.mockResolvedValue(NEW_UUID);

        // Provider lookup misses
        resolveExternalIdToUuidSpy.mockResolvedValue(null);

        const sql = makeFakeSql();
        const result = await resolveOrCreateMediaItem(
            sql as unknown as import('postgres').Sql,
            {
                externalId: 'tmdb-12345',
                provider: 'tmdb',
                title: 'Some Movie',
                year: 2020,
                mediaType: 'movie',
                confidence: 0.9,
                // no externalIds
            },
            undefined,
            fakeContext as unknown as import('./shared.js').FileScannerContext,
            undefined,
            undefined,
            undefined,
        );

        expect(result).toBe(NEW_UUID);
        // Only one resolveExternalIdToUuid call — the provider (tmdb) lookup.
        // The imdb/tvdb cross-link loop is skipped because externalIds is absent.
        expect(resolveExternalIdToUuidSpy).toHaveBeenCalledTimes(1);
    });

    it('skips cross-link for imdb when imdbId param already tried it', async () => {
        const NEW_UUID = 'created-uuid';
        insertScannedMediaItemSpy.mockResolvedValue(NEW_UUID);

        // step 1: imdb lookup via param — miss
        // step 2: provider lookup — miss
        // step 2b: tmdb cross-link — miss; imdb is skipped (alreadyTriedImdb=true)
        resolveExternalIdToUuidSpy.mockResolvedValue(null);

        const sql = makeFakeSql();
        await resolveOrCreateMediaItem(
            sql as unknown as import('postgres').Sql,
            {
                externalId: 'jf-uuid',
                provider: 'jellyfin',
                title: 'Movie With Imdb',
                year: 2019,
                mediaType: 'movie',
                confidence: 0.7,
                externalIds: { tmdb: '11111', imdb: 'tt9999999' },
            },
            'tt9999999', // imdbId param already queried
            fakeContext as unknown as import('./shared.js').FileScannerContext,
            undefined,
            undefined,
            undefined,
        );

        // Calls: imdb (step 1), jellyfin (step 2), tmdb (step 2b cross-link — imdb skipped)
        const calls = resolveExternalIdToUuidSpy.mock.calls;
        const providers = calls.map((c) => c[3] as string | undefined);
        expect(providers).toContain('imdb'); // step 1
        expect(providers).toContain('jellyfin'); // step 2
        expect(providers).toContain('tmdb'); // step 2b
        // imdb should NOT appear a second time in the cross-link iteration
        const imdbCount = providers.filter((p) => p === 'imdb').length;
        expect(imdbCount).toBe(1);
    });
});

describe('resolveOrCreateMediaItem — library_group_id backfill on adoption', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        insertScannedMediaItemSpy.mockResolvedValue('new-uuid');
        setRuntimeSecondsIfNullSpy.mockResolvedValue(undefined);
        upsertExternalIdSpy.mockResolvedValue(undefined);
        backfillLibraryGroupIdIfNullSpy.mockResolvedValue(undefined);
        findAdoptableDiscoveryRowByTitleSpy.mockResolvedValue(null);
    });

    it('backfills library_group_id when resolved via IMDB id (step 1)', async () => {
        const EXISTING_UUID = 'existing-imdb-uuid';
        resolveExternalIdToUuidSpy.mockResolvedValueOnce(EXISTING_UUID); // step 1: imdb hit

        const sql = makeFakeSql();
        const result = await resolveOrCreateMediaItem(
            sql as unknown as import('postgres').Sql,
            {
                externalId: 'tmdb-1',
                provider: 'tmdb',
                title: 'Movie',
                year: 2020,
                mediaType: 'movie',
                confidence: 0.9,
            },
            'tt1234567', // imdbId param — hits step 1
            fakeContext as unknown as import('./shared.js').FileScannerContext,
            undefined,
            'library-group-uuid-1',
            undefined,
        );

        expect(result).toBe(EXISTING_UUID);
        expect(backfillLibraryGroupIdIfNullSpy).toHaveBeenCalledWith(
            expect.anything(),
            EXISTING_UUID,
            'library-group-uuid-1',
        );
    });

    it('backfills library_group_id when resolved via primary provider id (step 2)', async () => {
        const EXISTING_UUID = 'existing-provider-uuid';
        // No imdbId param, so step 1 is skipped — first call is step 2 (provider).
        resolveExternalIdToUuidSpy.mockResolvedValueOnce(EXISTING_UUID);

        const sql = makeFakeSql();
        const result = await resolveOrCreateMediaItem(
            sql as unknown as import('postgres').Sql,
            {
                externalId: 'tmdb-2',
                provider: 'tmdb',
                title: 'Movie 2',
                year: 2021,
                mediaType: 'movie',
                confidence: 0.9,
            },
            undefined,
            fakeContext as unknown as import('./shared.js').FileScannerContext,
            undefined,
            'library-group-uuid-2',
            undefined,
        );

        expect(result).toBe(EXISTING_UUID);
        expect(backfillLibraryGroupIdIfNullSpy).toHaveBeenCalledWith(
            expect.anything(),
            EXISTING_UUID,
            'library-group-uuid-2',
        );
    });

    it('backfills library_group_id when resolved via cross-provider link (step 2b)', async () => {
        const EXISTING_UUID = 'existing-crosslink-uuid';
        resolveExternalIdToUuidSpy
            .mockResolvedValueOnce(null) // step 2: jellyfin miss
            .mockResolvedValueOnce(EXISTING_UUID); // step 2b: tmdb cross-link hit

        const sql = makeFakeSql();
        const result = await resolveOrCreateMediaItem(
            sql as unknown as import('postgres').Sql,
            {
                externalId: 'jellyfin-item-uuid',
                provider: 'jellyfin',
                title: 'Daydream',
                year: 2010,
                mediaType: 'movie',
                confidence: 0.7,
                externalIds: { tmdb: '27205' },
            },
            undefined,
            fakeContext as unknown as import('./shared.js').FileScannerContext,
            undefined,
            'library-group-uuid-3',
            undefined,
        );

        expect(result).toBe(EXISTING_UUID);
        expect(backfillLibraryGroupIdIfNullSpy).toHaveBeenCalledWith(
            expect.anything(),
            EXISTING_UUID,
            'library-group-uuid-3',
        );
    });

    it('backfills library_group_id when adopting a file-less discovery row by title match (step 2c)', async () => {
        const ADOPTED_UUID = 'adopted-uuid';
        resolveExternalIdToUuidSpy.mockResolvedValue(null); // all id-based lookups miss
        findAdoptableDiscoveryRowByTitleSpy.mockResolvedValueOnce(ADOPTED_UUID);

        const sql = makeFakeSql();
        const result = await resolveOrCreateMediaItem(
            sql as unknown as import('postgres').Sql,
            {
                externalId: 'jellyfin-item-noid',
                provider: 'jellyfin',
                title: 'Adopted Movie',
                year: 2015,
                mediaType: 'movie',
                confidence: 0.7,
            },
            undefined,
            fakeContext as unknown as import('./shared.js').FileScannerContext,
            undefined,
            'library-group-uuid-4',
            undefined,
        );

        expect(result).toBe(ADOPTED_UUID);
        expect(insertScannedMediaItemSpy).not.toHaveBeenCalled();
        expect(backfillLibraryGroupIdIfNullSpy).toHaveBeenCalledWith(
            expect.anything(),
            ADOPTED_UUID,
            'library-group-uuid-4',
        );
    });

    it('passes undefined through to the backfill helper when no libraryGroupId is available', async () => {
        const EXISTING_UUID = 'existing-uuid-no-group';
        resolveExternalIdToUuidSpy.mockResolvedValueOnce(EXISTING_UUID); // step 1: imdb hit

        const sql = makeFakeSql();
        await resolveOrCreateMediaItem(
            sql as unknown as import('postgres').Sql,
            {
                externalId: 'tmdb-3',
                provider: 'tmdb',
                title: 'Movie 3',
                year: 2022,
                mediaType: 'movie',
                confidence: 0.9,
            },
            'tt7654321',
            fakeContext as unknown as import('./shared.js').FileScannerContext,
            undefined,
            undefined, // no libraryGroupId
            undefined,
        );

        // backfillLibraryGroupIdIfNull itself is responsible for no-op'ing on
        // undefined — the caller always calls through so the query module's
        // guard is the single source of truth for that behavior.
        expect(backfillLibraryGroupIdIfNullSpy).toHaveBeenCalledWith(
            expect.anything(),
            EXISTING_UUID,
            undefined,
        );
    });
});
