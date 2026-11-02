// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * airing-series-refresh — re-sync running shows from TMDB on a schedule.
 *
 * series-sync runs when a series is matched or a file lands, and on demand.
 * Nothing re-ran it for a show that is still airing, so its episode rows froze
 * at the last sync: newly announced episodes reached the calendar only as
 * Sonarr gap-fill rows, and a new season had no rows at all until its first
 * file arrived (on prod 200 of 297 airing library series were over a week
 * stale, 2026-10-13).
 *
 * Every run picks the airing series (TMDB status, or a Sonarr episode in the
 * near window) whose TMDB data is older than {@link STALE_AFTER_HOURS}, oldest
 * first, at most {@link MAX_SERIES_PER_RUN}, and queues one series-sync each.
 * The cap bounds the TMDB spend per run: series-sync refetches every season.
 */

import { z } from 'zod';
import { defineTask } from '@sapd/lumastra-plugin-sdk';
import { registry } from '../../registry.js';
import { SERIES_SYNC_FRESHNESS_MINUTES } from './series-sync-freshness.js';

/**
 * A series whose TMDB data is younger than this is left alone. Must stay above
 * series-sync's own freshness window, or every queued sync would skip itself.
 */
export const STALE_AFTER_HOURS = 24;
if (STALE_AFTER_HOURS * 60 <= SERIES_SYNC_FRESHNESS_MINUTES) {
    throw new Error(
        'airing-series-refresh: STALE_AFTER_HOURS must exceed the series-sync freshness',
    );
}

/** Series queued per run; the next run continues with the next-oldest. */
export const MAX_SERIES_PER_RUN = 100;

/** Consecutive enqueue failures after which the run gives up (queue down). */
export const MAX_CONSECUTIVE_FAILURES = 5;

/** Background work: below scan- and file-triggered series-sync runs (5). */
const QUEUE_PRIORITY = 7;

const inputSchema = z.object({}).passthrough();

interface AiringSeriesRefreshResult {
    due: number;
    queued: number;
    deduped: number;
    failed: number;
    message: string;
}

export const airingSeriesRefreshTask = defineTask<
    Record<string, unknown>,
    AiringSeriesRefreshResult
>({
    id: 'airing-series-refresh',
    purpose: 'library',
    name: 'Airing Series Refresh',
    version: '1.0.0',
    processingVersion: 1,
    minAppVersion: '0.0.0',

    capabilities: { database: true },

    schedule: {
        every: '6h',
        runOnStartup: false,
        envOverride: 'AIRING_SERIES_REFRESH_INTERVAL',
    },

    identityFor: () => 'global',
    scope: 'global',
    // Only reads one query and queues runs; the TMDB work happens in the
    // series-sync runs (bulk class) it starts.
    resourceClass: 'maintenance',
    inputSchema,
    exclusiveWith: { scope: 'global', ttl: '15m' },
    timeout: { hard: '10m', soft: '9m' },

    async execute(ctx) {
        if (ctx.signal.aborted) {
            return { success: false, itemsProcessed: 0, stopReason: 'aborted' };
        }

        const { getPrimaryExternalIdProvider } =
            await import('$lib/server/utils/provider-config.js');
        if (getPrimaryExternalIdProvider() !== 'tmdb') {
            // Airing status and staleness are read from TMDB data; series-sync
            // judges freshness by the primary provider. Off that path, do nothing.
            const message = 'skipped: the primary metadata provider is not TMDB';
            return {
                success: true,
                itemsProcessed: 0,
                result: { due: 0, queued: 0, deduped: 0, failed: 0, message },
            };
        }

        const [{ findAiringSeriesDueForRefresh }, { orchestrator }] = await Promise.all([
            import('$lib/server/database/queries/airing-series.queries.js'),
            import('../../orchestrator.js'),
        ]);

        const due = await findAiringSeriesDueForRefresh(ctx.sql, {
            staleBefore: new Date(Date.now() - STALE_AFTER_HOURS * 60 * 60 * 1000),
            limit: MAX_SERIES_PER_RUN,
        });

        let queued = 0;
        let deduped = 0;
        let failed = 0;
        let consecutiveFailures = 0;
        let stopReason: 'aborted' | undefined;
        for (const series of due) {
            if (ctx.signal.aborted) {
                stopReason = 'aborted';
                break;
            }
            if (consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) break;
            try {
                const res = await orchestrator.startRun(
                    'series-sync',
                    { mediaItemId: series.id },
                    {
                        trigger: {
                            kind: 'in-process',
                            by: 'airing-series-refresh',
                            sourceRoute: 'task.airing-series-refresh',
                        },
                        parentRunId: ctx.runId,
                        priority: QUEUE_PRIORITY,
                        // The key the scan and stage-sweep paths use, so a sync
                        // they already queued for the series absorbs this one.
                        // An admin's forced sync keys on the bare id and is
                        // never swallowed by it.
                        idempotencyKey: `coverage:series-sync:${series.id}`,
                        subject: { type: 'mediaItem', id: series.id },
                    },
                );
                consecutiveFailures = 0;
                if (res.deduped) deduped++;
                else queued++;
            } catch (err) {
                failed++;
                consecutiveFailures++;
                ctx.logger.warn('airing-series-refresh: could not queue series-sync', {
                    mediaItemId: series.id,
                    error: err instanceof Error ? err.message : String(err),
                });
            }
            ctx.reportProgress(queued + deduped + failed, due.length, series.title);
        }

        const gaveUp = consecutiveFailures >= MAX_CONSECUTIVE_FAILURES;
        const message =
            `${queued} airing series queued for a TMDB refresh (${due.length} due, ` +
            `${deduped} already queued, ${failed} failed${gaveUp ? ', stopped after repeated failures' : ''})`;
        ctx.logger.info(message, { due: due.length, queued, deduped, failed });
        return {
            // Red when the queue took nothing although there was work for it.
            success: !stopReason && (failed === 0 || queued + deduped > 0),
            itemsProcessed: queued,
            ...(stopReason ? { stopReason } : {}),
            result: { due: due.length, queued, deduped, failed, message },
        };
    },
});

registry.registerTask(airingSeriesRefreshTask);
