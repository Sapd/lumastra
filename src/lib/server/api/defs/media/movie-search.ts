// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * defs/media/movie-search.ts — GET /api/movie/search
 *
 * Search for a movie by name in the local database.
 *
 * Contract: bare object — MediaDetails (best match).
 * DB down → 503 dependency_unavailable.
 * No match → 404 not_found.
 *
 * Auth: public (access filtered via library access context).
 */

import { z } from 'zod';
import { json } from '@sveltejs/kit';
import { defineEndpoint } from '$lib/server/api/define.js';
import { ApiProblem } from '$lib/server/api/problem.js';
import { Logger } from '$lib/server/utils/logger.js';
import { config } from '$lib/server/config.js';
import { getDb } from '$lib/server/database/connection.js';
import { searchMedia } from '$lib/server/database/queries/search.queries.js';
import { searchAccessBoundary } from '$lib/server/utils/search-access-context.js';
import { getPlaybackPreferences } from '$lib/server/database/queries/user-preferences.queries.js';
import { buildSearchAccessContext } from '$lib/server/utils/search-access-context.js';
import { buildImageRefs } from '$lib/shared/api-urls.js';
import { MovieSearchContractSchema } from '$lib/schemas/api-content-responses.js';
import { resolveMetadataLanguage } from '$lib/server/utils/metadata-language-resolve.js';
import { applyTranslationOverlay } from '$lib/server/utils/translation-overlay.js';

const logger = Logger.for('MovieSearchDef');

// ---------------------------------------------------------------------------
// def
// ---------------------------------------------------------------------------

export const def = defineEndpoint({
    auth: { kind: 'public' },
    visibility: 'internal',
    request: {
        query: z.object({
            name: z.string().min(1).describe('Movie title to search'),
            year: z.coerce
                .number()
                .int()
                .min(1900)
                .max(2100)
                .optional()
                .describe('Release year filter'),
        }),
    },
    handlers: {
        GET: async (event, ctx) => {
            const { url, locals } = event;

            const name = url.searchParams.get('name') ?? '';
            if (!name.trim()) {
                return ApiProblem.validationFailed([
                    { field: 'name', message: 'name parameter is required', value: name },
                ]);
            }

            const yearRaw = url.searchParams.get('year');
            const year = yearRaw ? parseInt(yearRaw, 10) : undefined;

            const sql = getDb();
            if (!sql) {
                return ApiProblem.dependencyUnavailable('Database unavailable');
            }

            const accessCtx = await buildSearchAccessContext(sql, locals.user);

            const results = await searchMedia(sql, name, searchAccessBoundary(accessCtx), {
                limit: 10,
                mediaTypes: ['movie'],
                availableOnly: false,
            });

            if (results.length === 0) {
                logger.info('Movie not found in database', { searchName: name, year });
                return ApiProblem.notFound('Movie not found');
            }

            const searchName = name.toLowerCase().trim();

            const matchesSearchName = (r: (typeof results)[number]): boolean =>
                [r.title, r.english_title, r.original_title]
                    .filter((t): t is string => typeof t === 'string')
                    .some((t) => t.toLowerCase().trim() === searchName);

            let matched = year
                ? results.find((r) => {
                      if (!matchesSearchName(r)) return false;
                      const releaseYear = r.release_date
                          ? new Date(r.release_date).getFullYear()
                          : undefined;
                      return releaseYear === year;
                  })
                : undefined;

            if (!matched) {
                matched = results.find(matchesSearchName);
            }

            if (!matched) {
                logger.info('Movie not found in database', {
                    searchName: name,
                    year,
                    resultsCount: results.length,
                });
                return ApiProblem.notFound('Movie not found');
            }

            // Per-user metadata-language overlay (multilingual-media-metadata
            // spec §5), resolved ONCE per request; `matched` is a freshly-built
            // object from `searchMedia` (no cache in this handler) so it's
            // mutated in place. `public` auth means anonymous callers simply
            // skip (no `locals.user`), degrading to a no-op.
            const userId = locals.user?.userId;
            if (userId && config.METADATA_ADDITIONAL_LANGUAGES.length > 0) {
                const langs = resolveMetadataLanguage(
                    await getPlaybackPreferences.one(sql, { userId }),
                );
                if (langs.titleLang || langs.textLang) {
                    await applyTranslationOverlay(sql, [matched], langs, {
                        id: (it) => it.internal_id ?? null,
                        setTitle: (it, v) => {
                            it.title = v;
                        },
                        setOverview: (it, v) => {
                            it.overview = v;
                        },
                    });
                }
            }

            const internalId = matched.internal_id ?? undefined;
            // Availability is the row's own `has_files` (searchMedia's
            // `is_available`), never "has a Jellyfin id": a standalone install
            // has no Jellyfin ids at all.
            const isAvailable = matched.is_available === true;
            const releaseYear = matched.release_date
                ? new Date(matched.release_date).getFullYear()
                : undefined;

            const ids: Record<string, string> = {
                tmdb: String(matched.tmdb_id),
                ...(internalId ? { internal: internalId } : {}),
            };

            const canonicalId = internalId ?? String(matched.tmdb_id);

            // Build self-describing images{} map via the same helper used by
            // other catalog endpoints. Falls back to null when no internal UUID.
            const images = internalId ? buildImageRefs(internalId, ctx.surface) : undefined;

            const data = {
                id: canonicalId,
                type: 'movie' as const,
                ids,
                title: matched.title,
                overview: matched.overview ?? undefined,
                year: releaseYear,
                genres: Array.isArray(matched.genres) ? matched.genres.map(String) : [],
                images,
                isAvailable,
                canRequest: !isAvailable,
                playbackAvailable: isAvailable,
            };

            logger.info('Found movie in database', {
                searchName,
                year,
                foundName: matched.title,
                foundYear: releaseYear,
            });

            return json(MovieSearchContractSchema.parse(data));
        },
    },
});
