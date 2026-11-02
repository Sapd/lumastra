// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * music-transcode-cache-reaper task tests.
 * Verifies:
 *   - feature gate: returns early when FEATURE_MUSIC_TRANSCODE is false
 *   - happy path: calls reapToCap with the correct byte cap
 *   - propagates errors thrown from cache.reapToCap
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { TaskContext } from '@sapd/lumastra-plugin-sdk';

const { reapToCap } = vi.hoisted(() => ({
    reapToCap: vi.fn(),
}));

vi.mock('$lib/server/services/music-transcode/cache.js', () => ({
    createMusicTranscodeCache: vi.fn(() => ({ reapToCap })),
}));

vi.mock('$lib/server/config.js', () => ({
    config: {
        FEATURE_MUSIC_TRANSCODE: true,
        MUSIC_TRANSCODE_CACHE_DIR: '/tmp/transcode-cache',
        MUSIC_TRANSCODE_CACHE_MAX_GB: 10,
        MUSIC_TRANSCODE_REAPER_INTERVAL_M: 30,
    },
    // registry.ts (imported transitively) reads this at module load.
    FEATURE_PER_TASK_QUEUES: false,
}));

import { musicTranscodeCacheReaperTask } from './music-transcode-cache-reaper.js';

type ReaperInput = Record<string, unknown>;

function makeContext(overrides: Partial<TaskContext<ReaperInput>> = {}): TaskContext<ReaperInput> {
    const ac = new AbortController();
    return {
        sql: {} as never,
        logger: {
            info: vi.fn(),
            debug: vi.fn(),
            warn: vi.fn(),
            error: vi.fn(),
            child: vi.fn(),
        },
        signal: ac.signal,
        abortSignal: ac.signal,
        input: {},
        reportProgress: vi.fn(),
        ...overrides,
    } as unknown as TaskContext<ReaperInput>;
}

describe('music-transcode-cache-reaper task', () => {
    beforeEach(() => {
        vi.clearAllMocks();
    });

    it('calls reapToCap with the configured byte cap', async () => {
        reapToCap.mockResolvedValue(undefined);
        const result = await musicTranscodeCacheReaperTask.execute(makeContext());
        // reapToCap is called with (maxBytes, signal). Assert the cap and
        // accept any AbortSignal for the second arg.
        expect(reapToCap).toHaveBeenCalledWith(10 * 1024 ** 3, expect.anything());
        expect(result.success).toBe(true);
        expect(result.result?.message).toContain('Cache reap complete');
        expect(result.result?.message).toContain('10 GB');
    });

    it('propagates errors thrown from cache.reapToCap', async () => {
        reapToCap.mockRejectedValue(new Error('disk full'));
        await expect(musicTranscodeCacheReaperTask.execute(makeContext())).rejects.toThrow(
            'disk full',
        );
    });

    it('skips reapToCap and returns feature-disabled message when FEATURE_MUSIC_TRANSCODE is false', async () => {
        // Patch the config mock for this one test by spying on the module
        const configMod = await import('$lib/server/config.js');
        const original = configMod.config.FEATURE_MUSIC_TRANSCODE;
        Object.defineProperty(configMod.config, 'FEATURE_MUSIC_TRANSCODE', {
            configurable: true,
            get: () => false,
        });

        try {
            const result = await musicTranscodeCacheReaperTask.execute(makeContext());
            expect(result.success).toBe(true);
            expect(result.itemsProcessed).toBe(0);
            expect(result.result?.message).toContain('FEATURE_MUSIC_TRANSCODE=false');
            expect(reapToCap).not.toHaveBeenCalled();
        } finally {
            Object.defineProperty(configMod.config, 'FEATURE_MUSIC_TRANSCODE', {
                configurable: true,
                get: () => original,
            });
        }
    });
});
