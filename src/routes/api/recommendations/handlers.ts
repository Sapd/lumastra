// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { json } from '@sveltejs/kit';
import { z } from 'zod';
import { isEpisode, isMovie, isSeries } from '$lib/server/utils/media-types';
import { refreshRateLimit } from '$lib/server/api/defs/recommendations/_refresh-rate-limit.js';
import { defineEndpoint } from '$lib/server/api/define.js';
import { ApiProblem } from '$lib/server/api/problem.js';
import { getEffectiveUser } from '$lib/server/dev-user.js';
import { config } from '$lib/server/config.js';
import { Logger } from '$lib/server/utils/logger.js';
import { cacheManager, CACHE_NAMESPACES } from '$lib/server/cache';
import { watchManager } from '$lib/server/services/watch-manager.service.js';
import { resolvePlayingMediaIds } from '$lib/server/services/effective-watching.service.js';
import type { ContinueWatchingRow } from '$lib/server/database/queries/watch-state.queries.js';

import { createExternalIds } from '$lib/utils/external-ids.js';
import { getCatalogPosterUrl } from '$lib/utils/image-utils';
import { getPrimaryExternalIdProvider } from '$lib/server/utils/provider-config.js';
import { nextUpRowToMediaItem } from '$lib/server/utils/next-up-media-item.js';
import {
    resolveViewerMetadataLanguages,
    type ResolvedMetadataLanguages,
} from '$lib/server/utils/metadata-language-resolve.js';
import {
    heroLangCacheToken,
    overlayHeroMediaItems,
} from '$lib/server/utils/hero-item-translation.js';
import { getDb } from '$lib/server/database/connection.js';
import {
    buildSearchAccessContext,
    searchAccessBoundary,
} from '$lib/server/utils/search-access-context.js';
import { getQualityLibraryMedia } from '$lib/server/database/queries/hero-fallback.queries.js';
import { pickDisplayRating } from '$lib/server/utils/rating-utils.js';
import { hasUserWatchActivitySince } from '$lib/server/database/queries/watch-history.queries.js';
import { getUserIdByUsername } from '$lib/server/database/queries/users.queries.js';
import type { UserId } from '$lib/shared/user-id.js';
import { stripAudiobookListArraysFromMetadata } from '$lib/server/utils/strip-audiobook-list-arrays.js';

const logger = Logger.for('Recommendations');

// ---------------------------------------------------------------------------
// Request schema
// ---------------------------------------------------------------------------

const RecommendationsQuerySchema = z.object({
    type: z.enum(['nextup', 'continue', 'watching', 'movies', 'series']).optional(),
    limit: z.coerce.number().int().min(1).max(100).optional().default(10),
    validate: z
        .string()
        .optional()
        .transform((v) => v === 'true'),
});

// ---------------------------------------------------------------------------
// Response shapes (typed, no z.any())
// ---------------------------------------------------------------------------

/**
 * Minimal typed shape for cache-staleness check responses.
 */
const NextUpValidateResponseSchema = z.object({
    isStale: z.boolean(),
    reason: z.string().optional(),
});

/**
 * Standard recommendations list shape.
 * items is typed as z.array(z.unknown()) because each type case (nextup, continue,
 * movies/series) returns a different item shape. The SPA consumer validates via its own
 * schema (nextUpRowToMediaItem shape).
 */
const RecommendationsResponseSchema = z.object({
    items: z.array(z.unknown()).optional(),
    cached: z.boolean().optional(),
    cachedAt: z.number().optional(),
    message: z.string().optional(),
    fallback: z.boolean().optional(),
});

/**
 * Watching rail: one nextUp + one continueWatching item.
 */
const WatchingResponseSchema = z.object({
    nextUp: z.unknown().nullable(),
    continueWatching: z.unknown().nullable(),
});

// ---------------------------------------------------------------------------
// Caches
// ---------------------------------------------------------------------------

