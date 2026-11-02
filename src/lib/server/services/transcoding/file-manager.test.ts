// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Unit Tests for TranscodeFileManager
 *
 * Tests filesystem operations for transcode jobs:
 * - Startup cleanup of stale directories
 * - Output directory creation and deletion
 * - Sliding window segment cleanup
 * - Error handling for filesystem operations
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { TranscodeFileManager } from './file-manager.js';
import type { TranscodeJob } from './types.js';
import * as fs from 'fs/promises';
import * as path from 'path';

// Mock fs/promises
vi.mock('fs/promises');

// Mock logger
vi.mock('../../utils/logger.js', () => ({
    Logger: {
        for: () => ({
            debug: vi.fn(),
            info: vi.fn(),
            warn: vi.fn(),
            error: vi.fn(),
        }),
    },
}));

// Mock config
vi.mock('../../config.js', () => ({
    config: {
        FFMPEG_TRANSCODE_DIR: '/tmp/transcode',
        FFMPEG_SEGMENT_KEEP_BEHIND: 50,
    },
}));

// Helper type for mock directory entries - simpler approach that works with any fs.readdir
type MockDirentEntry = { name: string; isDirectory: () => boolean };

// Cast mock entries to work with fs.readdir mock
function mockReaddir(entries: MockDirentEntry[]) {
    // Cast through unknown to satisfy strict type checking
    vi.mocked(fs.readdir).mockResolvedValue(
        entries as unknown as Awaited<ReturnType<typeof fs.readdir>>,
    );
}

