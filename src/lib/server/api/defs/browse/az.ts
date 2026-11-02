// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * defs/browse/az.ts — GET /api/browse/az
 *
 * Returns media items sorted alphabetically. Supports letter-bucket filtering,
 * media-type filter, library-group filter, genre filter, keyword/tag filter,
 * and offset-based pagination.
 *
 * Contract:
 *   GET /browse/az?type&letter&offset&limit&libraryGroupId&genre&tag&res&hdr&codec&qUnknown
 *     → bare AzBrowseResponse (items, totalCount, hasMore, letterCounts,
 *       genreCounts, keywordCounts, …)
 *
 * Auth: user.  Surface: public.
 * 503 dependency_unavailable when DB is down.
 */

import { json } from '@sveltejs/kit';
import { defineEndpoint } from '$lib/server/api/define.js';
import { ApiProblem } from '$lib/server/api/problem.js';
import { getDb } from '$lib/server/database/connection.js';
import { azQuerySchema } from '$lib/schemas/browse.js';
import type { UniversalMediaItem } from '$lib/types/server-driven-ui.js';
import {
    getAlphabeticalBucketCounts,
    getGenreFacetCounts,
    getKeywordFacetCounts,
    getMediaAlphabetical,
} from '$lib/server/database/queries/browse.queries.js';
import { CACHE_NAMESPACES, cacheManager } from '$lib/server/cache/index.js';
import { getPrimaryExternalIdProvider } from '$lib/server/utils/provider-config.js';
import { toMovieOrSeries } from '$lib/shared/media-type-domain';
import {
    browseScopedCacheKey,
    buildSearchAccessContext,
    searchAccessBoundary,
} from '$lib/server/utils/search-access-context.js';
import { FALLBACK_IMAGE } from '$lib/constants/images.js';
import { entityImageUrl } from '$lib/shared/api-urls.js';
import { Logger } from '$lib/server/utils/logger.js';
import { config } from '$lib/server/config.js';
import { pickDisplayRating } from '$lib/server/utils/rating-utils.js';
import { AzBrowseResponseSchema } from '$lib/schemas/api-browse-responses';
import { trimItemOverview } from '$lib/server/utils/truncate-overview.js';

const logger = Logger.for('Browse:AZ');

const azCache = cacheManager.for(CACHE_NAMESPACES.browseAZ);

/**
 * Hard cap on the `keywordCounts` facet shipped with every page.
 *
 * This field rides on EVERY /browse/az response, so its size is not optional
 * bookkeeping: un-capped it measured ~3.2-4.0 MB per response on a production
 * catalog (84k groups, 2s uncached, tens of MB of temp spill), the client
 * Zod-validated all 84k entries per page fetch, and `browseAZ`'s L1 is a
 * count-based LRU (maxSize 500 ENTRIES, not bytes) so each cached page held
 * 10-15 MB of heap.
 *
 * The curated-vocabulary gate in `queryKeywordFacets` already bounds
 * cardinality at |ALLOWED_KEYWORDS|; this cap is deliberately independent of it
 * so widening that vocabulary can never re-inflate the payload. A rail cannot
 * render more than a few dozen pills anyway — a client wanting the long tail
 * pages through /browse/tags.
 */
const KEYWORD_FACET_MAX = 50;

interface AZPageCacheData {
    items: Array<{
        internal_id?: string | null;
        primary_ext_id?: number | null;
        media_type: string;
        title: string;
        poster_path?: string | null;
        backdrop_path?: string | null;
        tmdb_rating?: number | null;
        imdb_rating?: number | null;
        vote_count?: number | null;
        rt_rating?: number | null;
        rt_audience_score?: number | null;
        release_date?: string | null;
        release_year?: number | null;
        overview?: string | null;
        is_available?: boolean | null;
    }>;
    totalCount: number;
}

