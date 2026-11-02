// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

// gen-api-routes: skip — authored ahead of route migration; the live route is a
// bespoke/legacy handler at a non-convention path (not generator-mounted). See
// scripts/gen-api-routes.ts (hasSkipDirective).

/**
 * defs/catalog/series-id.ts — series/{id} traversal spine.
 *
 * `GET /series/{id}` returns the SAME base node as `media/{id}` for a series
 * id but ADDS the children (seasons.href, episodes.href, next-episode.href,
 * watch-status.href) so clients can traverse without knowing any id scheme.
 *
 * Auth: user.
 */

import { InheritQuerySchema } from '$lib/schemas/api-image-descriptor.js';
import { resolveImageSet } from '$lib/server/services/image-descriptor/index.js';
import { z } from 'zod';
import { defineEndpoint } from '$lib/server/api/define.js';
import { ApiProblem } from '$lib/server/api/problem.js';
import { json } from '@sveltejs/kit';
import { getDb } from '$lib/server/database/connection.js';
import { checkMediaAccess } from '$lib/server/middleware/media-access.js';
import {
    getMediaDetailsById,
    getExternalIdsByMediaId,
    buildExternalIdsObject,
} from '$lib/server/database/queries/media-lookup.queries.js';
import { getMediaDetailByUuid } from '$lib/server/database/queries/media-details.queries.js';
import { getMediaStreamSummary } from '$lib/server/database/queries/media-stream-summary.queries.js';
import { mediaIdResolver } from '$lib/server/services/media-id-resolver.js';
import { Logger } from '$lib/server/utils/logger.js';
import {
    toDbMediaRow,
    transformToMediaDetail,
    toNodeDetailsExtra,
} from '$lib/server/utils/api-transforms.js';
import { config } from '$lib/server/config.js';
import { getPlaybackPreferences } from '$lib/server/database/queries/user-preferences.queries.js';
import { resolveMetadataLanguage } from '$lib/server/utils/metadata-language-resolve.js';
import { applyTranslationOverlay } from '$lib/server/utils/translation-overlay.js';
import { SeriesNodeSchema } from '$lib/schemas/api-series-responses.js';
import type { UserId } from '$lib/shared/user-id.js';
import { apiUrl, type ApiSurface } from '$lib/shared/api-urls.js';
import { watchlistExistsFragment } from '$lib/server/database/queries/builders/watchlist-exists.builder.js';

// ---------------------------------------------------------------------------
// Request query contract
// ---------------------------------------------------------------------------

/**
 * Query params accepted by GET /series/{id}.
 *
 * Mirrors the media/{id} query contract — same expansions, path handle identity
 * alias. Unknown params are stripped (not rejected).
 */
const SeriesIdQuery = z
    .object({
        /**
         * CSV of optional expansions.
         * Recognised values: `user`, `playback`, `details`.
         * `details` adds rich fields (cast/genres/ratings/trailer).
         */
        include: z.string().optional(),
        /**
         * Composite external ID form: `provider:id:type`.
         */
    })
    .merge(InheritQuerySchema);

/**
 * Docs-only query schema — mirrors SeriesIdQuery structurally but carries the
 * human-readable descriptions the retired
 * src/routes/api/v1/series/[id]/_openapi.ts published. Kept separate from the
 * runtime SeriesIdQuery so mergeDescriptions recovers the exact prior text
 * (byte-identical to the pre-migration spec).
 */
const SeriesIdDocsQuery = z
    .object({
        include: z
            .string()
            .optional()
            .meta({
                description:
                    'CSV of optional expansions: `user`, `playback`, `details`. `details` adds rich ' +
                    'fields (cast/genres/ratings/trailer).',
            }),
    })
    .merge(InheritQuerySchema);

const logger = Logger.for('CatalogSeriesIdDef');

/**
 * Build traversal links for a series node.
 * Every link is an href; clients follow the link without knowing the id scheme.
 */
