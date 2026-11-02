// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Where a generated episode frame is written.
 *
 * It used to go next to the video unconditionally, so a read-only library mount
 * failed every episode with EROFS on every cycle. The location now follows the
 * unified metadata-storage strategy (alongside when writable, otherwise the
 * app's central .metadata store), like every other generated artwork.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { mockContext } from '@sapd/lumastra-plugin-sdk-testing';

const mocks = vi.hoisted(() => ({
    findEpisodeThumbnailWork: vi.fn(),
    generate: vi.fn(),
    upsert: vi.fn(),
    isSuppressed: vi.fn(),
    resolveWritePath: vi.fn(),
    capture: vi.fn(),
}));

vi.mock('$lib/server/database/queries/media-artwork.queries.js', () => ({
    findEpisodeThumbnailWork: mocks.findEpisodeThumbnailWork,
    loadEpisodeThumbnailExclusions: vi.fn(async () => ({ shared: [] })),
    hasArtworkSuppressionForType: vi.fn(async () => false),
    isArtworkSuppressed: mocks.isSuppressed,
    upsertLocalArtwork: mocks.upsert,
}));
vi.mock('$lib/server/services/episode-thumbnail-publication.service.js', () => ({
    captureEpisodeThumbnailInput: mocks.capture,
    publishEpisodeThumbnail: async (
        sql: unknown,
        row: { episodeId: string },
        _input: unknown,
        filePath: string,
    ) =>
        mocks.upsert(sql, {
            mediaItemId: row.episodeId,
            artworkType: 'thumb',
            filePath,
            sourceTag: 'generated:ffmpeg',
        }),
}));
vi.mock('$lib/server/services/frame-candidate.service.js', () => ({
    generateEpisodeThumbnail: mocks.generate,
}));
vi.mock('$lib/server/utils/safe-fs.js', () => ({ safeReaddir: vi.fn(async () => []) }));
vi.mock('$lib/server/services/episode-thumbnail-state.js', async (importOriginal) => ({
    ...(await importOriginal<typeof import('$lib/server/services/episode-thumbnail-state.js')>()),
    expectedThumbNames: vi.fn(() => ['ep1-thumb.jpg']),
}));
vi.mock('$lib/server/services/metadata-storage.service.js', () => ({
    resolveWritePath: mocks.resolveWritePath,
    metadataCentralBaseDir: () => '/config',
}));

import { episodeThumbnailGenerateTask } from './episode-thumbnail-generate.js';

function ctx(): Parameters<typeof episodeThumbnailGenerateTask.execute>[0] {
    return mockContext({ input: { limit: 5 } });
}

describe('episode-thumbnail-generate output location', () => {
    beforeEach(() => {
        for (const m of Object.values(mocks)) m.mockReset();
        mocks.findEpisodeThumbnailWork
            .mockResolvedValueOnce([
                {
                    episodeId: 'ep-1',
                    seasonId: 's1',
                    fileId: 'f1',
                    videoPath: '/data/ro/Show/S01/ep1.mkv',
                    durationSeconds: 100,
                    artworkPath: null,
                    startOffsetMs: null,
                    endOffsetMs: null,
                },
            ])
            .mockResolvedValue([]);
        mocks.capture.mockResolvedValue({ extractionSpan: { base: 0, duration: 100 } });
        mocks.isSuppressed.mockResolvedValue(false);
        mocks.upsert.mockResolvedValue(true);
        mocks.generate.mockResolvedValue({ success: true, bestEffort: false });
    });

    it('writes into the path the storage strategy resolves, not next to the video', async () => {
        mocks.resolveWritePath.mockResolvedValue({
            filePath: '/config/.metadata/ep-1/ep1-thumb.jpg',
            location: 'central',
        });

        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        await episodeThumbnailGenerateTask.execute(ctx() as any);

        expect(mocks.resolveWritePath).toHaveBeenCalledWith(
            expect.objectContaining({
                mediaFilePath: '/data/ro/Show/S01/ep1.mkv',
                centralDir: '/config/.metadata/ep-1',
                fileName: expect.stringMatching(/^ep-1-[a-f0-9-]{36}-thumb\.jpg$/),
            }),
        );
        expect(mocks.generate).toHaveBeenCalledWith(
            expect.objectContaining({ outputPath: '/config/.metadata/ep-1/ep1-thumb.jpg' }),
        );
        expect(mocks.upsert).toHaveBeenCalledWith(
            expect.anything(),
            expect.objectContaining({ filePath: '/config/.metadata/ep-1/ep1-thumb.jpg' }),
        );
    });

    it('uses the captured bounded or proportional window for all decoding', async () => {
        mocks.capture.mockResolvedValue({ extractionSpan: { base: 600, duration: 600 } });
        mocks.resolveWritePath.mockResolvedValue({ filePath: '/config/segment-thumb.jpg' });
        await episodeThumbnailGenerateTask.execute(ctx());
        expect(mocks.generate).toHaveBeenCalledWith(
            expect.objectContaining({ baseOffsetSeconds: 600, durationSeconds: 600 }),
        );
    });

    it('counts an unresolvable write location as a failure, not a crash', async () => {
        mocks.resolveWritePath.mockRejectedValue(new Error('not writable'));

        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const out: any = await episodeThumbnailGenerateTask.execute(ctx() as any);

        expect(out.result.failed).toBe(1);
        expect(mocks.generate).not.toHaveBeenCalled();
    });
});
