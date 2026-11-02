// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Watch Sync Push — native defineTask implementation.
 *
 * Triggers the watch sync engine's push cycle every 5 minutes.
 * Pushes locally-changed watch states to all enabled sync providers
 * (Jellyfin, Trakt, etc.).
 *
 * Configuration:
 * - SYNC_WATCH_PUSH_INTERVAL: Duration-string override for the schedule interval
 *   (e.g. '5m', '10m'). Parsed by the scheduler as a duration string.
 */

import { z } from 'zod';
import { defineTask } from '@sapd/lumastra-plugin-sdk';
import type { TaskContext } from '@sapd/lumastra-plugin-sdk';
import { registry } from '../../registry.js';
import { watchSyncEngine } from '$lib/server/services/watch-sync-engine.service.js';
import { classifyInfraError } from '../../infra-retry.js';

type WatchSyncPushInput = Record<string, unknown>;

type WatchSyncPushResult = {
    summary: string;
    totalProcessed: number;
    totalSucceeded: number;
    totalSkipped: number;
    totalFailed: number;
    allErrors: string[];
    partialSuccess: boolean;
};

const inputSchema = z.object({}).passthrough();

export const watchSyncPushTask = defineTask<WatchSyncPushInput, WatchSyncPushResult>({
    id: 'watch-sync-push',
    purpose: 'watch-sync',
    name: 'Watch Sync Push',
    version: '1.0.0',
    processingVersion: 1,
    minAppVersion: '0.0.0',

    capabilities: { database: true, http: true },
    resourceClass: 'io',

    schedule: {
        every: '5m',
        runOnStartup: false,
        envOverride: 'SYNC_WATCH_PUSH_INTERVAL',
    },

    identityFor: (input) =>
        `global-${typeof (input as Record<string, unknown>).mode === 'string' ? ((input as Record<string, unknown>).mode as string) : 'catchup'}`,
    scope: 'global',

    // Singleton guard (mirrors watch-sync-pull): identityFor is a constant, so
    // without exclusiveWith every 5-minute fire would enqueue a fresh pending
    // run, and a push that overruns its window (or is re-delivered across a
    // deploy) would accumulate redundant pending rows. exclusiveWith collapses
    // concurrent fires into a single in-flight run. ttl must be >= timeout.hard;
    // 6m gives a 1m margin over the 5m hard cap.
    exclusiveWith: { scope: 'global', ttl: '6m' },

    inputSchema,

    timeout: { hard: '5m', soft: '290s' },

    retry: {
        attempts: 3,
        backoff: 'exponential',
        retryOn: classifyInfraError,
    },

    async execute(ctx: TaskContext<WatchSyncPushInput>) {
        const { signal } = ctx;

        ctx.logger.info('Watch sync push started');
        const results = (await watchSyncEngine.runPush(undefined, signal, ctx.sql)) ?? [];

        const totalProcessed = results.reduce((s, r) => s + (r.processed ?? 0), 0);
        const totalSucceeded = results.reduce((s, r) => s + (r.succeeded ?? 0), 0);
        const totalSkipped = results.reduce((s, r) => s + (r.skipped ?? 0), 0);
        const totalFailed = results.reduce((s, r) => s + (r.failed ?? 0), 0);
        const allErrors = results.flatMap((r) => r.errors);
        const summaryParts = results.map((r) => {
            const base = `${r.providerId}: ${r.succeeded ?? 0}/${r.processed ?? 0}, ${r.skipped ?? 0} skipped, ${r.failed ?? 0} failed${r.notPaired ? `, ${r.notPaired} titles not paired` : ''}`;
            return r.skippedUnavailable ? `${base} (unavailable)` : base;
        });
        const summary =
            results.length === 0
                ? 'No watch-sync providers enabled'
                : `Push: ${summaryParts.join(', ')}`;

        if (results.length === 0) {
            ctx.logger.info(summary);
        } else {
            for (const result of results) {
                const providerSummary = `${result.providerId}: ${result.succeeded ?? 0}/${result.processed ?? 0} pushed, ${result.skipped ?? 0} skipped, ${result.notPaired ?? 0} titles not paired`;
                if (result.errors.length > 0 || (result.notPaired ?? 0) > 0) {
                    ctx.logger.warn(`Watch sync push ${providerSummary}`, {
                        errors: result.errors.slice(0, 10),
                    });
                } else {
                    ctx.logger.info(`Watch sync push ${providerSummary}`, {
                        unavailable: result.skippedUnavailable,
                    });
                }
            }
        }

        // Strict success semantics (N1): errors → not a success; partial
        // progress is reported via result.partialSuccess.
        const success = allErrors.length === 0 && totalFailed === 0;
        const partialSuccess = totalSucceeded > 0 && !success;
        const wasAborted = signal.aborted;

        ctx.logger.info('Watch sync push finished', {
            totalProcessed,
            totalSucceeded,
            providers: results.length,
            errors: allErrors.length,
            aborted: wasAborted,
        });

        return {
            success,
            itemsProcessed: totalProcessed,
            stopReason: wasAborted ? 'aborted' : undefined,
            result: {
                summary,
                totalProcessed,
                totalSucceeded,
                totalSkipped,
                totalFailed,
                allErrors,
                partialSuccess,
            },
        };
    },
});

registry.registerTask(watchSyncPushTask);
