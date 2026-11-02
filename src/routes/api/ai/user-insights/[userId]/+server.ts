// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

// User AI Insights API - Explains how recommendations work
import { json } from '@sveltejs/kit';
import { z } from 'zod';
import { defineEndpoint } from '$lib/server/api/define.js';
import { mount } from '$lib/server/api/mount.js';
import { ApiProblem } from '$lib/server/api/problem.js';
import { Logger } from '$lib/server/utils/logger';
import { config } from '$lib/server/config';
import type { UserRating } from '$lib/server/database';
import { aiDbService } from '$lib/server/services/database.service';

const logger = Logger.for('UserInsights');

// Typed insight item — discriminated by category
const insightItemSchema = z.object({
    category: z.string(),
    strength: z.number(),
    description: z.string(),
    examples: z.array(z.string()),
    color: z.string(),
});

const userInsightsResponseSchema = z.object({
    insights: z.array(insightItemSchema),
    stats: z.object({
        total_ratings: z.number(),
        confidence: z.number(),
        last_updated: z.string(),
    }),
});

export type UserInsightsResponse = z.infer<typeof userInsightsResponseSchema>;

const def = defineEndpoint({
    auth: { kind: 'selfOrAdmin', param: 'userId' },
    visibility: 'internal',
    handlers: {
        GET: async (event, _ctx) => {
            let userId = event.params.userId ?? '';

            if (!userId) {
                return ApiProblem.validationFailed('userId is required');
            }

            // Get the effective current user (allows devUser cookie override in development only)
            const { getEffectiveUser } = await import('$lib/server/dev-user');
            const effectiveCurrentUser = getEffectiveUser(
                event.request,
                event.locals.user?.username,
            );

            // Handle generic "user" parameter - resolve to effective current user
            if (userId === 'user') {
                userId = effectiveCurrentUser;
                logger.debug('Resolved user ID', { resolvedUserId: userId });
            }

            // The [userId] path segment is a USERNAME — resolve to the stable
            // users.id UUID for user-data keys (mig 16.46.0).
            const { getDb } = await import('$lib/server/database/connection');
            const sql = getDb();
            if (!sql) {
                return ApiProblem.dependencyUnavailable('Database not available');
            }
            const { getUserIdByUsername } =
                await import('$lib/server/database/queries/users.queries');
            const uid = await getUserIdByUsername(sql, userId);
            if (!uid) {
                return ApiProblem.notFound('User not found');
            }

            // Get user profile and ratings
            const userProfile = await aiDbService.getUserProfileOrCreate(uid);
            const userRatings = await aiDbService.getUserRatings(uid, 100);

            const minRatings = config.FORYOU_MIN_RATINGS;
            if (!userProfile || userRatings.length < minRatings) {
                logger.info('Insufficient data for user insights', {
                    userId,
                    ratingsCount: userRatings.length,
                    required: minRatings,
                });
                return ApiProblem.validationFailed(
                    `Insufficient data: need ${minRatings} ratings, have ${userRatings.length}`,
                );
            }

            // Analyze user ratings to generate insights
            const insights = await generateUserInsights(userRatings);

            logger.info('User insights generated successfully', {
                userId,
                insightsCount: insights.length,
            });

            return json(
                userInsightsResponseSchema.parse({
                    insights,
                    stats: {
                        total_ratings: userRatings.length,
                        confidence: Math.min(95, Math.max(10, userRatings.length * 5)), // Rough confidence based on ratings count
                        last_updated: userProfile.updated_at
                            ? new Date(userProfile.updated_at).toLocaleDateString()
                            : 'Unknown',
                    },
                } satisfies UserInsightsResponse),
            );
        },
    },
});

export const { GET } = mount(def, { surface: 'internal' });

async function generateUserInsights(ratings: UserRating[]) {
    const insights = [];

    // Analyze rating patterns
    const ratingStats = analyzeRatings(ratings);

    // Genre preferences (if we have genre data)
    if (ratingStats.genrePreferences.length > 0) {
        const topGenres = ratingStats.genrePreferences.slice(0, 3);
        insights.push({
            category: 'Genre Preferences',
            strength: Math.min(95, topGenres[0].count * 20), // Rough strength calculation
            description: `You particularly enjoy ${topGenres.map((g) => g.name).join(', ')} content`,
            examples: topGenres.map((g) => `${g.name} (${g.avgRating.toFixed(1)}⭐)`),
            color: 'rgb(59, 130, 246)', // blue
        });
    }

    // Quality standards
    const avgRating = ratingStats.averageRating;
    const qualityThreshold = avgRating > 3.5;
    insights.push({
        category: 'Quality Standards',
        strength: qualityThreshold ? Math.round((avgRating - 1) * 25) : 40,
        description: qualityThreshold
            ? `You prefer high-quality content (avg rating: ${avgRating.toFixed(1)}/5)`
            : `You enjoy a wide range of content quality (avg rating: ${avgRating.toFixed(1)}/5)`,
        examples: qualityThreshold
            ? ['High IMDb ratings', 'Critical acclaim', 'Award winners']
            : ['Mix of popular and niche', 'Experimental content', 'Hidden gems'],
        color: 'rgb(16, 185, 129)', // emerald
    });

    // Recent vs classic content
    const recentContent = ratings.filter(() => {
        // This would need actual release date data from the database
        // For now, just use a rough heuristic
        return Math.random() > 0.5; // Mock data
    });

    const recentPercentage = (recentContent.length / ratings.length) * 100;
    insights.push({
        category: 'Era Preferences',
        strength: Math.abs(recentPercentage - 50) + 50, // Higher if strongly recent or classic
        description:
            recentPercentage > 60
                ? 'You prefer modern and recent releases'
                : recentPercentage < 40
                  ? 'You appreciate classic and older content'
                  : 'You enjoy a balanced mix of eras',
        examples:
            recentPercentage > 60
                ? ['Recent releases', 'Modern filmmaking', 'Current trends']
                : recentPercentage < 40
                  ? ['Classic cinema', 'Timeless stories', 'Vintage aesthetics']
                  : ['Best of both worlds', 'Timeless + modern', 'No era bias'],
        color: 'rgb(245, 158, 11)', // amber
    });

    // Diversity insight
    const uniqueRatings = new Set(ratings.map((r) => r.rating)).size;
    const isDiverseRater = uniqueRatings >= 4; // Uses most of the 1-5 scale

    insights.push({
        category: 'Rating Style',
        strength: isDiverseRater ? 75 : 45,
        description: isDiverseRater
            ? 'You use the full rating scale and are discerning'
            : 'You tend to rate most content similarly',
        examples: isDiverseRater
            ? ['Critical evaluation', 'Nuanced opinions', 'Clear preferences']
            : ['Consistent standards', 'Generally positive', 'Easy to please'],
        color: 'rgb(168, 85, 247)', // purple
    });

    return insights;
}

function analyzeRatings(ratings: UserRating[]) {
    const totalRatings = ratings.length;
    const averageRating = ratings.reduce((sum, r) => sum + r.rating, 0) / totalRatings;

    // Mock genre analysis - in reality you'd join with media_catalog to get genres
    const mockGenres = [
        { name: 'Action', count: 8, avgRating: 4.2 },
        { name: 'Sci-Fi', count: 6, avgRating: 4.5 },
        { name: 'Drama', count: 4, avgRating: 3.8 },
    ];

    return {
        totalRatings,
        averageRating,
        genrePreferences: mockGenres.sort((a, b) => b.avgRating - a.avgRating),
    };
}
