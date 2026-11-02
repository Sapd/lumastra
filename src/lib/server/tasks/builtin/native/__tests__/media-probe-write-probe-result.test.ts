// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Phase A (processPhaseASlice) and the admin retry (retryOneFile) write the same
 * probe result the same way: file metadata, runtime propagation, streams and
 * language/quality, then the media-probe-a coverage row and `file.probed` for
 * every linked media item, all in one transaction. `writeProbeResult` is the one
 * place that does it; both callers use it.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type postgres from 'postgres';
import type * as FfprobeModule from '../../../../utils/ffprobe.js';
import type { MediaProbeResult } from '../../../../utils/ffprobe.js';

const {
    mockUpdateProbeData,
    mockReplaceStreams,
    mockRefreshLanguages,
    mockRefreshQuality,
    mockUpsertCompleted,
    mockEmitPipelineEvent,
} = vi.hoisted(() => ({
    mockUpdateProbeData: vi.fn(),
    mockReplaceStreams: vi.fn(),
    mockRefreshLanguages: vi.fn(),
    mockRefreshQuality: vi.fn(),
    mockUpsertCompleted: vi.fn(),
    mockEmitPipelineEvent: vi.fn(),
}));

vi.mock('../../../../utils/ffprobe.js', async (importOriginal) => {
    const actual = await importOriginal<typeof FfprobeModule>();
    return { ...actual, probeMediaFile: vi.fn(), probeKeyframes: vi.fn() };
});

vi.mock('../../../../database/queries/media-files.queries.js', async (importOriginal) => {
    const actual = await importOriginal<Record<string, unknown>>();
    return { ...actual, updateProbeData: mockUpdateProbeData };
});

vi.mock('../../../../database/queries/media-streams.queries.js', () => ({
    replaceStreamsForFile: mockReplaceStreams,
}));

vi.mock('../../../../database/queries/media-item-languages.queries.js', () => ({
    refreshLanguagesForFile: mockRefreshLanguages,
}));

vi.mock('../../../../database/queries/media-item-quality.queries.js', () => ({
    refreshQualityForFile: mockRefreshQuality,
}));

vi.mock('../../../../database/queries/stage-state.queries.js', async (importOriginal) => {
    const actual = await importOriginal<Record<string, unknown>>();
    return { ...actual, upsertCompletedRow: mockUpsertCompleted };
});

vi.mock('../../../../database/queries/event-outbox.queries.js', () => ({
    emitPipelineEvent: mockEmitPipelineEvent,
}));

vi.mock('../../../../plugins/runtime/drain-backlog.js', async (importOriginal) => {
    const actual = await importOriginal<Record<string, unknown>>();
    return { ...actual, drainBacklog: vi.fn() };
});

import { writeProbeResult } from '../media-probe.js';

const PROBE: MediaProbeResult = {
    success: true,
    video: {
        index: 0,
        codec: 'h264',
        width: 1920,
        height: 1080,
        fps: 24,
        pixelFormat: 'yuv420p',
        bitrate: null,
        hdr: null,
        colorSpace: null,
        colorPrimaries: null,
        colorTransfer: null,
        refFrames: null,
        profile: null,
        level: null,
        masterDisplay: null,
        maxCll: null,
        closedCaptions: false,
        fieldOrder: null,
    } as unknown as MediaProbeResult['video'],
    audioStreams: [],
    subtitleStreams: [],
    duration: 1320,
    container: 'matroska,webm',
    fileSize: 4096,
    formatBitrate: 80000,
};

/** A transaction handle that answers every tagged-template query with no rows. */
function fakeTx(): postgres.Sql {
    return vi.fn(async () => []) as unknown as postgres.Sql;
}

beforeEach(() => {
    vi.clearAllMocks();
});

describe('writeProbeResult', () => {
    it('writes the probe metadata and streams for the file, inside the given transaction', async () => {
        const tx = fakeTx();

        await writeProbeResult(tx, 'file-1', PROBE, ['item-1']);

        expect(mockUpdateProbeData).toHaveBeenCalledWith(
            tx,
            expect.objectContaining({
                fileId: 'file-1',
                containerFormat: 'matroska,webm',
                durationSeconds: 1320,
                totalBitrate: 80000,
                fileSizeBytes: 4096,
            }),
        );
        expect(mockReplaceStreams).toHaveBeenCalledWith(tx, 'file-1', expect.any(Array));
        expect(mockRefreshLanguages).toHaveBeenCalledWith(tx, 'file-1');
        expect(mockRefreshQuality).toHaveBeenCalledWith(tx, 'file-1');
    });

    it('marks media-probe-a complete and emits file.probed for every linked media item', async () => {
        const tx = fakeTx();

        await writeProbeResult(tx, 'file-1', PROBE, ['item-1', 'item-2']);

        for (const mediaItemId of ['item-1', 'item-2']) {
            expect(mockUpsertCompleted).toHaveBeenCalledWith(
                tx,
                expect.objectContaining({ mediaItemId, stageId: 'media-probe-a' }),
            );
            expect(mockEmitPipelineEvent).toHaveBeenCalledWith(
                tx,
                'file.probed',
                mediaItemId,
                expect.objectContaining({
                    mediaId: mediaItemId,
                    fileId: 'file-1',
                    hasVideo: true,
                    hasAudio: false,
                }),
            );
        }
    });

    it('writes no coverage row or event when no media item is linked', async () => {
        const tx = fakeTx();

        await writeProbeResult(tx, 'file-1', PROBE, []);

        expect(mockUpdateProbeData).toHaveBeenCalledTimes(1);
        expect(mockUpsertCompleted).not.toHaveBeenCalled();
        expect(mockEmitPipelineEvent).not.toHaveBeenCalled();
    });
});
