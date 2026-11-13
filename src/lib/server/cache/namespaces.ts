// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Cache Namespace Registry
 *
 * SINGLE SOURCE OF TRUTH for all cache namespaces.
 * All cache namespaces must be defined here to:
 * 1. Ensure type safety (compile-time errors for typos)
 * 2. Maintain consistent TTLs across the codebase
 * 3. Document the purpose of each cache
 * 4. Enable pre-registration for admin stats visibility
 *
 * USAGE (preferred - type-safe):
 * ```typescript
 * import { cacheManager, CACHE_NAMESPACES } from '$lib/server/cache';
 *
 * // This provides compile-time safety and automatic TTL configuration
 * const cache = cacheManager.for(CACHE_NAMESPACES.trending);
 * ```
 *
 * ADDING A NEW CACHE:
 * 1. Add the namespace config to CACHE_NAMESPACES below
 * 2. Use cacheManager.for(CACHE_NAMESPACES.yourCache) in your code
 * 3. The cache will automatically appear in admin stats
 *
 * UPDATING AN EXISTING CACHE (e.g., changing key format):
 * 1. Update the version suffix in the name (e.g., 'trending-v17' -> 'trending-v18')
 * 2. All code using cacheManager.for() will automatically use the new name
 *
 * 2026-10-13: every namespace whose payload carries media ids was bumped once
 * when Jellyfin item ids left the API responses, so no pre-deploy payload with
 * a Jellyfin id is served after the update.
 *
 * PLUGIN CACHES:
 * Plugins can use dynamic namespaces with the `plugin:` prefix without
 * pre-registration. Use `createPluginCacheConfig()` helper:
 * ```typescript
 * const cache = cacheManager.for(createPluginCacheConfig('my-plugin'));
 * ```
 */

/**
 * Cache namespace configuration
 */
export interface CacheNamespaceConfig {
    /** Unique namespace identifier - use versioned names when cache format changes */
    name: string;
    /** L1 (in-memory) TTL in milliseconds */
    l1TTL: number;
    /** L2 (Valkey/Redis) TTL in milliseconds */
    l2TTL: number;
    /** Description for documentation */
    description: string;
    /**
     * Protected caches are NOT cleared during "Clear All Caches" admin action.
     * Use for user preference data (dismiss state, exclusions) that shouldn't be
     * lost during routine cache maintenance.
     */
    protected?: boolean;
}

/**
 * All cache namespaces used in the application.
 * Use these constants instead of hardcoded strings.
 */
