// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * RatingManager — owns all business logic for the AI rating workflow.
 * Routes call this service, not raw query functions.
 *
 * Responsibilities:
 * - Record user ratings with profile rebuild at milestones
 * - Skip suggestions without AI learning
 * - Cache invalidation after rating/skip events
 */

import type { ExternalIds } from '$lib/types/api-common.js';
import type { UserRating } from '$lib/server/database/connection.js';
import type { UserContext } from '$lib/server/types.js';
import {
    MIN_RATINGS_FOR_RECOMMENDATIONS,
    shouldRemoveSuggestionOnRating,
} from '$lib/shared/rating-thresholds.js';
import { Logger } from '$lib/server/utils/logger.js';
import { aiDbService } from './database.service.js';
import { cacheInvalidation } from '$lib/server/cache';
import { activityFeedService } from './activity-feed.service.js';
import { isEpisode } from '$lib/server/utils/media-types.js';
import { resolveAndGate } from '$lib/server/utils/resolve-and-gate.js';

/**
 * @deprecated Use `MediaAccessDeniedError` from `$lib/server/utils/resolve-and-gate.js`.
 * Re-exported alias to keep existing route imports working during the migration window.
 * Aliasing the class on re-export carries both its value and type bindings without
 * the const+type declaration-merge that `no-redeclare` rejects.
 */
export { MediaAccessDeniedError as RatingAccessDeniedError } from '$lib/server/utils/resolve-and-gate.js';

import {
    ensureUserExists,
    ensureUserProfileExists,
    deleteUserSuggestionByMediaId,
    deleteUserSuggestions,
    deleteUserRating,
    getMediaTypeById,
    countUserRatings,
} from '$lib/server/database/queries/user-ratings.queries.js';

const logger = Logger.for('RatingManager');

export interface RatingResult {
    rating: UserRating;
    mediaId: string;
    ratingCount: number;
    learningApplied: boolean;
    profileUpdated: boolean;
    recommendationsReady: boolean;
    milestoneReached: boolean;
    isEpisodeMedia: boolean;
    /**
     * True when this submit created a NEW rating row (fresh INSERT), false when
     * it conflict-updated an existing one (re-rating). Milestone signals must
     * only fire for genuinely new ratings — re-rating an item while sitting at
     * exactly a boundary count (5/25/50/…) must not re-report the milestone.
     */
    wasNewRating: boolean;
}

class RatingManager {
    private async getSql() {
        return aiDbService.getSql();
    }

