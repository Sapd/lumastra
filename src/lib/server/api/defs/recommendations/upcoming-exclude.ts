// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * defs/recommendations/upcoming-exclude.ts
 *
 * GET    /api/upcoming/exclude  — list all excluded series for the current user
 * POST   /api/upcoming/exclude  — mute a series or movie (by catalog id or TMDB id; never by title)
 * DELETE /api/upcoming/exclude  — unmute by flag row `id`
 *
 * Auth: user (GET/POST/DELETE all require an authenticated session).
 * Response shapes:
 *   GET    → { items: ExcludedSeriesItem[], page: PageBlock }
 *   POST   → bare object { message: string, seriesName: string, id?: string }
 *   DELETE → bare object { message: string, seriesName: string } (seriesName is empty)
 * Errors: problem+json (incl. 503 dependency_unavailable when DB is down).
 */

import { readBoundedJson } from '$lib/server/utils/bounded-body-reader.js';
import { z } from 'zod';
import { json } from '@sveltejs/kit';
import { defineEndpoint } from '$lib/server/api/define.js';
import { ApiProblem, paginate } from '$lib/server/api/problem.js';
import { Logger } from '$lib/server/utils/logger.js';
import { cacheManager, CACHE_NAMESPACES } from '$lib/server/cache/index.js';
import {
    EXCLUDED_SERIES_LIST_CACHE_KEY,
    invalidateExcludedSeriesCache,
} from '$lib/server/utils/excluded-series.js';
import { excludeSeriesBodySchema, removeExclusionBodySchema } from '$lib/schemas/common.js';

const logger = Logger.for('UpcomingExcludeDef');

const excludedSeriesCache = cacheManager.for(CACHE_NAMESPACES.excludedSeries);
const upcomingEpisodesCache = cacheManager.for(CACHE_NAMESPACES.upcomingEpisodes);
const newEpisodesCache = cacheManager.for(CACHE_NAMESPACES.newEpisodes);

// ---------------------------------------------------------------------------
// Schemas
// ---------------------------------------------------------------------------

const ExcludedSeriesItemSchema = z.object({
    /** user_media_flags row id; the handle for DELETE. */
    id: z.string(),
    username: z.string(),
    seriesName: z.string(),
    kind: z.enum(['series', 'tmdb_tv', 'tmdb_movie']),
    mediaId: z.string().optional(),
    tmdbId: z.string().optional(),
    excludedAt: z.string(),
});

export type ExcludedSeriesItem = z.infer<typeof ExcludedSeriesItemSchema>;

/** Mutable-result response (POST / DELETE). */
const ExclusionMutationSchema = z.object({
    message: z.string(),
    seriesName: z.string(),
    id: z.string().optional(),
});

export type ExclusionMutation = z.infer<typeof ExclusionMutationSchema>;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Clear per-user caches after exclusion list changes. */
async function clearRelatedCaches(userId: string, username: string): Promise<void> {
    await invalidateExcludedSeriesCache(userId, username);
    await upcomingEpisodesCache.deleteUserCache(userId);
    await newEpisodesCache.deleteUserCache(userId);
}

/** Parse a JSON body against a Zod schema; return a problem response on failure. */
async function parseBody<T>(
    event: { request: Request },
    schema: z.ZodType<T>,
): Promise<{ ok: true; data: T } | { ok: false; response: Response }> {
    let raw: unknown;
    try {
        raw = await readBoundedJson(event.request);
    } catch {
        return {
            ok: false,
            response: ApiProblem.validationFailed([
                { field: 'body', message: 'Invalid JSON body' },
            ]),
        };
    }
    const parsed = schema.safeParse(raw);
    if (!parsed.success) {
        return {
            ok: false,
            response: ApiProblem.validationFailed(
                parsed.error.issues.map((e) => ({
                    field: e.path.join('.'),
                    message: e.message,
                })),
            ),
        };
    }
    return { ok: true, data: parsed.data };
}

// ---------------------------------------------------------------------------
// Endpoint definition
// ---------------------------------------------------------------------------