export const CACHE_NAMESPACES = {
    // =========================================================================
    // Trending & Discovery
    // =========================================================================

    /**
     * Trending content from TMDB/MDBList
     * Versioned to invalidate cache when API response format changes
     * v18: Added lazy provider initialization fix
     */
    /**
     * Trending TMDB/MDBList results, enriched with local catalog metadata.
     *
     * v19: cache key + value semantics changed. The DB enrichment
     * (fetchRatingsFromDb) now filters local rows by the caller's
     * deniedGroupIds + ageRating, and the cache key carries the same
     * access scope. Pre-v19 entries were built without the filter, so
     * could carry internal UUIDs / ratings / overview for items the
     * current caller cannot access. Bump invalidates those entries.
     */
    trending: {
        name: 'trending-v20',
        l1TTL: 5 * 60 * 1000, // 5 minutes
        l2TTL: 4 * 60 * 60 * 1000, // 4 hours
        description: 'Trending movies/shows from TMDB and MDBList',
    },

    // =========================================================================
    // Episode Tracking
    // =========================================================================

    /**
     * Upcoming episodes from calendar
     */
    upcomingEpisodes: {
        name: 'upcoming-episodes-v2',
        l1TTL: 5 * 60 * 1000, // 5 minutes
        l2TTL: 30 * 60 * 1000, // 30 minutes
        description: 'Upcoming episode releases from Sonarr',
    },

    /**
     * New unwatched episodes for users
     *
     * v2: cache scope switched from username to users.id UUID (mig 16.46.0).
     */
    newEpisodes: {
        name: 'new-episodes-v3',
        l1TTL: 5 * 60 * 1000, // 5 minutes
        l2TTL: 30 * 60 * 1000, // 30 minutes
        description: 'New episodes available for user to watch',
    },

    /**
     * Next episode to watch for a series
     */
    nextEpisode: {
        name: 'next-episode-v2',
        l1TTL: 5 * 60 * 1000, // 5 minutes
        l2TTL: 30 * 60 * 1000, // 30 minutes
        description: 'Next episode to continue watching',
    },

    /**
     * Season-structure auto-fix: negative-detection backoff per series.
     * Stores the unmatched-episode signature detection last failed on so an
     * unfixable series doesn't re-pay TMDB episode-group calls on every sync.
     */
    seasonStructureDetect: {
        name: 'season-structure-detect',
        l1TTL: 60 * 60 * 1000, // 1 hour
        l2TTL: 7 * 24 * 60 * 60 * 1000, // 7 days
        description: 'Season-structure auto-fix negative-detection backoff',
    },

    /**
     * Series excluded from new episodes notifications
     * PROTECTED: User preference data, not cleared during "Clear All Caches"
     */
    excludedSeries: {
        name: 'excluded-series-v2',
        l1TTL: 10 * 60 * 1000, // 10 minutes
        l2TTL: 60 * 60 * 1000, // 1 hour
        description: 'User-excluded series from new episode alerts',
        protected: true,
    },

    // =========================================================================
    // AI & Recommendations
    // =========================================================================

    /**
     * Media embeddings for AI recommendations
     * Long L2 TTL - embeddings are static once generated
     */
    mediaEmbeddings: {
        name: 'media-embeddings',
        l1TTL: 30 * 60 * 1000, // 30 minutes
        l2TTL: 14 * 24 * 60 * 60 * 1000, // 2 weeks - embeddings are static
        description: 'Vector embeddings for media items',
    },

    /**
     * User ratings from AI database
     * 1 hour L2 TTL - ratings affect suggestions but don't change frequently
     */
    userRatings: {
        name: 'user-ratings',
        l1TTL: 5 * 60 * 1000, // 5 minutes
        l2TTL: 60 * 60 * 1000, // 1 hour - ratings affect suggestions
        description: 'User movie/show ratings',
    },

    /**
     * Served-set tracker for GET /api/rate/queue — media IDs already handed to
     * the rating trainer within the current opaque session (cursor). Keyed
     * `${userId}:${sessionId}`. Short L1 (source of truth is L2) so a page's
     * exclusions are visible cluster-wide immediately; 6h L2 matches the
     * expected upper bound of a single rating session before it goes stale.
     */
    rateQueueServed: {
        name: 'rate-queue-served',
        l1TTL: 60 * 1000, // 1 min (small; source of truth is L2)
        l2TTL: 6 * 60 * 60 * 1000, // 6 hours — a rating "session" horizon
        description: 'Media IDs already served to the /rate trainer per user+session',
    },

    // =========================================================================
    // Watch History
    // =========================================================================

    /**
     * Watched content for filtering recommendations
     * Longer L2 TTL - sufficient for recommendation filtering
     */
    watchedContent: {
        name: 'watched-content',
        l1TTL: 5 * 60 * 1000, // 5 minutes
        l2TTL: 24 * 60 * 60 * 1000, // 24 hours - sufficient for recommendations
        description: 'User watched content history',
    },

    /**
     * Watched series for episode tracking
     */
    watchedSeries: {
        name: 'watched-series',
        l1TTL: 10 * 60 * 1000, // 10 minutes
        l2TTL: 30 * 60 * 1000, // 30 minutes
        description: 'Series the user has started watching',
    },

    /**
     * Watch statistics and analytics — the cross-user /admin/library/insights aggregates.
     *
     * v2: TTLs lowered from 4h/48h to 5min/15min. This namespace is now wired
     * into /api/watch-stats (P2); admin operators expect "recent" data, and a
     * 48h L2 made a busy install's leaderboards stale for two days. The queries
     * are heavy (full-history GROUP BY aggregates), so a short cache still
     * collapses repeated page loads while keeping the numbers fresh. The name
     * suffix bump invalidates any pre-wiring entries.
     */
    watchStats: {
        name: 'watch-stats-v2',
        l1TTL: 5 * 60 * 1000, // 5 minutes
        l2TTL: 15 * 60 * 1000, // 15 minutes
        description: 'Cross-user admin watch statistics (/api/watch-stats)',
    },

    // =========================================================================
    // Search & Metadata
    // =========================================================================

    /**
     * Available search categories
     */
    searchCategories: {
        name: 'search-categories',
        l1TTL: 30 * 60 * 1000, // 30 minutes
        l2TTL: 60 * 60 * 1000, // 1 hour
        description: 'Available search filter categories',
    },

    /**
     * Person details (actors, directors)
     */
    personDetails: {
        name: 'person-details-v2',
        l1TTL: 30 * 60 * 1000, // 30 minutes
        l2TTL: 24 * 60 * 60 * 1000, // 24 hours
        description: 'TMDB person/actor details and filmography',
    },

    /**
     * Search results cache.
     *
     * v3: cache key extended with deniedGroupIds + maxAgeRating + liveTvAllowed
     * dimensions. Pre-v3 entries lacked these dimensions, so a Live TV–permitted
     * caller could have written channels into a key that a non-permitted caller
     * later read. Bump invalidates those entries across the rollout window.
     */
    search: {
        // Drop episode hits cached before the canonical availability guard.
        name: 'search-v5',
        l1TTL: 5 * 60 * 1000, // 5 minutes
        l2TTL: 15 * 60 * 1000, // 15 minutes
        description: 'Search results across all media sources',
    },

    /**
     * Full cross-entity search result PAGE cache (`GET /api/v1/search`).
     *
     * Caches the value returned by SearchService.search() — the merged,
     * excludeTerms-filtered, globally-sorted, WINDOW-PAGINATED page — keyed by
     * every behavior-affecting input (normalized query, limit, offset,
     * resolved types, fulltext flag, year/rating filters, excludeTerms, the
     * SHOW_UNAVAILABLE_MEDIA_IN_SEARCH flag) plus the caller's access scope via
     * `buildSearchAccessCacheKey` (denied groups, age rating, Live TV
     * permission).
     *
     * Deliberately user-AGNOSTIC: the def resolves the per-user
     * metadata-language translation overlay AFTER this cache is read/written
     * (search.ts clones items before mutating title/overview — mirrors the
     * episode-search cache-safety fix), so caching the pre-overlay page can
     * never leak one user's language preference into another's response.
     *
     * Short 45s TTL — this exists purely to collapse rapid repeated/debounced
     * keystroke queries and concurrent tabs/devices onto one 6-source DB
     * fan-out, not to serve minutes-stale results; search must still feel
     * live. Single-flighted via `getOrComputeSingleFlight` so a burst of
     * identical concurrent cold-cache misses collapses to one compute instead
     * of stampeding the DB + external sources.
     *
     * Distinct from `CACHE_NAMESPACES.search` ('search-v3'), which is the
     * INNER cache `MediaAggregationService.searchAcrossServices` uses for the
     * Kavita/Audiobookshelf/Jellyseerr/Live TV aggregation branch only — that
     * cache is untouched by this change and keeps its own 5min/15min TTL as a
     * dogpile guard for the external-source fan-out. This outer cache simply
     * fronts the WHOLE search flow (including that inner cache) for 45s.
     */
    searchResultsPage: {
        name: 'search-results-page-v5', // Keep one-character CJK queries in the audiobook lane.
        l1TTL: 45 * 1000, // 45 seconds
        l2TTL: 45 * 1000, // 45 seconds
        // This namespace writes a SHORT per-entry TTL for a page an optional
        // source timed out of (see DEGRADED_PAGE_TTL_SECONDS in
        // defs/search/search.ts). Without this flag, a replica that promotes
        // such a page out of L2 would hold it for the flat 45s and serve the
        // incomplete answer long after the entry it came from had expired —
        // which is the whole thing the short TTL exists to prevent.
        promoteWithRemainingTtl: true,
        description:
            'Full search result page (GET /api/v1/search), access+query-scoped, single-flighted, 45s TTL (5s when degraded)',
    },

    /**
     * Typeahead suggestion cache (`GET /api/v1/search/suggest`).
     *
     * Same discipline as `searchResultsPage` (query, limit, resolved types,
     * SHOW_UNAVAILABLE_MEDIA_IN_SEARCH, access scope) but no offset/fulltext/
     * filter dimensions — suggest has none of those params. Suggest has no
     * translation overlay to worry about (it never localizes titles), so the
     * cached payload is served as-is.
     *
     * Shorter 20s TTL than the full search page: typeahead is the hottest,
     * most rapid-fire query surface (fires on every keystroke after a short
     * debounce) and freshness matters less per-keystroke, but a burst of
     * concurrent identical prefixes (multiple devices/tabs, retry) still
     * benefits from single-flight collapsing.
     */
    searchSuggestResults: {
        name: 'search-suggest-results-v3', // Same artist gate as full search.
        l1TTL: 20 * 1000, // 20 seconds
        l2TTL: 20 * 1000, // 20 seconds
        description:
            'Typeahead suggestions (GET /api/v1/search/suggest), access+query-scoped, single-flighted, 20s TTL',
    },

    // =========================================================================
    // Jellyfin System
    // =========================================================================

    /**
     * Jellyfin users cache
     * Long TTL since user IDs rarely change
     */
    jellyfinUsers: {
        name: 'jellyfin-users',
        l1TTL: 60 * 60 * 1000, // 1 hour L1
        l2TTL: 7 * 24 * 60 * 60 * 1000, // 7 days L2
        description: 'Jellyfin user information',
    },

    /**
     * Jellyfin library items
     * Long TTL for library metadata caching
     */
    jellyfinLibrary: {
        name: 'jellyfin-library',
        l1TTL: 5 * 60 * 1000, // 5 minutes L1
        l2TTL: 24 * 60 * 60 * 1000, // 24 hours L2
        description: 'Jellyfin library item details',
    },

    // =========================================================================
    // AI Suggestions & Recommendations
    // =========================================================================

    /**
     * AI-generated suggestions per user
     *
     * v1: Migrated cache key construction from hand-built deniedSuffix/ageSuffix
     *     to unified scopedCacheKey helper for access context consistency.
     */
    aiSuggestions: {
        name: 'ai-suggestions-v2',
        l1TTL: 5 * 60 * 1000, // 5 minutes
        l2TTL: 60 * 60 * 1000, // 1 hour
        description: 'AI-powered personalized suggestions',
    },

    // =========================================================================
    // For You / Personalization
    // =========================================================================

    /**
     * Hero section Next Up data
     * User-scoped with 24 hour TTL - cross-checked with watch_history activity.
     * Cache is validated against DB watch_history on every load:
     * - If user has any session_end_time or updated_at > cachedAt, cache is invalidated
     * - This catches activity from web, tvOS, and any client reporting to Jellyfin
     * - Sessions polling updates watch_history within seconds of playback events
     */
    heroNextUp: {
        name: 'hero-nextup-v2',
        l1TTL: 24 * 60 * 60 * 1000, // 24 hours
        l2TTL: 24 * 60 * 60 * 1000, // 24 hours
        description: 'Next up episode for hero section (activity-validated via watch_history)',
    },

    /**
     * Keyword-based recommendations ("Du magst X").
     *
     * v2: query now requires deniedGroupIds + ageRating; cache key
     * extended with the access-scope suffix. Pre-v2 entries were keyed
     * on userId alone and could surface restricted-library / over-age
     * titles after a permission change.
     */
    forYouKeywords: {
        name: 'for-you-keywords-v3',
        l1TTL: 5 * 60 * 1000, // 5 minutes
        l2TTL: 15 * 60 * 1000, // 15 minutes
        description: 'Keyword-based recommendations per user',
    },

    /**
     * Mood-based recommendations (time-aware).
     *
     * v4: query now requires deniedGroupIds + ageRating; cache key extended
     * with an ageSuffix alongside the existing deniedSuffix. Pre-v4 entries
     * could have surfaced restricted-library / over-age titles to callers
     * with stricter policies.
     *
     * v5: Migrated cache key construction from hand-built deniedSuffix/ageSuffix
     *     to unified scopedCacheKey helper for access context consistency.
     */
    moodRecommendations: {
        name: 'mood-recommendations-v6',
        l1TTL: 10 * 60 * 1000, // 10 minutes
        l2TTL: 30 * 60 * 1000, // 30 minutes
        description: 'Time-aware mood-based recommendations',
    },

    /**
     * Watched content IDs per user (for filtering recommendations)
     */
    watchedIds: {
        name: 'watched-ids',
        l1TTL: 10 * 60 * 1000, // 10 minutes
        l2TTL: 30 * 60 * 1000, // 30 minutes
        description: 'User watched content IDs for filtering',
    },

    // =========================================================================
    // Curated & Discovery Content
    // =========================================================================

    /**
     * Curated content lists (binge-worthy, popular shows, anime, short movies)
     * Global cache - same for all users, filtered client-side
     *
     * v1: Migrated cache key construction from hand-built deniedSuffix/ageSuffix
     *     to unified scopedCacheKey helper for access context consistency.
     */
    curatedContent: {
        name: 'curated-content-v2',
        l1TTL: 15 * 60 * 1000, // 15 minutes
        l2TTL: 60 * 60 * 1000, // 1 hour
        description: 'Curated content lists (binge-worthy, popular, anime)',
    },

    /**
     * For-You "Because you watched" similar rail (/api/for-you/similar).
     * Keyed by tmdbId:mediaType:user via buildVersionedCacheKey, user-scoped
     * for watched/dislike steering.
     *
     * TTLs are intentionally SHORT: the rail bakes the user's watched set and
     * taste vector into the cached body, and a POSITIVE rating does not
     * proactively invalidate it (only downvotes / media changes do), so the
     * 15-minute L2 is the real freshness bound for taste drift. Do not raise
     * it — the modal endpoint, which wanted a longer L2, has its OWN namespace
     * (`similarModalContent`) precisely so its TTL can't leak onto this rail.
     *
     * v5: cache key construction unified via scopedCacheKey + buildVersionedCacheKey.
     */
    similarContent: {
        name: 'similar-content-v6',
        l1TTL: 5 * 60 * 1000, // 5 minutes
        l2TTL: 15 * 60 * 1000, // 15 minutes
        description: 'For-You similar rail',
    },

    /**
     * Modal similar section (/api/media/{id}/similar). Split from
     * `similarContent` so its longer L2 (popular titles are expensive to
     * recompute via two-phase ANN) doesn't lengthen the co-tenant For-You
     * rail's taste-staleness bound.
     *
     * Bodies are cached user-AGNOSTIC (userRating attached per-request), keyed
     * `<locale>:<internalId>:<limit>:<minSim>[|access]`.
     *
     * TTL asymmetry is deliberate: invalidateMedia's pattern delete reaches
     * ONLY the Valkey L2 tier (UnifiedCache has no pattern-aware L1 purge), so
     * the in-process L1 stays short — the true per-replica staleness bound
     * after a re-embed/metadata change — while L2 can be long because it IS
     * evicted on media change (invalidateMedia matches this key shape).
     */
    similarModalContent: {
        name: 'similar-modal-content-v2',
        l1TTL: 5 * 60 * 1000, // 5 minutes — NOT pattern-invalidatable, keep short
        l2TTL: 60 * 60 * 1000, // 1 hour — evicted on media change
        description: 'Modal similar section',
    },

    /**
     * Calendar data from Sonarr/Radarr
     * Global cache — raw calendar data is identical for all users.
     * Per-user exclusions are applied post-retrieval on every request.
     */
    calendar: {
        name: 'calendar',
        l1TTL: 5 * 60 * 1000, // 5 minutes
        l2TTL: 15 * 60 * 1000, // 15 minutes
        description: 'Release calendar from Sonarr/Radarr',
    },

    /**
     * Curated lists from MDBList
     * Global cache - syncs periodically in background
     */
    curatedLists: {
        name: 'curated-lists-v4',
        l1TTL: 30 * 60 * 1000, // 30 minutes
        l2TTL: 2 * 60 * 60 * 1000, // 2 hours
        description: 'MDBList curated lists metadata',
    },

    /**
     * Holiday-themed recommendations (Christmas, Halloween, etc.)
     * User-scoped cache with moderate TTL - holiday content rarely changes
     */
    holidayRecommendations: {
        name: 'holiday-recommendations-v2',
        l1TTL: 30 * 60 * 1000, // 30 minutes
        l2TTL: 60 * 60 * 1000, // 1 hour
        description: 'Holiday-themed content recommendations per user',
    },

    /**
     * Holiday source discovery (TMDB / MDBList candidates)
     * Global cache - the candidate set is the same for every user
     */
    holidayDiscovery: {
        name: 'holiday-discovery-v2',
        l1TTL: 30 * 60 * 1000, // 30 minutes
        l2TTL: 60 * 60 * 1000, // 1 hour
        description: 'User-independent holiday candidates from external sources',
    },

    // =========================================================================
    // Browse Page
    // =========================================================================

    /**
     * Library group list for browse filtering
     * Per-user cache scoped by denied group IDs and age rating
     *
     * v1: Migrated cache key construction from hand-built deniedSuffix/ageSuffix
     *     to unified scopedCacheKey helper for access context consistency.
     */
    browseLibraries: {
        name: 'browse-libraries-v1',
        l1TTL: 30 * 60 * 1000, // 30 minutes
        l2TTL: 6 * 60 * 60 * 1000, // 6 hours
        description: 'Available library groups for browse filtering',
    },

    /**
     * A-Z alphabetical browse data
     * Global cache with fixed fetch size - paginated after cache
     *
     * v1: Migrated cache key construction from hand-built deniedSuffix/ageSuffix
     *     to unified scopedCacheKey helper for access context consistency.
     */
    browseAZ: {
        name: 'browse-az-v2',
        l1TTL: 10 * 60 * 1000, // 10 minutes
        l2TTL: 30 * 60 * 1000, // 30 minutes
        description: 'Alphabetical media browse with pagination',
    },

    /**
     * Recently added content for browse page
     * Short TTL - needs to reflect new additions relatively quickly
     */
    browseRecentlyAdded: {
        name: 'browse-recently-added-v2',
        l1TTL: 2 * 60 * 1000, // 2 minutes
        l2TTL: 5 * 60 * 1000, // 5 minutes
        description: 'Recently added content for browse page',
    },

    /**
     * Live TV channels for browse page
     * Global cache - channel lineup rarely changes
     */
    browseChannels: {
        name: 'browse-channels',
        l1TTL: 15 * 60 * 1000, // 15 minutes
        l2TTL: 60 * 60 * 1000, // 1 hour
        description: 'Live TV channel listings',
    },

    /**
     * Genre rows for browse page
     * Global cache - genre content changes infrequently
     */
    browseGenres: {
        name: 'browse-genres-v2',
        l1TTL: 10 * 60 * 1000, // 10 minutes
        l2TTL: 30 * 60 * 1000, // 30 minutes
        description: 'Genre-based content rows for browse',
    },

    /**
     * Keyword rows for browse page (a static ~30-entry keyword list).
     * Global cache — the keyword list is fixed; which entries have enough
     * matching items changes only on ingest. Keys are access-scoped
     * (browseScopedCacheKey: library group + age) and carry the type/offset/limit
     * page dimensions, so restricted users never read an unrestricted entry.
     * TTL mirrors browseGenres; invalidated on the SAME content-added cascade
     * that clears browseGenres (see invalidation.ts runContentInvalidationCascade).
     */
    browseKeywords: {
        name: 'browse-keywords-v2',
        l1TTL: 10 * 60 * 1000, // 10 minutes
        l2TTL: 30 * 60 * 1000, // 30 minutes
        description:
            'Keyword-based content rows for browse (static keyword list). Cleared on the ' +
            'same ingest cascade as browseGenres. Single-flighted on miss; like any ' +
            'cache-aside this has an inherent invalidate/compute race (a compute in flight ' +
            'when a clear fires can write its pre-invalidation snapshot back) — bounded by ' +
            'the TTL and re-cleared on the next ingest, so stale keyword membership self-heals.',
    },

    /**
     * Next up episodes for browse page
     * User-scoped with short TTL - reduces load during rapid refreshes
     */
    browseNextUp: {
        name: 'browse-next-up-v2',
        l1TTL: 30 * 1000, // 30 seconds
        l2TTL: 60 * 1000, // 60 seconds
        description: 'Next up episodes (user-scoped, short TTL)',
    },

    // =========================================================================
    // Homepage
    // =========================================================================

    /**
     * Durable Continue Watching / Next Up rows per user.
     *
     * The home render recomputes CW/NU several times per load (SSR
     * effective-watching + the recommendations feed's continue-watching /
     * next-up sections). This namespace + single-flight collapses the
     * concurrent burst to a single DB read and shares the result across loads
     * within the (short) TTL.
     *
     * Scope: keyed per user AND per fetch `limit`. The value is that one user's
     * own watch rows — there is NO cross-user sharing, so a per-user key is the
     * correct (and sufficient) access scope. Access-boundary filtering (library
     * group / age) is applied by the CALLERS after these raw rows are read, so
     * the cache never widens what a caller can see.
     *
     * Invalidation: every explicit watch mutation (mark / clear / season /
     * series / jellyfin-sync) invalidates this per-user via
     * `invalidateContinueWatchingCache` (folded into `invalidateAllWatchedCaches`
     * and called directly from `clearWatchProgress` + the auto-complete branch
     * of `reportProgress`). Plain heartbeat progress writes do NOT invalidate
     * (far too hot); the <=30s L2 TTL bounds resume-position drift, and the
     * live-session overlay in effective-watching supplies fresh progress for
     * actively-playing items layered on top of these durable rows.
     */
    continueWatchingRows: {
        name: 'continue-watching-rows-v2',
        l1TTL: 5 * 1000, // 5 seconds
        l2TTL: 10 * 1000, // 10 seconds
        description:
            'Durable Continue Watching / Next Up rows per user (short TTL, single-flight; invalidated on watch mutations). ' +
            'The primary win is coalescing the ~5 CW/NU computes fired within a single home-page load into one; a few ' +
            'seconds suffices for that, so the TTL is kept small. Cache-aside has an inherent invalidate/compute race: a ' +
            'compute already in flight when an invalidating mutation commits can write its (now stale) rows back after the ' +
            'delete. The short TTL bounds that stale window to <=10s (self-heals); the live-session overlay masks progress ' +
            'drift for actively-playing items in the meantime.',
    },

    /**
     * Result of determineHeroState() — hero variant + onboarding step list +
     * media count. Only two variants exist (admin / non-admin), and both are
     * system-global (not per-user). Short TTL so onboarding dismissals and
     * newly scanned media reflect quickly.
     */
    heroState: {
        name: 'hero-state-v1',
        l1TTL: 30 * 1000, // 30 seconds
        l2TTL: 60 * 1000, // 60 seconds
        description: 'Hero state (onboarding / local-content / full-metadata) for the homepage',
    },

    heroFirstSlide: {
        name: 'hero-first-slide-v2',
        l1TTL: 30 * 1000, // 30 seconds
        l2TTL: 60 * 1000, // 60 seconds
        description:
            'SSR generic fallback first slide for the homepage hero. Access-scoped key (scopedCacheKey) — never store personalized Next Up here.',
    },

    /**
     * "Because you watched" source list — recently watched movies/TV with
     * embeddings, one entry per user. Short TTL because watch history evolves,
     * but the sources list is stable over a few minutes.
     */
    watchingSources: {
        name: 'for-you-watching-sources-v2',
        l1TTL: 2 * 60 * 1000, // 2 minutes
        l2TTL: 5 * 60 * 1000, // 5 minutes
        description: '"Because you watched" source list for For-You Phase 2',
    },

    /**
     * "Your requests are ready" section — per-user Jellyseerr fulfilled requests.
     *
     * Long TTL because fulfilled status only changes when:
     *   a) A new item is ingested into the library (library scan → invalidated by
     *      media-lifecycle hooks via cacheManager.for(fulfilledRequests).clear())
     *   b) The user dismisses a request (dismiss endpoint invalidates per-user key)
     *
     * The Jellyseerr roundtrip is expensive (~500ms–2s); a 30-minute cache makes
     * it sub-millisecond on warm hits.
     */
    fulfilledRequests: {
        name: 'for-you-fulfilled-requests-v3',
        l1TTL: 5 * 60 * 1000, // 5 min L1
        l2TTL: 30 * 60 * 1000, // 30 min L2
        description: '"Your requests are ready" per-user fulfilled Jellyseerr requests',
    },

    // =========================================================================
    // Sessions & Playback
    // =========================================================================

    /**
     * Live TV program info (current/next program)
     * Very short TTL as program info changes frequently
     */
    liveTvPrograms: {
        name: 'livetv-programs-v1',
        l1TTL: 30 * 1000, // 30 seconds
        l2TTL: 60 * 1000, // 60 seconds
        description: 'Current and upcoming Live TV program info',
    },

    /**
     * Per-user personalized Live TV channel IDs for the /livetv landing render.
     *
     * getPersonalizedChannelIds runs two aggregates over
     * livetv_channel_watch_history on every landing hit. The result is a short list
     * of <=4 channel UUIDs derived purely from THIS user's own watch history, so a
     * per-user key (cacheManager userId param) is the correct and sufficient access
     * scope — there is no cross-user sharing.
     *
     * The cached value is only the raw ID list; the channel objects + visibility are
     * resolved AFTER the cache read from the provider-cached channel lineup (which is
     * busted on admin mutations via bustCaches()). A hidden/renamed channel therefore
     * can never leak through a stale ID list — the +page.server.ts map lookup filters
     * on `ch.isVisible` against fresh channel data. Admin mutations need NOT invalidate
     * this namespace; the short TTL alone is sufficient.
     */
    liveTvPersonalizedChannels: {
        name: 'livetv-personalized-channels-v1',
        l1TTL: 60 * 1000, // 60 seconds
        l2TTL: 90 * 1000, // 90 seconds (within the requested 60–120s window)
        description: 'Per-user personalized Live TV channel IDs for the /livetv landing',
    },

    /**
     * "What's On Now" carousel data for home page
     * Short TTL - programs change frequently, "time remaining" must stay fresh
     */
    liveTvWhatsOnNow: {
        name: 'livetv-whats-on-now-v1',
        l1TTL: 30 * 1000, // 30 seconds
        l2TTL: 60 * 1000, // 60 seconds
        description: "What's On Now carousel data for home page",
    },

    /**
     * Audio metadata (album/artist names)
     * Long TTL as album/artist info rarely changes
     */
    audioMetadata: {
        name: 'audio-metadata',
        l1TTL: 30 * 60 * 1000, // 30 minutes
        l2TTL: 60 * 60 * 1000, // 1 hour
        description: 'Audio track album and artist metadata',
    },

    /**
     * Per-session next-track ID for music queue display.
     * Written by each heartbeat when queue[0] is known; read by admin/user
     * sessions endpoints to surface "Next: ..." on active stream cards.
     * Short TTL — sessions expire after ~30 s of missed heartbeats anyway.
     */
    musicNextTrack: {
        name: 'music-next-track-v1',
        l1TTL: 60 * 1000, // 60 seconds
        l2TTL: 90 * 1000, // 90 seconds
        description: 'Next-track UUID keyed by play session ID (for queue display)',
    },

    /**
     * Per-session crossfade in progress, written by the music session
     * heartbeat (`crossfade` field) and read next to `musicNextTrack` so the
     * Active Streams card can show "A → B". The value carries its own end
     * time, so an entry past it reads as "not fading" whatever the TTL. L1 is
     * kept short because prod runs several web pods: a `crossfade: null`
     * clear lands on one pod's L1 only.
     */
    musicCrossfade: {
        name: 'music-crossfade-v1',
        l1TTL: 1000,
        l2TTL: 90 * 1000,
        description: 'Crossfade in progress keyed by play session ID (for Active Streams)',
    },

    // =========================================================================
    // Music
    // =========================================================================

    /**
     * Per-user genre carousel plan for /music.
     * Maps genre name → array of track IDs (up to 20 per genre, 8 genres per user).
     * Computed once at SSR time by computeGenrePlan, cached here to skip the
     * 8 parallel getTracksByGenre queries on repeat visits.
     *
     * v1: Initial version
     */
    musicGenrePlan: {
        name: 'music-genre-plan-v1',
        l1TTL: 60 * 1000, // 60 seconds
        l2TTL: 3 * 60 * 1000, // 3 minutes
        description:
            'Per-user genre carousel plan: {genre: trackIds[]}. ' +
            '3-min staleness budget matches spec-accepted Quick Picks freshness lag.',
    },

    /**
     * Per-user k-means clusters of taste embeddings for Quick Picks v3.
     * Each entry: array of cluster centroids + sizes. Slow to compute
     * (k-means over up to 50 vectors, 1536-dim each) but stable across
     * playbacks. 6h TTL means clusters refresh ~4x/day.
     *
     * **IMPORTANT:** Bump the version suffix (`-v1` → `-v2`) whenever the
     * embedding model changes (dimension or provider). Cached centroids
     * from a different dimension would fail pgvector distance lookups and
     * fall through to the single-centroid legacy path. The per-cluster
     * query is already wrapped in try/catch so a stale cache degrades
     * gracefully, but bumping the name is the correct explicit signal.
     *
     * v1: Initial version (OpenAI text-embedding-3-small, 1536-dim)
     * v2: Rocchio-adjusted centroids — each cluster shifted by
     *     -DISLIKE_LAMBDA * negative_centroid so the taste vector is
     *     pushed away from explicitly-disliked embeddings. Also adds
     *     like-weighting (liked tracks duplicated in k-means input).
     *     Bumped to invalidate all pre-Rocchio cached centroids.
     * v3: "Various Artists" no longer appears in track embedding text —
     *     compilation tracks were clustering on the literal "Various
     *     Artists" token instead of musical similarity. Pre-v3 centroids
     *     built over those poisoned vectors are stale. Re-embedding any
     *     VA-tagged track is required for clusters to re-converge cleanly;
     *     until then, fresh centroids will mix old and new vectors.
     */
    musicTasteClusters: {
        name: 'music-taste-clusters-v3',
        l1TTL: 5 * 60 * 1000, // 5 minutes
        l2TTL: 6 * 60 * 60 * 1000, // 6 hours
        description:
            'Per-user k-means taste clusters for Quick Picks taste-similar bucket. Bump name suffix on embedding model change.',
    },

    /**
     * The home page's Quick Picks row (`/api/for-you/music-quick-picks`) — the
     * picked track + radio rows per user and access scope. Building them costs
     * 350-600 ms of queries on every home load. Short-lived on purpose: the row
     * follows listening, and the endpoint re-applies the user's current dislikes
     * on every hit, so a just-disliked track never comes back from here.
     */
    musicQuickPicksRow: {
        name: 'music-quick-picks-row-v1',
        l1TTL: 3 * 60 * 1000, // 3 minutes
        l2TTL: 3 * 60 * 1000, // 3 minutes
        description: 'Home Quick Picks row rows per user (dislikes re-applied on read).',
    },

    /**
     * Daily bucket-served counters for Quick Picks observability.
     * Increments on every getQuickPicks() call. Read by /admin/music-quick-picks.
     * Key format: `bucket-counts:YYYY-MM-DD`. 7-day TTL keeps a week of history.
     */
    musicQuickPicksStats: {
        name: 'music-quick-picks-stats-v1',
        l1TTL: 30 * 1000, // 30 seconds
        l2TTL: 7 * 24 * 60 * 60 * 1000, // 7 days
        description: 'Daily bucket-served counters for Quick Picks admin page.',
    },

    /**
     * Per-user 24h-pinned IDs for the Quick Picks `new-discovery` bucket.
     * Stabilizing the fresh-discovery picks across a day creates a ritual —
     * users have something to come back to and engage with, rather than
     * reroll casino on every page load (Spotify Discover Weekly analog).
     *
     * Key format: `new-discovery:YYYY-MM-DD`, userId scoped via cacheManager.
     * Value: string[] of track UUIDs.
     */
    musicNewDiscovery: {
        name: 'music-new-discovery-v1',
        l1TTL: 5 * 60 * 1000, // 5 minutes
        l2TTL: 24 * 60 * 60 * 1000, // 24 hours
        description: 'Per-user 24h-pinned track IDs for the Quick Picks new-discovery bucket.',
    },

    /**
     * Per-user 24h-pinned IDs for the Quick Picks `sonic-discovery` bucket.
     * Mirrors musicNewDiscovery but operates in MSCLAP sonic-embedding space
     * (1024-dim) rather than the metadata space. Separate namespace so the two
     * can be invalidated independently (sonic re-clustering doesn't touch metadata).
     *
     * Key format: `sonic-discovery:YYYY-MM-DD`, userId scoped via cacheManager.
     * Value: string[] of track UUIDs.
     */
    musicSonicDiscovery: {
        name: 'music-sonic-discovery-v1',
        l1TTL: 5 * 60 * 1000, // 5 minutes
        l2TTL: 24 * 60 * 60 * 1000, // 24 hours
        description:
            'Per-user 24h-pinned track IDs for the Quick Picks sonic-discovery bucket (MSCLAP kNN, never-played).',
    },

    /**
     * Distinct music library genres + per-genre track/album counts, scoped by
     * library/age access context. getDistinctMusicGenres scans every `track`
     * row, unnesting the custom_metadata->'genre' JSONB and grouping — ~700ms
     * to ~1.9s on preprod (~24k tracks) — and it sits in the AWAITED tier-1
     * block of the /music load, so it blocks the SSR critical path on every
     * visit. The result is library-wide (per access scope), not per playback,
     * and changes only on library scans / genre edits, so a short cache removes
     * it from the hot path entirely.
     *
     * Key: scopedCacheKey('music-library-genres', accessCtx) — different
     * library/age scopes get distinct entries; no cross-user leakage.
     */
    /**
     * Per-viewer genre-rail ranking for Music home — the ordered rail list plus
     * the previous day's keys (hysteresis input). User- AND access-scoped, and
     * day-bucketed inside the key: within one UTC day every request and every
     * replica returns a byte-identical rail set, so the tab does not reorder
     * under a listener mid-session.
     * Key: scopedCacheKey('music-genre-rails', ctx, [userId, dayKey]).
     * Value: { rails: GenreRail[], prevKeys: string[] }.
     */
    musicGenreRails: {
        name: 'music-genre-rails-v1',
        l1TTL: 5 * 60 * 1000, // 5 minutes
        l2TTL: 24 * 60 * 60 * 1000, // 24 hours — matches the day bucket
        description:
            'Per-user taste-ranked music genre rails (library prior + album-capped listening evidence).',
    },

    musicLibraryGenres: {
        name: 'music-library-genres-v1',
        l1TTL: 60 * 1000, // 60 seconds
        l2TTL: 5 * 60 * 1000, // 5 minutes
        description:
            'Distinct music library genres + track/album counts, scoped by access context. ' +
            'Removes the ~700ms-1.9s full-track-scan from the /music SSR critical path.',
    },

    /**
     * Music mood-recommendation tracks — cosine-similarity ranking of library
     * tracks against a pre-computed `music:<mood>` MSCLAP audio-space mood
     * vector (getMusicMoodRecommendations). Runs on every GET
     * /api/music/sections/mood-recommendations, uncached until now.
     *
     * Distinct namespace from `moodRecommendations` (which holds the VIDEO
     * keyword-mood recs, a different value shape) and `vectorMoodRecommendations`
     * (video vector-mode). A dedicated namespace avoids any cross-shape key
     * collision (a music payload could otherwise deserialize into a video read
     * path) and lets music mood be invalidated independently of the video mood
     * caches.
     *
     * Key: scopedCacheKey('music-mood-recs', accessCtx, [mood, limit]) — the DB
     * query depends ONLY on (moodKey, limit, library/age access scope), NOT on
     * the user, so the access-scoped key is the correct and sufficient scope
     * (no cross-scope leakage). TTL mirrors the video moodRecommendations
     * (10min L1 / 30min L2); mood vectors change only when the
     * mood-vector-generation task reruns, so a stale window of minutes is fine.
     *
     * v2: matching moved from text/metadata embedding space to CLAP audio
     * space (media_audio_embeddings) — bumped because the ranking underneath
     * an unchanged cache key shape now returns semantically different results.
     *
     * v3: the cached payload now holds raw DB rows (no baked `images{}` hrefs)
     * — the endpoint is published on both `/api/music/sections/...`
     * (imageBase `/api/image`) and `/api/v1/music/...` (imageBase
     * `/api/v1/media`), and those hrefs differ per surface. Baking hrefs into
     * the shared cache entry would let whichever surface warms the entry
     * first poison the other surface's response until TTL expiry. Bumped
     * because a v2 entry (baked `images{}`, no `rows`) does not deserialize
     * into the v3 shape.
     */
    musicMoodRecommendations: {
        name: 'music-mood-recommendations-v3',
        l1TTL: 10 * 60 * 1000, // 10 minutes
        l2TTL: 30 * 60 * 1000, // 30 minutes
        description:
            'Music mood-recommendation tracks (CLAP audio-space kNN vs music:<mood> vector), scoped by access context + mood + limit.',
    },

    /**
     * Per-user /music "Mood Shelf" carousel — CLAP audio-space kNN vs the
     * music:<mood> vector, blended toward the user's played artists and
     * optionally bounded by an Essentia energy band. Unlike
     * musicMoodRecommendations (which is access-scoped only), the taste blend
     * makes this per-user, so the key carries the userId. Short TTL: play
     * history shifts the blend, but a few-minute stale window is fine.
     * Key: scopedCacheKey('music-mood-shelf', ctx, [userId, mood]).
     * Value: { section: PageSection | null } (wrapped so a cached empty/null
     * section reads as a hit, not a miss).
     */
    musicMoodShelf: {
        name: 'music-mood-shelf-v1',
        l1TTL: 5 * 60 * 1000, // 5 minutes
        l2TTL: 15 * 60 * 1000, // 15 minutes
        description: 'Per-user mood-shelf carousel (CLAP kNN + taste blend + energy band).',
    },

    /**
     * Per-user /music "New For You" carousel — recently-added, never-played
     * library tracks ranked by the user's sonic taste vector. User- + access-
     * scoped. 15-min TTL balances freshness (new tracks arrive via scans, the
     * taste vector drifts) against the two-query 30d→90d widen cost.
     * Key: scopedCacheKey('music-new-for-you', ctx, [userId]).
     * Value: { section: PageSection | null }.
     */
    musicNewForYou: {
        name: 'music-new-for-you-v1',
        l1TTL: 5 * 60 * 1000, // 5 minutes
        l2TTL: 15 * 60 * 1000, // 15 minutes
        description: 'Per-user New For You carousel (recently-added, taste-ranked).',
    },

    /**
     * Per-user /music "Smart Mixes" carousels — k-means genre clusters over the
     * user's library surfaced as themed carousels. User- + access-scoped.
     * Longer TTL: the clustering is expensive and its output changes slowly.
     * Key: scopedCacheKey('music-smart-mixes', ctx, [userId]).
     * Value: { sections: PageSection[] } (matches the endpoint's wrapper shape).
     */
    musicSmartMixes: {
        name: 'music-smart-mixes-v1',
        l1TTL: 5 * 60 * 1000, // 5 minutes
        l2TTL: 30 * 60 * 1000, // 30 minutes
        description: 'Per-user Smart Mixes carousels (k-means genre clusters).',
    },

    /**
     * Per-user /music "Because you listened to X" carousel — embedding kNN from
     * a seed drawn from recent plays. User- + access-scoped. Short TTL: the seed
     * is chosen on the cold miss (so it re-rolls each TTL window) and recent
     * plays change as the user listens — keeping X stable for a few minutes is
     * also more coherent than re-rolling the seed on every back-navigation.
     * Key: scopedCacheKey('music-byl', ctx, [userId]).
     * Value: { section: PageSection | null }.
     */
    musicBecauseYouListened: {
        name: 'music-because-you-listened-v1',
        l1TTL: 5 * 60 * 1000, // 5 minutes
        l2TTL: 10 * 60 * 1000, // 10 minutes
        description: 'Per-user Because You Listened carousel (seed kNN from recent plays).',
    },

    /**
     * Music Map projection coordinates — access-scoped (library + age).
     * Long TTL because coordinates only change after a new projection run.
     * Cache key is scoped by access context to prevent cross-user leakage.
     */
    musicMapPoints: {
        name: 'music-map-points-v1',
        l1TTL: 5 * 60 * 1000, // 5 minutes L1
        l2TTL: 30 * 60 * 1000, // 30 minutes L2
        description:
            'Music Map 2D projection points (media_audio_map_coords), scoped by access context.',
    },

    /**
     * Sonic cluster listing — access-scoped (library + age).
     * Long TTL because cluster assignments only change after a clustering run.
     * Cache key is scoped by access context to prevent cross-user leakage.
     */
    musicClusters: {
        // v2: labels now rank genres by lift rather than raw frequency, so
        // every v1 entry holds a label the code would no longer produce.
        name: 'music-clusters-v2',
        l1TTL: 5 * 60 * 1000, // 5 minutes L1
        l2TTL: 60 * 60 * 1000, // 60 minutes L2
        description: 'Sonic cluster list (media_audio_clusters), scoped by access context.',
    },

    /**
     * Per-cluster member track list — access-scoped.
     * Cache key format: `v1:cluster-members:{clusterId}:{accessSuffix}`
     */
    musicClusterMembers: {
        name: 'music-cluster-members-v1',
        l1TTL: 5 * 60 * 1000, // 5 minutes L1
        l2TTL: 30 * 60 * 1000, // 30 minutes L2
        description: 'Per-cluster member tracks (media_audio_clusters), scoped by access context.',
    },

    /**
     * Per-user sonic fingerprint neighbour results.
     * User-scoped + access-scoped (library + age). Short TTL because play history
     * changes as the user listens; a fresh fingerprint after a few songs is fine.
     * Cache key format: `v1:sonic-fingerprint:{userId}:limit={N}:{accessSuffix}`
     */
    musicSonicFingerprint: {
        name: 'music-sonic-fingerprint-v1',
        l1TTL: 5 * 60 * 1000, // 5 minutes L1
        l2TTL: 15 * 60 * 1000, // 15 minutes L2
        description:
            'Per-user sonic fingerprint neighbour tracks (recency-weighted MSCLAP centroid kNN).',
    },

    /**
     * Per-user sonic taste clusters — computed from the user's top-played
     * tracks' media_audio_clusters assignments (MSCLAP, 1024-dim). Centroids
     * are in the sonic audio space rather than the 1536-dim metadata space
     * used by musicTasteClusters.
     *
     * Keyed the same way as musicTasteClusters (play-count + dislike-count
     * bucket), but under a distinct namespace so the two are invalidated
     * independently (sonic re-clustering doesn't re-cluster metadata, and
     * vice versa).
     *
     * v1: initial implementation; bump if MSCLAP model or centroid logic changes.
     */
    musicSonicTasteClusters: {
        name: 'music-sonic-taste-clusters-v1',
        l1TTL: 5 * 60 * 1000, // 5 minutes L1
        l2TTL: 6 * 60 * 60 * 1000, // 6 hours L2 (matches metadata clusters)
        description:
            'Per-user sonic audio taste clusters (media_audio_clusters / MSCLAP centroids). ' +
            'Parallel to musicTasteClusters but in the 1024-dim sonic space.',
    },

    /**
     * Per-user clustering snapshot (embedding space + centroids) behind the
     * version-bound taste-station ids. Listing stations stores the snapshot
     * under the id's version, so a stored id plays the station the user saw
     * even after the 6 h clusterings re-cluster.
     *
     * Key format: `snapshot:{version}`, userId scoped via cacheManager.
     * Value: { space: 'sonic' | 'metadata', centroids: number[][] }.
     */
    musicTasteStationSnapshots: {
        name: 'music-taste-station-snapshots-v1',
        l1TTL: 5 * 60 * 1000, // 5 minutes
        l2TTL: 7 * 24 * 60 * 60 * 1000, // 7 days
        description:
            'Per-user taste-station clustering snapshots (space + centroids) keyed by clustering version.',
    },

    /**
     * Sonic-similar artists for a seed artist (ArtistModal "Similar Artists"
     * section). `findSonicNeighborArtists` computes a centroid over every
     * embedded track of the seed artist and then aggregates cosine similarity
     * against every other artist's embedded tracks — a plain JOIN + GROUP BY
     * that cannot use the HNSW index (only literal-vector ORDER BY ... LIMIT
     * probes hit it), so it's a genuine full scan on every open (15-20s on
     * prod-sized libraries). Results only change when embeddings are
     * (re)computed or the library changes, so a long TTL is safe.
     *
     * Library/age-scoped (candidates are filtered by `accessCtx` in the
     * query), so the key MUST include the access suffix via scopedCacheKey —
     * NOT a plain per-artist key.
     *
     * Key: scopedCacheKey('music-similar-artists', accessCtx, [artistId, limit])
     */
    musicSimilarArtists: {
        name: 'music-similar-artists-v1',
        l1TTL: 5 * 60 * 1000, // 5 minutes L1
        l2TTL: 24 * 60 * 60 * 1000, // 24 hours L2 — similarity is embedding-derived, changes rarely
        description:
            'Sonic-similar artists for a seed artist (MSCLAP centroid kNN over all artist tracks), access-scoped.',
    },

    /**
     * Sonic-similar tracks for a seed track (ModalMovie-equivalent "Similar
     * Tracks" music surface). `findSonicNeighbors` is a genuine HNSW-eligible
     * `ORDER BY embedding <=> seed LIMIT n` probe (NOT a full scan like the
     * artist/album variants), but it still costs a DB roundtrip + join back to
     * `media_items` on every open, and results only change when embeddings are
     * (re)computed or the library changes, so caching is still worthwhile to
     * collapse repeated opens of the same track.
     *
     * Library/age-scoped (candidates are filtered by `accessCtx` in the
     * query via `mi` alias, which resolves correctly for this query — see
     * `findSonicNeighbors`), so the key MUST include the access suffix via
     * scopedCacheKey — NOT a plain per-track key.
     *
     * Key: scopedCacheKey('music-similar-tracks', accessCtx, [trackId, limit])
     */
    musicSimilarTracks: {
        name: 'music-similar-tracks-v1',
        l1TTL: 5 * 60 * 1000, // 5 minutes L1
        l2TTL: 24 * 60 * 60 * 1000, // 24 hours L2 — similarity is embedding-derived, changes rarely
        description: 'Sonic-similar tracks for a seed track (MSCLAP HNSW kNN), access-scoped.',
    },

    /**
     * Sonic-similar albums for a seed album (AlbumModal "Similar Albums"
     * section). `findSonicNeighborAlbums` computes a centroid over the seed
     * album's embedded tracks and aggregates cosine similarity against every
     * other album's embedded tracks via a plain JOIN + GROUP BY — same
     * full-scan shape as `findSonicNeighborArtists` (no HNSW index usable).
     * Results only change when embeddings are (re)computed or the library
     * changes, so a long TTL is safe.
     *
     * Library/age-scoped (candidates are filtered by `accessCtx` in the
     * query), so the key MUST include the access suffix via scopedCacheKey —
     * NOT a plain per-album key.
     *
     * Key: scopedCacheKey('music-similar-albums', accessCtx, [albumId, limit])
     */
    musicSimilarAlbums: {
        name: 'music-similar-albums-v1',
        l1TTL: 5 * 60 * 1000, // 5 minutes L1
        l2TTL: 24 * 60 * 60 * 1000, // 24 hours L2 — similarity is embedding-derived, changes rarely
        description:
            'Sonic-similar albums for a seed album (MSCLAP centroid kNN over all album tracks), access-scoped.',
    },

    /**
     * Per-station now-playing record for radio stations.
     * Cached data includes parsed metadata, internal image URLs, and last error.
     * 30s TTL matches client poll cadence for real-time now-playing updates.
     */
    radioNowPlaying: {
        name: 'radio-now-playing-v1',
        l1TTL: 30 * 1000, // 30 seconds
        l2TTL: 30 * 1000, // 30 seconds
        description:
            'Per-station now-playing record (parsed metadata + internal image URLs + last error). 30s TTL matches client poll cadence.',
    },

    /**
     * Whether radio is configured on this server (≥1 `media_type = 'radio'`
     * media_item exists). Global boolean (key 'all'), checked from the ROOT
     * layout on every authed request to gate the Radio nav item + page. Short
     * 60s L1 TTL so a newly-added first station appears in the nav within ~a
     * minute; L2 mirrors it so cluster nodes converge on the same window.
     */
    musicRadioConfigured: {
        name: 'music-radio-configured-v1',
        l1TTL: 60 * 1000, // 60 seconds
        l2TTL: 60 * 1000, // 60 seconds
        description:
            'Whether ≥1 radio station (media_type = radio) is configured. Gates the Radio nav item + page; checked from the root layout per request.',
    },

    // =========================================================================
    // Personal Statistics
    // =========================================================================

    /**
     * Personal viewing statistics per user
     * User-scoped cache with longer TTL - stats don't need real-time updates
     */
    personalStats: {
        name: 'personal-stats',
        l1TTL: 30 * 60 * 1000, // 30 minutes
        l2TTL: 2 * 60 * 60 * 1000, // 2 hours
        description: 'Personal viewing statistics per user',
    },

    /**
     * The proactive chat opener's single suggestion, per user and access scope.
     *
     * Short TTL on purpose: the whole point is that it feels current, and it is
     * cheap to rebuild. It exists only so that opening the chat five times in a
     * session does not re-run four queries five times.
     */
    assistantOpener: {
        name: 'assistant-opener',
        l1TTL: 15 * 60 * 1000, // 15 minutes
        l2TTL: 15 * 60 * 1000,
        description: 'Proactive assistant chat opener suggestion per user',
    },

    // =========================================================================
    // ID Resolution
    // =========================================================================

    /**
     * External ID to internal UUID mappings
     * Used by CacheIdResolver for efficient TMDB → UUID lookups
     * Long TTLs since mappings are stable once created
     */
    idMappings: {
        name: 'id-mappings',
        l1TTL: 60 * 1000, // 1 minute L1 (covered by LRU in CacheIdResolver)
        l2TTL: 60 * 60 * 1000, // 1 hour L2
        description: 'External ID to internal UUID mappings (TMDB, IMDB → UUID)',
    },

    // =========================================================================
    // Vector-Based Recommendations
    // =========================================================================

    /**
     * Pre-computed mood vectors (average of seed movie embeddings)
     * Very long TTL - mood vectors rarely change once computed
     */
    moodVectors: {
        name: 'mood-vectors-v1',
        l1TTL: 60 * 60 * 1000, // 1 hour L1
        l2TTL: 24 * 60 * 60 * 1000, // 24 hours L2
        description: 'Pre-computed mood vectors (average of seed embeddings)',
    },

    /**
     * Vector-mode mood recommendations (separate from keyword moodRecommendations!)
     * User-scoped - personalized with user preference vector.
     *
     * v2: queryWithMoodVector now requires deniedGroupIds + ageRating; cache
     * key extended with ageSuffix. Pre-v2 entries unscoped beyond denied
     * groups and could leak over-age titles.
     *
     * v3: Migrated cache key construction from hand-built deniedSuffix/ageSuffix
     *     to unified scopedCacheKey helper for access context consistency.
     */
    vectorMoodRecommendations: {
        name: 'vector-mood-recs-v4',
        l1TTL: 10 * 60 * 1000, // 10 minutes
        l2TTL: 30 * 60 * 1000, // 30 minutes
        description: 'Vector-based mood recommendations (user-scoped)',
    },

    // =========================================================================
    // Watch State Refresh
    // =========================================================================

    /**
     * Per-user throttle for background watch state sync.
     * Short TTL — prevents hammering on rapid page navigation.
     */
    watchStateRefresh: {
        name: 'watch-state-refresh-v1',
        l1TTL: 30 * 1000, // 30 seconds
        l2TTL: 30 * 1000, // 30 seconds
        description: 'Per-user throttle for background watch state sync',
    },

    /**
     * Dismiss state for "Because you watched" rows
     * Ephemeral session state - stored only in Redis, no database persistence
     * Used for real-time vector steering when users dismiss items
     * PROTECTED: User preference data, not cleared during "Clear All Caches"
     */
    dismissState: {
        name: 'dismiss-state-v2',
        l1TTL: 30 * 60 * 1000, // 30 minutes
        l2TTL: 2 * 60 * 60 * 1000, // 2 hours
        description: 'Session-based dismiss state for recommendation steering',
        protected: true,
    },

    /**
     * PROTECTED: Per-user decayed "show less like this" avoid-vector + hash.
     * Short TTL so a fresh damper is reflected quickly; the durable signal
     * lives in the user_taste_dampers table, this only memoizes the computed
     * avoid-vector across the ~10 endpoint calls of one For-You page load.
     */
    tasteDampers: {
        name: 'taste-dampers-v2',
        l1TTL: 2 * 60 * 1000, // 2 minutes
        l2TTL: 10 * 60 * 1000, // 10 minutes
        description:
            'Per-user damper context (mean-centered vectors + mean) for "show less like this"',
        protected: true,
    },

    /**
     * Global content-mean embedding used to mean-center "show less like this"
     * cosines. Changes very slowly (library-wide aggregate) and is expensive to
     * compute, so it gets a long TTL. Shared across all users (not per-user).
     */
    globalEmbeddingMean: {
        name: 'global-embedding-mean-v1',
        l1TTL: 60 * 60 * 1000, // 1 hour
        l2TTL: 24 * 60 * 60 * 1000, // 24 hours
        description: 'Sampled global content-mean embedding for damper mean-centering',
        protected: true,
    },

    /**
     * PROTECTED: Per-user "content cluster affinity" signal (whether the
     * user's own watch/rating history welcomes each content cluster — kids/
     * family, anime). Feeds the For-You mood-rail cluster soft-suppression
     * decision. Derived from slow-moving engagement history, so a long TTL
     * is safe.
     */
    contentAffinity: {
        name: 'content-affinity-v1',
        l1TTL: 6 * 60 * 60 * 1000, // 6 hours
        l2TTL: 6 * 60 * 60 * 1000, // 6 hours
        description: 'Per-user content cluster affinity signal (kids, anime)',
        protected: true,
    },

    // =========================================================================
    // Path Resolution
    // =========================================================================

    /**
     * Provider→container path mappings derived from library_paths.provider_path
     * L1-only (admin config, tiny dataset, rarely changes)
     * Invalidated on any library path CRUD mutation
     */
    libraryPathMappings: {
        name: 'library-path-mappings-v1',
        l1TTL: 5 * 60 * 1000, // 5 minutes in-memory
        l2TTL: 0, // L1 only
        description: 'Provider→container path mappings derived from library_paths table',
    },

    /**
     * Configured library root paths for boundary checks.
     * Used by isPathWithinLibraryRoots() as defense-in-depth against path traversal
     * via tampered DB rows. L1-only; refreshes every 60 seconds.
     */
    libraryRoots: {
        name: 'library-roots-v1',
        l1TTL: 60 * 1000, // 60 seconds in-memory
        l2TTL: 0, // L1 only
        description: 'Library root paths for file-read boundary checks (defense-in-depth)',
    },

    /**
     * Last image-cache cleanup result (when, what was freed, final size).
     * Read by the admin UI to show "Last cleanup: 2 hours ago, freed 240 MB".
     * Long L2 TTL so the panel keeps showing useful data even after a long
     * idle window — the next cleanup overwrites it.
     */
    imageCacheCleanupState: {
        name: 'image-cache-cleanup-state-v1',
        l1TTL: 60 * 1000, // 1 minute in-memory (admin polls every few seconds)
        l2TTL: 30 * 24 * 60 * 60 * 1000, // 30 days
        description: 'Last image-cache cleanup run summary',
    },

    // =========================================================================
    // Push relay
    // =========================================================================

    /**
     * The minted push relay token (≤24h ES256 JWT, push scope only),
     * shared by every process of the install and kept across restarts.
     *
     * Without it each process boot fetched its own token from lumastra.org, so
     * an install in a 30 s crash loop called lumastra.org every 30 s
     * per process. Written with a TTL equal to the token's remaining life.
     * L1 is short so a sibling's fresher token is seen on the next tick.
     *
     * Key: a single global key `'v1:relay-token'`.
     */
    pushRelayToken: {
        name: 'push-relay-token-v1',
        l1TTL: 60 * 1000, // unused: L1 is off for this namespace
        l2TTL: 24 * 60 * 60 * 1000, // ceiling; each write passes the token's remaining life
        // L2 only. The lock re-read and the compare-and-delete must see what a
        // sibling process wrote; a per-process copy would serve a stale or
        // already-removed token for up to l1TTL.
        enableL1: false,
        description: 'Minted push relay token shared across processes and restarts',
    },

    /**
     * Declined filename-absolute pairs of absolute-numbering reconciliation: the
     * file's episode title disagreed with the target's TMDB name and alt names.
     * A hit skips reloading the TMDB catalog on every metadata sync of the
     * series. Key: `buildVersionedCacheKey('absoluteNumberingDecline', orphanId,
     * tmdbEpisodeId, sha1(file title))`. Value: `true`. Not invalidated; the 7-day
     * TTL is the bound (a rename of the file or a different target is a new key).
     */
    absoluteNumberingDeclines: {
        name: 'absolute-numbering-declines-v1',
        l1TTL: 60 * 60 * 1000, // 1 hour in-memory (each replica re-reads L2 afterwards)
        l2TTL: 7 * 24 * 60 * 60 * 1000, // 7 days
        description:
            'Filename-absolute pairs declined for a title mismatch (skips the TMDB reload)',
    },
} as const;

