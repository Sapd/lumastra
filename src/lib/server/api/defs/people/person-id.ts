// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * defs/people/person-id.ts — GET /api/person/[personId]
 *
 * Person details & filmography. Delegates to person.service.ts.
 *
 * Contract: bare object — PersonDetailResponse.
 * Auth: user.
 *
 * @deprecated Use /api/people/{id} or /api/v1/people/{id} for new clients.
 */

import { z } from 'zod';
import { PersonDetailResponseSchema } from '$lib/schemas/api-person-responses.js';
import { defineEndpoint } from '$lib/server/api/define.js';
import {
    handlePersonGet,
    resolvePersonAccessBoundary,
} from '$lib/server/services/person.service.js';

// ---------------------------------------------------------------------------
// def
// ---------------------------------------------------------------------------

export const def = defineEndpoint({
    auth: { kind: 'user' },
    visibility: 'internal',
    docs: {
        GET: {
            tags: ['People'],
            summary: 'Get person details (legacy path)',
            stability: 'stable',
            auth: 'bearer',
            description:
                'Accepts numeric aliases or tmdb:123 and returns canonical person identity, profile ImageSet and filmography MediaPreviews. libraryOnly=true keeps accessible library titles. Each credit array caps at 30; creditsTruncated reports omitted credits.',
            query: z.object({ libraryOnly: z.enum(['true', 'false']).optional() }),
            responses: {
                200: { schema: PersonDetailResponseSchema, description: 'Person detail' },
                422: 'Invalid person handle',
                401: 'Authentication required',
                404: 'Person not found',
                500: 'Person lookup failed',
            },
        },
    },
    request: {
        params: z.object({ personId: z.string().min(1) }),
    },
    handlers: {
        GET: async (event, ctx) => {
            // `auth: { kind: 'user' }` guarantees an authenticated caller;
            // resolvePersonAccessBoundary still fails closed (denyAll) if
            // `locals.user` is absent or the boundary lookup is unavailable.
            const boundary = await resolvePersonAccessBoundary(event.locals.user);
            return handlePersonGet(event, boundary, ctx.surface);
        },
    },
});
