// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * defs/ai/rate.ts — POST /api/ai/rate
 *
 * Accepts a rating (1–10), a skip flag, or a clear flag (removes an
 * existing rating) for a media item.
 * Requires external IDs and media type.
 * Ratings influence AI recommendation generation.
 *
 * Returns a bare object (single resource):
 *   { message, rating, skipped?, cleared?, ratingCount?, nextAction?,
 *     learningApplied?, profileUpdated?, recommendationsReady?,
 *     milestoneReached?, progress?, totalRatings?, milestone?, profileStatus? }
 *
 * Errors via ApiProblem: 403 forbidden, 404 not_found, 422 validation_failed,
 *   429 rate_limited, 500 internal_error, 503 dependency_unavailable.
 *
 * Auth: user (any authenticated session or token).
 * Rate-limited: 20 req / 60 s.
 */

import { json } from '@sveltejs/kit';
import { defineEndpoint } from '$lib/server/api/define.js';
import { ApiProblem } from '$lib/server/api/problem.js';
import { rateContentBodySchema } from '$lib/schemas/ai.js';
import { Logger } from '$lib/server/utils/logger.js';
import * as m from '$lib/paraglide/messages.js';
import {
    ratingManager,
    RatingAccessDeniedError,
} from '$lib/server/services/rating-manager.service.js';
import {
    crossedMilestone,
    deriveProfileStatus,
    MIN_RATINGS_FOR_RECOMMENDATIONS,
} from '$lib/shared/rating-thresholds.js';

const logger = Logger.for('AIRateDef');

