// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * P1 + R2 residual (fix plan 6, Task 7 / S-P1, S-P1b): `processVideoFile`
 * must refuse two input classes before a `media_item` link exists for them,
 * recording a scan issue exactly like the pre-existing `filename_not_utf8`
 * (mangled-filename) case (the issue itself upserts a `media_files` STUB
 * row, so the file shows on the Ingest Map):
 *
 * 1. A filename containing a raw control character (`hasControlChars()`,
 *    shared with `init.ts` and `writeConcatTmpFile`) — such a name must
 *    never reach the ffmpeg concat list writer.
 * 2. A probed `format_name` identifying a playlist/reference-following
 *    container (`hls`, `dash`, `concat`, `imf`, via
 *    `isPlaylistClassContainer()`) — refusing it keeps it from ever getting
 *    a `media_item` link (a `media_files` STUB row is still upserted, for
 *    Ingest Map visibility — see `recordFileScanIssue`), so no playback
 *    query and no downstream ffmpeg/ffprobe argv builder ever selects it.
 *
 * Fix round 1 (F1a) adds a THIRD case: a LINKED file whose content changes
 * (same path, new bytes) must be re-probed too — before this fix,
 * `content-changed` returned 'updated' without ever probing, so an
 * already-linked row stayed selectable after turning into a playlist-class
 * container. The fix tombstones it via `deleteStaleMediaFile` (same as a
 * vanished file) instead of merely recording a scan issue on a still-linked
 * row.
 *
 * Mock harness mirrors `video-processor-extras-guard.test.ts` —
 * video-processor.ts pulls in a large module graph at import time
 * regardless of which exported function a test calls, so every collaborator
 * must be stubbed.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// ---------------------------------------------------------------------------
// Hoisted spy refs
// ---------------------------------------------------------------------------
const upsertMediaFileSpy = vi.hoisted(() =>
    vi.fn<() => Promise<{ id: string; created: boolean }>>(),
);
const recordFileScanIssueSpy = vi.hoisted(() => vi.fn().mockResolvedValue({}));
const getFileScanRetryAtSpy = vi.hoisted(() => vi.fn().mockResolvedValue(null));
const probeMediaFileSpy = vi.hoisted(() =>
    vi.fn().mockResolvedValue({ success: true, duration: 120, container: null }),
);
const findParentMediaItemByFolderSpy = vi.hoisted(() => vi.fn<() => Promise<string | null>>());
const isFileLinkedToMediaItemSpy = vi.hoisted(() => vi.fn<() => Promise<boolean>>());
const findMediaFileByPathSpy = vi.hoisted(() => vi.fn<() => Promise<null>>());
const deleteStaleMediaFileSpy = vi.hoisted(() =>
    vi.fn().mockResolvedValue({ deleted: true } as const),
);
const detectFileChangesSpy = vi.hoisted(() => vi.fn().mockResolvedValue({ status: 'unchanged' }));
const onFileContentChangedSpy = vi.hoisted(() =>
    vi.fn().mockResolvedValue({ invalidatedMediaItemIds: [] }),
);
const clearFileScanIssueSpy = vi.hoisted(() => vi.fn().mockResolvedValue(undefined));
const recordDecodeHealthIssueSpy = vi.hoisted(() => vi.fn().mockResolvedValue(undefined));
const updateFileStatSpy = vi.hoisted(() => vi.fn().mockResolvedValue(undefined));

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
    attachFileToItem: vi.fn().mockResolvedValue(undefined),
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
    updateFileStat: updateFileStatSpy,
    mediaItemHasFile: vi.fn().mockResolvedValue(false),
    linkFileAsVersion: vi.fn().mockResolvedValue(undefined),
    deleteStaleMediaFile: deleteStaleMediaFileSpy,
    recordFileScanIssue: recordFileScanIssueSpy,
    recordRangeSupersededFile: vi.fn().mockResolvedValue(undefined),
    clearRangeSupersededIfLinked: vi.fn().mockResolvedValue(undefined),
    getFileScanRetryAt: getFileScanRetryAtSpy,
    clearFileScanIssue: clearFileScanIssueSpy,
    clearUnlinkedFileScanIssue: vi.fn().mockResolvedValue(undefined),
    recordDecodeHealthIssue: recordDecodeHealthIssueSpy,
}));
vi.mock('../../../../../../services/metadata-matching.service.js', () => ({
    matchFileToMetadata: vi.fn().mockResolvedValue({ matched: false }),
}));
vi.mock('../../../../../../utils/ffprobe.js', () => ({
    probeChapters: vi.fn().mockResolvedValue({ chapters: [] }),
    probeMediaFile: probeMediaFileSpy,
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
        onFileContentChanged: onFileContentChangedSpy,
    },
}));
// Partial mock: the probe-outcome helpers (applyContentChange,
// probeNewFileForScan, recordScanIssueWithCooldown,
// clearStaleRefusalAndEnsureChangeDetection) run for REAL here, since they
// only call the already-mocked leaves above (probeMediaFile,
// deleteStaleMediaFile, recordFileScanIssue, getFileScanRetryAt,
// recordDecodeHealthIssue, updateFileStat, clearFileScanIssue,
// onFileContentChanged) — this is the seam these tests actually want to
// prove, not a second copy of the logic re-asserted against a mock of itself.
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
    detectFileChanges: detectFileChangesSpy,
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
const PRIMARY = `${MOVIE_ROOT}/Cinderella (1950) [imdbid-tt0042332].mkv`;
const CONTROL_CHAR_PATH = `${MOVIE_ROOT}/Cinderella.Part2\nfile '/tmp/outside.mkv'.mkv`;

