// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Unit tests for VideoFrameExtractorService
 *
 * Tests extraction logic without complex mocking.
 */

import { beforeEach, describe, it, expect, vi } from 'vitest';
import type postgres from 'postgres';

const itemMocks = vi.hoisted(() => ({
    findVideoFile: vi.fn(),
    hasLocalArtwork: vi.fn(),
    upsertLocalArtwork: vi.fn(),
    getMediaItemForImageSync: vi.fn(),
}));
const explicitMocks = vi.hoisted(() => ({
    capture: vi.fn(),
    publish: vi.fn(),
    current: vi.fn(),
}));

vi.mock('./explicit-episode-thumbnail.service.js', () => ({
    captureExplicitEpisodeThumbnailInput: explicitMocks.capture,
    publishExplicitEpisodeThumbnail: explicitMocks.publish,
    isExplicitEpisodeThumbnailInputCurrent: explicitMocks.current,
}));

vi.mock('$lib/server/database/queries/image-sync.queries.js', () => ({
    findVideoFile: itemMocks.findVideoFile,
    hasLocalArtwork: itemMocks.hasLocalArtwork,
    getMediaItemForImageSync: itemMocks.getMediaItemForImageSync,
    findEpisodesForSeries: vi.fn().mockResolvedValue([]),
    findEpisodesForSeason: vi.fn().mockResolvedValue([]),
}));

vi.mock('$lib/server/database/queries/media-artwork.queries.js', () => ({
    upsertLocalArtwork: itemMocks.upsertLocalArtwork,
}));

vi.mock('./image-proxy/index.js', () => ({
    getImageProxyService: () => ({ invalidateCatalogImage: vi.fn() }),
}));

vi.mock('./metadata-storage.service.js', () => ({
    resolveWritePath: vi.fn(async (opts: { centralDir: string; fileName: string }) => ({
        filePath: `${opts.centralDir}/${opts.fileName}`,
    })),
}));

const extractorMocks = vi.hoisted(() => {
    const execFile = vi.fn() as ReturnType<typeof vi.fn> & {
        [key: symbol]: unknown;
    };
    const execFilePromisified = vi.fn();
    execFile[Symbol.for('nodejs.util.promisify.custom')] = execFilePromisified;

    const sharpChain = {
        resize: vi.fn(),
        greyscale: vi.fn(),
        stats: vi.fn(),
    };
    sharpChain.resize.mockReturnValue(sharpChain);
    sharpChain.greyscale.mockReturnValue(sharpChain);

    return {
        execFile,
        execFilePromisified,
        spawnFFmpegSafely: vi.fn(),
        mkdir: vi.fn(),
        rename: vi.fn(),
        unlink: vi.fn(),
        sharp: vi.fn(() => sharpChain),
        sharpChain,
    };
});

vi.mock('$lib/server/config.js', () => ({
    config: {
        FFPROBE_PATH: '/usr/bin/ffprobe',
        IMAGE_SYNC_AUTO_VIDEO_EXTRACTION: true,
        IMAGE_SYNC_VIDEO_TIMESTAMP: 10,
        IMAGE_SYNC_VIDEO_QUALITY: 80,
        IMAGE_SYNC_VIDEO_MAX_WIDTH: 640,
        IMAGE_SYNC_VIDEO_MAX_HEIGHT: 360,
    },
}));

vi.mock('$lib/server/utils/ffmpeg-spawn.js', () => ({
    spawnFFmpegSafely: extractorMocks.spawnFFmpegSafely,
}));

vi.mock('child_process', () => ({
    execFile: extractorMocks.execFile,
}));

// Spread the real module: the playlist-body source guard opens the input with
// the real `open`, and a nonexistent test path is left to ffmpeg (ENOENT).
vi.mock('fs/promises', async (importOriginal) => ({
    ...(await importOriginal<typeof import('fs/promises')>()),
    mkdir: extractorMocks.mkdir,
    rename: extractorMocks.rename,
    unlink: extractorMocks.unlink,
}));

vi.mock('sharp', () => ({
    default: extractorMocks.sharp,
}));

