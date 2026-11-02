// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * defs/requests/redirect.ts — GET /requests/redirect?id=<composite|provider:id>&mediaType=movie|series
 *
 * Resolves a provider-agnostic media ID to a Jellyseerr TMDB-based deep-link
 * and issues a 302 redirect.  This is a Class R endpoint (non-JSON success
 * response).  Pre-flight errors (bad params, dependency down) still emit
 * problem+json.
 *
 * Auth: none (public — Jellyseerr's own page gate handles access there).
 * Visibility: internal (SPA dashboard shortcut; no automation value).
 *
 * Query params:
 *   id         — composite key "provider:id:mediaType" OR "provider:id"
 *   mediaType  — required when id is "provider:id" (two-part) form
 *
 * Examples:
 *   /api/request/redirect?id=tmdb:550:movie
 *   /api/request/redirect?id=imdb:tt0137523:movie
 *   /api/request/redirect?id=trakt:550&mediaType=movie
 */

import { redirect } from '@sveltejs/kit';
import { z } from 'zod';
import { defineEndpoint } from '$lib/server/api/define.js';
import { ApiProblem } from '$lib/server/api/problem.js';
import { env } from '$env/dynamic/public';
import { providerResolutionService } from '$lib/server/services/provider-resolution.service.js';
import { parseMediaId } from '$lib/server/utils/media-key-parser.js';
import { isMovie, isSeries } from '$lib/server/utils/media-types.js';
import type { ExternalIds } from '$lib/types/api-common.js';

// ---------------------------------------------------------------------------
// Request contract
// ---------------------------------------------------------------------------

const RedirectQuerySchema = z
    .object({
        id: z.string().min(1),
        mediaType: z.enum(['movie', 'series']).optional(),
    })
    .refine(
        (data) => {
            // Composite key (provider:id:mediaType) — mediaType not required
            const parts = data.id.split(':');
            if (parts.length === 3) return true;
            // Simple form (provider:id) — mediaType is required
            return !!data.mediaType;
        },
        {
            message: 'mediaType is required when using simple id format (provider:id)',
            path: ['mediaType'],
        },
    );

// ---------------------------------------------------------------------------
// Endpoint definition
// ---------------------------------------------------------------------------

export const def = defineEndpoint({
    auth: { kind: 'public' },
    visibility: 'internal',
    raw: true, // Class R — success response is a 302 redirect, not JSON
    request: {
        query: RedirectQuerySchema,
    },
    handlers: {
        GET: async (_event, ctx) => {
            const requestUrl = env.PUBLIC_REQUESTURL;
            if (!requestUrl) {
                return ApiProblem.dependencyUnavailable('Jellyseerr is not configured');
            }

            const { id, mediaType: queryMediaType } = ctx.input!.query as z.infer<
                typeof RedirectQuerySchema
            >;

            const parsed = parseMediaId(id);
            let mediaType: 'movie' | 'tv' | null;
            let externalIds: ExternalIds;

            if (parsed.type === 'composite') {
                // Composite key: provider:id:mediaType
                mediaType = isMovie(parsed.mediaType)
                    ? 'movie'
                    : isSeries(parsed.mediaType)
                      ? 'tv'
                      : null;

                if (!mediaType) {
                    return ApiProblem.validationFailed('Invalid media type in composite key');
                }
                if (!parsed.provider || !parsed.externalId) {
                    return ApiProblem.validationFailed('Invalid composite key format');
                }
                externalIds = { [parsed.provider]: parsed.externalId };
            } else {
                // Fallback: "provider:id" + mediaType query param
                if (!isMovie(queryMediaType) && !isSeries(queryMediaType)) {
                    return ApiProblem.validationFailed(
                        'mediaType must be "movie", "series", or "tv"',
                    );
                }
                mediaType = isMovie(queryMediaType) ? 'movie' : 'tv';

                const parts = id.split(':');
                if (parts.length === 2) {
                    externalIds = { [parts[0]]: parts[1] };
                } else {
                    return ApiProblem.validationFailed(
                        'Invalid ID format — use composite key (provider:id:mediaType) or provider:id with mediaType param',
                    );
                }
            }

            const resolution = await providerResolutionService.resolveToTmdb(
                externalIds,
                mediaType,
            );
            if (!resolution.success) {
                return ApiProblem.validationFailed(
                    `Cannot resolve to TMDB ID for Jellyseerr: ${resolution.error}`,
                );
            }

            throw redirect(302, `${requestUrl}/${mediaType}/${resolution.tmdbId}`);
        },
    },
});
