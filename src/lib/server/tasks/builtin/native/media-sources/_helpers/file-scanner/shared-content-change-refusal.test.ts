// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Unit tests for the probe-outcome table in shared.ts (ruling
 * T7-probe-outcomes): `probeFileForScan`, `probeNewFileForScan` and
 * `applyContentChange`. `processVideoFile` and `processExtra` both route
 * through these, so each outcome row is pinned here once, at the source —
 * what is written, what is not, and in which order.
 */

import { describe, it, expect, vi, beforeEach, beforeAll, afterAll } from 'vitest';
import type postgres from 'postgres';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const {
    calls,
    mockProbeMediaFile,
    mockDeleteStaleMediaFile,
    mockRecordFileScanIssue,
    mockGetFileScanRetryAt,
    mockRecordDecodeHealthIssue,
    mockUpdateFileStat,
    mockOnFileContentChanged,
} = vi.hoisted(() => {
    const calls: string[] = [];
    const logged = (name: string, value?: unknown) => async (): Promise<unknown> => {
        calls.push(name);
        return value;
    };
    return {
        calls,
        mockProbeMediaFile: vi.fn(),
        mockDeleteStaleMediaFile: vi.fn(logged('deleteStaleMediaFile', { deleted: true })),
        mockRecordFileScanIssue: vi.fn(logged('recordFileScanIssue', {})),
        mockGetFileScanRetryAt: vi.fn(async () => null),
        mockRecordDecodeHealthIssue: vi.fn(logged('recordDecodeHealthIssue')),
        mockUpdateFileStat: vi.fn(logged('updateFileStat')),
        mockOnFileContentChanged: vi.fn(
            logged('onFileContentChanged', { invalidatedMediaItemIds: ['item-1'] }),
        ),
    };
});

vi.mock('../../../../../../utils/ffprobe.js', () => ({
    probeMediaFile: mockProbeMediaFile,
}));

vi.mock('../../../../../../database/queries/media-files.queries.js', () => ({
    updateFileStat: mockUpdateFileStat,
    deleteStaleMediaFile: mockDeleteStaleMediaFile,
    recordFileScanIssue: mockRecordFileScanIssue,
    getFileScanRetryAt: mockGetFileScanRetryAt,
    recordDecodeHealthIssue: mockRecordDecodeHealthIssue,
    clearFileScanIssue: vi.fn(),
    clearUnlinkedFileScanIssue: vi.fn(),
}));

// The file-head reader runs for real (temp files below); wrapped only so a
// test can make it fail the way a dying disk does.
vi.mock('$lib/server/utils/playlist-sniff.js', async (importOriginal) => {
    const actual = await importOriginal<typeof import('$lib/server/utils/playlist-sniff.js')>();
    return { ...actual, sniffFileForPlaylist: vi.fn(actual.sniffFileForPlaylist) };
});

vi.mock('../../../../../../services/media-lifecycle.service.js', () => ({
    MediaLifecycleService: { onFileContentChanged: mockOnFileContentChanged },
}));

import { applyContentChange, probeFileForScan, probeNewFileForScan } from './shared.js';
import { sniffFileForPlaylist } from '$lib/server/utils/playlist-sniff.js';

const sql = {} as unknown as postgres.Sql;
const context = {
    sql,
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
} as never;

const FILE_ID = 'file-uuid-1';
const FILE_PATH = '/data/movies/Movie.mkv';
const FILE = { id: FILE_ID, filePath: FILE_PATH, libraryGroupId: null };
const STAT = { mtime: new Date('2026-09-26T10:00:00Z'), size: 200, hash: 'new-hash' };

const OK = { success: true, container: 'matroska,webm' };
const PLAYLIST = { success: true, container: 'concat' };
const ABORTED = { success: false, error: 'The operation was aborted', failureKind: 'aborted' };
const INVALID = {
    success: false,
    error: 'Movie.mkv: Invalid data found when processing input',
    failureKind: 'invalid-data',
};
const TRANSIENT = { success: false, error: 'Command failed: ffprobe', failureKind: 'transient' };

beforeEach(() => {
    vi.clearAllMocks();
    calls.length = 0;
});

