// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * F1b (fix plan 6, Task 7 fix round 1): `processExtra` ingests an extra
 * (trailer/featurette/etc.) via its own path — `upsertMediaFile` +
 * `attachFileToItem` below — that never ran either of `processVideoFile`'s
 * guards: the control-character filename check (`hasControlChars()`) and
 * the playlist-class probed-container check (`isPlaylistClassContainer()`).
 * This suite proves both are now applied through the SAME shared helpers,
 * before the file is ever linked to a media item.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type postgres from 'postgres';

const {
    mockIsFileLinkedToMediaItem,
    mockFindParentMediaItemByFolder,
    mockFindRootMediaItemByFolderRecursive,
    mockFindMediaItemByFilePath,
    mockFindMediaFileByPath,
    mockUpsertMediaFile,
    mockAttachFileToItem,
    mockRecordFileScanIssue,
    mockGetFileScanRetryAt,
    mockClearFileScanIssue,
    mockRecordDecodeHealthIssue,
    mockDeleteStaleMediaFile,
    mockInsertExtraMediaItem,
    mockFindLibraryGroupForItemTree,
    mockProbeMediaFile,
    mockDetectFileChanges,
    mockUpdateFileStat,
    mockOnFileContentChanged,
} = vi.hoisted(() => ({
    mockIsFileLinkedToMediaItem: vi.fn(),
    mockFindParentMediaItemByFolder: vi.fn(),
    mockFindRootMediaItemByFolderRecursive: vi.fn(),
    mockFindMediaItemByFilePath: vi.fn(),
    mockFindMediaFileByPath: vi.fn(),
    mockUpsertMediaFile: vi.fn(),
    mockAttachFileToItem: vi.fn(),
    mockRecordFileScanIssue: vi.fn(),
    mockGetFileScanRetryAt: vi.fn(),
    mockClearFileScanIssue: vi.fn(),
    mockRecordDecodeHealthIssue: vi.fn(),
    mockDeleteStaleMediaFile: vi.fn(),
    mockInsertExtraMediaItem: vi.fn(),
    mockFindLibraryGroupForItemTree: vi.fn(),
    mockProbeMediaFile: vi.fn(),
    mockDetectFileChanges: vi.fn(),
    mockUpdateFileStat: vi.fn(),
    mockOnFileContentChanged: vi.fn(),
}));

vi.mock('../../../../../../database/queries/media-files.queries.js', () => ({
    upsertMediaFile: mockUpsertMediaFile,
    attachFileToItem: mockAttachFileToItem,
    touchLibraryAddedAt: vi.fn().mockResolvedValue(undefined),
    isFileLinkedToMediaItem: mockIsFileLinkedToMediaItem,
    findParentMediaItemByFolder: mockFindParentMediaItemByFolder,
    findMediaItemByFilePath: mockFindMediaItemByFilePath,
    findSeasonParentIfEpisode: vi.fn(),
    findMediaFileByPath: mockFindMediaFileByPath,
    findArtistByChildFolder: vi.fn(),
    findRootMediaItemByFolderRecursive: mockFindRootMediaItemByFolderRecursive,
    findTvSeriesByFolderWithSeasonDirectory: vi.fn(),
    loadMediaFileIdsByPrefix: vi.fn(),
    updateFileStat: mockUpdateFileStat,
    recordFileScanIssue: mockRecordFileScanIssue,
    getFileScanRetryAt: mockGetFileScanRetryAt,
    clearFileScanIssue: mockClearFileScanIssue,
    clearUnlinkedFileScanIssue: vi.fn().mockResolvedValue(undefined),
    recordDecodeHealthIssue: mockRecordDecodeHealthIssue,
    deleteStaleMediaFile: mockDeleteStaleMediaFile,
}));

vi.mock('../../../../../../database/queries/media-items.queries.js', () => ({
    insertExtraMediaItem: mockInsertExtraMediaItem,
    findSeasonByNumber: vi.fn(),
}));

vi.mock('../../../../../../database/queries/media-artwork.queries.js', () => ({
    upsertLocalArtworkWithOutcome: vi.fn(),
    findManagedArtworkClaimForPath: vi.fn(),
}));

