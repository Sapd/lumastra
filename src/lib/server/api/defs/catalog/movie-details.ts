// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * defs/catalog/movie-details.ts — `movie-details/{id}`.
 *
 * Contract (bare object — single resource):
 *   GET /movie-details/{id} → {
 *     id, type, ids, title, overview?, year?, releaseDate?,
 *     runtimeMinutes?, genres, images, isAvailable, canRequest,
 *     playbackAvailable, user?: { rating?, isInWatchlist }
 *   }
 *
 * This is the SPA "detail sidebar" view. It always reads from the local DB
 * (Jellyfin is no longer in the happy path for metadata).
 *
 * Auth: user. Surface: internal.
 */

import { ImageSetSchema, InheritQuerySchema } from '$lib/schemas/api-image-descriptor.js';
import { z } from 'zod';
import { defineEndpoint } from '$lib/server/api/define.js';
import { ApiProblem } from '$lib/server/api/problem.js';
import { json } from '@sveltejs/kit';
import { getDb } from '$lib/server/database/connection.js';
import { config } from '$lib/server/config.js';
import { getPlaybackPreferences } from '$lib/server/database/queries/user-preferences.queries.js';
import { toDetailMediaType } from '$lib/shared/media-type-domain';
import { checkMediaAccess } from '$lib/server/middleware/media-access.js';
import { GenreService } from '$lib/server/services/genre.service.js';
import { resolveImageSet } from '$lib/server/services/image-descriptor/index.js';

import { Logger } from '$lib/server/utils/logger.js';
import { resolveMetadataLanguage } from '$lib/server/utils/metadata-language-resolve.js';
import { applyTranslationOverlay } from '$lib/server/utils/translation-overlay.js';
import { triggerMetadataTranslationLazyFill } from '$lib/server/utils/metadata-translation-lazy-fill.js';
import { watchlistExistsFragment } from '$lib/server/database/queries/builders/watchlist-exists.builder.js';

const logger = Logger.for('MovieDetailsDef');

// ---------------------------------------------------------------------------
// Schemas
// ---------------------------------------------------------------------------

export const MovieDetailsResponseSchema = z.object({
    id: z.string(),
    // Three arms, not two: this endpoint resolves ANY catalog id, including an
    // AudiobookShelf book. Clamping a book to 'movie' here is what made the
    // Continue-Watching audiobook card open a "Watch Movie" modal.
    // Mirror: MovieDetailsResponseSchema in $lib/schemas/api-content-responses.
    type: z.enum(['movie', 'series', 'audiobook']),
    ids: z.record(z.string(), z.string()),
    title: z.string(),
    overview: z.string().optional(),
    year: z.number().int().optional(),
    releaseDate: z.string().optional(),
    runtimeMinutes: z.number().int().optional(),
    genres: z.array(z.string()),
    images: ImageSetSchema,
    isAvailable: z.boolean(),
    canRequest: z.boolean(),
    playbackAvailable: z.boolean(),
    user: z
        .object({
            rating: z.number().int().optional(),
            isInWatchlist: z.boolean(),
        })
        .optional(),
});

export type MovieDetailsResponse = z.infer<typeof MovieDetailsResponseSchema>;

// ---------------------------------------------------------------------------
// def
// ---------------------------------------------------------------------------

