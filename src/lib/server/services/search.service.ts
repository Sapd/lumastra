// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Example names are fictional; production shapes and measurements are retained.
 * SearchService — the stateless cross-entity search orchestrator.
 *
 * Extracted (behavior-preserving) from `defs/search/search.ts` and reused by
 * `defs/search/suggest.ts`. It owns the *mechanics* of search; the def layer
 * keeps request parsing, schema validation, auth/age-rating gating,
 * feature-flag checks, and the final json()/paginate response.
 *
 * What lives here:
 *   - the per-source row → SearchResultItem mappers (catalog FTS+trigram,
 *     episode pattern, music, audiobooks, Kavita, external aggregation,
 *     non-entertainment),
 *   - the cross-source rank-band normalization (squash / normalizeRank +
 *     the SOURCE_BAND constants),
 *   - the global merge + excludeTerms filter + stable sort + window/hasMore
 *     pagination,
 *   - a lighter title-only fan-out (`suggestCore`) that powers the typeahead.
 *
 * DI is an EXPLICIT options object: every call is handed `sql`, the query, the
 * pagination window, the access scope (`deniedGroupIds`, `ageRating`), the
 * gating flags (`showUnavailableMedia`, `liveTvAllowed`), the `surface`, and
 * the in-scope source toggles. NOTHING request-derived is stored on the
 * service — the methods are static and pure-with-respect-to-their-arguments.
 *
 * Fault model (unchanged):
 *   - CORE DB sources (movies/series FTS+trigram, episode title, music) do NOT
 *     swallow errors — a throw propagates to the caller so the def can map it to
 *     503 dependency_unavailable.
 *   - OPTIONAL sources (Kavita, audiobooks, external aggregation,
 *     non-entertainment) are internally `.catch(() => [])` so a down auxiliary
 *     degrades to zero rows for that source only.
 */

import type { Sql } from 'postgres';
import type { PlaybackProgress } from '$lib/schemas/playback-progress.js';
import {
    searchMedia,
    searchMediaFulltext,
    searchMediaTrigram,
    searchEpisode,
    searchMusic,
} from '$lib/server/database/queries/search.queries.js';
import {
    AUDIOBOOKSHELF_PROVIDER,
    AUDIOBOOK_MEDIA_TYPE,
    getAbsItemIdsByMediaIds,
} from '$lib/server/database/queries/audiobooks.queries.js';
import { parseEpisodeQuery } from '$lib/server/utils/suggestion-utils.js';
import { toPublicMediaType } from '$lib/shared/media-type-domain';
import { SEARCH_RESULT_TYPES, type SearchResultType } from '$lib/schemas/api-search-responses.js';
import { createExternalIds } from '$lib/utils/external-ids.js';
import { config, features } from '$lib/server/config.js';
import type { AgeRatingFilterParams } from '$lib/server/database/queries/builders/age-rating.builder.js';
import { restrictedAccess } from '$lib/server/database/queries/builders/media-access-boundary.js';
import type { MediaAccessBoundary } from '$lib/server/database/queries/builders/media-access-boundary.js';
import { buildImageRefs, type ApiSurface } from '$lib/shared/api-urls.js';
import { Logger } from '$lib/server/utils/logger.js';

const logger = Logger.for('SearchService');

// ---------------------------------------------------------------------------
// Pagination safety
// ---------------------------------------------------------------------------

/**
 * Hard ceiling on the offset accepted by the full search fan-out.
 *
 * The per-source window is `offset + limit + 1`, so deep pagination fans a
 * proportionally large LIMIT to every source (O(offset) cost). Clamping here
 * keeps the worst-case window bounded. Clients needing item 1001+ should use
 * a narrowed query or a different surface (e.g. A-Z browse with letter filter).
 *
 * 1000 is chosen to match the schema-level max offset (browse.ts allows
 * offset up to Number.MAX_SAFE_INTEGER, but we enforce a practical bound here
 * to protect every DB source simultaneously).
 */
export const MAX_SEARCH_OFFSET = 1000;

// ---------------------------------------------------------------------------
// Optional-source deadline
// ---------------------------------------------------------------------------

/**
 * How long the fan-out waits for a network-backed OPTIONAL source before
 * dropping its contribution.
 *
 * The bound has to live here rather than in the source's own client, because a
 * source choosing its own timeout is a source choosing how long *the whole
 * search* takes: `fanOut` joins every lane with `Promise.all`. Kavita made two
 * sequential calls at `TIMEOUTS.DEFAULT` (10s) each, so a slow-but-alive server
 * could hold a search for ~20s — and not just the books, the movies too.
 *
 * 1500ms is calibrated against the neighbouring budgets: `decorateCards` gets
 * 50ms (per-card hot path), `homeSections` 500ms (once per page load), and
 * MediaAggregationService already races its own external calls at 3000ms. This
 * path is user-blocking and typed into, so it sits at the tighter end —
 * generous enough for a two-phase call to a remote Kavita over a home link,
 * short enough that one sick dependency does not make the search box feel
 * broken.
 */
export const OPTIONAL_SOURCE_DEADLINE_MS = 1500;

/**
 * Bound one optional lane, degrading to `fallback` when it overruns OR throws.
 *
 * The helper owns BOTH fault modes deliberately. Leaving the lane to catch its
 * own rejection outside the race means a failure landing after the deadline
 * gets logged a second time, with a stack, about a response that shipped
 * seconds ago — and the two logs disagree about what happened. Here the race's
 * outcome decides which one is true.
 *
 * `Promise.race` picks a winner; it does NOT cancel the loser. So the overrun
 * work keeps running, and its eventual rejection still needs a handler or it
 * surfaces as an unhandled rejection with no request left to attribute it to.
 * That handler is the `.catch` below, which is attached synchronously.
 *
 * The `AbortSignal` is how a lane finds out nobody is waiting any more. It
 * cannot unsend an in-flight request, but a multi-step lane can decline to
 * start the next step.
 */
function withDeadline<T>(opts: {
    run: (signal: AbortSignal) => Promise<T>;
    ms: number;
    fallback: T;
    label: string;
    /** Called once if the lane is dropped, so the caller can mark the page incomplete. */
    onOverrun?: () => void;
}): Promise<T> {
    const { run, ms, fallback, label } = opts;
    const controller = new AbortController();
    let decided = false;
    let timer: ReturnType<typeof setTimeout> | undefined;

    const deadline = new Promise<T>((resolve) => {
        timer = setTimeout(() => {
            decided = true;
            controller.abort();
            logger.warn(`${label} exceeded its ${ms}ms deadline — dropping its results`);
            opts.onOverrun?.();
            resolve(fallback);
        }, ms);
    });

    const work = run(controller.signal).catch((error) => {
        // Before the deadline this IS the lane's verdict, and it degrades to
        // the fallback exactly as the lane's own catch used to. After it, the
        // race is already decided and nobody is listening — absorb silently.
        if (!decided) logger.warn(`${label} failed`, error as Error);
        return fallback;
    });

    return Promise.race([work, deadline]).finally(() => {
        decided = true;
        clearTimeout(timer);
    });
}

