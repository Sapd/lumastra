// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * `get_music_picks` tool — personalized "quick picks" music recommendations
 * (the same engine that powers the music Quick Picks). Access-scoped.
 * TEXT-ONLY (music isn't a movie/tv card).
 *
 * @module server/assistant/assistant-tools/get-music-picks.tool
 */

import {
    getMusicPicksArgsSchema,
    ASSISTANT_TOOL_NAMES,
    type GetMusicPicksArgs,
} from '../../../schemas/assistant-tools.js';
import {
    getQuickPicks,
    hasMusicListeningHistory,
} from '../../services/music/quick-picks.service.js';
import type { AssistantTool, AssistantToolContext, AssistantToolExecuteResult } from './types.js';
import { musicCardFromTrackRow } from './music-card-builder.js';
import { resultCounts } from './result-counts.js';

const DEFAULT_LIMIT = 12;

export const getMusicPicksTool: AssistantTool<GetMusicPicksArgs> = {
    name: ASSISTANT_TOOL_NAMES.GET_MUSIC_PICKS,
    description:
        'Return personalized MUSIC recommendations ("quick picks") tailored to the user\'s listening taste. Use for "recommend me some music", "what should I listen to", or music suggestions.',
    argsSchema: getMusicPicksArgsSchema,

    async execute(
        args: GetMusicPicksArgs,
        ctx: AssistantToolContext,
    ): Promise<AssistantToolExecuteResult> {
        const limit = args.limit ?? DEFAULT_LIMIT;
        const [rows, hasMusicHistory] = await Promise.all([
            getQuickPicks(ctx.sql, ctx.userId, limit, [], {
                deniedGroupIds: ctx.accessCtx.deniedGroupIds,
                ageRating: ctx.accessCtx.ageRating,
            }),
            hasMusicListeningHistory(ctx.sql, ctx.userId),
        ]);
        const isColdStart = !hasMusicHistory;

        const summaryForModel = JSON.stringify({
            ...resultCounts(rows.length, limit),
            // These picks are TASTE-based and never mood-, genre- or era-aware.
            // That caveat used to fire only on cold start, so a user with
            // listening history who asked for "Musik zum Kochen" got taste picks
            // presented as mood picks with nothing to contradict it.
            note: isColdStart
                ? 'This user has no listening history — these are general library picks, NOT personalized and NOT mood-filtered. Say so; do not present them as matching a requested mood.'
                : 'These are TASTE-based picks. They are NOT filtered by mood, genre, era or any other criterion the user may have named. If the user asked for a specific mood/genre/decade, say plainly that you cannot filter music that way rather than implying these match.',
            picks: rows.map((t) => ({
                title: t.title,
                artist: t.artist_title ?? undefined,
                album: t.album_title ?? undefined,
                reason: t.bucket,
            })),
        });

        ctx.logger?.debug('get_music_picks executed', {
            userId: ctx.userId,
            returned: rows.length,
        });

        return {
            summaryForModel,
            music: rows.map((t) => musicCardFromTrackRow(t, t.bucket)),
        };
    },
};