vi.mock('../../../../../../database/queries/external-subtitles.queries.js', () => ({
    upsertExternalSubtitle: vi.fn(),
    loadExternalSubtitlesByPrefix: vi.fn(),
}));

vi.mock('../../../../../../database/queries/media-item-languages.queries.js', () => ({
    refreshLanguagesForFile: vi.fn(),
}));

vi.mock('../../../../../../database/queries/media-extras.queries.js', () => ({
    findLibraryGroupForItemTree: mockFindLibraryGroupForItemTree,
}));

vi.mock('../../../../../../database/with-tx.js', () => ({
    withTx: (s: unknown, fn: (tx: unknown) => Promise<unknown>) => fn(s),
}));

vi.mock('$lib/server/utils/safe-fs.js', () => ({
    safeReaddir: vi.fn(),
    safeStat: vi.fn(),
    // The head sniff (playlist-container.ts) reads through the guard; run it
    // straight through so the sniff sees the real (missing) test paths.
    withFsGuard: (factory: () => Promise<unknown>) => factory(),
}));

vi.mock('./shared.js', async (importOriginal) => {
    const actual = await importOriginal<typeof import('./shared.js')>();
    return {
        ...actual,
        initFileChangeDetection: vi.fn().mockResolvedValue(undefined),
    };
});

vi.mock('../../../../../../services/media-lifecycle.service.js', () => ({
    MediaLifecycleService: { onFileContentChanged: mockOnFileContentChanged },
}));

vi.mock('./change-detection.js', () => ({
    detectFileChanges: mockDetectFileChanges,
}));

vi.mock('../../../../../../utils/ffprobe.js', () => ({
    probeMediaFile: mockProbeMediaFile,
}));

vi.mock('../../../../../../utils/filename-parser.js', () => ({
    parseMediaFilename: vi.fn().mockReturnValue({ title: 'Trailer' }),
    parseSubtitleFilename: vi.fn(),
}));

import { processExtra } from './ancillary-processors.js';
import type { ExtraEntry } from '../../../../../../utils/walk-directory.js';

const sql = {} as unknown as postgres.Sql;
const context = {
    sql,
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
} as never;

const PARENT_ID = 'aaaaaaaa-0000-0000-0000-00000000000a';
const NORMAL_ENTRY: ExtraEntry = {
    filePath: '/data/movies/Cinderella/Cinderella-trailer.mkv',
    extraType: 'trailer',
    parentFolder: '/data/movies/Cinderella',
};

beforeEach(() => {
    vi.clearAllMocks();
    mockIsFileLinkedToMediaItem.mockResolvedValue(false);
    // I1 (fix round 2): the "not previously registered" fast path now goes
    // through findMediaFileByPath FIRST — null means "no stub row exists",
    // so every existing (pre-I1) test in this file keeps exercising the
    // genuinely-new-file path unchanged.
    mockFindMediaFileByPath.mockResolvedValue(null);
    mockClearFileScanIssue.mockResolvedValue(undefined);
    mockRecordDecodeHealthIssue.mockResolvedValue(undefined);
    mockDeleteStaleMediaFile.mockResolvedValue({ deleted: true });
    mockDetectFileChanges.mockResolvedValue({ status: 'unchanged' });
    mockFindMediaItemByFilePath.mockResolvedValue(null);
    mockFindParentMediaItemByFolder.mockResolvedValue(PARENT_ID);
    mockFindRootMediaItemByFolderRecursive.mockResolvedValue(null);
    mockInsertExtraMediaItem.mockResolvedValue('extra-uuid');
    mockFindLibraryGroupForItemTree.mockResolvedValue('group-uuid');
    mockUpsertMediaFile.mockResolvedValue({ id: 'extra-file-uuid', created: true });
    mockAttachFileToItem.mockResolvedValue(undefined);
    mockRecordFileScanIssue.mockResolvedValue({});
    mockGetFileScanRetryAt.mockResolvedValue(null);
    mockProbeMediaFile.mockResolvedValue({ success: true, duration: 5, container: null });
    mockUpdateFileStat.mockResolvedValue(undefined);
    mockOnFileContentChanged.mockResolvedValue({ invalidatedMediaItemIds: ['extra-uuid'] });
});

