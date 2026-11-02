// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Regression test for the "false-success" bug in findOrCreateSeriesHierarchy.
 *
 * When an episode number is unparseable AND the season already has canonical
 * episodes AND the file is not already linked, the scanner deliberately skips
 * creating an episode, recording an `episode_number_unparsed` scan issue instead. Before the fix, that
 * skip returned `outcome: 'updated'` — so scan stats claimed a successful update
 * while the file silently never linked. The fix returns a new `'skipped'`
 * outcome so the aggregated scan stats reflect reality.
 *
 * All heavy collaborators (DB queries, catalog service, ffprobe, lifecycle) are
 * stubbed so the test runs without a real database or filesystem. Mock block is
 * shared with video-processor-crosslink.test.ts.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// ---------------------------------------------------------------------------
// Hoisted spy refs
// ---------------------------------------------------------------------------
const seasonHasCanonicalEpisodesSpy = vi.hoisted(() => vi.fn<() => Promise<boolean>>());
const listCanonicalEpisodeTitlesSpy = vi.hoisted(() =>
    vi.fn<
        () => Promise<
            Array<{
                id: string;
                title: string;
                english_title: string | null;
                original_title: string | null;
            }>
        >
    >(),
);
const attachFileToItemSpy = vi.hoisted(() =>
    vi.fn<(...args: unknown[]) => Promise<void>>().mockResolvedValue(undefined),
);
const findAllLinkedMediaItemsByFilePathSpy = vi.hoisted(() => vi.fn<() => Promise<string[]>>());
const recordScanIssueWithCooldownSpy = vi.hoisted(() =>
    vi.fn<(...args: unknown[]) => Promise<void>>().mockResolvedValue(undefined),
);
const upsertMediaFileSpy = vi.hoisted(() =>
    vi.fn<() => Promise<{ id: string; created: boolean }>>(),
);