/**
 * Type for valid cache namespace names (string literal union)
 */
export type CacheNamespace = (typeof CACHE_NAMESPACES)[keyof typeof CACHE_NAMESPACES]['name'];

/**
 * Type for valid cache namespace config objects
 * This is the type that cacheManager.for() accepts - only exact values from CACHE_NAMESPACES
 */
export type RegisteredCacheConfig = (typeof CACHE_NAMESPACES)[keyof typeof CACHE_NAMESPACES];

/**
 * Get namespace config by name (for runtime lookups)
 */
export function getNamespaceConfig(name: string): CacheNamespaceConfig | undefined {
    return Object.values(CACHE_NAMESPACES).find((ns) => ns.name === name);
}

/**
 * Get all namespace configs (for pre-registration)
 */
export function getAllNamespaceConfigs(): CacheNamespaceConfig[] {
    return Object.values(CACHE_NAMESPACES);
}

/**
 * Check if a namespace is registered.
 *
 * Returns true for:
 * - Statically registered namespaces in CACHE_NAMESPACES
 * - Dynamic plugin namespaces matching `plugin:*` pattern
 *
 * Plugin namespaces are auto-allowed so plugins can use caching
 * without requiring changes to this file.
 */
export function isRegisteredNamespace(name: string): boolean {
    // Allow dynamic plugin namespaces (plugin:my-plugin, plugin:holidays, etc.)
    if (name.startsWith('plugin:')) {
        return true;
    }
    return Object.values(CACHE_NAMESPACES).some((ns) => ns.name === name);
}

