// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * `analyze_viewing_history` — the caller's own recorded playback sessions,
 * collapsed to one row per title.
 *
 * @module server/assistant/assistant-tools/analyze-viewing-history
 */

import {
    ASSISTANT_TOOL_NAMES,
    analyzeViewingHistoryArgsSchema,
    type AnalyzeViewingHistoryArgs,
} from '../../../schemas/assistant-tools.js';
import { searchAccessBoundary } from '../../utils/search-access-context.js';
import { buildLibraryAccessFilter } from '../../database/queries/builders/library-access.builder.js';
import { buildSeriesOwnedAgeRatingFilter } from '../../database/queries/builders/age-rating.builder.js';
import type { AssistantTool, AssistantToolContext, AssistantToolExecuteResult } from './types.js';
import { resultCounts } from './result-counts.js';

export const analyzeViewingHistoryTool: AssistantTool<AnalyzeViewingHistoryArgs> = {
    name: ASSISTANT_TOOL_NAMES.ANALYZE_VIEWING_HISTORY,
    description:
        "Analyze the caller's recorded viewing sessions. Use abandoned for titles stopped before 60%, nearly_finished for incomplete titles at 75–98%, and recent for recent sessions.",
    argsSchema: analyzeViewingHistoryArgsSchema,
    async execute(
        args: AnalyzeViewingHistoryArgs,
        ctx: AssistantToolContext,
    ): Promise<AssistantToolExecuteResult> {
        const access = searchAccessBoundary(ctx.accessCtx);
        // The `>= 300s` floor on `abandoned` is the project-wide "real watch"
        // convention, shared with getBehaviorallyDemotedMediaIds: below it, a
        // session is a peek, not a rejection (preprod: 90.5% of abandoned rows).
        const condition =
            args.mode === 'abandoned'
                ? ctx.sql`wh.status = 'abandoned' AND wh.actual_watch_time_seconds >= 300 AND wh.completion_percentage < 60`
                : args.mode === 'nearly_finished'
                  ? ctx.sql`wh.status = 'abandoned' AND wh.completion_percentage >= 75 AND wh.completion_percentage < 98`
                  : ctx.sql`true`;
        // `status` is per SESSION, not per title: a series someone dropped once
        // and finished a month later still has the old `abandoned` row, and the
        // WHERE above keeps it while filtering the later `completed` one out. So
        // "what did I abandon" listed titles the user had actually finished.
        // `user_media_state.is_watched` is the canonical watched signal.
        const excludeFinished =
            args.mode === 'recent'
                ? ctx.sql``
                : ctx.sql`AND NOT EXISTS (
                    SELECT 1 FROM user_media_state ums
                    WHERE ums.user_id = wh.user_id AND ums.media_id = wh.media_id
                      AND ums.is_watched = true)`;
        // DISTINCT ON must lead its ORDER BY with the distinct key, so the LIMIT
        // cannot live in the same SELECT: it would take the N lowest media_id
        // UUIDs rather than the N most recent titles (verified against pg18 —
        // `recent` returned the OLDEST rows). Dedup inside, rank outside.
        const rows = await ctx.sql<{ title: string; completion: number; ended_at: Date | null }[]>`
            SELECT * FROM (
                SELECT DISTINCT ON (wh.media_id)
                    wh.title, wh.completion_percentage AS completion, wh.session_end_time AS ended_at
                FROM watch_history wh JOIN media_items mi ON mi.id = wh.media_id
                WHERE wh.user_id = ${ctx.userId}::uuid AND wh.media_id IS NOT NULL AND ${condition}
                  ${excludeFinished}
                  ${buildLibraryAccessFilter(ctx.sql, access.library)}${buildSeriesOwnedAgeRatingFilter(ctx.sql, access.age)}
                ORDER BY wh.media_id, wh.session_end_time DESC NULLS LAST
            ) latest
            ORDER BY latest.ended_at DESC NULLS LAST
            LIMIT ${args.limit ?? 10}`;
        const limit = args.limit ?? 10;
        return {
            summaryForModel: JSON.stringify({
                mode: args.mode,
                // Reported twice on prod as a census — "du hast zehn Titel
                // abgebrochen" where ten was the page size.
                ...resultCounts(rows.length, limit),
                results: rows.map((r) => ({
                    title: r.title,
                    completionPercentage: r.completion === null ? null : Number(r.completion),
                    lastSessionAt: r.ended_at,
                })),
            }),
        };
    },
};
