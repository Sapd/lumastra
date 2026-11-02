// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: LicenseRef-Lumastra-Proprietary
// Proprietary and source-available — not licensed under AGPL. See LICENSING.md.

/**
 * `search_music` tool — text search over the user's MUSIC library (tracks,
 * albums, artists). Separate from `search_library` (movies/tv) so a music
 * request returns music and a movie request returns movies.
 *
 * TEXT-ONLY: music is not a movie/tv card, so this returns no `media` — the
 * model relays the matches in its reply.
 *
 * @module server/proprietary/assistant-tools/search-music.tool
 */

import {
    searchMusicArgsSchema,
    ASSISTANT_TOOL_NAMES,
    type SearchMusicArgs,
} from '../../../schemas/assistant-tools.js';
import { searchMusic } from '../../database/queries/search.queries.js';
import { searchAccessBoundary } from '../../utils/search-access-context.js';
import type { AssistantTool, AssistantToolContext, AssistantToolExecuteResult } from './types.js';
import { musicCardFromSearchResult } from './music-card-builder.js';
import { resultCounts } from './result-counts.js';

const DEFAULT_LIMIT = 10;

export const searchMusicTool: AssistantTool<SearchMusicArgs> = {
    name: ASSISTANT_TOOL_NAMES.SEARCH_MUSIC,
    description:
        "Search the user's MUSIC library (tracks, albums, artists) by name or keyword. Use this — NOT search_library — for ANY music / song / album / artist request. Results are access-scoped; never claim music exists that this did not return.",
    argsSchema: searchMusicArgsSchema,

    async execute(
        args: SearchMusicArgs,
        ctx: AssistantToolContext,
    ): Promise<AssistantToolExecuteResult> {
        const limit = args.limit ?? DEFAULT_LIMIT;

        const rows = await searchMusic(
            ctx.sql,
            args.query,
            limit,
            searchAccessBoundary(ctx.accessCtx),
            {
                excludeVariousArtists: true,
            },
        );

        const summaryForModel = JSON.stringify({
            ...resultCounts(rows.length, limit),
            results: rows.map((r) => ({
                title: r.title,
                type: r.media_type,
                artist: r.artist_name ?? undefined,
                album: r.album_title ?? undefined,
                year: r.year ?? undefined,
            })),
        });

        ctx.logger?.debug('search_music executed', {
            query: args.query,
            returned: rows.length,
        });

        return { summaryForModel, music: rows.map(musicCardFromSearchResult) };
    },
};
