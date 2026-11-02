// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: LicenseRef-Lumastra-Proprietary
// Proprietary and source-available — not licensed under AGPL. See LICENSING.md.

/**
 * `get_my_ratings` tool — return the calling user's own rated titles.
 * This is a TEXT-ONLY tool (no media cards); it provides a taste signal
 * the model can use to tailor recommendations.
 *
 * @module server/proprietary/assistant-tools/get-my-ratings.tool
 */

import {
    getMyRatingsArgsSchema,
    ASSISTANT_TOOL_NAMES,
    type GetMyRatingsArgs,
} from '../../../schemas/assistant-tools.js';
import {
    getUserRatingsFullMetadata,
    type UserRatingFullRow,
} from '../../database/queries/user-ratings.queries.js';
import { searchAccessBoundary } from '../../utils/search-access-context.js';
import type { AssistantTool, AssistantToolContext, AssistantToolExecuteResult } from './types.js';
import { resultCounts } from './result-counts.js';

const DEFAULT_LIMIT = 20;

export const getMyRatingsTool: AssistantTool<GetMyRatingsArgs> = {
    name: ASSISTANT_TOOL_NAMES.GET_MY_RATINGS,
    description:
        "Return the user's OWN star ratings (their taste profile). Use this to understand what the user likes or dislikes so you can tailor recommendations. This is NOT a search tool — it only surfaces titles the user has already rated.",
    argsSchema: getMyRatingsArgsSchema,

    async execute(
        args: GetMyRatingsArgs,
        ctx: AssistantToolContext,
    ): Promise<AssistantToolExecuteResult> {
        const limit = args.limit ?? DEFAULT_LIMIT;
        const rows: UserRatingFullRow[] = await getUserRatingsFullMetadata.all(ctx.sql, {
            userId: ctx.userId,
            ratingMin: args.minRating ?? 1,
            limit,
            access: searchAccessBoundary(ctx.accessCtx),
        });

        const summaryForModel = JSON.stringify({
            ...resultCounts(rows.length, limit),
            results: rows.map((r) => ({
                title: r.title,
                mediaType: r.media_type,
                yourRating: r.rating,
                isAvailable: r.is_available,
                canRequest: r.can_request,
            })),
        });

        ctx.logger?.debug('get_my_ratings executed', {
            userId: ctx.userId,
            returned: rows.length,
        });

        return { summaryForModel };
    },
};
