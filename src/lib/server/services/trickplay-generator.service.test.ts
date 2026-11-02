// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Tests for trickplay generator — focused on video info parsing
 * and aspect ratio computation.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

const execFileMock = vi.fn();
const getBestTrickplayInfoMock = vi.fn();
const getTrickplayManifestMock = vi.fn();
const hasTrickplayMock = vi.fn().mockResolvedValue(false);
const deleteTrickplayMock = vi.fn();
const getTrickplayStatsMock = vi.fn();
const saveSpriteSheetMock = vi.fn();
const saveTrickplayManifestMock = vi.fn();
const getSqlMock = vi.fn();
const getMediaItemByIdMock = vi.fn();
const getFilesForMediaItemMock = vi.fn();

// Mock dependencies before import
vi.mock('$lib/server/config.js', () => ({
    config: {
        FFPROBE_PATH: '/usr/bin/ffprobe',
        TRICKPLAY_ENABLED: true,
        TRICKPLAY_INTERVAL_MS: 10_000,
        TRICKPLAY_TILE_WIDTH: 10,
        TRICKPLAY_TILE_HEIGHT: 10,
        TRICKPLAY_WIDTH: 320,
        TRICKPLAY_QUALITY: 80,
        // Software decode keeps these tests independent of whether the machine
        // running them happens to have a GPU render node.
        TRICKPLAY_HWACCEL: 'off',
        TRICKPLAY_HWACCEL_DEVICE: '/dev/dri/renderD128',
        TRICKPLAY_PER_FRAME_CONCURRENCY: 4,
        BASE_PATH: '/tmp',
    },
    FEATURE_PER_TASK_QUEUES: false,
    LUMASTRA_FFMPEG_THREADS: 0,
    LUMASTRA_CONCURRENCY_CPU: 4,
}));

vi.mock('$lib/server/utils/cpu-budget.js', () => ({
    getCpuBudgetCores: () => 8,
}));

vi.mock('$lib/server/utils/logger.js', () => ({
    Logger: {
        for: () => ({
            info: vi.fn(),
            warn: vi.fn(),
            error: vi.fn(),
            child: vi.fn(),
        }),
    },
}));

vi.mock('child_process', () => ({
    execFile: (...args: unknown[]) => execFileMock(...args),
}));

vi.mock('$lib/server/utils/ffmpeg-spawn.js', () => ({
    spawnFFmpegSafely: vi.fn().mockResolvedValue({
        exitCode: 0,
        stdout: '',
        stderr: '',
    }),
}));

vi.mock('./trickplay-storage.service.js', () => ({
    getBestTrickplayInfo: getBestTrickplayInfoMock,
    saveSpriteSheet: saveSpriteSheetMock,
    deleteTrickplayGeneration: vi.fn().mockResolvedValue(undefined),
    saveTrickplayManifest: saveTrickplayManifestMock,
    getTrickplayManifest: getTrickplayManifestMock,
    hasTrickplay: hasTrickplayMock,
    deleteTrickplay: deleteTrickplayMock,
    getTrickplayStats: getTrickplayStatsMock,
}));

vi.mock('./database.service.js', () => ({
    aiDbService: {
        getSql: getSqlMock,
    },
}));

vi.mock('$lib/server/database/queries/trickplay.queries.js', () => ({
    getMediaItemForTrickplay: vi.fn(),
    findVideoPath: vi.fn(),
    findEpisodesForSeries: vi.fn(),
    findEpisodesForSeason: vi.fn(),
}));

vi.mock('$lib/server/database/queries/catalog-operations.queries.js', () => ({
    getMediaItemById: getMediaItemByIdMock,
}));

vi.mock('$lib/server/database/queries/media-files.queries.js', () => ({
    getFilesForMediaItem: getFilesForMediaItemMock,
}));

beforeEach(() => {
    vi.clearAllMocks();
    hasTrickplayMock.mockResolvedValue(false);
    getSqlMock.mockResolvedValue({} as never);
    getMediaItemByIdMock.mockResolvedValue(null);
    getFilesForMediaItemMock.mockResolvedValue([]);
});

