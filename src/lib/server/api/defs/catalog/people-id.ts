// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * defs/catalog/people-id.ts — `people/{id}` detail node.
 *
 * Auth: user (any authenticated caller).
 */

import { z } from 'zod';
import { defineEndpoint } from '$lib/server/api/define.js';
import {
    handlePersonGet,
    resolvePersonAccessBoundary,
} from '$lib/server/services/person.service.js';
import { PersonDetailResponseSchema } from '$lib/schemas/api-person-responses';

export const def = defineEndpoint({
    docs: {
        GET: {
            tags: ['People'],
            summary: 'Get a person',
            stability: 'stable',
            auth: 'bearer',
            description:
                'Returns biography, profile ImageSet and filmography MediaPreviews. Accepts tmdb:123 or numeric aliases; returns the canonical handle. Credits are filtered by caller access and capped at 30 per array, with creditsTruncated. libraryOnly=true keeps only accessible library titles.',
            query: z.object({
                libraryOnly: z
                    .enum(['true', 'false'])
                    .optional()
                    .describe('Return only accessible library titles'),
            }),
            responses: {
                200: { schema: PersonDetailResponseSchema, description: 'Person details' },
                422: 'Invalid person handle',
                401: 'Authentication required',
                404: 'Person not found',
                503: 'Database unavailable',
                500: 'Internal server error',
            },
        },
    },

    auth: { kind: 'user' },

    handlers: {
        /**
         * GET /people/{id}
         *
         * Delegates to the shared person-fetch service with the param remapped
         * from `id` → `personId` so the underlying handler logic stays unchanged.
         *
         * The access boundary is built here rather than inside the service:
         * `auth: { kind: 'user' }` guarantees an authenticated caller, and
         * `resolvePersonAccessBoundary` fails closed (denyAll) if `locals.user`
         * is nonetheless absent or the boundary cannot be looked up.
         */
        GET: async (event, ctx) => {
            // Remap: new param name `id` → legacy param name `personId`
            const patchedEvent = Object.create(event) as typeof event;
            patchedEvent.params = { ...event.params, personId: event.params.id ?? '' };
            const boundary = await resolvePersonAccessBoundary(event.locals.user);
            return handlePersonGet(patchedEvent, boundary, ctx.surface);
        },
    },
});