async function run(
    filePath: string,
    knownFiles?: Map<string, KnownFileRow>,
    abortSignal?: AbortSignal,
    onError?: (reason: string) => void,
) {
    const sql = makeFakeSql();
    return processVideoFile(
        sql as unknown as import('postgres').Sql,
        filePath,
        libraryPath,
        ['tmdb'],
        fakeContext as unknown as import('./shared.js').FileScannerContext,
        knownFiles,
        abortSignal,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        onError,
    );
}

function linkedKnownFile(filePath: string): Map<string, KnownFileRow> {
    return new Map([
        [
            filePath,
            {
                id: 'existing-file-uuid',
                file_path: filePath,
                file_mtime: new Date('2020-01-01'),
                file_size_bytes: 1000,
                file_hash_head: 'old-hash',
                health_issues: null,
                is_linked: true,
            },
        ],
    ]);
}

describe('processVideoFile — control-character filename guard (P1)', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        probeMediaFileSpy.mockResolvedValue({ success: true, duration: 120, container: null });
        getFileScanRetryAtSpy.mockResolvedValue(null);
        recordFileScanIssueSpy.mockResolvedValue({});
        isFileLinkedToMediaItemSpy.mockResolvedValue(false);
        findMediaFileByPathSpy.mockResolvedValue(null);
        upsertMediaFileSpy.mockResolvedValue({ id: 'new-file-uuid', created: true });
        findParentMediaItemByFolderSpy.mockResolvedValue(null);
    });

    it('skips a filename containing an embedded newline and records a scan issue, never probing it', async () => {
        const onError = vi.fn();
        const outcome = await run(CONTROL_CHAR_PATH, undefined, undefined, onError);

        expect(outcome).toBe('error');
        expect(recordFileScanIssueSpy).toHaveBeenCalledWith(
            expect.anything(),
            expect.objectContaining({ type: 'unsafe_filename' }),
        );
        expect(probeMediaFileSpy).not.toHaveBeenCalled();
        expect(upsertMediaFileSpy).not.toHaveBeenCalled();
        // The caller must get the SPECIFIC reason, not just the bare 'error'
        // outcome — this is what file-scanner.ts's result.errors now records
        // instead of a generic "file processing failed" for every failure.
        expect(onError).toHaveBeenCalledWith(expect.stringContaining('control character'));
    });

    // Control: a normal filename must still be ingested (not caught by the guard).
    it('does not flag a normal filename', async () => {
        const outcome = await run(PRIMARY);

        expect(outcome).not.toBe('error');
        expect(recordFileScanIssueSpy).not.toHaveBeenCalledWith(
            expect.anything(),
            expect.objectContaining({ type: 'unsafe_filename' }),
        );
        expect(probeMediaFileSpy).toHaveBeenCalled();
    });
});

