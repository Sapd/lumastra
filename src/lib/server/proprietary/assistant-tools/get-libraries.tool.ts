// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * `get_libraries` tool — list the media libraries the user can access, with
 * item counts and the media types each holds. Access-scoped via
 * `getLibraryGroupsWithCounts` (honours denied groups + age rating).
 *
 * TEXT-ONLY (no media cards).
 *
 * @module server/proprietary/assistant-tools/get-libraries.tool
 */

import {
    getLibrariesArgsSchema,
    ASSISTANT_TOOL_NAMES,
    type GetLibrariesArgs,
} from '../../../schemas/assistant-tools.js';
import { getLibraryGroupsWithCounts } from '../../database/queries/library-groups.queries.js';
import type { AssistantTool, AssistantToolContext, AssistantToolExecuteResult } from './types.js';
import { completeResultCounts } from './result-counts.js';

export const getLibrariesTool: AssistantTool<GetLibrariesArgs> = {
    name: ASSISTANT_TOOL_NAMES.GET_LIBRARIES,
    description:
        'List the media libraries the user can access (name, how many items, and which media types each holds, e.g. movies/tv/music). Use when the user asks what libraries exist or what is in a given library.',
    argsSchema: getLibrariesArgsSchema,

    async execute(
        _args: GetLibrariesArgs,
        ctx: AssistantToolContext,
    ): Promise<AssistantToolExecuteResult> {
        const rows = await getLibraryGroupsWithCounts(
            ctx.sql,
            ctx.accessCtx.deniedGroupIds,
            ctx.accessCtx.ageRating?.maxAgeRating ?? null,
        );

        const summaryForModel = JSON.stringify({
            // Unpaged: these are all the libraries the caller can reach.
            ...completeResultCounts(rows.length),
            libraries: rows.map((r) => ({
                name: r.name,
                itemCount: r.item_count,
                mediaTypes: r.media_types,
            })),
        });

        ctx.logger?.debug('get_libraries executed', {
            userId: ctx.userId,
            libraries: rows.length,
        });

        return { summaryForModel };
    },
};
