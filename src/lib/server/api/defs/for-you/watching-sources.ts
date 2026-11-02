// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * GET /api/for-you/watching/sources
 *
 * Recently watched movies/shows used as "Because you watched X" seeds.
 * Returns a bare object: { sources: WatchingSource[], secondBecauseSource: WatchingSource | null }
 *
 * Migrated to the new contract:
 * - No success wrapper
 * - images{} hrefs (not flat posterUrl)
 * - canonical type 'series' (not 'tv')
 * - 503 when DB unavailable (no silent empty fallback)
 */

import { batchGetAvailability } from '$lib/server/database/queries/availability.queries.js';
import { json } from '@sveltejs/kit';
import { z } from 'zod';
import { defineEndpoint } from '$lib/server/api/define.js';
import { ApiProblem } from '$lib/server/api/problem.js';
import { entityImageUrl } from '$lib/shared/api-urls.js';

const QuerySchema = z.object({
    limit: z.coerce.number().int().min(1).max(20).optional().default(3),
    secondBecauseSection: z
        .string()
        .optional()
        .transform((v) => v !== 'false'),
});

/** Canonical source shape with images{} hrefs. */
const WatchingSourceSchema = z.object({
    /** Internal UUID (may be null if only Sonarr/TMDB data is available). */
    id: z.string().nullable(),
    title: z.string(),
    /** Canonical type: 'movie' | 'series'. */
    type: z.enum(['movie', 'series']),
    /** Self-describing image hrefs. */
    images: z
        .object({
            poster: z.object({ href: z.string() }),
            thumb: z.object({ href: z.string() }),
        })
        .optional(),
    /** Provider ID map. */
    ids: z.record(z.string(), z.string()),
    lastWatched: z.string().optional(),
    /**
     * Why this seed was selected. 'watched' = the user actually watched this
     * title. 'popular' = a fallback substitute (a popular library title the
     * user did NOT watch), used only when no genuine watched seed of the
     * needed media type is available.
     */
    reason: z.enum(['watched', 'popular']).optional(),
});

