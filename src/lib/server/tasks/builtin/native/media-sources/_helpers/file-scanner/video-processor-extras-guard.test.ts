// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Regression test: `processVideoFile` must never process an extras path
 * (named subfolder like `trailers/`, or a Jellyfin filename-suffix extra like
 * `Film-trailer.mkv`) as a primary video/version — even when the file is
 * DB-known-but-unlinked (the `existingFileBlock` "no link → fall through to
 * new-file processing" branch would otherwise treat it as needing its link
 * recreated).
 *
 * This is the same choke point `attemptVersionLinkOrCreate`/`linkAsVersion`
 * would otherwise re-attach the file at as a version of the folder's primary
 * item. The guard sits before ANY of those code paths run, so this test only
 * needs to prove none of the attach-side collaborators (`upsertMediaFile`,
 * `attachFileToItem`, `linkFileAsVersion`, `findParentMediaItemByFolder`) are
 * ever invoked for an extras path, and that the outcome is `'skipped'` (so the
 * dedicated `walkExtras` → `processExtra` pass gets to attach it correctly
 * afterwards).
 *
 * Mock harness mirrors `video-processor-crosslink.test.ts` — video-processor.ts
 * pulls in a large module graph at import time regardless of which exported
 * function a test calls, so every collaborator must be stubbed.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// ---------------------------------------------------------------------------