// ---------------------------------------------------------------------------
// Cross-entity public search type discriminator
// ---------------------------------------------------------------------------

/** The catalog discriminator ('series', NOT 'tv'). */
export type CatalogSearchType = 'movie' | 'series' | 'episode' | 'track' | 'album' | 'artist';

// SEARCH_RESULT_TYPES / SearchResultType now live in the light schema module
// ($lib/schemas/api-search-responses.ts) so the OpenAPI generator can import the
// enum without pulling this heavy service chain (cache/tasks/lua) under tsx.
// Re-exported here for existing consumers of search.service.
export { SEARCH_RESULT_TYPES, type SearchResultType };

/**
 * Map internal DB media_type → canonical catalog discriminator ('tv' → 'series').
 * Delegates to the shared {@link toPublicMediaType}, then drops the public
 * values this narrower boundary cannot represent:
 *
 * - `season` — seasons are not standalone catalog search results.
 * - `audiobook` — books ARE a search result type, but they are not a *catalog*
 *   one: `searchAudiobookRows` queries them separately and maps them with
 *   `mapAudiobookRow`, which emits `type: 'audiobook'` directly. Returning
 *   them here would let a book leak into the movie/series mapper, which builds
 *   TMDB/IMDB id slots a book does not have.
 */
export function toCatalogType(dbType: string): CatalogSearchType | null {
    const p = toPublicMediaType(dbType);
    if (p === 'season' || p === 'audiobook') return null;
    return p;
}

// ---------------------------------------------------------------------------
// Result shapes
// ---------------------------------------------------------------------------

export type ImageRefs =
    ReturnType<typeof buildImageRefs> | { poster: { href: string }; backdrop?: { href: string } };

/**
 * A single v1 search result — a self-describing cross-entity handle.
 *
 * `images{}` carries hrefs; there is NEVER a flat `imageUrl`. Catalog/music use
 * the resolvable byte route (size presets); external sources emit a single
 * `poster.href` pointing at the source's cover/logo url.
 */
export interface SearchResultItem {
    id: string;
    type: SearchResultType;
    ids: Record<string, string>;
    title: string;
    matchedTitle?: string;
    year?: number;
    overview?: string;
    /** Episode-only: parent series coordinates. */
    seriesId?: string;
    seriesName?: string;
    seasonNumber?: number;
    episodeNumber?: number;
    /** Music tracks: parent album title (structured — `overview` is display-only). */
    album?: string;
    /** Music tracks: duration in seconds. */
    duration?: number;
    /** Music rows: performing artist UUID — makes card subtitles clickable. */
    artistId?: string;
    /**
     * Music rows: performing artist display NAME (structured — `overview` is
     * display-only). A track reports its album artist, an album its own.
     */
    artist?: string;
    /** Music tracks: parent album UUID — card background click opens it without a lookup. */
    albumId?: string;
    /**
     * Structured per-track artists (tag order) so track titles/credits can be
     * linkified on the client. Track rows only — undefined for albums/artists.
     */
    artists?: { id?: string; title: string }[];
    remixerArtists?: { id?: string; title: string }[];
    /** Jellyseerr request rows: the underlying request media type (movie|tv). */
    requestMediaType?: string;
    /** Kavita rows: library id used to build the external deep link. */
    libraryId?: number;
    /** Book rows: author display name (from Kavita series metadata). */
    author?: string;
    /**
     * Audiobook rows: the caller's own listening state, decorated by the def
     * AFTER its access-scoped (NOT per-user) page cache — never set by the
     * service itself, or it would be cached and served to the wrong viewer.
     */
    progress?: PlaybackProgress;
    /**
     * Library-backed rows (movie/series/episode/audiobook/track/album): the
     * item has a file (`media_items.has_files`), so it can be played. `false`
     * marks a catalog-only title, shown only when the install enables
     * SHOW_UNAVAILABLE_MEDIA_IN_SEARCH. Undefined for rows that are not
     * library items (artists, requests, channels, Kavita books).
     */
    isAvailable?: boolean;
    images: ImageRefs;
    /** Normalized cross-source relevance score; drives the merge sort. */
    rank: number;
    /** Provenance of the match. */
    matchSource: string;
}

/** The canonical public MediaType discriminator for the lean typeahead item. */
export type PublicMediaType = CatalogSearchType;

/** A lean typeahead suggestion — title-only, no overview/ids/rank/matchSource. */
export interface SuggestItem {
    id: string;
    title: string;
    mediaType: PublicMediaType;
    year?: number;
    images: ReturnType<typeof buildImageRefs>;
    ids?: Record<string, string>;
    isAvailable?: boolean;
}

// ---------------------------------------------------------------------------
// Cross-source rank normalization
// ---------------------------------------------------------------------------

/**
 * Per-source rank scales differ wildly. We map each source's raw rank onto a
 * shared (0,1) band, then offset bands by source priority so exact matches
 * outrank fuzzy/auxiliary hits deterministically. The merged set is sorted by
 * this normalized value BEFORE pagination so page boundaries are stable.
 *
 * Bands (high → low):
 *   episode_pattern (5)  exact SxxEyy — always first
 *   fts (4)              full-text / title match (movies, series)
 *   fts / audiobook (4)  full-text title match over our own catalog
 *   episode / music (3)  in-catalog secondary text matches
 *   external (2)         books/manga/comic, requests, channels
 *   non_entertainment(2) home_video/training/educational/personal
 *   fuzzy (1)            trigram typo-tolerance — always last
 *
 * `audiobook` shares the `fts` band deliberately. Books are matched by the SAME
 * `searchMediaFulltext` primitive against the SAME `media_items.search_vector`
 * as movies and series, so their raw ranks are already on one scale and a
 * separate band would order them by source rather than by relevance. This is a
 * visible change: books used to be pinned below every catalog and music row by
 * the `external` band, and now interleave on merit.
 */
export const SOURCE_BAND: Record<string, number> = {
    episode_pattern: 5,
    fts: 4,
    audiobook: 4,
    episode: 3,
    music: 3,
    // Auxiliary / external sources interleave just below the catalog text
    // matches but above fuzzy typo hits — they are real hits, not guesses.
    external: 2,
    non_entertainment: 2,
    fuzzy: 1,
};

/** Squash an unbounded positive raw rank into (0,1) so bands never overlap. */
export function squash(raw: number | null | undefined): number {
    const r = typeof raw === 'number' && Number.isFinite(raw) && raw > 0 ? raw : 0;
    return r / (r + 1);
}

/** Combine source band + squashed raw rank into a single sortable score. */
export function normalizeRank(source: string, raw: number | null | undefined): number {
    const band = SOURCE_BAND[source] ?? 0;
    return band + squash(raw);
}

/** Wrap an external/source image url as an images{} poster entry. */
export function posterImage(url: string | null | undefined): ImageRefs | undefined {
    if (!url) return undefined;
    return { poster: { href: url } };
}

// ---------------------------------------------------------------------------
// Explicit DI option shapes
// ---------------------------------------------------------------------------

