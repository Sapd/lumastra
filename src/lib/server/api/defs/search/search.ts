// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * defs/search/search.ts — `GET /api/v1/search` rebuilt to the redesign contract.
 *
 * Contract:
 *   GET /api/v1/search?q=…&types=…&limit=…&offset=…  → { items, page }
 *
 * Each item is a v1 cross-entity search handle:
 *   - canonical `id` (internal UUID when available, else a composite/source handle)
 *   - a `type` discriminator (canonical 'series', NOT 'tv')
 *   - open external-only `ids{}` map and separate `catalogId`
 *   - self-describing `images{}` hrefs (NO flat imageUrl). Catalog/music rows use
 *     `buildImageRefs` (the resolvable /media/{id}/images byte route); external
 *     sources (Kavita covers, Live TV channel logos, Audiobookshelf, Jellyseerr
 *     posters, non-entertainment custom posters) wrap the SAME url the legacy
 *     web-UI search emitted into an `images.poster.href` entry.
 *   - a normalized cross-source `score` (the merged set is sorted by it BEFORE
 *     paginating, so page boundaries are stable across every source).
 *
 * Errors → problem+json. A down *core* dependency (DB unavailable) yields
 * `503 dependency_unavailable` — NEVER a 200 with an empty array. A down
 * *optional* source (Kavita / Audiobookshelf / Jellyseerr / Live TV / the
 * external aggregator) is degraded to zero rows for THAT source only — it must
 * never 500 or 503 the whole search (mirrors the legacy route's per-source
 * try/catch resilience). An empty `{ items, page }` is returned ONLY for a
 * genuine zero-result search.
 *
 * SCOPE — full parity with the legacy `/api/search` web-UI fan-out. This def
 * searches the DB catalog (movies, series, episodes, music) AND the same
 * external/auxiliary sources the legacy handler did:
 *   - Kavita books / manga / comics            → type book | manga | comic
 *   - Audiobookshelf audiobooks                → type audiobook
 *   - Jellyseerr requests (discovery)          → type request
 *   - Live TV channels                         → type tvchannel
 *   - Non-entertainment libraries              → type home_video | training |
 *                                                educational | personal
 *
 * SEARCH ITEM TYPE UNION — search is cross-entity, so the item `type` is a
 * SUPERSET of the catalog MediaType. Catalog/music keep canonical types
 * (movie|series|episode|track|album|artist); the restored sources add
 * book|manga|comic|audiobook|request|tvchannel|home_video|training|
 * educational|personal. The legacy/web internal request type 'anfragen' is
 * mapped to the canonical public 'request'.
 *
 * STRUCTURE — this def is DECLARATIVE: it parses + validates the request,
 * resolves the access scope (denied groups + age rating), resolves the gating
 * flags and the in-scope source toggles, then hands the mechanics off to the
 * stateless `SearchService` (fan-out + per-source mappers + rank normalization +
 * merge/excludeTerms/stable-sort/window-paginate). External sources are still
 * delegated to `MediaAggregationService` inside the service, exactly as before.
 *
 * Auth: user (any authenticated caller — session, PAT, device JWT, service token).
 */

import { z } from 'zod';
import { exactSeriesRows } from './exact-series.js';

