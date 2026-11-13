// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * `browse_by_genre` tool — find library titles in a genre/category (e.g.
 * "Family"/"Kids" for kids shows, "Horror", "Comedy"). Card-bearing,
 * access-scoped, ghost-excluded. Better than semantic search for "what
 * <genre> do I have" requests.
 *
 * @module server/proprietary/assistant-tools/browse-by-genre.tool
 */

import {
    browseByGenreArgsSchema,
    ASSISTANT_TOOL_NAMES,
    type BrowseByGenreArgs,
} from '../../../schemas/assistant-tools.js';
import {
    findMediaByGenre,
    type AssistantMovieRow,
} from '../../database/queries/assistant-rag.queries.js';
import { searchAccessBoundary } from '../../utils/search-access-context.js';
import type { AssistantTool, AssistantToolContext, AssistantToolExecuteResult } from './types.js';
import { summarizeMediaForModel } from './media-summary.js';

const DEFAULT_LIMIT = 10;

export const browseByGenreTool: AssistantTool<BrowseByGenreArgs> = {
    name: ASSISTANT_TOOL_NAMES.BROWSE_BY_GENRE,
    description:
        'Find titles in the library by GENRE/category. Pass one or more English TMDB genre names (a title matching ANY is returned) plus the mediaType — e.g. kids series → genres ["Kids","Family","Animation"], mediaType "tv"; horror → genres ["Horror"], mediaType "movie". Returns matching titles as cards.',
    argsSchema: browseByGenreArgsSchema,

    async execute(
        args: BrowseByGenreArgs,
        ctx: AssistantToolContext,
    ): Promise<AssistantToolExecuteResult> {
        const media: AssistantMovieRow[] = await findMediaByGenre(ctx.sql, {
            genres: args.genres,
            mediaTypes: args.mediaType ? [args.mediaType] : ['movie', 'tv'],
            limit: args.limit ?? DEFAULT_LIMIT,
            userId: ctx.userId,
            access: searchAccessBoundary(ctx.accessCtx),
        });

        ctx.logger?.debug('browse_by_genre executed', {
            genres: args.genres,
            returned: media.length,
        });

        return {
            summaryForModel: summarizeMediaForModel(media, args.limit ?? DEFAULT_LIMIT),
            media,
        };
    },
};
