// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The cached genre-carousels + recently-added compute behind `/api/browse`
 * (and `/api/v1/browse`) — extracted from `defs/browse/index.ts`'s GET
 * handler so `/browse`'s SSR load can call the EXACT SAME cache-aside +
 * access-scoping + language-overlay logic directly, in-process, instead of
 * re-deriving it or issuing an internal HTTP round-trip. Both callers hit the
 * SAME `genresCache` / `recentlyAddedCache` entries — a warm cache for one
 * surface warms the other.
 *
 * This module applies NO overview truncation — it must stay byte-identical
 * for `/api/v1/browse`, which mounts the same def this function backs. Each
 * internal-only caller (the `/api/browse` route's internal-surface branch,
 * `/browse`'s SSR load) trims `overview` itself at its own boundary via
 * `truncate-overview.ts`. See that file's docblock for why.
 */

import type { Sql } from 'postgres';
import {
    type BrowseGenreSectionsResult,
    buildBrowseGenreSections,
    getFilteredRecentlyAddedMedia,
} from '$lib/server/database/queries/browse.queries.js';
import { isMovie } from '$lib/server/utils/media-types.js';
import { browseGenresCacheKey, CACHE_NAMESPACES, cacheManager } from '$lib/server/cache/index.js';
import {
    browseAccessSuffix,
    buildSearchAccessContext,
    searchAccessBoundary,
} from '$lib/server/utils/search-access-context.js';
import { config } from '$lib/server/config.js';
import type { BrowseGenreRow, BrowseItem } from '$lib/schemas/api-browse-responses.js';
import type { UserContext } from '$lib/server/types.js';
import type { ApiSurface } from '$lib/shared/api-urls.js';
import type { MediaPreview } from '$lib/schemas/api-media-preview.js';

const recentlyAddedCache = cacheManager.for(CACHE_NAMESPACES.browseRecentlyAdded);

/** Public/canonical media-type filter accepted by `/api/browse`. */
export type BrowseIndexMediaType = 'movie' | 'series' | 'channels' | 'all';

export interface BrowseIndexData {
    recentlyAdded: BrowseItem[];
    genres: BrowseGenreRow[];
    totalGenres: number;
    hasMoreGenres: boolean;
    mediaServerAvailable: boolean;
}

/**
 * Build the `/api/browse` payload: genre carousels + recently-added, scoped
 * to the caller's library/age access and localized to their metadata
 * language. Byte-identical output to the previous inline handler body in
 * `defs/browse/index.ts` — this is a pure extraction, not a behavior change.
 */
export async function loadBrowseIndexData(
    sql: Sql,
    params: { mediaType: BrowseIndexMediaType; user: UserContext },
): Promise<BrowseIndexData> {
    const { mediaType, user } = params;

    const accessCtx = await buildSearchAccessContext(sql, user);
    const access = searchAccessBoundary(accessCtx);

    // Map canonical public mediaType to internal DB value.
    // 'channels' falls through to 'all' (genre sections are skipped separately).
    const toDbMediaType = (t: string): 'movie' | 'tv' | 'all' =>
        t === 'movie' ? 'movie' : t === 'series' ? 'tv' : 'all';

    // Genre carousels — access-scoped cache key so restricted users never
    // receive genre rows from denied library groups.
    const genresCache = cacheManager.for(CACHE_NAMESPACES.browseGenres);
    const accessSuffix = browseAccessSuffix(accessCtx);
    const genreKey = accessSuffix
        ? `${browseGenresCacheKey(mediaType)}:${accessSuffix}`
        : browseGenresCacheKey(mediaType);

    // Recently-added cache key — skip for access-restricted users
    // (warmer stores unfiltered data).
    const cacheKey =
        accessCtx.deniedGroupIds === null && accessCtx.ageRating === null
            ? `titles-v1:${mediaType}`
            : null;

    // Genre sections and recently-added share no data, so compute them
    // concurrently. Each branch keeps its own cache-aside get/set.
    const genrePromise = (async (): Promise<BrowseGenreSectionsResult> => {
        if (mediaType === 'channels') {
            return { genres: [], totalGenres: 0, hasMoreGenres: false };
        }
        const cached = await genresCache.get<BrowseGenreSectionsResult>(genreKey);
        if (cached) {
            return cached;
        }
        const sections = await buildBrowseGenreSections(sql, {
            mediaType: toDbMediaType(mediaType),
            access,
        });
        try {
            await genresCache.set(genreKey, sections);
        } catch {
            /* non-fatal */
        }
        return sections;
    })();

    const recentlyAddedPromise = (async (): Promise<BrowseItem[]> => {
        if (cacheKey) {
            const cached = await recentlyAddedCache.get<BrowseItem[]>(cacheKey);
            if (cached) {
                return cached;
            }
        }

        const results = await getFilteredRecentlyAddedMedia(sql, {
            mediaType: toDbMediaType(mediaType),
            limit: 20,
            access,
            newness: 'titles',
        });

        const recentlyAdded: BrowseItem[] = results.map((row) => ({
            id: row.id,
            name: row.title,
            type: isMovie(row.media_type) ? 'movie' : 'series',
            overview: row.overview ?? undefined,
            imageId: row.id,
        }));

        if (cacheKey) {
            try {
                await recentlyAddedCache.set(cacheKey, recentlyAdded);
            } catch {
                /* non-fatal */
            }
        }
        return recentlyAdded;
    })();

    const [genreSections, recentlyAdded] = await Promise.all([genrePromise, recentlyAddedPromise]);

    // Per-user metadata-language overlay (multilingual-media-metadata spec
    // §5): resolved ONCE per request, applied AFTER cache retrieval to both
    // card feeds this endpoint emits (recently-added + genre carousels).
    // Both cache-hit paths above return the LIVE cached array/objects
    // (UnifiedCache L1 reference) — overlay on shallow-cloned copies so a
    // translated title/overview is never written back into the shared
    // cache entry.
    let responseRecentlyAdded = recentlyAdded;
    let responseGenres = genreSections.genres;
    const userId = user.userId;
    if (userId && config.METADATA_ADDITIONAL_LANGUAGES.length > 0) {
        const { resolveMetadataLanguage } =
            await import('$lib/server/utils/metadata-language-resolve.js');
        const { getPlaybackPreferences } =
            await import('$lib/server/database/queries/user-preferences.queries.js');
        const langs = resolveMetadataLanguage(await getPlaybackPreferences.one(sql, { userId }));
        if (langs.titleLang || langs.textLang) {
            const { applyTranslationOverlay } =
                await import('$lib/server/utils/translation-overlay.js');
            const clonedRecentlyAdded = recentlyAdded.map((it) => ({ ...it }));
            const clonedGenres = genreSections.genres.map((g) => ({
                ...g,
                items: g.items.map((it) => ({ ...it })),
            }));
            const allItems = [...clonedRecentlyAdded, ...clonedGenres.flatMap((g) => g.items)];
            await applyTranslationOverlay(sql, allItems, langs, {
                id: (it) => it.id || null,
                setTitle: (it, v) => {
                    it.name = v;
                },
                setOverview: (it, v) => {
                    it.overview = v;
                },
            });
            responseRecentlyAdded = clonedRecentlyAdded;
            responseGenres = clonedGenres;
        }
    }

    responseRecentlyAdded = responseRecentlyAdded.map((it) => ({ ...it }));
    responseGenres = responseGenres.map((g) => ({ ...g, items: g.items.map((it) => ({ ...it })) }));
    const { enrichSeriesEpisodeCounts } =
        await import('$lib/server/services/series-episode-counts.service.js');
    await enrichSeriesEpisodeCounts(
        sql,
        [...responseRecentlyAdded, ...responseGenres.flatMap((g) => g.items)],
        userId ?? null,
        access,
    );

    return {
        recentlyAdded: responseRecentlyAdded,
        genres: responseGenres,
        totalGenres: genreSections.totalGenres,
        hasMoreGenres: genreSections.hasMoreGenres,
        mediaServerAvailable: responseRecentlyAdded.length > 0 || genreSections.genres.length > 0,
    };
}

/** Public listing query: same library, age, genre and library-group predicates as A–Z. */
export interface MediaListingOptions {
    type?: 'movie' | 'series';
    libraryGroupId?: string;
    genre?: string;
    letter?: string;
    tag?: string;
    keyword?: string;
    year?: number;
    sort: 'title' | 'added' | 'year' | 'rating' | 'runtime';
    order: 'asc' | 'desc';
    limit: number;
    offset: number;
    include?: 'facets';
}

export async function loadMediaListing(
    sql: Sql,
    user: UserContext,
    surface: ApiSurface,
    options: MediaListingOptions,
): Promise<{
    items: MediaPreview[];
    page: { limit: number; offset: number; total: number; hasMore: boolean };
    facets?: {
        letterCounts: Array<{ letter: string; count: number }>;
        genreCounts: Array<{ name: string; count: number }>;
    };
}> {
    const { buildGenreMembershipFilter } =
        await import('$lib/server/database/queries/browse.queries.js');
    const { buildLibraryAccessFilter } =
        await import('$lib/server/database/queries/builders/library-access.builder.js');
    const { buildLibraryGroupFilter } =
        await import('$lib/server/database/queries/builders/library-group.builder.js');
    const { buildAgeRatingFilter } =
        await import('$lib/server/database/queries/builders/age-rating.builder.js');
    const { buildMetadataLateralJoinFragment } =
        await import('$lib/server/database/queries/builders/provider-metadata.builder.js');
    const { buildMediaPreviews } = await import('./media-preview.service.js');
    const { getMediaRailMetadataBatch } =
        await import('$lib/server/database/queries/media-rail-metadata.queries.js');
    const { pickDisplayRating } = await import('$lib/server/utils/rating-utils.js');
    const access = searchAccessBoundary(await buildSearchAccessContext(sql, user));
    const sortTitle = sql`COALESCE(NULLIF(mi.sort_title, ''), LOWER(mi.title)) COLLATE "C"`;
    const { keywordGroupMembers } = await import('$lib/shared/keyword-vocabulary.js');
    const keywordFilter = (value?: string): ReturnType<Sql> =>
        value?.trim()
            ? sql`AND EXISTS (SELECT 1 FROM media_keywords mk WHERE mk.media_id = mi.id AND mk.keyword = ANY(${[
                  ...keywordGroupMembers(value.trim().toLowerCase()),
              ]}::text[]))`
            : sql``;
    const sharedFilter = sql`mi.status = 'active' AND mi.has_files = true
        AND mi.media_type IN ('movie', 'tv')
        ${
            options.type
                ? sql`AND mi.media_type = ${options.type === 'series' ? 'tv' : 'movie'}`
                : sql``
        }
        ${buildLibraryAccessFilter(sql, access.library)} ${buildAgeRatingFilter(sql, access.age)}
        ${buildLibraryGroupFilter(sql, options.libraryGroupId)}
        ${keywordFilter(options.tag)} ${keywordFilter(options.keyword)}
        ${options.year !== undefined ? sql`AND mi.year = ${options.year}` : sql``}`;
    const baseFilter = sql`${sharedFilter} ${buildGenreMembershipFilter(sql, options.genre)}`;
    const letterFilter = options.letter
        ? options.letter === '#'
            ? sql`AND ${sortTitle} !~ '^[a-z]'`
            : sql`AND ${sortTitle} LIKE ${options.letter.toLowerCase() + '%'}`
        : sql``;
    const filter = sql`${baseFilter} ${letterFilter}`;
    const rating = sql`COALESCE(NULLIF(CASE WHEN pm.metadata->>'imdb_rating' ~ '^[0-9]+([.][0-9]+)?$' THEN (pm.metadata->>'imdb_rating')::float END, 0), CASE WHEN pm.metadata->>'vote_average' ~ '^[0-9]+([.][0-9]+)?$' THEN (pm.metadata->>'vote_average')::float END)`;
    const runtime = sql`COALESCE(CASE WHEN pm.metadata->>'runtime_minutes' ~ '^[0-9]+$' THEN (pm.metadata->>'runtime_minutes')::integer END, mi.runtime_seconds / 60.0)`;
    const key =
        options.sort === 'title'
            ? sortTitle
            : options.sort === 'added'
              ? sql`COALESCE(mi.library_added_at, mi.created_at)`
              : options.sort === 'year'
                ? sql`mi.year`
                : options.sort === 'rating'
                  ? rating
                  : runtime;
    const direction = options.order === 'asc' ? sql`ASC` : sql`DESC`;
    const [rows, count] = await Promise.all([
        sql<
            Array<{
                id: string;
                title: string;
                media_type: string;
                year: number | null;
                resume_position_ms: number | null;
                runtime_ms: number | null;
                watched: boolean | null;
                last_event_at: Date | null;
            }>
        >`
            SELECT mi.id, mi.title, mi.media_type, mi.year, uws.resume_position_ms,
                COALESCE(NULLIF(uws.runtime_ms, 0), ROUND(mi.runtime_seconds * 1000)) AS runtime_ms, uws.is_watched AS watched, uws.last_event_at
            FROM media_items mi ${buildMetadataLateralJoinFragment(sql)}
            LEFT JOIN user_media_state uws ON uws.media_id = mi.id AND uws.user_id = ${user.userId}::uuid
            WHERE ${filter}
            ORDER BY ${key} ${direction} NULLS LAST, mi.id ${direction}
            LIMIT ${options.limit} OFFSET ${options.offset}`,
        sql<
            Array<{ count: string }>
        >`SELECT count(*)::text AS count FROM media_items mi WHERE ${filter}`,
    ]);
    const [metadata, externalIds] = await Promise.all([
        getMediaRailMetadataBatch(
            sql,
            rows.map((row) => row.id),
        ),
        rows.length
            ? sql<Array<{ media_id: string; provider: string; external_id: string }>>`
            SELECT media_id, provider, external_id FROM external_ids WHERE media_id = ANY(${rows.map(
                (row) => row.id,
            )}::uuid[])`
            : [],
    ]);
    const idsByMedia = new Map<string, Record<string, string>>();
    for (const ext of externalIds) {
        const ids = idsByMedia.get(ext.media_id) ?? {};
        ids[ext.provider] = ext.external_id;
        idsByMedia.set(ext.media_id, ids);
    }
    const items = await buildMediaPreviews(
        sql,
        surface,
        rows.map((row) => {
            const meta = metadata.get(row.id);
            return {
                id: row.id,
                type: row.media_type,
                title: row.title,
                year: row.year,
                ids: idsByMedia.get(row.id),
                overview: meta?.overview,
                runtimeMinutes: meta?.runtimeMinutes,
                genres: meta?.genres ?? [],
                rating: meta ? pickDisplayRating(meta) : undefined,
                isAvailable: true,
                hasFile: true,
                canRequest: false,
                progress: {
                    positionMs:
                        row.resume_position_ms == null ? null : Number(row.resume_position_ms),
                    durationMs: row.runtime_ms == null ? null : Number(row.runtime_ms),
                    finished: row.watched ?? false,
                    updatedAt: row.last_event_at,
                },
            };
        }),
    );
    const total = Number(count[0]?.count ?? 0);
    const page = {
        limit: options.limit,
        offset: options.offset,
        total,
        hasMore: options.offset + options.limit < total,
    };
    if (options.include !== 'facets') return { items, page };
    const { GenreService } = await import('./genre.service.js');
    const { getMetadataProviderChain } = await import('$lib/server/utils/provider-config.js');
    const chain = getMetadataProviderChain().filter((provider) => /^[a-z0-9_]+$/i.test(provider));
    const genreIds = GenreService.getAllGenres().map((genre) => genre.id);
    const genreNames = GenreService.getAllGenres().map((genre) => genre.name);
    const genreLabel = sql`COALESCE((${genreNames}::text[])[array_position(${genreIds}::int[], mg.genre_id)], mg.genre_name)`;
    const [letters, genres] = await Promise.all([
        sql<
            Array<{ letter: string; count: number }>
        >`SELECT CASE WHEN left(${sortTitle}, 1) ~ '^[a-z]$'
            THEN upper(left(${sortTitle}, 1)) ELSE '#' END AS letter, count(*)::integer AS count
            FROM media_items mi WHERE ${baseFilter} GROUP BY 1 ORDER BY 1`,
        sql<Array<{ name: string; count: number }>>`
            WITH named AS (
                SELECT mg.media_id, ${genreLabel} AS name, array_position(${chain}::text[], mg.source) AS rank
                FROM media_genres mg WHERE mg.source = ANY(${chain}::text[]) AND ${genreLabel} IS NOT NULL
            ), best AS (SELECT media_id, min(rank) AS rank FROM named GROUP BY media_id)
            SELECT named.name, count(DISTINCT mi.id)::integer AS count
            FROM media_items mi JOIN best ON best.media_id = mi.id
            JOIN named ON named.media_id = mi.id AND named.rank = best.rank
            WHERE ${sharedFilter} ${letterFilter}
            GROUP BY named.name ORDER BY count DESC, named.name ASC`,
    ]);
    return { items, page, facets: { letterCounts: letters, genreCounts: genres } };
}
