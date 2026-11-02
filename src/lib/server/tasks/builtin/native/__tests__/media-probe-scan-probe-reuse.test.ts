// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * One full ffprobe per new file during a library scan.
 *
 * The scanner probes every new file before linking it (`probeFileForScan`),
 * and media-probe Phase A used to probe the same file again seconds later
 * (preprod 2026-10-20: ~1.6 `ffprobe -show_streams -show_format` per new
 * episode). Phase A now reuses the scanner's result when the file's
 * `media_files` row still describes the bytes that were probed (same mtime and
 * size), and probes itself otherwise.
 *
 * Real files on disk for the stat; ffprobe and the DB writes are mocked.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, writeFile, stat, utimes } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type * as DrainBacklogModule from '../../../../plugins/runtime/drain-backlog.js';
import type * as FfprobeModule from '../../../../utils/ffprobe.js';
import type { MediaProbeResult } from '../../../../utils/ffprobe.js';
import type { TaskContext } from '@sapd/lumastra-plugin-sdk';

const { mockProbeMediaFile, mockProbeKeyframes } = vi.hoisted(() => ({
    mockProbeMediaFile: vi.fn(),
    mockProbeKeyframes: vi.fn(),
}));

vi.mock('../../../../utils/ffprobe.js', async (importOriginal) => {
    const actual = await importOriginal<typeof FfprobeModule>();
    return { ...actual, probeMediaFile: mockProbeMediaFile, probeKeyframes: mockProbeKeyframes };
});

const { mockUpdateProbeData } = vi.hoisted(() => ({ mockUpdateProbeData: vi.fn() }));

vi.mock('../../../../database/queries/media-files.queries.js', async (importOriginal) => {
    const actual = await importOriginal<Record<string, unknown>>();
    return { ...actual, updateProbeData: mockUpdateProbeData };
});

vi.mock('../../../../database/queries/media-streams.queries.js', () => ({
    replaceStreamsForFile: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../../../../database/queries/plugin-failure-events.queries.js', () => ({
    recordFailure: vi.fn().mockResolvedValue(undefined),
    getFailureAggregates: vi.fn().mockResolvedValue(new Map()),
}));

vi.mock('../../../../plugins/runtime/drain-backlog.js', async (importOriginal) => {
    const actual = await importOriginal<typeof DrainBacklogModule>();
    return { ...actual, drainBacklog: vi.fn() };
});

import { mediaProbeTask } from '../media-probe.js';
import { drainBacklog } from '../../../../plugins/runtime/drain-backlog.js';
import { probeFileForScan } from '../media-sources/_helpers/file-scanner/shared.js';
import { clearScanProbeCache } from '../../../../utils/scan-probe-cache.js';

const FILE_ID = '00000000-0000-0000-0000-0000000000a1';

function okProbe(container: string): MediaProbeResult {
    return {
        success: true,
        video: null,
        audioStreams: [],
        subtitleStreams: [],
        duration: 1320,
        container,
        fileSize: 4096,
        formatBitrate: 2_000_000,
    };
}

function makeCtx(): TaskContext<{ [x: string]: unknown }> {
    const sql = vi.fn((..._args: unknown[]) => Promise.resolve([])) as unknown as {
        begin: unknown;
        json: unknown;
    };
    sql.json = (v: unknown) => v;
    sql.begin = vi.fn((fn: (tx: unknown) => Promise<unknown>) => fn(sql));
    return {
        sql,
        logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
        signal: new AbortController().signal,
        input: { mode: 'catchup' },
        runId: 'scan-probe-reuse',
        reportProgress: vi.fn(),
    } as unknown as TaskContext<{ [x: string]: unknown }>;
}

/** Run media-probe with Phase A handed exactly `row`; Phase B gets nothing. */
async function runPhaseA(row: Record<string, unknown>): Promise<void> {
    let call = 0;
    vi.mocked(drainBacklog).mockImplementation(async (_ctx, options) => {
        call++;
        if (call === 1) await options.processSlice([row], new AbortController().signal);
        return { unitsProcessed: call === 1 ? 1 : 0, resultsProduced: 0, stopReason: 'drained' };
    });
    await mediaProbeTask.execute(makeCtx());
}

describe('media-probe Phase A reuses the scanner probe of a new file', () => {
    let root: string;
    let filePath: string;

    beforeEach(async () => {
        vi.clearAllMocks();
        clearScanProbeCache();
        mockUpdateProbeData.mockResolvedValue(undefined);
        root = await mkdtemp(join(tmpdir(), 'lumastra-scan-probe-reuse-'));
        filePath = join(root, 'Show S01E01.mkv');
        // Matroska EBML magic, so the playlist sniff reads the file as media.
        await writeFile(
            filePath,
            Buffer.concat([Buffer.from([0x1a, 0x45, 0xdf, 0xa3]), Buffer.alloc(4092)]),
        );
    });

    afterEach(async () => {
        await rm(root, { recursive: true, force: true });
    });

    async function rowAsScannerStoredIt(): Promise<Record<string, unknown>> {
        const s = await stat(filePath);
        return {
            id: FILE_ID,
            file_path: filePath,
            media_item_ids: [],
            file_mtime: s.mtime,
            file_size_bytes: s.size,
        };
    }

    it('probes a new, unchanged file once across the scanner and Phase A', async () => {
        mockProbeMediaFile.mockResolvedValue(okProbe('matroska,webm'));

        const outcome = await probeFileForScan(filePath);
        expect(outcome.kind).toBe('ok');
        await runPhaseA(await rowAsScannerStoredIt());

        expect(mockProbeMediaFile).toHaveBeenCalledTimes(1);
        expect(mockUpdateProbeData).toHaveBeenCalledOnce();
        expect(mockUpdateProbeData.mock.calls[0][1]).toMatchObject({
            fileId: FILE_ID,
            containerFormat: 'matroska,webm',
            durationSeconds: 1320,
        });
    });

    it('probes again when the row no longer matches the probed bytes', async () => {
        mockProbeMediaFile
            .mockResolvedValueOnce(okProbe('matroska,webm'))
            .mockResolvedValueOnce(okProbe('mov,mp4,m4a,3gp,3g2,mj2'));

        await probeFileForScan(filePath);
        // The file changed after the scanner probed it; the row says so.
        await utimes(filePath, new Date('2030-01-01'), new Date('2030-01-01'));
        await runPhaseA(await rowAsScannerStoredIt());

        expect(mockProbeMediaFile).toHaveBeenCalledTimes(2);
        expect(mockUpdateProbeData.mock.calls[0][1]).toMatchObject({
            containerFormat: 'mov,mp4,m4a,3gp,3g2,mj2',
        });
    });

    it('uses a scanner result once only', async () => {
        mockProbeMediaFile.mockResolvedValue(okProbe('matroska,webm'));

        await probeFileForScan(filePath);
        const row = await rowAsScannerStoredIt();
        await runPhaseA(row);
        await runPhaseA(row);

        expect(mockProbeMediaFile).toHaveBeenCalledTimes(2);
    });

    it('never reuses a failed scanner probe', async () => {
        mockProbeMediaFile
            .mockResolvedValueOnce({
                ...okProbe(''),
                success: false,
                error: 'boom',
                failureKind: 'transient',
            })
            .mockResolvedValueOnce(okProbe('matroska,webm'));

        expect((await probeFileForScan(filePath)).kind).toBe('failed');
        await runPhaseA(await rowAsScannerStoredIt());

        expect(mockProbeMediaFile).toHaveBeenCalledTimes(2);
    });
});
