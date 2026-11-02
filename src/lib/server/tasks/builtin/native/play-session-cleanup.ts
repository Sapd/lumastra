// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Play Session Cleanup — native defineTask implementation.
 *
 * Marks stale play sessions (no heartbeat) as CRASHED, via
 * `reapStaleSessions()` — which first finalizes any candidate whose last
 * known position already crossed the completion threshold as COMPLETED
 * (full stop pipeline: markWatched, watch_history, cache invalidation), so
 * an episode the user actually finished doesn't get frozen mid-progress
 * just because the heartbeat connection died first.
 * Thresholds:
 *   - Lumastra ACTIVE: 5 minutes since last heartbeat
 *   - Lumastra PAUSED: 30 minutes since last heartbeat
 *   - Mirrors (jellyfin, livetv, music): 30 seconds since last_seen_at
 *   - AudiobookShelf: 5 minutes playing, 30 minutes paused (or for a download)
 *   - See `staleSessionCondition` in play-sessions.queries.ts for the full list
 *
 * Play sessions are always enabled.
 *
 * DB-unavailable handling: relies on the runner's sql-stub-throws-TaskError contract; no in-plugin guard needed.
 */

import { z } from 'zod';
import { defineTask } from '@sapd/lumastra-plugin-sdk';
import { registry } from '../../registry.js';
import { reapStaleSessions } from '$lib/server/services/play-sessions.service.js';
import { classifyInfraError } from '../../infra-retry.js';

type PlaySessionCleanupInput = Record<string, unknown>;

type PlaySessionCleanupResult = {
    message: string;
};

const inputSchema = z.object({}).passthrough();

export const playSessionCleanupTask = defineTask<PlaySessionCleanupInput, PlaySessionCleanupResult>(
    {
        id: 'play-session-cleanup',
        // Internal machinery: hidden from the admin task list unless it fails.
        visibility: 'system',
        purpose: 'maintenance',
        name: 'Play Session Cleanup',
        version: '1.0.0',
        processingVersion: 1,
        minAppVersion: '0.0.0',

        capabilities: { database: true },

        schedule: {
            every: '1m',
            runOnStartup: false,
        },

        identityFor: (input) =>
            `global-${typeof (input as Record<string, unknown>).mode === 'string' ? ((input as Record<string, unknown>).mode as string) : 'catchup'}`,
        scope: 'global',
        resourceClass: 'maintenance',

        inputSchema,

        timeout: { hard: '30s', soft: '25s' },

        retry: {
            attempts: 3,
            backoff: 'exponential',
            retryOn: classifyInfraError,
        },

        async execute(ctx) {
            const { logger, sql, signal } = ctx;

            if (signal.aborted) {
                return {
                    success: true,
                    itemsProcessed: 0,
                    stopReason: 'aborted',
                    result: { message: 'Aborted before start' },
                };
            }

            const { crashed: count, completed } = await reapStaleSessions(sql);

            const baseMessage =
                count > 0
                    ? `Marked ${count} stale play session(s) as CRASHED`
                    : 'No stale play sessions found';

            if (count > 0) {
                logger.info(baseMessage);
            }
            if (completed > 0) {
                logger.info(
                    `Finalized ${completed} stale play session(s) as COMPLETED (crossed completion threshold before going stale)`,
                );
            }

            // M3 (selection-bias fix): quality rows are otherwise written only on
            // the COMPLETED/stop path, so CRASHED/KILLED sessions reaped above
            // would never get scored — biasing fleet health upward. Score any
            // recently-reaped sessions that still lack a quality row here, using
            // their already-flushed raw telemetry. Best-effort: a scoring failure
            // must not fail the cleanup task.
            try {
                const { playbackTelemetryService } =
                    await import('$lib/server/services/playback-telemetry.service.js');
                await playbackTelemetryService.scoreReapedSessions();
            } catch (err) {
                logger.warn('Failed to score reaped sessions (non-fatal)', {
                    error: err instanceof Error ? err.message : String(err),
                });
            }

            return {
                success: true,
                itemsProcessed: count,
                result: { message: baseMessage },
            };
        },
    },
);

registry.registerTask(playSessionCleanupTask);
