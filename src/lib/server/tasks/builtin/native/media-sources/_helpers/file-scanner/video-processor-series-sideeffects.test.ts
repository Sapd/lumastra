// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Example names are fictional; production shapes and measurements are retained.
 * Regression: series-level side effects (external-ID enrichment +
 * metadata-sync enqueue via MediaLifecycleService.afterMatched) must run
 * ONCE per series per scan, not once per episode.
 *
 * Root cause (bulk-scan deadlock + series-sync lock-timeout storm): the file
 * scanner processes up to SCAN_CONCURRENCY episodes of the same series
 * concurrently. Running the series-level side effects per-episode fired N
 * concurrent writes to the same series row (→ Postgres deadlock 40P01) and N
 * redundant `series-sync` enqueues that piled on the per-series advisory lock
 * (→ SeriesSyncLockTimeoutError) plus task_history idempotency-key races.
 *
 * The fix threads a per-scan `seriesSideEffectsDone` Set through
 * findOrCreateSeriesHierarchy; the first episode of a series claims the work
 * (synchronous has()/add() — atomic under the single-threaded event loop) and
 * every other episode coalesces its announcement. Identity enrichment is
 * serialized separately and deduplicated by successfully written mapping.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// ---------------------------------------------------------------------------
// Hoisted spy refs
// ---------------------------------------------------------------------------

const afterMatchedSpy = vi.hoisted(() => vi.fn<() => Promise<void>>());
const upsertExternalIdSpy = vi.hoisted(() => vi.fn<() => Promise<void>>());
const findOrCreateSeriesSpy = vi.hoisted(() => vi.fn<() => Promise<string>>());
const upsertExternalIdDetailedSpy = vi.hoisted(() =>
    vi.fn<(...args: unknown[]) => Promise<{ written: boolean; changed: boolean }>>(),
);
const persistedMappings = vi.hoisted(
    () => new Map<string, { provider: string; id: string; mediaType: string }[]>(),
);
const getExternalIdsSpy = vi.hoisted(() => vi.fn().mockResolvedValue([]));
const resolveIdentitySpy = vi.hoisted(() => vi.fn().mockResolvedValue(null));
const seasonHasCanonicalEpisodesSpy = vi.hoisted(() => vi.fn<() => Promise<boolean>>());

// ---------------------------------------------------------------------------
// Module mocks — must precede the import under test
// ---------------------------------------------------------------------------

