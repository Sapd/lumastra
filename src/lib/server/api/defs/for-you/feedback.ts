// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * POST /api/v1/for-you/feedback — section-level interaction beacon.
 *
 * Body: { sectionType: SectionTypeEnum, event: FeedbackEventEnum }
 *
 * Internal telemetry only — fire-and-forget from the client.
 * Data feeds the future page-level section ranker.
 */

import { json } from '@sveltejs/kit';
import { defineEndpoint } from '$lib/server/api/define.js';
import { ApiProblem } from '$lib/server/api/problem.js';
import { ForYouFeedbackBodySchema } from '$lib/schemas/api-for-you-responses.js';
import { Logger } from '$lib/server/utils/logger.js';
import { OkAckResponseSchema } from '$lib/schemas/api-for-you-responses';

const logger = Logger.for('ForYouFeedbackDef');

export const def = defineEndpoint({
    docs: {
        // The endpoint def marks this surface internal (telemetry beacon feeding the
        // section ranker) — keep it out of the published api-v1.yaml.
        visibility: 'internal',
        POST: {
            tags: ['For You'],
            summary: 'Record a for-you section interaction beacon',
            stability: 'beta',
            auth: 'bearer',
            body: ForYouFeedbackBodySchema,
            responses: {
                200: { schema: OkAckResponseSchema, description: 'Feedback recorded' },
                401: 'Authentication required',
                422: 'Validation failed',
                503: 'Database unavailable',
                500: 'Internal server error',
            },
        },
    },

    auth: { kind: 'user' },
    visibility: 'internal',
    request: {
        body: ForYouFeedbackBodySchema,
    },
    handlers: {
        POST: async (event, ctx) => {
            const userId = event.locals.user?.userId;
            const username = event.locals.user?.username;
            if (!userId || !username) return ApiProblem.unauthorized();

            const body = ctx.input?.body;
            if (!body) return ApiProblem.validationFailed([{ field: 'body', message: 'Required' }]);

            const { sectionType, event: feedbackEvent } = body;

            const { getDb } = await import('$lib/server/database/connection.js');
            const sql = getDb();
            if (!sql) return ApiProblem.dependencyUnavailable('Database not available');

            const { bumpFeedback } =
                await import('$lib/server/database/queries/user-section-feedback.queries.js');

            try {
                await bumpFeedback(sql, { userId, sectionType, event: feedbackEvent });
                logger.debug('Recorded section feedback', { username, sectionType, feedbackEvent });
                return json({ ok: true });
            } catch (err) {
                logger.error('Failed to record section feedback', err as Error);
                return ApiProblem.internalError();
            }
        },
    },
});
