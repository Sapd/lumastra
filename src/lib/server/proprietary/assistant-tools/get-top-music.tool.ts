// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: LicenseRef-Lumastra-Proprietary
// Proprietary and source-available — not licensed under AGPL. See LICENSING.md.

/**
 * `get_top_music` tool — the user's most-played tracks (their listening
 * history / taste in music). TEXT-ONLY (music isn't a movie/tv card).
 *
 * @module server/proprietary/assistant-tools/get-top-music.tool
 */

import {
    getTopMusicArgsSchema,
    ASSISTANT_TOOL_NAMES,
    type GetTopMusicArgs,
} from '../../../schemas/assistant-tools.js';
import {
    getMostPlayedTracks,
    getHotThisWeek,
} from '../../database/queries/music-quick-picks.queries.js';
import type { AssistantTool, AssistantToolContext, AssistantToolExecuteResult } from './types.js';
import { musicCardFromTrackRow } from './music-card-builder.js';
import { resultCounts } from './result-counts.js';

const DEFAULT_LIMIT = 15;

/** Trailing-window sizes for the period arg. `all` has no window. */
const PERIOD_DAYS: Record<string, number> = { '7d': 7, '30d': 30, '90d': 90, '1y': 365 };

export const getTopMusicTool: AssistantTool<GetTopMusicArgs> = {
    name: ASSISTANT_TOOL_NAMES.GET_TOP_MUSIC,
    description:
        'Return the user\'s most-played MUSIC tracks (their top songs / listening history). Pass a period for "top songs this year / month / week" — 7d, 30d, 90d, 1y, or all (default, all-time). Use for "what are my top songs" or "what music do I listen to most".',
    argsSchema: getTopMusicArgsSchema,

    async execute(
        args: GetTopMusicArgs,
        ctx: AssistantToolContext,
    ): Promise<AssistantToolExecuteResult> {
        // All-time counts live on user_music_state; a real trailing window has
        // to be aggregated from the music_listen_events log instead. Without
        // this the tool only ever returned all-time, so "meine Top-Songs dieses
        // Jahr" got a lifetime list presented as this year's.
        const limit = args.limit ?? DEFAULT_LIMIT;
        const windowDays = args.period ? PERIOD_DAYS[args.period] : undefined;
        const rows = windowDays
            ? await getHotThisWeek(
                  ctx.sql,
                  ctx.userId,
                  windowDays,
                  limit,
                  ctx.accessCtx.deniedGroupIds,
                  ctx.accessCtx.ageRating,
              )
            : await getMostPlayedTracks(
                  ctx.sql,
                  ctx.userId,
                  limit,
                  ctx.accessCtx.deniedGroupIds,
                  ctx.accessCtx.ageRating,
              );

        const summaryForModel = JSON.stringify({
            ...resultCounts(rows.length, limit),
            period: args.period ?? 'all',
            periodNote: windowDays
                ? `Play counts over the last ${windowDays} days only.`
                : 'ALL-TIME play counts, not a recent period. If the user asked about a specific period, say this is all-time or call again with a period.',
            tracks: rows.map((t) => ({
                title: t.title,
                artist: t.artist_title ?? undefined,
                album: t.album_title ?? undefined,
            })),
        });

        ctx.logger?.debug('get_top_music executed', {
            userId: ctx.userId,
            returned: rows.length,
        });

        return {
            summaryForModel,
            music: rows.map((t) => musicCardFromTrackRow(t)),
        };
    },
};
