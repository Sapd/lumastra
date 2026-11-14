// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * `get_watch_stats` tool — coarse all-time watched count for the calling user.
 *
 * ACCESS: the three count queries have no `media_items` row in scope and so
 * cannot express the library/age predicates (see the user-watch-history module
 * docstring). They therefore take an explicit `unrestrictedAccess()` boundary,
 * which preserves the pre-boundary behaviour byte-for-byte.
 *
 * KNOWN GAP, deliberately unchanged: the returned count therefore includes items
 * in library groups the caller's current membership would deny. It is a coarse
 * aggregate over the user's OWN activity and leaks no titles or ids, but it is a
 * real (small) discrepancy. Closing it needs `JOIN media_items` in all three
 * queries — a behaviour change, and so its own PR.
 *
 * @module server/assistant/assistant-tools/get-watch-stats.tool
 */

import {
    getWatchStatsArgsSchema,
    ASSISTANT_TOOL_NAMES,
    type GetWatchStatsArgs,
} from '../../../schemas/assistant-tools.js';
import {
    getWatchedCount,
    getWatchedMovieCount,
    getWatchedTvCount,
} from '../../database/queries/user-watch-history.queries.js';
import { unrestrictedAccess } from '../../database/queries/builders/media-access-boundary.js';
import type { AssistantTool, AssistantToolContext, AssistantToolExecuteResult } from './types.js';

export const getWatchStatsTool: AssistantTool<GetWatchStatsArgs> = {
    name: ASSISTANT_TOOL_NAMES.GET_WATCH_STATS,
    description:
        'Returns an ALL-TIME count of how much the user has watched, optionally filtered to movies or tv. Per-period (e.g. "this month") and group-by breakdowns are NOT available.',
    argsSchema: getWatchStatsArgsSchema,

    async execute(
        args: GetWatchStatsArgs,
        ctx: AssistantToolContext,
    ): Promise<AssistantToolExecuteResult> {
        const userId = ctx.userId;
        let row: { count: number } | null;

        // Explicit and unenforceable — see the module docstring. `ctx.accessCtx`
        // is in scope but must NOT be passed: these queries cannot bind the
        // predicates, and the boundary type rejects a restricted value here
        // rather than silently ignoring it.
        const access = unrestrictedAccess();

        if (args.mediaType === 'movie') {
            row = await getWatchedMovieCount.one(ctx.sql, { userId, access });
        } else if (args.mediaType === 'tv') {
            row = await getWatchedTvCount.one(ctx.sql, { userId, access });
        } else {
            row = await getWatchedCount.one(ctx.sql, { userId, access });
        }

        const watchedCount = row?.count ?? 0;

        const summaryForModel = JSON.stringify({
            mediaType: args.mediaType ?? 'all',
            watchedCount,
            note: 'All-time count. Per-period (e.g. this month) and group-by breakdowns are not available.',
        });

        return { summaryForModel };
    },
};
