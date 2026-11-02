// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * defs/people/search.ts — GET /api/person/search
 *
 * Search TMDB for a person by name.
 *
 * Contract: bare object — { personId, name, profilePath }.
 * TMDB down → 503 dependency_unavailable.
 * No result → 404 not_found.
 *
 * Auth: user (rate-limited via withSearchRateLimit on the route).
 */

import { ImageSetSchema } from '$lib/schemas/api-image-descriptor.js';
import { personImageSet } from '$lib/server/services/image-descriptor/resources.js';
import { z } from 'zod';
import { json } from '@sveltejs/kit';
import { defineEndpoint } from '$lib/server/api/define.js';
import { ApiProblem } from '$lib/server/api/problem.js';
import { Logger } from '$lib/server/utils/logger.js';
import { config } from '$lib/server/config.js';
import { tmdbAuthorizedRequest } from '$lib/server/providers/implementations/tmdb/auth.js';
import { cacheManager, CACHE_NAMESPACES } from '$lib/server/cache/index.js';
import { fetchWithTimeout } from '$lib/server/utils/fetch-utils.js';
import { trackExternalCall } from '$lib/server/utils/external-request-counter.js';

const logger = Logger.for('PersonSearchDef');

/**
 * Read LIVE on every call — never captured into a module constant.
 *
 * `config.TMDB_API_KEY` is a getter resolving settings.json -> env -> default at
 * call time. A module-scope `const` froze it at process boot, so person search
 * stayed permanently dead for any operator who entered their key in the admin
 * UI after startup, with no error beyond an empty result.
 */
const tmdbApiKey = (): string => config.TMDB_API_KEY;

const personSearchCache = cacheManager.for(CACHE_NAMESPACES.personDetails);

interface TmdbPersonResult {
    id: number;
    name: string;
    profile_path?: string | null;
}

interface TmdbPersonSearchResponse {
    results?: TmdbPersonResult[];
}

const PersonSearchResultSchema = z.object({
    personId: z.number().describe('TMDB person ID'),
    name: z.string().describe('Person name'),
    images: ImageSetSchema,
});

// ---------------------------------------------------------------------------
// def
// ---------------------------------------------------------------------------

export const def = defineEndpoint({
    auth: { kind: 'user' },
    visibility: 'internal',
    request: {
        query: z.object({
            name: z.string().min(1).describe('Person name to search'),
        }),
    },
    handlers: {
        GET: async (event, ctx) => {
            const { url } = event;

            const name = url.searchParams.get('name') ?? '';
            if (!name.trim()) {
                return ApiProblem.validationFailed([
                    { field: 'name', message: 'name parameter is required', value: name },
                ]);
            }

            if (!tmdbApiKey()) {
                return ApiProblem.dependencyUnavailable('TMDB API key not configured');
            }

            const normalizedName = name.toLowerCase().trim();
            const cacheKey = `${ctx.surface}:images:search:${normalizedName}`;

            const cached =
                await personSearchCache.get<z.infer<typeof PersonSearchResultSchema>>(cacheKey);
            if (cached) {
                return json(PersonSearchResultSchema.parse(cached));
            }

            let data: TmdbPersonSearchResponse;
            try {
                const searchUrl = `https://api.themoviedb.org/3/search/person?query=${encodeURIComponent(name)}&language=en-US&page=1`;
                const request = tmdbAuthorizedRequest(searchUrl, tmdbApiKey(), {
                    'Content-Type': 'application/json',
                });
                // C22 fix-plan finding scope: fixed, non-admin-configurable
                // public host (api.themoviedb.org) — see
                // docs/dev/eslint-exceptions.md.
                const response = await trackExternalCall(request.url, () =>
                    fetchWithTimeout(request.url, { headers: request.headers }),
                );

                if (!response.ok) {
                    if (response.status === 429) {
                        return ApiProblem.rateLimited(60);
                    }
                    if (response.status >= 500) {
                        return ApiProblem.dependencyUnavailable('TMDB returned an error');
                    }
                    return ApiProblem.badGateway(`TMDB search failed: HTTP ${response.status}`);
                }

                data = (await response.json()) as TmdbPersonSearchResponse;
            } catch (error) {
                logger.error('Person search failed', error as Error, { name });
                return ApiProblem.dependencyUnavailable('TMDB request failed');
            }

            const results = Array.isArray(data.results) ? data.results : [];

            if (results.length === 0) {
                return ApiProblem.notFound('Person not found');
            }

            const exactMatch = results.find((p) => p.name.toLowerCase().trim() === normalizedName);
            const bestMatch = exactMatch ?? results[0];

            const result = {
                personId: bestMatch.id,
                name: bestMatch.name,
                images: personImageSet(ctx.surface, bestMatch.id, bestMatch.profile_path),
            };

            await personSearchCache.set(cacheKey, result);

            logger.info('Person search', {
                searchName: name,
                foundName: result.name,
                personId: result.personId,
            });

            return json(PersonSearchResultSchema.parse(result));
        },
    },
});