describe('processVideoFile — mangled (non-UTF-8) filename guard, e.g. lossy-decoded German umlauts', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        probeMediaFileSpy.mockResolvedValue({ success: true, duration: 120, container: null });
        getFileScanRetryAtSpy.mockResolvedValue(null);
        recordFileScanIssueSpy.mockResolvedValue({});
        isFileLinkedToMediaItemSpy.mockResolvedValue(false);
        findMediaFileByPathSpy.mockResolvedValue(null);
        upsertMediaFileSpy.mockResolvedValue({ id: 'new-file-uuid', created: true });
        findParentMediaItemByFolderSpy.mockResolvedValue(null);
    });

    // What Node's fs.readdir hands back for a Latin-1-named file on disk
    // (e.g. a German "ö"/"ü" byte that isn't valid UTF-8): the real path on
    // disk can never be re-opened under this lossy string, so `safeStat`
    // genuinely ENOENTs on it — no mock needed, the path just doesn't exist.
    const MANGLED_PATH = `${MOVIE_ROOT}/Nisekoi - S02E11 - Die Di�t.mkv`;

    it('skips a lossy-UTF-8-decoded filename, records a filename_not_utf8 scan issue, and reports the specific reason (not "file processing failed")', async () => {
        const onError = vi.fn();

        const outcome = await run(MANGLED_PATH, undefined, undefined, onError);

        expect(outcome).toBe('error');
        expect(recordFileScanIssueSpy).toHaveBeenCalledWith(
            expect.anything(),
            expect.objectContaining({ type: 'filename_not_utf8' }),
        );
        expect(probeMediaFileSpy).not.toHaveBeenCalled();
        expect(upsertMediaFileSpy).not.toHaveBeenCalled();
        expect(onError).toHaveBeenCalledWith(expect.stringContaining('not valid UTF-8'));
    });
});

describe('processVideoFile — playlist-class probed container guard (P1+R2 residual)', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        getFileScanRetryAtSpy.mockResolvedValue(null);
        recordFileScanIssueSpy.mockResolvedValue({});
        isFileLinkedToMediaItemSpy.mockResolvedValue(false);
        findMediaFileByPathSpy.mockResolvedValue(null);
        upsertMediaFileSpy.mockResolvedValue({ id: 'new-file-uuid', created: true });
        findParentMediaItemByFolderSpy.mockResolvedValue(null);
    });

    it.each(['hls', 'dash', 'concat', 'imf', 'HLS', 'foo,concat,bar'])(
        'skips a file probing as %s and records a scan issue, never linking it',
        async (container) => {
            probeMediaFileSpy.mockResolvedValue({ success: true, duration: 120, container });
            const onError = vi.fn();

            const outcome = await run(PRIMARY, undefined, undefined, onError);

            expect(outcome).toBe('error');
            expect(recordFileScanIssueSpy).toHaveBeenCalledWith(
                expect.anything(),
                expect.objectContaining({ type: 'playlist_container_rejected' }),
            );
            expect(upsertMediaFileSpy).not.toHaveBeenCalled();
            expect(onError).toHaveBeenCalledWith(expect.stringContaining('playlist'));
        },
    );

    // Control: a real movie container must still be ingested.
    it('does not flag a real movie container', async () => {
        probeMediaFileSpy.mockResolvedValue({
            success: true,
            duration: 120,
            container: 'mov,mp4,m4a,3gp,3g2,mj2',
        });

        const outcome = await run(PRIMARY);

        expect(outcome).not.toBe('error');
        expect(recordFileScanIssueSpy).not.toHaveBeenCalledWith(
            expect.anything(),
            expect.objectContaining({ type: 'playlist_container_rejected' }),
        );
    });
});

