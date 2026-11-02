// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: LicenseRef-Lumastra-Proprietary
// Proprietary and source-available — not licensed under AGPL. See LICENSING.md.

/**
 * `browse_by_keyword` tool — find library titles tagged with a keyword/tag
 * (e.g. "whodunit", "heist"). Precise boolean tag match over mdblist/TMDB
 * keywords — more exact than the semantic `search_library` for tag queries.
 * Card-bearing, access-scoped, ghost-excluded.
 *
 * @module server/proprietary/assistant-tools/browse-by-keyword.tool
 */

import {
    browseByKeywordArgsSchema,
    ASSISTANT_TOOL_NAMES,
    type BrowseByKeywordArgs,
} from '../../../schemas/assistant-tools.js';
import {
    findMediaByKeyword,
    type AssistantMovieRow,
} from '../../database/queries/assistant-rag.queries.js';
import { searchAccessBoundary } from '../../utils/search-access-context.js';
import type { AssistantTool, AssistantToolContext, AssistantToolExecuteResult } from './types.js';
import { summarizeMediaForModel } from './media-summary.js';

const DEFAULT_LIMIT = 10;

export const browseByKeywordTool: AssistantTool<BrowseByKeywordArgs> = {
    name: ASSISTANT_TOOL_NAMES.BROWSE_BY_KEYWORD,
    description:
        'Find titles in the library tagged with keyword(s)/tag(s) such as "whodunit", "heist", "time travel". Pass close synonyms together (e.g. ["whodunit","murder mystery","detective"]) to widen recall — tag coverage varies per title. Exact tag match; for broad themes also consider search_library. Returns matching titles as cards.',
    argsSchema: browseByKeywordArgsSchema,

    async execute(
        args: BrowseByKeywordArgs,
        ctx: AssistantToolContext,
    ): Promise<AssistantToolExecuteResult> {
        const media: AssistantMovieRow[] = await findMediaByKeyword(ctx.sql, {
            keywords: args.keywords,
            mediaTypes: args.mediaType ? [args.mediaType] : ['movie', 'tv'],
            limit: args.limit ?? DEFAULT_LIMIT,
            userId: ctx.userId,
            access: searchAccessBoundary(ctx.accessCtx),
        });

        ctx.logger?.debug('browse_by_keyword executed', {
            keywords: args.keywords,
            returned: media.length,
        });

        return {
            summaryForModel: summarizeMediaForModel(media, args.limit ?? DEFAULT_LIMIT),
            media,
        };
    },
};
