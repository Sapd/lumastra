// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only
import { refreshRateLimit } from '../../recommendations/_refresh-rate-limit.js';
import { json } from '@sveltejs/kit';
import { defineEndpoint } from '$lib/server/api/define.js';
import { ApiProblem, isDependencyUnavailable } from '$lib/server/api/problem.js';
import { TasteRailResponseSchema } from '$lib/schemas/api-for-you-responses.js';
import { buildAccessContext } from '../../recommendations/recommender.js';
import { TasteQuerySchema, getTasteRailPage } from '../taste.js';
const Body = TasteQuerySchema.omit({ cursor: true })
    .loose()
    .superRefine((body, ctx) => {
        for (const field of ['refresh', 'offset', 'cursor']) {
            if (field in body)
                ctx.addIssue({
                    code: 'custom',
                    path: [field],
                    message: 'Not accepted by this refresh action',
                });
        }
    });

export const def = defineEndpoint({
    visibility: 'internal',
    auth: { kind: 'user' },
    rateLimit: refreshRateLimit,
    request: { body: Body },
    docs: {
        POST: {
            tags: ['For You'],
            summary: 'Refresh the taste rail',
            stability: 'beta',
            body: TasteQuerySchema.omit({ cursor: true }),
            responses: {
                200: { schema: TasteRailResponseSchema, description: 'First taste page' },
                401: 'Authentication required',
                429: 'Refresh budget exhausted (30/minute per user)',
                422: 'Invalid first-page refresh filters',
                503: 'Database unavailable',
            },
        },
    },
    handlers: {
        POST: async (event, ctx) => {
            const access = await buildAccessContext(event);
            if (!access) return ApiProblem.unauthorized();
            try {
                return json(
                    TasteRailResponseSchema.parse(
                        await getTasteRailPage(access, {
                            surface: ctx.surface,
                            limit: ctx.input!.body!.limit,
                            refresh: true,
                        }),
                    ),
                );
            } catch (err) {
                if (isDependencyUnavailable(err))
                    return ApiProblem.dependencyUnavailable(err.message);
                throw err;
            }
        },
    },
});