import { json } from '@sveltejs/kit';
import { decorateSearchMatchedTitles } from '$lib/server/database/queries/search-matched-titles.queries.js';
import { defineEndpoint } from '$lib/server/api/define.js';
import { ApiProblem, paginate } from '$lib/server/api/problem.js';
import { getDb } from '$lib/server/database/connection.js';
import { config, isUnavailableMediaVisibleInSearch } from '$lib/server/config.js';
import {
    buildSearchAccessContext,
    searchAccessBoundary,
    buildSearchAccessCacheKey,
    type SearchAccessContext,
} from '$lib/server/utils/search-access-context.js';
import { searchQuerySchema, parseSearchQuery } from '$lib/schemas/browse.js';
import { Logger } from '$lib/server/utils/logger.js';
import { parseSearchQueryHints } from '$lib/server/utils/search-query-hints.js';
import { isSingleCjkAudiobookQuery } from '$lib/server/utils/audiobook-search.js';
import { cacheManager, CACHE_NAMESPACES } from '$lib/server/cache/index.js';
import { getOrComputeSingleFlight } from '$lib/server/cache/single-flight.js';
import {
    SearchService,
    MAX_SEARCH_OFFSET,
    type SearchSourceToggles,
    type SearchServiceOptions,
    type SearchPage,
    type SearchResultItem,
} from '$lib/server/services/search.service.js';
// The 200 item/response shape lives in a leaf schema module so the colocated
// `_openapi.ts` can share it without importing this def (which drags in
// SearchService and would make the route un-contract-checkable). See the header
// comment in that file.
export { SearchResultItemSchema, SearchResponseSchema } from './search-item.schemas.js';
import { SearchResponseSchema } from './search-item.schemas.js';
import { searchPreviews } from './preview-mapper.js';
import { buildPlaybackProgress } from '$lib/schemas/playback-progress.js';
import type { PlaybackProgress } from '$lib/schemas/playback-progress.js';

const logger = Logger.for('SearchV1Def');

/**
 * TTL for a page an optional source was dropped from (`SearchPage.degraded`).
 *
 * Not "don't cache it": a source sick enough to keep overrunning its deadline is
 * exactly when every search would become an uncached full fan-out, and the
 * single-flight lock — the thundering-herd guard — would stop doing anything at
 * the moment the herd is largest. A short TTL keeps the guard and bounds how
 * long one incomplete answer is served to the rest of the access scope, which is
 * the actual harm (the page is user-agnostic, so the viewer who triggered the
 * timeout is not the only one who gets it).
 */
export const DEGRADED_PAGE_TTL_SECONDS = 5;

/**
 * Is this serialized page one an optional source was dropped from?
 *
 * Parses rather than trusting a flag threaded out of `compute`, so the answer
 * is the same on every path that can reach it. Unparseable input is treated as
 * NOT degraded: that can only mean the page never came from `SearchService`,
 * and inventing a short TTL for a value we do not understand is worse than
 * leaving it on the namespace default.
 */
function pageIsDegraded(serializedPage: string): boolean {
    try {
        return (JSON.parse(serializedPage) as SearchPage).degraded === true;
    } catch {
        return false;
    }
}

// ---------------------------------------------------------------------------
// Cache key
// ---------------------------------------------------------------------------

/**
 * A cache-key component may never contain the `|` separator `scopedCacheKey`/
 * `buildSearchAccessCacheKey` reserve for splitting the access-scope suffix
 * off the body. User-supplied query/exclude text is otherwise free-form, so
 * sanitize rather than throw (a stray `|` in a search box must not 500 the
 * request) — see the module doc for why this can't cause cross-user leakage.
 */
function sanitizeKeyPart(s: string): string {
    return s.replace(/\|/g, '_');
}

/**
 * Build the cache key for a full `GET /api/v1/search` page.
 *
 * Every input that changes SearchService.search()'s OUTPUT must be
 * represented here (see CACHE_NAMESPACES.searchResultsPage doc for the full
 * rationale). Notably:
 *   - `excludeTerms` IS included: SearchService.mergeAndPaginate applies it
 *     as a POST-merge client-side filter, so it changes the final page/
 *     hasMore, not just the DB query.
 *   - Genre filters are included because they narrow catalog results.
 */
