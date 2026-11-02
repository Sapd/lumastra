// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * defs/music/genres.ts — `GET /api/music/genres` (internal surface only).
 *
 * Returns all distinct genres in the music library with track/album counts.
 * Optional `?q=` parameter for filtering genres by substring (applied
 * in-memory so the full genre list can be cached per access-scope).
 *
 * Response shape: bare object `{ genres: MusicGenreItem[] }`.
 * Errors → problem+json. DB-down → 503 dependency_unavailable.
 */

import { json } from '@sveltejs/kit';
import { z } from 'zod';
import { defineEndpoint } from '$lib/server/api/define.js';
import { ApiProblem } from '$lib/server/api/problem.js';
import { aiDbService } from '$lib/server/services/database.service.js';
import {
    getDistinctMusicGenres,
    type MusicGenreRow,
} from '$lib/server/database/queries/music.queries.js';
import {
    buildSearchAccessContext,
    scopedCacheKey,
} from '$lib/server/utils/search-access-context.js';
import { cacheManager, CACHE_NAMESPACES } from '$lib/server/cache/index.js';
import { getOrComputeSingleFlight } from '$lib/server/cache/single-flight.js';
import { MusicGenresResponseSchema } from '$lib/schemas/api-music-responses.js';

const genresQuerySchema = z.object({
    q: z.string().max(200).optional(),
});

export const def = defineEndpoint({
    auth: { kind: 'user' },
    visibility: 'internal',

    // OpenAPI docs for the /api/v1/music/genres (public/native) surface. Migrated
    // verbatim from the retired src/routes/api/v1/music/genres/_openapi.ts.
    // `auth: 'bearer'` + `stability: 'stable'` carried over → byte-identical
    // published security scheme and stability tier.
    docs: {
        GET: {
            tags: ['Music'],
            summary: 'Get music genres',
            stability: 'stable',
            auth: 'bearer',
            query: z.object({
                q: z.string().max(200).optional().meta({
                    description: 'Filter genres by substring (case-insensitive)',
                }),
            }),
            responses: {
                200: {
                    schema: MusicGenresResponseSchema,
                    description: 'List of music genres with track and album counts',
                },
                401: 'Authentication required',
                500: 'Internal server error',
            },
        },
    },

    request: {
        query: genresQuerySchema,
    },

    handlers: {
        GET: async (event, _ctx) => {
            const user = event.locals.user;
            if (!user) return ApiProblem.unauthorized();

            const sql = await aiDbService.getSql();
            if (!sql) return ApiProblem.dependencyUnavailable('Database is not available');

            const accessCtx = await buildSearchAccessContext(sql, user);

            // Same full-track JSONB scan (~700ms-1.9s) as the /music page load;
            // share its access-scoped cache entry so the two surfaces don't each
            // pay the scan. The `?q=` filter is applied in-memory below, so the
            // cached value is the unfiltered list.
            const genresCache = cacheManager.for(CACHE_NAMESPACES.musicLibraryGenres);
            const genresKey = scopedCacheKey('music-library-genres', accessCtx);
            let allGenres = await genresCache.get<MusicGenreRow[]>(genresKey);
            if (!allGenres) {
                // Single-flight the scan so a burst of concurrent cold-cache
                // misses — this endpoint shares its key with the /music SSR load,
                // so both surfaces collapse onto one compute — runs the
                // full-track JSONB scan ONCE instead of stampeding the DB.
                // The cached value is the unfiltered list (the `?q=` filter is
                // applied in-memory below), so caching stays transparent. Raw
                // Valkey key mirrors UnifiedCache.buildL2Key(genresKey) for this
                // non-user-scoped namespace: `${ns.name}:${genresKey}`.
                const ns = CACHE_NAMESPACES.musicLibraryGenres;
                const rawKey = `${ns.name}:${genresKey}`;
                const ttlSeconds = Math.floor(ns.l2TTL / 1000);
                const jsonStr = await getOrComputeSingleFlight({
                    cacheKey: rawKey,
                    ttlSeconds,
                    compute: async () =>
                        JSON.stringify(
                            await getDistinctMusicGenres(sql, {
                                deniedGroupIds: accessCtx.deniedGroupIds,
                                ageRating: accessCtx.ageRating,
                            }),
                        ),
                });
                allGenres = JSON.parse(jsonStr) as MusicGenreRow[];
                // Populate L1 so subsequent in-process reads skip Valkey.
                void genresCache.set(genresKey, allGenres);
            }

            const query = event.url.searchParams.get('q')?.trim().toLowerCase();
            const genres = query
                ? allGenres.filter((g) => g.genre.toLowerCase().includes(query))
                : allGenres;

            return json({
                genres: genres.map((row) => ({
                    genre: row.genre,
                    trackCount: row.track_count,
                    albumCount: row.album_count,
                })),
            });
        },
    },
});