export const def = defineEndpoint({
    auth: { kind: 'user' },
    visibility: 'internal',
    request: { query: QuerySchema },
    handlers: {
        GET: async (event, ctx) => {
            const raw = {
                limit: event.url.searchParams.get('limit') ?? undefined,
                secondBecauseSection:
                    event.url.searchParams.get('secondBecauseSection') ?? undefined,
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
            const { limit, secondBecauseSection } = parsed.data;

            const { config } = await import('$lib/server/config.js');
            const { isFeedKindHidden } = await import('$lib/server/utils/feed-prefs-gate.js');

            // Per-user feed preference gate
            if (await isFeedKindHidden(event.locals, 'because-you-watched')) {
                return json({ sources: [], secondBecauseSource: null });
            }

            const { getDb } = await import('$lib/server/database/connection.js');
            const dbSql = getDb();
            if (!dbSql) return ApiProblem.dependencyUnavailable('Database not available');
            // Re-bind to a non-nullable const: closures below (overlaySources) capture
            // this and TS does not retain the null-check narrowing of `dbSql`
            // across a nested function declaration.
            const sql = dbSql;

            const { getEffectiveUser } = await import('$lib/server/dev-user.js');
            const { getUserIdByUsername } =
                await import('$lib/server/database/queries/users.queries.js');
            const { getExternalIdFor } = await import('$lib/utils/external-ids.js');
            const { createExternalIdsFromProvider } =
                await import('$lib/utils/media-id-helpers.js');
            const { getPrimaryExternalIdProvider } =
                await import('$lib/server/utils/provider-config.js');
            const {
                getRecentWatchedMoviesWithEmbeddings,
                getRecentWatchedTvWithEmbeddings,
                getRandomPopularItem,
            } = await import('$lib/server/database/queries/index.js');
            const { filterAccessibleRows, unrestrictedAccess } =
                await import('$lib/server/utils/media-access-batch.js');
            const { buildSearchAccessContext, scopedCacheKey, searchAccessBoundary } =
                await import('$lib/server/utils/search-access-context.js');
            const { cacheManager, CACHE_NAMESPACES } = await import('$lib/server/cache/index.js');
            const { isMovie, isSeries, toMovieOrSeries } =
                await import('$lib/server/utils/media-types.js');
            const { seededShuffle, hashSeed } = await import('$lib/server/utils/diversify-rank.js');

            const effectiveUsername = getEffectiveUser(
                event.request,
                event.locals.user?.username || config.DEFAULT_USER,
            );

            const accessCtx = await buildSearchAccessContext(sql, event.locals.user);
            const effectiveUserId = await getUserIdByUsername(sql, effectiveUsername);
            if (!effectiveUserId) return json({ sources: [], secondBecauseSource: null });

            const secondBecauseSectionEnabled =
                secondBecauseSection && config.FORYOU_SECOND_BECAUSE_SECTION;

            const sourcesCache = cacheManager.for(CACHE_NAMESPACES.watchingSources);
            const cacheKey = scopedCacheKey(
                `watching-sources:v2:${effectiveUserId}:${limit}:${secondBecauseSectionEnabled ? '1' : '0'}`,
                accessCtx,
            );

            type CachedResponse = {
                sources: z.infer<typeof WatchingSourceSchema>[];
                secondBecauseSource: z.infer<typeof WatchingSourceSchema> | null;
            };

            // Per-user metadata-language overlay (multilingual-media-metadata spec
            // §5): resolved once per request, applied AFTER every cache read/write
            // path below. UnifiedCache L1 returns/stores the LIVE object
            // reference (the cache-hit payload AND the just-`set` payload are
            // both the cached object itself), so the overlay must run on
            // shallow CLONES — mutating in place would drift the cached entry
            // localized (stale foreign titles for a user who switches back to
            // the primary language, until TTL).
            const overlayUserId = event.locals.user?.userId;
            async function overlaySources(payload: CachedResponse): Promise<CachedResponse> {
                if (!accessCtx.showUnavailableMedia) {
                    const all = payload.secondBecauseSource
                        ? [...payload.sources, payload.secondBecauseSource]
                        : payload.sources;
                    const availability = await batchGetAvailability(
                        sql,
                        all.flatMap((source) => (source.id ? [source.id] : [])),
                    );
                    payload = {
                        sources: payload.sources.filter(
                            (source) => source.id && availability.get(source.id),
                        ),
                        secondBecauseSource:
                            payload.secondBecauseSource?.id &&
                            availability.get(payload.secondBecauseSource.id)
                                ? payload.secondBecauseSource
                                : null,
                    };
                }
                if (!overlayUserId || config.METADATA_ADDITIONAL_LANGUAGES.length === 0)
                    return payload;
                const { resolveMetadataLanguage } =
                    await import('$lib/server/utils/metadata-language-resolve.js');
                const { getPlaybackPreferences } =
                    await import('$lib/server/database/queries/user-preferences.queries.js');
                const langs = resolveMetadataLanguage(
                    await getPlaybackPreferences.one(sql, { userId: overlayUserId }),
                );
                if (!langs.titleLang && !langs.textLang) return payload;
                const { applyTranslationOverlay } =
                    await import('$lib/server/utils/translation-overlay.js');
                const localized: CachedResponse = {
                    sources: payload.sources.map((s) => ({ ...s })),
                    secondBecauseSource: payload.secondBecauseSource
                        ? { ...payload.secondBecauseSource }
                        : null,
                };
                const allSources = localized.secondBecauseSource
                    ? [...localized.sources, localized.secondBecauseSource]
                    : localized.sources;
                await applyTranslationOverlay(sql, allSources, langs, {
                    id: (it) => it.id,
                    setTitle: (it, v) => {
                        it.title = v;
                    },
                });
                return localized;
            }

            const cachedResult = await sourcesCache.get<CachedResponse>(cacheKey);
            if (cachedResult) {
                return json(await overlaySources(cachedResult));
            }

            type SourceRow = {
                tmdb_id: string;
                media_type: string;
                title: string;
                watched_at: Date;
                media_id: string;
            };

            // The boundary is enforced one layer down, by filterAccessibleRows
            // below, NOT here — so these two reads are explicitly unrestricted.
            //
            // This reads like a fail-open and is not one: the queries fetch
            // `limit * 2` rows and the filter runs after, which is a deliberate
            // over-fetch so a restricted user still has candidates left. Moving
            // the predicate INTO the queries would be strictly better ordering
            // (filter-before-limit), but it changes how many sources a restricted
            // user ends up with — a behaviour change this migration must not make.
            // Do not "fix" this by threading `boundary` in without also handling
            // the LIMIT.
            const unfilteredAtQueryLayer = unrestrictedAccess();
            const [moviesResult, tvResult] = await Promise.all([
                getRecentWatchedMoviesWithEmbeddings.all(sql, {
                    userId: effectiveUserId,
                    limit: limit * 2,
                    access: unfilteredAtQueryLayer,
                }),
                getRecentWatchedTvWithEmbeddings.all(sql, {
                    userId: effectiveUserId,
                    limit: limit * 2,
                    access: unfilteredAtQueryLayer,
                }),
            ]);

            type SourceRowWithId = SourceRow & { id: string };
            const moviesWithId = (moviesResult as SourceRow[]).map((r) => ({
                ...r,
                id: r.media_id,
            }));
            const tvWithId = (tvResult as SourceRow[]).map((r) => ({ ...r, id: r.media_id }));
            // The real enforcement point for both reads above.
            //
            // Passing a boundary rather than the legacy `{deniedGroupIds, ageRating}`
            // pair also skips filterAccessibleMediaIds' incidental media_items
            // existence check for unrestricted callers. That is a no-op here: both
            // source queries INNER JOIN media_items, so every row already has a
            // live media_items row and none can be dangling.
            const sourcesBoundary = searchAccessBoundary(accessCtx);
            const [filteredMovies, filteredTv] = await Promise.all([
                filterAccessibleRows(sql, moviesWithId as SourceRowWithId[], sourcesBoundary),
                filterAccessibleRows(sql, tvWithId as SourceRowWithId[], sourcesBoundary),
            ]);

            const availability = accessCtx.showUnavailableMedia
                ? null
                : await batchGetAvailability(
                      sql,
                      [...filteredMovies, ...filteredTv].map((row) => row.media_id),
                  );
            const movies = (filteredMovies as SourceRow[]).filter(
                (row) => !availability || availability.get(row.media_id),
            );
            const tvShows = (filteredTv as SourceRow[]).filter(
                (row) => !availability || availability.get(row.media_id),
            );

            // Deterministic per-(user, day) shuffle — stable within a day, rotates
            // across days. Matches the seeded-shuffle convention used elsewhere in
            // the for-you pipeline (see suggestion-engine.service.ts).
            const dateBucket = Math.floor(Date.now() / 86_400_000);
            const shuffledMovies = seededShuffle(
                movies,
                hashSeed(`${effectiveUserId}:${dateBucket}:movies`),
            );
            const shuffledTv = seededShuffle(
                tvShows,
                hashSeed(`${effectiveUserId}:${dateBucket}:tv`),
            );

            let selected: SourceRow[] = [];
            if (movies.length > 0 && tvShows.length > 0) {
                selected.push(shuffledMovies[0]);
                selected.push(shuffledTv[0]);
                const remaining = seededShuffle(
                    [...shuffledMovies.slice(1), ...shuffledTv.slice(1)],
                    hashSeed(`${effectiveUserId}:${dateBucket}:remaining`),
                );
                for (const item of remaining) {
                    if (selected.length >= limit) break;
                    selected.push(item);
                }
            } else {
                selected = [...shuffledMovies, ...shuffledTv].slice(0, limit);
            }

            const surface = ctx.surface;

            function rowToSource(
                s: SourceRow,
                reason: 'watched' | 'popular' = 'watched',
            ): z.infer<typeof WatchingSourceSchema> {
                const extIds = {
                    ...createExternalIdsFromProvider(getPrimaryExternalIdProvider(), s.tmdb_id),
                    ...(s.media_id ? { internal: s.media_id } : {}),
                };
                const internalId = getExternalIdFor(extIds, 'internal');
                const ids: Record<string, string> = {};
                for (const [k, v] of Object.entries(extIds)) {
                    if (v != null) ids[k] = String(v);
                }
                // getRecentWatchedMoviesWithEmbeddings / …TvWithEmbeddings each
                // hardcode `mi.media_type = 'movie'` / `= 'tv'` respectively —
                // `s.media_type` can never be anything else.
                // eslint-disable-next-line callback-safety/no-inline-media-type-default -- this query is movie/TV-only.
                const canonicalType = toMovieOrSeries(s.media_type) ?? 'movie';
                return WatchingSourceSchema.parse({
                    id: internalId ?? null,
                    title: s.title,
                    type: canonicalType,
                    ...(internalId
                        ? {
                              images: {
                                  poster: {
                                      href: entityImageUrl(internalId, 'poster', surface),
                                  },
                                  thumb: { href: entityImageUrl(internalId, 'thumb', surface) },
                              },
                          }
                        : {}),
                    ids,
                    reason,
                });
            }

            const sources = selected.map((s) => rowToSource(s));

            let secondBecauseSource: z.infer<typeof WatchingSourceSchema> | null = null;
            if (secondBecauseSectionEnabled && sources.length > 0) {
                const movieCount = selected.filter((s) => isMovie(s.media_type)).length;
                const tvCount = selected.filter((s) => isSeries(s.media_type)).length;
                const minorityType = movieCount <= tvCount ? 'movie' : 'tv';
                const selectedIds = new Set(selected.map((s) => s.tmdb_id));
                const pool = minorityType === 'movie' ? shuffledMovies : shuffledTv;
                const available = pool.filter((s) => !selectedIds.has(s.tmdb_id));

                if (available.length > 0) {
                    // Genuine unselected recently-watched item of the minority type —
                    // still a real "because you watched" seed.
                    secondBecauseSource = rowToSource(available[0], 'watched');
                } else {
                    const popularItem = await getRandomPopularItem(
                        sql,
                        minorityType,
                        searchAccessBoundary(accessCtx),
                    );
                    if (popularItem) {
                        const extIds = {
                            ...createExternalIdsFromProvider(
                                getPrimaryExternalIdProvider(),
                                popularItem.primary_ext_id,
                            ),
                            ...(popularItem.internal_id
                                ? { internal: popularItem.internal_id }
                                : {}),
                        };
                        const internalId = popularItem.internal_id;
                        const ids: Record<string, string> = {};
                        for (const [k, v] of Object.entries(extIds)) {
                            if (v != null) ids[k] = String(v);
                        }
                        // getRandomPopularItem(sql, minorityType, …) filters
                        // `mi.media_type = ${minorityType}`, where minorityType
                        // is itself `'movie' | 'tv'` — this can never be
                        // anything else.
                        // eslint-disable-next-line callback-safety/no-inline-media-type-default -- popular-item query is movie/TV-only.
                        const canonicalType = toMovieOrSeries(popularItem.media_type) ?? 'movie';
                        secondBecauseSource = {
                            id: internalId ?? null,
                            title: popularItem.title,
                            type: canonicalType,
                            ...(internalId
                                ? {
                                      images: {
                                          poster: {
                                              href: entityImageUrl(internalId, 'poster', surface),
                                          },
                                          thumb: {
                                              href: entityImageUrl(internalId, 'thumb', surface),
                                          },
                                      },
                                  }
                                : {}),
                            ids,
                            // Not a genuine watched seed — a random popular library
                            // title substituted when the minority-type recent pool
                            // is empty. The client must render an honest header for
                            // this instead of "Because you watched".
                            reason: 'popular',
                        };
                    }
                }
            }

            const responsePayload: CachedResponse = { sources, secondBecauseSource };
            await sourcesCache.set(cacheKey, responsePayload);
            return json(await overlaySources(responsePayload));
        },
    },
});