describe('VideoFrameExtractorService', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        explicitMocks.capture.mockResolvedValue({
            episodeId: 'ep-1',
            videoPath: '/media/show/episode.mkv',
            durationSeconds: 1200,
            span: { base: 0, duration: 1200 },
        });
        explicitMocks.publish.mockResolvedValue(true);
        explicitMocks.current.mockResolvedValue(true);
        itemMocks.getMediaItemForImageSync.mockResolvedValue({ media_type: 'episode' });
        extractorMocks.execFilePromisified.mockResolvedValue({
            stdout: JSON.stringify({ format: { duration: '100' } }),
            stderr: '',
        });
        extractorMocks.spawnFFmpegSafely.mockResolvedValue({
            exitCode: 0,
            stdout: '',
            stderr: '',
        });
        extractorMocks.mkdir.mockResolvedValue(undefined);
        extractorMocks.rename.mockResolvedValue(undefined);
        extractorMocks.unlink.mockResolvedValue(undefined);
        extractorMocks.sharp.mockReturnValue(extractorMocks.sharpChain);
        extractorMocks.sharpChain.resize.mockReturnValue(extractorMocks.sharpChain);
        extractorMocks.sharpChain.greyscale.mockReturnValue(extractorMocks.sharpChain);
        extractorMocks.sharpChain.stats.mockResolvedValue({
            channels: [{ mean: 128, min: 40, max: 220 }],
        });
    });

    describe('ExtractionOptions', () => {
        it('should use default values from config', () => {
            const defaultTimestamp = 10;
            const defaultQuality = 80;
            const defaultMaxWidth = 640;
            const defaultMaxHeight = 360;

            expect(defaultTimestamp).toBe(10);
            expect(defaultQuality).toBe(80);
            expect(defaultMaxWidth).toBe(640);
            expect(defaultMaxHeight).toBe(360);
        });

        it('should allow overriding defaults', () => {
            const options = {
                videoPath: '/test/video.mp4',
                outputPath: '/test/output.jpg',
                timestampPercent: 25,
                quality: 50,
                maxWidth: 1280,
                maxHeight: 720,
            };

            expect(options.timestampPercent).toBe(25);
            expect(options.quality).toBe(50);
            expect(options.maxWidth).toBe(1280);
            expect(options.maxHeight).toBe(720);
        });
    });

    describe('Seek time calculation', () => {
        it('should calculate seek time correctly for 10%', () => {
            const duration = 100;
            const timestampPercent = 10;
            const seekTime = (timestampPercent / 100) * duration;
            expect(seekTime).toBe(10);
        });

        it('should calculate seek time correctly for 25%', () => {
            const duration = 200;
            const timestampPercent = 25;
            const seekTime = (timestampPercent / 100) * duration;
            expect(seekTime).toBe(50);
        });

        it('should calculate seek time correctly for 90%', () => {
            const duration = 60;
            const timestampPercent = 90;
            const seekTime = (timestampPercent / 100) * duration;
            expect(seekTime).toBe(54);
        });
    });

    describe('Quality to q:v mapping', () => {
        it('should map quality 100 to lowest q:v', () => {
            const quality = 100;
            const qv = Math.round((100 - quality) / 3.33);
            expect(qv).toBe(0);
        });

        it('should map quality 80 to appropriate q:v', () => {
            const quality = 80;
            const qv = Math.round((100 - quality) / 3.33);
            expect(qv).toBe(6);
        });

        it('should map quality 1 to highest q:v', () => {
            const quality = 1;
            const qv = Math.round((100 - quality) / 3.33);
            expect(qv).toBe(30);
        });
    });

    describe('Scale filter construction', () => {
        it('should include max dimensions in filter', () => {
            const maxWidth = 640;
            const maxHeight = 360;
            const filter = `scale='min(${maxWidth},iw)':'min(${maxHeight},ih)':force_original_aspect_ratio=decrease,pad=${maxWidth}:${maxHeight}:'(ow-iw)/2':'(oh-ih)/2'`;

            expect(filter).toContain(String(maxWidth));
            expect(filter).toContain(String(maxHeight));
        });
    });

    describe('ExtractionResult type', () => {
        it('should have success flag and optional outputPath', () => {
            const successResult = {
                success: true,
                outputPath: '/test/output.jpg',
            };

            expect(successResult.success).toBe(true);
            expect(successResult.outputPath).toBeDefined();
        });

        it('should have error message on failure', () => {
            const errorResult = {
                success: false,
                error: 'FFmpeg exited with code 1',
            };

            expect(errorResult.success).toBe(false);
            expect(errorResult.error).toBeDefined();
        });
    });

    describe('proportionalEpisodeTimestamp', () => {
        it('places the two segments of a combined file at 25% and 75%', async () => {
            const { proportionalEpisodeTimestamp } =
                await import('./video-frame-extractor.service');
            expect(proportionalEpisodeTimestamp(0, 2)).toBeCloseTo(25);
            expect(proportionalEpisodeTimestamp(1, 2)).toBeCloseTo(75);
        });

        it('centres the frame for a single-episode file at 50%', async () => {
            const { proportionalEpisodeTimestamp } =
                await import('./video-frame-extractor.service');
            expect(proportionalEpisodeTimestamp(0, 1)).toBeCloseTo(50);
        });

        it('distributes three segments evenly', async () => {
            const { proportionalEpisodeTimestamp } =
                await import('./video-frame-extractor.service');
            expect(proportionalEpisodeTimestamp(0, 3)).toBeCloseTo(16.667, 2);
            expect(proportionalEpisodeTimestamp(1, 3)).toBeCloseTo(50);
            expect(proportionalEpisodeTimestamp(2, 3)).toBeCloseTo(83.333, 2);
        });
    });

    describe('low-information frame rejection', () => {
        it('falls back to the first extractable frame when every candidate is rejected as low-information', async () => {
            // Design choice: a flat-colour cartoon (all candidates score below
            // the contrast threshold) is still preferable to leaving the
            // episode with no thumbnail at all. We expect success with the
            // first extractable frame promoted to outputPath via rename().
            extractorMocks.sharpChain.stats.mockResolvedValue({
                channels: [{ mean: 0, min: 0, max: 0 }],
            });
            const { extractFrame } = await import('./video-frame-extractor.service');

            const result = await extractFrame({
                videoPath: '/media/show/episode.mkv',
                outputPath: '/metadata/episode-thumb.jpg',
                timestampPercent: 10,
            });

            expect(result.success).toBe(true);
            expect(result.outputPath).toBe('/metadata/episode-thumb.jpg');
            expect(extractorMocks.rename).toHaveBeenCalled();
        });
    });

    it('keeps all low-information frame retries within the requested episode span', async () => {
        extractorMocks.sharpChain.stats.mockResolvedValue({
            channels: [{ mean: 0, min: 0, max: 0 }],
        });
        const { extractFrame } = await import('./video-frame-extractor.service');
        await extractFrame({
            videoPath: '/video/combined.mkv',
            outputPath: '/tmp/thumb.jpg',
            baseOffsetSeconds: 600,
            durationSeconds: 600,
        });
        const seeks = extractorMocks.spawnFFmpegSafely.mock.calls.map(([options]) =>
            Number(options.args[1]),
        );
        expect(seeks.length).toBeGreaterThan(1);
        expect(seeks.every((seek) => seek >= 600 && seek < 1200)).toBe(true);
    });

    describe('known video duration', () => {
        /** Calls that ran ffprobe (the first argument is the ffprobe binary). */
        function ffprobeCalls(): unknown[][] {
            return extractorMocks.execFilePromisified.mock.calls.filter(
                (call) => call[0] === '/usr/bin/ffprobe',
            );
        }

        /** Stands in for the postgres client; the lookups it feeds are mocked. */
        const fakeSql = Object.assign(vi.fn().mockResolvedValue([]), {
            array: (values: unknown[]) => values,
        }) as unknown as postgres.Sql;

        beforeEach(() => {
            itemMocks.findVideoFile.mockReset();
            itemMocks.hasLocalArtwork.mockReset().mockResolvedValue(false);
            itemMocks.upsertLocalArtwork.mockReset().mockResolvedValue(true);
        });

        it('extractFrame with a known duration runs ffmpeg without probing the duration', async () => {
            const { extractFrame } = await import('./video-frame-extractor.service');

            const result = await extractFrame({
                videoPath: '/media/show/episode.mkv',
                outputPath: '/metadata/episode-thumb.jpg',
                timestampPercent: 10,
                durationSeconds: 1320,
            });

            expect(result.success).toBe(true);
            expect(extractorMocks.spawnFFmpegSafely).toHaveBeenCalled();
            expect(ffprobeCalls()).toHaveLength(0);
        });

        it('extractFrame without a known duration still probes it', async () => {
            const { extractFrame } = await import('./video-frame-extractor.service');

            await extractFrame({
                videoPath: '/media/show/episode.mkv',
                outputPath: '/metadata/episode-thumb.jpg',
                timestampPercent: 10,
            });

            expect(ffprobeCalls()).toHaveLength(1);
        });

        it.each([0, -5, Number.NaN, Number.POSITIVE_INFINITY])(
            'extractFrame ignores the unusable duration %s and probes it',
            async (durationSeconds) => {
                const { extractFrame } = await import('./video-frame-extractor.service');

                await extractFrame({
                    videoPath: '/media/show/episode.mkv',
                    outputPath: '/metadata/episode-thumb.jpg',
                    timestampPercent: 10,
                    durationSeconds,
                });

                expect(ffprobeCalls()).toHaveLength(1);
            },
        );

        it('extractPosterForItem takes the duration stored on the file, without ffprobe', async () => {
            itemMocks.findVideoFile.mockResolvedValue({
                filePath: '/media/show/episode.mkv',
                durationSeconds: 1320,
            });
            const { extractPosterForItem } = await import('./video-frame-extractor.service');

            const result = await extractPosterForItem(fakeSql, {
                mediaItemId: 'ep-1',
                artworkType: 'thumb',
            });

            expect(itemMocks.findVideoFile).toHaveBeenCalledWith(fakeSql, 'ep-1');
            expect(result.extracted).toBe(true);
            expect(ffprobeCalls()).toHaveLength(0);
        });

        it('registers explicit admin extraction as an admin frame choice even with existing artwork', async () => {
            itemMocks.hasLocalArtwork.mockResolvedValue(true);
            itemMocks.findVideoFile.mockResolvedValue({
                filePath: '/media/show/episode.mkv',
                durationSeconds: 1200,
            });
            const { extractPosterForItem } = await import('./video-frame-extractor.service');
            const result = await extractPosterForItem(fakeSql, {
                mediaItemId: 'ep-1',
                artworkType: 'thumb',
                force: true,
                selectAsAdmin: true,
            });
            expect(result.extracted).toBe(true);
            expect(itemMocks.hasLocalArtwork).not.toHaveBeenCalled();
            expect(explicitMocks.publish).toHaveBeenCalledWith(
                fakeSql,
                expect.objectContaining({ episodeId: 'ep-1' }),
                expect.stringContaining('-thumb.jpg'),
            );
        });

        it('removes only the new single frame after a definite stale publication', async () => {
            explicitMocks.publish.mockResolvedValue(false);
            const { extractPosterForItem } = await import('./video-frame-extractor.service');
            const result = await extractPosterForItem(fakeSql, {
                mediaItemId: 'ep-1',
                artworkType: 'thumb',
                force: true,
                selectAsAdmin: true,
            });
            const newPath = explicitMocks.publish.mock.calls[0][2] as string;
            expect(result).toEqual({ extracted: false, reason: 'stale_input' });
            expect(extractorMocks.unlink).toHaveBeenCalledWith(newPath);
            expect(extractorMocks.unlink).not.toHaveBeenCalledWith('/media/show/curated.jpg');
        });

        it('removes only the new batch frame after a definite stale publication', async () => {
            explicitMocks.publish.mockResolvedValue(false);
            const { extractFramesBatch } = await import('./video-frame-extractor.service');
            const result = await extractFramesBatch(fakeSql, {
                mediaItemId: 'ep-1',
                scope: 'episode',
                mode: 'execute',
                artworkType: 'thumb',
                force: true,
                selectAsAdmin: true,
            });
            const newPath = explicitMocks.publish.mock.calls[0][2] as string;
            expect(result).toMatchObject({ extracted: 0, skipped: 1, errors: 0 });
            expect(extractorMocks.unlink).toHaveBeenCalledWith(newPath);
            expect(extractorMocks.unlink).not.toHaveBeenCalledWith('/media/show/curated.jpg');
        });

        it('retains the new frame when publication throws with an uncertain outcome', async () => {
            explicitMocks.publish.mockRejectedValue(new Error('connection lost'));
            const { extractFramesBatch } = await import('./video-frame-extractor.service');
            const result = await extractFramesBatch(fakeSql, {
                mediaItemId: 'ep-1',
                scope: 'episode',
                mode: 'execute',
                artworkType: 'thumb',
                force: true,
                selectAsAdmin: true,
            });
            const newPath = explicitMocks.publish.mock.calls[0][2] as string;
            expect(result).toMatchObject({ extracted: 0, errors: 1 });
            expect(extractorMocks.unlink).not.toHaveBeenCalledWith(newPath);
        });

        it('skips queued episode work when its reviewed source changed before decoding', async () => {
            explicitMocks.current.mockResolvedValue(false);
            const { extractFramesBatch } = await import('./video-frame-extractor.service');
            const result = await extractFramesBatch(fakeSql, {
                mediaItemId: 'ep-1',
                scope: 'episode',
                mode: 'execute',
                artworkType: 'thumb',
                force: true,
                selectAsAdmin: true,
                reviewedInput: {
                    episodeId: 'ep-1',
                    fileId: 'source-id',
                    videoPath: '/media/show/episode.mkv',
                    selectedCandidateId: null,
                    durationSeconds: 1200,
                    fileGeneration: 'file',
                    mediaGeneration: 'media',
                    siblingGeneration: 'siblings',
                    artworkGeneration: 'artwork',
                    physicalIdentity: 'physical',
                    span: { base: 0, duration: 1200 },
                },
            });
            expect(result).toMatchObject({ extracted: 0, skipped: 1, errors: 0 });
            expect(extractorMocks.spawnFFmpegSafely).not.toHaveBeenCalled();
            expect(explicitMocks.publish).not.toHaveBeenCalled();
        });

        it('refuses an explicit episode path that differs from its current default source', async () => {
            const { extractPosterForItem } = await import('./video-frame-extractor.service');
            const result = await extractPosterForItem(fakeSql, {
                mediaItemId: 'ep-1',
                artworkType: 'thumb',
                force: true,
                selectAsAdmin: true,
                videoFilePath: '/library/previous.mkv',
            });
            expect(result).toEqual({ extracted: false, reason: 'stale_input' });
            expect(extractorMocks.spawnFFmpegSafely).not.toHaveBeenCalled();
        });

        it('extractPosterForItem probes when the file has no stored duration', async () => {
            itemMocks.findVideoFile.mockResolvedValue({
                filePath: '/media/show/episode.mkv',
                durationSeconds: null,
            });
            const { extractPosterForItem } = await import('./video-frame-extractor.service');

            await extractPosterForItem(fakeSql, { mediaItemId: 'ep-1', artworkType: 'thumb' });

            expect(ffprobeCalls()).toHaveLength(1);
        });

        it('extractPosterForItem with an explicit videoFilePath and durationSeconds does not look up or probe', async () => {
            const { extractPosterForItem } = await import('./video-frame-extractor.service');

            const result = await extractPosterForItem(fakeSql, {
                mediaItemId: 'series-1',
                artworkType: 'poster',
                videoFilePath: '/media/show/episode.mkv',
                durationSeconds: 1320,
            });

            expect(result.extracted).toBe(true);
            expect(itemMocks.findVideoFile).not.toHaveBeenCalled();
            expect(ffprobeCalls()).toHaveLength(0);
        });

        it('extractPosterForItem with an explicit videoFilePath and no duration probes it', async () => {
            const { extractPosterForItem } = await import('./video-frame-extractor.service');

            await extractPosterForItem(fakeSql, {
                mediaItemId: 'series-1',
                artworkType: 'poster',
                videoFilePath: '/media/show/episode.mkv',
            });

            expect(itemMocks.findVideoFile).not.toHaveBeenCalled();
            expect(ffprobeCalls()).toHaveLength(1);
        });

        it('preserves FFmpeg disk-full stderr for a retry instead of a generic exit code', async () => {
            itemMocks.findVideoFile.mockResolvedValue({ filePath: '/media/show/episode.mkv', durationSeconds: 1320 });
            extractorMocks.spawnFFmpegSafely.mockResolvedValue({ exitCode: 1, stdout: '', stderr: 'av_interleaved_write_frame(): No space left on device' });
            const { extractFramesBatch } = await import('./video-frame-extractor.service');
            const result = await extractFramesBatch(fakeSql, { mediaItemId: 'ep-1', scope: 'episode', mode: 'execute', artworkType: 'thumb', force: true });
            expect(result).toMatchObject({ errors: 1, transientError: expect.stringContaining('No space left on device') });
        });

        it('preserves ENOSPC from a failed batch so the task can retry', async () => {
            itemMocks.findVideoFile.mockResolvedValue({
                filePath: '/media/show/episode.mkv',
                durationSeconds: 1320,
            });
            extractorMocks.mkdir.mockRejectedValueOnce(
                new Error('ENOSPC: no space left on device'),
            );
            const { extractFramesBatch } = await import('./video-frame-extractor.service');
            const result = await extractFramesBatch(fakeSql, {
                mediaItemId: 'ep-1',
                scope: 'episode',
                mode: 'execute',
                artworkType: 'thumb',
                force: true,
            });
            expect(result).toMatchObject({
                errors: 1,
                transientError: expect.stringContaining('ENOSPC'),
            });
        });

        it('extractFramesBatch takes the stored duration of the target file, without ffprobe', async () => {
            itemMocks.findVideoFile.mockResolvedValue({
                filePath: '/media/show/episode.mkv',
                durationSeconds: 1320,
            });
            const { extractFramesBatch } = await import('./video-frame-extractor.service');

            const result = await extractFramesBatch(fakeSql, {
                mediaItemId: 'ep-1',
                scope: 'episode',
                mode: 'execute',
                artworkType: 'backdrop',
            });

            expect(itemMocks.findVideoFile).toHaveBeenCalledWith(fakeSql, 'ep-1');
            expect(result.extracted).toBe(1);
            expect(ffprobeCalls()).toHaveLength(0);
        });
    });
});
