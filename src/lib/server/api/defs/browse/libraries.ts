// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * defs/browse/libraries.ts — GET /api/browse/libraries
 *
 * Returns available library groups with item counts, filtered by user access.
 *
 * Contract:
 *   GET /browse/libraries
 *     → bare LibrariesResponse object  { libraries, totalLibraries }
 *
 * Auth: user.  Surface: internal.
 * 503 dependency_unavailable when DB is down.
 */

import { libraryImageSet } from '$lib/server/services/image-descriptor/resources.js';
import { getLibraryBackdropHash } from '$lib/server/services/library-backdrop.service.js';
import { json } from '@sveltejs/kit';
import { defineEndpoint } from '$lib/server/api/define.js';
import { ApiProblem } from '$lib/server/api/problem.js';
import { getDb } from '$lib/server/database/connection.js';
import { getAvailableLibraries } from '$lib/server/database/queries/browse.queries.js';
import { LibrariesResponseSchema } from '$lib/schemas/api-browse-responses.js';
import { cacheManager, CACHE_NAMESPACES } from '$lib/server/cache/index.js';
import {
    buildSearchAccessContext,
    browseScopedCacheKey,
    searchAccessBoundary,
} from '$lib/server/utils/search-access-context.js';
import { Logger } from '$lib/server/utils/logger.js';

const logger = Logger.for('Browse:Libraries');

interface LibrariesCacheData {
    libraries: Array<{
        id: string;
        name: string;
        itemCount: number;
        mediaType: 'movie' | 'tv' | 'mixed';
        icon?: string;
        description?: string;
    }>;
    totalLibraries: number;
}

const librariesCache = cacheManager.for(CACHE_NAMESPACES.browseLibraries);

/**
 * Map the internal storage token 'tv' to the canonical public value 'series'
 * at the response boundary. `getAvailableLibraries` and the libraries cache
 * both carry the raw storage token — this must run on every response path
 * (cache hit AND miss) so wire responses never leak 'tv'.
 */
function toPublicLibraries(libraries: LibrariesCacheData['libraries']): Array<
    Omit<LibrariesCacheData['libraries'][number], 'mediaType'> & {
        mediaType: 'movie' | 'series' | 'mixed';
    }
> {
    return libraries.map((lib) => ({
        ...lib,
        mediaType: lib.mediaType === 'tv' ? 'series' : lib.mediaType,
    }));
}

export const def = defineEndpoint({
    auth: { kind: 'user' },
    visibility: 'internal',
    // OpenAPI metadata for the public/native surface.
    docs: {
        GET: {
            stability: 'stable',
            tags: ['Browse'],
            summary: 'List available media libraries',
            responses: {
                200: {
                    schema: LibrariesResponseSchema,
                    description: 'Library list',
                },
                401: 'Authentication required',
                500: 'Internal server error',
            },
        },
    },
    handlers: {
        GET: async (event, ctx) => {
            const sql = getDb();
            if (!sql) {
                return ApiProblem.dependencyUnavailable('Database not available');
            }

            const accessCtx = await buildSearchAccessContext(sql, event.locals.user);

            // Cache key: denied-groups + age only (no Live TV, no locale).
            const cacheKey = browseScopedCacheKey('v6:groups', accessCtx);

            try {
                const cached = await librariesCache.get<LibrariesCacheData>(cacheKey);
                if (cached) {
                    return json({
                        libraries: await Promise.all(
                            toPublicLibraries(cached.libraries).map(async (lib) => ({
                                ...lib,
                                images: libraryImageSet(
                                    ctx.surface,
                                    lib.id,
                                    await getLibraryBackdropHash(sql, lib.id),
                                ),
                            })),
                        ),
                        totalLibraries: cached.totalLibraries,
                    });
                }

                const libraries = await getAvailableLibraries(sql, searchAccessBoundary(accessCtx));

                const result: LibrariesCacheData = {
                    libraries,
                    totalLibraries: libraries.length,
                };

                try {
                    await librariesCache.set(cacheKey, result);
                } catch {
                    /* non-fatal */
                }

                return json({
                    libraries: await Promise.all(
                        toPublicLibraries(result.libraries).map(async (lib) => ({
                            ...lib,
                            images: libraryImageSet(
                                ctx.surface,
                                lib.id,
                                await getLibraryBackdropHash(sql, lib.id),
                            ),
                        })),
                    ),
                    totalLibraries: result.totalLibraries,
                });
            } catch (error) {
                logger.error('Failed to fetch libraries', error as Error);
                return ApiProblem.internalError('Failed to fetch libraries');
            }
        },
    },
});