/**
 * Get all valid namespace names (for validation)
 */
export function getValidNamespaceNames(): Set<string> {
    return new Set(Object.values(CACHE_NAMESPACES).map((ns) => ns.name));
}

/**
 * Validate a namespace name and throw if invalid
 * Use this when accepting namespace from external input (e.g., admin API)
 */
export function validateNamespace(name: string): void {
    if (!isRegisteredNamespace(name)) {
        const validNames = Object.values(CACHE_NAMESPACES)
            .map((ns) => ns.name)
            .join(', ');
        throw new Error(
            `Invalid cache namespace: "${name}". ` + `Valid namespaces are: ${validNames}`,
        );
    }
}

/**
 * Check if a namespace is protected (user preference data that shouldn't be cleared)
 */
export function isProtectedNamespace(name: string): boolean {
    return (Object.values(CACHE_NAMESPACES) as CacheNamespaceConfig[]).some(
        (ns) => ns.name === name && ns.protected === true,
    );
}

/**
 * Get all protected namespace names
 */
export function getProtectedNamespaceNames(): string[] {
    return (Object.values(CACHE_NAMESPACES) as CacheNamespaceConfig[])
        .filter((ns) => ns.protected)
        .map((ns) => ns.name);
}

// =============================================================================
// Cache Key Version Registry
// =============================================================================

