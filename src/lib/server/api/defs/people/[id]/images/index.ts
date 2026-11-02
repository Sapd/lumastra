// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/** Person artwork listing. A known profile path is exposed as primary with real TMDB renditions; absent profiles have an empty image set. */

import {
    handlePersonGet,
    resolvePersonAccessBoundary,
} from '$lib/server/services/person.service.js';
import { ImageSetSchema } from '$lib/schemas/api-image-descriptor.js';
import { json } from '@sveltejs/kit';
import { defineEndpoint } from '$lib/server/api/define.js';
import { ApiProblem } from '$lib/server/api/problem.js';
import { z } from 'zod';
import { parsePersonHandle } from '$lib/shared/person-handle.js';

const ImagesListResponseSchema = z.object({ id: z.string(), images: ImageSetSchema });

// No request schema needed — the {id} param format is validated inline
// in the handler (accepts bare numeric TMDB id or "tmdb:<n>"); the
// SvelteKit route param is a free-form string and is not a UUID.

// ownership: none — a person is not a user-owned resource and the artwork is
// provider metadata (TMDB), identical for every caller. There is no per-user
// dimension for a gate to consult, so this is a genuine exemption rather than a
// deferred finding.
export const def = defineEndpoint({
    docs: {
        GET: {
            tags: ['People'],
            summary: 'List available image roles for a person',
            stability: 'stable',
            auth: 'bearer',
            description:
                'Returns which image roles are available for the given person (actor/director/crew). ' +
                'Accepts tmdb:123 and positive numeric aliases; returns the canonical handle. People expose profile artwork as `primary`, with thumb/card/full variants mapped to w45/w185/original. ' +
                'Does not return raw image bytes — use `GET /api/v1/people/{id}/images/profile` for that.',
            responses: {
                200: {
                    schema: ImagesListResponseSchema,
                    description: 'Available image roles',
                },
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
        GET: async (event, ctx) => {
            const { params } = event;
            const id = params.id ?? '';

            const parsed = parsePersonHandle(id);
            if (!parsed.ok)
                return ApiProblem.validationFailed([
                    { field: 'id', message: 'Invalid person handle' },
                ]);
            const patchedEvent = Object.create(event) as typeof event;
            patchedEvent.params = { ...event.params, personId: parsed.handle };
            const boundary = await resolvePersonAccessBoundary(event.locals.user);
            const response = await handlePersonGet(patchedEvent, boundary, ctx.surface);
            if (!response.ok) return response;
            const person = (await response.json()) as { images: unknown };
            const images = ImageSetSchema.safeParse(person.images);
            return json({ id: parsed.handle, images: images.success ? images.data : {} });
        },
    },
});
