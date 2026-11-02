// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { buildMediaPreviews } from '$lib/server/services/media-preview.service.js';
import { MediaPreviewSchema } from '$lib/schemas/api-media-preview.js';
import { boundedListEnvelope } from '$lib/schemas/pagination.js';

/**
 * defs/catalog/media-id-similar.ts — `media/{id}/similar`.
 *
 * Contract (bare object — single resource):
 *   GET /media/{id}/similar?limit=&minSimilarity=
 *     → { sourceMedia: { id, type, ids, title }, similar: [MediaSummary], count }
 *
 * Auth: user (age-restricted users receive 403).
 * Surface: internal (SPA AI feature; not external-automation value).
 */

import { ImageSetSchema, InheritQuerySchema } from '$lib/schemas/api-image-descriptor.js';
import { z } from 'zod';
import { defineEndpoint } from '$lib/server/api/define.js';
import { ApiProblem } from '$lib/server/api/problem.js';
import { json } from '@sveltejs/kit';
import { getDb } from '$lib/server/database/connection.js';
import { config } from '$lib/server/config.js';
import { createExternalIds } from '$lib/utils/external-ids.js';
import { getPrimaryExternalIdProvider } from '$lib/server/utils/provider-config.js';
import {
    buildSearchAccessContext,
    scopedCacheKey,
} from '$lib/server/utils/search-access-context.js';
import { restrictedAccess } from '$lib/server/database/queries/builders/media-access-boundary.js';
import { resolveImageSets } from '$lib/server/services/image-descriptor/index.js';

import { checkMediaAccess } from '$lib/server/middleware/media-access.js';
import { resolveCatalogInternalId } from './resolve-id.js';
import { toMovieOrSeries } from '$lib/shared/media-type-domain';
import { getSimilarSourceMedia } from '$lib/server/caches/similar-source-media.js';
import type postgres from 'postgres';
import type { UserId } from '$lib/shared/user-id';

// ---------------------------------------------------------------------------
// Per-user rating enrichment
// ---------------------------------------------------------------------------

/**
 * Attach the requesting user's ratings to a (shared, user-agnostic) cached
 * body. Ratings are NEVER part of the cached payload: the response cache is
 * keyed by access context, not user, so a cached userRating would leak one
 * user's ratings into everyone else's modal. Always returns fresh objects —
 * the input may be the live L1 cache entry and must not be mutated.
 */
async function attachUserRatings(
    sql: postgres.Sql,
    body: SimilarResponse,
    userId: UserId | null,
): Promise<SimilarResponse> {
    if (!userId || body.similar.length === 0) return body;

    const mediaIds = body.similar
        .map((item) => item.ids?.internal)
        .filter((id): id is string => typeof id === 'string' && id.length > 0);
    if (mediaIds.length === 0) return body;

    const { getUserRatingsForMedia } =
        await import('$lib/server/database/queries/user-ratings.queries.js');
    const { unrestrictedAccess } =
        await import('$lib/server/database/queries/builders/media-access-boundary.js');
    // Deliberately unfiltered: `mediaIds` are drawn from `body.similar`, which is
    // an access-context-keyed cached payload — the boundary was already applied
    // upstream when that list was built. Re-filtering here would be redundant, and
    // this lookup only ever attaches the caller's OWN rating to ids they can
    // already see.
    const rows = await getUserRatingsForMedia.all(sql, {
        userId,
        mediaIds,
        access: unrestrictedAccess(),
    });
    const byMediaId = new Map(rows.map((r) => [r.media_id, r.rating]));

    return {
        ...body,
        similar: body.similar.map((item) => {
            const rating = item.ids?.internal ? byMediaId.get(item.ids.internal) : undefined;
            return { ...item, userRating: rating };
        }),
    };
}

/**
 * Per-user metadata-language overlay (multilingual-media-metadata spec §5).
 * Always returns a FRESH object graph — `body` may still be (or derive from)
 * the live L1 cache reference even after `attachUserRatings`, which itself
 * passes the original object through unmodified whenever there's nothing to
 * attach (`!userId || similar.length === 0`), so this clones `sourceMedia`
 * and every `similar[]` item before mutating, same rationale as
 * `attachUserRatings`'s own "always returns fresh objects" contract.
 * `sourceMedia` and every `similar[]` item are batched into ONE
 * `applyTranslationOverlay` call (at most 2 DB queries total) via a
 * discriminated wrapper, rather than one call per array.
 */