/**
 * The access scope every source query is run under, in the legacy permissive
 * pair form that the def layer and the still-unmigrated downstream consumers
 * (MediaAggregationService's `accessCtx`, `listItemsByLibraryType`) speak.
 *
 * Internally this is projected ONCE into a required-by-shape
 * {@link MediaAccessBoundary} (`fanOut`/`suggestFanOut`), and every
 * search.queries call takes that boundary — so no per-source helper can
 * accidentally omit an axis.
 */
interface LegacySearchAccessFields {
    deniedGroupIds: string[] | null;
    ageRating: AgeRatingFilterParams | null;
}

/** Options for the full cross-entity search fan-out (`SearchService.search`). */
export interface SearchServiceOptions extends LegacySearchAccessFields {
    sql: Sql;
    /** Already-normalized query ('*' for filter-only searches). */
    q: string;
    /** Pagination window — typically `offset + limit + 1`. */
    window: number;
    /** Slice bounds for the final page. */
    offset: number;
    limit: number;
    /** Whether to use the fulltext primitive vs the default searchMedia. */
    useFulltext: boolean;
    /** Catalog filter passthrough. */
    yearMin?: number;
    yearMax?: number;
    /** Soft hint from "Title (2019)": titles of that year rank first within their band. */
    yearHint?: number;
    ratingMin?: number;
    genres?: string[];
    /** Lowercased terms whose presence in title/overview excludes a result. */
    excludeTerms?: string[];
    /** Gating: include unavailable (not-in-library) titles. */
    showUnavailableMedia: boolean;
    /** Gating: caller may receive Live TV channels. */
    liveTvAllowed: boolean;
    /** Image href base for the resolvable byte route. */
    surface: ApiSurface;
    /** In-scope source toggles (resolved from the requested `types`). */
    sources: SearchSourceToggles;
}

/** Which sources participate in a given search (resolved by the def). */
export interface SearchSourceToggles {
    movies: boolean;
    series: boolean;
    episodes: boolean;
    music: boolean;
    /**
     * Which music row types the music source returns. Absent = all three.
     * `types=track` must mean tracks only: without this the music source
     * returned artists and albums for it too, so no client could page
     * through one section.
     */
    musicTypes?: readonly ('artist' | 'album' | 'track')[];
    books: boolean;
    audiobooks: boolean;
    requests: boolean;
    channels: boolean;
    /**
     * Non-entertainment library media types in scope (1:1 with the DB
     * media_type). Empty → that source is skipped entirely.
     */
    nonEntTypes: readonly ('home_video' | 'training' | 'educational' | 'personal')[];
}

/** The merged-and-paginated result of a full search. */
export interface SearchPage {
    items: SearchResultItem[];
    hasMore: boolean;
    /**
     * An optional source was dropped for overrunning its deadline, so this page
     * is a known-incomplete answer to the query.
     *
     * Server-side only — it never reaches the wire (the def builds its response
     * from `items` and `hasMore` explicitly). Its job is to stop the def
     * caching an incomplete page for the full 45s TTL and serving it to
     * everyone else in the access scope.
     *
     * ABSENT rather than `false` on the healthy path, so the cached JSON of a
     * complete page is byte-identical to what it was before this field existed.
     */
    degraded?: boolean;
}

/** Options for the lean typeahead fan-out (`SearchService.suggest`). */
export interface SuggestServiceOptions extends LegacySearchAccessFields {
    sql: Sql;
    /** Already-trimmed query. */
    q: string;
    /** Pagination window — typically `limit + 1`. */
    window: number;
    limit: number;
    showUnavailableMedia: boolean;
    surface: ApiSurface;
    sources: {
        movies: boolean;
        series: boolean;
        episodes: boolean;
        music: boolean;
    };
}

/** The merged-and-sliced result of a suggest fan-out. */
export interface SuggestPage {
    items: SuggestItem[];
    truncated: boolean;
}

// ---------------------------------------------------------------------------
// Same-type run capping
// ---------------------------------------------------------------------------

/**
 * How many results of one type may appear consecutively before another type
 * gets a turn.
 *
 * 4 is chosen against the query that motivated this. On prod, "milo farrow"
 * matches 27 audiobooks and 14 movies, and the books edge the films on rank —
 * so a purely rank-ordered page put 27 books at indices 0–26 and the first film
 * at 27, i.e. off a 40-item page's useful area. 4 puts a film on screen within
 * the first handful without burying the books, which is the point: the server
 * declines to decide whether "milo farrow" means the films or the books, and
 * shows both.
 *
 * Note the symmetry — before audiobooks joined the catalog band the same page
 * was 100% films and the first book sat at offset 362. One shared scale over an
 * unbalanced corpus fails in whichever direction the corpus is heavier. This is
 * a presentation fix for that, not a re-ranking: {@link normalizeRank} is
 * untouched and the result SET is identical.
 */
export const MAX_SAME_TYPE_RUN = 4;

/**
 * Rank step that preserves searchMusic's row order among equal ranks (see
 * searchMusicRows). The window is at most ~1000 rows, so the total shift stays
 * below 1e-6 — far under the gap between any two real rank values.
 */
const MUSIC_ORDER_EPSILON = 1e-9;

/**
 * Reorder a rank-sorted list so no more than `maxRun` consecutive items share a
 * `type`, promoting the next-best item of another type instead.
 *
 * ⚠️ Promotion is confined to items in the SAME rank band. `normalizeRank`
 * encodes the band in the integer part (fts/audiobook 4, episode/music 3,
 * external 2, fuzzy 1) and the relevance in the fraction, so comparing
 * `Math.floor(rank)` asks "is this alternative a peer, or a worse KIND of
 * match?". Without that guard the cap would haul a band-1 trigram guess above a
 * wall of band-4 exact title matches every fifth row — trading a crowded page
 * for a wrong one, which is a bad trade at any run length.
 *
 * When no same-band alternative exists the run simply continues: the cap is a
 * preference, never a reason to withhold a result or to reorder across bands.
 *
 * Stable and total: items are consumed from per-type queues that preserve the
 * incoming order, and every input appears exactly once in the output. Output
 * length always equals input length — asserted in the tests, because a
 * dedup/starvation bug here would silently delete search results.
 */
