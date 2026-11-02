// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: LicenseRef-Lumastra-Proprietary
// Proprietary and source-available — not licensed under AGPL. See LICENSING.md.

/**
 * `search_tv_guide` tool — full-text search of the Live TV guide (EPG).
 *
 * Wraps `searchProgramsByTextGrouped`, which already excludes hidden channels
 * and programs that ended more than 30 minutes ago, groups by program, and
 * tags each with a temporal status (live / upcoming today / future). Answers
 * "is Bundesliga on soon", "when is Tatort", etc. TEXT-ONLY.
 *
 * Only registered when the caller may view Live TV (`accessCtx.liveTvAllowed`),
 * and defensively re-checks that flag.
 *
 * @module server/proprietary/assistant-tools/search-tv-guide.tool
 */

import {
    searchTvGuideArgsSchema,
    ASSISTANT_TOOL_NAMES,
    type SearchTvGuideArgs,
} from '../../../schemas/assistant-tools.js';
import { searchProgramsByTextGrouped } from '../../database/queries/livetv-programs.queries.js';
import type { AssistantTool, AssistantToolContext, AssistantToolExecuteResult } from './types.js';
import { resultCounts } from './result-counts.js';

const MAX_RESULTS = 20;

/** Normalize a Postgres timestamp string to ISO-8601 (matches whats_on_tv). */
function toIso(ts: string): string {
    const ms = Date.parse(ts);
    return Number.isFinite(ms) ? new Date(ms).toISOString() : ts;
}

export const searchTvGuideTool: AssistantTool<SearchTvGuideArgs> = {
    name: ASSISTANT_TOOL_NAMES.SEARCH_TV_GUIDE,
    description:
        'Search the Live TV guide (EPG) for a show, sports event, team, or topic ("Bundesliga", "Tatort", "Tagesschau"). Returns matching programs with their channel and whether each is live now, later today, or upcoming. Use for "is X on soon", "when is X on TV".',
    argsSchema: searchTvGuideArgsSchema,

    async execute(
        args: SearchTvGuideArgs,
        ctx: AssistantToolContext,
    ): Promise<AssistantToolExecuteResult> {
        if (!ctx.accessCtx.liveTvAllowed) {
            return {
                summaryForModel: JSON.stringify({
                    available: false,
                    note: 'Live TV is not available to this user.',
                }),
            };
        }

        const programs = await searchProgramsByTextGrouped(ctx.sql, args.query, MAX_RESULTS);

        ctx.logger?.debug('search_tv_guide executed', {
            query: args.query,
            results: programs.length,
        });

        return {
            summaryForModel: JSON.stringify({
                available: true,
                found: programs.length > 0,
                query: args.query,
                // The query is LIMITed to MAX_RESULTS — a page of the guide.
                ...resultCounts(programs.length, MAX_RESULTS),
                programs: programs.map((p) => ({
                    title: p.title,
                    status: p.temporal_status,
                    start: toIso(p.start_time),
                    end: toIso(p.end_time),
                    channels: (p.channels ?? []).map((c) => c.name),
                    description: p.description ?? undefined,
                })),
                note:
                    programs.length === 0
                        ? `Nothing in the TV guide matches "${args.query}" in the upcoming window.`
                        : undefined,
            }),
        };
    },
};
