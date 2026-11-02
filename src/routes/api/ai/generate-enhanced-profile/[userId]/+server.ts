// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

// Generate enhanced user profile combining watch history and ratings with improved weighting
import { json } from '@sveltejs/kit';
import { z } from 'zod';
import { defineEndpoint } from '$lib/server/api/define.js';
import { mount } from '$lib/server/api/mount.js';
import { ApiProblem } from '$lib/server/api/problem.js';
import { Logger } from '$lib/server/utils/logger';
import { generateEnhancedProfileBodySchema, userIdParamsSchema } from '$lib/schemas/ai';
import { aiDbService } from '$lib/server/services/database.service';
import { isRecord } from '$lib/utils/data-extraction';
import { config, features } from '$lib/server/config';
import { getBehaviorallyDemotedMediaIds } from '$lib/server/database/queries/for-you-helpers.queries';
import { getUserIdByUsername } from '$lib/server/database/queries/users.queries';
import { PROFILE_RATING_WINDOW } from '$lib/shared/rating-thresholds.js';

const logger = Logger.for('EnhancedProfile');

const enhancedProfileResponseSchema = z.object({
    message: z.string(),
    user_id: z.string(),
    profile_stats: z.object({
        total_items_processed: z.number(),
        watched_items: z.number(),
        rated_items: z.number(),
        overlap_items: z.number(),
        average_weight: z.number(),
        weight_distribution: z.record(z.string(), z.number()),
        genre_preferences: z.number(),
        embeddings_created: z.enum(['Yes', 'No']),
        creation_method: z.string(),
    }),
    weight_examples: z.record(z.string(), z.string()),
});

export type EnhancedProfileResponse = z.infer<typeof enhancedProfileResponseSchema>;

const def = defineEndpoint({
    auth: { kind: 'admin' },
    visibility: 'internal',
    request: {
        body: generateEnhancedProfileBodySchema,
        params: userIdParamsSchema,
    },
    handlers: {
        POST: async (event, ctx) => {
            const { userId } = ctx.input!.params;
            const { watchHistory } = ctx.input!.body;
            // Import AI modules
            const { getDb } = await import('$lib/server/database/connection.js');

            logger.info('Starting enhanced profile generation', { userId });

            const sql = getDb();

            if (!sql) {
                return ApiProblem.dependencyUnavailable('Database not available');
            }

            // The [userId] path segment is a USERNAME — resolve to the stable
            // users.id UUID for all user-data keys (mig 16.46.0).
            const uid = await getUserIdByUsername(sql, userId);
            if (!uid) {
                return ApiProblem.notFound('User not found');
            }

            const profileService = await aiDbService.getUserProfileService();
            const ratingsService = await aiDbService.getUserRatingsService();
            if (!profileService || !ratingsService) {
                return ApiProblem.dependencyUnavailable('AI service not available');
            }

            logger.info('Received watch history items', {
                userId,
                count: watchHistory.length,
            });

            // Get user's existing ratings WITH UUIDs for efficient embedding lookup
            const existingRatings = await ratingsService.getUserRatingsWithUuid(
                uid,
                PROFILE_RATING_WINDOW,
            );
            logger.info('Found existing ratings', {
                userId,
                count: existingRatings.length,
            });

            if (existingRatings.length === 0 && watchHistory.length === 0) {
                return ApiProblem.validationFailed(
                    'Insufficient data: need at least 1 item of watch history or ratings',
                );
            }

            // Optionally fetch behavioral negatives (abandoned items with
            // ≥5min real watch, <60% completion) so the profile centroid
            // is shifted away from items the user sampled and bailed on.
            // Best-effort: a DB error here must NOT fail profile rebuild.
            let softDemote: { mediaIds: Set<string>; multiplier: number } | undefined;
            if (features.forYouAbandonmentDemote) {
                try {
                    const demoted = await getBehaviorallyDemotedMediaIds(sql, uid);
                    if (demoted.length > 0) {
                        // Clamp multiplier into [0, 1]. Schema validation
                        // is UI-only — env-set values bypass it, and NaN
                        // would propagate into the centroid math.
                        const raw = config.FORYOU_ABANDONMENT_DEMOTE_MULTIPLIER;
                        const multiplier = Number.isFinite(raw)
                            ? Math.min(1, Math.max(0, raw))
                            : 0.3;
                        softDemote = {
                            mediaIds: new Set(demoted),
                            multiplier,
                        };
                        logger.info('Applying abandonment soft-demote', {
                            userId,
                            demotedCount: demoted.length,
                            multiplier,
                        });
                    }
                } catch (e) {
                    logger.warn(
                        'Failed to fetch abandonment demote set; continuing without demote',
                        { userId },
                        e as Error,
                    );
                }
            }

            // Create enhanced profile using the new method
            const profile = await profileService.createEnhancedUserProfile(
                uid,
                watchHistory,
                existingRatings,
                softDemote,
            );

            if (!profile) {
                return ApiProblem.internalError('Profile creation returned null');
            }

            logger.info('Created enhanced profile', { userId });

            // Return detailed stats about the profile creation
            const preferences = isRecord(profile.preferences) ? profile.preferences : {};

            return json(
                enhancedProfileResponseSchema.parse({
                    message: `Successfully created enhanced AI profile for ${userId}`,
                    user_id: userId,
                    profile_stats: {
                        total_items_processed:
                            typeof preferences.total_items === 'number'
                                ? preferences.total_items
                                : 0,
                        watched_items:
                            typeof preferences.watched_items === 'number'
                                ? preferences.watched_items
                                : 0,
                        rated_items:
                            typeof preferences.rated_items === 'number'
                                ? preferences.rated_items
                                : 0,
                        overlap_items:
                            typeof preferences.overlap_items === 'number'
                                ? preferences.overlap_items
                                : 0,
                        average_weight:
                            typeof preferences.average_weight === 'number'
                                ? preferences.average_weight
                                : 0,
                        weight_distribution: isRecord(preferences.weight_distribution)
                            ? (preferences.weight_distribution as Record<string, number>)
                            : {},
                        genre_preferences: isRecord(preferences.genres)
                            ? Object.keys(preferences.genres).length
                            : 0,
                        embeddings_created: profile.catalog_embedding ? 'Yes' : 'No',
                        creation_method: 'enhanced_hybrid',
                    },
                    weight_examples: {
                        'Watched + 5-star movie': '1.8 (max)',
                        'Watched + 3-star movie': '1.1',
                        'Only 4-star movie (not watched)': '0.48',
                        'Watched TV series (70% complete)': '0.9',
                        'Watched + 5-star TV series': '2.0 → 1.8 (capped)',
                        'Only 5-star rating (not watched)': '1.0 (movie) / 0.9 (TV)',
                    },
                } satisfies EnhancedProfileResponse),
            );
        },
    },
});

export const { POST } = mount(def, { surface: 'internal' });
