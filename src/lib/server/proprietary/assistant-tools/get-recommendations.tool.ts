// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: LicenseRef-Lumastra-Proprietary
// Proprietary and source-available — not licensed under AGPL. See LICENSING.md.

/**
 * `get_recommendations` tool — taste-aware picks for open-ended requests
 * ("what should I watch", "surprise me"). Seeds a vector search from the
 * user's own high ratings (so it needs no query from the user), excludes
 * titles they've already rated, and — like all card tools — is access-scoped
 * and ghost-excluded. An optional mood steers the vibe; cold-start (no
 * ratings) falls back to broadly acclaimed picks.
 *
 * @module server/proprietary/assistant-tools/get-recommendations.tool
 */

import {
    getRecommendationsArgsSchema,
    ASSISTANT_TOOL_NAMES,
    type GetRecommendationsArgs,
} from '../../../schemas/assistant-tools.js';
import {
    findRelevantMediaByVector,
    type AssistantMovieRow,
} from '../../database/queries/assistant-rag.queries.js';
import { getUserRatingsFullMetadata } from '../../database/queries/user-ratings.queries.js';
import { searchAccessBoundary } from '../../utils/search-access-context.js';
import type { AssistantTool, AssistantToolContext, AssistantToolExecuteResult } from './types.js';
import { summarizeMediaForModel } from './media-summary.js';

const DEFAULT_LIMIT = 8;
const LIKED_RATING_MIN = 7;

export const getRecommendationsTool: AssistantTool<GetRecommendationsArgs> = {
    name: ASSISTANT_TOOL_NAMES.GET_RECOMMENDATIONS,
    description:
        'Personalized recommendations for open-ended requests like "what should I watch today" or "surprise me", when the user has NOT named a specific title or theme to search. Uses the user\'s own ratings to tailor picks (an optional mood steers the vibe). Returns available titles as cards.',
    argsSchema: getRecommendationsArgsSchema,

    async execute(
        args: GetRecommendationsArgs,
        ctx: AssistantToolContext,
    ): Promise<AssistantToolExecuteResult> {
        const limit = args.limit ?? DEFAULT_LIMIT;
        const mediaTypes = args.mediaType ? [args.mediaType] : ['movie', 'tv'];

        // Taste signal: the user's own highly-rated titles (access-scoped).
        const liked = await getUserRatingsFullMetadata.all(ctx.sql, {
            userId: ctx.userId,
            ratingMin: LIKED_RATING_MIN,
            limit: 20,
            access: searchAccessBoundary(ctx.accessCtx),
        });
        const likedTitles = liked.map((l) => l.title).filter((t): t is string => Boolean(t));

        const seed = args.mood
            ? likedTitles.length > 0
                ? `${args.mood} — similar in taste to ${likedTitles.slice(0, 4).join(', ')}`
                : args.mood
            : likedTitles.length > 0
              ? `movies and shows similar to ${likedTitles.slice(0, 5).join(', ')}`
              : 'critically acclaimed, popular, highly rated';

        const queryEmbeddingStr = await ctx.embedQuery(seed);
        const rows = await findRelevantMediaByVector(ctx.sql, {
            queryEmbeddingStr,
            userId: ctx.userId,
            access: searchAccessBoundary(ctx.accessCtx),
            mediaTypes,
            // Default: don't recommend titles the user has already watched.
            // Only include them when the user explicitly asked for rewatches.
            excludeWatched: !args.includeWatched,
        });

        // Don't recommend something they've already rated.
        const ratedKeys = new Set(liked.map((l) => `${l.primary_ext_id}:${l.media_type}`));

        const media: AssistantMovieRow[] = rows
            .map((r) => ({ ...r, similarity: Number(r.similarity ?? 0) }))
            .sort((a, b) => a.similarity - b.similarity)
            .filter((r) => !ratedKeys.has(`${r.primary_ext_id}:${r.media_type}`))
            .slice(0, limit);

        ctx.logger?.debug('get_recommendations executed', {
            mood: args.mood ?? 'taste-only',
            tasteSeeds: likedTitles.length,
            returned: media.length,
        });

        return {
            summaryForModel: summarizeMediaForModel(media, limit),
            media,
        };
    },
};