describe('processExtra — control-character filename guard (F1b)', () => {
    it('skips an extra whose filename contains a control character, recording a scan issue', async () => {
        const entry: ExtraEntry = {
            ...NORMAL_ENTRY,
            filePath: "/data/movies/Cinderella/Cinderella-trailer\nfile '/tmp/x'.mkv",
        };

        const outcome = await processExtra(sql, entry, context);

        expect(outcome).toBe('skipped');
        expect(mockRecordFileScanIssue).toHaveBeenCalledWith(
            expect.anything(),
            expect.objectContaining({ type: 'unsafe_filename' }),
        );
        expect(mockUpsertMediaFile).not.toHaveBeenCalled();
        expect(mockAttachFileToItem).not.toHaveBeenCalled();
    });

    // Control: a normal extra filename is unaffected.
    it('ingests a normal extra filename', async () => {
        const outcome = await processExtra(sql, NORMAL_ENTRY, context);

        expect(outcome).toBe('added');
        expect(mockRecordFileScanIssue).not.toHaveBeenCalled();
        expect(mockUpsertMediaFile).toHaveBeenCalled();
    });
});

describe('processExtra — playlist-class probed container guard (F1b)', () => {
    it.each(['hls', 'dash', 'concat', 'imf'])(
        'skips an extra probing as %s, recording a scan issue and never linking it',
        async (container) => {
            mockProbeMediaFile.mockResolvedValue({ success: true, duration: 5, container });

            const outcome = await processExtra(sql, NORMAL_ENTRY, context);

            expect(outcome).toBe('skipped');
            expect(mockRecordFileScanIssue).toHaveBeenCalledWith(
                expect.anything(),
                expect.objectContaining({ type: 'playlist_container_rejected' }),
            );
            expect(mockUpsertMediaFile).not.toHaveBeenCalled();
            expect(mockAttachFileToItem).not.toHaveBeenCalled();
        },
    );

    // Control: a real container is unaffected.
    it('ingests an extra probing as a real container', async () => {
        mockProbeMediaFile.mockResolvedValue({
            success: true,
            duration: 5,
            container: 'mov,mp4,m4a,3gp,3g2,mj2',
        });

        const outcome = await processExtra(sql, NORMAL_ENTRY, context);

        expect(outcome).toBe('added');
        expect(mockRecordFileScanIssue).not.toHaveBeenCalled();
        expect(mockUpsertMediaFile).toHaveBeenCalled();
    });
});

