// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * `get_series_episodes` tool — a series' episodes with the user's watched
 * status, so "which episodes of X haven't I watched" is answerable from real
 * watch state. Resolves the series via the access-scoped title search, then
 * reads per-episode watch state. TEXT-ONLY.
 *
 * @module server/proprietary/assistant-tools/get-series-episodes.tool
 */

import {
    getSeriesEpisodesArgsSchema,
    ASSISTANT_TOOL_NAMES,
    type GetSeriesEpisodesArgs,
} from '../../../schemas/assistant-tools.js';
import { searchMediaByTitle } from '../../database/queries/assistant-rag.queries.js';
import { getSeriesEpisodesWithWatchState } from '../../database/queries/episode-detail.queries.js';
import { searchAccessBoundary } from '../../utils/search-access-context.js';
import type { AssistantTool, AssistantToolContext, AssistantToolExecuteResult } from './types.js';

const MAX_LISTED = 80;

export const getSeriesEpisodesTool: AssistantTool<GetSeriesEpisodesArgs> = {
    name: ASSISTANT_TOOL_NAMES.GET_SERIES_EPISODES,
    description:
        'List a series\' episodes with the user\'s watched/unwatched status. Use for "which episodes of X haven\'t I watched", "what\'s left to watch in X", or per-season progress. Returns the unwatched episodes plus watched/total counts.',
    argsSchema: getSeriesEpisodesArgsSchema,

    async execute(
        args: GetSeriesEpisodesArgs,
        ctx: AssistantToolContext,
    ): Promise<AssistantToolExecuteResult> {
        // Resolve the series via the access-scoped title search.
        const matches = await searchMediaByTitle(ctx.sql, {
            title: args.title,
            mediaTypes: ['tv'],
            access: searchAccessBoundary(ctx.accessCtx),
        });
        const series = matches.find((m) => m.media_type === 'tv') ?? matches[0];

        if (!series?.media_id) {
            return {
                summaryForModel: JSON.stringify({
                    found: false,
                    note: `No accessible series matching "${args.title}".`,
                }),
            };
        }

        const episodes = await getSeriesEpisodesWithWatchState(
            ctx.sql,
            series.media_id,
            ctx.userId,
            args.season,
        );

        const unwatched = episodes.filter((e) => !e.is_watched);

        const summaryForModel = JSON.stringify({
            found: true,
            series: series.title,
            season: args.season ?? 'all',
            totalEpisodes: episodes.length,
            watchedCount: episodes.length - unwatched.length,
            unwatchedCount: unwatched.length,
            unwatched: unwatched.slice(0, MAX_LISTED).map((e) => ({
                season: e.season_number,
                episode: e.episode_number,
                title: e.title ?? undefined,
            })),
            truncated: unwatched.length > MAX_LISTED,
        });

        ctx.logger?.debug('get_series_episodes executed', {
            title: args.title,
            resolved: series.title,
            episodes: episodes.length,
            unwatched: unwatched.length,
        });

        return { summaryForModel };
    },
};
