// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * defs/ai/force-suggestions.ts — GET /api/ai/force-suggestions
 *
 * Admin/debug: force-generate suggestions for the calling user, deleting any
 * existing ones first. Returns a typed bare object with the generated list.
 * Internal surface only.
 */

import { z } from 'zod';
import { defineEndpoint } from '$lib/server/api/define.js';
import { ApiProblem } from '$lib/server/api/problem.js';
import { json } from '@sveltejs/kit';
import { Logger } from '$lib/server/utils/logger.js';
import { deleteUserSuggestions } from '$lib/server/database/queries/ai-admin.queries.js';
import { aiDbService } from '$lib/server/services/database.service.js';

const logger = Logger.for('ForceSuggestions');

// Typed suggestion item — no z.any() / passthrough
const ForceSuggestionItemSchema = z.object({
    media_id: z.string(),
    primary_ext_id: z.string().optional(),
    media_type: z.string(),
    similarity_score: z.number(),
    suggestion_reason: z.string().optional(),
    is_available: z.boolean(),
    can_request: z.boolean(),
});

// Bare object response
const ForceSuggestionsResponseSchema = z.object({
    user_id: z.string(),
    suggestions_generated: z.number(),
    suggestions: z.array(ForceSuggestionItemSchema),
});

export const def = defineEndpoint({
    auth: { kind: 'admin' },
    visibility: 'internal',

    handlers: {
        GET: async (event) => {
            if (!event.locals.user) {
                return ApiProblem.unauthorized();
            }

            const { getDb } = await import('$lib/server/database/connection.js');
            const sql = getDb();
            const userId = event.locals.user.userId;

            logger.info('Generating suggestions', { userId });
            if (!sql) {
                return ApiProblem.dependencyUnavailable('AI database not available');
            }

            await deleteUserSuggestions(sql, userId);
            logger.info('Cleared existing suggestions', { userId });

            const suggestionEngine = await aiDbService.getSuggestionEngine();
            if (!suggestionEngine) {
                return ApiProblem.dependencyUnavailable('AI suggestion engine unavailable');
            }
            const suggestions = await suggestionEngine.generateSuggestionsFromProfile(userId, 10);

            logger.info('Generated suggestions', { count: suggestions.length, userId });

            const body = ForceSuggestionsResponseSchema.parse({
                user_id: userId,
                suggestions_generated: suggestions.length,
                suggestions: suggestions
                    .filter((s) => s.combined_score !== null)
                    .map((s) => ({
                        media_id: s.media_id,
                        primary_ext_id: s.primary_ext_id ?? undefined,
                        media_type: s.media_type,
                        similarity_score: s.combined_score as number,
                        suggestion_reason: s.suggestion_reason ?? undefined,
                        is_available: s.is_available,
                        can_request: s.can_request,
                    })),
            });
            return json(body);
        },
    },
});
