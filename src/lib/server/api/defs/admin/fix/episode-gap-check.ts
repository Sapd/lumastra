// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * admin/fix/episode-gap-check — the "episodes are missing" diagnostic.
 *
 * GET /api/admin/fix/episode-gap-check → EpisodeGapCheck.
 * Auth: admin. Errors: problem+json.
 *
 * Counts are measured live from the episode catalog series-sync maintains —
 * see `getEpisodeGapsFromCatalog` for what is and is not counted as missing,
 * and the schema header for why the unmeasured and conflicted series are
 * reported next to the findings rather than dropped.
 *
 * This used to read `series_health_reports`. Nothing has written that table
 * since its only writer lost its only caller, so the page reported "0 of N
 * series analysed" on every instance while the data it needed sat in
 * `media_items` the whole time.
 */

import { defineEndpoint } from '$lib/server/api/define.js';
import { json } from '@sveltejs/kit';
import { ApiProblem } from '$lib/server/api/problem.js';
import { Logger } from '$lib/server/utils/logger.js';
import { getAdminDb } from '$lib/server/database/connection.js';
import { getEpisodeGapsFromCatalog } from '$lib/server/database/queries/series-health.queries.js';
import { getPrimaryExternalIdProvider } from '$lib/server/utils/provider-config.js';
import { getSchedulerState } from '$lib/server/tasks/scheduler-state.js';
import { getLastCompletedRunAt } from '$lib/server/database/queries/runs-grouped.queries.js';
import type { EpisodeGapCheck } from '$lib/components/admin/fix/episode-gap-check.schema.js';

const logger = Logger.for('AdminFixEpisodeGapCheck');

/**
 * The task that writes the provider's episode rows. Its paused state decides
 * whether the catalog below can ever refresh, which is why the page reports it.
 */
const SERIES_SYNC_TASK_ID = 'series-sync';

/** Evidence, not an inventory. */
const MAX_GAPS = 25;

export const def = defineEndpoint({
    auth: { kind: 'scope', anyOf: ['tasks:admin'] },
    visibility: 'internal',
    handlers: {
        GET: async () => {
            const sql = getAdminDb();
            if (!sql) {
                return ApiProblem.dependencyUnavailable('Database not configured');
            }

            // A failed history read is not "never run".
            let lastRunUnreadable = false;
            const [summary, schedule, lastRunAt] = await Promise.all([
                // The measurement itself: no fallback. An empty summary here would
                // render "no shortfalls" — the one answer this page must never give
                // by accident.
                getEpisodeGapsFromCatalog(sql, getPrimaryExternalIdProvider(), MAX_GAPS),
                // Freshness context is independently degradable.
                getSchedulerState(sql, SERIES_SYNC_TASK_ID).catch((err: unknown) => {
                    logger.warn('series-sync scheduler state unreadable', {
                        error: err instanceof Error ? err.message : String(err),
                    });
                    return null;
                }),
                // Run history, NOT scheduler_state.last_fired_at. series-sync is
                // enqueued per item and declares no schedule, so it never gets a
                // scheduler_state row and that field is null forever.
                getLastCompletedRunAt(sql, SERIES_SYNC_TASK_ID).catch((err: unknown) => {
                    logger.warn('series-sync run history unreadable', {
                        error: err instanceof Error ? err.message : String(err),
                    });
                    lastRunUnreadable = true;
                    return null;
                }),
            ]);

            const payload: EpisodeGapCheck = {
                generatedAt: new Date().toISOString(),
                seriesWithFiles: summary.seriesWithFiles,
                unmeasuredSeries: summary.unmeasuredSeries,
                conflictedSeries: summary.conflictedSeries,
                seriesWithGaps: summary.seriesWithGaps,
                missingTotal: summary.missingTotal,
                syncPaused: schedule?.paused ?? false,
                // Prefer the real run history; fall back to the schedule for a task
                // that has a schedule row but no completed run yet.
                syncLastFiredAt: lastRunAt
                    ? new Date(lastRunAt).toISOString()
                    : schedule?.lastFiredAt
                      ? new Date(schedule.lastFiredAt).toISOString()
                      : null,
                syncLastRunUnreadable: lastRunUnreadable && !schedule?.lastFiredAt,
                gaps: summary.gaps.slice(0, MAX_GAPS).map((g) => ({
                    seriesId: g.series_id,
                    title: g.title,
                    held: g.held,
                    missing: g.missing,
                    seasonsAffected: g.seasons_affected,
                })),
                gapsTruncated: summary.seriesWithGaps > MAX_GAPS,
            };

            return json(payload);
        },
    },
});
