// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * GET /api/for-you/similar
 *
 * Similar content based on a source media item ("Because you watched X").
 *
 * Response: paginate(RecommendationItem[], page) + source metadata bare object
 *
 * Migrated to the new contract:
 * - paginate() for the similar items collection
 * - images{} hrefs (not flat posterUrl)
 * - canonical type: 'series' (not 'tv')
 * - 503 when DB/AI unavailable
 * - No success wrapper
 */

import { json } from '@sveltejs/kit';
import { z } from 'zod';
import { defineEndpoint } from '$lib/server/api/define.js';
import { paginate, ApiProblem } from '$lib/server/api/problem.js';
import { mapBatch, hydrateRailMetadata } from './item-mapper.js';
import { toMovieOrSeries } from '$lib/shared/media-type-domain';

const QuerySchema = z.object({
    key: z.string(),
    limit: z.coerce.number().int().min(1).max(20).optional().default(8),
    title: z.string().optional(),
    available: z.string().optional(),
    // Dismiss steering is ON by default; only an explicit `off`/`false` bypasses
    // it (dismissed items are still excluded regardless — see the def handler).
    steering: z
        .string()
        .optional()
        .transform((v) => v !== 'off' && v !== 'false'),
    beta: z.coerce.number().min(0).max(1).optional().default(0.3),
    watched: z.string().optional(),
});

