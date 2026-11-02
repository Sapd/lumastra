// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * defs/ai/save-movie.ts — POST /api/ai/save-movie & DELETE /api/ai/save-movie
 *
 * Internal BFF endpoints consumed by the SPA for watchlist management.
 * These are intentionally kept separate from the /watchlist def (which uses
 * the authenticated user's own UUID directly); here the caller still goes
 * through the getEffectiveUser dev-override path.
 *
 * POST  /api/ai/save-movie
 *   Body: { externalIds, mediaType, title }
 *   Returns: { message, saved, externalIds }
 *
 * DELETE /api/ai/save-movie
 *   Body: { externalIds, mediaType }
 *   Returns: { message, removed, externalIds }
 *
 * Errors via ApiProblem: 401 unauthorized, 404 not_found,
 *   422 validation_failed, 503 dependency_unavailable.
 *
 * Auth: user.
 */

import { json } from '@sveltejs/kit';
import { defineEndpoint } from '$lib/server/api/define.js';
import { ApiProblem } from '$lib/server/api/problem.js';
import { saveMovieBodySchema, unsaveMovieBodySchema } from '$lib/schemas/ai.js';
import { z } from 'zod';
import type { ExternalIds } from '$lib/types/api-common.js';

// Shared body superset: title optional so mount()'s single schema never
// rejects a valid DELETE body that lacks a title.
const sharedBodySchema = z
    .object({
        externalIds: z
            .record(z.string(), z.string())
            .refine((ids) => Object.values(ids).some((v) => v.length > 0), {
                message: 'At least one external ID is required',
            }),
        mediaType: z.enum(['movie', 'tv']).optional(),
        media_type: z.enum(['movie', 'tv']).optional(),
        title: z.string().min(1).optional(),
    })
    .refine((d) => (d.mediaType ?? d.media_type) !== undefined, {
        message: 'mediaType is required',
    })
    .transform((d) => ({
        externalIds: d.externalIds as ExternalIds,
        title: d.title,
        // constrained: both fields are z.enum(['movie','tv']) and the refine above
        // guarantees one is present, so this only discards `undefined`.
        // eslint-disable-next-line callback-safety/no-narrowing-media-type-cast
        mediaType: (d.mediaType ?? d.media_type) as 'movie' | 'tv',
    }));

export const def = defineEndpoint({
    auth: { kind: 'user' },
    visibility: 'internal',

    request: {
        body: sharedBodySchema,
    },

    handlers: {
        POST: async (event, ctx) => {
            const { locals, request } = event;

            const { externalIds, mediaType, title } = ctx.input!.body;

            if (!title) {
                return ApiProblem.validationFailed([
                    { field: 'body.title', message: 'Title is required' },
                ]);
            }

            const { getEffectiveUser } = await import('$lib/server/dev-user.js');
            const authenticatedUser = locals.user?.username;
            const effectiveUsername = getEffectiveUser(request, authenticatedUser);

            const { getDb } = await import('$lib/server/database/connection.js');
            const sql = getDb();
            if (!sql) {
                return ApiProblem.dependencyUnavailable('Database not available');
            }

            // getEffectiveUser returns a USERNAME — resolve to users.id UUID.
            const { getUserIdByUsername } =
                await import('$lib/server/database/queries/users.queries.js');
            const uid = await getUserIdByUsername(sql, effectiveUsername);
            if (!uid) {
                return ApiProblem.unauthorized('Authentication required');
            }

            const { watchlistManager } =
                await import('$lib/server/services/watchlist-manager.service.js');
            const { MediaAccessDeniedError } =
                await import('$lib/server/utils/resolve-and-gate.js');

            let result;
            try {
                result = await watchlistManager.addItem({
                    sql,
                    userId: uid,
                    externalIds,
                    mediaType,
                    title,
                    user: locals.user,
                });
            } catch (err) {
                if (err instanceof MediaAccessDeniedError) {
                    return ApiProblem.notFound('Media not found or not accessible');
                }
                throw err;
            }

            if (!result.mediaId) {
                // See watchlist-manager.service.ts's `mediaTypeRejected` doc:
                // distinguishes "resolved to a real, disallowed-type row"
                // from "the external IDs didn't resolve at all" — same status
                // and shape, only the message names the actual cause.
                return ApiProblem.validationFailed(
                    result.mediaTypeRejected
                        ? 'This media type is not allowed on the watchlist'
                        : 'No valid external IDs provided',
                );
            }

            return json({
                message: result.saved ? 'Movie saved' : 'Movie already saved',
                saved: result.saved ?? false,
                externalIds: { ...externalIds, internal: result.mediaId },
            });
        },

        DELETE: async (event, ctx) => {
            const { locals, request } = event;

            const { externalIds, mediaType } = ctx.input!.body;

            const { getEffectiveUser } = await import('$lib/server/dev-user.js');
            const authenticatedUser = locals.user?.username;
            const effectiveUsername = getEffectiveUser(request, authenticatedUser);

            const { getDb } = await import('$lib/server/database/connection.js');
            const sql = getDb();
            if (!sql) {
                return ApiProblem.dependencyUnavailable('Database not available');
            }

            // getEffectiveUser returns a USERNAME — resolve to users.id UUID.
            const { getUserIdByUsername } =
                await import('$lib/server/database/queries/users.queries.js');
            const uid = await getUserIdByUsername(sql, effectiveUsername);
            if (!uid) {
                return ApiProblem.unauthorized('Authentication required');
            }

            const { watchlistManager } =
                await import('$lib/server/services/watchlist-manager.service.js');

            const result = await watchlistManager.removeItem({
                sql,
                userId: uid,
                externalIds,
                mediaType,
            });

            if (!result.mediaId) {
                return ApiProblem.validationFailed('No valid external IDs provided');
            }

            return json({
                message: result.removed ? 'Movie unsaved' : 'Movie was not saved',
                removed: result.removed ?? false,
                externalIds: { ...externalIds, internal: result.mediaId },
            });
        },
    },
});

// Re-export legacy openapi schemas (retained for _openapi.ts compatibility).
export { saveMovieBodySchema, unsaveMovieBodySchema };