describe('processVideoFile — content-changed files are re-probed and refused (F1a, fix round 1)', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        probeMediaFileSpy.mockResolvedValue({ success: true, duration: 120, container: null });
        getFileScanRetryAtSpy.mockResolvedValue(null);
        recordFileScanIssueSpy.mockResolvedValue({});
        deleteStaleMediaFileSpy.mockResolvedValue({ deleted: true });
        onFileContentChangedSpy.mockResolvedValue({ invalidatedMediaItemIds: [] });
    });

    it('retires an already-linked file whose content changed into a playlist-class container (reviewer repro)', async () => {
        detectFileChangesSpy.mockResolvedValueOnce({
            status: 'content-changed',
            fileStat: { mtime: new Date(), size: 200 },
            currentHash: 'new-hash',
        });
        probeMediaFileSpy.mockResolvedValue({ success: true, duration: 5, container: 'concat' });

        const outcome = await run(PRIMARY, linkedKnownFile(PRIMARY));

        expect(outcome).toBe('error');
        // Tombstoned exactly like a vanished file — NOT merely flagged while
        // still linked (the reviewer's finding: recordFileScanIssue alone
        // would leave the existing link selectable for playback).
        expect(deleteStaleMediaFileSpy).toHaveBeenCalledWith(expect.anything(), PRIMARY);
        expect(recordFileScanIssueSpy).toHaveBeenCalledWith(
            expect.anything(),
            expect.objectContaining({ type: 'playlist_container_rejected' }),
        );
        // The normal content-changed handling (probe-data invalidation) must
        // NOT also run — this file is being retired, not updated.
        expect(onFileContentChangedSpy).not.toHaveBeenCalled();
    });

    // Control: an ordinary content change (real container) is unaffected —
    // proves the new probe call doesn't itself change outcome for the
    // steady-state case the reviewer's harness also exercised.
    it('a content change into a real container still goes through the normal update path', async () => {
        detectFileChangesSpy.mockResolvedValueOnce({
            status: 'content-changed',
            fileStat: { mtime: new Date(), size: 200 },
            currentHash: 'new-hash',
        });
        probeMediaFileSpy.mockResolvedValue({
            success: true,
            duration: 90,
            container: 'matroska,webm',
        });

        const outcome = await run(PRIMARY, linkedKnownFile(PRIMARY));

        expect(outcome).toBe('updated');
        expect(deleteStaleMediaFileSpy).not.toHaveBeenCalled();
        expect(recordFileScanIssueSpy).not.toHaveBeenCalledWith(
            expect.anything(),
            expect.objectContaining({ type: 'playlist_container_rejected' }),
        );
        expect(onFileContentChangedSpy).toHaveBeenCalled();
    });

    // Ruling T7-probe-outcomes (fix round 3): genuinely invalid data never
    // tombstones; it invalidates the probe data, THEN records
    // container_unreadable (the invalidation sets health_issues = NULL), THEN
    // commits the hash.
    it('invalid data on a content-changed file: invalidate, then record container_unreadable, then commit', async () => {
        detectFileChangesSpy.mockResolvedValueOnce({
            status: 'content-changed',
            fileStat: { mtime: new Date(), size: 200 },
            currentHash: 'new-hash',
        });
        probeMediaFileSpy.mockResolvedValue({
            success: false,
            error: 'Movie.mkv: Invalid data found when processing input',
            failureKind: 'invalid-data',
        });

        const outcome = await run(PRIMARY, linkedKnownFile(PRIMARY));

        expect(outcome).toBe('updated');
        expect(deleteStaleMediaFileSpy).not.toHaveBeenCalled();
        expect(recordDecodeHealthIssueSpy).toHaveBeenCalledWith(
            expect.anything(),
            expect.objectContaining({ fileId: 'existing-file-uuid', type: 'container_unreadable' }),
        );
        expect(recordFileScanIssueSpy).not.toHaveBeenCalled();
        const invalidatedAt = onFileContentChangedSpy.mock.invocationCallOrder[0]!;
        const recordedAt = recordDecodeHealthIssueSpy.mock.invocationCallOrder[0]!;
        const committedAt = updateFileStatSpy.mock.invocationCallOrder[0]!;
        expect(invalidatedAt).toBeLessThan(recordedAt);
        expect(recordedAt).toBeLessThan(committedAt);
    });

    // Important-A: an aborted probe writes nothing — above all not the new
    // hash, which would make the next scan see 'unchanged' and never re-run
    // the refusal.
    it('an aborted probe on a content-changed file writes no stat, no hash and no issue', async () => {
        detectFileChangesSpy.mockResolvedValueOnce({
            status: 'content-changed',
            fileStat: { mtime: new Date(), size: 200 },
            currentHash: 'new-hash',
        });
        probeMediaFileSpy.mockResolvedValue({
            success: false,
            error: 'The operation was aborted',
            failureKind: 'aborted',
        });

        const outcome = await run(PRIMARY, linkedKnownFile(PRIMARY));

        expect(outcome).toBe('skipped');
        expect(onFileContentChangedSpy).not.toHaveBeenCalled();
        expect(updateFileStatSpy).not.toHaveBeenCalled();
        expect(recordDecodeHealthIssueSpy).not.toHaveBeenCalled();
        expect(deleteStaleMediaFileSpy).not.toHaveBeenCalled();
    });

    it('a transient probe failure on a content-changed file writes no stat, no hash and no issue', async () => {
        detectFileChangesSpy.mockResolvedValueOnce({
            status: 'content-changed',
            fileStat: { mtime: new Date(), size: 200 },
            currentHash: 'new-hash',
        });
        probeMediaFileSpy.mockResolvedValue({
            success: false,
            error: 'Command failed: ffprobe',
            failureKind: 'transient',
        });

        const outcome = await run(PRIMARY, linkedKnownFile(PRIMARY));

        expect(outcome).toBe('error');
        expect(onFileContentChangedSpy).not.toHaveBeenCalled();
        expect(updateFileStatSpy).not.toHaveBeenCalled();
        expect(recordDecodeHealthIssueSpy).not.toHaveBeenCalled();
    });
});