/**
 * Centralized cache key version registry.
 *
 * Increment a version when the cache format changes to force invalidation.
 * This avoids scattered hardcoded version prefixes throughout the codebase.
 *
 * When updating a version:
 * 1. Increment the version string (e.g., 'v4' -> 'v5')
 * 2. Add a comment documenting what changed
 * 3. All usages of buildVersionedCacheKey() will automatically use the new version
 */
export const CACHE_KEY_VERSIONS = {
    /** v4: Include RT ratings in similar content cache (2024-01) */
    similarContent: 'v4',
    /** v17: Fixed popularity queries to aggregate ALL users */
    watchStats: 'v17',
    /**
     * v3: Access-context fingerprint now folded into completion/records keys
     * (B3 cache-poisoning fix). Bumped from v2 to invalidate any pre-fix entries
     * that were keyed without the access dimension. Distinct from adminStats so a
     * targeted-user admin payload can never satisfy a personal read (and vice versa).
     */
    // v4: topTitles mediaType canonicalized 'tv'->'series'; bumped to invalidate
    // pre-deploy entries whose cached payload would now fail the stricter
    // PersonalStatsEnvelopeSchema.parse() on a cache hit (transient 500s otherwise).
    // v5: title-level completion, genre/device/keyword/record fixes and the
    // runtime-capped watch time (2026-09-27) — cached payloads carry the old
    // per-session numbers.
    personalStats: 'v5',
    assistantOpener: 'v1',
    /**
     * a1: Admin stats keyed in a DISTINCT version namespace from personalStats so
     * the byte-identical `<version>:completion:all` key can never collide between
     * the personal and admin surfaces (B3). (Previously both were 'v2'.)
     */
    // a3: same payload changes as personalStats v5.
    adminStats: 'a3',
    absoluteNumberingDecline: 'v1',
} as const;