vi.mock('../../../../../../database/queries/media-lookup.queries.js', () => ({
    resolveExternalIdToUuid: resolveIdentitySpy,
}));
vi.mock('../../../../../../services/catalog.service.js', () => ({
    createCatalogService: vi.fn(() => ({
        upsertExternalId: upsertExternalIdSpy,
        upsertExternalIdDetailed: async (...args: unknown[]) => {
            const result = await upsertExternalIdDetailedSpy(...args);
            if (result.written) {
                const seriesId = args[0] as string;
                const mapping = args[1] as { provider: string; id: string; mediaType: string };
                const existing = persistedMappings.get(seriesId) ?? [];
                persistedMappings.set(seriesId, [
                    ...existing.filter(
                        (entry) =>
                            entry.provider !== mapping.provider ||
                            entry.mediaType !== mapping.mediaType,
                    ),
                    mapping,
                ]);
            }
            return result;
        },
        getExternalIds: getExternalIdsSpy,
    })),
}));
vi.mock('../../../../../../database/queries/media-items.queries.js', () => ({
    insertScannedMediaItem: vi.fn().mockResolvedValue('new-uuid'),
    findPersonalMediaItemByTitleYear: vi.fn().mockResolvedValue(null),
    normalizeTitleForVersionDedupe: vi.fn((title: string) => title.toLowerCase()),
    getMediaItemType: vi.fn().mockResolvedValue(null),
    findOrCreatePersonalSeason: vi.fn().mockResolvedValue('season-uuid'),
    findOrCreatePersonalEpisode: vi.fn().mockResolvedValue({ id: 'ep-uuid', created: true }),
    getNextEpisodeNumber: vi.fn().mockResolvedValue(1),
    seasonHasCanonicalEpisodes: seasonHasCanonicalEpisodesSpy,
    listCanonicalEpisodeTitles: vi.fn().mockResolvedValue([]),
    findOrCreateSeries: findOrCreateSeriesSpy,
    backfillLibraryGroupIdIfNull: vi.fn().mockResolvedValue(undefined),
    setRuntimeSecondsIfNull: vi.fn().mockResolvedValue(undefined),
    findAdoptableDiscoveryRowByTitle: vi.fn().mockResolvedValue(null),
}));
vi.mock('../../../../../../database/with-tx.js', () => ({
    withTx: vi.fn(async (_sql: unknown, cb: (tx: unknown) => Promise<unknown>) => {
        const fakeTx = Object.assign(vi.fn().mockResolvedValue([]), {
            unsafe: vi.fn(),
            array: vi.fn((v: unknown[]) => v),
            json: vi.fn((v: unknown) => v),
            begin: vi.fn(),
            savepoint: vi.fn(),
        });
        const tx = new Proxy(fakeTx, { apply: (_t, _this, args) => fakeTx(...args) });
        return cb(tx);
    }),
}));
vi.mock('node:path', async (importOriginal) => importOriginal());
vi.mock('$lib/server/tasks/plugin-context.js', () => ({
    invokeProviderDetail: vi.fn(),
    isProviderConfigured: vi.fn().mockResolvedValue(false),
}));
vi.mock('$lib/server/providers/normalize.js', () => ({
    normalizeDetail: vi.fn().mockReturnValue(null),
}));
vi.mock('$lib/server/providers/encode-id.js', () => ({
    encodeDetailId: vi.fn().mockReturnValue('id'),
}));
vi.mock('$lib/server/providers/implementations/tmdb/resolve-external.js', () => ({
    tmdbResolveExternalId: vi.fn().mockResolvedValue(null),
}));
vi.mock('../../../../../../utils/filename-parser.js', () => ({
    parseMediaFilename: vi.fn().mockReturnValue({ title: 'Test Series', year: 2020 }),
    editionCanonicalToDisplayName: vi.fn().mockReturnValue(''),
}));
// Partial mock on purpose: this module is the media-type domain's public
// surface, so a full-replacement factory silently breaks the moment
// video-processor.ts reaches for a mapper it did not list (that is exactly how
// `toProviderMediaType` broke this file). Override only the four predicates the
// fixture needs to steer; every mapper keeps its real, table-driven behaviour.
vi.mock('$lib/server/utils/media-types.js', async (importOriginal) => ({
    ...(await importOriginal<typeof import('$lib/server/utils/media-types.js')>()),
    isNonEntertainment: vi.fn().mockReturnValue(false),
    isMusic: vi.fn().mockReturnValue(false),
    isMovie: vi.fn().mockReturnValue(false),
    isSeries: vi.fn().mockReturnValue(true),
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
        afterMatched: afterMatchedSpy,
        afterReclaimed: vi.fn().mockResolvedValue(undefined),
        onFileContentChanged: vi.fn().mockResolvedValue({ invalidatedMediaItemIds: [] }),
    },
}));
vi.mock('./shared.js', () => ({
    toDbMediaType: vi.fn((t: string) => (t === 'movie' ? 'movie' : 'tv')),
    initFileChangeDetection: vi.fn().mockResolvedValue(undefined),
    tryHashFileHead: vi.fn().mockResolvedValue(undefined),
    episodeTitleFromPath: vi.fn().mockReturnValue('Episode'),
    extractSeriesTitleFromPath: vi.fn().mockReturnValue('Test Series'),
    extractSeasonNumberFromPath: vi.fn().mockReturnValue(undefined),
    recordScanIssueWithCooldown: vi.fn().mockResolvedValue(undefined),
    resolveSeasonNumber: (
        fs: number | undefined,
        folderS: number | undefined,
        et: string | undefined,
    ) => fs ?? folderS ?? (et === 'special' || et === 'ova' || et === 'ona' ? 0 : 1),
}));
vi.mock('./change-detection.js', () => ({
    detectFileChanges: vi.fn().mockResolvedValue({ status: 'unchanged' }),
}));
vi.mock('./audio-processor.js', () => ({ processAudioFile: vi.fn().mockResolvedValue('skipped') }));
vi.mock('$lib/server/config.js', () => ({
    config: { RECENTLY_ADDED_PROPAGATE_TO_SERIES: false, IMAGE_SYNC_AUTO_VIDEO_EXTRACTION: false },
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
// Import under test (after mocks)
// ---------------------------------------------------------------------------

import { toProviderMediaType } from '$lib/shared/media-type-domain';
import { findOrCreateSeriesHierarchy } from './video-processor.js';
import {
    findOrCreatePersonalSeason,
    findOrCreatePersonalEpisode,
} from '../../../../../../database/queries/media-items.queries.js';
import { invokeProviderDetail } from '$lib/server/tasks/plugin-context.js';
import { attachFileToItem } from '../../../../../../database/queries/media-files.queries.js';

function mockPersistedMappings(): void {
    persistedMappings.clear();
    getExternalIdsSpy
        .mockReset()
        .mockImplementation(async (seriesId: string) => persistedMappings.get(seriesId) ?? []);
}
beforeEach(mockPersistedMappings);

function makeFakeSql() {
    const fn = vi.fn().mockResolvedValue([]);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (fn as any).array = (v: unknown[]) => v;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (fn as any).json = (v: unknown) => v;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (fn as any).unsafe = vi.fn();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (fn as any).reserve = vi.fn();
    return fn;
}

const ctx = {
    logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
} as unknown as import('./shared.js').FileScannerContext;

const candidate = {
    externalId: '1234',
    provider: 'tmdb',
    title: 'Test Series',
    year: 2020,
    mediaType: 'tv',
    confidence: 0.9,
};

function optionsFor() {
    return {
        year: 2020,
        libraryGroupId: 'grp-1',
        mediaType: 'tv',
        candidate,
        durationSeconds: 1200,
    };
}

function parsedFor(episode: number) {
    return {
        title: 'Test Series',
        year: 2020,
        season: 1,
        episode,
        episodeStart: episode,
    } as unknown as ReturnType<
        typeof import('../../../../../../utils/filename-parser.js').parseMediaFilename
    >;
}

describe('findOrCreateSeriesHierarchy — series-level side effects run once per series', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        afterMatchedSpy.mockResolvedValue(undefined);
        upsertExternalIdSpy.mockResolvedValue(undefined);
        upsertExternalIdDetailedSpy.mockResolvedValue({ written: true, changed: false });
        seasonHasCanonicalEpisodesSpy.mockResolvedValue(false);
        findOrCreateSeriesSpy.mockResolvedValue('series-uuid');
    });

    it('fires afterMatched ONCE across two sequential episodes of the same series', async () => {
        const sql = makeFakeSql() as unknown as import('postgres').Sql;
        const seriesIdCache = new Map<string, string>();
        const seasonIdCache = new Map<string, string>();
        const done = new Set<string>();

        await findOrCreateSeriesHierarchy(
            sql,
            '/lib/Test Series/S01E01.mkv',
            parsedFor(1),
            ctx,
            optionsFor(),
            seriesIdCache,
            seasonIdCache,
            done,
        );
        await findOrCreateSeriesHierarchy(
            sql,
            '/lib/Test Series/S01E02.mkv',
            parsedFor(2),
            ctx,
            optionsFor(),
            seriesIdCache,
            seasonIdCache,
            done,
        );

        expect(findOrCreateSeriesSpy).toHaveBeenCalledTimes(1);
        expect(findOrCreatePersonalSeason).toHaveBeenCalledTimes(1);
        expect(upsertExternalIdDetailedSpy).toHaveBeenCalledTimes(1);
        expect(afterMatchedSpy).toHaveBeenCalledTimes(1);
        expect(afterMatchedSpy).toHaveBeenCalledWith(
            'series-uuid',
            'tv',
            expect.objectContaining({ enqueueMetadataSync: true }),
            sql,
        );
    });

    it('fires afterMatched ONCE when two episodes of the same series ingest concurrently', async () => {
        const sql = makeFakeSql() as unknown as import('postgres').Sql;
        const seriesIdCache = new Map<string, string>();
        const seasonIdCache = new Map<string, string>();
        const done = new Set<string>();

        await Promise.all([
            findOrCreateSeriesHierarchy(
                sql,
                '/lib/Test Series/S01E01.mkv',
                parsedFor(1),
                ctx,
                optionsFor(),
                seriesIdCache,
                seasonIdCache,
                done,
            ),
            findOrCreateSeriesHierarchy(
                sql,
                '/lib/Test Series/S01E02.mkv',
                parsedFor(2),
                ctx,
                optionsFor(),
                seriesIdCache,
                seasonIdCache,
                done,
            ),
        ]);

        expect(afterMatchedSpy).toHaveBeenCalledTimes(1);
    });

    it('still fires afterMatched when no guard set is supplied (single-file path unchanged)', async () => {
        const sql = makeFakeSql() as unknown as import('postgres').Sql;
        await findOrCreateSeriesHierarchy(
            sql,
            '/lib/Test Series/S01E01.mkv',
            parsedFor(1),
            ctx,
            optionsFor(),
        );
        expect(afterMatchedSpy).toHaveBeenCalledTimes(1);
    });
});