// ---------------------------------------------------------------------------
// Module mocks — must precede the import under test
// ---------------------------------------------------------------------------
vi.mock('../../../../../../database/queries/media-lookup.queries.js', () => ({
    resolveExternalIdToUuid: vi.fn().mockResolvedValue(null),
}));
vi.mock('../../../../../../services/catalog.service.js', () => ({
    createCatalogService: vi.fn(() => ({
        upsertExternalId: vi.fn(),
        upsertExternalIdDetailed: vi.fn().mockResolvedValue({ written: true, changed: false }),
    })),
}));
vi.mock('../../../../../../database/queries/media-items.queries.js', () => ({
    insertScannedMediaItem: vi.fn().mockResolvedValue('new-uuid'),
    findPersonalMediaItemByTitleYear: vi.fn().mockResolvedValue(null),
    normalizeTitleForVersionDedupe: vi.fn((title: string) => title.toLowerCase()),
    getMediaItemType: vi.fn().mockResolvedValue(null),
    findOrCreatePersonalSeason: vi.fn().mockResolvedValue('season-uuid'),
    findOrCreatePersonalEpisode: vi.fn().mockResolvedValue({ id: 'ep-uuid', created: false }),
    getNextEpisodeNumber: vi.fn().mockResolvedValue(1),
    seasonHasCanonicalEpisodes: seasonHasCanonicalEpisodesSpy,
    listCanonicalEpisodeTitles: listCanonicalEpisodeTitlesSpy,
    findOrCreateSeries: vi.fn().mockResolvedValue('series-uuid'),
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
        const tx = new Proxy(fakeTx, { apply: (_t, _a, args) => fakeTx(...args) });
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
    parseMediaFilename: vi.fn().mockReturnValue({ title: 'Show' }),
    editionCanonicalToDisplayName: vi.fn().mockReturnValue(''),
}));
vi.mock('$lib/server/utils/media-types.js', () => ({
    isNonEntertainment: vi.fn().mockReturnValue(false),
    isMusic: vi.fn().mockReturnValue(false),
    isMovie: vi.fn().mockReturnValue(false),
    isSeries: vi.fn().mockReturnValue(true),
}));
vi.mock('$lib/shared/library-type-templates.js', () => ({
    getLibraryTypeTemplate: vi.fn().mockReturnValue(null),
}));
vi.mock('../../../../../../database/queries/media-files.queries.js', () => ({
    upsertMediaFile: upsertMediaFileSpy,
    attachFileToItem: attachFileToItemSpy,
    touchLibraryAddedAt: vi.fn().mockResolvedValue(undefined),
    isFileLinkedToMediaItem: vi.fn().mockResolvedValue(false),
    getLinkedEpisodeNumbersForFile: vi.fn().mockResolvedValue(new Set()),
    detachAndClearAwaitingMatchForFile: vi.fn().mockResolvedValue(0),
    findAwaitingMatchItemIdsForFile: vi.fn().mockResolvedValue([]),
    clearAwaitingMatchFlag: vi.fn().mockResolvedValue(undefined),
    findAllLinkedMediaItemsByFilePath: findAllLinkedMediaItemsByFilePathSpy,
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
    recordScanIssueWithCooldown: recordScanIssueWithCooldownSpy,
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
// Import under test (after all mocks are in place)
// ---------------------------------------------------------------------------
import { findOrCreateSeriesHierarchy } from './video-processor.js';
import type { FileScannerContext } from './shared.js';

function makeFakeSql() {
    const fn = vi.fn().mockResolvedValue([]);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (fn as any).array = (v: unknown[]) => v;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (fn as any).json = (v: unknown) => v;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (fn as any).unsafe = vi.fn();
    return fn;
}

const fakeContext = {
    logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
} as unknown as FileScannerContext;

// parsed with NO episode number in a season number 1.
const parsedNoEpisode = { title: 'Show', season: 1 } as unknown as ReturnType<
    typeof import('../../../../../../utils/filename-parser.js').parseMediaFilename
>;

describe('findOrCreateSeriesHierarchy — unparseable episode in canonical season returns skipped', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        findAllLinkedMediaItemsByFilePathSpy.mockResolvedValue([]);
        listCanonicalEpisodeTitlesSpy.mockResolvedValue([]);
        upsertMediaFileSpy.mockResolvedValue({ id: 'file-uuid', created: true });
    });

    it("returns outcome 'skipped' (not 'updated'), links nothing, and records why when the season has canonical episodes", async () => {
        seasonHasCanonicalEpisodesSpy.mockResolvedValue(true);
        const sql = makeFakeSql();

        const result = await findOrCreateSeriesHierarchy(
            sql as unknown as import('postgres').Sql,
            '/library/Show/Season 01/bonus-clip.mkv',
            parsedNoEpisode,
            fakeContext,
            { resolvedSeriesId: 'series-uuid', libraryGroupId: 'lg-1' },
        );

        expect(result.outcome).toBe('skipped');
        expect(result.episodeIds).toEqual([]);
        // No episode link and no linked media_files row...
        expect(upsertMediaFileSpy).not.toHaveBeenCalled();
        // ...but the skip is recorded as a scan issue (which keeps a stub row),
        // so the file shows on the Ingest Map and the ingest funnel with the
        // reason, instead of vanishing with only a log line.
        expect(recordScanIssueWithCooldownSpy).toHaveBeenCalledWith(
            sql,
            '/library/Show/Season 01/bonus-clip.mkv',
            'lg-1',
            'episode_number_unparsed',
            expect.stringContaining('episode number'),
        );
    });

    it("still auto-numbers (outcome != 'skipped') when the season has NO canonical episodes", async () => {
        seasonHasCanonicalEpisodesSpy.mockResolvedValue(false);
        const sql = makeFakeSql();

        const result = await findOrCreateSeriesHierarchy(
            sql as unknown as import('postgres').Sql,
            '/library/Show/Season 01/bonus-clip.mkv',
            parsedNoEpisode,
            fakeContext,
            { resolvedSeriesId: 'series-uuid', libraryGroupId: 'lg-1' },
        );

        // Not skipped — the file goes through the auto-number path and a
        // media_files row is created.
        expect(result.outcome).not.toBe('skipped');
        expect(upsertMediaFileSpy).toHaveBeenCalled();
        expect(recordScanIssueWithCooldownSpy).not.toHaveBeenCalled();
    });

    it('links an unnumbered file to the canonical episode whose title it carries', async () => {
        seasonHasCanonicalEpisodesSpy.mockResolvedValue(true);
        listCanonicalEpisodeTitlesSpy.mockResolvedValue([
            {
                id: 'ep-xmas',
                title: 'The Ghost of Christmas',
                english_title: null,
                original_title: null,
            },
            { id: 'ep-came', title: 'He Came!', english_title: null, original_title: null },
        ]);
        const sql = makeFakeSql();

        const result = await findOrCreateSeriesHierarchy(
            sql as unknown as import('postgres').Sql,
            '/library/Ghosts/Season 01/He Came.mp4',
            { title: 'He Came', season: 1 } as unknown as typeof parsedNoEpisode,
            fakeContext,
            { resolvedSeriesId: 'series-uuid', libraryGroupId: 'lg-1' },
        );

        expect(result.outcome).not.toBe('skipped');
        expect(result.episodeIds).toEqual(['ep-came']);
        expect(attachFileToItemSpy).toHaveBeenCalledWith(sql, 'file-uuid', 'ep-came');
        expect(recordScanIssueWithCooldownSpy).not.toHaveBeenCalled();
    });

    it('auto-numbers an unmatched file in the Specials season instead of refusing it', async () => {
        seasonHasCanonicalEpisodesSpy.mockResolvedValue(true);
        const sql = makeFakeSql();

        const result = await findOrCreateSeriesHierarchy(
            sql as unknown as import('postgres').Sql,
            '/library/Stromberg/Season 00/capitol-mitarbeiter-doku.avi',
            { title: 'capitol mitarbeiter doku', season: 0 } as unknown as typeof parsedNoEpisode,
            fakeContext,
            { resolvedSeriesId: 'series-uuid', libraryGroupId: 'lg-1' },
        );

        expect(result.outcome).not.toBe('skipped');
        expect(upsertMediaFileSpy).toHaveBeenCalled();
        expect(recordScanIssueWithCooldownSpy).not.toHaveBeenCalled();
    });
});