/**
 * Type for valid cache key version names
 */
export type CacheKeyVersion = keyof typeof CACHE_KEY_VERSIONS;

/**
 * Build a versioned cache key using the centralized version registry.
 *
 * @param version - The version key from CACHE_KEY_VERSIONS
 * @param parts - Additional key parts to join with ':'
 * @returns Versioned cache key string
 *
 * @example
 * // Returns "v4:tmdb:550:movie"
 * buildVersionedCacheKey('similarContent', 'tmdb:550:movie')
 *
 * @example
 * // Returns "v17:movies:AllTime"
 * buildVersionedCacheKey('watchStats', 'movies', 'AllTime')
 */
export function buildVersionedCacheKey(
    version: CacheKeyVersion,
    ...parts: (string | number)[]
): string {
    return `${CACHE_KEY_VERSIONS[version]}:${parts.join(':')}`;
}

// =============================================================================
// Plugin Cache Helpers
// =============================================================================

/**
 * Default TTLs for plugin caches.
 * Plugins can override these when creating their cache config.
 */
export const PLUGIN_CACHE_DEFAULTS = {
    l1TTL: 5 * 60 * 1000, // 5 minutes
    l2TTL: 30 * 60 * 1000, // 30 minutes
} as const;

/**
 * Create a cache namespace config for a plugin.
 *
 * Plugin caches use the `plugin:` prefix and are auto-allowed without
 * pre-registration in CACHE_NAMESPACES.
 *
 * @param pluginId - The plugin's unique identifier
 * @param options - Optional TTL overrides and description
 * @returns CacheNamespaceConfig for use with cacheManager.for()
 *
 * @example
 * ```typescript
 * import { cacheManager } from '$lib/server/cache';
 * import { createPluginCacheConfig } from '$lib/server/cache/namespaces';
 *
 * // Basic usage with defaults (5min L1, 30min L2)
 * const cache = cacheManager.for(createPluginCacheConfig('my-plugin'));
 *
 * // Custom TTLs
 * const cache = cacheManager.for(createPluginCacheConfig('my-plugin', {
 *     l1TTL: 10 * 60 * 1000,  // 10 minutes
 *     l2TTL: 60 * 60 * 1000,  // 1 hour
 *     description: 'My plugin data cache'
 * }));
 * ```
 */
export function createPluginCacheConfig(
    pluginId: string,
    options?: Partial<Omit<CacheNamespaceConfig, 'name'>>,
): CacheNamespaceConfig {
    return {
        name: `plugin:${pluginId}`,
        l1TTL: options?.l1TTL ?? PLUGIN_CACHE_DEFAULTS.l1TTL,
        l2TTL: options?.l2TTL ?? PLUGIN_CACHE_DEFAULTS.l2TTL,
        description: options?.description ?? `Cache for ${pluginId} plugin`,
        protected: options?.protected,
    };
}

/**
 * Cache key for warmed browse genre sections, keyed by the browse tab type
 * ('all' | 'movies' | 'series'). The `g3:` prefix versions the payload — bumped
 * when cross-rail dedup landed in buildBrowseGenreSections (a title now appears
 * only in its first rail), so stale pre-dedup entries are ignored instead of
 * served. (`g2:` bump history: genre sourcing fixed to read across providers —
 * TV genres live in `tmdb`, not `aggregated`.)
 *
 * Shared by the cache-warming service and the /api/browse endpoint.
 */
export function browseGenresCacheKey(type: string): string {
    // g4: ratings are review scores, never popularity.
    return `g4:${type}:0:12`;
}