describe('probeFileForScan', () => {
    it.each([
        ['ok', OK, 'ok'],
        ['a playlist-class container', PLAYLIST, 'refused'],
        ['an aborted probe', ABORTED, 'aborted'],
        ['an invalid-data failure', INVALID, 'failed'],
        ['a transient failure', TRANSIENT, 'failed'],
    ])('maps %s to %s', async (_label, probe, kind) => {
        mockProbeMediaFile.mockResolvedValue(probe);
        expect((await probeFileForScan(FILE_PATH)).kind).toBe(kind);
    });

    it('keeps the invalid-data / transient split on a failure', async () => {
        mockProbeMediaFile.mockResolvedValue(INVALID);
        expect(await probeFileForScan(FILE_PATH)).toMatchObject({ failure: 'invalid-data' });
        mockProbeMediaFile.mockResolvedValue(TRANSIENT);
        expect(await probeFileForScan(FILE_PATH)).toMatchObject({ failure: 'transient' });
    });

    // A failure with no classification must land on the side that links
    // nothing and commits nothing.
    it('treats an unclassified failure as transient', async () => {
        mockProbeMediaFile.mockResolvedValue({ success: false, error: 'boom' });
        expect(await probeFileForScan(FILE_PATH)).toMatchObject({
            kind: 'failed',
            failure: 'transient',
        });
    });

    it('forwards the abortSignal into probeMediaFile', async () => {
        mockProbeMediaFile.mockResolvedValue(OK);
        const controller = new AbortController();
        await probeFileForScan(FILE_PATH, controller.signal);
        expect(mockProbeMediaFile).toHaveBeenCalledWith(FILE_PATH, undefined, {
            chapters: true,
            signal: controller.signal,
        });
    });

    // Control: no signal given → no signal option, so the assertion above is
    // about forwarding, not a hard-coded value.
    it('passes no signal option when no abortSignal is given', async () => {
        mockProbeMediaFile.mockResolvedValue(OK);
        await probeFileForScan(FILE_PATH);
        expect(mockProbeMediaFile).toHaveBeenCalledWith(FILE_PATH, undefined, { chapters: true });
    });
});

describe('probeNewFileForScan', () => {
    it('records playlist_container_rejected for a refused file', async () => {
        mockProbeMediaFile.mockResolvedValue(PLAYLIST);
        const outcome = await probeNewFileForScan(sql, FILE_PATH, 'group-1', context);
        expect(outcome.kind).toBe('refused');
        expect(mockRecordFileScanIssue).toHaveBeenCalledWith(
            sql,
            expect.objectContaining({
                filePath: FILE_PATH,
                libraryGroupId: 'group-1',
                type: 'playlist_container_rejected',
            }),
        );
    });

    it.each([
        ['ok', OK],
        ['aborted', ABORTED],
        ['transient', TRANSIENT],
    ])('records nothing for %s', async (_label, probe) => {
        mockProbeMediaFile.mockResolvedValue(probe);
        await probeNewFileForScan(sql, FILE_PATH, null, context);
        expect(calls).toEqual([]);
    });

    // A verdict on the bytes: recorded on the stub row so the file backs off
    // (the retry tiers and the cooldown are covered end to end in
    // new-file-probe-backoff.integration.test.ts).
    it('records container_unreadable for invalid data', async () => {
        mockProbeMediaFile.mockResolvedValue(INVALID);
        await probeNewFileForScan(sql, FILE_PATH, 'group-1', context);
        expect(mockRecordFileScanIssue).toHaveBeenCalledWith(
            sql,
            expect.objectContaining({
                filePath: FILE_PATH,
                libraryGroupId: 'group-1',
                type: 'container_unreadable',
            }),
        );
    });
});

describe('applyContentChange — one row per probe outcome', () => {
    it('refused: retires the row and records the refusal, never invalidating or committing', async () => {
        mockProbeMediaFile.mockResolvedValue(PLAYLIST);
        const outcome = await applyContentChange(sql, FILE, STAT, context);
        expect(outcome).toEqual({ kind: 'refused' });
        expect(calls).toEqual(['deleteStaleMediaFile', 'recordFileScanIssue']);
        expect(mockDeleteStaleMediaFile).toHaveBeenCalledWith(sql, FILE_PATH);
    });

    // Important-A: an aborted probe must write NOTHING — above all not the
    // new hash, or the next scan sees 'unchanged' and never re-runs the
    // refusal.
    it('aborted: writes no stat, no hash, no issue', async () => {
        mockProbeMediaFile.mockResolvedValue(ABORTED);
        const outcome = await applyContentChange(sql, FILE, STAT, context);
        expect(outcome).toEqual({ kind: 'aborted' });
        expect(calls).toEqual([]);
    });

    it('transient failure: writes no stat, no hash, no issue', async () => {
        mockProbeMediaFile.mockResolvedValue(TRANSIENT);
        const outcome = await applyContentChange(sql, FILE, STAT, context);
        expect(outcome).toEqual({ kind: 'retry-next-scan' });
        expect(calls).toEqual([]);
    });

    // Important-B: the issue is written AFTER the invalidation (which sets
    // health_issues = NULL), then the hash is committed.
    it('invalid data: invalidates, THEN records container_unreadable, THEN commits the hash', async () => {
        mockProbeMediaFile.mockResolvedValue(INVALID);
        const outcome = await applyContentChange(sql, FILE, STAT, context);
        expect(outcome).toEqual({
            kind: 'committed',
            readable: false,
            invalidatedMediaItemIds: ['item-1'],
        });
        expect(calls).toEqual([
            'onFileContentChanged',
            'recordDecodeHealthIssue',
            'updateFileStat',
        ]);
        expect(mockRecordDecodeHealthIssue).toHaveBeenCalledWith(sql, {
            fileId: FILE_ID,
            type: 'container_unreadable',
            detail: expect.stringContaining('Invalid data found'),
        });
        expect(mockUpdateFileStat).toHaveBeenCalledWith(sql, FILE_ID, STAT.mtime, 200, 'new-hash');
        expect(mockDeleteStaleMediaFile).not.toHaveBeenCalled();
    });

    // Control: a readable content change invalidates and commits, records no
    // issue, retires nothing.
    it('ok: invalidates and commits the hash, records no issue', async () => {
        mockProbeMediaFile.mockResolvedValue(OK);
        const outcome = await applyContentChange(sql, FILE, STAT, context);
        expect(outcome).toEqual({
            kind: 'committed',
            readable: true,
            invalidatedMediaItemIds: ['item-1'],
        });
        expect(calls).toEqual(['onFileContentChanged', 'updateFileStat']);
    });

    it('forwards the abortSignal into the probe', async () => {
        mockProbeMediaFile.mockResolvedValue(OK);
        const controller = new AbortController();
        await applyContentChange(sql, FILE, STAT, context, controller.signal);
        expect(mockProbeMediaFile).toHaveBeenCalledWith(FILE_PATH, undefined, {
            chapters: true,
            signal: controller.signal,
        });
    });
});

