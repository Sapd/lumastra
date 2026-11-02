// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { buildMediaPreviews } from '$lib/server/services/media-preview.service.js';
import { MediaPreviewSchema } from '$lib/schemas/api-media-preview.js';
import { boundedListEnvelope } from '$lib/schemas/pagination.js';

/**
 * defs/lists/[id].ts — GET /lists/{id}
 *
 * GET /lists/{id}?limit=&debug=
 *   Returns items for a specific curated list with optional metadata enrichment.
 *   Auth: user. Errors: problem+json.
 */

import { z } from 'zod';
import { json } from '@sveltejs/kit';
import { defineEndpoint } from '$lib/server/api/define.js';
import { ApiProblem } from '$lib/server/api/problem.js';

// ---------------------------------------------------------------------------
// Request schema
// ---------------------------------------------------------------------------

/**
 * GET /lists/{id} query schema.
 *
 * `limit` — max items to return (1–200, handler defaults to 20).
 * `debug`  — when "true", adds debug diagnostics to the response.
 */
const ListItemsQuerySchema = z.object({
    // Coercion only; the handler clamps via Math.min(Math.max(1, ...), ...).
    limit: z.coerce.number().int().optional(),
    debug: z.string().optional(),
});
import { CACHE_NAMESPACES, cacheManager } from '$lib/server/cache/index.js';
import { config } from '$lib/server/config.js';
import { Logger } from '$lib/server/utils/logger.js';
import {
    buildSearchAccessContext,
    searchAccessBoundary,
} from '$lib/server/utils/search-access-context.js';
import { getDb } from '$lib/server/database/connection.js';
import type { AvailabilityRow } from '$lib/server/database/queries/for-you-helpers.queries.js';
import { entityImageUrl } from '$lib/shared/api-urls.js';
import { getPrimaryExternalIdProvider } from '$lib/server/utils/provider-config.js';
import { filterAccessibleMediaIds } from '$lib/server/utils/media-access-batch.js';
import { restrictedAccess } from '$lib/server/database/queries/builders/media-access-boundary.js';
import { toPublicMediaType } from '$lib/shared/media-type-domain';
import { TMDB_GENRE_MAP } from '$lib/constants/genres.js';
import { UUID_RE } from '$lib/utils/id-patterns.js';
import type { CachedListItem } from '$lib/server/ai/list-sync.js';
import type { MediaEmbedding } from '$lib/server/database/connection.js';

const ListItemsQuerySchemaFromDocs = z.object({
    limit: z.coerce
        .number()
        .int()
        .optional()
        .meta({ description: 'Max items to return (1-200, handler defaults to 20)' }),
    debug: z
        .string()
        .optional()
        .meta({ description: 'When "true", adds debug diagnostics to the response' }),
});

const ListItemsResponseSchema = boundedListEnvelope(MediaPreviewSchema).meta({
    id: 'ListItemsResponse',
    description: 'Bounded curated-list MediaPreviews with opaque handles and ImageSet.',
});

const logger = Logger.for('ListItemsDef');
const listsCache = cacheManager.for(CACHE_NAMESPACES.curatedLists);

// Fixed cache size to avoid fragmentation from different limit values
const CACHE_FETCH_SIZE = 50;