function buildSearchResultsCacheKey(
    params: {
        q: string;
        limit: number;
        offset: number;
        types?: string[];
        useFulltext?: boolean;
        yearMin?: number;
        yearMax?: number;
        yearHint?: number;
        ratingMin?: number;
        genres?: string[];
        excludeTerms?: string[];
        showUnavailableMedia: boolean;
        availableOnly: boolean;
    },
    accessCtx: SearchAccessContext,
): string {
    const parts = [
        // v5: `types=track|album|artist` now restricts the music rows, so a
        // cached v4 page for those types holds the old mixed set.
        'v5-typed-music',
        sanitizeKeyPart(params.q.trim().toLowerCase()),
        `l${params.limit}`,
        `o${params.offset}`,
        params.types && params.types.length > 0
            ? `t:${[...params.types].sort().join(',')}`
            : 't:all',
        params.useFulltext ? 'ft1' : 'ft0',
        params.yearMin !== undefined ? `yn${params.yearMin}` : null,
        params.yearMax !== undefined ? `yx${params.yearMax}` : null,
        params.yearHint !== undefined ? `yh${params.yearHint}` : null,
        params.ratingMin !== undefined ? `rm${params.ratingMin}` : null,
        params.excludeTerms && params.excludeTerms.length > 0
            ? `ex:${sanitizeKeyPart([...params.excludeTerms].sort().join(','))}`
            : null,
        params.genres?.length ? `g:${sanitizeKeyPart([...params.genres].sort().join(','))}` : null,
        params.showUnavailableMedia ? 'unavail1' : 'unavail0',
        // Also drops request rows, which `showUnavailableMedia` does not cover.
        params.availableOnly ? 'avail1' : null,
    ].filter((p): p is string => p !== null);
    const accessSuffix = buildSearchAccessCacheKey(accessCtx);
    return accessSuffix ? `${parts.join(':')}|${accessSuffix}` : parts.join(':');
}

// ---------------------------------------------------------------------------
// def
// ---------------------------------------------------------------------------

const CatalogSearchQuery = searchQuerySchema
    .extend({
        match: z
            .literal('exact')
            .optional()
            .describe('With types=series: exact title equality, ranked, without fuzzy results'),
        year: z.coerce.number().int().min(1).max(9999).optional(),
    })
    .strict()
    .meta({
        id: 'CatalogSearchQuery',
        description: 'Search, including exact series title and year lookup',
    });

