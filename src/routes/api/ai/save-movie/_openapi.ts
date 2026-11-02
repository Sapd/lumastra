// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import type { RouteMetadata } from '$lib/server/openapi';
import { saveMovieBodySchema, unsaveMovieBodySchema } from '$lib/schemas/ai';
import { SaveMovieResponseSchema } from '$lib/schemas/api-ai-responses';

export { saveMovieBodySchema, unsaveMovieBodySchema, SaveMovieResponseSchema };

export const route: RouteMetadata = {
    POST: {
        tags: ['AI'],
        summary: "Save a movie to user's list",
        description:
            "Saves a movie or series to the current user's saved list for later viewing. Requires external IDs, media type, and title.",
        body: saveMovieBodySchema,
        responses: {
            200: {
                schema: SaveMovieResponseSchema,
                description: 'Movie saved successfully',
            },
        },
    },
    DELETE: {
        tags: ['AI'],
        summary: 'Remove a saved movie',
        description:
            "Removes a previously saved movie or series from the current user's saved list.",
        body: unsaveMovieBodySchema,
        responses: {
            200: {
                schema: SaveMovieResponseSchema,
                description: 'Movie removed from saved list',
            },
        },
    },
};