export const def = defineEndpoint({
    docs: {
        GET: {
            tags: ['Lists'],
            summary: 'Get items in a curated list',
            stability: 'stable',
            auth: 'bearer',
            description:
                'Returns the enriched media items in a curated list by its ID. A configured ' +
                'list that has not synced yet (or synced empty) answers 200 with an empty ' +
                '`items` array; only an unknown list ID is a 404.',
            query: ListItemsQuerySchemaFromDocs,
            responses: {
                200: { schema: ListItemsResponseSchema, description: 'List items' },
                401: 'Authentication required',
                404: 'Unknown list ID',
                503: 'Database unavailable',
                500: 'Internal server error',
            },
        },
    },

    auth: { kind: 'user' },
    request: {
        query: ListItemsQuerySchema,
    },
    handlers: {
        /**
         * GET /lists/{id}?limit=&debug=
         *
         * Returns items for a specific curated list.
         * `{id}` is the list slug (e.g. "trending-movies") — not an entity UUID,
         * so accept-any-resolve-canonical (N3) does not apply here.
         *
         * Response: bare object with `items` array + list metadata.
         */
        GET: async (event, ctx) => {
            if (event.locals.user?.isAgeRestricted) {
                return ApiProblem.forbidden('Lists are not available for age-restricted profiles');
            }

            // `id` is the list slug. The SPA surface mounts this def under
            // `[list_id]` (SvelteKit param name), while the v1 surface uses
            // `[id]`. Accept whichever param is present.
            const listId = event.params.id ?? event.params.list_id;
            if (!listId) {
                return ApiProblem.validationFailed('List ID is required');
            }

            const limit = Math.min(
                Math.max(1, Number.parseInt(event.url.searchParams.get('limit') || '20', 10) || 20),
                200,
            );
            const debug = event.url.searchParams.get('debug') === 'true';

            try {
                const { getCachedListItems, syncList, CURATED_LISTS } =
                    await import('$lib/server/ai/list-sync.js');

                const cacheKey = `v1:items:${listId}`;
                const listConfig = CURATED_LISTS.find((l) => l.list_id === listId);
                let items: CachedListItem[];

                const cached = await listsCache.get<CachedListItem[]>(cacheKey);
                if (cached && cached.length > 0) {
                    logger.debug('Serving list items from cache', {
                        listId,
                        count: cached.length,
                    });
                    items = cached;
                } else {
                    items = await getCachedListItems(listId, CACHE_FETCH_SIZE);

                    if (items.length === 0) {
                        if (listConfig) {
                            logger.info('List not cached, syncing now', { listId });
                            await syncList(listConfig, CACHE_FETCH_SIZE);
                            items = await getCachedListItems(listId, CACHE_FETCH_SIZE);
                        }
                    }

                    if (items.length > 0) {
                        await listsCache.set(cacheKey, items);
                    }
                }

                if (items.length === 0) {
                    // A configured list with nothing synced yet (a fresh install, no
                    // MDBList key) exists — it is empty, not missing. The 404 it used
                    // to get was a console error on every web Home load.
                    if (listConfig) {
                        return json({
                            items: [],
                            truncated: false,
                        });
                    }
                    return ApiProblem.notFound(`List '${listId}'`);
                }

                // Real availability (mirrors fetchTrending()'s lookupAvailabilityByTmdbIds()
                // usage), resolved for the whole cached window BEFORE the limit is
                // applied: when unavailable titles are hidden, filtering after the
                // slice would return short pages while available items sit beyond it.
                // Without this lookup every list item reported isAvailable:false/
                // canRequest:true, even titles already in the library.
                let availabilityMap = new Map<string, AvailabilityRow>();
                const sqlForAccess = getDb();
                // Fail closed: when the access context cannot be built (no DB, or
                // the build throws) it stays null and unavailable media counts as
                // hidden, so file-less and unknown items are dropped below.
                let accessCtx: Awaited<ReturnType<typeof buildSearchAccessContext>> | null = null;
                if (sqlForAccess) {
                    try {
                        accessCtx = await buildSearchAccessContext(sqlForAccess, event.locals.user);
                    } catch (err) {
                        logger.warn('Failed to build access context for list items', {
                            listId,
                            error: err instanceof Error ? err.message : String(err),
                        });
                    }
                }
                if (sqlForAccess && accessCtx) {
                    try {
                        const { lookupAvailabilityByTmdbIds, lookupAvailabilityByInternalIds } =
                            await import('$lib/server/database/queries/for-you-helpers.queries.js');
                        const boundary = searchAccessBoundary(accessCtx);
                        const tmdbIdsForAvailability = items
                            .filter((i) => /^\d+$/.test(i.primary_ext_id))
                            .map((i) => i.primary_ext_id);
                        if (tmdbIdsForAvailability.length > 0) {
                            availabilityMap = await lookupAvailabilityByTmdbIds(
                                sqlForAccess,
                                tmdbIdsForAvailability,
                                boundary,
                            );
                        }
                        // Rows without a numeric primary id resolve through their
                        // internal id instead of being dropped unconditionally.
                        const nonNumeric = items.filter(
                            (i) => !/^\d+$/.test(i.primary_ext_id) && UUID_RE.test(i.internal_id),
                        );
                        if (nonNumeric.length > 0) {
                            const byInternalId = await lookupAvailabilityByInternalIds(
                                sqlForAccess,
                                nonNumeric.map((i) => i.internal_id),
                                boundary,
                            );
                            for (const item of nonNumeric) {
                                const row = byInternalId.get(item.internal_id);
                                if (row) {
                                    availabilityMap.set(`${item.primary_ext_id}:${item.media_type}`, {
                                        ...row,
                                        primary_ext_id: item.primary_ext_id,
                                    });
                                }
                            }
                        }
                    } catch (err) {
                        // Restrictive default: with no availability data nothing is
                        // known to be available, so hidden-unavailable mode drops
                        // every item instead of answering 500.
                        logger.warn('Availability lookup failed for list items', {
                            listId,
                            error: err instanceof Error ? err.message : String(err),
                        });
                        availabilityMap = new Map();
                    }
                }
                // File-less titles are request candidates: without the operator
                // opt-in (SHOW_UNAVAILABLE_MEDIA + a request path) they are dead
                // ends, so drop them. With it they stay, flagged isAvailable:false.
                if (accessCtx?.showUnavailableMedia !== true) {
                    items = items.filter(
                        (i) =>
                            availabilityMap.get(`${i.primary_ext_id}:${i.media_type}`)
                                ?.is_available === true,
                    );
                }

                // Apply requested limit after cache retrieval and availability filtering
                const eligibleCount = items.length;
                items = items.slice(0, limit);

                // Dedup by primary_ext_id + media_type
                const originalCount = items.length;
                const seenKeys = new Set<string>();
                const duplicates: Array<{ rank: number; primaryExtId: string; title: string }> = [];
                items = items.filter((item) => {
                    const key = `${item.primary_ext_id}:${item.media_type}`;
                    if (seenKeys.has(key)) {
                        duplicates.push({
                            rank: item.rank,
                            primaryExtId: item.primary_ext_id,
                            title: item.title,
                        });
                        return false;
                    }
                    seenKeys.add(key);
                    return true;
                });
                if (duplicates.length > 0) {
                    logger.warn('Filtered duplicate list items', {
                        listId,
                        originalCount,
                        afterDedup: items.length,
                        duplicates,
                    });
                }

                // Enrich items with internal metadata + access filtering
                let mediaMetadataMap = new Map<string, MediaEmbedding>();
                try {
                    const { aiDbService } =
                        await import('$lib/server/services/database.service.js');
                    const db = await aiDbService.getDatabase();
                    if (db) {
                        const keys = items
                            .filter(
                                (i) =>
                                    /^\d+$/.test(i.primary_ext_id) &&
                                    // Embedding keys are (tmdb_id, movie|tv). An
                                    // episode/season row has no key of this shape,
                                    // so exclude it rather than mislabel it.
                                    (i.media_type === 'movie' || i.media_type === 'tv'),
                            )
                            .map((i) => ({
                                tmdb_id: Number(i.primary_ext_id),
                                // constrained by the filter directly above.
                                // eslint-disable-next-line callback-safety/no-narrowing-media-type-cast
                                media_type: i.media_type as 'movie' | 'tv',
                            }));

                        const metadata = await db.getMediaEmbeddingsByKeys(keys);

                        let allowedInternalIds: Set<string> | null = null;
                        if (sqlForAccess && accessCtx) {
                            if (accessCtx.deniedGroupIds || accessCtx.ageRating) {
                                const internalIds = metadata
                                    .map((m) => m.internal_id)
                                    .filter((id): id is string => typeof id === 'string');
                                if (internalIds.length > 0) {
                                    // The shared batch gate, not a local copy of
                                    // the two predicates. A list row is
                                    // `movie` or `tv` (see the filter above), and
                                    // the copy that used to live here asked
                                    // whether the row owned a non-denied file —
                                    // which no `tv` row does (0 of 6,570 on
                                    // production, 2026-09-15), so its
                                    // `NOT EXISTS (own files)` arm was always TRUE
                                    // and the library axis did nothing for series.
                                    allowedInternalIds = await filterAccessibleMediaIds(
                                        sqlForAccess,
                                        internalIds,
                                        restrictedAccess({
                                            deniedGroupIds: accessCtx.deniedGroupIds ?? [],
                                            maxAgeRating: accessCtx.ageRating?.maxAgeRating ?? null,
                                            allowUnrated: accessCtx.ageRating?.allowUnrated ?? true,
                                        }),
                                    );
                                } else {
                                    allowedInternalIds = new Set();
                                }
                            }
                        }

                        metadata.forEach((m) => {
                            if (
                                allowedInternalIds !== null &&
                                m.internal_id &&
                                !allowedInternalIds.has(m.internal_id)
                            ) {
                                return;
                            }
                            const compositeKey = `${m.tmdb_id}:${m.media_type}`;
                            mediaMetadataMap.set(compositeKey, m);
                        });
                    }
                } catch (err) {
                    logger.warn('Failed to fetch metadata from database', err as Error);
                }

                const enrichedItems = items.flatMap((item, index) => {
                    // A list row whose media_type has no public representation is
                    // DROPPED, not relabelled: `type` is a real enum on the
                    // published contract, and the old `canonicalType` fallback
                    // leaked the raw storage token (or defaulted a typeless row to
                    // 'movie'). mdblist rows are movie/show, so this drops nothing
                    // in practice. `rank` deliberately keeps the ORIGINAL list
                    // position, so a drop leaves a gap rather than renumbering the
                    // items after it.
                    const publicType = toPublicMediaType(item.media_type);
                    if (!publicType) return [];

                    const compositeKey = `${item.primary_ext_id}:${item.media_type}`;
                    const metadata = mediaMetadataMap.get(compositeKey);
                    const availability = availabilityMap.get(compositeKey);
                    // The availability row passed the same access boundary, so its
                    // internal id is as safe to expose as the embedding row's. Rows
                    // without a numeric primary id only have this one.
                    const accessibleInternalId =
                        metadata?.internal_id ?? availability?.internal_id ?? null;

                    // Public contract: flat `posterUrl` (matches GET /media/{id});
                    // never leak the internal provider name in the path.
                    const posterUrl = accessibleInternalId
                        ? entityImageUrl(accessibleInternalId, 'poster', ctx.surface, {
                              size: 'thumb',
                          })
                        : entityImageUrl(
                              `${getPrimaryExternalIdProvider()}:${item.primary_ext_id}:${item.media_type}`,
                              'poster',
                              ctx.surface,
                              { size: 'thumb' },
                          );

                    const enriched = {
                        id: accessibleInternalId,
                        externalIds: {
                            internal: accessibleInternalId,
                            [getPrimaryExternalIdProvider()]: item.primary_ext_id,
                        },
                        // Canonical public discriminator ('series', never raw 'tv'/sonarr/radarr).
                        type: publicType,
                        title: item.title,
                        overview: metadata?.overview || '',
                        // `metadata.genres` holds TMDB genre IDs (number[]), not
                        // names — map them. The response schema had been widened
                        // to `z.array(string) | z.array(number)` to accommodate
                        // the raw ids, which masked the mismatch rather than
                        // fixing it; clients were getting [28, 878] to render.
                        genres: (metadata?.genres ?? []).map((g) => TMDB_GENRE_MAP[g] ?? String(g)),
                        // `item.score` is mdblist_score, stored 0-100
                        // (list-sync.ts:432) — this field is documented 0-10, so
                        // scale it rather than shipping e.g. 85 as a "rating".
                        rating:
                            metadata?.imdb_rating ??
                            (item.score != null ? item.score / 10 : undefined),
                        ratingSource: metadata?.imdb_rating
                            ? 'imdb'
                            : item.score
                              ? 'mdblist'
                              : undefined,
                        letterboxdRating: metadata?.letterboxd_rating ?? undefined,
                        letterboxdVotes: metadata?.letterboxd_votes ?? undefined,
                        rtCritic: metadata?.rt_rating ?? undefined,
                        rtAudience: metadata?.rt_audience_score ?? undefined,
                        mdblistScore: metadata?.mdblist_score || item.score || undefined,
                        traktScore: metadata?.trakt_score ?? undefined,
                        metacriticScore: metadata?.metacritic_score ?? undefined,
                        malScore: metadata?.mal_score ?? undefined,
                        trending: true,
                        trendingSource: 'mdblist' as const,
                        rank: index + 1,
                        year:
                            item.release_year ||
                            (metadata?.release_date
                                ? new Date(metadata.release_date).getFullYear()
                                : undefined),
                        // Real availability (mirrors fetchTrending()'s enrichment) —
                        // an item absent from the availability map has no library row,
                        // so it defaults to the pre-existing "not available, requestable"
                        // behavior rather than staying permanently hardcoded to it.
                        isAvailable: availability?.is_available ?? false,
                        canRequest: availability ? (availability.can_request ?? false) : true,
                        posterUrl,
                    };
                    return [enriched];
                });

                // Per-user metadata-language overlay (multilingual-media-metadata
                // spec §5): `enrichedItems` is a freshly-built array of new object
                // literals from the `.flatMap()` above (never shares a reference with
                // the cached `CachedListItem[]`/`mediaMetadataMap` — only their
                // scalar fields were read), so no clone is needed even though the
                // underlying list is cache-backed. Title/overview both derive from
                // a live `media_items`/metadata join (see `getCachedListItems` and
                // `getMediaEmbeddingsByKeys`), not a stored external-list snapshot,
                // so both are eligible. Resolved ONCE per request, gated on
                // METADATA_ADDITIONAL_LANGUAGES; skipped for anonymous/no-UUID items.
                const listUserId = event.locals.user?.userId;
                if (listUserId && config.METADATA_ADDITIONAL_LANGUAGES.length > 0) {
                    const sqlForOverlay = getDb();
                    if (sqlForOverlay) {
                        const { resolveMetadataLanguage } =
                            await import('$lib/server/utils/metadata-language-resolve.js');
                        const { getPlaybackPreferences } =
                            await import('$lib/server/database/queries/user-preferences.queries.js');
                        const langs = resolveMetadataLanguage(
                            await getPlaybackPreferences.one(sqlForOverlay, { userId: listUserId }),
                        );
                        if (langs.titleLang || langs.textLang) {
                            const { applyTranslationOverlay } =
                                await import('$lib/server/utils/translation-overlay.js');
                            await applyTranslationOverlay(sqlForOverlay, enrichedItems, langs, {
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
                }

                const previewSql = getDb();
                if (!previewSql) return ApiProblem.dependencyUnavailable('Database unavailable');
                const previewItems = await buildMediaPreviews(
                    previewSql,
                    ctx.surface,
                    enrichedItems.map((item) => ({
                        id: item.id,
                        type: item.type,
                        title: item.title ?? '',
                        ids: item.externalIds,
                        overview: item.overview,
                        genres: item.genres,
                        rating: item.rating,
                        year: item.year,
                        isAvailable: item.isAvailable,
                        canRequest: item.canRequest,
                    })),
                    event.locals.user.userId,
                );
                const response: Record<string, unknown> = {
                    items: previewItems,
                    truncated: eligibleCount > limit || originalCount >= CACHE_FETCH_SIZE,
                };

                if (debug) {
                    response.debug = {
                        originalCount,
                        afterDedup: items.length,
                        duplicatesRemoved: duplicates.length,
                        duplicates,
                    };
                }

                return json(response);
            } catch (err) {
                logger.error('Failed to get list items', err as Error, { listId });
                return ApiProblem.internalError('Failed to retrieve list items');
            }
        },
    },
});
