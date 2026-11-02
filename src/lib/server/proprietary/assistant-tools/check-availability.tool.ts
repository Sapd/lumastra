// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: LicenseRef-Lumastra-Proprietary
// Proprietary and source-available — not licensed under AGPL. See LICENSING.md.

/**
 * `check_availability` tool — resolve a specific title (optionally by year)
 * to a concrete library item with watch/request status.
 *
 * @module server/proprietary/assistant-tools/check-availability.tool
 */

import {
    checkAvailabilityArgsSchema,
    ASSISTANT_TOOL_NAMES,
    type CheckAvailabilityArgs,
} from '../../../schemas/assistant-tools.js';
import {
    searchMediaByTitle,
    type AssistantMovieRow,
} from '../../database/queries/assistant-rag.queries.js';
import { searchAccessBoundary } from '../../utils/search-access-context.js';
import type { AssistantTool, AssistantToolContext, AssistantToolExecuteResult } from './types.js';
import { summarizeMediaForModel } from './media-summary.js';

export const checkAvailabilityTool: AssistantTool<CheckAvailabilityArgs> = {
    name: ASSISTANT_TOOL_NAMES.CHECK_AVAILABILITY,
    description:
        "Check whether a SPECIFIC named title is in the user's accessible library and whether it can be watched or requested. Returns availability information plus the item as a card. Use when the user asks about a specific title by name (e.g. 'Is The Matrix available?').",
    argsSchema: checkAvailabilityArgsSchema,

    async execute(
        args: CheckAvailabilityArgs,
        ctx: AssistantToolContext,
    ): Promise<AssistantToolExecuteResult> {
        const rows: AssistantMovieRow[] = await searchMediaByTitle(ctx.sql, {
            title: args.title,
            year: args.year,
            access: searchAccessBoundary(ctx.accessCtx),
        });

        ctx.logger?.debug('check_availability executed', {
            title: args.title,
            found: rows.length,
        });

        return {
            summaryForModel: summarizeMediaForModel(rows),
            media: rows,
        };
    },
};