export const def = defineEndpoint({
    auth: { kind: 'user' },
    visibility: 'internal',

    request: {
        body: rateContentBodySchema,
    },

    handlers: {
        POST: async (event, ctx) => {
            const { locals, request } = event;

            // Age-restricted profiles cannot use AI rating (it builds the AI taste profile).
            if (locals.user?.isAgeRestricted) {
                return ApiProblem.forbidden(
                    'AI features are not available for age-restricted profiles',
                );
            }

            // Rate-limit: 20 req / 60 s per IP+username.
            {
                const { checkRateLimit } =
                    await import('$lib/server/middleware/valkey-rate-limit.js');
                const { getClientIp } = await import('$lib/server/utils/client-ip.js');
                const ip = getClientIp(event);
                const username = locals.user?.username || 'anonymous';
                const key = `${ip}:${username}:ai-rate`;
                const rl = await checkRateLimit(key, 20, 60);
                if (!rl.allowed) {
                    const retryAfter = rl.resetAt - Math.floor(Date.now() / 1000);
                    return ApiProblem.rateLimited(retryAfter > 0 ? retryAfter : 60);
                }
            }

            // Dev user override — resolve to effective username / UUID.
            const { getEffectiveUser } = await import('$lib/server/dev-user.js');
            const authenticatedUser = locals.user?.username;
            const effectiveUsername = getEffectiveUser(request, authenticatedUser);
            logger.debug('Resolved user for rating', { userId: effectiveUsername });

            // When the effective user differs from the authenticated user (dev-only
            // devUser cookie override), resolve the override username to its UUID so
            // that ALL data writes are keyed to the effective user.
            let effectiveUser = locals.user;
            if (effectiveUsername !== authenticatedUser) {
                const { getUserIdByUsername } =
                    await import('$lib/server/database/queries/users.queries.js');
                const { aiDbService } = await import('$lib/server/services/database.service.js');
                const sql = await aiDbService.getSql();
                if (sql) {
                    const { ensureUserExists } =
                        await import('$lib/server/database/queries/user-ratings.queries.js');
                    await ensureUserExists(sql, effectiveUsername, {
                        maxAgeRating: locals.user?.maxAgeRating,
                    });
                    const resolvedId = await getUserIdByUsername(sql, effectiveUsername);
                    if (resolvedId) {
                        effectiveUser = {
                            ...locals.user,
                            userId: resolvedId,
                            username: effectiveUsername,
                        };
                    }
                }
            }

            // Body already validated + typed by mount() via the request schema.
            const {
                externalIds,
                mediaType,
                rating,
                context,
                tags,
                notes,
                skip,
                clear,
                title,
                ratingStyle,
            } = ctx.input!.body;

            // Handle clear: remove an existing rating (re-tapping the same
            // already-active quick-rating button). No AI learning to apply/undo —
            // the profile self-corrects from surviving ratings on next rebuild.
            if (clear) {
                try {
                    const clearResult = await ratingManager.clearRating({
                        externalIds,
                        mediaType,
                        title: title || undefined,
                        user: effectiveUser,
                    });

                    // An undo (clear) can drop the user below the unlock
                    // threshold — without a post-operation count/status the
                    // client has no signal that recommendations un-ready'd.
                    // No `milestone` here: milestones are a forward-progress
                    // gamification signal (crossedMilestone), not meaningful
                    // on a removal.
                    let totalRatings: number | undefined;
                    let profileStatus: ReturnType<typeof deriveProfileStatus> | undefined;
                    const { aiDbService } =
                        await import('$lib/server/services/database.service.js');
                    const sql = await aiDbService.getSql();
                    if (sql) {
                        const { countUserRatings } =
                            await import('$lib/server/database/queries/user-ratings.queries.js');
                        totalRatings = await countUserRatings(sql, effectiveUser.userId);
                        profileStatus = deriveProfileStatus(totalRatings);
                    }

                    return json({
                        message: 'Rating cleared',
                        cleared: clearResult.cleared,
                        totalRatings,
                        profileStatus,
                    });
                } catch (error) {
                    if (error instanceof RatingAccessDeniedError) {
                        return ApiProblem.notFound('Media not found or not accessible');
                    }
                    const message = error instanceof Error ? error.message : String(error);
                    if (message === 'No valid external IDs provided') {
                        return ApiProblem.validationFailed(message);
                    }
                    if (message === 'Database unavailable') {
                        return ApiProblem.dependencyUnavailable(message);
                    }
                    throw error;
                }
            }

            // Handle skip: save with skipped flag but no learning.
            if (skip) {
                let skipResult;
                try {
                    skipResult = await ratingManager.skipSuggestion({
                        username: effectiveUsername,
                        externalIds,
                        mediaType,
                        context: context || undefined,
                        title: title || undefined,
                        user: effectiveUser,
                    });
                } catch (error) {
                    if (error instanceof RatingAccessDeniedError) {
                        return ApiProblem.notFound('Media not found or not accessible');
                    }
                    const message = error instanceof Error ? error.message : String(error);
                    if (message === 'No valid external IDs provided') {
                        return ApiProblem.validationFailed(message);
                    }
                    if (message === 'AI service not available') {
                        return ApiProblem.dependencyUnavailable('AI service not available');
                    }
                    throw error;
                }

                // Skips persist a (skipped=true) row in user_ratings too — the
                // client needs the same post-operation signal as a real
                // rating submit. No `milestone` here: skip's `rating: 5`
                // placeholder would make crossedMilestone() misreport a
                // forward-progress crossing that wasn't a genuine rating.
                let totalRatings: number | undefined;
                let profileStatus: ReturnType<typeof deriveProfileStatus> | undefined;
                {
                    const { aiDbService } =
                        await import('$lib/server/services/database.service.js');
                    const sql = await aiDbService.getSql();
                    if (sql) {
                        const { countUserRatings } =
                            await import('$lib/server/database/queries/user-ratings.queries.js');
                        totalRatings = await countUserRatings(sql, effectiveUser.userId);
                        profileStatus = deriveProfileStatus(totalRatings);
                    }
                }

                return json({
                    message: 'Content skipped',
                    rating: skipResult.rating,
                    skipped: true,
                    totalRatings,
                    profileStatus,
                });
            }

            // At this point rating is guaranteed defined (validated by schema refine).
            const ratingValue = rating as number;

            let result;
            try {
                result = await ratingManager.recordRating({
                    username: effectiveUsername,
                    externalIds,
                    mediaType,
                    rating: ratingValue,
                    context: context || undefined,
                    tags: tags || undefined,
                    notes: notes || undefined,
                    title: title || undefined,
                    ratingStyle: ratingStyle || undefined,
                    user: effectiveUser,
                });
            } catch (error) {
                if (error instanceof RatingAccessDeniedError) {
                    return ApiProblem.notFound('Media not found or not accessible');
                }
                const message = error instanceof Error ? error.message : String(error);
                if (message === 'No valid external IDs provided') {
                    return ApiProblem.validationFailed(message);
                }
                if (message === 'AI service not available' || message === 'Database unavailable') {
                    return ApiProblem.dependencyUnavailable(message);
                }
                throw error;
            }

            // Episodes skip the AI pipeline — rating saved, return early.
            if (result.isEpisodeMedia) {
                return json({
                    message: 'Episode rating saved',
                    rating: result.rating,
                    learningApplied: false,
                });
            }

            const {
                ratingCount,
                learningApplied,
                profileUpdated,
                recommendationsReady,
                milestoneReached,
            } = result;

            // Determine next action for gamified UX. Keyed off the server's
            // actual readiness signal + the shared unlock threshold so the
            // legacy message can never contradict recommendationsReady/
            // profileStatus in the same payload.
            let nextAction: string;
            let message: string;

            if (recommendationsReady) {
                nextAction = 'view_recommendations';
                message = m.api_ai_milestone_reached({ count: ratingCount });
            } else {
                const needed = Math.max(0, MIN_RATINGS_FOR_RECOMMENDATIONS - ratingCount);
                nextAction = 'continue_rating';
                message =
                    needed > 0
                        ? `Good start! Rate ${needed} more movies to begin getting recommendations.`
                        : 'Keep rating — your recommendations are being prepared.';
            }

            // Server-authoritative, drift-free values — additive alongside the
            // legacy nextAction/message pair above (which the old widget still
            // consumes verbatim; see module docblock).
            //
            // profileStatus reflects the persistent UNLOCK state (count vs
            // threshold), NOT recommendationsReady — that flag only reports
            // whether THIS submit regenerated suggestions (%5 cadence), so a
            // veteran's 237th rating would misreport 'building'.
            //
            // milestone only fires for a genuinely NEW rating: re-rating an
            // existing item while sitting at exactly a boundary count would
            // otherwise falsely re-report crossedMilestone(N-1, N).
            const totalRatings = ratingCount;
            const milestone = result.wasNewRating
                ? (crossedMilestone(totalRatings - 1, totalRatings) ?? undefined)
                : undefined;
            const profileStatus = deriveProfileStatus(totalRatings);

            return json({
                message,
                rating: result.rating,
                ratingCount,
                nextAction,
                learningApplied,
                profileUpdated,
                recommendationsReady,
                milestoneReached,
                progress: {
                    ratingsNeeded: Math.max(0, MIN_RATINGS_FOR_RECOMMENDATIONS - ratingCount),
                    ratingsComplete: ratingCount,
                    percentage: Math.min(
                        100,
                        Math.round((ratingCount / MIN_RATINGS_FOR_RECOMMENDATIONS) * 100),
                    ),
                },
                totalRatings,
                milestone,
                profileStatus,
            });
        },
    },
});