export const def = defineEndpoint({
    auth: { kind: 'user' },
    visibility: 'internal',

    docs: {
        GET: {
            tags: ['Catalog'],
            summary: 'Get movie details',
            query: InheritQuerySchema,
            responses: {
                200: { schema: MovieDetailsResponseSchema, description: 'Get movie details' },
            },
        },
    },

    request: { query: InheritQuerySchema },

    handlers: {
        GET: async (event, ctx) => {
            const { id } = event.params;
            if (!id) {
                return ApiProblem.validationFailed([
                    { field: 'params.id', message: 'id is required' },
                ]);
            }

            const sql = getDb();
            if (!sql) return ApiProblem.dependencyUnavailable('Database is not available');

            // Resolve id to internal UUID using the same logic as other catalog endpoints
            const { resolveCatalogInternalId } = await import('./resolve-id.js');
            const internalId = await resolveCatalogInternalId(event);
            if (!internalId) return ApiProblem.notFound('Item not found');

            // Library + age gate
            if (!(await checkMediaAccess(sql, internalId, event.locals.user))) {
                return ApiProblem.notFound('Item not found');
            }

            type MediaRow = {
                id: string;
                title: string;
                media_type: string;
                overview: string | null;
                premiere_date: string | null;
                runtime_seconds: number | null;
                metadata: Record<string, unknown> | null;
                has_file: boolean;
            };

            const rows = await sql<MediaRow[]>`
                SELECT
                    mi.id,
                    mi.title,
                    mi.media_type,
                    mi.overview,
                    mi.premiere_date,
                    mi.runtime_seconds,
                    pm.metadata,
                    (mi.file_path IS NOT NULL) as has_file
                FROM media_items mi
                LEFT JOIN LATERAL (
                    SELECT metadata FROM provider_metadata
                    WHERE media_id = mi.id
                    ORDER BY CASE WHEN provider = mi.preferred_provider THEN 0 ELSE 1 END
                    LIMIT 1
                ) pm ON true
                WHERE mi.id = ${internalId}::uuid
                  AND mi.status = 'active'
                LIMIT 1
            `;

            const row = rows[0];
            if (!row) return ApiProblem.notFound('Item not found');

            // Build external IDs
            const extIdRows = await sql<{ provider: string; external_id: string }[]>`
                SELECT provider, external_id
                FROM external_ids
                WHERE media_id = ${internalId}::uuid
                ORDER BY provider
            `;
            const ids: Record<string, string> = { internal: internalId };
            for (const e of extIdRows) ids[e.provider] = e.external_id;

            const metadata = row.metadata ?? {};
            // RAW row.media_type — `toDetailMediaType` must never be handed an
            // already-normalized value, or its audiobook arm is unreachable.
            const publicType = toDetailMediaType(row.media_type);
            // This endpoint resolves ANY catalog id; a row that is none of
            // movie/series/audiobook (an episode, a season, a music track, …)
            // has no detail surface here — treat it as not found rather than
            // mislabelling it.
            if (!publicType) return ApiProblem.notFound('Item not found');
            const year = row.premiere_date ? new Date(row.premiere_date).getFullYear() : undefined;

            const genres = GenreService.getGenreNames(
                GenreService.normalizeGenres(
                    Array.isArray(metadata.genres) ? (metadata.genres as number[]) : [],
                    publicType === 'series' ? 'tv' : 'movie',
                ),
            );

            // Enrich with user-specific data
            const userId = event.locals.user?.userId;
            let userObj: MovieDetailsResponse['user'];
            if (userId) {
                try {
                    const userRows = await sql<
                        { user_rating: number | null; in_watchlist: boolean }[]
                    >`
                        SELECT
                            ur.rating as user_rating,
                            ${watchlistExistsFragment(sql, sql`${internalId}::uuid`, sql`${userId}::uuid`)} as in_watchlist
                        FROM (SELECT 1) as dummy
                        LEFT JOIN user_ratings ur ON ur.user_id = ${userId}::uuid AND ur.media_id = ${internalId}::uuid
                        LIMIT 1
                    `;
                    if (userRows.length > 0) {
                        userObj = {
                            rating: userRows[0].user_rating ?? undefined,
                            isInWatchlist: userRows[0].in_watchlist === true,
                        };
                    }
                } catch (e) {
                    logger.debug('Failed to fetch user data for movie details', {
                        internalId,
                        error: e,
                    });
                }
            }

            const surface = ctx.surface;

            const base: MovieDetailsResponse = {
                id: internalId,
                type: publicType,
                ids,
                title: row.title,
                overview: row.overview ?? undefined,
                year,
                releaseDate: row.premiere_date ?? undefined,
                runtimeMinutes: row.runtime_seconds
                    ? Math.round(row.runtime_seconds / 60)
                    : undefined,
                genres,
                images: await resolveImageSet(
                    sql,
                    surface,
                    internalId,
                    undefined,
                    ctx.input?.query?.inherit === 'none' ? { inherit: 'none' } : undefined,
                ),
                isAvailable: row.has_file,
                canRequest: !row.has_file,
                playbackAvailable: row.has_file,
                user: userObj,
            };

            // Per-user metadata-language overlay (multilingual-media-metadata
            // spec §5), resolved ONCE per request; `base` is a freshly-built
            // object (no cache in this handler) so it's mutated in place, same
            // as catalog/media-id.ts's `base` overlay.
            if (userId && config.METADATA_ADDITIONAL_LANGUAGES.length > 0) {
                const langs = resolveMetadataLanguage(
                    await getPlaybackPreferences.one(sql, { userId }),
                );
                if (langs.titleLang || langs.textLang) {
                    await applyTranslationOverlay(sql, [base], langs, {
                        id: (it) => it.id,
                        setTitle: (it, v) => {
                            it.title = v;
                        },
                        setOverview: (it, v) => {
                            it.overview = v;
                        },
                    });
                }
                // Lazy-fill (multilingual-metadata spec §4.3) — see
                // metadata-translation-lazy-fill.ts. This is the only
                // movie/series read path that previously had no self-heal:
                // ModalMovie's `media-id.ts` already enqueues on view, but a
                // movie opened only via the in-player sidebar never did.
                triggerMetadataTranslationLazyFill(sql, internalId, publicType, userId, langs, {
                    sourceRoute: 'movie-detail-sidebar',
                });
            }

            return json(base satisfies MovieDetailsResponse);
        },
    },
});