describe('findOrCreateSeriesHierarchy — a skipped file does not announce an unchanged series', () => {
    // Prod 2026-09-30: the hourly full scan re-reads every file it deliberately
    // never ingests (it gets no media_files row). For Harborfolk's superseded
    // duplicate and Pinky and the Brain's unparseable episode that meant a full
    // series-sync every hour, forever, for a series whose identity never changed.
    beforeEach(() => {
        vi.clearAllMocks();
        afterMatchedSpy.mockResolvedValue(undefined);
        upsertExternalIdSpy.mockResolvedValue(undefined);
        upsertExternalIdDetailedSpy.mockResolvedValue({ written: true, changed: false });
        findOrCreateSeriesSpy.mockResolvedValue('series-uuid');
        // Canonical episodes exist, so an unparseable name is skipped, not invented.
        seasonHasCanonicalEpisodesSpy.mockResolvedValue(true);
    });

    const unparseable = (): ReturnType<typeof parsedFor> =>
        ({ title: 'Pinky.31.Guru', year: 2020, season: 1 }) as unknown as ReturnType<
            typeof parsedFor
        >;

    it('does NOT fire afterMatched for a skipped file when the identity is unchanged', async () => {
        const sql = makeFakeSql() as unknown as import('postgres').Sql;

        const r = await findOrCreateSeriesHierarchy(
            sql,
            '/lib/Test Series/Pinky.31.Guru.mkv',
            unparseable(),
            ctx,
            optionsFor(),
            new Map(),
            new Map(),
            new Set(),
        );

        expect(r.outcome).toBe('skipped');
        expect(afterMatchedSpy).not.toHaveBeenCalled();
    });

    it("DOES fire when the skipped file's pass changed the series identity", async () => {
        upsertExternalIdDetailedSpy.mockResolvedValue({ written: true, changed: true });
        const sql = makeFakeSql() as unknown as import('postgres').Sql;

        await findOrCreateSeriesHierarchy(
            sql,
            '/lib/Test Series/Pinky.31.Guru.mkv',
            unparseable(),
            ctx,
            optionsFor(),
            new Map(),
            new Map(),
            new Set(),
        );

        expect(afterMatchedSpy).toHaveBeenCalledTimes(1);
    });

    it('a new episode later in the same scan still announces the series', async () => {
        const sql = makeFakeSql() as unknown as import('postgres').Sql;
        const seriesIdCache = new Map<string, string>();
        const seasonIdCache = new Map<string, string>();
        const done = new Set<string>();

        await findOrCreateSeriesHierarchy(
            sql,
            '/lib/Test Series/Pinky.31.Guru.mkv',
            unparseable(),
            ctx,
            optionsFor(),
            seriesIdCache,
            seasonIdCache,
            done,
        );
        expect(afterMatchedSpy).not.toHaveBeenCalled();

        await findOrCreateSeriesHierarchy(
            sql,
            '/lib/Test Series/S01E05.mkv',
            parsedFor(5),
            ctx,
            optionsFor(),
            seriesIdCache,
            seasonIdCache,
            done,
        );

        expect(afterMatchedSpy).toHaveBeenCalledTimes(1);
    });
});

type HierarchyOptions = Parameters<typeof findOrCreateSeriesHierarchy>[4];

function identityOptions(overrides: Partial<HierarchyOptions> = {}): HierarchyOptions {
    return { ...optionsFor(), ...overrides };
}