describe('TranscodeFileManager', () => {
    let fileManager: TranscodeFileManager;
    let mockJob: TranscodeJob;

    beforeEach(() => {
        vi.clearAllMocks();
        fileManager = new TranscodeFileManager();

        // Create minimal mock job
        mockJob = {
            id: 'test-job-123',
            config: {
                playSessionId: 'session-123',
                itemId: 'item-123',
                username: 'testuser',
                deviceId: 'test-device',
                audioTracks: [],
                inputUrl: 'http://example.com/stream',
                videoInfo: { codec: 'h264', width: 1920, height: 1080 },
            },
            outputDir: '/tmp/transcode/test-job-123',
            status: 'running',
            segmentsReady: 100,
            segmentOffset: 0,
            process: null,
            startedAt: new Date(),
            lastAccessedAt: new Date(),
            lastProgressAt: new Date(),
            lastServedSegment: new Map(),
            deletedUpTo: new Map(),
            masterPlaylistReady: true,
            isSeeking: false,
            seekCount: 0,
            segmentDurationSeconds: 6,
            iframeData: [],
            iframeAnalyzedCount: 0,
            iframeAnalysisComplete: false,
            streamTargetDurations: new Map(),
            lastSeekTrigger: '',
            lastFFmpegSpawnTime: 0,
            spawnAttempt: 0,
            endSegmentCache: new Map(),
        } as unknown as TranscodeJob;
    });

    // ========================================================================
    // clearTranscodeDirectory() Tests
    // ========================================================================

    describe('clearTranscodeDirectory()', () => {
        it('should remove all subdirectories from transcode directory', async () => {
            const mockDirEntries = [
                { isDirectory: () => true, name: 'job-123' },
                { isDirectory: () => true, name: 'job-456' },
                { isDirectory: () => false, name: 'file.txt' },
            ];

            vi.mocked(fs.access).mockResolvedValue(undefined);
            mockReaddir(mockDirEntries);
            vi.mocked(fs.rm).mockResolvedValue(undefined);

            await fileManager.clearTranscodeDirectory();

            // Should remove both job directories
            expect(fs.rm).toHaveBeenCalledWith('/tmp/transcode/job-123', {
                recursive: true,
                force: true,
            });
            expect(fs.rm).toHaveBeenCalledWith('/tmp/transcode/job-456', {
                recursive: true,
                force: true,
            });

            // Should not try to remove the file
            expect(fs.rm).not.toHaveBeenCalledWith(
                expect.stringContaining('file.txt'),
                expect.anything(),
            );
        });

        // The transcode dir is SHARED across web replicas and the worker so a
        // peer can restore a session after a rolling recreate. A boot-time wipe
        // therefore must not touch directories belonging to sessions another
        // pod is actively streaming — otherwise every container start kills
        // every live playback on the host.
        it('preserves directories for sessions that are still live on another pod', async () => {
            const mockDirEntries = [
                { isDirectory: () => true, name: 'live-on-peer' },
                { isDirectory: () => true, name: 'genuinely-stale' },
            ];

            vi.mocked(fs.access).mockResolvedValue(undefined);
            mockReaddir(mockDirEntries);
            vi.mocked(fs.rm).mockResolvedValue(undefined);

            await fileManager.clearTranscodeDirectory(new Set(['live-on-peer']));

            expect(fs.rm).toHaveBeenCalledWith('/tmp/transcode/genuinely-stale', {
                recursive: true,
                force: true,
            });
            expect(fs.rm).not.toHaveBeenCalledWith(
                '/tmp/transcode/live-on-peer',
                expect.anything(),
            );
        });

        // The liveness set comes from a uuid column, so it is always dashed and
        // lowercase, while a directory keeps the spelling the client used: a
        // /j PlaySessionId is dashless 32-hex, an iOS one uppercase.
        it('preserves a live session directory spelled differently from its DB row', async () => {
            const mockDirEntries = [
                { isDirectory: () => true, name: '5f0c3a9e2b7d4c1a8e6f0b3d9a2c7e14' },
                { isDirectory: () => true, name: 'A8A1D0C2-5C1E-4F5B-9A57-6F0B8F3C2E11' },
            ];

            vi.mocked(fs.access).mockResolvedValue(undefined);
            mockReaddir(mockDirEntries);
            vi.mocked(fs.stat).mockResolvedValue({
                mtimeMs: Date.now() - 3 * 60 * 60 * 1000,
            } as unknown as Awaited<ReturnType<typeof fs.stat>>);
            vi.mocked(fs.rm).mockResolvedValue(undefined);

            await fileManager.clearTranscodeDirectory(
                new Set([
                    '5f0c3a9e-2b7d-4c1a-8e6f-0b3d9a2c7e14',
                    'a8a1d0c2-5c1e-4f5b-9a57-6f0b8f3c2e11',
                ]),
            );

            expect(fs.rm).not.toHaveBeenCalled();
        });

        // Non-cache preview sessions use a `preview-<id>-<ts>-<hex>` play
        // session id. Persistence only writes UUID-keyed rows, so these can
        // never appear in the liveness set — deleting them on that basis would
        // kill a Live TV preview a viewer is watching on another pod.
        it('keeps a recent non-UUID (preview) session directory that cannot be in the DB', async () => {
            const mockDirEntries = [
                { isDirectory: () => true, name: 'preview-abc-1753000000000-9f3a' },
            ];

            vi.mocked(fs.access).mockResolvedValue(undefined);
            mockReaddir(mockDirEntries);
            vi.mocked(fs.stat).mockResolvedValue({
                mtimeMs: Date.now() - 60 * 1000,
            } as unknown as Awaited<ReturnType<typeof fs.stat>>);
            vi.mocked(fs.rm).mockResolvedValue(undefined);

            await fileManager.clearTranscodeDirectory(new Set());

            expect(fs.rm).not.toHaveBeenCalled();
        });

        it('removes an abandoned non-UUID (preview) session directory once it is old', async () => {
            const mockDirEntries = [
                { isDirectory: () => true, name: 'preview-abc-1753000000000-9f3a' },
            ];

            vi.mocked(fs.access).mockResolvedValue(undefined);
            mockReaddir(mockDirEntries);
            vi.mocked(fs.stat).mockResolvedValue({
                mtimeMs: Date.now() - 3 * 60 * 60 * 1000,
            } as unknown as Awaited<ReturnType<typeof fs.stat>>);
            vi.mocked(fs.rm).mockResolvedValue(undefined);

            await fileManager.clearTranscodeDirectory(new Set());

            expect(fs.rm).toHaveBeenCalledWith('/tmp/transcode/preview-abc-1753000000000-9f3a', {
                recursive: true,
                force: true,
            });
        });

        it('removes everything when no sessions are live', async () => {
            const mockDirEntries = [
                { isDirectory: () => true, name: 'job-123' },
                { isDirectory: () => true, name: 'job-456' },
            ];

            vi.mocked(fs.access).mockResolvedValue(undefined);
            mockReaddir(mockDirEntries);
            vi.mocked(fs.rm).mockResolvedValue(undefined);

            await fileManager.clearTranscodeDirectory(new Set());

            expect(fs.rm).toHaveBeenCalledTimes(2);
        });

        it('should handle directory not existing', async () => {
            vi.mocked(fs.access).mockRejectedValue(new Error('ENOENT'));

            // Should not throw
            await expect(fileManager.clearTranscodeDirectory()).resolves.toBeUndefined();

            // Should not try to read or remove anything
            expect(fs.readdir).not.toHaveBeenCalled();
            expect(fs.rm).not.toHaveBeenCalled();
        });

        it('should continue cleanup even if one directory fails to remove', async () => {
            const mockDirEntries = [
                { isDirectory: () => true, name: 'job-123' },
                { isDirectory: () => true, name: 'job-456' },
            ];

            vi.mocked(fs.access).mockResolvedValue(undefined);
            mockReaddir(mockDirEntries);
            vi.mocked(fs.rm)
                .mockResolvedValueOnce(undefined) // First succeeds
                .mockRejectedValueOnce(new Error('Permission denied')); // Second fails

            // Should not throw
            await expect(fileManager.clearTranscodeDirectory()).resolves.toBeUndefined();

            // Should have tried to remove both
            expect(fs.rm).toHaveBeenCalledTimes(2);
        });

        it('should handle empty transcode directory', async () => {
            vi.mocked(fs.access).mockResolvedValue(undefined);
            vi.mocked(fs.readdir).mockResolvedValue([]);

            await fileManager.clearTranscodeDirectory();

            // Should not call rm
            expect(fs.rm).not.toHaveBeenCalled();
        });

        it('should handle readdir errors gracefully', async () => {
            vi.mocked(fs.access).mockResolvedValue(undefined);
            vi.mocked(fs.readdir).mockRejectedValue(new Error('Read error'));

            // Should not throw
            await expect(fileManager.clearTranscodeDirectory()).resolves.toBeUndefined();
        });
    });

    // ========================================================================
    // createOutputDirectory() Tests
    // ========================================================================

    describe('createOutputDirectory()', () => {
        it('should create output directory with recursive option', async () => {
            vi.mocked(fs.mkdir).mockResolvedValue(undefined);

            await fileManager.createOutputDirectory('/tmp/transcode/job-123');

            expect(fs.mkdir).toHaveBeenCalledWith('/tmp/transcode/job-123', {
                recursive: true,
            });
        });

        it('should throw error if mkdir fails', async () => {
            const error = new Error('Permission denied');
            vi.mocked(fs.mkdir).mockRejectedValue(error);

            await expect(
                fileManager.createOutputDirectory('/tmp/transcode/job-123'),
            ).rejects.toThrow('Permission denied');
        });

        it('should create parent directories if they do not exist', async () => {
            vi.mocked(fs.mkdir).mockResolvedValue(undefined);

            await fileManager.createOutputDirectory('/tmp/transcode/subdir/job-123');

            // recursive: true ensures parent directories are created
            expect(fs.mkdir).toHaveBeenCalledWith('/tmp/transcode/subdir/job-123', {
                recursive: true,
            });
        });
    });

    // ========================================================================
    // deleteOutputDirectory() Tests
    // ========================================================================

    describe('deleteOutputDirectory()', () => {
        it('should delete output directory recursively', async () => {
            vi.mocked(fs.rm).mockResolvedValue(undefined);

            await fileManager.deleteOutputDirectory('/tmp/transcode/job-123');

            expect(fs.rm).toHaveBeenCalledWith('/tmp/transcode/job-123', {
                recursive: true,
                force: true,
            });
        });

        it('should not throw error if directory does not exist', async () => {
            vi.mocked(fs.rm).mockResolvedValue(undefined);

            // force: true means it won't error if directory doesn't exist
            await expect(
                fileManager.deleteOutputDirectory('/tmp/transcode/job-123'),
            ).resolves.toBeUndefined();
        });

        it('should handle deletion errors gracefully', async () => {
            vi.mocked(fs.rm).mockRejectedValue(new Error('Permission denied'));

            // Should not throw - errors are logged but not propagated
            await expect(
                fileManager.deleteOutputDirectory('/tmp/transcode/job-123'),
            ).resolves.toBeUndefined();
        });
    });

    // ========================================================================
    // slidingWindowCleanup() Tests
    // ========================================================================

    // ========================================================================
    // isOutputComplete() Tests
    // ========================================================================
    //
    // Prod 2026-08-28: `restoreJob` respawned FFmpeg over a job whose 133
    // segments were already on disk, rewriting them from index 0 under a client
    // that was mid-playback. Segment requests blocked ~8s and the picture froze
    // while audio, buffered further ahead, played straight through. FFmpeg
    // terminates a finished media playlist with #EXT-X-ENDLIST, so that tag is
    // the authoritative "nothing left to produce" signal.

    describe('isOutputComplete()', () => {
        function mockManifests(
            byStream: Record<string, string | Error>,
            { withMaster = true }: { withMaster?: boolean } = {},
        ) {
            mockReaddir([
                ...Object.keys(byStream).map((name) => ({ name, isDirectory: () => true })),
                ...(withMaster ? [{ name: 'master.m3u8', isDirectory: () => false }] : []),
            ]);
            vi.mocked(fs.readFile).mockImplementation((async (p: string) => {
                const stream = path.basename(path.dirname(String(p)));
                const value = byStream[stream];
                if (value instanceof Error) throw value;
                return value;
            }) as unknown as typeof fs.readFile);
        }

        it('is complete when every stream manifest is terminated by ENDLIST', async () => {
            mockManifests({
                stream_0: '#EXTINF:10,\nsegment_00000.m4s\n#EXT-X-ENDLIST\n',
                stream_2: '#EXTINF:10,\nsegment_00000.m4s\n#EXT-X-ENDLIST\n',
            });

            await expect(fileManager.isOutputComplete('/tmp/transcode/gen-0001')).resolves.toBe(
                true,
            );
        });

        it('is NOT complete when one stream is still being written', async () => {
            // The exact prod shape after a seek/restart: audio finished, video
            // still growing. Respawning is correct here, so this must stay false.
            mockManifests({
                stream_0: '#EXTINF:10,\nsegment_00000.m4s\n#EXT-X-ENDLIST\n',
                stream_2: '#EXTINF:10,\nsegment_00000.m4s\n',
            });

            await expect(fileManager.isOutputComplete('/tmp/transcode/gen-0001')).resolves.toBe(
                false,
            );
        });

        it('is NOT complete when the master playlist was never written', async () => {
            // masterPlaylistReady is reported as job progress, so adopting an
            // output without a master would report a readiness that is not true.
            mockManifests(
                { stream_0: '#EXT-X-ENDLIST\n', stream_2: '#EXT-X-ENDLIST\n' },
                { withMaster: false },
            );

            await expect(fileManager.isOutputComplete('/tmp/transcode/gen-0001')).resolves.toBe(
                false,
            );
        });

        it('is NOT complete when there are no stream manifests to serve', async () => {
            mockReaddir([]);

            await expect(fileManager.isOutputComplete('/tmp/transcode/gen-0001')).resolves.toBe(
                false,
            );
        });

        it('is NOT complete when the output directory cannot be read', async () => {
            vi.mocked(fs.readdir).mockRejectedValue(new Error('ENOENT'));

            await expect(fileManager.isOutputComplete('/tmp/gone')).resolves.toBe(false);
        });
    });

    describe('slidingWindowCleanup()', () => {
        it('should not delete anything if no segments have been served', async () => {
            mockJob.lastServedSegment = new Map();

            await fileManager.slidingWindowCleanup(mockJob);

            expect(fs.readdir).not.toHaveBeenCalled();
            expect(fs.unlink).not.toHaveBeenCalled();
        });

        it('should not delete anything if lastServed < keepBehind', async () => {
            // Last served segment is 30, but keep behind is 50
            mockJob.lastServedSegment = new Map([['stream_0', 30]]);
            mockJob.deletedUpTo = new Map();

            await fileManager.slidingWindowCleanup(mockJob);

            // Should check for stream directories but not delete anything
            expect(fs.unlink).not.toHaveBeenCalled();
        });

        it('should delete old segments beyond keepBehind threshold', async () => {
            const mockDirEntries = [{ isDirectory: () => true, name: 'stream_0' }];

            // Last served: segment 100, keep behind: 50
            // Should delete segments 0-49 (threshold = 100 - 50 = 50)
            mockJob.lastServedSegment = new Map([['stream_0', 100]]);
            mockJob.deletedUpTo = new Map([['stream_0', -1]]);

            mockReaddir(mockDirEntries);
            vi.mocked(fs.unlink).mockResolvedValue(undefined);

            await fileManager.slidingWindowCleanup(mockJob);

            // Should delete segments 0-49 (50 segments total)
            expect(fs.unlink).toHaveBeenCalledTimes(50);

            // Check a few specific calls
            expect(fs.unlink).toHaveBeenCalledWith(
                path.join(mockJob.outputDir, 'stream_0', 'segment_00000.m4s'),
            );
            expect(fs.unlink).toHaveBeenCalledWith(
                path.join(mockJob.outputDir, 'stream_0', 'segment_00025.m4s'),
            );
            expect(fs.unlink).toHaveBeenCalledWith(
                path.join(mockJob.outputDir, 'stream_0', 'segment_00049.m4s'),
            );

            // Should update deletedUpTo marker
            expect(mockJob.deletedUpTo.get('stream_0')).toBe(49);
        });

        it('should only delete segments not already deleted', async () => {
            const mockDirEntries = [{ isDirectory: () => true, name: 'stream_0' }];

            // Last served: 100, keep behind: 50, already deleted up to: 30
            // Should delete segments 31-49 (deleteThreshold = 50)
            mockJob.lastServedSegment = new Map([['stream_0', 100]]);
            mockJob.deletedUpTo = new Map([['stream_0', 30]]);

            mockReaddir(mockDirEntries);
            vi.mocked(fs.unlink).mockResolvedValue(undefined);

            await fileManager.slidingWindowCleanup(mockJob);

            // Should delete segments 31-49 (19 segments)
            expect(fs.unlink).toHaveBeenCalledTimes(19);

            // Check boundary segments
            expect(fs.unlink).toHaveBeenCalledWith(
                path.join(mockJob.outputDir, 'stream_0', 'segment_00031.m4s'),
            );
            expect(fs.unlink).toHaveBeenCalledWith(
                path.join(mockJob.outputDir, 'stream_0', 'segment_00049.m4s'),
            );

            // Should NOT delete segment 30 (already deleted)
            expect(fs.unlink).not.toHaveBeenCalledWith(
                path.join(mockJob.outputDir, 'stream_0', 'segment_00030.m4s'),
            );

            // Should NOT delete segment 50 (within keep behind window)
            expect(fs.unlink).not.toHaveBeenCalledWith(
                path.join(mockJob.outputDir, 'stream_0', 'segment_00050.m4s'),
            );

            // Should update deletedUpTo marker
            expect(mockJob.deletedUpTo.get('stream_0')).toBe(49);
        });

        it('should use minimum lastServedSegment across all streams', async () => {
            const mockDirEntries = [
                { isDirectory: () => true, name: 'stream_0' },
                { isDirectory: () => true, name: 'stream_1' },
            ];

            // Different progress for each stream — min(100, 80) = 80
            // deleteThreshold = 80 - 50 = 30 for ALL streams
            mockJob.lastServedSegment = new Map([
                ['stream_0', 100],
                ['stream_1', 80],
            ]);
            mockJob.deletedUpTo = new Map([
                ['stream_0', -1],
                ['stream_1', -1],
            ]);

            mockReaddir(mockDirEntries);
            vi.mocked(fs.unlink).mockResolvedValue(undefined);

            await fileManager.slidingWindowCleanup(mockJob);

            // Both streams use min threshold: delete segments 0-29 = 30 each = 60 total
            expect(fs.unlink).toHaveBeenCalledTimes(60);

            // Check updated markers — both use same threshold
            expect(mockJob.deletedUpTo.get('stream_0')).toBe(29);
            expect(mockJob.deletedUpTo.get('stream_1')).toBe(29);
        });

        it('should handle file deletion errors gracefully', async () => {
            const mockDirEntries = [{ isDirectory: () => true, name: 'stream_0' }];

            mockJob.lastServedSegment = new Map([['stream_0', 100]]);
            mockJob.deletedUpTo = new Map([['stream_0', -1]]);

            mockReaddir(mockDirEntries);
            // Some files fail to delete
            vi.mocked(fs.unlink).mockImplementation(async (path: unknown) => {
                const pathStr = typeof path === 'string' ? path : String(path);
                if (pathStr.includes('segment_00010') || pathStr.includes('segment_00020')) {
                    throw new Error('File not found');
                }
            });

            // Should not throw - continues despite errors
            await expect(fileManager.slidingWindowCleanup(mockJob)).resolves.toBeUndefined();

            // Should still update deletedUpTo marker
            expect(mockJob.deletedUpTo.get('stream_0')).toBe(49);
        });

        it('should skip ALL cleanup when any stream has no lastServedSegment', async () => {
            const mockDirEntries = [
                { isDirectory: () => true, name: 'stream_0' },
                { isDirectory: () => true, name: 'stream_1' },
            ];

            // Only stream_0 has been served — stream_1 has no entry
            // Since min across all streams is undefined, no cleanup happens
            mockJob.lastServedSegment = new Map([['stream_0', 100]]);
            mockJob.deletedUpTo = new Map([['stream_0', -1]]);

            mockReaddir(mockDirEntries);
            vi.mocked(fs.unlink).mockResolvedValue(undefined);

            await fileManager.slidingWindowCleanup(mockJob);

            // No deletions — can't clean up until all renditions have been accessed
            expect(fs.unlink).not.toHaveBeenCalled();
        });

        it('should not delete if deleteThreshold <= currentDeletedUpTo', async () => {
            const mockDirEntries = [{ isDirectory: () => true, name: 'stream_0' }];

            // Last served: 100, keep behind: 50, already deleted up to: 49
            // deleteThreshold = 50, currentDeletedUpTo = 49
            // Since threshold (50) > currentDeletedUpTo (49), should delete segment 50
            // Wait, the logic is: deleteThreshold = lastServed - keepBehind = 100 - 50 = 50
            // We delete segments from (currentDeletedUpTo + 1) to (deleteThreshold - 1)
            // So from 50 to 49... which is invalid range, so nothing deleted
            mockJob.lastServedSegment = new Map([['stream_0', 100]]);
            mockJob.deletedUpTo = new Map([['stream_0', 49]]);

            mockReaddir(mockDirEntries);
            vi.mocked(fs.unlink).mockResolvedValue(undefined);

            await fileManager.slidingWindowCleanup(mockJob);

            // Should not delete anything (already caught up)
            expect(fs.unlink).not.toHaveBeenCalled();

            // deletedUpTo should remain unchanged
            expect(mockJob.deletedUpTo.get('stream_0')).toBe(49);
        });

        it('should handle readdir errors gracefully', async () => {
            mockJob.lastServedSegment = new Map([['stream_0', 100]]);
            mockJob.deletedUpTo = new Map([['stream_0', -1]]);

            vi.mocked(fs.readdir).mockRejectedValue(new Error('Read error'));

            // Should not throw
            await expect(fileManager.slidingWindowCleanup(mockJob)).resolves.toBeUndefined();

            // Should not have tried to delete anything
            expect(fs.unlink).not.toHaveBeenCalled();
        });

        it('should format segment filenames with zero-padding', async () => {
            const mockDirEntries = [{ isDirectory: () => true, name: 'stream_0' }];

            // Test single-digit and multi-digit segment numbers
            // lastServed: 60, keepBehind: 50 → deleteThreshold = 10
            // Delete segments 0-9 (10 segments total)
            mockJob.lastServedSegment = new Map([['stream_0', 60]]);
            mockJob.deletedUpTo = new Map([['stream_0', -1]]);

            mockReaddir(mockDirEntries);
            vi.mocked(fs.unlink).mockResolvedValue(undefined);

            await fileManager.slidingWindowCleanup(mockJob);

            // Should delete 10 segments (0-9)
            expect(fs.unlink).toHaveBeenCalledTimes(10);

            // Check that segment numbers are zero-padded to 5 digits
            expect(fs.unlink).toHaveBeenCalledWith(
                path.join(mockJob.outputDir, 'stream_0', 'segment_00000.m4s'),
            );
            expect(fs.unlink).toHaveBeenCalledWith(
                path.join(mockJob.outputDir, 'stream_0', 'segment_00005.m4s'),
            );
            expect(fs.unlink).toHaveBeenCalledWith(
                path.join(mockJob.outputDir, 'stream_0', 'segment_00009.m4s'),
            );

            // Should NOT delete segment 10 (at threshold)
            expect(fs.unlink).not.toHaveBeenCalledWith(
                path.join(mockJob.outputDir, 'stream_0', 'segment_00010.m4s'),
            );
        });
    });
});