// Hoisted spy refs
// ---------------------------------------------------------------------------
const upsertMediaFileSpy = vi.hoisted(() =>
    vi.fn<() => Promise<{ id: string; created: boolean }>>(),
);
const attachFileToItemSpy = vi.hoisted(() => vi.fn<() => Promise<void>>());
const linkFileAsVersionSpy = vi.hoisted(() => vi.fn<() => Promise<void>>());
const findParentMediaItemByFolderSpy = vi.hoisted(() => vi.fn<() => Promise<string | null>>());
const isFileLinkedToMediaItemSpy = vi.hoisted(() => vi.fn<() => Promise<boolean>>());
const findMediaFileByPathSpy = vi.hoisted(() => vi.fn<() => Promise<null>>());
const processAudioFileSpy = vi.hoisted(() => vi.fn<() => Promise<string>>());

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
    seasonHasCanonicalEpisodes: vi.fn().mockResolvedValue(false),
    listCanonicalEpisodeTitles: vi.fn().mockResolvedValue([]),
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
        const tx = new Proxy(fakeTx, {
            apply: (_target, _thisArg, args) => fakeTx(...args),
        });
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
    upsertMediaFile: upsertMediaFileSpy,
    attachFileToItem: attachFileToItemSpy,
    touchLibraryAddedAt: vi.fn().mockResolvedValue(undefined),
    isFileLinkedToMediaItem: isFileLinkedToMediaItemSpy,
    getLinkedEpisodeNumbersForFile: vi.fn().mockResolvedValue(new Set()),
    detachAndClearAwaitingMatchForFile: vi.fn().mockResolvedValue(0),
    findAwaitingMatchItemIdsForFile: vi.fn().mockResolvedValue([]),
    clearAwaitingMatchFlag: vi.fn().mockResolvedValue(undefined),
    findAllLinkedMediaItemsByFilePath: vi.fn().mockResolvedValue([]),
    findParentMediaItemByFolder: findParentMediaItemByFolderSpy,
    getFilesForMediaItem: vi.fn().mockResolvedValue([]),
    findMediaFileByPath: findMediaFileByPathSpy,
    updateFileStat: vi.fn().mockResolvedValue(undefined),
    mediaItemHasFile: vi.fn().mockResolvedValue(false),
    linkFileAsVersion: linkFileAsVersionSpy,
    deleteStaleMediaFile: vi.fn().mockResolvedValue(undefined),
    recordFileScanIssue: vi.fn().mockResolvedValue({}),
    recordRangeSupersededFile: vi.fn().mockResolvedValue(undefined),
    clearRangeSupersededIfLinked: vi.fn().mockResolvedValue(undefined),
    getFileScanRetryAt: vi.fn().mockResolvedValue(null),
    clearFileScanIssue: vi.fn().mockResolvedValue(undefined),
    clearUnlinkedFileScanIssue: vi.fn().mockResolvedValue(undefined),
    recordDecodeHealthIssue: vi.fn().mockResolvedValue(undefined),
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
vi.mock('./shared.js', async (importOriginal) => {
    const actual = await importOriginal<typeof import('./shared.js')>();
    return {
        ...actual,
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
    };
});
vi.mock('./change-detection.js', () => ({
    detectFileChanges: vi.fn().mockResolvedValue({ status: 'unchanged' }),
}));
vi.mock('./audio-processor.js', () => ({
    processAudioFile: processAudioFileSpy,
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

import { processVideoFile } from './video-processor.js';
import type { LibraryPathRow } from '../../../../../../database/queries/library-paths.queries.js';
import type { KnownFileRow } from '../../../../../../database/queries/media-files.queries.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

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
    logger: {
        debug: vi.fn(),
        info: vi.fn(),
        warn: vi.fn(),
        error: vi.fn(),
    },
};

const libraryPath: LibraryPathRow = {
    id: 'lib-path-uuid',
    path: '/data/movies',
    media_type: 'movie',
    language: 'en',
    provider: 'tmdb',
    enabled: true,
    provider_path: null,
    library_group_id: 'group-uuid',
    edition_label: null,
    scan_chapters: false,
    fallback_providers: [],
    source_prefix: null,
    created_at: new Date(),
    updated_at: new Date(),
};

const MOVIE_ROOT = '/data/movies/Cinderella (1950) [imdbid-tt0042332]';
const TRAILER_IN_SUBFOLDER = `${MOVIE_ROOT}/trailers/Cinderella-trailer.mp4`;
const SUFFIX_EXTRA = `${MOVIE_ROOT}/Cinderella-trailer.mkv`;
const PRIMARY = `${MOVIE_ROOT}/Cinderella (1950) [imdbid-tt0042332].mkv`;

function orphanedRow(filePath: string): KnownFileRow {
    return {
        id: 'orphan-file-uuid',
        file_path: filePath,
        file_mtime: null,
        file_size_bytes: null,
        file_hash_head: null,
        health_issues: null,
        is_linked: false,
    };
}

describe('processVideoFile — extras paths are never claimed as a primary video/version', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        isFileLinkedToMediaItemSpy.mockResolvedValue(false);
        findMediaFileByPathSpy.mockResolvedValue(null);
        upsertMediaFileSpy.mockResolvedValue({ id: 'new-file-uuid', created: true });
        findParentMediaItemByFolderSpy.mockResolvedValue(null);
        processAudioFileSpy.mockResolvedValue('skipped');
    });

    it('returns "skipped" for a DB-known-but-unlinked extras-subfolder path without attaching', async () => {
        const knownFiles = new Map<string, KnownFileRow>([
            [TRAILER_IN_SUBFOLDER, orphanedRow(TRAILER_IN_SUBFOLDER)],
        ]);
        const sql = makeFakeSql();

        const outcome = await processVideoFile(
            sql as unknown as import('postgres').Sql,
            TRAILER_IN_SUBFOLDER,
            libraryPath,
            ['tmdb'],
            fakeContext as unknown as import('./shared.js').FileScannerContext,
            knownFiles,
        );

        expect(outcome).toBe('skipped');
        expect(upsertMediaFileSpy).not.toHaveBeenCalled();
        expect(attachFileToItemSpy).not.toHaveBeenCalled();
        expect(linkFileAsVersionSpy).not.toHaveBeenCalled();
        expect(findParentMediaItemByFolderSpy).not.toHaveBeenCalled();
    });

    it('returns "skipped" for a DB-known-but-unlinked filename-suffix extra without attaching', async () => {
        const knownFiles = new Map<string, KnownFileRow>([
            [SUFFIX_EXTRA, orphanedRow(SUFFIX_EXTRA)],
        ]);
        const sql = makeFakeSql();

        const outcome = await processVideoFile(
            sql as unknown as import('postgres').Sql,
            SUFFIX_EXTRA,
            libraryPath,
            ['tmdb'],
            fakeContext as unknown as import('./shared.js').FileScannerContext,
            knownFiles,
        );

        expect(outcome).toBe('skipped');
        expect(upsertMediaFileSpy).not.toHaveBeenCalled();
        expect(attachFileToItemSpy).not.toHaveBeenCalled();
        expect(linkFileAsVersionSpy).not.toHaveBeenCalled();
    });

    it('a genuine (non-extras) unlinked file still falls through to normal processing', async () => {
        const knownFiles = new Map<string, KnownFileRow>([[PRIMARY, orphanedRow(PRIMARY)]]);
        const sql = makeFakeSql();

        const outcome = await processVideoFile(
            sql as unknown as import('postgres').Sql,
            PRIMARY,
            libraryPath,
            ['tmdb'],
            fakeContext as unknown as import('./shared.js').FileScannerContext,
            knownFiles,
        );

        // Not 'skipped' via the extras guard — it proceeds into the normal
        // match/create pipeline (ends up 'added' via insertScannedMediaItem's
        // mocked 'new-uuid' path through findParentMediaItemByFolder → null →
        // createPersonalMediaItem, or similar; the precise outcome isn't the
        // point here — what matters is the extras short-circuit did NOT fire).
        expect(outcome).not.toBe('error');
        expect(findParentMediaItemByFolderSpy).toHaveBeenCalled();
    });
});
