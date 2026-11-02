// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Watch History Retention — native defineTask implementation.
 *
 * watch_history grows without bound because it has no expiry column and no
 * previous retention mechanism. This task deletes rows whose session_start_time
 * is older than DB_CLEANUP_WATCH_HISTORY_DAYS (default 400 days) in batches of
 * 5 000 rows, honoring the abort signal between batches to avoid blocking other
 * maintenance work.
 *
 * Scheduled every 24h; manual trigger also allowed. The batch loop ensures a
 * backlog accumulated before this task was introduced is drained over successive
 * runs without holding long DELETE locks.
 *
 * DB-unavailable handling: relies on the runner's sql-stub-throws-TaskError
 * contract; no in-plugin guard needed.
 */

import { z } from 'zod';
import { defineTask } from '@sapd/lumastra-plugin-sdk';
import { registry } from '../../registry.js';
import { DB_CLEANUP_WATCH_HISTORY_DAYS } from '$lib/server/config.js';
import { classifyInfraError } from '../../infra-retry.js';

type WatchHistoryRetentionInput = Record<string, unknown>;

type WatchHistoryRetentionResult = {
    deleted: number;
    batches: number;
    message: string;
};

const inputSchema = z.object({}).passthrough();

export const watchHistoryRetentionTask = defineTask<
    WatchHistoryRetentionInput,
    WatchHistoryRetentionResult
>({
    id: 'watch-history-retention',
    // Internal machinery: hidden from the admin task list unless it fails.
    visibility: 'system',
    purpose: 'maintenance',
    name: 'Watch History Retention',
    version: '1.0.0',
    processingVersion: 1,
    minAppVersion: '0.0.0',

    capabilities: { database: true },

    schedule: {
        every: '24h',
        runOnStartup: false,
    },

    identityFor: () => 'global',
    scope: 'global',
    resourceClass: 'maintenance',

    inputSchema,

    timeout: { hard: '60m', soft: '59m' },

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
                result: { deleted: 0, batches: 0, message: 'Aborted before start' },
            };
        }

        const retentionModule =
            await import('$lib/server/services/watch-history-retention.service.js').catch(
                (err: unknown) => {
                    throw new Error(
                        `watch-history-retention: failed to load service: ${err instanceof Error ? err.message : String(err)}`,
                        { cause: err },
                    );
                },
            );

        const { pruneWatchHistory } = retentionModule;

        const result = await pruneWatchHistory(sql, DB_CLEANUP_WATCH_HISTORY_DAYS, signal);

        const wasAborted = result.aborted;

        const message =
            result.deleted > 0
                ? wasAborted
                    ? `Aborted after deleting ${result.deleted} watch_history rows (${result.batches} batches)`
                    : `Deleted ${result.deleted} watch_history rows older than ${DB_CLEANUP_WATCH_HISTORY_DAYS} days (${result.batches} batches)`
                : `No watch_history rows older than ${DB_CLEANUP_WATCH_HISTORY_DAYS} days`;

        if (result.deleted > 0) {
            logger.info('Watch history retention completed', {
                deleted: result.deleted,
                batches: result.batches,
                retentionDays: DB_CLEANUP_WATCH_HISTORY_DAYS,
                wasAborted,
            });
        }

        return {
            success: true,
            itemsProcessed: result.deleted,
            stopReason: wasAborted ? 'aborted' : undefined,
            result: {
                deleted: result.deleted,
                batches: result.batches,
                message,
            },
        };
    },
});

registry.registerTask(watchHistoryRetentionTask);
