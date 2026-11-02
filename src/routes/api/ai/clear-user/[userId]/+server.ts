// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * DELETE /api/ai/clear-user/[userId]
 *
 * Clear all AI data for a specific user (ratings, profile, suggestions).
 * Preserves watchlist (saved movies).
 * Accessible by the user themselves or by an admin.
 *
 * Response: bare object via json() + problem+json errors
 * incl. 503 dependency_unavailable when the AI DB is down.
 *
 * Auth: selfOrAdmin (userId param). Surface: internal.
 */

import { json } from '@sveltejs/kit';
import { z } from 'zod';
import { defineEndpoint } from '$lib/server/api/define.js';
import { mount } from '$lib/server/api/mount.js';
import { ApiProblem } from '$lib/server/api/problem.js';
import { Logger } from '$lib/server/utils/logger';
import { aiDbService } from '$lib/server/services/database.service.js';
import { getUserIdByUsername } from '$lib/server/database/queries/users.queries.js';
import {
    deleteUserRatingsSimple,
    deleteUserSuggestions,
    deleteUserProfile,
    countUserRatings,
    countUserSuggestions,
    countUserProfiles,
    countUserWatchlist,
} from '$lib/server/database/queries';

const logger = Logger.for('ClearUserEndpoint');

const ClearUserDataResponseSchema = z.object({
    message: z.string(),
    deleted: z.object({
        profiles: z.number(),
        ratings: z.number(),
        suggestions: z.number(),
        savedMovies: z.number(),
    }),
    remaining: z.object({
        profiles: z.number(),
        ratings: z.number(),
        suggestions: z.number(),
        savedMovies: z.number(),
    }),
});

// ---------------------------------------------------------------------------
// def
// ---------------------------------------------------------------------------

const def = defineEndpoint({
    auth: { kind: 'selfOrAdmin', param: 'userId' },
    visibility: 'internal',
    request: {
        params: z.object({ userId: z.string() }),
    },
    handlers: {
        DELETE: async (event, ctx) => {
            const { userId: usernameParam } = ctx.input!.params;

            const currentUser = event.locals.user?.username;
            logger.info('Clearing AI data', { currentUser, userId: usernameParam });

            const sql = await aiDbService.getSql();
            if (!sql) {
                return ApiProblem.dependencyUnavailable('Database not available');
            }

            // The [userId] route segment is a USERNAME (selfOrAdmin compares it to
            // users.username); resolve to the stable users.id UUID — all user-data
            // tables are keyed by uuid since mig 16.46.0.
            const userId = await getUserIdByUsername(sql, usernameParam);
            if (!userId) {
                return ApiProblem.notFound('User not found');
            }

            // Get counts before deletion using centralized queries
            const [profilesBefore, ratingsBefore, suggestionsBefore, savedMoviesBefore] =
                await Promise.all([
                    countUserProfiles(sql, userId),
                    countUserRatings(sql, userId),
                    countUserSuggestions(sql, userId),
                    countUserWatchlist(sql, userId),
                ]);

            logger.info('Before deletion', {
                userId,
                profiles: profilesBefore,
                ratings: ratingsBefore,
                suggestions: suggestionsBefore,
                savedMovies: savedMoviesBefore,
            });

            // Delete AI data (preserve watchlist)
            await Promise.all([
                deleteUserProfile(sql, userId),
                deleteUserRatingsSimple(sql, userId),
                deleteUserSuggestions(sql, userId),
            ]);

            logger.info('Deleted user AI data', { userId });

            // Verify deletion
            const [profilesAfter, ratingsAfter, suggestionsAfter, savedMoviesAfter] =
                await Promise.all([
                    countUserProfiles(sql, userId),
                    countUserRatings(sql, userId),
                    countUserSuggestions(sql, userId),
                    countUserWatchlist(sql, userId),
                ]);

            logger.info('After deletion', {
                userId,
                profiles: profilesAfter,
                ratings: ratingsAfter,
                suggestions: suggestionsAfter,
                savedMovies: savedMoviesAfter,
            });

            return json(
                ClearUserDataResponseSchema.parse({
                    message: `Successfully cleared AI data for user ${userId}`,
                    deleted: {
                        profiles: profilesBefore - profilesAfter,
                        ratings: ratingsBefore - ratingsAfter,
                        suggestions: suggestionsBefore - suggestionsAfter,
                        savedMovies: 0, // Preserved
                    },
                    remaining: {
                        profiles: profilesAfter,
                        ratings: ratingsAfter,
                        suggestions: suggestionsAfter,
                        savedMovies: savedMoviesAfter,
                    },
                }),
            );
        },
    },
});

export const { DELETE } = mount(def, { surface: 'internal' });
