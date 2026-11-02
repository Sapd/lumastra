// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Music Transcode Cache Reaper — native defineTask implementation.
 *
 * Periodically enforces the disk-space cap on the music transcode cache by:
 *   1. Sweeping stale `.partial` files older than 1 hour (interrupted encodes).
 *   2. Evicting the least-recently-accessed final files until total usage is
 *      below `MUSIC_TRANSCODE_CACHE_MAX_GB` gigabytes.
 *
 * Only active when `FEATURE_MUSIC_TRANSCODE=true`. Checked at execute() entry
 * so both scheduled and manual triggers are blocked when the feature is off.
 *
 * The cache instance is created fresh on every run so that config changes
 * (cache dir, cap) take effect on the next tick without a restart.
 *
 * Interval is controlled by `MUSIC_TRANSCODE_REAPER_INTERVAL_M` (minutes,
 * default 30). The schedule here mirrors the default; the env var feeds into
 * config and is applied at runtime.
 */

import { z } from 'zod';
import { defineTask } from '@sapd/lumastra-plugin-sdk';
import { registry } from '../../registry.js';
import { config } from '$lib/server/config.js';
import { classifyInfraError } from '../../infra-retry.js';

type MusicTranscodeCacheReaperInput = Record<string, unknown>;

type MusicTranscodeCacheReaperResult = {
    message: string;
};

const inputSchema = z.object({}).passthrough();

export const musicTranscodeCacheReaperTask = defineTask<
    MusicTranscodeCacheReaperInput,
    MusicTranscodeCacheReaperResult
>({
    id: 'music-transcode-cache-reaper',
    // Internal machinery: hidden from the admin task list unless it fails.
    visibility: 'system',
    purpose: 'maintenance',
    name: 'Music Transcode Cache Reaper',
    version: '1.0.0',
    processingVersion: 1,
    minAppVersion: '0.0.0',

    capabilities: {},

    schedule: {
        every: '30m',
        runOnStartup: false,
    },

    identityFor: (input) =>
        `global-${typeof (input as Record<string, unknown>).mode === 'string' ? ((input as Record<string, unknown>).mode as string) : 'catchup'}`,
    scope: 'global',
    resourceClass: 'maintenance',

    inputSchema,

    timeout: { hard: '5m', soft: '4m' },

    retry: {
        attempts: 3,
        backoff: 'exponential',
        retryOn: classifyInfraError,
    },

    async execute(ctx) {
        const { logger, signal } = ctx;

        if (!config.FEATURE_MUSIC_TRANSCODE) {
            return {
                success: true,
                itemsProcessed: 0,
                result: {
                    message:
                        'music-transcode-cache-reaper disabled (FEATURE_MUSIC_TRANSCODE=false)',
                },
            };
        }

        const cacheDir = config.MUSIC_TRANSCODE_CACHE_DIR;
        const maxBytes = config.MUSIC_TRANSCODE_CACHE_MAX_GB * 1024 ** 3;

        if (!Number.isFinite(maxBytes) || maxBytes <= 0) {
            logger.warn(
                'MUSIC_TRANSCODE_CACHE_MAX_GB is zero/negative/invalid; skipping reap to avoid wiping cache',
                { maxBytes },
            );
            return {
                success: true,
                itemsProcessed: 0,
                result: {
                    message: 'cache cap is zero or invalid; reap skipped',
                },
            };
        }

        const { createMusicTranscodeCache } =
            await import('$lib/server/services/music-transcode/cache.js');
        const cache = createMusicTranscodeCache({ cacheDir });

        logger.debug('Music transcode cache reap starting', {
            cacheDir,
            maxGb: config.MUSIC_TRANSCODE_CACHE_MAX_GB,
        });

        await cache.reapToCap(maxBytes, signal);

        logger.debug('Music transcode cache reap complete');

        return {
            success: true,
            itemsProcessed: 0,
            result: {
                message: `Cache reap complete (cap: ${config.MUSIC_TRANSCODE_CACHE_MAX_GB} GB)`,
            },
        };
    },
});

registry.registerTask(musicTranscodeCacheReaperTask);