async function overlayLanguage(
    sql: postgres.Sql,
    body: SimilarResponse,
    userId: UserId | null,
): Promise<SimilarResponse> {
    if (!userId || config.METADATA_ADDITIONAL_LANGUAGES.length === 0) return body;

    const { resolveMetadataLanguage } =
        await import('$lib/server/utils/metadata-language-resolve.js');
    const { getPlaybackPreferences } =
        await import('$lib/server/database/queries/user-preferences.queries.js');
    const langs = resolveMetadataLanguage(await getPlaybackPreferences.one(sql, { userId }));
    if (!langs.titleLang && !langs.textLang) return body;

    const { applyTranslationOverlay } = await import('$lib/server/utils/translation-overlay.js');

    const sourceMedia = { ...body.sourceMedia };
    const similar = body.similar.map((item) => ({ ...item }));

    type OverlayTarget =
        | { kind: 'source'; ref: SimilarResponse['sourceMedia'] }
        | { kind: 'similar'; ref: SimilarResponse['similar'][number] };
    const targets: OverlayTarget[] = [
        { kind: 'source', ref: sourceMedia },
        ...similar.map((ref): OverlayTarget => ({ kind: 'similar', ref })),
    ];

    await applyTranslationOverlay(sql, targets, langs, {
        id: (t) => (t.kind === 'source' ? t.ref.id : (t.ref.ids?.internal ?? null)),
        setTitle: (t, v) => {
            t.ref.title = v;
        },
        setOverview: (t, v) => {
            if (t.kind === 'similar') t.ref.overview = v;
        },
    });

    return { ...body, sourceMedia, similar };
}

// ---------------------------------------------------------------------------
// Request schema
// ---------------------------------------------------------------------------

const SimilarQuery = z
    .object({
        limit: z.coerce.number().int().min(1).max(100).default(20),
        minSimilarity: z.coerce.number().min(0).max(1).default(0.5),
    })
    .merge(InheritQuerySchema);

// ---------------------------------------------------------------------------
// Response schema — fully typed
// ---------------------------------------------------------------------------

const SimilarMediaItemSchema = z.object({
    id: z.string(),
    type: z.enum(['movie', 'series']),
    ids: z.record(z.string(), z.string()),
    title: z.string(),
    year: z.number().int().optional(),
    overview: z.string().optional(),
    images: ImageSetSchema,
    similarity: z.number(),
    userRating: z.number().int().optional(),
    isAvailable: z.boolean(),
    canRequest: z.boolean(),
});

export const SimilarResponseSchema = z.object({
    sourceMedia: z.object({
        id: z.string(),
        type: z.enum(['movie', 'series']),
        ids: z.record(z.string(), z.string()),
        title: z.string(),
    }),
    similar: z.array(SimilarMediaItemSchema),
    count: z.number().int(),
});

export type SimilarResponse = z.infer<typeof SimilarResponseSchema>;

// ---------------------------------------------------------------------------
// def
// ---------------------------------------------------------------------------