export const def = defineEndpoint({
    // Internal /api/browse route retained for the web until the client migration.
    // v1 consumers use GET /media; the v1 A–Z and genre mounts were removed.
    docs: {
        visibility: 'internal',
        GET: {
            tags: ['Browse'],
            summary: 'Browse the catalog alphabetically (A–Z)',
            stability: 'beta',
            auth: 'bearer',
            description:
                'Returns a page of catalog items sorted alphabetically with letter-bucket ' +
                'filtering (`letter` = A–Z or `#`), media-type filter (`type`), ' +
                'library-group filter (`libraryGroupId`), genre filter (`genre`), keyword/tag ' +
                'filter (`tag`), and offset-based pagination. Every filter composes — ' +
                '`genre` and `tag` are not separate modes, so "Anime + Action + whodunit, ' +
                'newest first" is one request. Alongside the page of items it returns ' +
                '`letterCounts` — the per-bucket counts for building an A–Z jump ' +
                'navigator — `genreCounts`, the same idea on the genre axis (only genres ' +
                'with content, computed with the `genre` filter itself excluded so a ' +
                'client can switch genres from one response), and `keywordCounts`, the ' +
                'same idea on the keyword/tag axis (computed with the `tag` filter itself ' +
                'excluded).',
            query: azQuerySchema,
            responses: {
                200: {
                    schema: AzBrowseResponseSchema,
                    description: 'Alphabetical media page with letter-bucket counts',
                },
                401: 'Authentication required',
                422: 'Validation failed',
                503: 'Database unavailable',
                500: 'Internal server error',
            },
        },
    },

    auth: { kind: 'user' },
    visibility: 'internal',
    request: {
        query: azQuerySchema,
    },
    handlers: {
        GET: async (event, ctx) => {
            const {
                type: mediaType,
                offset,
                limit,
                letter,
                libraryGroupId,
                genre,
                tag,
                audio,
                subs,
                includeUnknown,
                sort,
                res,
                hdr,
                codec,
                qUnknown,
                q,
            } = ctx.input!.query;
            // Translate canonical public value to the internal DB discriminator.
            const dbMediaType: 'movie' | 'tv' | 'all' = mediaType === 'series' ? 'tv' : mediaType;

            const sql = getDb();
            if (!sql) {
                return ApiProblem.dependencyUnavailable('Database not available');
            }

            const accessCtx = await buildSearchAccessContext(sql, event.locals.user);
            const access = searchAccessBoundary(accessCtx);

            // v10: fold the `genre` filter into the page and bucket cache keys
            // (v9 folded in the res/hdr/codec/qUnknown QUALITY filter; v8 folded in
            // `sort` on the page key only; v7 folded in the audio/subs/includeUnknown
            // language filter on both) so genre-filtered results and bucket counts
            // never collide with unfiltered ones. Page cache key includes
            // offset+limit so each page is cached independently. Use dbMediaType in
            // cache keys so 'series' and legacy 'tv' hit the same slot.
            const langKey = `${audio.join('+') || '-'}:${subs.join('+') || '-'}:${includeUnknown ? 'u' : ''}`;
            const qKey = `${res.join('+') || '-'}:${hdr.join('+') || '-'}:${codec.join('+') || '-'}:${qUnknown ? 'u' : ''}`;
            // `genre` is the only FREE-FORM component in these keys (every other
            // one is a UUID, a single regex-checked letter, or an allow-listed
            // enum), so it gets encoded rather than interpolated raw:
            //   - percent-encoding keeps '|' out of the key. browseScopedCacheKey
            //     reserves '|' as the access-suffix delimiter and THROWS on it —
            //     and these keys are built before the handler's try block, so a
            //     genre containing '|' would 500 instead of matching nothing.
            //   - case is preserved: the SQL match is case-SENSITIVE (as it is on
            //     /browse/genre/{name}), so 'Action' and 'action' are different
            //     filters returning different rows and must not share an entry.
            //   - the 'g_' prefix keeps every present-genre key distinct from the
            //     absent-genre sentinel, which a literal ?genre=- would otherwise
            //     collide with.
            const genreKey = genre ? `g_${encodeURIComponent(genre)}` : '-';
            // `tag` is free-form like `genre` (values carry spaces: "time travel"),
            // so it gets the same treatment: percent-encoded because
            // browseScopedCacheKey THROWS on '|' and these keys are built before the
            // try block, and 't_'-prefixed so a literal ?tag=- can't collide with the
            // absent sentinel. Unlike genre, the value is lowercased first — the
            // projection column is lowercased, so the match is case-insensitive and
            // 'Whodunit'/'whodunit' MUST share a cache entry.
            const tagKey = tag ? `t_${encodeURIComponent(tag.trim().toLowerCase())}` : '-';
            // Free-form like `genre`/`tag`, so it gets the same encoding treatment —
            // and note `qKey` above is the QUALITY key, not this one. Lowercased
            // because the match is accent- and case-insensitive, so "Dune" and
            // "dune" MUST share an entry. Folded into ALL FOUR keys below: the
            // facet counts are computed under the query too, so a cached count
            // from an unfiltered read would describe a different set.
            const textKey = q ? `q_${encodeURIComponent(q.trim().toLowerCase())}` : '-';
            // An active query suppresses the letter in SQL, so it must collapse
            // here too — otherwise ?q=dune&letter=A and ?q=dune&letter=B key two
            // entries for one identical result set. (`sort`'s own letter gate
            // needs no such handling: sort is already a key component.)
            const pageLetterKey = q ? 'all' : letter?.toUpperCase() || 'all';
            const pageCacheKey = browseScopedCacheKey(
                `v13page:${dbMediaType}:${pageLetterKey}:${libraryGroupId || 'all'}:${genreKey}:${tagKey}:${langKey}:${qKey}:${sort}:${offset}:${limit}:${textKey}`,
                accessCtx,
            );
            // Bucket counts only exist for the title sorts (they drive the
            // letter-jump rail, which is hidden client-side for the other sorts) —
            // buckets are sort-independent among themselves, so the cache key
            // doesn't need `sort` folded in. It DOES need `genre`/`tag`: with a
            // genre or tag selected the rail must only offer letters that have
            // content in it.
            const bucketCacheKey = browseScopedCacheKey(
                `v12buckets:${dbMediaType}:${libraryGroupId || 'all'}:${genreKey}:${tagKey}:${langKey}:${qKey}:${textKey}`,
                accessCtx,
            );
            const wantsLetterRail = sort === 'title_asc' || sort === 'title_desc';
            // The genre facet is scoped by everything EXCEPT genre (a facet must
            // not narrow over its own axis) — so no genreKey here — and by the
            // letter only when the letter is actually in effect, mirroring
            // getMediaAlphabetical's own `effectiveLetterFragment` gate. It DOES
            // gain `tagKey`: a genre count under an active tag must count only
            // tagged titles, matching what the grid itself would return.
            // `!q` mirrors getMediaAlphabetical's own gate: an active query
            // suppresses the letter, so a facet key built with a stale letter
            // would key a count the grid never applies.
            const effectiveLetter = wantsLetterRail && !q ? letter : undefined;
            const genreFacetCacheKey = browseScopedCacheKey(
                `v4genrefacets:${dbMediaType}:${effectiveLetter?.toUpperCase() || 'all'}:${libraryGroupId || 'all'}:${tagKey}:${langKey}:${qKey}:${textKey}`,
                accessCtx,
            );
            // The keyword facet is the mirror of the genre facet: scoped by
            // everything EXCEPT its own axis, so it carries `genreKey` but NOT
            // `tagKey` — a facet must never narrow over its own axis.
            const keywordFacetCacheKey = browseScopedCacheKey(
                `v4keywordfacets:${dbMediaType}:${effectiveLetter?.toUpperCase() || 'all'}:${libraryGroupId || 'all'}:${genreKey}:${langKey}:${qKey}:${textKey}`,
                accessCtx,
            );

            try {
                let result: AZPageCacheData;

                const cached = await azCache.get<AZPageCacheData>(pageCacheKey);
                if (cached) {
                    result = cached;
                } else {
                    // Fetch only the requested page from SQL (LIMIT/OFFSET pushed to DB).
                    result = await getMediaAlphabetical(sql, {
                        mediaType: dbMediaType,
                        limit,
                        offset,
                        letter,
                        availableOnly: true,
                        groupId: libraryGroupId,
                        genreName: genre,
                        keyword: tag,
                        access,
                        query: q,
                        audioLangs: audio,
                        subLangs: subs,
                        includeUnknown,
                        sort,
                        resolutions: res,
                        hdr,
                        codecs: codec,
                        qualityIncludeUnknown: qUnknown,
                    });
                    await azCache.set(pageCacheKey, result);
                }

                // The letter-jump rail only applies to the title sorts — skip the
                // bucket query entirely for the others and return an empty list
                // (the UI hides the rail when sort isn't title_asc/title_desc).
                let letterCounts: Array<{ letter: string; count: number }> = [];
                if (wantsLetterRail) {
                    const cachedBuckets =
                        await azCache.get<Array<{ letter: string; count: number }>>(bucketCacheKey);
                    if (cachedBuckets) {
                        letterCounts = cachedBuckets;
                    } else {
                        const buckets = await getAlphabeticalBucketCounts(sql, {
                            mediaType: dbMediaType,
                            availableOnly: true,
                            groupId: libraryGroupId,
                            genreName: genre,
                            keyword: tag,
                            access,
                            query: q,
                            audioLangs: audio,
                            subLangs: subs,
                            includeUnknown,
                            resolutions: res,
                            hdr,
                            codecs: codec,
                            qualityIncludeUnknown: qUnknown,
                        });
                        letterCounts = buckets.map((b) => ({ letter: b.bucket, count: b.count }));
                        await azCache.set(bucketCacheKey, letterCounts);
                    }
                }

                // Genre facet — always computed (a genre rail is meaningful under
                // every sort, unlike the letter rail) and cached under its own
                // genre-independent key, so the whole rail costs one extra cache
                // read per request and one aggregate per filter combination.
                //
                // Failure here is contained: the facet is a navigation aid, so a
                // broken rail must not take down the grid the caller actually
                // asked for. getGenreFacetCounts RETHROWS rather than returning
                // [], which lets this degrade to an empty rail while deliberately
                // NOT caching that emptiness — otherwise one transient error would
                // assert "this catalog has no genres" for the namespace TTL.
                // /browse/genres makes the opposite call and 500s.
                let genreCounts =
                    await azCache.get<Array<{ name: string; count: number }>>(genreFacetCacheKey);
                if (!genreCounts) {
                    try {
                        const facets = await getGenreFacetCounts(sql, {
                            mediaType: dbMediaType,
                            availableOnly: true,
                            letter: effectiveLetter,
                            groupId: libraryGroupId,
                            keyword: tag,
                            access,
                            query: q,
                            audioLangs: audio,
                            subLangs: subs,
                            includeUnknown,
                            resolutions: res,
                            hdr,
                            codecs: codec,
                            qualityIncludeUnknown: qUnknown,
                        });
                        genreCounts = facets.map((g) => ({ name: g.genre, count: g.count }));
                        await azCache.set(genreFacetCacheKey, genreCounts);
                    } catch (error) {
                        logger.warn('Genre facet unavailable; serving page without it', {
                            error: (error as Error).message,
                        });
                        genreCounts = [];
                    }
                }

                // Keyword facet — same contract as the genre facet above: scoped by
                // every axis EXCEPT its own, rethrown by the query layer, and
                // degraded to an empty rail WITHOUT caching so one transient failure
                // can't assert "this catalog has no tags" for the namespace TTL.
                let keywordCounts =
                    await azCache.get<Array<{ keyword: string; count: number }>>(
                        keywordFacetCacheKey,
                    );
                if (!keywordCounts) {
                    try {
                        keywordCounts = await getKeywordFacetCounts(sql, {
                            mediaType: dbMediaType,
                            availableOnly: true,
                            letter: effectiveLetter,
                            groupId: libraryGroupId,
                            genreName: genre,
                            access,
                            query: q,
                            audioLangs: audio,
                            subLangs: subs,
                            includeUnknown,
                            resolutions: res,
                            hdr,
                            codecs: codec,
                            qualityIncludeUnknown: qUnknown,
                            max: KEYWORD_FACET_MAX,
                        });
                        await azCache.set(keywordFacetCacheKey, keywordCounts);
                    } catch (error) {
                        logger.warn('Keyword facet unavailable; serving page without it', {
                            error: (error as Error).message,
                        });
                        keywordCounts = [];
                    }
                }

                const paginatedItems = result.items;

                const getPosterImage = (item: (typeof result.items)[0]): string => {
                    if (item.internal_id) {
                        return entityImageUrl(item.internal_id, 'poster', ctx.surface, {
                            size: 'thumb',
                        });
                    }
                    if (item.poster_path && item.primary_ext_id) {
                        return entityImageUrl(
                            `${getPrimaryExternalIdProvider()}:${item.primary_ext_id}:${item.media_type}`,
                            'poster',
                            ctx.surface,
                            { size: 'thumb' },
                        );
                    }
                    return FALLBACK_IMAGE;
                };

                const getBackdropImage = (item: (typeof result.items)[0]): string | undefined => {
                    if (item.internal_id) {
                        return entityImageUrl(item.internal_id, 'backdrop', ctx.surface, {
                            size: 'thumb',
                        });
                    }
                    if (item.backdrop_path && item.primary_ext_id) {
                        return entityImageUrl(
                            `${getPrimaryExternalIdProvider()}:${item.primary_ext_id}:${item.media_type}`,
                            'backdrop',
                            ctx.surface,
                            { size: 'thumb' },
                        );
                    }
                    return undefined;
                };

                const items: UniversalMediaItem[] = paginatedItems
                    .filter((item) => !!item.internal_id)
                    .map((item) => ({
                        id: item.internal_id!,
                        externalIds: {
                            internal: item.internal_id!,
                            ...(item.primary_ext_id != null
                                ? {
                                      [getPrimaryExternalIdProvider()]: String(item.primary_ext_id),
                                  }
                                : {}),
                        },
                        // Canonical: 'series' replaces 'tv'. getMediaAlphabetical's
                        // query filters `mi.media_type = ${mediaType}` or, for the
                        // 'all' filter, `mi.media_type IN ('movie', 'tv')` — this
                        // row can never be anything else.
                        // eslint-disable-next-line callback-safety/no-inline-media-type-default -- the alphabetical query is movie/TV-only.
                        mediaType: toMovieOrSeries(item.media_type) ?? 'movie',
                        title: item.title,
                        image: getPosterImage(item),
                        backdrop: getBackdropImage(item),
                        rating: pickDisplayRating({
                            imdbRating: item.imdb_rating,
                            tmdbRating: item.tmdb_rating,
                            voteCount: item.vote_count,
                        }),
                        voteCount: item.vote_count ?? undefined,
                        criticRating: item.rt_rating ?? undefined,
                        audienceRating: item.rt_audience_score ?? undefined,
                        year:
                            item.release_year ||
                            (item.release_date
                                ? new Date(item.release_date).getFullYear()
                                : undefined),
                        overview: item.overview || undefined,
                        isAvailable: item.is_available !== false,
                        canRequest: false,
                    }));

                // Per-user metadata-language overlay (multilingual-media-metadata
                // spec §5): resolved ONCE per request, applied AFTER the cached
                // page/bucket reads above. `items` was just freshly constructed by
                // the `.map()` call above (not a cache-resident reference), so it's
                // safe to overlay in place — no clone needed.
                const { enrichSeriesEpisodeCounts } =
                    await import('$lib/server/services/series-episode-counts.service.js');
                await enrichSeriesEpisodeCounts(sql, items, event.locals.user.userId, access);
                const userId = event.locals.user?.userId;
                if (userId && config.METADATA_ADDITIONAL_LANGUAGES.length > 0) {
                    const { resolveMetadataLanguage } =
                        await import('$lib/server/utils/metadata-language-resolve.js');
                    const { getPlaybackPreferences } =
                        await import('$lib/server/database/queries/user-preferences.queries.js');
                    const langs = resolveMetadataLanguage(
                        await getPlaybackPreferences.one(sql, { userId }),
                    );
                    if (langs.titleLang || langs.textLang) {
                        const { applyTranslationOverlay } =
                            await import('$lib/server/utils/translation-overlay.js');
                        await applyTranslationOverlay(sql, items, langs, {
                            id: (it) => it.id || null,
                            setTitle: (it, v) => {
                                it.title = v;
                            },
                            setOverview: (it, v) => {
                                it.overview = v;
                            },
                        });
                    }
                }

                // Overview truncation applies ONLY on the internal surface — this
                // def is also mounted at /api/v1/browse/az (see
                // routes/api/v1/browse/az), which must stay byte-identical for
                // native clients. See truncate-overview.ts.
                const responseItems =
                    ctx.surface === 'internal' ? items.map(trimItemOverview) : items;

                return json({
                    items: responseItems,
                    page: {
                        limit,
                        offset,
                        total: result.totalCount,
                        hasMore: offset + limit < result.totalCount,
                    },
                    // Echoes the applied `?type=` filter under the field name
                    // AzBrowseResponseSchema declares (`mediaType`) — not an item-level
                    // discriminator leak, so this is a deliberate passthrough.
                    // eslint-disable-next-line callback-safety/no-discriminator-leak-in-response
                    mediaType,
                    letter: letter || undefined,
                    libraryGroupId: libraryGroupId || undefined,
                    genre: genre || undefined,
                    tag: tag || undefined,
                    letterCounts,
                    genreCounts,
                    keywordCounts,
                });
            } catch (error) {
                logger.error('Failed to fetch media', error as Error);
                return ApiProblem.internalError('Failed to fetch media');
            }
        },
    },
});