export const def = defineEndpoint({
    auth: { kind: 'user' },
    visibility: 'internal',
    handlers: {
        /** GET /upcoming/exclude — list all exclusions for the current user. */
        GET: async (event, _ctx) => {
            const userId = event.locals.user?.userId;
            const username = event.locals.user?.username;
            if (!userId || !username) {
                return ApiProblem.unauthorized();
            }

            try {
                const { getDb } = await import('$lib/server/database/connection.js');
                const { getExcludedSeries } = await import('$lib/server/database/queries/index.js');

                // Serve from per-user cache when available.
                const cached = await excludedSeriesCache.get<ExcludedSeriesItem[]>(
                    EXCLUDED_SERIES_LIST_CACHE_KEY,
                    userId,
                );
                if (cached) {
                    return json(
                        paginate(cached, { limit: cached.length, offset: 0, hasMore: false }),
                    );
                }

                const sql = getDb();
                if (!sql) {
                    return ApiProblem.dependencyUnavailable('Database not available');
                }

                const rows = await getExcludedSeries.all(sql, { userId });

                const items: ExcludedSeriesItem[] = rows.map((row) =>
                    ExcludedSeriesItemSchema.parse({
                        id: String(row.id),
                        username: row.user_id,
                        seriesName: row.series_name,
                        kind: row.kind,
                        mediaId: row.media_id ?? undefined,
                        tmdbId: row.tmdb_id ?? undefined,
                        excludedAt:
                            row.excluded_at instanceof Date
                                ? row.excluded_at.toISOString()
                                : String(row.excluded_at),
                    }),
                );

                await excludedSeriesCache.set(
                    EXCLUDED_SERIES_LIST_CACHE_KEY,
                    items,
                    undefined,
                    userId,
                );

                return json(paginate(items, { limit: items.length, offset: 0, hasMore: false }));
            } catch (err) {
                logger.error('Failed to get excluded series', err as Error);
                return ApiProblem.internalError('Failed to retrieve excluded series');
            }
        },

        /** POST /upcoming/exclude — exclude a series. */
        POST: async (event, _ctx) => {
            const userId = event.locals.user?.userId;
            const username = event.locals.user?.username;
            if (!userId || !username) {
                return ApiProblem.unauthorized();
            }

            const bodyResult = await parseBody(event, excludeSeriesBodySchema);
            if (!bodyResult.ok) return bodyResult.response;
            const { seriesName, mediaId, tmdbId, mediaType } = bodyResult.data;

            try {
                const { getDb } = await import('$lib/server/database/connection.js');
                const { upsertExcludedSeries } =
                    await import('$lib/server/database/queries/index.js');
                const { checkMediaAccess } = await import('$lib/server/middleware/media-access.js');

                const sql = getDb();
                if (!sql) {
                    return ApiProblem.dependencyUnavailable('Database not available');
                }
                const user = event.locals.user;

                // A mute must never reveal an item the user cannot see: a denied
                // catalog id answers like a missing one, and a TMDB key (only ever
                // shown on Sonarr/Radarr-only calendar rows, which restricted users
                // never get) is refused for them.
                let rows;
                if (mediaId) {
                    if (!(await checkMediaAccess(sql, mediaId, user))) {
                        return ApiProblem.notFound('Media item');
                    }
                    rows = await upsertExcludedSeries.execute(sql, {
                        userId,
                        seriesName,
                        mediaId,
                    });
                } else if (tmdbId) {
                    const { buildSearchAccessContext, searchAccessBoundary } =
                        await import('$lib/server/utils/search-access-context.js');
                    const { isUnrestricted } =
                        await import('$lib/server/database/queries/builders/media-access-boundary.js');
                    const accessCtx = await buildSearchAccessContext(sql, user);
                    if (!isUnrestricted(searchAccessBoundary(accessCtx))) {
                        return ApiProblem.notFound('Media item');
                    }
                    rows = await upsertExcludedSeries.execute(sql, {
                        userId,
                        seriesName,
                        tmdbId,
                        tmdbType: mediaType === 'movie' ? 'movie' : 'tv',
                    });
                } else {
                    // Unreachable: the body schema requires one of the two ids.
                    return ApiProblem.validationFailed([
                        { field: 'body', message: 'mediaId or tmdbId is required' },
                    ]);
                }
                const [row] = rows;
                // A mediaId is written only while it exists and is a series or movie.
                if (!row) {
                    return ApiProblem.notFound('Media item');
                }

                logger.info('Series excluded from upcoming', { username, seriesName });
                await clearRelatedCaches(userId, username);

                return json(
                    ExclusionMutationSchema.parse({
                        message: 'Series excluded successfully',
                        seriesName,
                        id: row.id,
                    }),
                );
            } catch (err) {
                logger.error('Failed to exclude series', err as Error);
                return ApiProblem.internalError('Failed to exclude series');
            }
        },

        /** DELETE /upcoming/exclude — remove a series exclusion. */
        DELETE: async (event, _ctx) => {
            const userId = event.locals.user?.userId;
            const username = event.locals.user?.username;
            if (!userId || !username) {
                return ApiProblem.unauthorized();
            }

            const bodyResult = await parseBody(event, removeExclusionBodySchema);
            if (!bodyResult.ok) return bodyResult.response;
            const { id } = bodyResult.data;

            try {
                const { getDb } = await import('$lib/server/database/connection.js');
                const { removeExcludedSeriesById } =
                    await import('$lib/server/database/queries/index.js');

                const sql = getDb();
                if (!sql) {
                    return ApiProblem.dependencyUnavailable('Database not available');
                }

                const result = await removeExcludedSeriesById.all(sql, { userId, id });

                if (result.length === 0) {
                    return ApiProblem.notFound('Excluded series');
                }

                logger.info('Series unexcluded from upcoming', { username, id });
                await clearRelatedCaches(userId, username);

                return json(
                    ExclusionMutationSchema.parse({
                        message: 'Series unexcluded successfully',
                        seriesName: '',
                    }),
                );
            } catch (err) {
                logger.error('Failed to unexclude series', err as Error);
                return ApiProblem.internalError('Failed to unexclude series');
            }
        },
    },
});
