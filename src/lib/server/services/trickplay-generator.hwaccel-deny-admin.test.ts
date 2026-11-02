// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The admin read/reset surface for the trickplay hwaccel deny list
 * (`listHwaccelDenyEntries`, `resetAllHwaccelDeny`, `resetOneHwaccelDeny`).
 *
 * These go straight to Valkey rather than through the task system's
 * `NamespacedCache` interface `cacheBackedHwaccelDenyList` uses (SCAN + TTL
 * aren't in that narrow interface) — see media-item-tasks.ts's
 * `capabilities: { cache: true }`, which wraps every key the generator writes
 * in a `plugin:trickplay-generation:` namespace via `buildNamespacedCache()`
 * (context-primitives.ts). The admin functions have to reconstruct that SAME
 * prefix by hand, or they silently look at — and "clear" — a keyspace nothing
 * ever wrote to. That is the one thing these tests exist to pin down.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

const getKeysByPatternMock = vi.fn(async (_pattern: string) => [] as string[]);
const deleteKeysByPatternMock = vi.fn(async (_pattern: string) => 0);
const cacheDelMock = vi.fn(async (_key: string | string[]) => 0);
const getKeyTtlSecondsMock = vi.fn(async (_key: string) => -2);

vi.mock('$lib/server/cache/valkey.js', () => ({
    getKeysByPattern: (p: string) => getKeysByPatternMock(p),
    deleteKeysByPattern: (p: string) => deleteKeysByPatternMock(p),
    cacheDel: (k: string | string[]) => cacheDelMock(k),
    getKeyTtlSeconds: (k: string) => getKeyTtlSecondsMock(k),
}));

const publishTrickplayHwaccelDenyResetMock = vi.fn();
vi.mock('$lib/server/cache/trickplay-hwaccel-deny-bus.js', () => ({
    onRemoteTrickplayHwaccelDenyReset: vi.fn(),
    publishTrickplayHwaccelDenyReset: (event: unknown) =>
        publishTrickplayHwaccelDenyResetMock(event),
}));

const configMock = {
    TRICKPLAY_HWACCEL_DEVICE: '/dev/dri/renderD128',
};

vi.mock('$lib/server/config.js', () => ({
    config: configMock,
    FEATURE_PER_TASK_QUEUES: false,
    LUMASTRA_FFMPEG_THREADS: 4,
    LUMASTRA_CONCURRENCY_CPU: 4,
}));

vi.mock('$lib/server/utils/cpu-budget.js', () => ({ getCpuBudgetCores: () => 20 }));
vi.mock('$lib/server/utils/logger.js', () => ({
    Logger: { for: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }) },
}));
vi.mock('$lib/server/utils/ffmpeg-spawn.js', () => ({ spawnFFmpegSafely: vi.fn() }));
vi.mock('$lib/server/utils/safe-fs.js', () => ({
    safeExists: vi.fn().mockResolvedValue(false),
    safeReaddir: vi.fn().mockResolvedValue([]),
    safeStat: vi.fn().mockResolvedValue({ size: 1000, mtimeMs: 100, ctimeMs: 100, ino: 1, dev: 1 }),
}));
vi.mock('./trickplay-storage.service.js', () => ({
    getBestTrickplayInfo: vi.fn(),
    saveSpriteSheet: vi.fn(),
    deleteTrickplayGeneration: vi.fn().mockResolvedValue(undefined),
    saveTrickplayManifest: vi.fn(),
    getTrickplayManifest: vi.fn(),
    hasTrickplay: vi.fn(),
    deleteTrickplay: vi.fn(),
    getTrickplayStats: vi.fn(),
}));
vi.mock('./database.service.js', () => ({
    aiDbService: { getSql: vi.fn().mockResolvedValue({}) },
}));
vi.mock('./trickplay-params.service.js', () => ({
    trickplayParamsService: { invalidate: vi.fn(), write: vi.fn() },
}));
vi.mock('$lib/server/database/queries/trickplay.queries.js', () => ({
    getMediaItemForTrickplay: vi.fn(),
    findEpisodesForSeries: vi.fn().mockResolvedValue([]),
    findEpisodesForSeason: vi.fn().mockResolvedValue([]),
}));
vi.mock('$lib/server/database/queries/media-files.queries.js', () => ({
    getFilesForMediaItem: vi.fn(),
    recordDecodeHealthIssue: vi.fn().mockResolvedValue(undefined),
    clearDecodeHealthIssues: vi.fn().mockResolvedValue(undefined),
}));

