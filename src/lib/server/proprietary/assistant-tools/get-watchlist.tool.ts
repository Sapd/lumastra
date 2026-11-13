// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * `get_watchlist` tool — the movies/shows the user saved to watch later.
 * Card-bearing (returns `media`), access-scoped via `getUserWatchlistMedia`
 * (which keeps the saved row but drops metadata for now-inaccessible titles).
 *
 * @module server/proprietary/assistant-tools/get-watchlist.tool
 */

import {
    getWatchlistArgsSchema,
    ASSISTANT_TOOL_NAMES,
    type GetWatchlistArgs,
} from '../../../schemas/assistant-tools.js';
import { getUserWatchlistMedia } from '../../database/queries/watchlist-media.queries.js';
import type { AssistantMovieRow } from '../../database/queries/assistant-rag.queries.js';
import type { AssistantTool, AssistantToolContext, AssistantToolExecuteResult } from './types.js';
import { summarizeMediaForModel } from './media-summary.js';

const DEFAULT_LIMIT = 30;

export const getWatchlistTool: AssistantTool<GetWatchlistArgs> = {
    name: ASSISTANT_TOOL_NAMES.GET_WATCHLIST,
    description:
        'Return the movies and shows the user has saved to their watchlist (to watch later). Use for questions like "what\'s on my watchlist" or "what did I save". Returns the saved titles as cards.',
    argsSchema: getWatchlistArgsSchema,

    async execute(
        args: GetWatchlistArgs,
        ctx: AssistantToolContext,
    ): Promise<AssistantToolExecuteResult> {
        const limit = args.limit ?? DEFAULT_LIMIT;

        const rows = await getUserWatchlistMedia(ctx.sql, ctx.userId, {
            deniedGroupIds: ctx.accessCtx.deniedGroupIds,
            ageRating: ctx.accessCtx.ageRating,
        });

        // Cards are movie/tv-shaped; restrict accordingly (and honour an
        // explicit mediaType filter). `primary_ext_id` is nullable on the
        // watchlist row (audiobooks — excluded here by `wanted` — have no
        // external_ids row under the primary provider), so also drop the rare
        // movie/tv row resolved only via a non-primary provider (e.g.
        // IMDB-only, no TMDB match): AssistantMovieRow requires it non-null,
        // and a card with no primary provider id has nothing for the model to
        // reference anyway.
        const wanted: string[] = args.mediaType ? [args.mediaType] : ['movie', 'tv'];
        const media: AssistantMovieRow[] = rows
            .filter((r) => wanted.includes(r.media_type) && r.primary_ext_id !== null)
            .slice(0, limit)
            .map((r) => ({
                // Coerce release_date (the watchlist query may return a Date via
                // make_date) to the string the card pipeline expects.
                ...r,
                primary_ext_id: r.primary_ext_id as string,
                release_date:
                    r.release_date instanceof Date
                        ? r.release_date.toISOString().slice(0, 10)
                        : r.release_date,
            }));

        ctx.logger?.debug('get_watchlist executed', {
            userId: ctx.userId,
            total: rows.length,
            returned: media.length,
        });

        return {
            summaryForModel: summarizeMediaForModel(media, limit),
            media,
        };
    },
};
