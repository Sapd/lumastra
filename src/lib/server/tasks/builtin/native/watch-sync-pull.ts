// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Watch Sync Pull — native defineTask implementation.
 *
 * Triggers the watch sync engine's pull cycle every 5 minutes.
 * Cursor-based incremental pull keeps per-cycle cost proportional to new
 * activity, not total history. Imports watch state from all enabled sync
 * providers (Jellyfin, Trakt, etc.).
 *
 * Configuration:
 * - SYNC_WATCH_PULL_INTERVAL: Duration-string override for the schedule interval
 *   (e.g. '10m', '30m'). Parsed by the scheduler as a duration string.
 */

import { z } from 'zod';
import { defineTask } from '@sapd/lumastra-plugin-sdk';
import type { TaskContext } from '@sapd/lumastra-plugin-sdk';
import { registry } from '../../registry.js';
import {
    watchSyncEngine,
    type ArbitrationLoss,
} from '$lib/server/services/watch-sync-engine.service.js';
import { classifyInfraError } from '../../infra-retry.js';
import {
    consumePendingJellyfinPull,
    saveJellyfinSetupValue,
} from '$lib/server/database/queries/jellyfin-setup.queries.js';
import { refreshSetupJellyfinCounts } from '$lib/server/database/queries/onboarding.queries.js';
import { flushPendingJellyfinPull } from '$lib/server/services/jellyfin-setup-sync.service.js';
import { registerRunFollowup } from '../../run-followups.js';
import { Logger } from '$lib/server/utils/logger.js';
import { features } from '$lib/server/config.js';

type WatchSyncPullInput = Record<string, unknown>;

type WatchSyncPullResult = {
    summary: string;
    totalProcessed: number;
    allErrors: string[];
    partialSuccess: boolean;
    meta: {
        /** Overall count across providers (all providers that were pulled). */
        usersSkippedNoLumastraAccount: number;
        /**
         * Per provider id (e.g. `jellyfin-watch-sync`): the usernames skipped for
         * having no Lumastra account, de-duplicated and capped at
         * MAX_SKIPPED_NAMES_IN_META. Only providers that were pulled this run
         * appear, with an empty list when nobody was skipped.
         */
        skippedNoLumastraAccountByProvider: Record<string, string[]>;
        /** Per provider id: the true distinct number of skipped usernames (not capped). */
        skippedNoLumastraAccountCountByProvider: Record<string, number>;
        totalLostArbitration: number;
        arbitrationLosses: ArbitrationLoss[];
    };
};

const inputSchema = z.object({}).passthrough();

/** Bounds the names stored in the task result; the count stays exact. */
const MAX_SKIPPED_NAMES_IN_META = 50;

/** Usernames de-duplicated case-insensitively, keeping the first spelling and dropping blanks. */
function distinctUsernames(names: readonly string[]): string[] {
    const seen = new Set<string>();
    const out: string[] = [];
    for (const name of names) {
        const key = name.trim().toLowerCase();
        if (key === '' || seen.has(key)) continue;
        seen.add(key);
        out.push(name);
    }
    return out;
}