export const def = defineEndpoint({
    auth: { kind: 'user' },
    visibility: 'internal',
    request: { query: QuerySchema },
    handlers: {
        GET: async (event, ctx) => {
            const raw = {
                key: event.url.searchParams.get('key') ?? undefined,
                limit: event.url.searchParams.get('limit') ?? undefined,
                title: event.url.searchParams.get('title') ?? undefined,
                available: event.url.searchParams.get('available') ?? undefined,
                steering: event.url.searchParams.get('steering') ?? undefined,
                beta: event.url.searchParams.get('beta') ?? undefined,
                watched: event.url.searchParams.get('watched') ?? undefined,
            };
            const parsed = QuerySchema.safeParse(raw);
            if (!parsed.success) {
                return ApiProblem.validationFailed(
                    parsed.error.issues.map((e) => ({
                        field: e.path.join('.'),
                        message: e.message,
                    })),
                );
            }
            const {
                key,
                limit,
                title,
                available,
                watched: watchedParam,
                steering,
                beta,
            } = parsed.data;

            if (!key) return ApiProblem.validationFailed([{ field: 'key', message: 'Required' }]);

            // Age-restricted profiles cannot access AI-powered similar recommendations
            if (event.locals.user?.isAgeRestricted) {
                return ApiProblem.forbidden(
                    'AI features are not available for age-restricted profiles',
                );
            }

            const { parseMediaId, validateParsedMediaId } =
                await import('$lib/server/utils/media-key-parser.js');
            const parsed2 = parseMediaId(key);
            if (!validateParsedMediaId(parsed2)) {
                return ApiProblem.validationFailed([
                    {
                        field: 'key',
                        message: 'Invalid key format. Expected UUID or provider:id:mediaType',
                    },
                ]);
            }

            const { getDb } = await import('$lib/server/database/index.js');
            const { config } = await import('$lib/server/config.js');
            const { getEffectiveUser } = await import('$lib/server/dev-user.js');
            const { getUserIdByUsername } =
                await import('$lib/server/database/queries/users.queries.js');
            const { fetchSimilarMedia, toSimilarMediaAccess } =
                await import('$lib/server/services/for-you.service.js');
            const { getExternalIdFor, createExternalIds } =
                await import('$lib/utils/external-ids.js');
            const { getDismissService } = await import('$lib/server/services/dismiss.service.js');
            const { getPrimaryExternalIdProvider } =
                await import('$lib/server/utils/provider-config.js');
            const { aiDbService } = await import('$lib/server/services/database.service.js');
            const { providerResolutionService } =
                await import('$lib/server/services/provider-resolution.service.js');
            const { resolveUuidToProvider } =
                await import('$lib/server/database/queries/embedding-similarity.queries.js');
            const { isMovie, isSeries } = await import('$lib/server/utils/media-types.js');
            const { cacheManager, CACHE_NAMESPACES, buildVersionedCacheKey } =
                await import('$lib/server/cache/index.js');
            const { buildSearchAccessContext, scopedCacheKey } =
                await import('$lib/server/utils/search-access-context.js');
            const { getUserWatchedItems } = await import('$lib/server/utils/user-watch-history.js');
            const { filterItemsByAvailability } =
                await import('$lib/server/utils/availability-filter.js');
            const db = getDb();
            if (!db) return ApiProblem.dependencyUnavailable('Database not available');

            const effectiveUsername = getEffectiveUser(
                event.request,
                event.locals.user?.username || config.DEFAULT_USER,
            );
            const effectiveUserId = await getUserIdByUsername(db, effectiveUsername);
            if (!effectiveUserId) {
                return json(paginate([], { limit, offset: 0, hasMore: false }));
            }

            let mediaType: 'movie' | 'tv';
            let externalIds: Record<string, string | number | null>;
            let tmdbId: number;

            if (parsed2.type === 'uuid') {
                const sql = await aiDbService.getSql();
                if (!sql) return ApiProblem.dependencyUnavailable('AI database not available');
                const resolved = await resolveUuidToProvider(sql, parsed2.uuid!);
                if (!resolved) return ApiProblem.notFound('Media not found');
                // Seed resolution has no library/age gate of its own (see the
                // sibling doc-comment on getSourceEmbedding) — resolveUuidToProvider
                // is a raw lookup by internal id with no relation to the caller.
                // Without this, a caller holding an out-of-band UUID for an item
                // they're denied (library-restricted, or above their age ceiling)
                // could confirm it exists and learn its TMDB id and media type.
                // Gate here, before any of that reaches the response, and 404
                // with the exact same body as the not-found case above so a
                // denied id and an unknown id are indistinguishable. Gate on
                // `sql` — the SAME handle `resolveUuidToProvider` just resolved
                // the id with, not the separate `db` (web pool) handle used
                // elsewhere in this file. They point at the same database
                // today, but if the AI pool is ever repointed, gating on a
                // different connection than the one that resolved the id would
                // run the check where the id may not exist at all — and
                // checkMediaAccess passes VACUOUSLY for an unknown id (see
                // isMediaAccessible's NOT EXISTS fail-open), turning a silent
                // misconfiguration into a silent access-check bypass.
                const { checkMediaAccess } = await import('$lib/server/middleware/media-access.js');
                if (!(await checkMediaAccess(sql, parsed2.uuid!, event.locals.user))) {
                    return ApiProblem.notFound('Media not found');
                }
                const resolvedMediaType = resolved.media_type.toLowerCase();
                if (!isMovie(resolvedMediaType) && !isSeries(resolvedMediaType)) {
                    return ApiProblem.validationFailed([
                        { field: 'key', message: 'Invalid media type' },
                    ]);
                }
                // Normalise, don't assert: isSeries() accepts 'series' as well as
                // 'tv', so the guard above passes for either and a bare cast
                // would carry 'series' through under the 'tv' type.
                mediaType = isMovie(resolvedMediaType) ? 'movie' : 'tv';
                tmdbId = parseInt(resolved.tmdb_id, 10);
                externalIds = {
                    internal: parsed2.uuid!,
                    [getPrimaryExternalIdProvider()]: resolved.tmdb_id,
                };
                if (isNaN(tmdbId) || tmdbId <= 0) {
                    return ApiProblem.validationFailed([
                        { field: 'key', message: 'No TMDB ID for this item' },
                    ]);
                }
            } else {
                if (
                    !parsed2.mediaType ||
                    (!isMovie(parsed2.mediaType) && !isSeries(parsed2.mediaType))
                ) {
                    return ApiProblem.validationFailed([
                        { field: 'key', message: 'Invalid media type' },
                    ]);
                }
                // Same normalisation as the UUID branch above — the guard admits
                // both naming conventions, so pick the canonical token here.
                mediaType = isMovie(parsed2.mediaType) ? 'movie' : 'tv';
                externalIds = { [parsed2.provider!]: parsed2.externalId! };
                const resolution = await providerResolutionService.resolveToTmdb(
                    externalIds as Record<string, string>,
                    mediaType,
                );
                if (!resolution.success) {
                    return ApiProblem.notFound(`Cannot find similar content: ${resolution.error}`);
                }
                tmdbId = resolution.tmdbId;
            }

            const availableOnly = available === 'true';
            const accessCtx = await buildSearchAccessContext(db, event.locals.user);

            const mediaKey = `tmdb:${tmdbId}:${mediaType}`;

            // Server-side watched history → composite `(id, mediaType)` exclusion
            // applied IN-QUERY via fetchSimilarMedia's `watchedItems` param. This
            // replaces the old bare-TMDB-id post-filter, which cross-suppressed the
            // other media type on id collision (e.g. tmdb 1429 = a movie AND a tv
            // show) and was capped at 500. The mapped items are already primary
            // (tmdb) ids, so fetchSimilarMedia's internal resolveToTmdb is a no-op.
            const serverWatchedItems = effectiveUsername
                ? (await getUserWatchedItems(effectiveUsername, 500)).map((w) => ({
                      externalIds: createExternalIds({
                          [getPrimaryExternalIdProvider()]: w.primary_ext_id,
                      }),
                      mediaType: w.media_type,
                  }))
                : [];

            // The explicit `watched=` query param is a client-supplied set of bare
            // TMDB ids (e.g. optimistic just-watched ids not yet in server history).
            // Keep a thin post-filter for it, but make it composite `(id, mediaType)`
            // using THIS seed's media type so it cannot collide across media types.
            const clientWatchedComposite = new Set(
                (watchedParam
                    ? watchedParam
                          .split(',')
                          .map((id) => id.trim())
                          .filter((id) => id.length > 0)
                    : []
                ).map((id) => `${id}:${mediaType}`),
            );

            // Dismiss state folds into the cache key so a fresh dismissal (or a
            // steering/beta change) invalidates immediately.
            const dismissService = getDismissService(db);
            const dismissHash = await dismissService.getDismissHash(effectiveUserId, mediaKey);
            const dismissKeyPart = dismissHash
                ? `:${dismissHash}${steering ? `:b${beta}` : ':nos'}`
                : '';

            const CACHE_FETCH_SIZE = 20;
            // User-scoped: fetchSimilarMedia bakes the requesting user's dislikes,
            // watched history and stem/genre penalties into the SQL ranking, so a
            // key scoped only by access context would pin the first user's
            // taste-shaped result for everyone in the same scope (and leak their
            // taste profile). v7: watched exclusion moved in-query (composite) +
            // dismiss steering. v8: per-availability-class SQL window upstream
            // changed the rail's availability composition. NOTE
            // staleness tradeoff: the watched set is now
            // baked into the cached result, so a title the user watches mid-session
            // keeps showing until this entry's short similarContent TTL (5m/15m)
            // expires — an acceptable bound for a "Because you watched" rail.
            const cacheKey = scopedCacheKey(
                buildVersionedCacheKey(
                    'similarContent',
                    `${mediaKey}:u=${effectiveUserId}:v8${dismissKeyPart}`,
                ),
                accessCtx,
            );
            const similarCache = cacheManager.for(CACHE_NAMESPACES.similarContent);

            let similar =
                await similarCache.get<Awaited<ReturnType<typeof fetchSimilarMedia>>>(cacheKey);
            if (!similar) {
                similar = await fetchSimilarMedia(
                    db,
                    externalIds as Record<string, string>,
                    mediaType,
                    CACHE_FETCH_SIZE,
                    effectiveUserId,
                    serverWatchedItems,
                    toSimilarMediaAccess(accessCtx),
                    { steering, beta },
                );
                await similarCache.set(cacheKey, similar);
            }

            if (clientWatchedComposite.size > 0) {
                similar = similar.filter(
                    (item) =>
                        !clientWatchedComposite.has(
                            `${getExternalIdFor(item.externalIds, 'tmdb') || ''}:${item.mediaType}`,
                        ),
                );
            }

            if (!accessCtx.showUnavailableMedia) {
                similar = similar.filter((item) => item.isAvailable);
            }

            if (availableOnly) {
                similar = filterItemsByAvailability(similar);
            }

            const { items, hasMore } = mapBatch(
                similar as Array<{
                    externalIds: (typeof similar)[0]['externalIds'];
                    mediaType: string;
                    title: string;
                    rating: number;
                    year?: number | null;
                    isAvailable?: boolean;
                    canRequest?: boolean;
                    similarity?: number;
                }>,
                limit,
                'similar',
                ctx.surface,
                (item) =>
                    item.similarity != null ? Math.min(item.similarity / 100, 1) : undefined,
            );
            await hydrateRailMetadata(db, items);

            // Per-user metadata-language overlay (multilingual-media-metadata spec
            // §5): resolved once per request, applied AFTER the cache read/write
            // above (so the shared similarContent cache stays language-neutral).
            const overlayUserId = event.locals.user?.userId;
            const { config: overlayConfig } = await import('$lib/server/config.js');
            if (overlayUserId && overlayConfig.METADATA_ADDITIONAL_LANGUAGES.length > 0) {
                const { resolveMetadataLanguage } =
                    await import('$lib/server/utils/metadata-language-resolve.js');
                const { getPlaybackPreferences } =
                    await import('$lib/server/database/queries/user-preferences.queries.js');
                const langs = resolveMetadataLanguage(
                    await getPlaybackPreferences.one(db, { userId: overlayUserId }),
                );
                if (langs.titleLang || langs.textLang) {
                    const { applyTranslationOverlay } =
                        await import('$lib/server/utils/translation-overlay.js');
                    await applyTranslationOverlay(db, items, langs, {
                        id: (it) => it.media.id || null,
                        setTitle: (it, v) => {
                            it.media.title = v;
                        },
                        setOverview: (it, v) => {
                            it.media.overview = v;
                        },
                    });
                }
            }

            // Include the seed source metadata in the response alongside the paginated items
            const sourceInfo = {
                id: getExternalIdFor(externalIds as Record<string, string>, 'internal') ?? null,
                title: title ?? null,
                // `mediaType` is declared `'movie' | 'tv'` above (the isMovie/
                // isSeries guards on both resolution branches admit no other
                // value) — this can never be anything else.
                // eslint-disable-next-line callback-safety/no-inline-media-type-default -- similar-media queries are movie/TV-only.
                type: toMovieOrSeries(mediaType) ?? 'movie',
                ids: Object.fromEntries(
                    Object.entries(externalIds)
                        .filter(([, v]) => v != null)
                        .map(([k, v]) => [k, String(v)]),
                ),
            };

            return json({
                source: sourceInfo,
                ...paginate(items, { limit, offset: 0, hasMore }),
            });
        },
    },
});
