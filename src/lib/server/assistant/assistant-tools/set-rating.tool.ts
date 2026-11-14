// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * `set_rating` tool — set or REMOVE the caller's own 1-10 rating for one title.
 *
 * TWO rating paths exist in this codebase and they diverge:
 *
 *  - `ratingManager.recordRating` (behind `POST /api/ai/rate`) — the AI/taste
 *    path: `ensureUserExists`, profile rebuild every 5th rating, suggestion
 *    regeneration, cache invalidation, activity feed.
 *  - `PUT /api/v1/watch-state/{id}` — the device path: writes
 *    `upsertUserRating` directly inside a transaction, with none of the above.
 *
 * This tool uses the FIRST, deliberately. The assistant already READS that
 * taste profile (`getUserRecentRatings` seeds every system prompt), so a rating
 * it sets must feed the same profile, or the assistant would be rating into a
 * store it cannot see.
 *
 * `milestoneReached` / `recommendationsReady` are deliberately NOT surfaced:
 * they invite the model to announce a feature unlock it has no way to verify.
 * `ratingCount` is, so it can say something true about progress.
 *
 * @module server/assistant/assistant-tools/set-rating.tool
 */

import {
    setRatingArgsSchema,
    ASSISTANT_TOOL_NAMES,
    type SetRatingArgs,
} from '../../../schemas/assistant-tools.js';
import { ratingManager } from '$lib/server/services/rating-manager.service.js';
import { resolveTitleForWrite } from './resolve-title.js';
import {
    mediaRef,
    mediaYear,
    refuseAmbiguous,
    refuseFailed,
    refuseNotFound,
    refuseWritesDisabled,
    writeOk,
} from './write-result.js';
import type { AssistantTool, AssistantToolContext, AssistantToolExecuteResult } from './types.js';

const NOTHING_HAPPENED = 'The rating was not saved.';

/** See `add-to-watchlist.tool.ts` — matched by name, not `instanceof`. */
function isAccessOrResolveError(err: unknown): boolean {
    if (!(err instanceof Error)) return false;
    return err.name === 'MediaAccessDeniedError' || err.name === 'MediaNotResolvableError';
}

export const setRatingTool: AssistantTool<SetRatingArgs> = {
    name: ASSISTANT_TOOL_NAMES.SET_RATING,
    description:
        "Set the user's OWN rating for ONE movie or TV show on a 1-10 scale, or pass rating: null to remove an existing rating. Call this only when the user stated an opinion AND asked for it to be saved in their latest message — do not rate on their behalf because they said they liked something in passing. One title per call.",
    argsSchema: setRatingArgsSchema,

    async execute(
        args: SetRatingArgs,
        ctx: AssistantToolContext,
    ): Promise<AssistantToolExecuteResult> {
        if (!ctx.writesAllowed) return refuseWritesDisabled(NOTHING_HAPPENED);
        // Mirrors POST /api/ai/rate: an age-restricted profile may not feed the
        // AI taste profile. `runAssistant` already rejects those callers outright,
        // so this is belt-and-braces — but `deEscalateUser` deliberately leaves
        // `isAgeRestricted` false while applying a content ceiling, so the two
        // flags are not interchangeable and this check has to be explicit.
        if (ctx.user.isAgeRestricted) return refuseWritesDisabled(NOTHING_HAPPENED);

        const resolved = await resolveTitleForWrite(ctx, args);
        if (resolved.kind === 'not_found') return refuseNotFound(args, NOTHING_HAPPENED);
        if (resolved.kind === 'ambiguous') {
            return refuseAmbiguous(resolved.candidates, NOTHING_HAPPENED);
        }

        const row = resolved.row;
        const shared = {
            title: row.title,
            year: mediaYear(row),
            ref: mediaRef(row),
        };

        try {
            if (args.rating === null) {
                const { cleared } = await ratingManager.clearRating({
                    externalIds: { internal: row.media_id },
                    mediaType: row.media_type,
                    title: row.title,
                    user: ctx.user,
                });
                return writeOk({
                    action: 'cleared',
                    ...shared,
                    hadRating: cleared,
                    note: cleared
                        ? 'The rating was removed.'
                        : 'There was no rating to remove — nothing changed.',
                });
            }

            const result = await ratingManager.recordRating({
                // Seeds the users row for Jellyfin matching; all user-data writes
                // key off `user.userId`, not this.
                username: ctx.user.username,
                externalIds: { internal: row.media_id },
                mediaType: row.media_type,
                rating: args.rating,
                title: row.title,
                // 'stars' = a precise value the user named, as opposed to the
                // semantic quick-rating buttons.
                ratingStyle: 'stars',
                context: 'Rated via the assistant',
                user: ctx.user,
            });

            return writeOk({
                action: 'rated',
                ...shared,
                rating: args.rating,
                wasNewRating: result.wasNewRating,
                totalRatings: result.ratingCount,
                note: `Saved a rating of ${args.rating}/10.`,
            });
        } catch (err) {
            ctx.logger?.warn('set_rating failed', {
                title: args.title,
                error: err instanceof Error ? err.name : String(err),
            });
            if (isAccessOrResolveError(err)) return refuseNotFound(args, NOTHING_HAPPENED);
            return refuseFailed(NOTHING_HAPPENED);
        }
    },
};