// Ruling T7-probe-outcomes-2 (fix round 4): the file head is sniffed for
// playlist/manifest magic before, and independent of, ffprobe.
describe('probeFileForScan — content sniff', () => {
    let dir: string;
    beforeAll(async () => {
        dir = await mkdtemp(join(tmpdir(), 'lumastra-sniff-shared-'));
    });
    afterAll(async () => {
        await rm(dir, { recursive: true, force: true });
    });

    it.each([
        ['ffconcat', 'ffconcat version 1.0\nfile v.m3u8\n'],
        ['hls', '#EXTM3U\n#EXT-X-TARGETDURATION:2\n#EXTINF:2,\nnotyet.mkv\n'],
        ['bare concat', "file '/other/library/secret.mkv'\n"],
    ])('%s body: refused without asking ffprobe', async (_label, body) => {
        const p = join(dir, `${_label.replace(/ /g, '-')}.mkv`);
        await writeFile(p, body);
        mockProbeMediaFile.mockResolvedValue(OK);

        expect((await probeFileForScan(p)).kind).toBe('refused');
        expect(mockProbeMediaFile).not.toHaveBeenCalled();
    });

    it('a content-changed linked file with an HLS body is retired', async () => {
        const p = join(dir, 'linked.mkv');
        await writeFile(p, '#EXTM3U\n#EXT-X-TARGETDURATION:2\n');
        const outcome = await applyContentChange(sql, { ...FILE, filePath: p }, STAT, context);
        expect(outcome).toEqual({ kind: 'refused' });
        expect(calls).toEqual(['deleteStaleMediaFile', 'recordFileScanIssue']);
    });

    it('a reference-demuxer probe failure is refused', async () => {
        mockProbeMediaFile.mockResolvedValue({
            success: false,
            error: "[concat @ 0x1] Impossible to open 'v.m3u8'",
            failureKind: 'reference-demuxer',
        });
        expect((await probeFileForScan(FILE_PATH)).kind).toBe('refused');
    });

    it('an EIO reading the head is transient and never reaches ffprobe', async () => {
        vi.mocked(sniffFileForPlaylist).mockRejectedValueOnce(
            Object.assign(new Error('EIO: i/o error, read'), { code: 'EIO' }),
        );
        expect(await probeFileForScan(FILE_PATH)).toMatchObject({
            kind: 'failed',
            failure: 'transient',
        });
        expect(mockProbeMediaFile).not.toHaveBeenCalled();
    });

    // ENOENT keeps the pre-sniff path: ffprobe reports the missing file and
    // processVideoFile's stale-row cleanup keys off that.
    it('ENOENT reading the head falls through to ffprobe', async () => {
        mockProbeMediaFile.mockResolvedValue(TRANSIENT);
        await probeFileForScan(join(dir, 'missing.mkv'));
        expect(mockProbeMediaFile).toHaveBeenCalled();
    });

    it('an already-aborted scan neither sniffs nor probes', async () => {
        const controller = new AbortController();
        controller.abort();
        expect((await probeFileForScan(FILE_PATH, controller.signal)).kind).toBe('aborted');
        expect(sniffFileForPlaylist).not.toHaveBeenCalled();
        expect(mockProbeMediaFile).not.toHaveBeenCalled();
    });

    // Control: a text file that merely mentions "file" mid-line is not a
    // concat script; ffprobe decides.
    it('control: a non-playlist text body is left to ffprobe', async () => {
        const p = join(dir, 'notes.mkv');
        await writeFile(p, 'this profile mentions file somewhere\n');
        mockProbeMediaFile.mockResolvedValue(INVALID);
        expect(await probeFileForScan(p)).toMatchObject({
            kind: 'failed',
            failure: 'invalid-data',
        });
        expect(mockProbeMediaFile).toHaveBeenCalled();
    });
});
