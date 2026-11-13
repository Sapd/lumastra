// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * `get_details` tool — full details for ONE movie or TV show.
 *
 * Resolves the title through the ACCESS-SCOPED `searchMediaByTitle` first, so
 * the detail lookups (which key off the internal id) only ever run for a title
 * the user is allowed to see. Aggregates: rich metadata + tags/keywords +
 * season/episode counts (`getMediaDetailByUuid`), audio/subtitle languages
 * (`getMediaDetailsById`), and which library it lives in
 * (`getMediaItemLibraryNames`).
 *
 * @module server/proprietary/assistant-tools/get-details.tool
 */

import {
    getDetailsArgsSchema,
    ASSISTANT_TOOL_NAMES,
    type GetDetailsArgs,
} from '../../../schemas/assistant-tools.js';
import {
    searchMediaByTitle,
    getAllProviderKeywords,
    type AssistantMovieRow,
} from '../../database/queries/assistant-rag.queries.js';
import { getMediaDetailByUuid } from '../../database/queries/media-details.queries.js';
import { getMediaDetailsById } from '../../database/queries/media-lookup.queries.js';
import { getMediaItemLibraryNames } from '../../database/queries/library-groups.queries.js';
import { searchAccessBoundary } from '../../utils/search-access-context.js';
import type { AssistantTool, AssistantToolContext, AssistantToolExecuteResult } from './types.js';

export const getDetailsTool: AssistantTool<GetDetailsArgs> = {
    name: ASSISTANT_TOOL_NAMES.GET_DETAILS,
    description:
        'Get full details for a SPECIFIC movie or TV show: overview, cast, directors, genres, tags/keywords (e.g. "whodunit"), ratings, runtime, certification, which library it is in, available audio & subtitle languages, and (for series) the number of seasons and episodes. Use when the user asks "tell me about X", "who is in X", "what languages/subtitles does X have", "how many seasons", etc.',
    argsSchema: getDetailsArgsSchema,

    async execute(
        args: GetDetailsArgs,
        ctx: AssistantToolContext,
    ): Promise<AssistantToolExecuteResult> {
        const matches = await searchMediaByTitle(ctx.sql, {
            title: args.title,
            year: args.year,
            // Ask for several so the mediaType preference below has something to
            // choose BETWEEN. The query defaulted to LIMIT 1, which made that
            // preference dead code: "Fargo, the series" resolved to whichever of
            // film/series won trigram similarity, and the film's details were
            // then described as the series'.
            limit: args.mediaType ? 5 : 1,
            access: searchAccessBoundary(ctx.accessCtx),
        });
        const match: AssistantMovieRow | undefined = args.mediaType
            ? (matches.find((m) => m.media_type === args.mediaType) ?? matches[0])
            : matches[0];

        if (!match?.media_id) {
            return {
                summaryForModel: JSON.stringify({
                    found: false,
                    note: `No accessible title matching "${args.title}"${args.year ? ` (${args.year})` : ''}.`,
                }),
            };
        }

        const id = match.media_id;
        const [detail, langRow, libraries, allKeywords] = await Promise.all([
            getMediaDetailByUuid(ctx.sql, id),
            getMediaDetailsById(ctx.sql, id),
            getMediaItemLibraryNames(ctx.sql, id, ctx.accessCtx.deniedGroupIds),
            // Tags across ALL provider rows — the detail query reads only the
            // chain-selected row and misses the rich mdblist tag set.
            getAllProviderKeywords(ctx.sql, id),
        ]);

        const year = detail?.release_date ? Number(String(detail.release_date).slice(0, 4)) : null;

        const isTv = match.media_type === 'tv';

        const summary = {
            found: true,
            // The clickable handle the model cites, e.g. [The Last Signal](ref:10000001:movie).
            // It was missing entirely, so the model improvised `ref:0:movie` and
            // every "tell me about X" answer ended in a dead link — on the one
            // path where the user is most likely to click through.
            // MUST be 'series', not 'tv': resolveMovieByRef matches the ref
            // against `${id}:${card.mediaType}`, and the card carries the PUBLIC
            // vocabulary ('movie' | 'series'). A `:tv` ref matches no card and is
            // a dead link — the same failure this ref was added to fix.
            ref: match.primary_ext_id
                ? `${match.primary_ext_id}:${isTv ? 'series' : 'movie'}`
                : null,
            title: detail?.title ?? match.title,
            mediaType: match.media_type,
            year: Number.isFinite(year) ? year : null,
            overview: detail?.overview ?? match.overview ?? null,
            genres: detail?.genres ?? null,
            tags: allKeywords.length > 0 ? allKeywords : (detail?.keywords ?? null),
            cast: detail?.actors?.slice(0, 8) ?? null,
            directors: detail?.directors ?? null,
            runtimeMinutes: detail?.runtime_minutes ?? null,
            certification: detail?.certification ?? null,
            // Scales differ per source and the model WILL restate them, so each
            // is named with its range. `tmdb` is gone: nothing writes
            // `tmdb_rating`, so it was always null (TMDB's own value lands as
            // `vote_average` on a provider row this query never reads).
            ratings: {
                imdbOutOf10: detail?.imdb_rating ?? null,
                rottenTomatoesCriticPercent: detail?.rt_rating ?? null,
                rottenTomatoesAudiencePercent: detail?.rt_audience_score ?? null,
                metacriticOutOf100: detail?.metacritic_score ?? null,
                letterboxdOutOf10: detail?.letterboxd_rating ?? null,
            },
            isAvailable: Boolean(match.is_available),
            canRequest: Boolean(match.can_request),
            libraries,
            audioLanguages: langRow?.audio_languages ?? [],
            subtitleLanguages: langRow?.subtitle_languages ?? [],
            ...(isTv
                ? {
                      status: detail?.status ?? null,
                      seasonCount: detail?.season_count ?? null,
                      episodeCount: detail?.episode_count ?? null,
                  }
                : {}),
        };

        ctx.logger?.debug('get_details executed', {
            title: args.title,
            resolved: match.title,
            mediaType: match.media_type,
        });

        return {
            summaryForModel: JSON.stringify(summary),
            media: [match],
        };
    },
};