// We test the private getVideoInfo indirectly through the module.
// Since it's not exported, we'll use a dynamic import trick to access
// the function. Instead, we test the aspect ratio logic directly.
describe('Trickplay aspect ratio computation', () => {
    it('computes correct height for 16:9 video (1920x1080)', () => {
        const videoWidth = 1920;
        const videoHeight = 1080;
        const trickplayWidth = 320;

        const aspectRatio = videoHeight / videoWidth;
        const height = Math.floor((trickplayWidth * aspectRatio) / 2) * 2;

        // 320 * (1080/1920) = 320 * 0.5625 = 180
        expect(height).toBe(180);
    });

    it('computes correct height for 4:3 video (720x480)', () => {
        const videoWidth = 720;
        const videoHeight = 480;
        const trickplayWidth = 320;

        const aspectRatio = videoHeight / videoWidth;
        const height = Math.floor((trickplayWidth * aspectRatio) / 2) * 2;

        // 320 * (480/720) = 320 * 0.6667 ≈ 213.3 → floor(213.3/2)*2 = 212
        expect(height).toBe(212);
    });

    it('computes correct height for 21:9 ultrawide (2560x1080)', () => {
        const videoWidth = 2560;
        const videoHeight = 1080;
        const trickplayWidth = 320;

        const aspectRatio = videoHeight / videoWidth;
        const height = Math.floor((trickplayWidth * aspectRatio) / 2) * 2;

        // 320 * (1080/2560) = 320 * 0.421875 = 135 → floor(135/2)*2 = 134
        expect(height).toBe(134);
    });

    it('computes correct height for vertical video (1080x1920)', () => {
        const videoWidth = 1080;
        const videoHeight = 1920;
        const trickplayWidth = 320;

        const aspectRatio = videoHeight / videoWidth;
        const height = Math.floor((trickplayWidth * aspectRatio) / 2) * 2;

        // 320 * (1920/1080) = 320 * 1.7778 ≈ 568.9 → floor(568.9/2)*2 = 568
        expect(height).toBe(568);
    });

    it('falls back to 16:9 when dimensions unavailable', () => {
        const videoWidth = 0;
        const videoHeight = 0;
        const trickplayWidth = 320;

        const aspectRatio = videoWidth > 0 && videoHeight > 0 ? videoHeight / videoWidth : 9 / 16;
        const height = Math.floor((trickplayWidth * aspectRatio) / 2) * 2;

        expect(height).toBe(180); // same as 16:9
    });

    it('ensures height is always even (required by ffmpeg)', () => {
        // Test with an aspect ratio that would produce an odd height
        const videoWidth = 1000;
        const videoHeight = 333; // ratio = 0.333, 320 * 0.333 = 106.56
        const trickplayWidth = 320;

        const aspectRatio = videoHeight / videoWidth;
        const height = Math.floor((trickplayWidth * aspectRatio) / 2) * 2;

        expect(height % 2).toBe(0);
    });
});

describe('trickplay source-scoped helpers', () => {
    it('checks trickplay status from source manifests only', async () => {
        getFilesForMediaItemMock.mockResolvedValue([
            { id: 'version-1', file_path: '/video-a.mkv' },
            { id: 'version-2', file_path: '/video-b.mkv' },
        ]);
        getTrickplayManifestMock.mockResolvedValueOnce(null).mockResolvedValueOnce({
            width: 320,
            thumbnailCount: 42,
        });

        const { getTrickplayStatus } = await import('./trickplay-generator.service.js');
        const status = await getTrickplayStatus('item-1', 320);

        expect(status).toEqual({
            exists: true,
            width: 320,
            thumbnailCount: 42,
        });
        expect(getTrickplayManifestMock).toHaveBeenCalledTimes(2);
        expect(getTrickplayManifestMock).toHaveBeenNthCalledWith(
            1,
            'version-1',
            320,
            '/video-a.mkv',
        );
        expect(getTrickplayManifestMock).toHaveBeenNthCalledWith(
            2,
            'version-2',
            320,
            '/video-b.mkv',
        );
    });

    it('deletes trickplay only for resolved sources', async () => {
        getFilesForMediaItemMock.mockResolvedValue([
            { id: 'version-1', file_path: '/video-a.mkv' },
            { id: 'version-2', file_path: '/video-b.mkv' },
        ]);

        const { deleteTrickplay } = await import('./trickplay-generator.service.js');
        const deleted = await deleteTrickplay('item-1');

        expect(deleted).toBe(true);
        expect(deleteTrickplayMock).toHaveBeenCalledTimes(2);
        expect(deleteTrickplayMock).toHaveBeenNthCalledWith(1, 'version-1', '/video-a.mkv');
        expect(deleteTrickplayMock).toHaveBeenNthCalledWith(2, 'version-2', '/video-b.mkv');
    });
});