const identityCases: {
    name: string;
    first: HierarchyOptions;
    second: HierarchyOptions;
}[] = [
    {
        name: 'original and reboot with different years and TMDB IDs',
        first: identityOptions({
            candidate: { ...candidate, title: 'Shorefolk', year: 2001, externalId: '4556' },
        }),
        second: identityOptions({
            candidate: { ...candidate, title: 'Shorefolk', year: 2026, externalId: '281097' },
        }),
    },
    {
        name: 'same year with different provider IDs',
        first: identityOptions(),
        second: identityOptions({ candidate: { ...candidate, externalId: '5678' } }),
    },
    {
        name: 'missing years with different provider IDs',
        first: identityOptions({ year: undefined, candidate: { ...candidate, year: undefined } }),
        second: identityOptions({
            year: undefined,
            candidate: { ...candidate, year: undefined, externalId: '5678' },
        }),
    },
    {
        name: 'title-only and provider-matched inputs',
        first: identityOptions({ candidate: undefined, seriesTitle: candidate.title }),
        second: identityOptions(),
    },
    {
        name: 'equal ID text under different provider namespaces',
        first: identityOptions(),
        second: identityOptions({ candidate: { ...candidate, provider: 'tvdb' } }),
    },
    {
        name: 'equal provider IDs under different candidate media types',
        first: identityOptions(),
        second: identityOptions({ candidate: { ...candidate, mediaType: 'movie' } }),
    },
    {
        name: 'equal identities under different series media types',
        first: identityOptions(),
        second: identityOptions({ mediaType: 'anime' }),
    },
    {
        name: 'title-only inputs with different release years',
        first: identityOptions({ candidate: undefined, seriesTitle: candidate.title, year: 2001 }),
        second: identityOptions({ candidate: undefined, seriesTitle: candidate.title, year: 2026 }),
    },
    {
        name: 'unknown and known release years for the same provider ID',
        first: identityOptions({ year: undefined, candidate: { ...candidate, year: undefined } }),
        second: identityOptions(),
    },
    {
        name: 'delimiter characters in provider and ID text',
        first: identityOptions({
            candidate: { ...candidate, provider: 'custom:namespace', externalId: 'id' },
        }),
        second: identityOptions({
            candidate: { ...candidate, provider: 'custom', externalId: 'namespace:id' },
        }),
    },
];

describe('findOrCreateSeriesHierarchy — per-path cache respects series identity', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        findOrCreateSeriesSpy.mockReset().mockResolvedValue('series-uuid');
        afterMatchedSpy.mockResolvedValue(undefined);
        upsertExternalIdDetailedSpy.mockResolvedValue({ written: true, changed: false });
        seasonHasCanonicalEpisodesSpy.mockResolvedValue(false);
    });

    it.each(
        identityCases.flatMap((testCase) => [
            { ...testCase, order: 'forward' },
            { ...testCase, first: testCase.second, second: testCase.first, order: 'reverse' },
        ]),
    )('resolves $name independently in $order order', async ({ first, second }) => {
        const sql = makeFakeSql() as unknown as import('postgres').Sql;
        const seriesIdCache = new Map<string, string>();
        const seasonIdCache = new Map<string, string>();
        const done = new Set<string>();
        findOrCreateSeriesSpy
            .mockResolvedValueOnce('first-series')
            .mockResolvedValueOnce('second-series');
        vi.mocked(findOrCreatePersonalSeason)
            .mockResolvedValueOnce('first-season')
            .mockResolvedValueOnce('second-season');
        vi.mocked(findOrCreatePersonalEpisode)
            .mockResolvedValueOnce({ id: 'first-episode', created: true })
            .mockResolvedValueOnce({ id: 'second-episode', created: true });

        const firstResult = await findOrCreateSeriesHierarchy(
            sql,
            '/lib/First/S01E01.mkv',
            parsedFor(1),
            ctx,
            first,
            seriesIdCache,
            seasonIdCache,
            done,
        );
        const secondResult = await findOrCreateSeriesHierarchy(
            sql,
            '/lib/Second/S01E02.mkv',
            parsedFor(2),
            ctx,
            second,
            seriesIdCache,
            seasonIdCache,
            done,
        );

        expect(firstResult.seriesId).toBe('first-series');
        expect(secondResult.seriesId).toBe('second-series');
        expect(findOrCreateSeriesSpy).toHaveBeenCalledTimes(2);
        for (const [index, options] of [first, second].entries()) {
            expect(findOrCreateSeriesSpy).toHaveBeenNthCalledWith(
                index + 1,
                sql,
                expect.objectContaining({
                    title: options.candidate?.title ?? options.seriesTitle,
                    year: options.candidate?.year ?? options.year,
                    mediaType: options.mediaType,
                    externalId: options.candidate
                        ? {
                              provider: options.candidate.provider,
                              id: options.candidate.externalId,
                              mediaType: toProviderMediaType(options.candidate.mediaType),
                          }
                        : undefined,
                }),
            );
            expect(findOrCreatePersonalSeason).toHaveBeenNthCalledWith(index + 1, sql, {
                seriesId: index === 0 ? 'first-series' : 'second-series',
                seasonNumber: 1,
            });
            // Episode and attach run on the episode link lock's transaction
            // handle (a single file's links are decided under that lock), not
            // on `sql` itself.
            expect(findOrCreatePersonalEpisode).toHaveBeenNthCalledWith(
                index + 1,
                expect.anything(),
                expect.objectContaining({
                    seasonId: index === 0 ? 'first-season' : 'second-season',
                }),
            );
            expect(attachFileToItem).toHaveBeenNthCalledWith(
                index + 1,
                expect.anything(),
                'file-uuid',
                index === 0 ? 'first-episode' : 'second-episode',
            );
        }
        expect(seriesIdCache.size).toBe(2);
        expect(seasonIdCache.size).toBe(2);
        expect(upsertExternalIdDetailedSpy).toHaveBeenCalledTimes(
            Number(!!first.candidate) + Number(!!second.candidate),
        );
        expect(afterMatchedSpy).toHaveBeenCalledTimes(
            Number(!!first.candidate) + Number(!!second.candidate),
        );
    });

    it('keeps an explicit resolved UUID authoritative over a populated identity cache', async () => {
        const sql = makeFakeSql() as unknown as import('postgres').Sql;
        const seriesIdCache = new Map<string, string>();
        const seasonIdCache = new Map<string, string>();
        const done = new Set<string>();
        await findOrCreateSeriesHierarchy(
            sql,
            '/lib/First/S01E01.mkv',
            parsedFor(1),
            ctx,
            optionsFor(),
            seriesIdCache,
            seasonIdCache,
            done,
        );
        const result = await findOrCreateSeriesHierarchy(
            sql,
            '/lib/Resolved/S01E02.mkv',
            parsedFor(2),
            ctx,
            identityOptions({ resolvedSeriesId: 'authoritative-series' }),
            seriesIdCache,
            seasonIdCache,
            done,
        );
        expect(result.seriesId).toBe('authoritative-series');
        expect(findOrCreateSeriesSpy).toHaveBeenCalledTimes(1);
        expect(findOrCreatePersonalSeason).toHaveBeenLastCalledWith(sql, {
            seriesId: 'authoritative-series',
            seasonNumber: 1,
        });
    });

    it('retains caching for repeated title-only episodes with the same year', async () => {
        const sql = makeFakeSql() as unknown as import('postgres').Sql;
        const seriesIdCache = new Map<string, string>();
        const seasonIdCache = new Map<string, string>();
        const options = identityOptions({ candidate: undefined, seriesTitle: candidate.title });
        for (const episode of [1, 2]) {
            const result = await findOrCreateSeriesHierarchy(
                sql,
                `/lib/Test Series/S01E0${episode}.mkv`,
                parsedFor(episode),
                ctx,
                options,
                seriesIdCache,
                seasonIdCache,
                new Set(),
            );
            expect(result.seriesId).toBe('series-uuid');
        }
        expect(findOrCreateSeriesSpy).toHaveBeenCalledTimes(1);
        expect(findOrCreatePersonalSeason).toHaveBeenCalledTimes(1);
    });

    it('guards side effects by resolved UUID when different namespaces resolve to the same series', async () => {
        const sql = makeFakeSql() as unknown as import('postgres').Sql;
        const seriesIdCache = new Map<string, string>();
        const seasonIdCache = new Map<string, string>();
        const done = new Set<string>();
        for (const provider of ['tmdb', 'tvdb']) {
            const result = await findOrCreateSeriesHierarchy(
                sql,
                `/lib/Test Series/${provider}.mkv`,
                parsedFor(1),
                ctx,
                identityOptions({ candidate: { ...candidate, provider } }),
                seriesIdCache,
                seasonIdCache,
                done,
            );
            expect(result.seriesId).toBe('series-uuid');
        }
        expect(findOrCreateSeriesSpy).toHaveBeenCalledTimes(2);
        expect(findOrCreatePersonalSeason).toHaveBeenCalledTimes(1);
        expect(upsertExternalIdDetailedSpy).toHaveBeenCalledTimes(2);
        expect(afterMatchedSpy).toHaveBeenCalledTimes(1);
    });

    it('propagates resolver failure on an incompatible identity cache miss', async () => {
        const sql = makeFakeSql() as unknown as import('postgres').Sql;
        const seriesIdCache = new Map<string, string>();
        await findOrCreateSeriesHierarchy(
            sql,
            '/lib/First/S01E01.mkv',
            parsedFor(1),
            ctx,
            optionsFor(),
            seriesIdCache,
        );
        const error = new Error('series resolver failed');
        findOrCreateSeriesSpy.mockRejectedValueOnce(error);
        await expect(
            findOrCreateSeriesHierarchy(
                sql,
                '/lib/Second/S01E01.mkv',
                parsedFor(1),
                ctx,
                identityOptions({ candidate: { ...candidate, externalId: '5678' } }),
                seriesIdCache,
            ),
        ).rejects.toBe(error);
        expect(seriesIdCache.size).toBe(1);
    });
});