export function capTypeRuns(
    sorted: readonly SearchResultItem[],
    maxRun: number,
): SearchResultItem[] {
    if (maxRun <= 0 || sorted.length <= maxRun) return [...sorted];

    // Per-type queues, each already in the caller's sort order.
    const queues = new Map<string, SearchResultItem[]>();
    for (const item of sorted) {
        const q = queues.get(item.type);
        if (q) q.push(item);
        else queues.set(item.type, [item]);
    }
    // Single-type result sets have nothing to interleave — the common case for
    // a scoped search, and worth not walking the loop for.
    if (queues.size <= 1) return [...sorted];

    const out: SearchResultItem[] = [];
    let lastType: string | null = null;
    let run = 0;

    for (let emitted = 0; emitted < sorted.length; emitted++) {
        const capped = lastType !== null && run >= maxRun ? lastType : null;

        // Best remaining head overall, and the best head of any OTHER type that
        // sits in the same band as it. Heads are compared by rank alone: each
        // queue is already in the caller's fully-ordered sequence, so ties are
        // resolved by insertion order, which preserves the incoming sort.
        let best: { type: string; item: SearchResultItem } | null = null;
        for (const [type, q] of queues) {
            const head = q[0];
            if (!head) continue;
            if (!best || head.rank > best.item.rank) best = { type, item: head };
        }
        if (!best) break; // unreachable while emitted < sorted.length

        let chosen = best;
        if (capped !== null && best.type === capped) {
            const band = Math.floor(best.item.rank);
            let alt: { type: string; item: SearchResultItem } | null = null;
            for (const [type, q] of queues) {
                if (type === capped) continue;
                const head = q[0];
                if (!head || Math.floor(head.rank) !== band) continue;
                if (!alt || head.rank > alt.item.rank) alt = { type, item: head };
            }
            if (alt) chosen = alt;
        }

        const q = queues.get(chosen.type)!;
        q.shift();
        if (q.length === 0) queues.delete(chosen.type);
        out.push(chosen.item);

        if (chosen.type === lastType) {
            run++;
        } else {
            lastType = chosen.type;
            run = 1;
        }
    }

    return out;
}

// ---------------------------------------------------------------------------
// SearchService — stateless orchestrator
// ---------------------------------------------------------------------------

