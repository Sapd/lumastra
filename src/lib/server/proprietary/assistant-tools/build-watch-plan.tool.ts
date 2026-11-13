// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * `build_watch_plan` — a real, runtime-budgeted watchlist from unwatched
 * library candidates.
 *
 * @module server/proprietary/assistant-tools/build-watch-plan
 */

import {
    ASSISTANT_TOOL_NAMES,
    buildWatchPlanArgsSchema,
    type BuildWatchPlanArgs,
} from '../../../schemas/assistant-tools.js';
import {
    findMediaByConstraints,
    type AssistantMovieRow,
} from '../../database/queries/assistant-rag.queries.js';
import { searchAccessBoundary } from '../../utils/search-access-context.js';
import { toMediaSummary } from './media-summary.js';
import type { AssistantTool, AssistantToolContext, AssistantToolExecuteResult } from './types.js';

/**
 * Lower-cased genre labels for one row, tolerant of every shape
 * `provider_metadata.metadata->'genres'` is stored in: `[{id,name}]` objects,
 * bare `["Comedy"]` strings, and bare `[35]` ids (which stringify to their id
 * and so still separate one genre from another).
 */
function genreLabels(row: AssistantMovieRow): string[] {
    const raw: unknown = row.genres;
    if (!Array.isArray(raw)) return [];
    return raw
        .map((g): string => {
            if (typeof g === 'string') return g.toLowerCase();
            if (typeof g === 'number') return String(g);
            if (g && typeof g === 'object' && 'name' in g) {
                const name = (g as { name?: unknown }).name;
                return typeof name === 'string' ? name.toLowerCase() : '';
            }
            return '';
        })
        .filter((g) => g !== '');
}

export const buildWatchPlanTool: AssistantTool<BuildWatchPlanArgs> = {
    name: ASSISTANT_TOOL_NAMES.BUILD_WATCH_PLAN,
    description:
        "Build a real watchlist or movie marathon from the caller's unwatched library within a time budget. Use for “a six-hour marathon”, “three films for a flight”, or “what can we finish tonight”. It selects factual candidates only; explain if the available runtimes cannot fill the budget exactly.",
    argsSchema: buildWatchPlanArgsSchema,
    async execute(
        args: BuildWatchPlanArgs,
        ctx: AssistantToolContext,
    ): Promise<AssistantToolExecuteResult> {
        const itemCount = args.itemCount ?? 3;
        const candidates = await findMediaByConstraints(ctx.sql, {
            userId: ctx.userId,
            access: searchAccessBoundary(ctx.accessCtx),
            mediaType: args.mediaType,
            genres: args.genres,
            minRtRating: args.minRtRating,
            minImdbRating: args.minImdbRating,
            watched: false,
            limit: 20,
        });
        const chosen: AssistantMovieRow[] = [];
        // Genres already represented in the plan. `diverse` used to compare
        // JSON.stringify(genres) — byte equality, so "Action,Comedy" and
        // "Comedy,Action" counted as different and the mode was close to a
        // no-op. Overlap on any single genre is what "deliberately different
        // picks" means.
        const usedGenres = new Set<string>();
        // A genre the caller ASKED for cannot be what makes two picks alike.
        // Every candidate carries it by construction, so counting it meant the
        // first pick consumed it and disqualified all twenty of the others:
        // `diverse` + `genres: ['action']` returned a one-film "marathon" no
        // matter what itemCount or targetMinutes said.
        const requestedGenres = new Set((args.genres ?? []).map((g) => g.toLowerCase()));
        let totalMinutes = 0;
        for (const item of candidates) {
            if (chosen.length >= itemCount) break;
            const runtime = item.runtime_minutes ?? 0;
            const labels = genreLabels(item);
            if (
                runtime <= 0 ||
                totalMinutes + runtime > args.targetMinutes ||
                (args.selectionMode === 'diverse' && labels.some((g) => usedGenres.has(g)))
            )
                continue;
            chosen.push(item);
            for (const g of labels) if (!requestedGenres.has(g)) usedGenres.add(g);
            totalMinutes += runtime;
        }
        return {
            summaryForModel: JSON.stringify({
                targetMinutes: args.targetMinutes,
                totalMinutes,
                remainingMinutes: args.targetMinutes - totalMinutes,
                // Named for what it is — how many titles this plan holds. A
                // bare `count` next to a list is the shape the model kept
                // relaying as a library total.
                plannedItemCount: chosen.length,
                exactFit: totalMinutes === args.targetMinutes,
                // runtimeMinutes now comes from the shared summary — it used to
                // be re-added here because toMediaSummary dropped it.
                items: chosen.map(toMediaSummary),
            }),
            media: chosen,
        };
    },
};