const heroNextUpCache = cacheManager.for(CACHE_NAMESPACES.heroNextUp);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function continueWatchingRowToMediaItem(
    row: ContinueWatchingRow,
    playingIds?: Set<string>,
): Record<string, unknown> {
    const isEpisodeContent = isEpisode(row.media_type);
    const runtimeMs = row.runtime_ms ? Number(row.runtime_ms) : 0;
    const positionMs = Number(row.resume_position_ms);

    return {
        // True when a fresh live session is actively playing this item — drives
        // the hero's "Playing now" treatment. Omitted (not false) when not
        // playing so it stays absent from the serialized payload.
        isPlaying: playingIds?.has(row.media_id) ? true : undefined,
        id: row.media_id,
        title: row.title,
        overview: row.overview ?? undefined,
        // Chapter/file lists are stripped here — a single in-progress
        // audiobook can carry hundreds of entries in each array and this
        // rail/hero item never renders them (see
        // stripAudiobookListArraysFromMetadata). Every other
        // `audiobookshelf` field, e.g. authors/narrators, is kept.
        customMetadata: stripAudiobookListArraysFromMetadata(row.custom_metadata) ?? undefined,
        externalIds: createExternalIds({
            [getPrimaryExternalIdProvider()]: row.tmdb_id || null,
            imdb: row.imdb_id || null,
            internal: row.media_id,
        }),
        // 'mediaType' field preserved (SPA consumer reads rec.mediaType); 'tv' value kept
        mediaType: isSeries(row.media_type)
            ? 'tv'
            : isMovie(row.media_type)
              ? 'movie'
              : row.media_type,
        seriesName: row.series_name ?? undefined,
        seasonNumber: row.season_number ?? undefined,
        episodeNumber: row.episode_number ?? undefined,
        duration: runtimeMs > 0 ? Math.round(runtimeMs / 1000) : undefined,
        // images{} self-describing href map (no flat imageUrl/posterUrl)
        images: {
            thumb: { href: getCatalogPosterUrl(row.media_id, { size: 'thumb' }) },
        },
        watchProgress: runtimeMs > 0 ? Math.min((positionMs / runtimeMs) * 100, 100) : 0,
        playbackPositionTicks: positionMs * 10000,
        // Internal series UUID (also under `seriesInternalId`, which the
        // translation overlay keys on).
        seriesId: row.series_id ?? undefined,
        seriesInternalId: row.series_id ?? undefined,
        imageBackdropId: isEpisodeContent ? row.series_id || row.media_id : row.media_id,
    };
}

/**
 * Overlay the viewer's preferred-language title/overview onto freshly-built
 * hero / Continue-Watching items (delegates to the shared helper; resolves the
 * DB handle here). Mutates in place; no-op when no overlay applies.
 */
async function overlayHeroItems(
    items: Record<string, unknown>[],
    langs: ResolvedMetadataLanguages,
): Promise<void> {
    const sql = getDb();
    if (!sql) return;
    await overlayHeroMediaItems(sql, items, langs);
}

// ---------------------------------------------------------------------------
// Endpoint definition
// ---------------------------------------------------------------------------