// I1 (fix plan 6, Task 7 fix round 2): a LINKED extra used to short-circuit
// to 'skipped' with NO content-change detection at all. This suite proves it
// now gets the same detectFileChanges the main-file path uses, and — on a
// genuine content change — the SAME shared applyContentChange helper
// video-processor.ts's content-changed branch uses (fix round 3: one outcome
// table for both).
describe('processExtra — linked extra content-change detection (I1, fix round 2)', () => {
    const LINKED_FILE_ID = 'linked-extra-file-uuid';
    const linkedRow = {
        id: LINKED_FILE_ID,
        file_path: NORMAL_ENTRY.filePath,
        file_mtime: new Date('2020-01-01'),
        file_size_bytes: 1000,
        file_hash_head: 'old-hash',
        library_group_id: null,
        health_issues: null,
    };

    beforeEach(() => {
        mockFindMediaFileByPath.mockResolvedValue(linkedRow);
        mockIsFileLinkedToMediaItem.mockResolvedValue(true);
    });

    it('retires an already-linked extra whose content changed into a playlist-class container (reviewer repro)', async () => {
        mockDetectFileChanges.mockResolvedValue({
            status: 'content-changed',
            fileStat: { mtime: new Date(), size: 200 },
            currentHash: 'new-hash',
        });
        mockProbeMediaFile.mockResolvedValue({ success: true, duration: 5, container: 'concat' });

        const outcome = await processExtra(sql, NORMAL_ENTRY, context);

        expect(outcome).toBe('skipped');
        expect(mockDeleteStaleMediaFile).toHaveBeenCalledWith(
            expect.anything(),
            NORMAL_ENTRY.filePath,
        );
        expect(mockRecordFileScanIssue).toHaveBeenCalledWith(
            expect.anything(),
            expect.objectContaining({ type: 'playlist_container_rejected' }),
        );
    });

    // Control: a benign content change (real container) leaves the extra linked.
    it('a benign content change on a linked extra stays linked (control)', async () => {
        mockDetectFileChanges.mockResolvedValue({
            status: 'content-changed',
            fileStat: { mtime: new Date(), size: 200 },
            currentHash: 'new-hash',
        });
        mockProbeMediaFile.mockResolvedValue({
            success: true,
            duration: 5,
            container: 'mov,mp4,m4a,3gp,3g2,mj2',
        });

        const outcome = await processExtra(sql, NORMAL_ENTRY, context);

        expect(outcome).toBe('skipped'); // processExtra has no 'updated' outcome
        expect(mockDeleteStaleMediaFile).not.toHaveBeenCalled();
        expect(mockRecordFileScanIssue).not.toHaveBeenCalled();
    });

    // Minor (fix round 3): an extra's content change invalidates its probe
    // data exactly like the main path, so a stale container_format cannot
    // hide it from the operator queries.
    it('a content change on a linked extra invalidates its probe data before committing the hash', async () => {
        mockDetectFileChanges.mockResolvedValue({
            status: 'content-changed',
            fileStat: { mtime: new Date(), size: 200 },
            currentHash: 'new-hash',
        });
        mockProbeMediaFile.mockResolvedValue({
            success: true,
            duration: 5,
            container: 'mov,mp4,m4a,3gp,3g2,mj2',
        });

        await processExtra(sql, NORMAL_ENTRY, context);

        expect(mockOnFileContentChanged).toHaveBeenCalledWith(
            expect.anything(),
            LINKED_FILE_ID,
            NORMAL_ENTRY.filePath,
        );
        expect(mockUpdateFileStat).toHaveBeenCalledWith(
            expect.anything(),
            LINKED_FILE_ID,
            expect.any(Date),
            200,
            'new-hash',
        );
        expect(mockOnFileContentChanged.mock.invocationCallOrder[0]!).toBeLessThan(
            mockUpdateFileStat.mock.invocationCallOrder[0]!,
        );
    });

    // Ruling T7-probe-outcomes: invalid data never tombstones — invalidate,
    // then record container_unreadable, then commit.
    it('invalid data on a content-changed extra is recorded as a decode issue after the invalidation, never tombstoned', async () => {
        mockDetectFileChanges.mockResolvedValue({
            status: 'content-changed',
            fileStat: { mtime: new Date(), size: 200 },
            currentHash: 'new-hash',
        });
        mockProbeMediaFile.mockResolvedValue({
            success: false,
            error: 'trailer.mkv: Invalid data found when processing input',
            failureKind: 'invalid-data',
        });

        const outcome = await processExtra(sql, NORMAL_ENTRY, context);

        expect(outcome).toBe('skipped');
        expect(mockDeleteStaleMediaFile).not.toHaveBeenCalled();
        expect(mockRecordDecodeHealthIssue).toHaveBeenCalledWith(
            expect.anything(),
            expect.objectContaining({ fileId: LINKED_FILE_ID, type: 'container_unreadable' }),
        );
        expect(mockRecordFileScanIssue).not.toHaveBeenCalled();
        expect(mockOnFileContentChanged.mock.invocationCallOrder[0]!).toBeLessThan(
            mockRecordDecodeHealthIssue.mock.invocationCallOrder[0]!,
        );
    });

    it.each([
        [
            'aborted',
            { success: false, error: 'The operation was aborted', failureKind: 'aborted' },
            'skipped',
        ],
        [
            'transient',
            { success: false, error: 'Command failed', failureKind: 'transient' },
            'error',
        ],
    ])(
        'a %s probe on a content-changed extra writes no stat, no hash and no issue',
        async (_label, probe, expected) => {
            mockDetectFileChanges.mockResolvedValue({
                status: 'content-changed',
                fileStat: { mtime: new Date(), size: 200 },
                currentHash: 'new-hash',
            });
            mockProbeMediaFile.mockResolvedValue(probe);

            const outcome = await processExtra(sql, NORMAL_ENTRY, context);

            expect(outcome).toBe(expected);
            expect(mockUpdateFileStat).not.toHaveBeenCalled();
            expect(mockOnFileContentChanged).not.toHaveBeenCalled();
            expect(mockRecordDecodeHealthIssue).not.toHaveBeenCalled();
            expect(mockDeleteStaleMediaFile).not.toHaveBeenCalled();
        },
    );

    it('forwards the abort signal into the content-change probe', async () => {
        mockDetectFileChanges.mockResolvedValue({
            status: 'content-changed',
            fileStat: { mtime: new Date(), size: 200 },
            currentHash: 'new-hash',
        });
        const controller = new AbortController();

        await processExtra(sql, NORMAL_ENTRY, context, controller.signal);

        expect(mockProbeMediaFile).toHaveBeenCalledWith(NORMAL_ENTRY.filePath, undefined, {
            chapters: true,
            signal: controller.signal,
        });
    });

    // Control: no content change at all — detectFileChanges is consulted but
    // the probe (and everything downstream of it) never runs.
    it('an unchanged linked extra never probes', async () => {
        mockDetectFileChanges.mockResolvedValue({ status: 'unchanged' });

        const outcome = await processExtra(sql, NORMAL_ENTRY, context);

        expect(outcome).toBe('skipped');
        expect(mockProbeMediaFile).not.toHaveBeenCalled();
        expect(mockDeleteStaleMediaFile).not.toHaveBeenCalled();
    });
});