export const def = defineEndpoint({
    docs: {
        GET: {
            tags: ['Search'],
            summary: 'Search the catalog',
            stability: 'stable',
            auth: 'bearer',
            description:
                'Exact series lookup: ?q=M&types=series&match=exact&year=1931 returns ranked title matches only. Full-text search across the catalog (movies, series, episodes, music) with ' +
                'optional type filtering, year ranges, rating minimums and exclusion terms. ' +
                'Returns a paginated `{ items, page }` collection; each item is a self-describing ' +
                'media handle (canonical `id` + `type` + `ids{}` + `images{}` descriptors) that ' +
                'matches `GET /media/{id}`. Results are merged across sources and globally ' +
                'sorted by a normalized relevance `score` before pagination, so page boundaries ' +
                'are stable. A down dependency returns `503 dependency_unavailable` (never an ' +
                'empty 200).',
            query: CatalogSearchQuery,
            responses: {
                200: {
                    schema: SearchResponseSchema,
                    description: 'Search results',
                },
                401: 'Authentication required',
                422: 'Validation failed',
                503: 'Search dependency unavailable',
                500: 'Internal server error',
            },
        },
    },

    auth: { kind: 'user' },

    request: {
        query: CatalogSearchQuery,
    },

    handlers: {
        GET: async (event, ctx) => {
            const sql = getDb();
            if (!sql) {
                // Core dependency down → 503 problem+json (NEVER 200-empty).
                return ApiProblem.dependencyUnavailable('Database is not available');
            }

            // ── Parse the shared request contract ──
            const parsedQuery = CatalogSearchQuery.safeParse(
                Object.fromEntries(event.url.searchParams),
            );
            if (!parsedQuery.success) {
                return ApiProblem.validationFailed(
                    parsedQuery.error.issues.map((e) => ({
                        field: e.path.join('.'),
                        message: e.message,
                    })),
                );
            }
            if (parsedQuery.data.year !== undefined && parsedQuery.data.match !== 'exact') {
                return ApiProblem.validationFailed([
                    {
                        field: 'match',
                        message:
                            'year is supported by the exact series lookup; use types=series&match=exact',
                    },
                ]);
            }
            if (parsedQuery.data.match === 'exact') {
                if (parsedQuery.data.types !== 'series' || !parsedQuery.data.q?.trim()) {
                    return ApiProblem.validationFailed([
                        {
                            field: 'match',
                            message: 'Exact lookup requires types=series and a title q',
                        },
                    ]);
                }
                if (!event.locals.user) return ApiProblem.unauthorized();
                const { limit, offset } = parseSearchQuery(parsedQuery.data);
                const access = searchAccessBoundary(
                    await buildSearchAccessContext(sql, event.locals.user),
                );
                const rows = await exactSeriesRows(
                    sql,
                    parsedQuery.data.q,
                    parsedQuery.data.year,
                    limit + 1,
                    offset,
                    access,
                    !isUnavailableMediaVisibleInSearch() || parsedQuery.data.availableOnly === true,
                );
                const items = rows.slice(0, limit).flatMap((row) => {
                    const item = SearchService.mapCatalogRow(row, 'fts', ctx.surface);
                    return item ? [item] : [];
                });
                return json(
                    paginate(
                        await searchPreviews(
                            sql,
                            ctx.surface,
                            items.map(({ progress: _progress, ...item }) => item),
                        ),
                        { limit, offset, hasMore: rows.length > limit },
                    ),
                );
            }
            const {
                q: rawQuery,
                limit,
                offset,
                types: explicitTypes,
                fulltext: useFulltext,
                yearMin: explicitYearMin,
                yearMax: explicitYearMax,
                ratingMin,
                genres,
                excludeTerms,
                availableOnly: availableOnlyParam,
            } = parseSearchQuery(parsedQuery.data);
            const availableOnly = availableOnlyParam === true;

            // ── Query hints: "Anna (2019)", "movie 2019" ──
            // A year / type word is not part of a title; left in the text it makes
            // the FTS AND-match fail. Explicit params always win over hints.
            let query = rawQuery;
            let allowedTypes = explicitTypes;
            let yearMin = explicitYearMin;
            let yearMax = explicitYearMax;
            let yearHint: number | undefined;
            if (rawQuery && rawQuery !== '*') {
                const hints = parseSearchQueryHints(rawQuery);
                if (hints.year !== undefined) {
                    query = hints.text;
                    if (hints.type && !explicitTypes) allowedTypes = [hints.type];
                    if (hints.text === '') {
                        // Only hints → "all movies of that year" (filter-only search).
                        if (yearMin === undefined && yearMax === undefined) {
                            yearMin = hints.year;
                            yearMax = hints.year;
                        }
                        query = '*';
                    } else {
                        yearHint = hints.year;
                    }
                }
            }

            const hasFilters =
                yearMin !== undefined ||
                yearMax !== undefined ||
                ratingMin !== undefined ||
                !!genres?.length ||
                !!excludeTerms?.length;

            // A single kana/kanji character can be a meaningful audiobook term.
            // Keep the historical Latin minimum and other explicit media lanes.
            const shortAudiobookQuery =
                query &&
                isSingleCjkAudiobookQuery(query) &&
                (!allowedTypes || allowedTypes.includes('audiobook'));
            const isFilterOnlySearch = query === '*' && hasFilters;
            if (
                !isFilterOnlySearch &&
                !shortAudiobookQuery &&
                (!query || [...query.trim()].length < 2)
            ) {
                // Genuine zero-result (query too short) → empty page, 200.
                return json(paginate([], { limit, offset, hasMore: false, total: 0 }));
            }
            const q = query ?? '*';
            // Do not let this audiobook-only exception fan a one-character
            // query out to movie, music, book, request or channel providers.
            if (shortAudiobookQuery) allowedTypes = ['audiobook'];

            // ── Access scope (denied library groups + age rating + live TV) ──
            // `auth: { kind: 'user' }` guarantees locals.user is populated by
            // resolveAuth() for every credential path (session, PAT, service
            // token, JWT) before this handler runs — see hooks.server.ts /
            // forward-auth.ts. The guard below is standard defensive practice
            // (matches every other buildSearchAccessContext call site) and
            // makes the closed-by-default contract explicit at the call site.
            const user = event.locals.user;
            if (!user) return ApiProblem.unauthorized();
            const accessCtx = await buildSearchAccessContext(sql, user);

            // Search has its own gate (default false): unavailable titles are
            // reachable via the separate requests surface, so the inline list
            // stays library-only unless the install opts in. Effective gate
            // additionally requires a configured request path (config.ts).
            //
            // NOTE: deliberately NOT accessCtx.showUnavailableMedia — that
            // field is driven by isUnavailableMediaVisible() (the SHOW_UNAVAILABLE_MEDIA
            // Trending/For-You gate). Search has its OWN, separate toggle
            // (SHOW_UNAVAILABLE_MEDIA_IN_SEARCH / isUnavailableMediaVisibleInSearch()) —
            // see the doc comments on both functions in config.ts. Folding this
            // into the shared context field would silently couple two
            // independently-configurable gates.
            //
            // `availableOnly` lets a client (a tvOS/iOS search grid, a UI test)
            // ask for playable titles only. It can only NARROW the install
            // setting, never widen it.
            const showUnavailableMedia = isUnavailableMediaVisibleInSearch() && !availableOnly;

            // ── Which sources are in scope. 'tv' here is the INTERNAL db value
            //    (parseSearchQuery already maps 'series' → 'tv'). ──
            const nonEntTypes = ['home_video', 'training', 'educational', 'personal'] as const;
            const sources: SearchSourceToggles = {
                movies: !allowedTypes || allowedTypes.includes('movie'),
                series: !allowedTypes || allowedTypes.includes('tv'),
                episodes: !allowedTypes || allowedTypes.includes('episode'),
                music:
                    !allowedTypes ||
                    allowedTypes.includes('music') ||
                    allowedTypes.includes('audio') ||
                    allowedTypes.includes('track') ||
                    allowedTypes.includes('album') ||
                    allowedTypes.includes('artist'),
                // `music`/`audio` (or no filter) mean all three row types; otherwise
                // honour track/album/artist individually so a client can page one
                // section without the others eating the window.
                musicTypes:
                    !allowedTypes ||
                    allowedTypes.includes('music') ||
                    allowedTypes.includes('audio')
                        ? undefined
                        : (['artist', 'album', 'track'] as const).filter((t) =>
                              allowedTypes.includes(t),
                          ),
                // Restored auxiliary sources (full parity with legacy fan-out).
                books:
                    !allowedTypes ||
                    allowedTypes.includes('book') ||
                    allowedTypes.includes('manga') ||
                    allowedTypes.includes('comic'),
                audiobooks: !allowedTypes || allowedTypes.includes('audiobook'),
                // Request rows are titles NOT in the library by definition.
                requests:
                    !availableOnly &&
                    (!allowedTypes ||
                        allowedTypes.includes('request') ||
                        allowedTypes.includes('anfragen')),
                channels: !allowedTypes || allowedTypes.includes('tvchannel'),
                // Non-entertainment library types (1:1 with the catalog DB media_type).
                nonEntTypes: nonEntTypes.filter((t) => !allowedTypes || allowedTypes.includes(t)),
            };

            // These catalog filters cannot be honored by auxiliary providers.
            // Never mix unfiltered external hits into a filtered catalog search.
            if (
                yearMin !== undefined ||
                yearMax !== undefined ||
                ratingMin !== undefined ||
                genres?.length
            ) {
                sources.episodes = false;
                sources.music = false;
                sources.books = false;
                sources.audiobooks = false;
                sources.requests = false;
                sources.channels = false;
                sources.nonEntTypes = [];
            }

            // Deep-pagination guard: offset growth fans proportionally large LIMITs
            // to every source (O(offset) cost). Return an empty page when offset
            // exceeds the ceiling — contract-valid per the v1 spec.
            if (offset > MAX_SEARCH_OFFSET) {
                return json(paginate([], { limit, offset, hasMore: false, total: 0 }));
            }

            // We sort the merged set globally THEN slice, so each source must
            // contribute at least the full window [0, offset+limit] of its best
            // matches (plus one to detect hasMore on the merged set).
            const window = offset + limit + 1;

            const searchOptions: SearchServiceOptions = {
                sql,
                q,
                window,
                offset,
                limit,
                useFulltext: useFulltext === true,
                yearMin,
                yearMax,
                yearHint,
                ratingMin,
                genres,
                excludeTerms,
                deniedGroupIds: accessCtx.deniedGroupIds,
                ageRating: accessCtx.ageRating,
                showUnavailableMedia,
                liveTvAllowed: accessCtx.liveTvAllowed,
                surface: ctx.surface,
                sources,
            };

            let result: SearchPage;
            try {
                // Short-TTL (45s), access-scoped, single-flighted cache fronting
                // the whole 6-source fan-out — see CACHE_NAMESPACES.searchResultsPage
                // for the full rationale. L1 pre-check first (skips the Valkey hop
                // entirely on a warm in-process hit); on L1 miss, single-flight
                // collapses concurrent identical misses (multiple tabs/devices,
                // debounce retries) onto one compute.
                const cacheKey = buildSearchResultsCacheKey(
                    {
                        q,
                        limit,
                        offset,
                        types: allowedTypes,
                        useFulltext,
                        yearMin,
                        yearMax,
                        yearHint,
                        ratingMin,
                        genres,
                        excludeTerms,
                        showUnavailableMedia,
                        availableOnly,
                    },
                    accessCtx,
                );
                const searchCache = cacheManager.for(CACHE_NAMESPACES.searchResultsPage);
                const cached = await searchCache.get<SearchPage>(cacheKey);
                if (cached) {
                    result = cached;
                } else {
                    const ns = CACHE_NAMESPACES.searchResultsPage;
                    const rawKey = `${ns.name}:${cacheKey}`;
                    const ttlSeconds = Math.floor(ns.l2TTL / 1000);
                    const jsonStr = await getOrComputeSingleFlight({
                        cacheKey: rawKey,
                        ttlSeconds,
                        compute: async () =>
                            JSON.stringify(await SearchService.search(searchOptions)),
                        // Derived from the VALUE, not from a flag set inside
                        // `compute`. A follower is handed the leader's value
                        // without ever running `compute`, so any such flag reads
                        // false for a page that is in fact degraded. The page
                        // carries the truth; nothing else has to stay in sync
                        // with it.
                        resolveTtlSeconds: (value) =>
                            pageIsDegraded(value) ? DEGRADED_PAGE_TTL_SECONDS : ttlSeconds,
                    });
                    result = JSON.parse(jsonStr) as SearchPage;
                    // Populate L1 so subsequent in-process reads skip Valkey.
                    void searchCache.set(
                        cacheKey,
                        result,
                        result.degraded === true ? DEGRADED_PAGE_TTL_SECONDS * 1000 : undefined,
                    );
                }
            } catch (error) {
                // A genuine CORE query failure (not "no results") is a dependency
                // fault — surface it, never mask it as an empty page. Optional
                // sources already degraded to [] inside the service, so reaching
                // here means a catalog/DB-level failure. Errors thrown inside the
                // cached `compute()` propagate up through getOrComputeSingleFlight
                // uncaught (never cached as a false empty page).
                logger.error('Search query failed', error as Error, { query: q });
                return ApiProblem.dependencyUnavailable('Search backend is unavailable');
            }

            // Per-user metadata-language overlay (multilingual-media-metadata spec
            // §5): resolved once per request, applied AFTER the cache read/write
            // above. Only the catalog kinds (movie/series/episode) carry a
            // media_items translation row — the id accessor skips every auxiliary
            // source (book/track/tvchannel/…) so their (non-media_items) ids never
            // reach the lookup. The additional UUID_RE guard skips catalog rows
            // whose id fell back to a non-UUID form (jellyfin id / 'tmdb:…' in
            // mapCatalogRow): one such id would make the lookup's ::uuid[] cast
            // throw and silently disable the overlay for the whole response.
            //
            // CRITICAL: `result.items` may be the LIVE array reference cached
            // above (both the L1 hit path and the just-populated L1 entry share
            // it). Mutating it in place would write one user's language INTO the
            // shared, user-agnostic cache entry and leak it to the next caller
            // who hits the same key within the 45s TTL — mirrors the same fix
            // applied to defs/search/episodes.ts. The overlay therefore always
            // runs on shallow CLONES; the cached array is never touched.
            let responseItems: Array<
                Omit<SearchResultItem, 'progress'> & { progress?: PlaybackProgress }
            > = result.items.map(({ progress: _progress, ...item }) => item);
            if (event.locals.user?.userId && config.METADATA_ADDITIONAL_LANGUAGES.length > 0) {
                const { resolveMetadataLanguage } =
                    await import('$lib/server/utils/metadata-language-resolve.js');
                const { getPlaybackPreferences } =
                    await import('$lib/server/database/queries/user-preferences.queries.js');
                const langs = resolveMetadataLanguage(
                    await getPlaybackPreferences.one(sql, { userId: event.locals.user.userId }),
                );
                if (langs.titleLang || langs.textLang) {
                    const { applyTranslationOverlay } =
                        await import('$lib/server/utils/translation-overlay.js');
                    const { UUID_RE } = await import('$lib/utils/id-patterns.js');
                    const CATALOG_TYPES = new Set(['movie', 'series', 'episode']);
                    const localizedItems = result.items.map((it) => ({ ...it }));
                    await applyTranslationOverlay(sql, localizedItems, langs, {
                        id: (it) =>
                            CATALOG_TYPES.has(it.type) && UUID_RE.test(it.id) ? it.id : null,
                        setTitle: (it, v) => {
                            it.title = v;
                        },
                        setOverview: (it, v) => {
                            it.overview = v;
                        },
                    });
                    responseItems = localizedItems.map(({ progress: _progress, ...item }) => item);
                }
            }

            // Optional explanation on per-request clones, after metadata language selection.
            // Failure retains the old response shape and never fails an otherwise valid search.
            responseItems = await decorateSearchMatchedTitles(
                sql,
                responseItems,
                q,
                searchAccessBoundary(accessCtx),
            ).catch((error: unknown) => {
                logger.warn('Search matched-title decoration failed', error as Error);
                return responseItems;
            });

            // Per-user audiobook listening state, under the SAME constraint as
            // the language overlay above and for the same reason: this page's
            // cache key is access-scoped, not per-user, so two viewers in one
            // access scope share the entry. Writing progress into it in place
            // would serve one viewer's position to the other for the rest of the
            // 45s TTL. So this runs after the cache read, on shallow clones.
            //
            // Only books already ingested into media_items have a UUID id (see
            // mapExternalRow) — an unresolved ABS row keeps its raw provider id
            // and is skipped, rather than making the ::uuid[] cast throw and
            // disabling the decoration for the whole response.
            if (event.locals.user?.userId) {
                const { UUID_RE } = await import('$lib/utils/id-patterns.js');
                const bookIds = responseItems
                    .filter((it) => it.type === 'audiobook' && UUID_RE.test(it.id))
                    .map((it) => it.id);
                if (bookIds.length > 0) {
                    const { batchGetUserWatchStates } =
                        await import('$lib/server/database/queries/watch-state.queries.js');
                    // Best-effort: a failed state read serves plain rows rather
                    // than 500ing a search that otherwise succeeded.
                    const states = await batchGetUserWatchStates
                        .all(sql, { userId: event.locals.user.userId, mediaIds: bookIds })
                        .catch((error: unknown) => {
                            logger.warn(
                                'Audiobook listening-state decoration failed',
                                error as Error,
                            );
                            return [];
                        });
                    if (states.length > 0) {
                        const byId = new Map(states.map((state) => [state.media_id, state]));
                        responseItems = responseItems.map((it) => {
                            const state = it.type === 'audiobook' ? byId.get(it.id) : undefined;
                            if (!state) return it;
                            // Finishing resets resume_position_ms, so a finished
                            // book's progress comes from the flag, not the
                            // position. Unknown duration keeps position while
                            // leaving duration and fraction null.
                            const positionMs =
                                state.resume_position_ms == null
                                    ? null
                                    : Number(state.resume_position_ms);
                            const durationMs = Number(state.runtime_ms ?? 0);
                            return {
                                ...it,
                                progress: buildPlaybackProgress({
                                    positionMs,
                                    durationMs: durationMs > 0 ? durationMs : null,
                                    finished: state.is_watched,
                                    updatedAt: state.last_event_at ?? null,
                                }),
                            };
                        });
                    }
                }
            }

            return json(
                paginate(await searchPreviews(sql, ctx.surface, responseItems), {
                    limit,
                    offset,
                    hasMore: result.hasMore,
                }),
            );
        },
    },
});
