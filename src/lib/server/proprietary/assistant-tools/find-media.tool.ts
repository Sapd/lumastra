// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: LicenseRef-Lumastra-Proprietary
// Proprietary and source-available — not licensed under AGPL. See LICENSING.md.

/**
 * `find_media` — objective, access-scoped candidate filtering.
 *
 * @module server/proprietary/assistant-tools/find-media
 */

import {
    ASSISTANT_TOOL_NAMES,
    findMediaArgsSchema,
    type FindMediaArgs,
} from '../../../schemas/assistant-tools.js';
import {
    findMediaByConstraints,
    type AssistantMovieRow,
} from '../../database/queries/assistant-rag.queries.js';
import { searchAccessBoundary } from '../../utils/search-access-context.js';
import { summarizeMediaForModel } from './media-summary.js';
import type { AssistantTool, AssistantToolContext, AssistantToolExecuteResult } from './types.js';

/** Which rating sources the caller actually filtered or sorted on. */
function requestedRatingSources(args: FindMediaArgs): string[] {
    const used: string[] = [];
    if (args.minRtRating !== undefined || args.sortBy === 'rt_rating') {
        used.push('Rotten Tomatoes critic score');
    }
    if (args.minRtAudienceScore !== undefined || args.sortBy === 'rt_audience_score') {
        used.push('Rotten Tomatoes audience score');
    }
    if (args.minImdbRating !== undefined || args.sortBy === 'imdb_rating') {
        used.push('IMDb rating');
    }
    return used;
}

export const findMediaTool: AssistantTool<FindMediaArgs> = {
    name: ASSISTANT_TOOL_NAMES.FIND_MEDIA,
    description:
        'Find accessible movie/TV candidates using objective filters: genre, release years, runtime, critic/audience ratings, and the CALLING user\'s watched/unwatched state. Ratings use DIFFERENT scales — Rotten Tomatoes critic and audience scores are percentages (0-100), IMDb is 0-10. Use for "a 90 minute comedy from the 2000s I have not watched" or "well-reviewed films I have not seen". Any rating this returns as null is one the library genuinely does not have — say so, never supply it from your own knowledge. Combine with get_shared_watch_history for a named peer.',
    argsSchema: findMediaArgsSchema,
    async execute(
        args: FindMediaArgs,
        ctx: AssistantToolContext,
    ): Promise<AssistantToolExecuteResult> {
        // The peer predicate can reveal another person's watch state one
        // candidate at a time. Keep it behind the same capability gate as the
        // explicit shared-history tool; omitting the context flag is
        // intentionally fail-closed for direct/unit callers too.
        const peerFilterApplied = Boolean(
            args.unwatchedByUsername && ctx.socialWatchHistoryViewable,
        );
        const peerFilterDropped = Boolean(args.unwatchedByUsername) && !peerFilterApplied;

        // Fetch ONE more than asked for. Answers kept reporting the page size as
        // a census — "insgesamt 15 neue Inhalte" when 15 was simply the limit —
        // and a plain count gives the model no way to tell a full result from a
        // truncated one. A cheap over-fetch does, without a second COUNT query.
        const limit = args.limit ?? 10;
        const fetched = await findMediaByConstraints(ctx.sql, {
            ...args,
            unwatchedByUsername: peerFilterApplied ? args.unwatchedByUsername : undefined,
            limit: limit + 1,
            userId: ctx.userId,
            access: searchAccessBoundary(ctx.accessCtx),
        });
        const hasMore = fetched.length > limit;
        const media = hasMore ? fetched.slice(0, limit) : fetched;

        const summary = JSON.parse(summarizeMediaForModel(media)) as Record<string, unknown>;
        // The over-fetch above answers "is there more" exactly, so replace the
        // generic marker rather than adding a second, differently-named one —
        // one vocabulary across every tool is what makes the rule stick.
        summary.maybeMore = hasMore;
        summary.countNote = hasMore
            ? `returnedCount (${media.length}) is a PAGE — more titles match than are shown. Do not say "there are ${media.length}" or "insgesamt ${media.length}"; say "here are ${media.length}".`
            : `returnedCount (${media.length}) is every accessible match for these filters — nothing was cut off by the limit.`;

        // Dropping a filter silently is how a tool turns into a liar: the model
        // asked "neither Alex nor I have seen", got titles filtered on the
        // caller alone, and reported them as checked against both — a specific,
        // checkable, wrong claim about another person. Say what was applied.
        if (args.unwatchedByUsername) {
            summary.peerFilterApplied = peerFilterApplied;
            if (peerFilterDropped) {
                summary.peerFilterNote = `These results are filtered on YOUR watch state ONLY. Shared watch history is not enabled here, so "${args.unwatchedByUsername}" was NOT checked. Do not claim or imply that they have not seen these titles — say you can only speak for the caller.`;
            }
        }

        const ratingSources = requestedRatingSources(args);

        if (ratingSources.length > 0) {
            const has = (pick: (row: AssistantMovieRow) => number | null | undefined): number =>
                media.filter((row) => pick(row) != null).length;
            // Per-source counts, so "3 of 10 results have a Tomatometer score"
            // is something the model can state instead of guessing at the rest.
            summary.ratingCoverage = {
                // `total` here meant "of the rows returned", which is exactly
                // the misreading the count rename exists to stop.
                ofReturned: media.length,
                rtRating: has((r) => r.rt_rating),
                rtAudienceScore: has((r) => r.rt_audience_score),
                imdbRating: has((r) => r.imdb_rating),
            };
            summary.ratingDataNote =
                media.length === 0
                    ? `No accessible title met this ${ratingSources.join(' / ')} threshold. That means either nothing scores that highly or this library has no score for those titles — it does NOT mean the titles are bad. Say plainly that you could not find matches on ${ratingSources.join(' / ')}; do not invent scores and do not fall back on ratings you remember.`
                    : `Ratings shown are the library's own stored values. A null score means this library has no value for it — say you do not have it. NEVER state a score from your own knowledge for any title here, and never present a remembered score as if the tool returned it.`;
        }

        return { summaryForModel: JSON.stringify(summary), media };
    },
};