export const SearchService = {
    // -----------------------------------------------------------------------
    // Public: full cross-entity search
    // -----------------------------------------------------------------------

    /**
     * Fan out across every in-scope source, merge, apply the excludeTerms
     * filter, globally stable-sort by normalized rank, then window-paginate.
     *
     * CORE DB failures propagate (caller maps to 503); optional sources degrade
     * to [] internally.
     */
    async search(opts: SearchServiceOptions): Promise<SearchPage> {
        const { items, degraded } = await SearchService.fanOut(opts);
        const page = SearchService.mergeAndPaginate(items, opts);
        return degraded ? { ...page, degraded: true } : page;
    },

    /**
     * Run every in-scope source and collect their mapped items (unsorted,
     * unfiltered, unpaginated). Throws on a CORE DB failure; optional sources
     * are fault-isolated to [].
     *
     * `degraded` is true when a lane was dropped for overrunning its deadline.
     * A lane that FAILED is not degraded: a down Kavita returns no books and
     * that is the honest, stable answer to cache. A lane that timed out might
     * have had books, so the same query a second later can legitimately answer
     * differently — that is the case worth keeping out of a 45s cache.
     */
    async fanOut(
        opts: SearchServiceOptions,
    ): Promise<{ items: SearchResultItem[]; degraded: boolean }> {
        const { sql, q } = opts;
        const access: MediaAccessBoundary = restrictedAccess({
            deniedGroupIds: opts.deniedGroupIds ?? [],
            maxAgeRating: opts.ageRating?.maxAgeRating ?? null,
            allowUnrated: opts.ageRating?.allowUnrated ?? false,
        });
        const items: SearchResultItem[] = [];
        let degraded = false;

        // ── Episode pattern fast-path (e.g. "Quiet Orbit S03E12") ──
        const episodePattern = parseEpisodeQuery(q);
        if (episodePattern && opts.sources.episodes) {
            const episodeResults = await searchEpisode(
                sql,
                episodePattern.seriesName,
                episodePattern.season,
                episodePattern.episode,
                access,
                // Episodes are never requestable on their own: a missing one is
                // not a discovery candidate, whatever the search switch says.
                { availableOnly: true },
            );
            for (const ep of episodeResults) {
                items.push(SearchService.mapEpisodePatternRow(ep, opts.surface));
            }
            // Pure DB lane, no deadline involved — never degraded.
            return { items, degraded: false };
        }

        // ── Parallel searches across the in-scope sources ──
        // Each task is internally fault-isolated (legacy parity): an optional
        // source throwing degrades to [] for that source only, never failing
        // the whole search.
        const tasks: Promise<SearchResultItem[]>[] = [];

        // 1. Movies + series (FTS, optional trigram typo tolerance).
        if (opts.sources.movies || opts.sources.series) {
            tasks.push(SearchService.searchCatalog(opts, access));
            // CORE source: a DB failure here is a dependency fault. We do NOT
            // swallow it — it propagates to the caller → 503 (contract).
        }

        // 2. Episode title search.
        if (opts.sources.episodes) {
            tasks.push(SearchService.searchEpisodeTitles(opts, access));
            // CORE source: DB failure propagates → 503 (contract).
        }

        // 3. Music tracks / albums / artists.
        if (opts.sources.music) {
            tasks.push(SearchService.searchMusicRows(opts, access));
            // CORE source: DB failure propagates → 503 (contract).
        }

        // 4. Kavita books / manga / comics (optional, feature-gated).
        if (opts.sources.books && features.kavita) {
            // Deadline is HOST-owned: the lane's own client timeouts bound
            // Kavita's patience, not ours. See OPTIONAL_SOURCE_DEADLINE_MS.
            tasks.push(
                withDeadline({
                    run: (signal) => SearchService.searchKavita(opts, signal),
                    ms: OPTIONAL_SOURCE_DEADLINE_MS,
                    fallback: [] as SearchResultItem[],
                    label: 'Kavita search',
                    onOverrun: () => {
                        degraded = true;
                    },
                }),
            );
        }

        // 5. Audiobooks — OUR catalog, not a live AudiobookShelf call.
        //
        // This used to go out to ABS with the raw query string, which ABS
        // matches as one contiguous substring: "potter fire" and "potter feuer"
        // both returned zero while "feuerkel" (an infix) matched, because no
        // one on either side tokenised. Every ABS book already has a
        // `media_items` row with a populated `search_vector` (a DB trigger
        // maintains it over title/english_title/original_title/overview, with
        // unaccent + German digraph folding), so the same primitive the movie
        // and episode sources use answers these queries correctly and
        // order-independently — and gives books a real rank instead of the flat
        // `normalizeRank('external', null)`.
        if (opts.sources.audiobooks && features.audiobooks) {
            tasks.push(
                SearchService.searchAudiobookRows(opts, access).catch((error) => {
                    // Kept optional rather than promoted to a CORE source: the
                    // audiobook lane is feature-gated and was fault-isolated
                    // when it lived behind searchExternal. A book-shaped DB
                    // failure must not 503 a movie search.
                    logger.warn('Audiobook search failed', error as Error);
                    return [];
                }),
            );
        }

        // 6. External aggregation: requests (Jellyseerr), Live TV channels.
        if (opts.sources.requests || opts.sources.channels) {
            tasks.push(
                SearchService.searchExternal(opts).catch((error) => {
                    logger.warn('External aggregation search failed', error as Error);
                    return [];
                }),
            );
        }

        // 7. Non-entertainment libraries (home_video / training / educational /
        //    personal).
        if (opts.sources.nonEntTypes.length > 0) {
            tasks.push(
                SearchService.searchNonEntertainment(opts).catch((error) => {
                    logger.warn('Non-entertainment search failed', error as Error);
                    return [];
                }),
            );
        }

        const settled = await Promise.all(tasks);
        for (const group of settled) items.push(...group);
        return { items, degraded };
    },

    /**
     * Apply the excludeTerms filter, globally stable-sort by normalized rank,
     * cap same-type runs, then window-paginate. Pure transform — no I/O.
     */
    mergeAndPaginate(items: SearchResultItem[], opts: SearchServiceOptions): SearchPage {
        // ── Client-side filters (parity with legacy) ──
        let merged = items;
        const excludeTerms = opts.excludeTerms;
        if (excludeTerms && excludeTerms.length > 0) {
            merged = merged.filter((item) => {
                const title = item.title.toLowerCase();
                const overview = (item.overview ?? '').toLowerCase();
                return !excludeTerms.some(
                    (term) => title.includes(term) || overview.includes(term),
                );
            });
        }

        // ── Global stable sort, THEN paginate (fixes page-boundary churn) ──
        const yearHint = opts.yearHint;
        merged.sort((a, b) => {
            // A year hint reorders WITHIN a rank band only (never lifts a fuzzy
            // typo hit over an exact title match).
            if (yearHint !== undefined) {
                const sameBand = Math.floor(a.rank) === Math.floor(b.rank);
                const yearDelta = Number(b.year === yearHint) - Number(a.year === yearHint);
                if (sameBand && yearDelta !== 0) return yearDelta;
            }
            if (b.rank !== a.rank) return b.rank - a.rank;
            const t = a.title.localeCompare(b.title);
            if (t !== 0) return t;
            return a.id.localeCompare(b.id);
        });

        // ── Break up same-type walls, THEN paginate ──
        // Applied to the whole list rather than to the page, so item→position
        // is one function of the whole result set and pages stay disjoint and
        // stable. Capping after slicing would reorder within a page while the
        // page boundaries stayed put, which is how you get an item on two pages.
        merged = capTypeRuns(merged, MAX_SAME_TYPE_RUN);

        const hasMore = merged.length > opts.offset + opts.limit;
        const page = merged.slice(opts.offset, opts.offset + opts.limit);
        return { items: page, hasMore };
    },

    // -----------------------------------------------------------------------
    // Public: lean typeahead
    // -----------------------------------------------------------------------

    /**
     * The lighter title-only fan-out powering `GET /search/suggest`. No
     * episode-pattern fast-path, no fuzzy pass, no external aggregation, no
     * rank bands — title relevance is the user's mental model. CORE DB failures
     * propagate.
     */
    async suggest(opts: SuggestServiceOptions): Promise<SuggestPage> {
        const items = await SearchService.suggestFanOut(opts);

        // FTS rows arrive rank-ordered per source; the merge across sources
        // needs a stable order, so sort by title then id (typeahead has no
        // cross-source rank band — exact/prefix boosts already float the best
        // title to the front within each source).
        items.sort((a, b) => {
            const t = a.title.localeCompare(b.title);
            if (t !== 0) return t;
            return a.id.localeCompare(b.id);
        });

        const truncated = items.length > opts.limit;
        const page = items.slice(0, opts.limit);
        return { items: page, truncated };
    },

    /** Run the in-scope title-only sources for the typeahead. */
    async suggestFanOut(opts: SuggestServiceOptions): Promise<SuggestItem[]> {
        const { sql, q } = opts;
        const access: MediaAccessBoundary = restrictedAccess({
            deniedGroupIds: opts.deniedGroupIds ?? [],
            maxAgeRating: opts.ageRating?.maxAgeRating ?? null,
            allowUnrated: opts.ageRating?.allowUnrated ?? false,
        });
        const items: SuggestItem[] = [];
        const tasks: Promise<SuggestItem[]>[] = [];

        // Movies + series + episodes — title-only FTS (no fuzzy pass). Episodes
        // always require a file inside the query itself (searchMediaFulltext).
        const dbTypes: ('movie' | 'tv' | 'episode')[] = [];
        if (opts.sources.movies) dbTypes.push('movie');
        if (opts.sources.series) dbTypes.push('tv');
        if (opts.sources.episodes) dbTypes.push('episode');
        if (dbTypes.length > 0) {
            tasks.push(
                (async (): Promise<SuggestItem[]> => {
                    const rows = await searchMediaFulltext(sql, q, access, {
                        limit: opts.window,
                        offset: 0,
                        mediaTypes: dbTypes,
                        availableOnly: !opts.showUnavailableMedia,
                    });
                    const out: SuggestItem[] = [];
                    for (const row of rows) {
                        const item = SearchService.mapSuggestRow(row, opts.surface);
                        if (item) out.push(item);
                    }
                    return out;
                })(),
            );
        }

        // Music tracks / albums / artists.
        if (opts.sources.music) {
            tasks.push(
                (async (): Promise<SuggestItem[]> => {
                    const rows = await searchMusic(sql, q, opts.window, access, {
                        offset: 0,
                        excludeVariousArtists: true,
                        playableOnly: true,
                    });
                    const out: SuggestItem[] = [];
                    for (const row of rows) {
                        const item = SearchService.mapSuggestMusicRow(row, opts.surface);
                        if (item) out.push(item);
                    }
                    return out;
                })(),
            );
        }

        const settled = await Promise.all(tasks);
        for (const group of settled) items.push(...group);
        return items;
    },

    // -----------------------------------------------------------------------
    // Per-source query + map helpers (full search)
    // -----------------------------------------------------------------------

    /** 1. Movies + series catalog: FTS (or default) + optional trigram fuzzy. */
    async searchCatalog(
        opts: SearchServiceOptions,
        access: MediaAccessBoundary,
    ): Promise<SearchResultItem[]> {
        const { sql, q } = opts;
        const mediaTypes: ('movie' | 'tv')[] = [];
        if (opts.sources.movies) mediaTypes.push('movie');
        if (opts.sources.series) mediaTypes.push('tv');

        const searchOpts = {
            limit: opts.window,
            offset: 0,
            mediaTypes,
            availableOnly: !opts.showUnavailableMedia,
            filters: {
                yearMin: opts.yearMin,
                yearMax: opts.yearMax,
                ratingMin: opts.ratingMin,
                genres: opts.genres,
            },
        };

        const ftsRows = opts.useFulltext
            ? await searchMediaFulltext(sql, q, access, searchOpts)
            : await searchMedia(sql, q, access, searchOpts);

        const typoMode = config.SEARCH_TYPO_TOLERANCE;
        const typoMin = config.SEARCH_TYPO_MIN_RESULTS;
        let fuzzyRows: Awaited<ReturnType<typeof searchMediaTrigram>> = [];
        if (typoMode === 'always' || (typoMode === 'fallback' && ftsRows.length < typoMin)) {
            const ftsIds = ftsRows.map((r) => r.internal_id).filter((id): id is string => !!id);
            fuzzyRows = await searchMediaTrigram(sql, q, access, searchOpts, ftsIds);
        }

        const out: SearchResultItem[] = [];
        for (const r of ftsRows) {
            const m = SearchService.mapCatalogRow(r, 'fts', opts.surface);
            if (m) out.push(m);
        }
        for (const r of fuzzyRows) {
            const m = SearchService.mapCatalogRow(r, 'fuzzy', opts.surface);
            if (m) out.push(m);
        }
        return out;
    },

    /** 2. Episode title search. */
    async searchEpisodeTitles(
        opts: SearchServiceOptions,
        access: MediaAccessBoundary,
    ): Promise<SearchResultItem[]> {
        const rows = await searchMediaFulltext(opts.sql, opts.q, access, {
            limit: opts.window,
            offset: 0,
            mediaTypes: ['episode'],
            includeDescriptions: opts.useFulltext === true,
            // Episodes always require a file: a missing one is not requestable.
            availableOnly: true,
        });
        const out: SearchResultItem[] = [];
        for (const row of rows) {
            const item = SearchService.mapEpisodeTitleRow(row, opts.surface);
            if (item) out.push(item);
        }
        return out;
    },

    /** 3. Music tracks / albums / artists. */
    async searchMusicRows(
        opts: SearchServiceOptions,
        access: MediaAccessBoundary,
    ): Promise<SearchResultItem[]> {
        const rows = await searchMusic(opts.sql, opts.q, opts.window, access, {
            offset: 0,
            excludeVariousArtists: true,
            playableOnly: true,
            mediaTypes: opts.sources.musicTypes,
            popularitySource: config.MUSIC_POPULARITY_PRIMARY_SOURCE,
        });
        const out: SearchResultItem[] = [];
        for (const row of rows) {
            const item = SearchService.mapMusicRow(row, opts.surface);
            if (!item) continue;
            // Keep searchMusic's order for equal ranks. mergeAndPaginate breaks
            // ties by title with localeCompare, which (a) drops the popularity
            // and artist>album>track keys the SQL ordered by, and (b) disagrees
            // with the DB collation, so a row just outside one page's DB window
            // could sort into the middle of the next window and paging skipped
            // a song. A per-position epsilon far below any real rank gap makes
            // the SQL order the tiebreak; distinct ranks are unaffected.
            item.rank -= out.length * MUSIC_ORDER_EPSILON;
            out.push(item);
        }
        return out;
    },

    /**
     * 4. Kavita books / manga / comics.
     *
     * Two sequential round trips, so `signal` is checked between them: once the
     * host deadline has passed nobody is waiting for this lane, and issuing the
     * metadata call anyway would hold a second socket for up to another
     * `TIMEOUTS.DEFAULT` (10s) per abandoned search. At typeahead rates against
     * a slow Kavita those accumulate instead of being shed. The first call
     * cannot be unsent — cancelling that needs the signal threaded into the
     * Kavita client itself.
     */
    async searchKavita(
        opts: SearchServiceOptions,
        signal?: AbortSignal,
    ): Promise<SearchResultItem[]> {
        const kavita = await import('$lib/server/plugins/kavita/index.js');
        const kavitaResults = await kavita.search({
            query: opts.q,
            includeChapterAndFiles: false,
        });
        if (signal?.aborted) return [];
        const seriesIds = kavitaResults.series?.map((s) => s.seriesId) ?? [];
        const metadataMap =
            seriesIds.length > 0 ? await kavita.getSeriesMetadataBatch(seriesIds) : new Map();
        const transformed = kavita.transformSearchResults(kavitaResults, metadataMap);
        const out: SearchResultItem[] = [];
        for (const item of transformed) {
            const mapped = SearchService.mapKavitaRow(item);
            if (mapped) out.push(mapped);
        }
        return out;
    },

    /**
     * 5. Audiobooks, from our own `media_items` rows.
     *
     * Same `searchMediaFulltext` primitive as movies/series/episodes, narrowed
     * to `media_type = 'audiobook'`, so tokenisation, unaccenting, German
     * digraph folding, the access boundary and the rank scale are shared rather
     * than reimplemented. See the fan-out comment for why this replaced the
     * live AudiobookShelf call.
     */
    async searchAudiobookRows(
        opts: SearchServiceOptions,
        access: MediaAccessBoundary,
    ): Promise<SearchResultItem[]> {
        const rows = await searchMediaFulltext(opts.sql, opts.q, access, {
            limit: opts.window,
            offset: 0,
            mediaTypes: [AUDIOBOOK_MEDIA_TYPE],
            includeDescriptions: opts.useFulltext === true,
            availableOnly: !opts.showUnavailableMedia,
        });
        if (rows.length === 0) return [];

        // The ABS item id is not a column on the search projection, so fill the
        // provider slots in one batch. A failure here must not lose the hits:
        // the ids are needed for the deep link out to AudiobookShelf, not to
        // open the book in Lumastra (which keys off `ids.internal`).
        const mediaIds = rows.map((row) => row.internal_id).filter((id): id is string => !!id);
        const absIds = await getAbsItemIdsByMediaIds(opts.sql, mediaIds).catch((error) => {
            logger.warn('Audiobook external-id lookup failed', error as Error);
            return new Map<string, string>();
        });

        const out: SearchResultItem[] = [];
        for (const row of rows) {
            const item = SearchService.mapAudiobookRow(row, absIds, opts.surface);
            if (item) out.push(item);
        }
        return out;
    },

    /** 6. External aggregation: requests, Live TV channels. */
    async searchExternal(opts: SearchServiceOptions): Promise<SearchResultItem[]> {
        const sources: ('livetv' | 'jellyseerr')[] = [];
        if (opts.sources.channels) sources.push('livetv');
        if (opts.sources.requests) sources.push('jellyseerr');

        const { MediaAggregationService } =
            await import('$lib/server/services/media-aggregation.service.js');
        // The aggregation cache key must be partitioned by the caller's
        // access scope (deniedGroupIds/ageRating/liveTvAllowed), not just
        // liveTvAllowed — see SearchAcrossServicesOptions.accessCtx doc.
        // `username` isn't consulted by the cache-key builder; SearchServiceOptions
        // doesn't carry it, so it's omitted here (null) rather than plumbed
        // through for a field the key never reads.
        const aggregated = await MediaAggregationService.searchAcrossServices(opts.q, {
            maxResults: opts.limit,
            sources: [...new Set(sources)],
            timeout: 2500,
            liveTvAllowed: opts.liveTvAllowed,
            accessCtx: {
                username: null,
                deniedGroupIds: opts.deniedGroupIds,
                ageRating: opts.ageRating,
                liveTvAllowed: opts.liveTvAllowed,
                showUnavailableMedia: opts.showUnavailableMedia,
            },
        });

        const out: SearchResultItem[] = [];
        for (const item of aggregated.items) {
            const mapped = SearchService.mapExternalRow(item, opts.sources);
            if (mapped) out.push(mapped);
        }
        return out;
    },

    /** 6. Non-entertainment libraries (home_video / training / …). */
    async searchNonEntertainment(opts: SearchServiceOptions): Promise<SearchResultItem[]> {
        const { listItemsByLibraryType } =
            await import('$lib/server/database/queries/non-entertainment-browse.queries.js');
        // Project the legacy permissive pair ONCE into the required-by-shape
        // boundary, exactly as `fanOut`/`suggestFanOut` do, so every per-type
        // call below is gated by the same value.
        const access: MediaAccessBoundary = restrictedAccess({
            deniedGroupIds: opts.deniedGroupIds ?? [],
            maxAgeRating: opts.ageRating?.maxAgeRating ?? null,
            allowUnrated: opts.ageRating?.allowUnrated ?? false,
        });
        const perType = await Promise.all(
            opts.sources.nonEntTypes.map(async (mediaType) => {
                const { items: rows } = await listItemsByLibraryType(opts.sql, {
                    mediaType,
                    search: opts.q === '*' ? undefined : opts.q,
                    limit: opts.window,
                    offset: 0,
                    access,
                });
                return rows.map((row) =>
                    SearchService.mapNonEntertainmentRow(row, mediaType, opts.surface),
                );
            }),
        );
        return perType.flat();
    },

    // -----------------------------------------------------------------------
    // Row → SearchResultItem mappers (pure)
    // -----------------------------------------------------------------------

    /** Episode-pattern fast-path row → item. */
    mapEpisodePatternRow(
        ep: Awaited<ReturnType<typeof searchEpisode>>[number],
        surface: ApiSurface,
    ): SearchResultItem {
        const seriesExt: Parameters<typeof createExternalIds>[0] = {
            internal: ep.series_internal_id,
        };
        if (ep.series_ext_provider === 'tmdb') seriesExt.tmdb = ep.series_ext_id;
        else if (ep.series_ext_provider === 'tvdb') seriesExt.tvdb = ep.series_ext_id;
        else if (ep.series_ext_provider === 'imdb') seriesExt.imdb = ep.series_ext_id;
        else if (ep.series_ext_provider === 'trakt') seriesExt.trakt = ep.series_ext_id;
        return {
            id: ep.id,
            type: 'episode',
            ids: createExternalIds(seriesExt),
            title: ep.title,
            overview: ep.overview ?? undefined,
            year: ep.series_year ?? undefined,
            seriesId: ep.series_internal_id,
            seriesName: ep.series_name ?? undefined,
            seasonNumber: ep.season_number,
            episodeNumber: ep.episode_number,
            isAvailable: ep.is_available ?? false,
            images: buildImageRefs(ep.series_internal_id, surface),
            rank: normalizeRank('episode_pattern', 1),
            matchSource: 'episode_pattern',
        };
    },

    /** Catalog FTS / trigram row → item. */
    mapCatalogRow(
        row: Awaited<ReturnType<typeof searchMedia>>[number] & {
            match_source?: string;
            search_source?: string;
        },
        source: 'fts' | 'fuzzy',
        surface: ApiSurface,
    ): SearchResultItem | null {
        const type = toCatalogType(row.media_type);
        if (!type) return null;
        const internalId = row.internal_id ?? null;
        const id = internalId || `tmdb:${row.tmdb_id}:${type}`;
        const ids = createExternalIds({
            internal: internalId,
            tmdb: row.tmdb_id || undefined,
            imdb: row.imdb_id || undefined,
        }) as Record<string, string>;
        const year = row.release_date ? new Date(row.release_date).getFullYear() : undefined;
        return {
            id,
            type,
            ids,
            title: row.title,
            year,
            overview: row.overview ?? undefined,
            // Catalog video always carries an explicit boolean; a row that did not select
            // availability is reported unavailable rather than leaving clients to guess.
            isAvailable: row.is_available ?? false,
            images: buildImageRefs(id, surface),
            rank: normalizeRank(source, row.rank),
            matchSource: source === 'fuzzy' ? 'fuzzy' : (row.match_source ?? 'fts'),
        };
    },

    /** Episode-title FTS row → item. */
    mapEpisodeTitleRow(
        row: Awaited<ReturnType<typeof searchMediaFulltext>>[number],
        surface: ApiSurface,
    ): SearchResultItem | null {
        const internalId = row.internal_id ?? null;
        if (!internalId) return null;
        const ids = createExternalIds({
            internal: internalId,
            tmdb: row.tmdb_id || undefined,
            imdb: row.imdb_id || undefined,
        }) as Record<string, string>;
        const year = row.release_date ? new Date(row.release_date).getFullYear() : undefined;
        return {
            id: internalId,
            type: 'episode',
            ids,
            title: row.title,
            year,
            overview: row.overview ?? undefined,
            isAvailable: row.is_available ?? false,
            images: buildImageRefs(internalId, surface),
            rank: normalizeRank('episode', row.rank),
            matchSource: row.match_source ?? 'episode',
        };
    },

    /** Music row → item. */
    mapMusicRow(
        row: Awaited<ReturnType<typeof searchMusic>>[number],
        surface: ApiSurface,
    ): SearchResultItem | null {
        const type = toCatalogType(row.media_type);
        if (!type) return null;
        const ids = createExternalIds({ internal: row.id }) as Record<string, string>;
        return {
            id: row.id,
            type,
            ids,
            title: row.title,
            year: row.year ?? undefined,
            overview: row.artist_name
                ? row.album_title
                    ? `${row.artist_name} · ${row.album_title}`
                    : row.artist_name
                : undefined,
            // The same artist name `overview` renders into a display string,
            // exposed structurally: a client that wants to label a row cannot
            // parse "Artist · Album" back apart safely (either half may contain
            // the separator), and albums carried an artistId with no name to
            // show for it. `overview` keeps its display form for existing
            // clients. Album rows report their own artist, tracks their album's.
            artist: row.artist_name ?? undefined,
            // Structured album/duration so pickers can tell duplicate copies
            // of the same track apart (album_title is track-only per the
            // query's CASE; runtime_seconds is whatever the row carries).
            album: row.album_title ?? undefined,
            duration: row.runtime_seconds ?? undefined,
            // Structured entity ids: cards use these for the clickable artist
            // subtitle and to open a track's parent album without a lookup.
            artistId: row.artist_id ?? undefined,
            albumId: row.album_id ?? undefined,
            // Structured per-track artists (tag order) so track titles/credits can be
            // linkified on the client. Track rows only — NULL for albums/artists.
            artists: row.track_artists
                ? row.track_artists.map((artist) => ({
                      id: artist.id ?? undefined,
                      title: artist.title,
                  }))
                : undefined,
            remixerArtists: row.remixer_artists?.map((artist) => ({
                id: artist.id ?? undefined,
                title: artist.title,
            })),
            // searchMusicRows passes `playableOnly`, so every track/album that
            // reaches here has a file. Artists are not library items.
            ...(type !== 'artist' ? { isAvailable: true } : {}),
            images: buildImageRefs(row.image_source_id ?? row.id, surface),
            rank: normalizeRank('music', row.rank),
            matchSource: 'music',
        };
    },

    /** Kavita transformed row → item (book/manga/comic only). */
    mapKavitaRow(item: {
        id: string;
        mediaType: string;
        title: string;
        overview?: string | null;
        author?: string | null;
        year?: number | null;
        libraryId?: string | number;
        imageUrl?: string | null;
    }): SearchResultItem | null {
        // transformer yields mediaType ∈ book|manga|comic and an `imageUrl`
        // cover href. Only book/manga/comic series are deep-linkable; the
        // transformer maps every Kavita row to one of those.
        if (item.mediaType !== 'book' && item.mediaType !== 'manga' && item.mediaType !== 'comic') {
            return null;
        }
        const type = item.mediaType;
        // The transformer ids are `kavita-{kind}-{id}`. Recover the bare source
        // id and expose it in its own `kavita` slot for the openKavitaItem()
        // deep-link fallback.
        const sourceId = item.id.replace(/^kavita-[a-z]+-/, '');
        const libraryId =
            typeof item.libraryId === 'string' ? Number(item.libraryId) : item.libraryId;
        return {
            id: item.id,
            type,
            ids: createExternalIds({
                internal: item.id,
                kavita: sourceId || undefined,
            }),
            title: item.title,
            year: item.year ?? undefined,
            overview: item.overview ?? undefined,
            author: item.author ?? undefined,
            libraryId: libraryId != null && Number.isFinite(libraryId) ? libraryId : undefined,
            images: posterImage(item.imageUrl) ?? { poster: { href: '' } },
            rank: normalizeRank('external', null),
            matchSource: 'kavita',
        };
    },

    /**
     * Audiobook `media_items` row → item.
     *
     * `images` uses the resolvable byte route keyed by the internal UUID — the
     * SAME url `audiobookEntryToCard` builds for the browse grid, so a book's
     * cover is now byte-identical between search and browse. It used to be a
     * raw AudiobookShelf url passed straight through to the browser, which
     * coupled the client to ABS being reachable.
     */
    mapAudiobookRow(
        row: Awaited<ReturnType<typeof searchMediaFulltext>>[number],
        absItemIds: Map<string, string>,
        surface: ApiSurface,
    ): SearchResultItem | null {
        const internalId = row.internal_id ?? null;
        if (!internalId) return null;
        const absItemId = absItemIds.get(internalId);
        const ids: Record<string, string> = { internal: internalId };
        if (absItemId) {
            // The AudiobookShelf library item id has its own provider slot.
            // (It used to be duplicated into the `jellyfin` slot; responses no
            // longer carry Jellyfin ids at all.)
            ids[AUDIOBOOKSHELF_PROVIDER] = absItemId;
        }
        const year = row.release_date ? new Date(row.release_date).getFullYear() : undefined;
        return {
            id: internalId,
            type: AUDIOBOOK_MEDIA_TYPE,
            ids,
            title: row.title,
            year,
            overview: row.overview ?? undefined,
            ...(row.is_available !== undefined ? { isAvailable: row.is_available } : {}),
            images: buildImageRefs(internalId, surface),
            rank: normalizeRank('audiobook', row.rank),
            matchSource: row.match_source ?? 'title',
        };
    },

    /** External-aggregation row → item (request / tvchannel). */
    mapExternalRow(
        item: {
            id: string;
            mediaType?: string;
            title: string;
            year?: number | null;
            overview?: string | null;
            imageUrl?: string | null;
            externalIds?: Record<string, string>;
            requestMediaType?: string;
        },
        sources: SearchSourceToggles,
    ): SearchResultItem | null {
        const itemType = item.mediaType?.toLowerCase();
        // Skip rows we own via a DB task — catalog, and (since books moved to
        // the local catalog pass) audiobooks. An 'audiobook' reaching here at
        // all would be a duplicate of a row `searchAudiobookRows` already
        // emitted, with a worse id and a worse rank.
        if (
            itemType === 'movie' ||
            itemType === 'tv' ||
            itemType === 'episode' ||
            itemType === AUDIOBOOK_MEDIA_TYPE
        ) {
            return null;
        }

        if (sources.requests && itemType === 'anfragen') {
            return {
                id: item.id,
                type: 'request',
                ids: item.externalIds ?? {},
                title: item.title,
                year: item.year ?? undefined,
                overview: item.overview ?? undefined,
                requestMediaType: item.requestMediaType ?? 'movie',
                images: posterImage(item.imageUrl) ?? { poster: { href: '' } },
                rank: normalizeRank('external', null),
                matchSource: 'jellyseerr',
            };
        }
        if (sources.channels && itemType === 'tvchannel') {
            return {
                id: item.id,
                type: 'tvchannel',
                ids: createExternalIds({ internal: item.id }),
                title: item.title,
                overview: item.overview ?? undefined,
                images: posterImage(item.imageUrl) ?? { poster: { href: '' } },
                rank: normalizeRank('external', null),
                matchSource: 'livetv',
            };
        }
        return null;
    },

    /** Non-entertainment library row → item. */
    mapNonEntertainmentRow(
        row: {
            id: string;
            title: string;
            has_files: boolean;
            release_year?: number | null;
            overview?: string | null;
            custom_poster_url?: string | null;
        },
        mediaType: 'home_video' | 'training' | 'educational' | 'personal',
        surface: ApiSurface,
    ): SearchResultItem {
        return {
            id: row.id,
            type: mediaType,
            ids: createExternalIds({ internal: row.id }),
            title: row.title,
            year: row.release_year ?? undefined,
            isAvailable: row.has_files,
            overview: row.overview ?? undefined,
            images:
                posterImage(row.custom_poster_url) ??
                // Fall back to the resolvable byte route (these ARE catalog UUIDs).
                buildImageRefs(row.id, surface),
            rank: normalizeRank('non_entertainment', null),
            matchSource: `library:${mediaType}`,
        };
    },

    // -----------------------------------------------------------------------
    // Row → SuggestItem mappers (pure)
    // -----------------------------------------------------------------------

    /** Catalog FTS row → lean suggestion. */
    mapSuggestRow(
        row: Awaited<ReturnType<typeof searchMediaFulltext>>[number],
        surface: ApiSurface,
    ): SuggestItem | null {
        const type = toCatalogType(row.media_type);
        if (!type) return null;
        // Image entity = internal UUID when present (episodes inherit the
        // series poster via the parent CTE); otherwise the composite key.
        const id = row.internal_id || `tmdb:${row.tmdb_id}:${type}`;
        const year = row.release_date ? new Date(row.release_date).getFullYear() : undefined;
        return {
            id,
            title: row.title,
            ids: {
                ...(row.tmdb_id ? { tmdb: String(row.tmdb_id) } : {}),
                ...(row.imdb_id ? { imdb: row.imdb_id } : {}),
            },
            isAvailable: row.is_available ?? false,
            mediaType: type,
            year,
            images: buildImageRefs(id, surface),
        };
    },

    /** Music row → lean suggestion. */
    mapSuggestMusicRow(
        row: Awaited<ReturnType<typeof searchMusic>>[number],
        surface: ApiSurface,
    ): SuggestItem | null {
        const type = toCatalogType(row.media_type);
        if (!type) return null;
        return {
            id: row.id,
            title: row.title,
            ids: {},
            isAvailable: type === 'artist' ? undefined : true,
            mediaType: type,
            year: row.year ?? undefined,
            images: buildImageRefs(row.image_source_id ?? row.id, surface),
        };
    },
};
