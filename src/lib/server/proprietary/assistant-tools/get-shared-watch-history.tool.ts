// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/** Consent-gated household watch history for the AI assistant. */

import {
    ASSISTANT_TOOL_NAMES,
    getSharedWatchHistoryArgsSchema,
    type GetSharedWatchHistoryArgs,
} from '../../../schemas/assistant-tools.js';
import { getSharedRecentWatchedWithTitles } from '../../database/queries/user-watch-history.queries.js';
import { searchAccessBoundary } from '../../utils/search-access-context.js';
import type { AssistantTool, AssistantToolContext, AssistantToolExecuteResult } from './types.js';
import { resultCounts } from './result-counts.js';

export const getSharedWatchHistoryTool: AssistantTool<GetSharedWatchHistoryArgs> = {
    name: ASSISTANT_TOOL_NAMES.GET_SHARED_WATCH_HISTORY,
    description:
        "Returns one other household member's watched titles, but only when that person has opted into the server's social-sharing audience. Use for requests such as 'what has Alex watched?' or 'find something neither Alex nor I have seen'. Never use it to probe users who were not named by the user.",
    argsSchema: getSharedWatchHistoryArgsSchema,

    async execute(
        args: GetSharedWatchHistoryArgs,
        ctx: AssistantToolContext,
    ): Promise<AssistantToolExecuteResult> {
        const limit = args.limit ?? 20;
        const fetchLimit = args.mediaType ? Math.min(50, limit * 3) : limit;
        const rows = await getSharedRecentWatchedWithTitles.all(ctx.sql, {
            viewerId: ctx.userId,
            username: args.username,
            limit: fetchLimit,
            // Both axes. Dropping the age ceiling matters more here than on the
            // caller's own history: these are ANOTHER person's titles, so an
            // above-ceiling row is content the caller has never been allowed to
            // see, surfaced by name.
            access: searchAccessBoundary(ctx.accessCtx),
        });
        const results = (
            args.mediaType ? rows.filter((row) => row.media_type === args.mediaType) : rows
        ).slice(0, limit);

        return {
            summaryForModel: JSON.stringify({
                username: args.username,
                ...resultCounts(results.length, limit),
                results: results.map((row) => ({
                    title: row.title,
                    mediaType: row.media_type,
                    watchedAt: row.watched_at,
                })),
                privacyNote:
                    'An empty result can mean this person has not watched anything visible to you, does not exist, or has not shared their history. Do not distinguish these cases.',
            }),
        };
    },
};