const DEVICE = '/dev/dri/renderD128';
const RAW_PREFIX = `plugin:trickplay-generation:hwaccel-deny:${DEVICE}:`;

beforeEach(async () => {
    vi.clearAllMocks();
    configMock.TRICKPLAY_HWACCEL_DEVICE = DEVICE;
    const { resetHwaccelProbe } = await import('./trickplay-generator.service.js');
    resetHwaccelProbe();
});

describe('listHwaccelDenyEntries', () => {
    it('scans the plugin-namespaced key, not the bare logical key', async () => {
        // The bug this pins: without the `plugin:trickplay-generation:` prefix,
        // this would scan a keyspace the generator never writes to and always
        // report "nothing denied" even when entries exist.
        getKeysByPatternMock.mockResolvedValue([]);
        const { listHwaccelDenyEntries } = await import('./trickplay-generator.service.js');

        await listHwaccelDenyEntries();

        expect(getKeysByPatternMock).toHaveBeenCalledWith(`${RAW_PREFIX}*`);
    });

    it('parses codec and pixFmt out of the key, and TTL into an ISO expiry', async () => {
        getKeysByPatternMock.mockResolvedValue([`${RAW_PREFIX}hevc:yuv420p10le`]);
        getKeyTtlSecondsMock.mockResolvedValue(3600);
        const { listHwaccelDenyEntries } = await import('./trickplay-generator.service.js');

        const entries = await listHwaccelDenyEntries();

        expect(entries).toHaveLength(1);
        expect(entries[0]).toMatchObject({ device: DEVICE, codec: 'hevc', pixFmt: 'yuv420p10le' });
        expect(entries[0].expiresAt).not.toBeNull();
        expect(new Date(entries[0].expiresAt as string).getTime()).toBeGreaterThan(Date.now());
    });

    it('reports no expiry when the key has none (ttl <= 0)', async () => {
        getKeysByPatternMock.mockResolvedValue([`${RAW_PREFIX}av1:yuv420p`]);
        getKeyTtlSecondsMock.mockResolvedValue(-1);
        const { listHwaccelDenyEntries } = await import('./trickplay-generator.service.js');

        const entries = await listHwaccelDenyEntries();

        expect(entries[0].expiresAt).toBeNull();
    });
});

describe('resetAllHwaccelDeny', () => {
    it('deletes the plugin-namespaced pattern for the current device', async () => {
        deleteKeysByPatternMock.mockResolvedValue(3);
        const { resetAllHwaccelDeny } = await import('./trickplay-generator.service.js');

        const cleared = await resetAllHwaccelDeny();

        expect(cleared).toBe(3);
        expect(deleteKeysByPatternMock).toHaveBeenCalledWith(`${RAW_PREFIX}*`);
    });

    it('publishes a reset-all event so every OTHER replica clears its own latch too', async () => {
        const { resetAllHwaccelDeny } = await import('./trickplay-generator.service.js');

        await resetAllHwaccelDeny();

        expect(publishTrickplayHwaccelDenyResetMock).toHaveBeenCalledWith({ kind: 'reset-all' });
    });
});

describe('resetOneHwaccelDeny', () => {
    it('deletes exactly the plugin-namespaced key for the given codec/pixFmt', async () => {
        cacheDelMock.mockResolvedValue(1);
        const { resetOneHwaccelDeny } = await import('./trickplay-generator.service.js');

        const cleared = await resetOneHwaccelDeny('hevc:yuv420p10le');

        expect(cleared).toBe(1);
        expect(cacheDelMock).toHaveBeenCalledWith(`${RAW_PREFIX}hevc:yuv420p10le`);
    });

    it('publishes a reset-key event carrying the cleared codec key', async () => {
        const { resetOneHwaccelDeny } = await import('./trickplay-generator.service.js');

        await resetOneHwaccelDeny('hevc:yuv420p10le');

        expect(publishTrickplayHwaccelDenyResetMock).toHaveBeenCalledWith({
            kind: 'reset-key',
            codecKey: 'hevc:yuv420p10le',
        });
    });
});
