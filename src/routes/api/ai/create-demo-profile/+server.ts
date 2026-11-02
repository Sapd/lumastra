// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * GET /api/ai/create-demo-profile
 *
 * Create a demo AI profile for the authenticated user using known movies.
 * Dev/demo tool — generates a pre-seeded watch history and profile embedding.
 *
 * Response: bare object via json() + problem+json errors
 * incl. 503 dependency_unavailable when the DB or AI service is down.
 *
 * Auth: user. Surface: internal.
 */

import { json } from '@sveltejs/kit';
import { z } from 'zod';
import { defineEndpoint } from '$lib/server/api/define.js';
import { mount } from '$lib/server/api/mount.js';
import { ApiProblem } from '$lib/server/api/problem.js';
import { Logger } from '$lib/server/utils/logger';
import type { UserSuggestionRow } from '$lib/server/database/queries/suggestion-management.queries';
import { aiDbService } from '$lib/server/services/database.service';

const logger = Logger.for('ai-create-demo-profile');

// Typed preferences schema covering all known shapes produced by user-profile.service
const UserProfilePreferencesSchema = z.object({
    genres: z.record(z.string(), z.number()).optional(),
    created_from: z.string().optional(),
    watched_items: z.number().optional(),
    last_updated: z.string().optional(),
});

const DemoWatchHistoryItemSchema = z.object({
    tmdb_id: z.number(),
    title: z.string(),
    playCount: z.number(),
});

const DemoSuggestionSampleSchema = z.object({
    primary_ext_id: z.string().optional(),
    media_type: z.string(),
    similarity_score: z.number(),
    suggestion_reason: z.string().optional(),
});

const DemoProfileResponseSchema = z.object({
    user_id: z.string(),
    demo_watch_history: z.array(DemoWatchHistoryItemSchema),
    profile_created: z.boolean(),
    profile_embedding_length: z.number(),
    preferences: UserProfilePreferencesSchema.optional(),
    suggestions_generated: z.boolean(),
    suggestions_count: z.number(),
    suggestions_sample: z.array(DemoSuggestionSampleSchema),
});

// ---------------------------------------------------------------------------
// def
// ---------------------------------------------------------------------------

const def = defineEndpoint({
    auth: { kind: 'user' },
    visibility: 'internal',
    handlers: {
        GET: async (event) => {
            const { getDb } = await import('$lib/server/database/connection.js');
            const sql = getDb();
            if (!sql) {
                return ApiProblem.dependencyUnavailable('Database not available');
            }

            const profileService = await aiDbService.getUserProfileService();
            const suggestionEngine = await aiDbService.getSuggestionEngine();
            if (!profileService || !suggestionEngine) {
                return ApiProblem.dependencyUnavailable('AI service not available');
            }

            const userId = event.locals.user.userId;

            logger.info('Creating demo profile for user', { userId });

            // Create watch history based on some of the movies we have embeddings for
            const demoWatchHistory = [
                {
                    tmdb_id: 157336, // Interlumastra
                    media_type: 'movie' as const,
                    title: 'Interlumastra',
                    genres: [12, 18, 878], // Adventure, Drama, Sci-Fi
                    overview:
                        "A team of explorers travel through a wormhole in space in an attempt to ensure humanity's survival.",
                    playCount: 3,
                    playbackPositionTicks: 0,
                    runtimeTicks: 10200000000, // ~2.8 hours
                },
                {
                    tmdb_id: 575264, // Mission: Impossible - Dead Reckoning Teil Eins
                    media_type: 'movie' as const,
                    title: 'Mission: Impossible - Dead Reckoning Teil Eins',
                    genres: [28, 12, 53], // Action, Adventure, Thriller
                    overview:
                        'Ethan Hunt and his IMF team embark on their most dangerous mission yet.',
                    playCount: 2,
                    playbackPositionTicks: 0,
                    runtimeTicks: 9600000000, // ~2.7 hours
                },
                {
                    tmdb_id: 7451, // xXx - Triple X
                    media_type: 'movie' as const,
                    title: 'xXx - Triple X',
                    genres: [28, 12, 53, 80], // Action, Adventure, Thriller, Crime
                    overview:
                        'Xander Cage is your standard adrenaline junkie with no fear and a lousy attitude.',
                    playCount: 1,
                    playbackPositionTicks: 0,
                    runtimeTicks: 7200000000, // ~2 hours
                },
            ];

            // Create or update profile
            const userProfile = await profileService.createUserProfileFromWatchHistory(
                userId,
                demoWatchHistory,
            );

            let suggestionsGenerated = false;
            let suggestions: UserSuggestionRow[] = [];

            if (userProfile) {
                logger.info('Profile created successfully', { userId });

                // Generate suggestions
                suggestions = await suggestionEngine.generateSuggestionsFromProfile(userId, 10);
                suggestionsGenerated = suggestions.length > 0;

                if (suggestionsGenerated) {
                    logger.info('Generated suggestions', { userId, count: suggestions.length });
                }
            }

            return json(
                DemoProfileResponseSchema.parse({
                    user_id: userId,
                    demo_watch_history: demoWatchHistory.map((m) => ({
                        tmdb_id: m.tmdb_id,
                        title: m.title,
                        playCount: m.playCount,
                    })),
                    profile_created: !!userProfile,
                    profile_embedding_length: Array.isArray(userProfile?.catalog_embedding)
                        ? userProfile?.catalog_embedding.length
                        : 0,
                    preferences: userProfile?.preferences,
                    suggestions_generated: suggestionsGenerated,
                    suggestions_count: suggestions.length,
                    suggestions_sample: suggestions.slice(0, 5).map((s) => ({
                        primary_ext_id: s.primary_ext_id ?? undefined,
                        media_type: s.media_type,
                        similarity_score: s.combined_score ?? 0,
                        suggestion_reason: s.suggestion_reason ?? undefined,
                    })),
                }),
            );
        },
    },
});

export const { GET } = mount(def, { surface: 'internal' });
