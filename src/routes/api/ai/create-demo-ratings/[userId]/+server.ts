// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * POST /api/ai/create-demo-ratings/[userId]
 *
 * Admin endpoint: create demo ratings for a user to seed AI testing.
 *
 * Response: bare object via json() + problem+json errors
 * incl. 503 dependency_unavailable when the DB is down.
 *
 * Auth: admin. Surface: internal.
 */

import { json } from '@sveltejs/kit';
import { z } from 'zod';
import { defineEndpoint } from '$lib/server/api/define.js';
import { mount } from '$lib/server/api/mount.js';
import { ApiProblem } from '$lib/server/api/problem.js';
import { Logger } from '$lib/server/utils/logger';
import { getPrimaryExternalIdProvider } from '$lib/server/utils/provider-config.js';
import { withTx } from '$lib/server/database/with-tx.js';
import {
    getDemoEligibleMedia,
    bulkUpsertDemoRatings,
} from '$lib/server/database/queries/user-ratings.queries.js';
import { unrestrictedAccess } from '$lib/server/database/queries/builders/media-access-boundary.js';
import { getUserIdByUsername } from '$lib/server/database/queries/users.queries.js';

const logger = Logger.for('DemoRatings');

const DemoRatingItemSchema = z.object({
    externalIds: z.record(z.string(), z.string()),
    title: z.string(),
    rating: z.number(),
    reason: z.string(),
});

const DemoRatingsResponseSchema = z.object({
    message: z.string(),
    ratings_created: z.number(),
    demo_ratings: z.array(DemoRatingItemSchema),
    next_step: z.string(),
});

// ---------------------------------------------------------------------------
// def
// ---------------------------------------------------------------------------

const def = defineEndpoint({
    auth: { kind: 'admin' },
    visibility: 'internal',
    request: {
        params: z.object({ userId: z.string() }),
    },
    handlers: {
        POST: async (_event, ctx) => {
            const { userId } = ctx.input!.params;

            const { getDb } = await import('$lib/server/database/connection.js');
            const sql = getDb();
            if (!sql) {
                return ApiProblem.dependencyUnavailable('Database not available');
            }

            logger.info('Creating demo ratings', { userId });

            // The [userId] path segment is a USERNAME — resolve to the stable
            // users.id UUID for user-data keys (mig 16.46.0).
            const uid = await getUserIdByUsername(sql, userId);
            if (!uid) {
                return ApiProblem.notFound('User not found');
            }

            // Get some media items with LIBRARY embeddings (UUID-based tables).
            // The query returns media_id directly, so no per-item resolve is needed.
            // Deliberately unfiltered: this is an admin-only demo/seed path that
            // picks arbitrary embedded titles to fabricate ratings for. It serves
            // no media to the caller, so no viewer boundary applies.
            const moviesWithEmbeddings = await getDemoEligibleMedia(sql, 8, unrestrictedAccess());

            if (moviesWithEmbeddings.length === 0) {
                return ApiProblem.validationFailed(
                    'No movies with embeddings found; run embedding generation first',
                );
            }

            // Create demo ratings (mix of good and average ratings)
            const demoRatings = [
                { rating: 4.5, reason: 'Great action movie' },
                { rating: 3.5, reason: 'Decent entertainment' },
                { rating: 4, reason: 'Good storyline' },
                { rating: 3, reason: 'Average but watchable' },
                { rating: 4.5, reason: 'Excellent cinematography' },
                { rating: 3.5, reason: 'Good for family viewing' },
                { rating: 4, reason: 'Interesting characters' },
                { rating: 3.5, reason: 'Well made film' },
            ];

            // Take the same window the legacy loop used: up to 6 items, and skip
            // any without a primary external ID (the legacy loop re-resolved the
            // external ID → media_id and skipped on miss — an item with no primary
            // external id could never resolve).
            const selected = moviesWithEmbeddings
                .slice(0, Math.min(moviesWithEmbeddings.length, 6))
                .map((movie, i) => ({ movie, rating: demoRatings[i] }))
                .filter(({ movie }) => movie.primary_ext_id !== '');

            // Single transaction, single multi-row upsert.
            const ratingsCreated = await withTx(sql, (tx) =>
                bulkUpsertDemoRatings(
                    tx,
                    uid,
                    selected.map(({ movie, rating }) => ({
                        mediaId: movie.media_id,
                        rating: rating.rating,
                    })),
                ),
            );

            const createdRatings = selected.map(({ movie, rating }) => ({
                externalIds: {
                    [getPrimaryExternalIdProvider()]: String(movie.primary_ext_id),
                },
                title: movie.title,
                rating: rating.rating,
                reason: rating.reason,
            }));

            logger.info('Demo ratings creation completed', { userId, ratingsCreated });

            return json(
                DemoRatingsResponseSchema.parse({
                    message: `Successfully created ${ratingsCreated} demo ratings for ${userId}`,
                    ratings_created: ratingsCreated,
                    demo_ratings: createdRatings,
                    next_step: 'You can now generate your AI profile!',
                }),
            );
        },
    },
});

export const { POST } = mount(def, { surface: 'internal' });
