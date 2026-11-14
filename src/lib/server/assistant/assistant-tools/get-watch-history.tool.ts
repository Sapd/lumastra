// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * `get_watch_history` tool — returns the calling user's recently watched titles.
 */

import {
    getWatchHistoryArgsSchema,
    ASSISTANT_TOOL_NAMES,
    type GetWatchHistoryArgs,
} from '../../../schemas/assistant-tools.js';
import { getRecentWatchedWithTitles } from '../../database/queries/user-watch-history.queries.js';
import { searchAccessBoundary } from '../../utils/search-access-context.js';
import type { AssistantTool, AssistantToolContext, AssistantToolExecuteResult } from './types.js';
import { resultCounts } from './result-counts.js';

/**
 * IMPORTANT scoping note: the backing query returns only the user's OWN watch
 * history, but it IS library-access-scoped — a title the user watched may since
 * have moved into a library group now denied to them, and it must not be
 * surfaced. The library axis is threaded from `ctx.accessCtx` below.
 *
 * The age axis is enforced too — see the comment at the call site for why it
 * used to be pinned open and why that was wrong.
 */
export const getWatchHistoryTool: AssistantTool<GetWatchHistoryArgs> = {
    name: ASSISTANT_TOOL_NAMES.GET_WATCH_HISTORY,
    description:
        "Returns the titles the user has actually WATCHED (most recent first). Use this for questions like 'what have I watched recently?' or any personal watch-history query.",
    argsSchema: getWatchHistoryArgsSchema,

    async execute(
        args: GetWatchHistoryArgs,
        ctx: AssistantToolContext,
    ): Promise<AssistantToolExecuteResult> {
        const limit = args.limit ?? 20;
        const fetchLimit = args.mediaType ? Math.min(50, limit * 3) : limit;

        const rows = await getRecentWatchedWithTitles.all(ctx.sql, {
            userId: ctx.userId,
            limit: fetchLimit,
            // BOTH axes from the real context. The age axis used to be pinned
            // open here on the reasoning that the assistant refuses
            // age-restricted profiles outright — true of the HTTP path, but the
            // plugin bridge de-escalates instead: deEscalateUser sets a real
            // maxAgeRating and keeps isAgeRestricted false precisely so the run
            // proceeds, and that ceiling was then discarded right here.
            access: searchAccessBoundary(ctx.accessCtx),
        });

        const filtered = (
            args.mediaType ? rows.filter((r) => r.media_type === args.mediaType) : rows
        ).slice(0, limit);

        const summaryForModel = JSON.stringify({
            ...resultCounts(filtered.length, limit),
            results: filtered.map((r) => ({
                title: r.title,
                mediaType: r.media_type,
                watchedAt: r.watched_at,
            })),
        });

        return { summaryForModel };
    },
};