    async recordRating(params: {
        username: string;
        externalIds: ExternalIds;
        mediaType: 'movie' | 'tv';
        rating: number;
        context?: string;
        tags?: string[];
        notes?: string;
        title?: string;
        /** How the rating was entered — 'quick' (semantic button/swipe) or 'stars' (precise). */
        ratingStyle?: 'quick' | 'stars';
        user: UserContext;
    }): Promise<RatingResult> {
        const {
            username,
            externalIds,
            mediaType,
            rating,
            context,
            tags,
            notes,
            title,
            ratingStyle,
            user,
        } = params;
        // The stable users.id UUID keys ALL user-data writes/reads below
        // (profiles, ratings, suggestions — mig 16.46.0). `username` is retained
        // only to seed the users row (Jellyfin matching) via ensureUserExists.
        const userId = user.userId;

        const sql = await this.getSql();
        if (!sql) throw new Error('Database unavailable');

        const profileService = await aiDbService.getUserProfileService();
        const ratingsService = await aiDbService.getUserRatingsService();
        if (!profileService || !ratingsService) {
            throw new Error('AI service not available');
        }

        // Enrich context with tags and notes
        let enrichedContext = context || '';
        if (tags && tags.length > 0) {
            enrichedContext += ` | Tags: ${tags.join(', ')}`;
        }
        if (notes && notes.trim()) {
            enrichedContext += ` | Notes: ${notes.trim()}`;
        }

        // Ensure user record exists BEFORE creating user_profiles (FK constraint)
        await ensureUserExists(sql, username, { maxAgeRating: user.maxAgeRating });

        // Ensure user profile exists BEFORE adding rating (for foreign key constraint)
        let userProfile = await profileService.getUserProfile(userId);
        if (!userProfile) {
            logger.info('Creating new user profile', { userId: userId });
            try {
                await ensureUserProfileExists(sql, userId);
                userProfile = await profileService.getUserProfile(userId);
            } catch (error) {
                logger.error('Failed to create user profile', error as Error, {
                    userId: userId,
                });
            }
            if (!userProfile) {
                throw new Error('Failed to create user profile');
            }
        }

        // Resolve external IDs to internal UUID and gate by library + age.
        // Throws MediaNotResolvableError or MediaAccessDeniedError; the
        // route maps both to user-safe responses (400 / 404).
        const { mediaId } = await resolveAndGate(
            sql,
            externalIds,
            mediaType,
            user,
            title || undefined,
        );

        // Check if this is an episode — episodes skip the AI pipeline entirely
        const mediaType_db = await getMediaTypeById(sql, mediaId);
        const isEpisodeMedia = mediaType_db ? isEpisode(mediaType_db) : false;

        // Save the rating. Strip wasNewRating off the persisted-rating object so
        // it doesn't leak into API responses that embed `rating` verbatim.
        const { wasNewRating, ...userRating } = await ratingsService.addUserRating({
            user_id: userId,
            media_id: mediaId,
            media_type: mediaType,
            rating,
            suggestion_context: enrichedContext,
            skipped: false,
            rating_style: ratingStyle,
        });

        // Episodes skip the AI pipeline — rating saved, but no profile rebuild.
        // Cache invalidation still runs so userRatings/personalStats stay fresh.
        if (isEpisodeMedia) {
            try {
                await cacheInvalidation.onUserRating(userId, externalIds, mediaType, rating, 0);
            } catch (error) {
                logger.warn('Failed to invalidate cache after episode rating', {
                    userId: userId,
                    error: String(error),
                });
            }

            return {
                rating: userRating,
                mediaId,
                ratingCount: 0,
                learningApplied: false,
                profileUpdated: false,
                recommendationsReady: false,
                milestoneReached: false,
                isEpisodeMedia: true,
                wasNewRating,
            };
        }

        // Get updated rating count after adding this rating (use COUNT, not capped fetch)
        const ratingCount = await countUserRatings(sql, userId);

        let learningApplied = false;
        let profileUpdated = false;
        let recommendationsReady = false;

        if (ratingCount >= MIN_RATINGS_FOR_RECOMMENDATIONS) {
            // Every-5th-rating profile-rebuild cadence — a cadence, not the
            // recommendations-unlock threshold (kept literal; the two happen to
            // share the value 5 today but are conceptually independent).
            // `ratingCount === 5` is redundant with `% 5 === 0` (5 % 5 === 0).
            const shouldUpdateProfile = ratingCount % 5 === 0;

            if (shouldUpdateProfile) {
                // Major profile update every 5 ratings
                logger.info('Auto-updating user profile', {
                    userId: userId,
                    ratingCount,
                });

                try {
                    // Clear cached suggestions to force refresh when profile changes significantly
                    await deleteUserSuggestions(sql, userId);

                    // Regenerate profile from ratings + watch history
                    const newProfile = await profileService.rebuildUserProfile(userId);
                    profileUpdated = !!newProfile;
                    learningApplied = profileUpdated;

                    if (profileUpdated && ratingCount >= MIN_RATINGS_FOR_RECOMMENDATIONS) {
                        // Generate fresh recommendations. A milestone rebuild that
                        // silently produces zero suggestion rows (or throws) is the
                        // exact observability gap that let a 199-rating prod user
                        // sit on an EMPTY user_suggestions table serving fallback
                        // content undetected — surface it loudly instead of letting
                        // recommendationsReady default to a false "success".
                        const engine = await aiDbService.getSuggestionEngine();
                        if (engine) {
                            try {
                                const generated = await engine.generateSuggestionsFromProfile(
                                    userId,
                                    10,
                                );
                                if (!generated || generated.length === 0) {
                                    logger.error(
                                        'Milestone suggestion generation returned zero rows',
                                        undefined,
                                        { userId: userId, ratingCount },
                                    );
                                } else {
                                    recommendationsReady = true;
                                    logger.info('Generated fresh recommendations', {
                                        userId: userId,
                                        ratingCount,
                                        count: generated.length,
                                    });
                                }
                            } catch (error) {
                                logger.error(
                                    'Milestone suggestion generation threw',
                                    error as Error,
                                    { userId: userId, ratingCount },
                                );
                            }
                        }
                    }
                } catch (error) {
                    logger.error('Failed to update user profile', error as Error, {
                        userId: userId,
                        ratingCount,
                    });
                }
            } else if (shouldRemoveSuggestionOnRating(rating)) {
                // For significant ratings between milestones, remove any suggestions for this specific movie
                logger.info('Removing rated movie from suggestions cache', {
                    userId: userId,
                    mediaId,
                    rating,
                });

                try {
                    await deleteUserSuggestionByMediaId(sql, userId, mediaId);
                } catch (error) {
                    logger.warn(
                        'Failed to remove specific suggestion',
                        { userId: userId, mediaId, mediaType },
                        error as Error,
                    );
                }
            }
        }

        // Single cache invalidation call — always runs for non-episode ratings
        try {
            await cacheInvalidation.onUserRating(
                userId,
                externalIds,
                mediaType,
                rating,
                ratingCount,
            );
        } catch (error) {
            logger.warn('Failed to invalidate cache after rating', {
                userId: userId,
                error: String(error),
            });
        }

        // Track rating in activity feed (fire-and-forget)
        try {
            await activityFeedService.trackRatingEvent(userId, {
                media_id: mediaId,
                media_type: mediaType,
                title: title || 'Unknown Title',
                rating,
            });
        } catch (error) {
            logger.warn('Failed to track rating in activity feed', {
                userId: userId,
                error: String(error),
            });
        }

        logger.info('User rated movie', {
            userId: userId,
            mediaId,
            rating,
            totalRatings: ratingCount,
        });

        // Only a genuinely NEW rating can reach a milestone — re-rating an
        // existing item at exactly a boundary count must not re-fire it.
        const milestoneReached =
            wasNewRating &&
            ratingCount >= MIN_RATINGS_FOR_RECOMMENDATIONS &&
            (ratingCount % 5 === 0 || ratingCount === 5);

        return {
            rating: userRating,
            mediaId,
            ratingCount,
            learningApplied,
            profileUpdated,
            recommendationsReady,
            milestoneReached,
            isEpisodeMedia: false,
            wasNewRating,
        };
    }