// The scan's abortSignal must reach the ffprobe child on BOTH of
// processVideoFile's probe paths — dropping the argument at either call
// site turns one of these RED.
describe('processVideoFile — abort signal reaches the probe', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        probeMediaFileSpy.mockResolvedValue({ success: true, duration: 120, container: null });
        getFileScanRetryAtSpy.mockResolvedValue(null);
        isFileLinkedToMediaItemSpy.mockResolvedValue(false);
        findMediaFileByPathSpy.mockResolvedValue(null);
        upsertMediaFileSpy.mockResolvedValue({ id: 'new-file-uuid', created: true });
        findParentMediaItemByFolderSpy.mockResolvedValue(null);
        onFileContentChangedSpy.mockResolvedValue({ invalidatedMediaItemIds: [] });
    });

    it('content-changed path', async () => {
        detectFileChangesSpy.mockResolvedValueOnce({
            status: 'content-changed',
            fileStat: { mtime: new Date(), size: 200 },
            currentHash: 'new-hash',
        });
        const controller = new AbortController();

        await run(PRIMARY, linkedKnownFile(PRIMARY), controller.signal);

        expect(probeMediaFileSpy).toHaveBeenCalledWith(PRIMARY, undefined, {
            chapters: true,
            signal: controller.signal,
        });
    });

    it('new-file path', async () => {
        const controller = new AbortController();

        await run(PRIMARY, undefined, controller.signal);

        expect(probeMediaFileSpy).toHaveBeenCalledWith(PRIMARY, undefined, {
            chapters: true,
            signal: controller.signal,
        });
    });
});

// M2 seam: a previously-refused STUB row that now probes ok must have its
// refusal badge cleared by processVideoFile itself — deleting the
// clearStaleRefusalAndEnsureChangeDetection call site turns this RED.
describe('processVideoFile — clears a stale refusal on re-ingest (M2 seam)', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        probeMediaFileSpy.mockResolvedValue({
            success: true,
            duration: 120,
            container: 'matroska,webm',
        });
        getFileScanRetryAtSpy.mockResolvedValue(null);
        isFileLinkedToMediaItemSpy.mockResolvedValue(false);
        upsertMediaFileSpy.mockResolvedValue({ id: 'stub-file-uuid', created: false });
        findParentMediaItemByFolderSpy.mockResolvedValue(null);
    });

    it('clears unsafe_filename / playlist_container_rejected on an unlinked stub that now probes ok', async () => {
        const stub = new Map<string, KnownFileRow>([
            [
                PRIMARY,
                {
                    id: 'stub-file-uuid',
                    file_path: PRIMARY,
                    file_mtime: null,
                    file_size_bytes: null,
                    file_hash_head: null,
                    health_issues: null,
                    is_linked: false,
                },
            ],
        ]);

        await run(PRIMARY, stub);

        expect(clearFileScanIssueSpy).toHaveBeenCalledWith(expect.anything(), PRIMARY, [
            'unsafe_filename',
            'playlist_container_rejected',
        ]);
    });

    // Control: a refused file never reaches the clear.
    it('control: a file refused as playlist-class is not cleared', async () => {
        probeMediaFileSpy.mockResolvedValue({ success: true, duration: 5, container: 'hls' });
        findMediaFileByPathSpy.mockResolvedValue(null);

        await run(PRIMARY);

        expect(clearFileScanIssueSpy).not.toHaveBeenCalled();
    });
});