function buildTraversalLinks(seriesId: string, surface: ApiSurface) {
    return {
        seasons: { href: apiUrl(surface, `/series/${seriesId}/seasons`) },
        episodes: { href: apiUrl(surface, `/series/${seriesId}/episodes`) },
        nextEpisode: { href: apiUrl(surface, `/series/${seriesId}/next-episode`) },
        watchStatus: { href: apiUrl(surface, `/series/${seriesId}/watch-status`) },
    };
}

/**
 * Build image refs for a series.
 * `surface` is injected via `ctx` and differs by surface.
 * Each role emits canonical preset variants so clients use cache-friendly URLs.
 */

export const def = defineEndpoint({
    auth: { kind: 'user' },

    // OpenAPI docs for the /api/v1/series/{id} (public/native) surface. Migrated
    // verbatim from the retired src/routes/api/v1/series/[id]/_openapi.ts. The
    // query descriptions live on SeriesIdDocsQuery so the generator recovers the
    // exact prior text (byte-identical to the pre-migration spec).
    docs: {
        GET: {
            tags: ['Series'],
            summary: 'Get a series',
            stability: 'stable',
            auth: 'bearer',
            description:
                'Accepts a UUID or tvdb:N:series, tmdb:N:series, imdb:ttN:series path handle; example /series/tvdb:81189:series. Query parameters do not override identity.',
            query: SeriesIdDocsQuery,
            responses: {
                200: {
                    schema: SeriesNodeSchema,
                    description:
                        'Series traversal node with seasons, episodes, and watch-status links',
                },
                401: 'Authentication required',
                500: 'Internal server error',
            },
        },
    },

    request: {
        query: SeriesIdQuery,
    },

    handlers: {
        GET: async (event, ctx) => {
            const sql = getDb();
            if (!sql) {
                return ApiProblem.dependencyUnavailable('Database is not available');
            }

            // ID resolution — prefer pre-resolved locals.resolvedIds from middleware,
            // fall back to UUID fast-path for direct calls.
            const resolvedIds = event.locals.resolvedIds;
            let internalId: string | null = resolvedIds?.internalId ?? null;

            if (!internalId) {
                // No pre-resolution: resolve inline via the same resolver
                // withIdResolution uses (accepts UUID, dashless UUID, or a
                // composite provider:id:type key from the path).
                const rawId = event.params.id || '';
                if (!rawId) {
                    return ApiProblem.notFound('Series not found');
                }
                try {
                    const resolved = await mediaIdResolver.resolveAnyMediaId(rawId);
                    internalId = resolved.internalId;
                } catch (err) {
                    const message = err instanceof Error ? err.message : 'Unknown error';
                    if (message.includes('Invalid media ID format')) {
                        return ApiProblem.validationFailed([{ field: 'id', message }]);
                    } else if (message.includes('not found')) {
                        return ApiProblem.notFound('Series not found');
                    } else if (message.includes('Database connection not available')) {
                        return ApiProblem.dependencyUnavailable(
                            'Database connection not available',
                        );
                    } else {
                        return ApiProblem.internalError('ID resolution failed');
                    }
                }
            }

            if (!internalId) {
                return ApiProblem.notFound('Series not found');
            }

            // Access gate — library + age
            if (!(await checkMediaAccess(sql, internalId, event.locals.user))) {
                return ApiProblem.notFound('Series not found');
            }

            // Fetch series detail
            const row = await getMediaDetailsById(sql, internalId);
            if (!row) {
                return ApiProblem.notFound('Series not found');
            }

            // Verify this is actually a series (or tv) item
            const dbType = row.media_type?.toLowerCase() ?? '';
            const isSeries = dbType === 'tv' || dbType === 'series';
            if (!isSeries) {
                logger.warn('series/{id} resolved to non-series item', {
                    id: internalId,
                    mediaType: row.media_type,
                });
                return ApiProblem.notFound('Series not found');
            }

            // External IDs (ids{} map)
            const dbExternalIds = await getExternalIdsByMediaId(sql, internalId);
            const builtIds = buildExternalIdsObject(dbExternalIds);
            const ids = Object.fromEntries(
                Object.entries(builtIds).filter(([provider]) => provider !== 'internal'),
            );

            // Metadata from row
            const premiere = (row as { premiere_date?: string | null }).premiere_date ?? undefined;
            const year = premiere ? new Date(premiere).getFullYear() : undefined;

            // ?include= — opt-in per-user fields (same pattern as media/{id})
            const include = event.url.searchParams.get('include') ?? '';
            const includeUser = include.includes('user') || include.includes('playback');
            const includeDetails = include.includes('details');

            let userRating: number | null = null;
            let isInWatchlist = false;
            const userId = event.locals.user?.userId;

            if (includeUser && userId) {
                try {
                    const userRows = await sql<
                        Array<{ user_rating: number | null; in_watchlist: boolean }>
                    >`
						SELECT
							ur.rating as user_rating,
							${watchlistExistsFragment(sql, sql`${internalId}::uuid`, sql`${userId}::uuid`)} as in_watchlist
						FROM (SELECT 1) as dummy
						LEFT JOIN user_ratings ur ON ur.user_id = ${userId}::uuid
							AND ur.media_id = ${internalId}::uuid
						LIMIT 1
					`;
                    if (userRows[0]) {
                        userRating = userRows[0].user_rating;
                        isInWatchlist = userRows[0].in_watchlist === true;
                    }
                } catch (err) {
                    logger.warn('Failed to load per-user data for series/{id}', {
                        seriesId: internalId,
                        error: String(err),
                    });
                }
            }

            // Build response body: base shape + traversal links + optional user fields
            const surface = ctx.surface;

            const base = {
                id: internalId,
                catalogId: internalId,
                // Canonical type token = 'series', regardless of DB value
                type: 'series' as const,
                ids,
                title: row.title ?? '',
                year,
                overview: row.overview ?? undefined,
                images: await resolveImageSet(
                    sql,
                    surface,
                    internalId,
                    'series',
                    ctx.input?.query?.inherit === 'none' ? { inherit: 'none' } : undefined,
                ),
                // Traversal links — always included in series detail
                ...buildTraversalLinks(internalId, surface),
            };

            // Per-user metadata-language overlay (multilingual-media-metadata spec
            // §5): resolved once per request; zero extra queries when no
            // admin-additional language is configured.
            if (userId && config.METADATA_ADDITIONAL_LANGUAGES.length > 0) {
                const langs = resolveMetadataLanguage(
                    await getPlaybackPreferences.one(sql, { userId: userId as UserId }),
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
            }

            const userFields = includeUser
                ? { user: { rating: userRating, inWatchlist: isInWatchlist } }
                : {};

            // Rich detail fields — opt-in, same shared query+transform as
            // media/{id}'s ?include=details (see toNodeDetailsExtra in
            // api-transforms.ts) so the two paths can't drift apart.
            let detailsFields: Record<string, unknown> = {};
            if (includeDetails) {
                const richRow = await getMediaDetailByUuid(sql, internalId);
                if (richRow) {
                    const genreNames = (richRow.genres || []).filter(Boolean);
                    const streamSummary = await getMediaStreamSummary(
                        sql,
                        internalId,
                        richRow.media_type,
                    );
                    const fullDetail = transformToMediaDetail(
                        toDbMediaRow(richRow, genreNames),
                        ids,
                        streamSummary,
                        ctx.surface,
                        base.images,
                    );
                    // `null` = no MediaDetailSchema arm for the row. This route
                    // is series-only, so it should always be the 'series' arm;
                    // omitting `details` (which the schema allows) is the right
                    // response if a non-series row is ever reachable here,
                    // rather than emitting a movie-shaped expansion.
                    if (fullDetail) {
                        detailsFields = { details: toNodeDetailsExtra(fullDetail) };
                    }
                }
            }

            return json({ ...base, ...userFields, ...detailsFields });
        },
    },
});