export const def = defineEndpoint({
    auth: { kind: 'user' },
    visibility: 'internal',
    request: {
        query: RecommendationsQuerySchema,
    },
    handlers: {
        GET: async (event, ctx) => {
            if (event.request.method === 'GET' && event.url.searchParams.has('refresh'))
                return ApiProblem.validationFailed('Use the POST refresh action');
            const { locals, request } = event;
            const query = ctx.input!.query;

            const type = query.type;
            const refresh = event.request.method === 'POST';
            const limit = query.limit;

            // Resolve effective user
            const effectiveUsername = getEffectiveUser(
                request,
                locals.user?.username || config.DEFAULT_USER,
            );
            const effectiveUserId: UserId | undefined =
                effectiveUsername === locals.user?.username
                    ? locals.user?.userId
                    : await (async () => {
                          const sqlForId = getDb();
                          return sqlForId
                              ? ((await getUserIdByUsername(sqlForId, effectiveUsername)) ??
                                    undefined)
                              : undefined;
                      })();
            if (!effectiveUserId) {
                return ApiProblem.unauthorized('User not resolvable');
            }

            // Viewer's metadata-language overlay, resolved once (gated → zero
            // queries when the feature is off). Reused by the continue/nextup/
            // watching/movies/series hero paths so they localize titles like the
            // modal does. Keyed on the VIEWER (locals.user), not the effective/
            // admin-previewed user, so this matches +page.server.ts's SSR choice
            // — otherwise the SSR first paint and this client refresh could
            // localize to two different languages during an admin preview.
            const langs = await resolveViewerMetadataLanguages(
                getDb(),
                locals.user?.userId ?? effectiveUserId,
            );
            // Cache-key token so the per-user Next Up cache never serves one
            // language's overlay to another (empty when no overlay applies).
            const langTok = heroLangCacheToken(langs);

            try {
                switch (type) {
                    case 'nextup': {
                        // Language token in the key: a cache hit returns items
                        // already overlaid in the viewer's language, so hits stay
                        // instant AND correct across a language switch.
                        const cacheKey = `v2:nextup:${limit}${langTok}`;
                        const validate = query.validate;

                        if (validate) {
                            const cached = await heroNextUpCache.get<{
                                data: Record<string, unknown>[];
                                cachedAt: number;
                            }>(cacheKey, effectiveUserId);

                            if (!cached) {
                                return json(
                                    NextUpValidateResponseSchema.parse({
                                        isStale: true,
                                        reason: 'no_cache',
                                    }),
                                );
                            }
                            if (!cached.cachedAt) {
                                await heroNextUpCache.delete(cacheKey, effectiveUserId);
                                return json(
                                    NextUpValidateResponseSchema.parse({
                                        isStale: true,
                                        reason: 'legacy_cache_format',
                                    }),
                                );
                            }

                            try {
                                const sql = getDb();
                                if (sql) {
                                    const cachedDate = new Date(cached.cachedAt);
                                    const hasActivity = await hasUserWatchActivitySince.check(sql, {
                                        userId: effectiveUserId,
                                        since: cachedDate,
                                    });
                                    if (hasActivity) {
                                        await heroNextUpCache.delete(cacheKey, effectiveUserId);
                                        return json(
                                            NextUpValidateResponseSchema.parse({
                                                isStale: true,
                                                reason: 'activity_detected',
                                            }),
                                        );
                                    }
                                }
                            } catch (e) {
                                logger.warn(
                                    'Activity check failed in validate mode',
                                    {},
                                    e as Error,
                                );
                            }

                            return json(NextUpValidateResponseSchema.parse({ isStale: false }));
                        }

                        if (!refresh) {
                            const cached = await heroNextUpCache.get<{
                                data: Record<string, unknown>[];
                                cachedAt: number;
                            }>(cacheKey, effectiveUserId);
                            if (cached && cached.cachedAt && cached.data) {
                                return json(
                                    RecommendationsResponseSchema.parse({
                                        items: cached.data,
                                        cachedAt: cached.cachedAt,
                                        cached: true,
                                    }),
                                );
                            }
                        }

                        const nextUpRows = await watchManager.getNextUp(effectiveUserId, limit);
                        const transformed = nextUpRows.map(nextUpRowToMediaItem);
                        // Localize before caching so the stored payload is already
                        // in the viewer's language (see langTok above).
                        await overlayHeroItems(transformed, langs);
                        await heroNextUpCache.set(
                            cacheKey,
                            { data: transformed, cachedAt: Date.now() },
                            undefined,
                            effectiveUserId,
                        );
                        return json(
                            RecommendationsResponseSchema.parse({
                                items: transformed,
                                cachedAt: Date.now(),
                                cached: false,
                            }),
                        );
                    }

                    case 'continue': {
                        const cwRows = await watchManager.getContinueWatching(
                            effectiveUserId,
                            limit,
                        );
                        // Overlay the live playing state (reusing the canonical
                        // resolver) so the hero can render "Playing now" — the raw
                        // CW rows carry no session state on their own.
                        const playingIds = await resolvePlayingMediaIds(
                            effectiveUsername,
                            effectiveUserId,
                            cwRows,
                        );
                        const continueItems = cwRows.map((row) =>
                            continueWatchingRowToMediaItem(row, playingIds),
                        );
                        // Not cached — safe to overlay in place before responding.
                        await overlayHeroItems(continueItems, langs);
                        return json(
                            RecommendationsResponseSchema.parse({
                                items: continueItems,
                                cached: false,
                            }),
                        );
                    }

                    case 'watching': {
                        const halfLimit = Math.ceil(limit / 2);
                        const [watchingNextUpRows, watchingCwRows] = await Promise.all([
                            watchManager.getNextUp(effectiveUserId, halfLimit),
                            watchManager.getContinueWatching(effectiveUserId, halfLimit),
                        ]);
                        const watchingNextUp = watchingNextUpRows.map(nextUpRowToMediaItem);
                        const watchingContinue = watchingCwRows.map((row) =>
                            continueWatchingRowToMediaItem(row),
                        );
                        // Localize both single-item rails before responding.
                        await Promise.all([
                            overlayHeroItems(watchingNextUp, langs),
                            overlayHeroItems(watchingContinue, langs),
                        ]);
                        return json(
                            WatchingResponseSchema.parse({
                                nextUp: watchingNextUp[0] || null,
                                continueWatching: watchingContinue[0] || null,
                            }),
                        );
                    }

                    case 'movies':
                    case 'series': {
                        const sql = getDb();
                        if (!sql) {
                            return ApiProblem.dependencyUnavailable('Database');
                        }
                        // `type` is narrowed to the literal 'movies' | 'series' by this
                        // combined case block (query.type: z.enum([...]) above) — that
                        // plural 'movies' has never matched toTmdbType's 'movie' | alias
                        // vocabulary, so calling it here previously depended on the old
                        // total toTmdbType's `return 'movie'` catch-all to work at all.
                        // Deriving the TMDB namespace directly from the already-known
                        // case value is both correct and structurally non-null.
                        const dbMediaType: 'movie' | 'tv' = type === 'movies' ? 'movie' : 'tv';
                        const accessCtx = await buildSearchAccessContext(sql, locals.user);
                        const dbItems = await getQualityLibraryMedia(sql, {
                            mediaType: dbMediaType,
                            limit,
                            access: searchAccessBoundary(accessCtx),
                        });
                        const mappedItems = dbItems.map((item) => {
                            const rating = pickDisplayRating({
                                imdbRating: item.imdb_rating,
                                tmdbRating: item.tmdb_rating,
                                voteCount: item.vote_count,
                            });
                            return {
                                externalIds: createExternalIds({
                                    tmdb: item.tmdb_id ?? undefined,
                                    internal: item.internal_id ?? undefined,
                                }),
                                // 'mediaType' field preserved (SPA reads rec.mediaType)
                                mediaType: isSeries(item.media_type) ? 'tv' : 'movie',
                                title: item.title,
                                year: item.release_year,
                                overview: item.overview,
                                genres: item.genres,
                                rating,
                                // Derived FROM the picked value rather than
                                // re-deriving the gate beside it: the copy here had
                                // to be kept in lockstep with pickDisplayRating by
                                // hand, and a row must not be labelled 'tmdb' while
                                // carrying no rating at all.
                                ratingSource:
                                    rating === undefined
                                        ? undefined
                                        : item.imdb_rating && item.imdb_rating > 0
                                          ? 'imdb'
                                          : 'tmdb',
                                isAvailable: item.is_available ?? false,
                                canRequest: item.can_request ?? false,
                                remoteTrailers: item.trailer_url ? [item.trailer_url] : undefined,
                            };
                        });
                        // Localize the no-history fallback hero / rails too — for
                        // a user with no Continue Watching this is the hero they
                        // see (hero-builder fetches type=movies). Keyed on
                        // externalIds.internal (these rows carry no top-level id).
                        await overlayHeroItems(mappedItems, langs);
                        return json(
                            RecommendationsResponseSchema.parse({
                                items: mappedItems,
                                cached: false,
                            }),
                        );
                    }

                    default:
                        return ApiProblem.validationFailed([
                            { field: 'query.type', message: 'Invalid recommendation type' },
                        ]);
                }
            } catch (error) {
                logger.error('Recommendations error', error as Error);
                return ApiProblem.internalError('Failed to get recommendations');
            }
        },
    },
});

export const refreshDef = defineEndpoint({
    auth: def.auth,
    rateLimit: refreshRateLimit,
    visibility: 'internal',
    request: {
        body: RecommendationsQuerySchema.loose().superRefine((body, ctx) => {
            for (const field of ['refresh', 'offset', 'cursor']) {
                if (field in body)
                    ctx.addIssue({
                        code: 'custom',
                        path: [field],
                        message: 'Not accepted by this refresh action',
                    });
            }
        }),
    },
    handlers: {
        POST: (event, ctx) =>
            def.handlers.GET!(event, {
                ...ctx,
                input: { query: ctx.input!.body, body: undefined, params: undefined },
            }),
    },
});