describe('series identity evidence follow-ups', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        mockPersistedMappings();
        resolveIdentitySpy.mockReset().mockResolvedValue(null);
        findOrCreateSeriesSpy.mockReset().mockResolvedValue('series-uuid');
        upsertExternalIdDetailedSpy.mockReset().mockResolvedValue({ written: true, changed: true });
        seasonHasCanonicalEpisodesSpy.mockResolvedValue(false);
    });
    async function scan(
        options: HierarchyOptions,
        cache = new Map<string, string>(),
        done = new Set<string>(),
    ) {
        return findOrCreateSeriesHierarchy(
            makeFakeSql() as unknown as import('postgres').Sql,
            '/lib/Test/S01E01.mkv',
            parsedFor(1),
            ctx,
            options,
            cache,
            new Map(),
            done,
        );
    }
    it('executes every mapping even after the first changed write', async () => {
        await scan(
            identityOptions({
                imdbId: 'tt1234',
                candidate: { ...candidate, externalIds: { tvdb: '55', trakt: '66' } },
            }),
        );
        expect(upsertExternalIdDetailedSpy).toHaveBeenCalledTimes(4);
    });
    it('refreshes explicit UUID authority for the next identical call', async () => {
        const cache = new Map<string, string>();
        const done = new Set<string>();
        await scan(optionsFor(), cache, done);
        await scan(identityOptions({ resolvedSeriesId: 'explicit' }), cache, done);
        expect((await scan(optionsFor(), cache, done)).seriesId).toBe('explicit');
    });
    it('re-resolves later supported evidence and persists it without another announcement', async () => {
        const cache = new Map<string, string>();
        const done = new Set<string>();
        await scan(optionsFor(), cache, done);
        const stronger = identityOptions({
            candidate: { ...candidate, externalIds: { tvdb: '55' } },
        });
        await scan(stronger, cache, done);
        await scan(stronger, cache, done);
        expect(findOrCreateSeriesSpy).toHaveBeenCalledTimes(2);
        expect(upsertExternalIdDetailedSpy).toHaveBeenCalledTimes(2);
        expect(afterMatchedSpy).toHaveBeenCalledTimes(1);
    });
    it('retries rejected writes on the next episode', async () => {
        upsertExternalIdDetailedSpy.mockRejectedValueOnce(new Error('temporary failure'));
        const done = new Set<string>();
        await scan(optionsFor(), new Map(), done);
        await scan(optionsFor(), new Map(), done);
        expect(upsertExternalIdDetailedSpy).toHaveBeenCalledTimes(2);
    });
    it('preserves historical same-provider mappings even with an explicit UUID', async () => {
        getExternalIdsSpy.mockResolvedValue([{ provider: 'tmdb', id: 'old-id', mediaType: 'tv' }]);
        await scan(identityOptions({ resolvedSeriesId: 'series-uuid' }));
        expect(upsertExternalIdDetailedSpy).not.toHaveBeenCalled();
        expect(ctx.logger.warn).toHaveBeenCalledWith(
            '[FileScanner] Conflicting series provider mapping',
            expect.objectContaining({ keeping: 'old-id' }),
        );
    });
    it('reports conflicting cross-provider owners without choosing the first one', async () => {
        resolveIdentitySpy.mockResolvedValueOnce('first').mockResolvedValueOnce('second');
        const cache = new Map<string, string>();
        await expect(
            scan(
                identityOptions({ candidate: { ...candidate, externalIds: { tvdb: '55' } } }),
                cache,
            ),
        ).rejects.toThrow('Conflicting series identity evidence');
        expect(upsertExternalIdDetailedSpy).not.toHaveBeenCalled();
        expect(cache.size).toBe(0);
    });
    it('adopts a compatible cross-provider owner and retains both mappings', async () => {
        resolveIdentitySpy.mockResolvedValueOnce(null).mockResolvedValueOnce('discovery');
        const result = await scan(
            identityOptions({
                candidate: { ...candidate, provider: 'jellyfin', externalIds: { tmdb: '55' } },
            }),
        );
        expect(result.seriesId).toBe('discovery');
        expect(findOrCreateSeriesSpy).not.toHaveBeenCalled();
        expect(upsertExternalIdDetailedSpy).toHaveBeenCalledTimes(2);
    });
    it('retries a written=false rejection instead of caching it', async () => {
        upsertExternalIdDetailedSpy.mockResolvedValueOnce({ written: false, changed: false });
        const done = new Set<string>();
        const cache = new Map<string, string>();
        await expect(scan(optionsFor(), cache, done)).rejects.toThrow(
            'Series identity write rejected',
        );
        expect(cache.size).toBe(0);
        await scan(optionsFor(), cache, done);
        expect(upsertExternalIdDetailedSpy).toHaveBeenCalledTimes(2);
    });
    it('recovers from resolver failure and caches the successful retry', async () => {
        const cache = new Map<string, string>();
        findOrCreateSeriesSpy.mockRejectedValueOnce(new Error('transient'));
        await expect(scan(optionsFor(), cache)).rejects.toThrow('transient');
        expect(cache.size).toBe(0);
        await scan(optionsFor(), cache);
        await scan(optionsFor(), cache);
        expect(findOrCreateSeriesSpy).toHaveBeenCalledTimes(2);
    });
    it.each([
        ['capitalization', identityOptions({ candidate: { ...candidate, title: 'TEST SERIES' } })],
        [
            'anime provider namespace',
            identityOptions({ candidate: { ...candidate, mediaType: 'anime' } }),
        ],
        ['fallback year', identityOptions({ candidate: { ...candidate, year: undefined } })],
    ])('reuses equivalent %s identity', async (_name, equivalent) => {
        const cache = new Map<string, string>();
        await scan(optionsFor(), cache);
        await scan(equivalent, cache);
        expect(findOrCreateSeriesSpy).toHaveBeenCalledTimes(1);
    });
    it('ignores unsupported evidence and sorts supported evidence for cache reuse', async () => {
        const cache = new Map<string, string>();
        await scan(
            identityOptions({
                candidate: { ...candidate, externalIds: { tvdb: '55', imdb: 'tt1' } },
            }),
            cache,
        );
        await scan(
            identityOptions({
                candidate: {
                    ...candidate,
                    externalIds: { imdb: 'tt1', ignored: 'new', tvdb: '55' },
                },
            }),
            cache,
        );
        expect(findOrCreateSeriesSpy).toHaveBeenCalledTimes(1);
    });
    it('serializes concurrent unique mappings while coalescing duplicate mappings', async () => {
        let active = 0;
        let maximum = 0;
        upsertExternalIdDetailedSpy.mockImplementation(async () => {
            active += 1;
            maximum = Math.max(maximum, active);
            await Promise.resolve();
            active -= 1;
            return { written: true, changed: true };
        });
        const done = new Set<string>();
        await Promise.all([
            scan(
                identityOptions({ candidate: { ...candidate, externalIds: { tvdb: '55' } } }),
                new Map(),
                done,
            ),
            scan(
                identityOptions({ candidate: { ...candidate, externalIds: { imdb: 'tt1' } } }),
                new Map(),
                done,
            ),
            scan(optionsFor(), new Map(), done),
        ]);
        expect(maximum).toBe(1);
        expect(upsertExternalIdDetailedSpy).toHaveBeenCalledTimes(3);
        expect(afterMatchedSpy).toHaveBeenCalledTimes(1);
    });
    it('normalizes dashed and dashless Jellyfin identity cache keys', async () => {
        const cache = new Map<string, string>();
        for (const externalId of [
            'a1bc9a3d-39d6-8698-370b-bcd45cfb9c11',
            'a1bc9a3d39d68698370bbcd45cfb9c11',
        ]) {
            await scan(
                identityOptions({ candidate: { ...candidate, provider: 'jellyfin', externalId } }),
                cache,
            );
        }
        expect(findOrCreateSeriesSpy).toHaveBeenCalledTimes(1);
    });
    it('announces a concurrent skipped pass that newly enriches identity exactly once', async () => {
        seasonHasCanonicalEpisodesSpy.mockResolvedValue(true);
        upsertExternalIdDetailedSpy.mockResolvedValueOnce({ written: true, changed: false });
        const done = new Set<string>();
        const sql = makeFakeSql() as unknown as import('postgres').Sql;
        await Promise.all(
            ([{}, { tvdb: '55' }] as Record<string, string>[]).map((externalIds) =>
                findOrCreateSeriesHierarchy(
                    sql,
                    '/lib/Test/unparseable.mkv',
                    { title: 'Test', season: 1 } as ReturnType<typeof parsedFor>,
                    ctx,
                    identityOptions({ candidate: { ...candidate, externalIds } }),
                    new Map(),
                    new Map(),
                    done,
                ),
            ),
        );
        expect(afterMatchedSpy).toHaveBeenCalledTimes(1);
    });
    it.each(['tmdb', 'imdb'])(
        'rejects unowned contradictory %s evidence before series creation',
        async (provider) => {
            const options =
                provider === 'tmdb'
                    ? identityOptions({
                          candidate: { ...candidate, externalIds: { tmdb: 'different' } },
                      })
                    : identityOptions({
                          imdbId: 'ttfirst',
                          candidate: { ...candidate, externalIds: { imdb: 'ttsecond' } },
                      });
            await expect(scan(options)).rejects.toThrow('Conflicting series identity evidence');
            expect(findOrCreateSeriesSpy).not.toHaveBeenCalled();
            expect(attachFileToItem).not.toHaveBeenCalled();
        },
    );
    it('rejects implicit adoption of an owner with an incompatible primary mapping', async () => {
        resolveIdentitySpy.mockResolvedValueOnce(null).mockResolvedValueOnce('owner');
        getExternalIdsSpy.mockResolvedValue([{ provider: 'tmdb', id: 'other', mediaType: 'tv' }]);
        const cache = new Map<string, string>();
        await expect(
            scan(
                identityOptions({ candidate: { ...candidate, externalIds: { imdb: 'ttowner' } } }),
                cache,
            ),
        ).rejects.toThrow('Conflicting series provider mapping');
        expect(cache.size).toBe(0);
        expect(upsertExternalIdDetailedSpy).not.toHaveBeenCalled();
        expect(attachFileToItem).not.toHaveBeenCalled();
    });
    it('aborts and evicts implicit resolution when a foreign owner wins enrichment', async () => {
        const error = new Error('owned');
        error.name = 'ExternalIdOwnedByAnotherItemError';
        upsertExternalIdDetailedSpy.mockRejectedValueOnce(error);
        const cache = new Map<string, string>();
        await expect(scan(optionsFor(), cache)).rejects.toThrow(
            'Conflicting series identity ownership',
        );
        expect(cache.size).toBe(0);
        expect(attachFileToItem).not.toHaveBeenCalled();
        await scan(optionsFor(), cache);
        expect(findOrCreateSeriesSpy).toHaveBeenCalledTimes(2);
    });
    it('normalizes dashed Jellyfin evidence before comparing conflicting owners', async () => {
        resolveIdentitySpy.mockResolvedValueOnce('first').mockResolvedValueOnce('second');
        await expect(
            scan(
                identityOptions({
                    candidate: {
                        ...candidate,
                        provider: 'jellyfin',
                        externalId: 'a1bc9a3d-39d6-8698-370b-bcd45cfb9c11',
                        externalIds: { tmdb: '55' },
                    },
                }),
            ),
        ).rejects.toThrow('Conflicting series identity evidence');
        expect(resolveIdentitySpy).toHaveBeenNthCalledWith(
            1,
            expect.anything(),
            'a1bc9a3d39d68698370bbcd45cfb9c11',
            'tv',
            'jellyfin',
        );
    });
    it('coalesces concurrent inline provider detail work independently of announcements', async () => {
        vi.stubEnv('SCAN_ENRICH_INLINE', 'true');
        let release!: () => void;
        vi.mocked(invokeProviderDetail).mockImplementationOnce(
            async () =>
                new Promise<void>((resolve) => {
                    release = resolve;
                }),
        );
        const done = new Set<string>();
        const options = identityOptions({ metadataProviderId: 'tmdb' });
        try {
            const first = scan(options, new Map(), done);
            while (!release) await Promise.resolve();
            const second = scan(options, new Map(), done);
            await second;
            release();
            await first;
            expect(invokeProviderDetail).toHaveBeenCalledTimes(1);
        } finally {
            vi.unstubAllEnvs();
        }
    });
    it('retries a failed metadata announcement on the next episode', async () => {
        vi.stubEnv('NODE_ENV', 'production');
        afterMatchedSpy
            .mockRejectedValueOnce(new Error('queue unavailable'))
            .mockResolvedValue(undefined);
        const done = new Set<string>();
        try {
            await scan(optionsFor(), new Map(), done);
            await Promise.resolve();
            await scan(optionsFor(), new Map(), done);
            expect(afterMatchedSpy).toHaveBeenCalledTimes(2);
        } finally {
            vi.unstubAllEnvs();
        }
    });
    it('revalidates completed identity after an operator transfers ownership mid-scan', async () => {
        const cache = new Map<string, string>();
        const done = new Set<string>();
        await scan(optionsFor(), cache, done);
        vi.mocked(attachFileToItem).mockClear();
        getExternalIdsSpy.mockResolvedValue([]);
        const error = new Error('operator transferred ID');
        error.name = 'ExternalIdOwnedByAnotherItemError';
        upsertExternalIdDetailedSpy.mockRejectedValueOnce(error);
        await expect(scan(optionsFor(), cache, done)).rejects.toThrow(
            'Conflicting series identity ownership',
        );
        expect(cache.size).toBe(0);
        expect(attachFileToItem).not.toHaveBeenCalled();
        expect(upsertExternalIdDetailedSpy).toHaveBeenCalledTimes(2);
    });
    it('evicts contradictory evidence cached by an earlier explicit resolution', async () => {
        const cache = new Map<string, string>();
        const conflicting = identityOptions({
            candidate: { ...candidate, externalIds: { tmdb: 'different' } },
        });
        await scan({ ...conflicting, resolvedSeriesId: 'explicit' }, cache);
        expect(cache.size).toBe(1);
        vi.mocked(attachFileToItem).mockClear();
        await expect(scan(conflicting, cache)).rejects.toThrow(
            'Conflicting series identity evidence',
        );
        expect(cache.size).toBe(0);
        expect(attachFileToItem).not.toHaveBeenCalled();
    });
});

