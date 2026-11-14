// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * `search_library` tool — semantic/vector search over the user's accessible
 * library. This is the PRIMARY tool and the source of recommended cards.
 *
 * REFERENCE IMPLEMENTATION: other tools follow this exact shape —
 *   1. an `AssistantTool` object literal with `name`, `description`,
 *      `argsSchema` (from `schemas/assistant-tools`), and `execute`;
 *   2. `execute` threads `ctx.accessCtx` into an EXISTING access-scoped query
 *      module — never raw SQL — projecting it onto the required-by-shape
 *      boundary via `searchAccessBoundary(ctx.accessCtx)` rather than passing
 *      `deniedGroupIds` / `ageRating` as a hand-assembled pair;
 *   3. it returns `summaryForModel` (compact JSON via `summarizeMediaForModel`)
 *      and, for card-worthy tools, the raw `media` rows.
 *
 * @module server/assistant/assistant-tools/search-library.tool
 */

import {
    searchLibraryArgsSchema,
    ASSISTANT_TOOL_NAMES,
    type SearchLibraryArgs,
} from '../../../schemas/assistant-tools.js';
import {
    findRelevantMediaByVector,
    searchMediaByTitle,
    type AssistantMovieRow,
} from '../../database/queries/assistant-rag.queries.js';
import { searchAccessBoundary } from '../../utils/search-access-context.js';
import type { AssistantTool, AssistantToolContext, AssistantToolExecuteResult } from './types.js';
import { summarizeMediaForModel } from './media-summary.js';

const DEFAULT_LIMIT = 8;

export const searchLibraryTool: AssistantTool<SearchLibraryArgs> = {
    name: ASSISTANT_TOOL_NAMES.SEARCH_LIBRARY,
    description:
        'Search the catalogue the user is allowed to see. Works for taste/theme/vibe queries ("movies like Inception", "cozy mysteries") AND exact titles ("Stromberg") — a lexical title match is merged ahead of semantic results. Returns matching titles with availability — these become the recommended cards. Results are access-scoped; never claim a title exists that this did not return.',
    argsSchema: searchLibraryArgsSchema,

    async execute(
        args: SearchLibraryArgs,
        ctx: AssistantToolContext,
    ): Promise<AssistantToolExecuteResult> {
        const limit = args.limit ?? DEFAULT_LIMIT;
        const mediaTypes = args.mediaType ? [args.mediaType] : ['movie', 'tv'];

        const queryEmbeddingStr = await ctx.embedQuery(args.query);

        // Vector (semantic) + exact-title (lexical) in parallel. Vector search
        // is lexically blind — it won't reliably surface an exact title like
        // "Stromberg" — so the title match is the safety net regardless of
        // which tool the model picked.
        const [vectorRows, titleRows] = await Promise.all([
            findRelevantMediaByVector(ctx.sql, {
                queryEmbeddingStr,
                userId: ctx.userId,
                access: searchAccessBoundary(ctx.accessCtx),
                mediaTypes,
            }),
            searchMediaByTitle(ctx.sql, {
                title: args.query,
                access: searchAccessBoundary(ctx.accessCtx),
            }),
        ]);

        const ranked = vectorRows
            .map((row) => ({ ...row, similarity: Number(row.similarity ?? 0) }))
            .sort((a, b) => a.similarity - b.similarity);

        // Available title matches within the requested media type go first.
        const titleMatches = titleRows.filter(
            (r) => r.is_available && mediaTypes.includes(r.media_type),
        );

        const seen = new Set<string>();
        const media: AssistantMovieRow[] = [];
        for (const row of [...titleMatches, ...ranked]) {
            const key = row.primary_ext_id
                ? `${row.primary_ext_id}:${row.media_type}`
                : String(row.media_id ?? `${row.title}:${row.media_type}`);
            if (seen.has(key)) continue;
            seen.add(key);
            media.push(row);
            if (media.length >= limit) break;
        }

        ctx.logger?.debug('search_library executed', {
            query: args.query,
            mediaType: args.mediaType ?? 'any',
            titleMatches: titleMatches.length,
            returned: media.length,
        });

        return {
            summaryForModel: summarizeMediaForModel(media, limit),
            media,
        };
    },
};