// Important-C (fix round 3): a NEW extra is linked only when its probe came
// back ok — the same rule as a new main file.
describe('processExtra — a new extra whose probe did not return ok is never linked', () => {
    it.each([
        [
            'invalid-data',
            { success: false, error: 'Invalid data found', failureKind: 'invalid-data' },
            'error',
        ],
        [
            'transient',
            { success: false, error: 'Command failed', failureKind: 'transient' },
            'error',
        ],
        [
            'aborted',
            { success: false, error: 'The operation was aborted', failureKind: 'aborted' },
            'skipped',
        ],
    ])('%s', async (_label, probe, expected) => {
        mockProbeMediaFile.mockResolvedValue(probe);

        const outcome = await processExtra(sql, NORMAL_ENTRY, context);

        expect(outcome).toBe(expected);
        expect(mockUpsertMediaFile).not.toHaveBeenCalled();
        expect(mockAttachFileToItem).not.toHaveBeenCalled();
        expect(mockInsertExtraMediaItem).not.toHaveBeenCalled();
    });

    it('forwards the abort signal into the new-extra probe', async () => {
        const controller = new AbortController();

        await processExtra(sql, NORMAL_ENTRY, context, controller.signal);

        expect(mockProbeMediaFile).toHaveBeenCalledWith(NORMAL_ENTRY.filePath, undefined, {
            chapters: true,
            signal: controller.signal,
        });
    });
});

// M2 seam: processExtra clears a stale refusal through the shared
// clearStaleRefusalAndEnsureChangeDetection — deleting that call site turns
// this RED.
describe('processExtra — clears a stale refusal on re-ingest (M2 seam)', () => {
    it('clears unsafe_filename / playlist_container_rejected on an unlinked stub that now probes ok', async () => {
        mockFindMediaFileByPath.mockResolvedValue({
            id: 'stub-extra-uuid',
            file_path: NORMAL_ENTRY.filePath,
            file_mtime: null,
            file_size_bytes: null,
            file_hash_head: null,
            library_group_id: null,
            health_issues: [{ type: 'playlist_container_rejected' }],
        });
        mockIsFileLinkedToMediaItem.mockResolvedValue(false);

        const outcome = await processExtra(sql, NORMAL_ENTRY, context);

        expect(outcome).toBe('added');
        expect(mockClearFileScanIssue).toHaveBeenCalledWith(
            expect.anything(),
            NORMAL_ENTRY.filePath,
            ['unsafe_filename', 'playlist_container_rejected'],
        );
    });
});