describe('series identity: secondary and re-assigned provider ids do not block ingest', () => {
    const J1 = 'a1bc9a3d39d68698370bbcd45cfb9c11';
    const J2 = 'b2cd0b4e40e79709481ccde56d0ac22';
    beforeEach(() => {
        vi.clearAllMocks();
        mockPersistedMappings();
        findOrCreateSeriesSpy.mockReset().mockResolvedValue('series-uuid');
        upsertExternalIdDetailedSpy.mockReset().mockResolvedValue({ written: true, changed: true });
        seasonHasCanonicalEpisodesSpy.mockResolvedValue(false);
        resolveIdentitySpy.mockReset().mockImplementation(async (_sql, id: string) => {
            for (const [seriesId, mappings] of persistedMappings) {
                if (mappings.some((mapping) => mapping.id === id)) return seriesId;
            }
            return null;
        });
    });
    const scan = (options: HierarchyOptions) =>
        findOrCreateSeriesHierarchy(
            makeFakeSql() as unknown as import('postgres').Sql,
            '/lib/Test/S01E01.mkv',
            parsedFor(1),
            ctx,
            options,
            new Map(),
            new Map(),
            new Set(),
        );

    it('skips a secondary id that disagrees with the stored one and still links the episode', async () => {
        persistedMappings.set('series-uuid', [
            { provider: 'tmdb', id: '1234', mediaType: 'tv' },
            { provider: 'tvdb', id: 'stored-tvdb', mediaType: 'tv' },
        ]);
        const result = await scan(
            identityOptions({ candidate: { ...candidate, externalIds: { tvdb: 'other-tvdb' } } }),
        );
        expect(result.seriesId).toBe('series-uuid');
        expect(attachFileToItem).toHaveBeenCalled();
        expect(upsertExternalIdDetailedSpy).not.toHaveBeenCalledWith(
            'series-uuid',
            expect.objectContaining({ provider: 'tvdb' }),
            expect.anything(),
            expect.anything(),
        );
        expect(ctx.logger.warn).toHaveBeenCalledWith(
            '[FileScanner] Skipping disagreeing secondary series id',
            expect.objectContaining({ provider: 'tvdb', keeping: 'stored-tvdb' }),
        );
    });

    it('replaces a re-assigned Jellyfin id when the Jellyfin item still names the series by TMDB id', async () => {
        persistedMappings.set('series-uuid', [
            { provider: 'jellyfin', id: J1, mediaType: 'tv' },
            { provider: 'tmdb', id: '4556', mediaType: 'tv' },
        ]);
        const result = await scan(
            identityOptions({
                candidate: {
                    ...candidate,
                    provider: 'jellyfin',
                    externalId: J2,
                    externalIds: { tmdb: '4556' },
                },
            }),
        );
        expect(result.seriesId).toBe('series-uuid');
        expect(attachFileToItem).toHaveBeenCalled();
        // Not the preserve-only write: the catalog's replace-when-stale path,
        // with its convergence window, decides whether the new id wins.
        const jellyfinWrite = upsertExternalIdDetailedSpy.mock.calls.find(
            (call) => (call[1] as { provider: string }).provider === 'jellyfin',
        );
        expect(jellyfinWrite?.[1]).toMatchObject({ provider: 'jellyfin', id: J2 });
        expect(jellyfinWrite?.[3]).toBeUndefined();
    });

    it('keeps ingesting when the convergence window skips the re-assigned primary id', async () => {
        persistedMappings.set('series-uuid', [
            { provider: 'jellyfin', id: J1, mediaType: 'tv' },
            { provider: 'tmdb', id: '4556', mediaType: 'tv' },
        ]);
        upsertExternalIdDetailedSpy.mockImplementation(async (...args: unknown[]) =>
            (args[1] as { provider: string }).provider === 'jellyfin'
                ? { written: false, changed: false }
                : { written: true, changed: false },
        );
        const result = await scan(
            identityOptions({
                candidate: {
                    ...candidate,
                    provider: 'jellyfin',
                    externalId: J2,
                    externalIds: { tmdb: '4556' },
                },
            }),
        );
        expect(result.seriesId).toBe('series-uuid');
        expect(attachFileToItem).toHaveBeenCalled();
    });

    it('treats a concurrent duplicate insert of the same mapping as confirmed', async () => {
        const duplicate = Object.assign(new Error('duplicate key value'), { code: '23505' });
        upsertExternalIdDetailedSpy.mockImplementationOnce(async () => {
            // The concurrent writer committed the identical mapping first.
            persistedMappings.set('series-uuid', [
                { provider: 'tmdb', id: '1234', mediaType: 'tv' },
            ]);
            throw duplicate;
        });
        const result = await scan(optionsFor());
        expect(result.seriesId).toBe('series-uuid');
        expect(attachFileToItem).toHaveBeenCalled();
    });

    it('skips a secondary id another series owns instead of failing the file', async () => {
        persistedMappings.set('other-series', [{ provider: 'tvdb', id: '55', mediaType: 'tv' }]);
        // Not visible at resolution time; claimed concurrently before the write.
        resolveIdentitySpy.mockResolvedValue(null);
        const owned = new Error('owned');
        owned.name = 'ExternalIdOwnedByAnotherItemError';
        upsertExternalIdDetailedSpy.mockImplementation(async (...args: unknown[]) => {
            if ((args[1] as { provider: string }).provider === 'tvdb') {
                resolveIdentitySpy.mockResolvedValue('other-series');
                throw owned;
            }
            return { written: true, changed: true };
        });
        const result = await scan(
            identityOptions({ candidate: { ...candidate, externalIds: { tvdb: '55' } } }),
        );
        expect(result.seriesId).toBe('series-uuid');
        expect(attachFileToItem).toHaveBeenCalled();
    });
});
