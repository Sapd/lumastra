// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * defs/user/music/pinned-genres.ts — `GET/POST/DELETE /api/me/music/pinned-genres`
 * (internal surface) also published as `GET/POST /api/v1/me/music/pinned-genres`
 * + `DELETE /api/v1/me/music/pinned-genres/{genre}` (beta).
 *
 * Manages a user's pinned genre list on the /music homepage.
 *
 * GET  → bare object `{ items: PinnedGenre[] }`
 * POST → bare object `{ message, genre }` — pins a genre; capped at 20.
 * DELETE → bare object `{ message, genre }` — unpins a genre. The genre comes
 *   from the `{genre}` path param on the v1 surface; the internal route keeps
 *   passing it in a JSON body (DELETE bodies are dropped by some HTTP clients,
 *   proxies and SDK generators, so the published surface uses the path param
 *   instead). The path param is preferred; the body is a fallback so the
 *   internal route keeps working unchanged.
 *
 * Errors → problem+json. DB-down → 503 dependency_unavailable.
 * Missing genre on DELETE → 404 not_found.
 * Cap exceeded on POST → 422 validation_failed.
 */

import { readBoundedJson } from '$lib/server/utils/bounded-body-reader.js';
import { json } from '@sveltejs/kit';
import type { RouteMetadata } from '$lib/server/openapi.js';
import { defineEndpoint } from '$lib/server/api/define.js';
import { ApiProblem } from '$lib/server/api/problem.js';
import { getDb } from '$lib/server/database/connection.js';
import { Logger } from '$lib/server/utils/logger.js';
import {
    getPinnedGenres,
    pinGenre,
    unpinGenre,
    type PinnedGenreRow,
} from '$lib/server/database/queries/index.js';
import { pinGenreBodySchema, unpinGenreBodySchema } from '$lib/schemas/common.js';
import {
    MusicPinnedGenresResponseSchema,
    PinGenreResponseSchema,
} from '$lib/schemas/api-music-responses.js';

const logger = Logger.for('PinnedGenresDef');

const MAX_PINNED_GENRES = 20;

interface PinnedGenre {
    id: number;
    genre: string;
    position: number;
    pinnedAt: string;
}

function transformRow(row: PinnedGenreRow): PinnedGenre {
    return {
        id: row.id,
        genre: row.genre,
        position: row.position,
        pinnedAt:
            row.pinned_at instanceof Date ? row.pinned_at.toISOString() : String(row.pinned_at),
    };
}

// ---------------------------------------------------------------------------
// OpenAPI docs — this def is mounted at THREE paths: the internal collection
// `/api/me/music/pinned-genres` (GET+POST+DELETE, DELETE reads a JSON body), and
// two public v1 mounts that split the same operations across two paths
// (`/api/v1/me/music/pinned-genres` → GET+POST, `/api/v1/me/music/pinned-genres/{genre}`
// → DELETE by path param). A single `docs` object can't express "GET+POST here,
// DELETE there", so `docsByPath` returns the metadata appropriate to whichever
// path the generator is asking about.
// ---------------------------------------------------------------------------
const GET_DOCS: RouteMetadata['GET'] = {
    tags: ['Music'],
    summary: 'List pinned genres',
    stability: 'beta',
    auth: 'bearer',
    description: 'Returns the caller’s pinned music genres in display order.',
    responses: {
        200: {
            schema: MusicPinnedGenresResponseSchema,
            description: 'Pinned genres in display order',
        },
        401: 'Authentication required',
        503: 'Database unavailable',
    },
};

const POST_DOCS: RouteMetadata['POST'] = {
    tags: ['Music'],
    summary: 'Pin a genre',
    stability: 'beta',
    auth: 'bearer',
    description: 'Pins a genre for the caller. Capped at 20 pinned genres.',
    body: pinGenreBodySchema,
    responses: {
        200: { schema: PinGenreResponseSchema, description: 'Genre pinned' },
        401: 'Authentication required',
        422: 'Invalid genre or pin limit reached',
        503: 'Database unavailable',
    },
};

const DELETE_DOCS: RouteMetadata['DELETE'] = {
    tags: ['Music'],
    summary: 'Unpin a genre',
    stability: 'beta',
    auth: 'bearer',
    description:
        'Unpins a genre for the caller. A `/` inside a genre name must be ' +
        'percent-encoded as `%2F` by the client, since the genre is passed as a path segment.',
    responses: {
        200: { schema: PinGenreResponseSchema, description: 'Genre unpinned' },
        401: 'Authentication required',
        422: 'Invalid genre',
        503: 'Database unavailable',
    },
};