export const def = defineEndpoint({
    auth: { kind: 'user' },
    visibility: 'internal',

    // Published v1 contract (the internal surface is not in any spec). Tags are
    // 'Media' on v1 (the internal sibling used 'Media Social'). limit/minSimilarity
    // come from `request.query` below (optional, server-side defaults).
    docs: {
        GET: {
            query: SimilarQuery,
            tags: ['Media'],
            summary: 'List titles similar to this one',
            stability: 'stable',
            auth: 'bearer',
            responses: {
                200: {
                    schema: boundedListEnvelope(MediaPreviewSchema),
                    description:
                        'Bounded MediaPreviews; score is similarity ranking and progress is PlaybackProgress',
                },
                401: 'Authentication required',
                500: 'Internal server error',
            },
        },
    },

    request: {
        query: SimilarQuery,
    },

    handlers: {
        GET: async (event, ctx) => {
            // Age-restricted profiles cannot access AI similar content
            if (event.locals.user?.isAgeRestricted) {
                return ApiProblem.forbidden(
                    'AI features are not available for age-restricted profiles',
                );
            }

            const sql = getDb();
            if (!sql) return ApiProblem.dependencyUnavailable('Database is not available');

            const internalId = await resolveCatalogInternalId(event);
            if (!internalId) return ApiProblem.notFound('Media not found');

            // Library + age gate
            if (!(await checkMediaAccess(sql, internalId, event.locals.user))) {
                return ApiProblem.notFound('Media not found');
            }

            const { cacheManager, CACHE_NAMESPACES } = await import('$lib/server/cache/index.js');
            const cache = cacheManager.for(CACHE_NAMESPACES.similarModalContent);
            const accessCtx = await buildSearchAccessContext(sql, event.locals.user);

            const limit =
                (ctx.input?.query as { limit: number; minSimilarity: number } | undefined)?.limit ??
                20;
            const minSimilarity =
                (ctx.input?.query as { limit: number; minSimilarity: number } | undefined)
                    ?.minSimilarity ?? 0.5;

            const cacheKey = scopedCacheKey(
                `v14:${internalId}:${limit}:${minSimilarity}`,
                accessCtx,
            );
            const ratingsUserId = event.locals.user?.userId ?? null;

            // Cached bodies are user-AGNOSTIC (no userRating) — ratings are
            // attached per-request below so the access-scoped (not user-scoped)
            // key can never leak one user's ratings into another's response.
            const cached = await cache.get<z.infer<typeof SimilarResponseSchema>>(cacheKey);
            if (cached) {
                const withRatings = await attachUserRatings(sql, cached, ratingsUserId);
                const localized = await overlayLanguage(sql, withRatings, ratingsUserId);
                return json({
                    items: await buildMediaPreviews(
                        sql,
                        ctx.surface,
                        localized.similar.slice(0, limit).map((item) => ({
                            ...item,
                            score: item.similarity,
                        })),
                        event.locals.user.userId,
                    ),
                    truncated: localized.count > limit,
                });
            }

            const surface = ctx.surface;

            const sourceMedia = await getSimilarSourceMedia(sql, internalId);
            if (!sourceMedia) return ApiProblem.notFound('Media not found');

            // getSimilarSourceMedia reads `mi.media_type` with no type
            // restriction at all, so a resolved id can genuinely be an
            // audiobook, a track, or any other non-catalog type. This
            // endpoint's response schema (and the downstream
            // findSimilarMediaDual query, keyed off sourceType) only knows
            // movie/series — treat "neither" the same as "not found" instead
            // of relabelling it.
            const sourceType = toMovieOrSeries(sourceMedia.media_type);
            if (!sourceType) return ApiProblem.notFound('Media not found');
            const sourceIds: Record<string, string> = { internal: internalId };
            if (sourceMedia.primary_ext_id) {
                sourceIds[getPrimaryExternalIdProvider()] = sourceMedia.primary_ext_id;
            }

            if (!sourceMedia.embedding) {
                return json({ items: [], truncated: false });
            }
            const embedding = sourceMedia.embedding;

            const computeBody = async (): Promise<z.infer<typeof SimilarResponseSchema>> => {
                const { findSimilarMediaDual } =
                    await import('$lib/server/database/queries/suggestion-search.queries.js');
                const similar = await findSimilarMediaDual(sql, embedding, {
                    limit: limit * 2,
                    mediaTypes: [sourceType === 'series' ? 'tv' : 'movie'],
                    // Library axis from the real user. Age axis deliberately
                    // `any`: this call has never applied an age predicate, and
                    // turning one on here would change which rows an
                    // age-limited caller sees — a behaviour change that belongs
                    // in its own commit, not in the boundary reshape. Two things
                    // hold the line meanwhile: the handler already 403s
                    // age-restricted profiles above, and `cacheKey` is built
                    // with `scopedCacheKey(..., accessCtx)`, whose suffix
                    // includes the age dimension, so entries never cross age
                    // boundaries. Built directly from the context's real values
                    // so the mapping is provably the one the old pair encoded.
                    access: restrictedAccess({
                        deniedGroupIds: accessCtx.deniedGroupIds ?? [],
                        maxAgeRating: null,
                        allowUnrated: false,
                    }),
                    // Response-shaping only — skip the provider_metadata JSONB
                    // detoast; genres/actors/etc. aren't part of this response.
                    lean: true,
                    // File-less candidates are discovery/request items: they only
                    // surface when the operator enabled unavailable titles (the
                    // access context's `showUnavailableMedia`, also part of the
                    // cache key via its `lib-only` suffix). Filtered in the query
                    // so `limit` applies to available rows.
                    availableOnly: !accessCtx.showUnavailableMedia,
                });

                // Deduplicate by primary_ext_id + media_type
                const seen = new Set<string>();
                const deduplicated = [];
                for (const item of similar) {
                    const key = `${item.primary_ext_id}:${item.media_type}`;
                    if (!seen.has(key)) {
                        seen.add(key);
                        deduplicated.push(item);
                    }
                }

                const filtered = deduplicated
                    // Never the seed itself: by its own id, or by its provider id when both
                    // sides have one (an item without a provider id must not match another).
                    .filter((item) => {
                        const { media_uuid } = item as typeof item & { media_uuid?: string };
                        if (media_uuid && media_uuid.toLowerCase() === internalId.toLowerCase())
                            return false;
                        return !(
                            item.primary_ext_id != null &&
                            item.primary_ext_id === sourceMedia.primary_ext_id &&
                            item.media_type === sourceMedia.media_type
                        );
                    })
                    .filter((item) => (item.combined_score || 0) >= minSimilarity)
                    .slice(0, limit + 1);

                const imageSets = await resolveImageSets(
                    sql,
                    surface,
                    filtered.flatMap((item) => {
                        const { media_uuid } = item as typeof item & { media_uuid?: string };
                        return media_uuid ? [{ id: media_uuid, mediaType: item.media_type }] : [];
                    }),
                    ctx.input?.query?.inherit === 'none' ? { inherit: 'none' } : undefined,
                );

                const items: z.infer<typeof SimilarMediaItemSchema>[] = filtered.flatMap((item) => {
                    const itemWithUuid = item as typeof item & { media_uuid?: string };
                    const itemType = toMovieOrSeries(item.media_type);
                    if (!itemType) return [];
                    const itemId =
                        itemWithUuid.media_uuid ||
                        `${getPrimaryExternalIdProvider()}:${item.primary_ext_id}:${itemType}`;

                    const primaryProvider = getPrimaryExternalIdProvider();
                    const baseIds = createExternalIds({
                        internal: itemWithUuid.media_uuid,
                        [primaryProvider]: item.primary_ext_id ?? undefined,
                    } as Parameters<typeof createExternalIds>[0]);
                    const ids = baseIds as Record<string, string>;

                    return [{
                        id: itemId,
                        type: itemType,
                        ids,
                        title: item.title ?? 'Unknown',
                        year: item.release_year ?? undefined,
                        overview: item.overview ?? undefined,
                        images: imageSets.get(itemId) ?? {},
                        similarity: item.combined_score || 0,
                        isAvailable: item.is_available,
                        canRequest: item.can_request,
                    }];
                });

                return {
                    sourceMedia: {
                        id: internalId,
                        type: sourceType,
                        ids: sourceIds,
                        title: sourceMedia.title,
                    },
                    similar: items,
                    count: items.length,
                };
            };

            // Single-flight the ANN computation: a popular title whose cache
            // entry just expired would otherwise run the full two-phase HNSW
            // query once per concurrent modal open until the first write lands.
            const { getOrComputeSingleFlight } = await import('$lib/server/cache/single-flight.js');
            // When THIS request is the single-flight leader, keep the computed
            // object and skip re-parsing the string bridge — only followers
            // (who got the leader's cached string) pay the JSON.parse.
            let leaderBody: z.infer<typeof SimilarResponseSchema> | null = null;
            const raw = await getOrComputeSingleFlight({
                cacheKey: `${CACHE_NAMESPACES.similarModalContent.name}:sf:${cacheKey}`,
                // Short bridge only — the unified cache above is the real store.
                ttlSeconds: 60,
                lockTtlSeconds: 15,
                compute: async () => {
                    const computed = await computeBody();
                    leaderBody = computed;
                    // Accepted race: an invalidateMedia() landing between our
                    // embedding snapshot and this set can be overwritten by a
                    // stale body. The window is one compute (~100s of ms; lock
                    // TTL bounds it at 15 s) and the payload is a similarity
                    // list, where brief staleness is harmless — versioned keys
                    // would cost more than they buy here.
                    await cache.set(cacheKey, computed);
                    return JSON.stringify(computed);
                },
            });
            const body = leaderBody ?? (JSON.parse(raw) as z.infer<typeof SimilarResponseSchema>);

            const withRatings = await attachUserRatings(sql, body, ratingsUserId);
            const localized = await overlayLanguage(sql, withRatings, ratingsUserId);
            return json({
                items: await buildMediaPreviews(
                    sql,
                    ctx.surface,
                    localized.similar.slice(0, limit).map((item) => ({
                        ...item,
                        score: item.similarity,
                    })),
                    event.locals.user.userId,
                ),
                truncated: localized.count > limit,
            });
        },
    },
});