    async skipSuggestion(params: {
        username: string;
        externalIds: ExternalIds;
        mediaType: 'movie' | 'tv';
        context?: string;
        title?: string;
        user: UserContext;
    }): Promise<{ rating: UserRating; skipped: true }> {
        const { externalIds, mediaType, context, title, user } = params;
        const userId = user.userId;

        const sql = await this.getSql();
        if (!sql) throw new Error('Database unavailable');

        const ratingsService = await aiDbService.getUserRatingsService();
        if (!ratingsService) {
            throw new Error('AI service not available');
        }

        const { mediaId } = await resolveAndGate(
            sql,
            externalIds,
            mediaType,
            user,
            title || undefined,
        );

        // Strip wasNewRating (upsert bookkeeping) off the persisted-rating
        // object — the skip response embeds `rating` verbatim.
        const { wasNewRating: _wasNewRating, ...skipRating } = await ratingsService.addUserRating({
            user_id: userId,
            media_id: mediaId,
            media_type: mediaType,
            rating: 5,
            suggestion_context: context || 'Skipped content',
            skipped: true,
        });

        try {
            await deleteUserSuggestionByMediaId(sql, userId, mediaId);

            await cacheInvalidation.onSuggestionSkipped(userId, externalIds, mediaType);
        } catch (error) {
            logger.warn(
                'Failed to remove skipped item from suggestions',
                { userId: userId, mediaId },
                error as Error,
            );
        }

        return { rating: skipRating, skipped: true };
    }

    /**
     * Remove the caller's existing rating for a media item (re-tapping an
     * already-active quick-rating button). No profile rebuild — the taste
     * profile recomputes from scratch from surviving ratings on its next
     * milestone rebuild, so a deleted rating simply stops contributing.
     */
    async clearRating(params: {
        externalIds: ExternalIds;
        mediaType: 'movie' | 'tv';
        title?: string;
        user: UserContext;
    }): Promise<{ cleared: boolean }> {
        const { externalIds, mediaType, title, user } = params;
        const userId = user.userId;

        const sql = await this.getSql();
        if (!sql) throw new Error('Database unavailable');

        const { mediaId } = await resolveAndGate(
            sql,
            externalIds,
            mediaType,
            user,
            title || undefined,
        );

        const result = await deleteUserRating.execute(sql, { userId, mediaId });

        try {
            await cacheInvalidation.onRatingCacheChanged(userId);
        } catch (error) {
            logger.warn('Failed to invalidate cache after clearing rating', {
                userId: userId,
                error: String(error),
            });
        }

        return { cleared: result.length > 0 };
    }
}

export const ratingManager = new RatingManager();
