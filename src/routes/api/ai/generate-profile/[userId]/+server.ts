// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

// Generate user profile from watch history
import { json } from '@sveltejs/kit';
import { z } from 'zod';
import { defineEndpoint } from '$lib/server/api/define.js';
import { mount } from '$lib/server/api/mount.js';
import { ApiProblem } from '$lib/server/api/problem.js';
import { Logger } from '$lib/server/utils/logger';
import { aiDbService } from '$lib/server/services/database.service';
import { userIdParamsSchema } from '$lib/schemas/ai';
import { localsIsAdmin } from '$lib/server/auth/locals-admin.js';

const logger = Logger.for('GenerateProfileEndpoint');

const profileExistsResponseSchema = z.object({
    message: z.string(),
    profile_exists: z.literal(true),
});

const profileCreatedResponseSchema = z.object({
    message: z.string(),
    ratings_count: z.number(),
    profile_created: z.literal(true),
    user_id: z.string(),
    profile_method: z.string(),
});

// Union discriminated on profile_exists / profile_created presence
const generateProfileResponseSchema = z.union([
    profileExistsResponseSchema,
    profileCreatedResponseSchema,
]);

export type GenerateProfileResponse = z.infer<typeof generateProfileResponseSchema>;

const def = defineEndpoint({
    auth: { kind: 'admin' },
    visibility: 'internal',
    request: {
        params: userIdParamsSchema,
    },
    handlers: {
        POST: async (event, ctx) => {
            const usernameParam = ctx.input!.params.userId;

            // Import AI modules
            const { getDb } = await import('$lib/server/database/connection.js');
            const { getUserIdByUsername } =
                await import('$lib/server/database/queries/users.queries.js');
            logger.info('Starting profile generation', { userId: usernameParam });

            const sql = getDb();
            if (!sql) {
                return ApiProblem.dependencyUnavailable('Database not initialized');
            }

            // [userId] segment is a username; resolve to users.id UUID (mig 16.46.0).
            const userId = await getUserIdByUsername(sql, usernameParam);
            if (!userId) {
                return ApiProblem.notFound('User not found');
            }

            const profileService = await aiDbService.getUserProfileService();
            const ratingsService = await aiDbService.getUserRatingsService();
            if (!profileService || !ratingsService) {
                return ApiProblem.dependencyUnavailable('AI service not available');
            }

            // Check if profile already exists
            let userProfile = await profileService.getUserProfile(userId);
            if (userProfile) {
                logger.info('Profile already exists', { userId });
                return json(
                    generateProfileResponseSchema.parse({
                        message: 'User profile already exists',
                        profile_exists: true,
                    } satisfies z.infer<typeof profileExistsResponseSchema>),
                );
            }

            // Check if user has enough ratings for profile creation
            const userRatings = await ratingsService.getUserRatings(userId, 100);
            const MINIMUM_RATINGS_REQUIRED = 5;

            // Check if current user is admin (can bypass rating requirement)
            const currentUser = event.locals.user?.username;
            // Use already-parsed userGroups and isAdmin from hooks.server.ts
            const isAdmin = localsIsAdmin(event.locals);

            logger.info('Profile generation request', {
                currentUser,
                isAdmin,
                targetUserId: userId,
                ratingsCount: userRatings.length,
                required: MINIMUM_RATINGS_REQUIRED,
            });

            if (userRatings.length < MINIMUM_RATINGS_REQUIRED && !isAdmin) {
                return ApiProblem.validationFailed(
                    `Insufficient ratings: ${userRatings.length} of ${MINIMUM_RATINGS_REQUIRED} required`,
                );
            }

            // For admins or users with few ratings, try to generate from watch history
            if (userRatings.length < MINIMUM_RATINGS_REQUIRED && isAdmin) {
                logger.info('Admin bypass: Attempting to generate profile from watch history', {
                    userId,
                });
                try {
                    userProfile = await profileService.createUserProfileFromRatings(userId);
                    logger.info('Successfully created profile from watch history', {
                        userId,
                    });
                } catch (watchHistoryError) {
                    logger.error('Watch history method failed', watchHistoryError as Error, {
                        userId,
                    });
                    return ApiProblem.validationFailed(
                        'No sufficient watch history or embeddings available. Try rating a few movies manually first',
                    );
                }
            } else if (userRatings.length >= MINIMUM_RATINGS_REQUIRED) {
                // Create user profile from ratings
                logger.info('Creating profile from ratings', {
                    userId,
                    ratingsCount: userRatings.length,
                });
                userProfile = await profileService.createUserProfileFromRatings(userId);
            } else {
                return ApiProblem.validationFailed(
                    `Insufficient data: need 5 ratings, have ${userRatings.length}`,
                );
            }

            if (!userProfile) {
                return ApiProblem.internalError('Profile creation returned null');
            }

            logger.info('Created profile successfully', {
                userId,
                ratingsCount: userRatings.length,
            });

            return json(
                generateProfileResponseSchema.parse({
                    message: `Profile created successfully from ${userRatings.length} user ratings`,
                    ratings_count: userRatings.length,
                    profile_created: true,
                    user_id: userId,
                    profile_method: 'ratings_based',
                } satisfies z.infer<typeof profileCreatedResponseSchema>),
            );
        },
    },
});

export const { POST } = mount(def, { surface: 'internal' });