export const watchSyncPullTask = defineTask<WatchSyncPullInput, WatchSyncPullResult>({
    id: 'watch-sync-pull',
    purpose: 'watch-sync',
    name: 'Watch Sync Pull',
    version: '1.0.0',
    processingVersion: 1,
    minAppVersion: '0.0.0',

    capabilities: { database: true, http: true },
    resourceClass: 'io',

    schedule: {
        every: '5m',
        runOnStartup: false,
        envOverride: 'SYNC_WATCH_PULL_INTERVAL',
    },

    identityFor: (input) =>
        `global-${typeof (input as Record<string, unknown>).mode === 'string' ? ((input as Record<string, unknown>).mode as string) : 'catchup'}`,
    scope: 'global',

    // Singleton guard: identityFor is a constant ('global-catchup'), so without
    // exclusiveWith every 5-minute scheduler fire would enqueue a brand-new
    // pending run. A slow pull (per-user Jellyfin sweeps can run for hours)
    // then accumulates a deep backlog of redundant pending rows. exclusiveWith
    // SETNX-claims the identity key for the duration of an in-flight run, so
    // each subsequent fire is a no-op duplicate until the current run finishes.
    // ttl must be >= timeout.hard (SDK-enforced); 130m gives a 10m margin over
    // the 2h hard cap and is clamped up to the derived floor by the host.
    exclusiveWith: { scope: 'global', ttl: '130m' },

    inputSchema,

    timeout: { hard: '2h', soft: '115m' },

    retry: {
        attempts: 3,
        backoff: 'exponential',
        retryOn: classifyInfraError,
    },

    async execute(ctx: TaskContext<WatchSyncPullInput>) {
        const { signal } = ctx;
        if (features.jellyfinSync) {
            try {
                await saveJellyfinSetupValue(ctx.sql, 'pull-run', { runId: ctx.runId });
                await consumePendingJellyfinPull(ctx.sql);
                await saveJellyfinSetupValue(ctx.sql, 'kick-error', false);
            } catch {
                ctx.logger.warn('Could not record Jellyfin pull status');
            }
        }

        // The engine has its own server logger for operational diagnostics,
        // but that logger is not attached to this task run's persisted log.
        // Keep concise lifecycle entries here so the admin Run detail can
        // explain what a scheduled pull actually did.
        ctx.logger.info('Watch sync pull started');
        const results = (await watchSyncEngine.runPull(undefined, signal, ctx.sql)) ?? [];
        if (features.jellyfinSync) {
            try {
                await refreshSetupJellyfinCounts(ctx.sql);
            } catch {
                ctx.logger.warn('Could not update Jellyfin pairing counts');
            }
        }

        const totalProcessed = results.reduce((s, r) => s + r.totalUpserted, 0);
        const allErrors = results.flatMap((r) => r.errors);
        const totalSkippedUsers = results.reduce(
            (s, r) => s + (r.usersSkippedNoLumastraAccount ?? 0),
            0,
        );
        // Per provider, so the Jellyfin notice never counts another provider's
        // accounts. An unavailable provider or a pull that never returned (for
        // example, a failed Jellyfin /Users fetch) says nothing about its accounts.
        const skippedByProvider: Record<string, string[]> = {};
        const skippedCountByProvider: Record<string, number> = {};
        for (const r of results) {
            if (r.skippedUnavailable || !r.pulled) continue;
            const names = distinctUsernames(r.skippedNoLumastraAccountNames ?? []);
            skippedByProvider[r.provider] = names.slice(0, MAX_SKIPPED_NAMES_IN_META);
            skippedCountByProvider[r.provider] = names.length;
        }
        const summaryParts = results.map((r) => {
            const parts = [`${r.provider}:`];
            const movies = r.movies ?? { imported: 0 };
            const episodes = r.episodes ?? { imported: 0 };
            const resumeItems = r.resumeItems ?? { imported: 0 };
            if (movies.imported > 0) parts.push(`${movies.imported} movies`);
            if (episodes.imported > 0) parts.push(`${episodes.imported} episodes`);
            if (resumeItems.imported > 0) parts.push(`${resumeItems.imported} resume`);
            const notPaired = r.notPaired ?? r.totalSkippedNoMatch;
            if (notPaired > 0) parts.push(`${notPaired} titles not paired`);
            if (r.usersSkippedNoLumastraAccount > 0) {
                parts.push(`${r.usersSkippedNoLumastraAccount} unknown-users`);
            }
            if (r.totalLostArbitration) parts.push(`${r.totalLostArbitration} lost arbitration`);
            if (r.skippedUnavailable) parts.push('unavailable');
            else if (!r.pulled) parts.push('not pulled');
            if (parts.length === 1) parts.push('0 imported');
            return parts.join(' ');
        });
        const summary =
            results.length === 0
                ? 'No watch-sync providers with pull enabled'
                : `Pull: ${summaryParts.join(', ')}`;

        if (results.length === 0) {
            ctx.logger.info(summary);
        } else {
            for (const result of results) {
                const providerSummary = `${result.provider}: ${result.totalUpserted} imported, ${result.notPaired ?? result.totalSkippedNoMatch} titles not paired, ${result.totalBuffered} buffered`;
                if (
                    result.errors.length > 0 ||
                    (result.notPaired ?? result.totalSkippedNoMatch) > 0
                ) {
                    ctx.logger.warn(`Watch sync pull ${providerSummary}`, {
                        errors: result.errors.slice(0, 10),
                    });
                } else {
                    ctx.logger.info(`Watch sync pull ${providerSummary}`, {
                        skippedUnavailable: result.skippedUnavailable,
                        usersSkippedNoLumastraAccount: result.usersSkippedNoLumastraAccount,
                    });
                }
            }
        }

        // Strict success semantics (N1): a run is only "successful" if no
        // errors surfaced. Partial progress is reported via result.partialSuccess
        // for the admin UI to distinguish a degraded-but-productive run
        // from a clean run.
        const success = allErrors.length === 0;
        const partialSuccess = totalProcessed > 0 && !success;
        const wasAborted = signal.aborted;

        ctx.logger.info('Watch sync pull finished', {
            totalProcessed,
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
                allErrors,
                partialSuccess,
                meta: {
                    usersSkippedNoLumastraAccount: totalSkippedUsers,
                    skippedNoLumastraAccountByProvider: skippedByProvider,
                    skippedNoLumastraAccountCountByProvider: skippedCountByProvider,
                    totalLostArbitration: results.reduce(
                        (sum, r) => sum + (r.totalLostArbitration ?? 0),
                        0,
                    ),
                    arbitrationLosses: results
                        .flatMap((r) => r.arbitrationLosses ?? [])
                        .slice(0, 100),
                },
            },
        };
    },
});

registry.registerTask(watchSyncPullTask);
registerRunFollowup(watchSyncPullTask.id, async (sql) => {
    if (features.jellyfinSync) await flushPendingJellyfinPull(sql, Logger.for('WatchSyncFollowup'));
});
