// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * defs/ai/generate-suggestions.ts — POST /api/ai/generate-suggestions/[userId]
 *
 * Admin: generate AI suggestions for a specific user (by username).
 * Rate-limited via withAISuggestionRateLimit. Clears existing suggestions
 * and generates fresh picks from the user's profile.
 * Internal surface only.
 */

import { z } from 'zod';
import { defineEndpoint } from '$lib/server/api/define.js';
import { ApiProblem } from '$lib/server/api/problem.js';
import { json } from '@sveltejs/kit';
import { Logger } from '$lib/server/utils/logger.js';
import { checkRateLimit, RateLimitPresets } from '$lib/server/middleware/valkey-rate-limit.js';
import { getClientIp } from '$lib/server/utils/client-ip.js';
import { deleteUserSuggestions } from '$lib/server/database/queries/ai-admin.queries.js';
import { generateSuggestionsParamsSchema } from '$lib/schemas/ai.js';
import { aiDbService } from '$lib/server/services/database.service.js';

const logger = Logger.for('GenerateSuggestionsEndpoint');

// Typed suggestion item — no z.any() / passthrough
const SuggestionItemSchema = z.object({
    media_id: z.string(),
    primary_ext_id: z.string().optional(),
    media_type: z.string(),
    /** Formatted similarity score, e.g. "87%" */
    similarity_score: z.string(),
    suggestion_reason: z.string().optional(),
    is_available: z.boolean(),
    can_request: z.boolean(),
});

// Bare object — no success wrapper
const SuggestionsResponseSchema = z.object({
    message: z.string(),
    user_id: z.string(),
    suggestions_count: z.number(),
    suggestions: z.array(SuggestionItemSchema),
});

const NoSuggestionsResponseSchema = z.object({
    message: z.string(),
    suggestions_count: z.literal(0),
});

export const def = defineEndpoint({
    auth: { kind: 'admin' },
    visibility: 'internal',
    request: {
        params: generateSuggestionsParamsSchema,
    },

    handlers: {
        POST: async (event, ctx) => {
            // Rate-limit check after auth (preserves original ordering: admin → rate-limit → domain)
            const ip = getClientIp(event);
            const username = event.locals.user?.username ?? 'anonymous';
            const rlKey = `${ip}:${username}:generate-suggestions`;
            const rl = RateLimitPresets.AI_SUGGESTIONS;
            const rlResult = await checkRateLimit(rlKey, rl.limit, rl.windowSeconds);
            if (!rlResult.allowed) {
                const retryAfter = Math.ceil((rlResult.resetAt * 1000 - Date.now()) / 1000);
                return ApiProblem.rateLimited(retryAfter > 0 ? retryAfter : 60);
            }

            // Params are already validated and typed by mount() via request.params schema
            const { userId: usernameParam } = ctx.input!.params as { userId: string };

            const { getDb } = await import('$lib/server/database/connection.js');
            const { getUserIdByUsername } =
                await import('$lib/server/database/queries/users.queries.js');

            logger.info('Starting suggestion generation', { userId: usernameParam });

            const sql = getDb();
            if (!sql) {
                return ApiProblem.dependencyUnavailable('AI database not initialized');
            }

            // [userId] segment is a username; resolve to users.id UUID (mig 16.46.0)
            const userId = await getUserIdByUsername(sql, usernameParam);
            if (!userId) {
                return ApiProblem.notFound('User not found');
            }

            const userRatings = await aiDbService.getUserRatings(userId, 100);
            const MINIMUM_RATINGS_REQUIRED = 5;

            if (userRatings.length < MINIMUM_RATINGS_REQUIRED) {
                return ApiProblem.validationFailed(
                    `Insufficient ratings: ${userRatings.length} of ${MINIMUM_RATINGS_REQUIRED} required to generate AI suggestions`,
                );
            }

            const userProfile = await aiDbService.getUserProfileOrCreate(userId);
            if (!userProfile?.catalog_embedding) {
                return ApiProblem.validationFailed(
                    `User ${userId} doesn't have an AI profile — profile must be generated from ratings before creating suggestions`,
                );
            }

            logger.info('User has profile, generating suggestions', { userId });

            await deleteUserSuggestions(sql, userId);
            logger.info('Cleared existing suggestions', { userId });

            const suggestionEngine = await aiDbService.getSuggestionEngine();
            if (!suggestionEngine) {
                return ApiProblem.dependencyUnavailable('AI suggestion engine unavailable');
            }
            const suggestions = await suggestionEngine.generateSuggestionsFromProfile(userId, 10);

            if (suggestions.length === 0) {
                const body = NoSuggestionsResponseSchema.parse({
                    message:
                        'No suggestions could be generated. This might happen if there are no suitable matches in the database.',
                    suggestions_count: 0,
                });
                return json(body);
            }

            logger.info('Generated suggestions', { userId, count: suggestions.length });

            const body = SuggestionsResponseSchema.parse({
                message: `Successfully generated ${suggestions.length} AI recommendations`,
                user_id: userId,
                suggestions_count: suggestions.length,
                suggestions: suggestions
                    .filter((s) => s.combined_score !== null)
                    .map((s) => ({
                        media_id: s.media_id,
                        primary_ext_id: s.primary_ext_id ?? undefined,
                        media_type: s.media_type,
                        similarity_score:
                            Math.min(Math.round((s.combined_score as number) * 100), 100) + '%',
                        suggestion_reason: s.suggestion_reason ?? undefined,
                        is_available: s.is_available,
                        can_request: s.can_request,
                    })),
            });
            return json(body);
        },
    },
});