const COLLECTION_DOCS: RouteMetadata = { GET: GET_DOCS, POST: POST_DOCS };
const GENRE_NODE_DOCS: RouteMetadata = { DELETE: DELETE_DOCS };
const INTERNAL_COLLECTION_DOCS: RouteMetadata = {
    GET: GET_DOCS,
    POST: POST_DOCS,
    DELETE: DELETE_DOCS,
};

export const def = defineEndpoint({
    auth: { kind: 'user' },
    visibility: 'public',

    docsByPath: (openApiPath: string): RouteMetadata | undefined => {
        if (openApiPath.endsWith('/pinned-genres/{genre}')) return GENRE_NODE_DOCS;
        if (openApiPath.endsWith('/pinned-genres')) {
            return openApiPath.includes('/v1/') ? COLLECTION_DOCS : INTERNAL_COLLECTION_DOCS;
        }
        return undefined;
    },

    handlers: {
        GET: async (event, _ctx) => {
            const userId = event.locals.user?.userId;
            if (!userId) return ApiProblem.unauthorized();

            const sql = getDb();
            if (!sql) return ApiProblem.dependencyUnavailable('Database not available');

            const result = await getPinnedGenres.all(sql, { userId });
            const items: PinnedGenre[] = result.map(transformRow);

            return json({ items });
        },

        POST: async (event, _ctx) => {
            const user = event.locals.user;
            if (!user) return ApiProblem.unauthorized();

            let body: { genre: string };
            try {
                const raw = await readBoundedJson(event.request);
                const parsed = pinGenreBodySchema.safeParse(raw);
                if (!parsed.success) {
                    return ApiProblem.validationFailed(
                        parsed.error.issues.map((e) => ({
                            field: e.path.join('.'),
                            message: e.message,
                        })),
                    );
                }
                body = parsed.data;
            } catch {
                return ApiProblem.validationFailed('Invalid JSON body');
            }

            const sql = getDb();
            if (!sql) return ApiProblem.dependencyUnavailable('Database not available');

            const existing = await getPinnedGenres.count(sql, { userId: user.userId });
            if (existing >= MAX_PINNED_GENRES) {
                return ApiProblem.validationFailed(
                    `Maximum ${MAX_PINNED_GENRES} pinned genres allowed`,
                );
            }

            await pinGenre.execute(sql, { userId: user.userId, genre: body.genre });

            logger.info('Genre pinned', { username: user.username, genre: body.genre });

            return json({ message: 'Genre pinned successfully', genre: body.genre });
        },

        DELETE: async (event, _ctx) => {
            const user = event.locals.user;
            if (!user) return ApiProblem.unauthorized();

            // v1 passes the genre as a path segment; the internal route passes a
            // JSON body. DELETE bodies are dropped by some clients and proxies,
            // so the published surface uses the path param. SvelteKit already
            // decodes route params (decode_params → decodeURIComponent) before
            // the handler ever sees them, so no further decoding happens here.
            let genre = event.params.genre || undefined;
            if (!genre) {
                let raw: unknown;
                try {
                    raw = await readBoundedJson(event.request);
                } catch {
                    return ApiProblem.validationFailed('Invalid JSON body');
                }
                const parsed = unpinGenreBodySchema.safeParse(raw);
                if (!parsed.success) {
                    return ApiProblem.validationFailed(
                        parsed.error.issues.map((e) => ({
                            field: e.path.join('.'),
                            message: e.message,
                        })),
                    );
                }
                genre = parsed.data.genre;
            }

            // Validate the resolved genre through the same schema regardless of
            // source (path param or body) — otherwise a >255-char genre from the
            // path param hits the varchar(255) column and 500s instead of a
            // clean 422.
            const validated = unpinGenreBodySchema.safeParse({ genre });
            if (!validated.success) {
                return ApiProblem.validationFailed(
                    validated.error.issues.map((e) => ({
                        field: e.path.join('.'),
                        message: e.message,
                    })),
                );
            }
            genre = validated.data.genre;

            const sql = getDb();
            if (!sql) return ApiProblem.dependencyUnavailable('Database not available');

            const result = await unpinGenre.all(sql, { userId: user.userId, genre });

            if (result.length === 0) {
                return ApiProblem.notFound('Pinned genre not found');
            }

            logger.info('Genre unpinned', { username: user.username, genre });

            return json({ message: 'Genre unpinned successfully', genre });
        },
    },
});
