// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Cache Warming Service
 *
 * Pre-populates caches on application startup to eliminate cold starts.
 * Runs in background without blocking server initialization.
 *
 * What gets warmed:
 * 1. Trending content (all types)
 * 2. Popular media metadata
 * 3. Hero next-up for active users
 * 4. Browse page caches (genres, channels, A-Z, libraries, recently added)
 *
 * (The legacy "AI suggestions" warmer that wrote the `aiSuggestions` namespace's
 * `suggestions:list` / `suggestion:${id}` keys was removed with the `sections:v2`
 * composer it existed to pre-populate. Those keys were already unread by any
 * live route.)
 */

const dev = process.env.NODE_ENV !== 'production';
import { Logger } from '../utils/logger';
import { CACHE_NAMESPACES, browseGenresCacheKey } from './namespaces';
import type { Sql } from 'postgres';
import { getDb } from '../database/connection.js';
import {
    getAvailableLibraries,
    buildBrowseGenreSections,
    buildBrowseKeywordSections,
    getFilteredRecentlyAddedMedia,
} from '../database/queries/browse.queries.js';
import { unrestrictedAccess } from '../database/queries/builders/media-access-boundary.js';
import { isMovie } from '../utils/media-types.js';
import { config } from '$lib/server/config.js';
import { browseScopedCacheKey, type SearchAccessContext } from '../utils/search-access-context.js';
import { toUserId } from '$lib/shared/user-id.js';
import { escapeRequestLanguage } from '../utils/request-language-context.js';
import type { TMDBSearchResult } from '../providers/implementations/tmdb/index.js';
import type { ProviderDiscoverResult } from '@sapd/lumastra-plugin-sdk';

const logger = Logger.for('CacheWarming');

export interface CacheWarmingConfig {
    enabled: boolean;
    trendingEnabled: boolean;
    metadataEnabled: boolean;
    heroNextUpEnabled: boolean;
    /** Browse page caches (genres, channels, A-Z, libraries, recently added) */
    browseEnabled: boolean;
    /** ForYou global sections (trending, popular-shows, fresh-releases, explore-keywords) */
    forYouEnabled: boolean;
    activeUsersLimit: number;
    metadataLimit: number;
    /** How far back to look for active users (days) */
    activeUsersDays: number;
}

export interface CacheWarmingProgress {
    status: 'idle' | 'warming' | 'completed' | 'failed';
    startTime: Date | null;
    endTime: Date | null;
    tasksTotal: number;
    tasksCompleted: number;
    errors: Array<{ task: string; error: string }>;
    duration?: number;
}

export class CacheWarmingService {
    private progress: CacheWarmingProgress = {
        status: 'idle',
        startTime: null,
        endTime: null,
        tasksTotal: 0,
        tasksCompleted: 0,
        errors: [],
    };

    private readonly overrides: () => Partial<CacheWarmingConfig>;

    /**
     * `config` may be a function: it is then re-read on every warm, so the
     * CACHE_WARM_* settings apply to the next run without a restart (the
     * service is a long-lived singleton).
     */
    constructor(config?: Partial<CacheWarmingConfig> | (() => Partial<CacheWarmingConfig>)) {
        this.overrides = typeof config === 'function' ? config : () => config ?? {};
    }

    private get config(): CacheWarmingConfig {
        return {
            enabled: true,
            trendingEnabled: true,
            metadataEnabled: true,
            heroNextUpEnabled: true,
            browseEnabled: true,
            forYouEnabled: true,
            activeUsersLimit: 20,
            metadataLimit: 100,
            activeUsersDays: 14,
            ...this.overrides(),
        };
    }

    getConfig(): CacheWarmingConfig {
        return this.config;
    }

    /**
     * Start cache warming (non-blocking by default)
     * @param blocking If true, waits for all tasks to complete before returning
     */
    async warmCaches(blocking: boolean = false): Promise<void> {
        // Skip cache warming in development mode to prevent constant re-warming on hot reloads
        if (dev) {
            logger.info('Cache warming disabled in development mode');
            return;
        }

        if (!this.config.enabled) {
            logger.info('Cache warming disabled');
            return;
        }

        if (this.progress.status === 'warming') {
            logger.warn('Cache warming already in progress');
            return;
        }

        logger.info('🔥 Starting cache warming...');

        this.progress = {
            status: 'warming',
            startTime: new Date(),
            endTime: null,
            tasksTotal: this.countEnabledTasks(),
            tasksCompleted: 0,
            errors: [],
        };

        if (blocking) {
            // Wait for all tasks to complete (for manual triggers)
            await this.runWarmingTasks();
        } else {
            // Run warming tasks in background (don't await) - for startup
            this.runWarmingTasks().catch((error) => {
                logger.error('Cache warming failed', error as Error);
                this.progress.status = 'failed';
            });
        }
    }

    /**
     * Run all warming tasks
     *
     * Escapes any inherited request language hint: this is invoked directly
     * from an HTTP admin trigger (`triggerCacheWarming` → `warmUserCachesOnly`
     * and `warmCaches` → here), which would otherwise run inside the
     * requesting admin's `runWithRequestLanguage` ALS scope. Several tasks
     * below (hero next-up, ForYou) resolve per-user metadata language via
     * `resolveViewerMetadataLanguages`, and for any pref-less user that falls
     * through to the ambient request hint — the admin's, not that user's.
     */
    private async runWarmingTasks(): Promise<void> {
        return escapeRequestLanguage(() => this.runWarmingTasksImpl());
    }

    private async runWarmingTasksImpl(): Promise<void> {
        if (!this.progress.startTime) {
            this.progress.startTime = new Date();
        }
        if (!this.progress.tasksTotal) {
            this.progress.tasksTotal = this.countEnabledTasks();
        }
        if (this.progress.status !== 'warming') {
            this.progress.status = 'warming';
        }
        const tasks: Array<() => Promise<void>> = [];

        if (this.config.trendingEnabled) {
            tasks.push(() => this.warmTrending());
        }

        if (this.config.metadataEnabled) {
            tasks.push(() => this.warmMetadata());
        }

        if (this.config.heroNextUpEnabled) {
            tasks.push(() => this.warmHeroNextUp());
        }

        if (this.config.browseEnabled) {
            tasks.push(() => this.warmBrowse());
        }

        if (this.config.forYouEnabled) {
            tasks.push(() => this.warmForYou());
        }

        // Run all tasks with error handling
        await Promise.allSettled(
            tasks.map((task) =>
                task().then(() => {
                    this.progress.tasksCompleted++;
                }),
            ),
        );

        this.progress.status = 'completed';
        this.progress.endTime = new Date();
        this.progress.duration =
            this.progress.endTime.getTime() - this.progress.startTime.getTime();

        logger.info('✅ Cache warming completed', {
            duration: this.progress.duration,
            tasksCompleted: this.progress.tasksCompleted,
            errors: this.progress.errors.length,
        });
    }

    /**
     * Warm trending content cache
     */
    private async warmTrending(): Promise<void> {
        try {
            logger.info('Warming trending cache...');

            // Dynamically import to avoid circular dependencies
            const { tmdbApi } = await import('../providers/implementations/tmdb/index.js');
            const { invokeProviderTrending } = await import('../tasks/plugin-context.js');
            const { cacheManager } = await import('./index');

            if (!tmdbApi.isAvailable()) {
                logger.warn('TMDB API not available, skipping trending cache warming');
                return;
            }

            // Type-safe cache - TTLs from centralized CACHE_NAMESPACES config
            const trendingCache = cacheManager.for(CACHE_NAMESPACES.trending);

            const mediaTypes = ['movie', 'tv'] as const;

            await Promise.all(
                mediaTypes.map(async (mediaType) => {
                    try {
                        // Prefer the provider SDK, but fall back to the direct tmdbApi
                        // when the invoke yields nothing OR throws. On a web container
                        // (WORKER_MODE=disabled) the provider path can throw, and the
                        // original code only fell back on an empty result — so both
                        // media types errored and trending never pre-warmed.
                        let results: ProviderDiscoverResult[] | TMDBSearchResult[] = [];
                        try {
                            results = await invokeProviderTrending('tmdb-metadata-provider', {
                                mediaType,
                                window: 'week',
                            });
                        } catch (invokeError) {
                            logger.debug('Provider trending invoke failed; using tmdbApi', {
                                type: mediaType,
                                error: (invokeError as Error).message,
                            });
                        }

                        if (results.length === 0) {
                            const trending =
                                mediaType === 'movie'
                                    ? await tmdbApi.getTrendingMovies()
                                    : await tmdbApi.getTrendingTVShows();
                            results = trending.results || [];
                        }

                        // TTL comes from CACHE_NAMESPACES.trending config
                        await trendingCache.set(`${mediaType}:tmdb:20`, results);

                        logger.debug('Warmed trending cache', {
                            type: mediaType,
                            count: results.length,
                        });
                    } catch (error) {
                        // best-effort: recorded in progress.errors AND logged — this inner
                        // catch was previously silent, so failures showed up only as an
                        // opaque "errors: N" in the completion summary.
                        logger.warn('Failed to warm trending cache for media type', {
                            type: mediaType,
                            error: (error as Error).message,
                        });
                        this.progress.errors.push({
                            task: `trending:${mediaType}`,
                            error: (error as Error).message,
                        });
                    }
                }),
            );

            logger.info('✓ Trending cache warmed');
        } catch (error) {
            logger.error('Failed to warm trending cache', error as Error);
            this.progress.errors.push({
                task: 'trending',
                error: (error as Error).message,
            });
        }
    }

    /**
     * Warm media metadata cache
     */
    private async warmMetadata(): Promise<void> {
        try {
            logger.info('Warming metadata cache...');

            // Get AI database for popular media
            const { Database, testDbConnection } = await import('../database');
            const { cacheManager } = await import('./index');

            const aiHealthy = await testDbConnection();
            if (!aiHealthy) {
                logger.warn('AI database not available, skipping metadata warming');
                return;
            }

            const db = new Database();
            // Type-safe cache - TTLs from centralized CACHE_NAMESPACES config
            const metadataCache = cacheManager.for(CACHE_NAMESPACES.mediaEmbeddings);

            // Get most popular media (from user suggestions via UUID-based table)
            const popularMedia = (await db.sqlClient`
                SELECT DISTINCT us.media_id, COUNT(*) as count
                FROM user_suggestions us
                WHERE us.created_at > NOW() - INTERVAL '7 days'
                GROUP BY us.media_id
                ORDER BY count DESC
                LIMIT ${this.config.metadataLimit}
            `) as unknown as PopularMediaRow[];

            // Process in parallel batches of 10 for better performance
            const BATCH_SIZE = 10;
            let warmed = 0;

            for (let i = 0; i < popularMedia.length; i += BATCH_SIZE) {
                const batch = popularMedia.slice(i, i + BATCH_SIZE);
                const results = await Promise.allSettled(
                    batch.map(async (row) => {
                        const media = await db.getMediaEmbeddingByUuid(row.media_id);
                        if (media?.title) {
                            await metadataCache.set(`media:${row.media_id}`, media);
                            return true;
                        }
                        return false;
                    }),
                );
                warmed += results.filter((r) => r.status === 'fulfilled' && r.value).length;
            }

            logger.info('✓ Metadata cache warmed', { count: warmed });
        } catch (error) {
            logger.error('Failed to warm metadata cache', error as Error);
            this.progress.errors.push({
                task: 'metadata',
                error: (error as Error).message,
            });
        }
    }

    /**
     * Warm hero section Next Up cache for active users.
     * Uses Lumastra DB watch state (watchManager.getNextUp) — no Jellyfin dependency.
     */
    private async warmHeroNextUp(): Promise<void> {
        try {
            logger.info('Warming hero nextUp cache...');

            const { Database, testDbConnection } = await import('../database');
            const { watchManager } = await import('../services/watch-manager.service');
            const { cacheManager } = await import('./index');
            const { nextUpRowToMediaItem } = await import('$lib/server/utils/next-up-media-item');

            const aiHealthy = await testDbConnection();
            if (!aiHealthy) {
                logger.warn('AI database not available, skipping hero nextUp warming');
                return;
            }

            const db = new Database();
            const heroNextUpCache = cacheManager.for(CACHE_NAMESPACES.heroNextUp);

            // Get active users from watch_history (last N days)
            const activeUsers = await getActiveUsers(db, this.config);

            if (activeUsers.length === 0) {
                logger.info('No active users found for hero nextUp warming');
                return;
            }

            // Process users in parallel
            const results = await Promise.allSettled(
                activeUsers.map(async (row) => {
                    // watch_history.user_id is the stable users.id UUID (mig 16.46.0).
                    const userId = toUserId(row.user_id);
                    try {
                        // Fetch next up from Lumastra DB (limit 1 for hero section)
                        const limit = 1;
                        const nextUpRows = await watchManager.getNextUp(userId, limit);
                        const transformed = nextUpRows.map(nextUpRowToMediaItem);

                        // Warm the entry in THIS user's metadata language, under
                        // the same language-tokened key the route reads. Warming
                        // the bare key instead would leave every non-primary-
                        // language viewer permanently on the cold path (their
                        // read key carries a token the warmer never wrote) —
                        // i.e. the warmer would be dead for exactly the users
                        // the overlay exists for. Zero extra queries when the
                        // feature is off: both calls short-circuit on NO_OVERLAY.
                        const [
                            { resolveViewerMetadataLanguages },
                            { overlayHeroMediaItems, heroLangCacheToken },
                        ] = await Promise.all([
                            import('../utils/metadata-language-resolve.js'),
                            import('../utils/hero-item-translation.js'),
                        ]);
                        const sql = getDb();
                        const langs = await resolveViewerMetadataLanguages(sql, userId);
                        if (sql) await overlayHeroMediaItems(sql, transformed, langs);

                        // Cache with user scope (same versioned key the API route reads —
                        // v2: per-user scope keyed by users.id UUID, not username).
                        const cacheKey = `v2:nextup:${limit}${heroLangCacheToken(langs)}`;
                        await heroNextUpCache.set(
                            cacheKey,
                            {
                                data: transformed,
                                cachedAt: Date.now(),
                            },
                            undefined,
                            userId,
                        );

                        return true;
                    } catch (error) {
                        logger.debug('Failed to warm hero nextUp for user', {
                            user: userId,
                            error: (error as Error).message,
                        });
                        return false;
                    }
                }),
            );

            const warmed = results.filter((r) => r.status === 'fulfilled' && r.value).length;
            logger.info('✓ Hero nextUp cache warmed', {
                users: warmed,
                total: activeUsers.length,
            });
        } catch (error) {
            logger.error('Failed to warm hero nextUp cache', error as Error);
            this.progress.errors.push({
                task: 'hero-nextup',
                error: (error as Error).message,
            });
        }
    }

    /**
     * Warm browse page caches (genres, channels, A-Z, libraries, recently added)
     * Uses Lumastra DB queries — no Jellyfin dependency.
     */
    private async warmBrowse(): Promise<void> {
        try {
            logger.info('Warming browse caches...');

            const { getLiveTvProvider } = await import('../services/livetv/index.js');
            const { testDbConnection } = await import('../database');
            const { cacheManager } = await import('./index');

            // Warm all browse caches in parallel
            const warmingTasks: Array<{
                name: string;
                task: () => Promise<void>;
            }> = [];

            // 1. Browse Genres — Lumastra DB query
            warmingTasks.push({
                name: 'genres',
                task: async () => {
                    const aiHealthy = await testDbConnection();
                    if (!aiHealthy) {
                        logger.debug('Skipped genres warming (database not available)');
                        return;
                    }

                    const sql = getDb();
                    if (!sql) {
                        logger.debug('Skipped genres warming (SQL not available)');
                        return;
                    }

                    const genresCache = cacheManager.for(CACHE_NAMESPACES.browseGenres);

                    // Warm all three media type variants: all, movies, series.
                    // Section building (priority sort, item fetch, sparse-row
                    // drop) is shared with the /api/browse endpoint via
                    // buildBrowseGenreSections so the two can't drift.
                    const mediaTypeConfigs: Array<{
                        key: string;
                        dbType: 'all' | 'movie' | 'tv';
                    }> = [
                        { key: 'all', dbType: 'all' },
                        { key: 'movie', dbType: 'movie' },
                        { key: 'series', dbType: 'tv' },
                    ];

                    for (const { key: mediaTypeKey, dbType } of mediaTypeConfigs) {
                        const sections = await buildBrowseGenreSections(sql, {
                            mediaType: dbType,
                            access: unrestrictedAccess(),
                        });

                        await genresCache.set(browseGenresCacheKey(mediaTypeKey), sections);
                    }

                    logger.debug('Warmed browse genres for all media types');
                },
            });

            // 2. Browse Channels (via LiveTV provider)
            warmingTasks.push({
                name: 'channels',
                task: async () => {
                    const channelsCache = cacheManager.for(CACHE_NAMESPACES.browseChannels);

                    try {
                        const provider = await getLiveTvProvider();
                        const liveTvChannels = await provider.getChannels();
                        if (liveTvChannels.length === 0) {
                            logger.debug('Skipped channels warming (no channels available)');
                            return;
                        }
                        const channels = liveTvChannels
                            .filter((ch) => ch.isVisible)
                            .slice(0, 50)
                            .map((ch) => ({
                                id: ch.id,
                                name: ch.name,
                                type: 'channel' as const,
                                overview: ch.currentProgram?.title,
                                imageId: ch.images.primary?.href ? ch.id : undefined,
                            }));

                        await channelsCache.set('all', channels);
                        logger.debug('Warmed browse channels', {
                            count: channels.length,
                        });
                    } catch {
                        // Live TV might not be configured, that's okay
                        logger.debug('Skipped channels warming (Live TV not available)');
                    }
                },
            });

            // 3. Browse Libraries
            warmingTasks.push({
                name: 'libraries',
                task: async () => {
                    const aiHealthy = await testDbConnection();
                    if (!aiHealthy) {
                        logger.debug('Skipped libraries warming (AI database not available)');
                        return;
                    }

                    const librariesCache = cacheManager.for(CACHE_NAMESPACES.browseLibraries);
                    const sql = getDb();
                    if (!sql) {
                        logger.debug('Skipped libraries warming (SQL not available)');
                        return;
                    }

                    const libraries = await getAvailableLibraries(sql, unrestrictedAccess());
                    // Key MUST match the endpoint's unrestricted browseScopedCacheKey
                    // ('v6:groups'). The old 'all' key was never read by any
                    // request, so this warm step was silently wasted.
                    await librariesCache.set('v6:groups', {
                        libraries,
                        totalLibraries: libraries.length,
                    });

                    logger.debug('Warmed browse libraries', {
                        count: libraries.length,
                    });
                },
            });

            // A-Z pages are cached on demand by the browse endpoint. The former
            // v6 warmer read entire catalogs (up to a million rows per type)
            // into keys no paginated endpoint consumes. Do not revive it without
            // sharing the endpoint's bounded page loader and cache-key builder.

            // 5. Recently Added — Lumastra DB query
            warmingTasks.push({
                name: 'recently-added',
                task: async () => {
                    const aiHealthy = await testDbConnection();
                    if (!aiHealthy) {
                        logger.debug('Skipped recently-added warming (database not available)');
                        return;
                    }

                    const sql = getDb();
                    if (!sql) {
                        logger.debug('Skipped recently-added warming (SQL not available)');
                        return;
                    }

                    const recentlyAddedCache = cacheManager.for(
                        CACHE_NAMESPACES.browseRecentlyAdded,
                    );

                    // Warm all three media type variants: all, movies, series
                    const mediaTypeConfigs: Array<{
                        key: string;
                        dbType: 'all' | 'movie' | 'tv';
                    }> = [
                        { key: 'all', dbType: 'all' },
                        { key: 'movie', dbType: 'movie' },
                        { key: 'series', dbType: 'tv' },
                    ];

                    for (const { key: mediaTypeKey, dbType } of mediaTypeConfigs) {
                        // Match /api/browse: default carousel uses the 'titles'
                        // newness mode (only brand-new titles surface).
                        const results = await getFilteredRecentlyAddedMedia(sql, {
                            mediaType: dbType,
                            limit: 20,
                            newness: 'titles',
                            access: unrestrictedAccess(),
                        });

                        // Map to BrowseItem format
                        const items = results.map((row) => ({
                            id: row.id,
                            name: row.title,
                            // Canonical public discriminant is 'movie' | 'series'
                            // (BrowseItemSchema rejects 'tv') — must match /api/browse's
                            // live mapping, or the warmed cache fails client validation.
                            type: (isMovie(row.media_type) ? 'movie' : 'series') as
                                'movie' | 'series',
                            overview: row.overview ?? undefined,
                            imageId: row.id,
                        }));

                        // 'titles-v1' prefix must stay in sync with /api/browse.
                        await recentlyAddedCache.set(`titles-v1:${mediaTypeKey}`, items);
                    }

                    logger.debug('Warmed browse recently added for all media types');
                },
            });

            // 6. Browse Keywords — Lumastra DB query. Warms the initial page
            // (offset 0, limit 5 = keywordsQuerySchema default) for each media
            // type, unrestricted access. Mirrors the genres warmer: it shares the
            // buildBrowseKeywordSections builder with /api/browse/keywords so the
            // two can't drift, and writes the bare (unrestricted) access-scoped key
            // that admins/unrestricted users read. Restricted users key with a
            // denied-group/age suffix and fill on first request.
            warmingTasks.push({
                name: 'keywords',
                task: async () => {
                    const aiHealthy = await testDbConnection();
                    if (!aiHealthy) {
                        logger.debug('Skipped keywords warming (database not available)');
                        return;
                    }

                    const sql = getDb();
                    if (!sql) {
                        logger.debug('Skipped keywords warming (SQL not available)');
                        return;
                    }

                    const keywordsCache = cacheManager.for(CACHE_NAMESPACES.browseKeywords);

                    // Truly-unrestricted context: null denied groups + null age
                    // rating → browseScopedCacheKey emits an empty access suffix,
                    // producing the same bare key an admin/unrestricted user reads.
                    const unrestrictedCtx: SearchAccessContext = {
                        username: null,
                        deniedGroupIds: null,
                        ageRating: null,
                        liveTvAllowed: false,
                        showUnavailableMedia: true,
                    };
                    const DEFAULT_OFFSET = 0;
                    // Must track the endpoint's initial-page limit so the warmed
                    // key matches what a real request reads. The endpoint derives
                    // it from BROWSE_KEYWORDS_INITIAL (default 5); a hardcoded 5
                    // here would silently warm a dead key if that's reconfigured.
                    const DEFAULT_LIMIT = config.BROWSE_KEYWORDS_INITIAL;

                    // Public media-type value drives the cache key (matches the
                    // endpoint's key); dbType drives the query column filter.
                    const mediaTypeConfigs: Array<{
                        key: 'all' | 'movie' | 'series';
                        dbType: 'all' | 'movie' | 'tv';
                    }> = [
                        { key: 'all', dbType: 'all' },
                        { key: 'movie', dbType: 'movie' },
                        { key: 'series', dbType: 'tv' },
                    ];

                    for (const { key: publicType, dbType } of mediaTypeConfigs) {
                        const result = await buildBrowseKeywordSections(sql, {
                            mediaType: dbType,
                            limit: DEFAULT_LIMIT,
                            offset: DEFAULT_OFFSET,
                            access: unrestrictedAccess(),
                        });
                        const cacheKey = browseScopedCacheKey('bk1', unrestrictedCtx, [
                            publicType,
                            DEFAULT_OFFSET,
                            DEFAULT_LIMIT,
                        ]);
                        await keywordsCache.set(cacheKey, result);
                    }

                    logger.debug('Warmed browse keywords for all media types');
                },
            });

            // Execute all warming tasks
            const results = await Promise.allSettled(
                warmingTasks.map(async ({ name, task }) => {
                    try {
                        await task();
                        return { name, success: true };
                    } catch (error) {
                        // best-effort: cache warming — failure recorded in progress.errors, not swallowed.
                        this.progress.errors.push({
                            task: `browse:${name}`,
                            error: (error as Error).message,
                        });
                        return { name, success: false };
                    }
                }),
            );

            const succeeded = results.filter(
                (r) => r.status === 'fulfilled' && r.value.success,
            ).length;
            logger.info('✓ Browse caches warmed', {
                succeeded,
                total: warmingTasks.length,
            });
        } catch (error) {
            logger.error('Failed to warm browse caches', error as Error);
            this.progress.errors.push({
                task: 'browse',
                error: (error as Error).message,
            });
        }
    }

    /**
     * Warm ForYou global curated content sections
     * Only warms sections with global cache keys (no user suffix).
     */
    private async warmForYou(): Promise<void> {
        try {
            logger.info('Warming ForYou curated content caches...');

            const { testDbConnection } = await import('../database');
            const { cacheManager } = await import('./index');

            const dbHealthy = await testDbConnection();
            if (!dbHealthy) {
                logger.warn('Database not available, skipping ForYou cache warming');
                return;
            }

            const { getDb } = await import('../database/connection.js');
            const sql = getDb();
            if (!sql) {
                logger.warn('SQL not available, skipping ForYou cache warming');
                return;
            }

            const { fetchTrending, fetchPopularShows, fetchFreshReleases, fetchPopularKeywords } =
                await import('../services/for-you.service.js');
            const { unrestrictedAccess } =
                await import('../database/queries/builders/media-access-boundary.js');

            const curatedCache = cacheManager.for(CACHE_NAMESPACES.curatedContent);

            // Warm bare keys (no age-rating or denied-group suffixes).
            // Users with restrictions use suffixed keys that get cached on first request.
            //
            // DELIBERATE PRIVILEGE ASSERTION. The warmer runs as no user at all,
            // so it has no permissions to derive a boundary from — it asserts an
            // explicitly unrestricted one and writes the result into a globally
            // readable cache key. Previously this was implicit: the access
            // arguments were simply omitted and the permissive defaults filled
            // them in, so nothing at this call site said "unfiltered". Now it
            // does, and it is greppable.
            //
            // This is safe ONLY because of how the read path keys these rails: a
            // restricted user's request goes through scopedCacheKey, which
            // appends a `|denied:…|age:…` suffix, so it can never read the bare
            // key written here. Unrestricted users and admins produce an empty
            // suffix and legitimately share this entry. If the read path ever
            // stops suffixing by access, these four warm writes become a leak.
            const warmAccess = unrestrictedAccess();
            const warmingTasks: Array<{
                name: string;
                task: () => Promise<void>;
            }> = [
                {
                    name: 'trending',
                    task: async () => {
                        const CACHE_FETCH_SIZE = 20;
                        const cacheKey = 'trending:global:v2';
                        const cached = await curatedCache.get(cacheKey);
                        if (!cached) {
                            const trending = await fetchTrending(sql, CACHE_FETCH_SIZE, warmAccess);
                            await curatedCache.set(cacheKey, trending);
                            logger.debug('Warmed ForYou trending', {
                                count: trending.length,
                            });
                        } else {
                            logger.debug('ForYou trending already cached, skipping');
                        }
                    },
                },
                {
                    name: 'popular-shows',
                    task: async () => {
                        const CACHE_FETCH_SIZE = 30;
                        const cacheKey = 'popular-shows:global:v3';
                        const cached = await curatedCache.get(cacheKey);
                        if (!cached) {
                            const popularShows = await fetchPopularShows(
                                sql,
                                CACHE_FETCH_SIZE,
                                warmAccess,
                            );
                            await curatedCache.set(cacheKey, popularShows);
                            logger.debug('Warmed ForYou popular-shows', {
                                count: popularShows.length,
                            });
                        } else {
                            logger.debug('ForYou popular-shows already cached, skipping');
                        }
                    },
                },
                {
                    name: 'fresh-releases',
                    task: async () => {
                        const CACHE_FETCH_SIZE = 50;
                        const cacheKey = 'fresh-releases:global';
                        const cached = await curatedCache.get(cacheKey);
                        if (!cached) {
                            const freshReleases = await fetchFreshReleases(
                                sql,
                                CACHE_FETCH_SIZE,
                                [],
                                warmAccess,
                            );
                            await curatedCache.set(cacheKey, freshReleases);
                            logger.debug('Warmed ForYou fresh-releases', {
                                count: freshReleases.length,
                            });
                        } else {
                            logger.debug('ForYou fresh-releases already cached, skipping');
                        }
                    },
                },
                {
                    name: 'explore-keywords',
                    // TODO(library-access): The read path now appends a ':g<denied-ids>'
                    // suffix to the cache key for users with library restrictions. This
                    // warmer only fills the bare 'explore-keywords:global' key (no denied
                    // suffix), so it is effectively dead for restricted users — their first
                    // request will be a cache miss and will fill a suffixed key instead.
                    // Warming restricted-user variants here would require enumerating every
                    // possible denied-group combination at startup, which is not practical.
                    // The bare key remains useful as a warm slot for admins and unrestricted
                    // users, so warming is intentionally kept as-is.
                    task: async () => {
                        const CACHE_FETCH_SIZE = 30;
                        const cacheKey = 'explore-keywords:global';
                        const cached = await curatedCache.get(cacheKey);
                        if (!cached) {
                            const keywords = await fetchPopularKeywords(
                                sql,
                                CACHE_FETCH_SIZE,
                                warmAccess,
                            );
                            await curatedCache.set(cacheKey, keywords);
                            logger.debug('Warmed ForYou explore-keywords', {
                                count: keywords.length,
                            });
                        } else {
                            logger.debug('ForYou explore-keywords already cached, skipping');
                        }
                    },
                },
            ];

            const results = await Promise.allSettled(
                warmingTasks.map(async ({ name, task }) => {
                    try {
                        await task();
                        return { name, success: true };
                    } catch (error) {
                        // best-effort: cache warming — failure recorded in progress.errors, not swallowed.
                        this.progress.errors.push({
                            task: `for-you:${name}`,
                            error: (error as Error).message,
                        });
                        return { name, success: false };
                    }
                }),
            );

            const succeeded = results.filter(
                (r) => r.status === 'fulfilled' && r.value.success,
            ).length;
            logger.info('✓ ForYou caches warmed', {
                succeeded,
                total: warmingTasks.length,
            });
        } catch (error) {
            logger.error('Failed to warm ForYou caches', error as Error);
            this.progress.errors.push({
                task: 'for-you',
                error: (error as Error).message,
            });
        }
    }

    /**
     * Count enabled warming tasks
     */
    private countEnabledTasks(): number {
        let count = 0;
        if (this.config.trendingEnabled) count++;
        if (this.config.metadataEnabled) count++;
        if (this.config.heroNextUpEnabled) count++;
        if (this.config.browseEnabled) count++;
        if (this.config.forYouEnabled) count++;
        return count;
    }

    /**
     * Get warming progress
     */
    getProgress(): CacheWarmingProgress {
        return { ...this.progress };
    }

    /**
     * Check if warming is complete
     */
    isComplete(): boolean {
        return this.progress.status === 'completed' || this.progress.status === 'failed';
    }

    /**
     * Reset progress
     */
    reset(): void {
        this.progress = {
            status: 'idle',
            startTime: null,
            endTime: null,
            tasksTotal: 0,
            tasksCompleted: 0,
            errors: [],
        };
    }
}

// Singleton instance
let warmingServiceInstance: CacheWarmingService | null = null;

export function getCacheWarmingService(
    config?: Partial<CacheWarmingConfig> | (() => Partial<CacheWarmingConfig>),
): CacheWarmingService {
    warmingServiceInstance ??= new CacheWarmingService(config);
    return warmingServiceInstance;
}

/**
 * Start cache warming (convenience function)
 */
export async function startCacheWarming(
    config?: Partial<CacheWarmingConfig> | (() => Partial<CacheWarmingConfig>),
): Promise<void> {
    const service = getCacheWarmingService(config);

    // Multi-replica guard: on a rolling deploy every replica boots and would
    // otherwise warm the full cache simultaneously, multiplying TMDB API load
    // at the worst moment. Take a short distributed lock so only one replica
    // does the initial warm; the others skip (the steady-state tiered
    // scheduler keeps caches fresh thereafter). If Valkey isn't ready yet at
    // boot we fall back to warming unconditionally — same as before.
    const { acquireLock, releaseLock, isValkeyReady } = await import('../cache/valkey');
    const lockKey = 'lock:cache-warming:startup';
    const lockTtl = WARMING_LOCK_TTL.nightly; // full warm — use the longest TTL

    if (!isValkeyReady()) {
        await service.warmCaches();
        return;
    }

    const lockValue = await acquireLock(lockKey, lockTtl);
    if (!lockValue) {
        logger.info('⏭️ Skipping startup cache warm (another replica is handling it)');
        return;
    }

    // Cap the heartbeat at the lock TTL: if a warm hangs past one TTL the
    // heartbeat stops extending and the lock expires, letting another replica
    // take over — rather than this replica holding the lock for up to an hour
    // while the warm is wedged.
    const stopHeartbeat = startCacheWarmingHeartbeat(lockKey, lockTtl, lockTtl * 1000);
    try {
        await service.warmCaches();
    } finally {
        stopHeartbeat();
        await releaseLock(lockKey, lockValue).catch(() => {
            /* lock expires via TTL */
        });
    }
}

// ============================================================================
// Tiered Cache Warming Scheduler
// ============================================================================
// Different caches have different TTLs, so we warm them at different intervals:
// - Frequent (every 3 hours): trending (4h TTL)
// - Regular (every 12 hours): heroNextUp (24h TTL)
// - Nightly (3 AM): Full warming including metadata

let frequentWarmingInterval: ReturnType<typeof setInterval> | null = null;
let regularWarmingInterval: ReturnType<typeof setInterval> | null = null;
let nightlyWarmingTimeout: ReturnType<typeof setTimeout> | null = null;

// Configuration for warming intervals (in milliseconds)
const WARMING_INTERVALS = {
    frequent: 3 * 60 * 60 * 1000, // 3 hours (before 4h trending TTL)
    regular: 12 * 60 * 60 * 1000, // 12 hours (before 24h heroNextUp TTL)
    nightly: 24 * 60 * 60 * 1000, // 24 hours
};

// Lock TTLs for distributed warming (prevents multiple replicas from warming simultaneously)
const WARMING_LOCK_TTL = {
    frequent: 5 * 60, // 5 minutes (trending warming is fast)
    regular: 15 * 60, // 15 minutes (hero + AI + browse)
    nightly: 30 * 60, // 30 minutes (full warming)
};

/**
 * Start lock heartbeat for cache warming operations
 * Extends lock TTL periodically and enforces maximum duration
 *
 * @param lockKey - The lock key to keep alive
 * @param lockTtlSeconds - Lock TTL to reset on each heartbeat
 * @param maxDurationMs - Maximum duration before aborting (1 hour for warming)
 * @returns Function to stop the heartbeat
 */
function startCacheWarmingHeartbeat(
    lockKey: string,
    lockTtlSeconds: number,
    maxDurationMs: number = 60 * 60 * 1000, // 1 hour max
): () => void {
    const startTime = Date.now();

    const interval = setInterval(() => {
        void (async () => {
            // Check if max duration exceeded
            const elapsed = Date.now() - startTime;
            if (elapsed > maxDurationMs) {
                logger.error('Cache warming exceeded maximum duration, aborting', undefined, {
                    lockKey,
                    elapsedMs: elapsed,
                    maxDurationMs,
                });
                clearInterval(interval);
                return;
            }

            // Extend lock TTL
            const { expire } = await import('../cache/valkey');
            const extended = await expire(lockKey, lockTtlSeconds);
            if (!extended) {
                logger.error(
                    'Cache warming lock heartbeat failed - lock lost or expired',
                    undefined,
                    {
                        lockKey,
                        elapsedMs: elapsed,
                    },
                );
                clearInterval(interval);
            }
        })();
    }, 60000);

    return () => {
        clearInterval(interval);
        logger.debug('Cache warming heartbeat stopped', { lockKey });
    };
}

/**
 * Warm only trending content (fast, shared across all users)
 */
async function warmTrendingOnly(): Promise<void> {
    // Try to acquire distributed lock to prevent multiple replicas from warming
    const { acquireLock, releaseLock, isValkeyReady } = await import('../cache/valkey');
    const lockKey = 'lock:cache-warming:frequent';
    let lockValue: string | null = null;
    let stopHeartbeat: (() => void) | null = null;

    if (isValkeyReady()) {
        lockValue = await acquireLock(lockKey, WARMING_LOCK_TTL.frequent);
        if (!lockValue) {
            logger.info('⏭️ Skipping frequent warming (another replica is handling it)');
            return;
        }

        // Start heartbeat to prevent lock expiration
        stopHeartbeat = startCacheWarmingHeartbeat(
            lockKey,
            WARMING_LOCK_TTL.frequent,
            10 * 60 * 1000, // 10 minutes max (trending is fast)
        );
    }

    try {
        logger.info('⚡ Running frequent warming (trending)...');
        // Access private method via prototype or just recreate the logic
        const { tmdbApi } = await import('../providers/implementations/tmdb/index.js');
        const { invokeProviderTrending } = await import('../tasks/plugin-context.js');
        const { cacheManager } = await import('./index');

        if (!tmdbApi.isAvailable()) {
            return;
        }

        const trendingCache = cacheManager.for(CACHE_NAMESPACES.trending);
        const mediaTypes = ['movie', 'tv'] as const;

        await Promise.all(
            mediaTypes.map(async (mediaType) => {
                try {
                    // Use SDK invoke helper; fall back to direct tmdbApi when provider
                    // capability is absent.
                    let results: ProviderDiscoverResult[] | TMDBSearchResult[] =
                        await invokeProviderTrending('tmdb-metadata-provider', {
                            mediaType,
                            window: 'week',
                        });

                    if (results.length === 0) {
                        const trending =
                            mediaType === 'movie'
                                ? await tmdbApi.getTrendingMovies()
                                : await tmdbApi.getTrendingTVShows();
                        results = trending.results || [];
                    }

                    await trendingCache.set(`${mediaType}:tmdb:20`, results);
                } catch (e) {
                    logger.debug('Trending warming task failed', {
                        type: mediaType,
                        error: e,
                    });
                }
            }),
        );

        // Track successful run
        lastFrequentRun = { timestamp: new Date(), success: true };
        logger.info('✓ Frequent warming completed (trending)');
    } catch (error) {
        lastFrequentRun = { timestamp: new Date(), success: false };
        logger.warn('Frequent warming failed', {
            error: (error as Error).message,
        });
    } finally {
        // Stop heartbeat
        stopHeartbeat?.();

        // Release the lock
        if (lockValue) {
            const released = await releaseLock(lockKey, lockValue);
            if (!released) {
                logger.warn('Failed to release frequent cache warming lock', {
                    lockKey,
                });
            }
        }
    }
}

/**
 * Warm hero and browse caches for active users
 */
async function warmUserCachesOnly(): Promise<void> {
    // Try to acquire distributed lock to prevent multiple replicas from warming
    const { acquireLock, releaseLock, isValkeyReady } = await import('../cache/valkey');
    const lockKey = 'lock:cache-warming:regular';
    let lockValue: string | null = null;
    let stopHeartbeat: (() => void) | null = null;

    if (isValkeyReady()) {
        lockValue = await acquireLock(lockKey, WARMING_LOCK_TTL.regular);
        if (!lockValue) {
            logger.info('⏭️ Skipping regular warming (another replica is handling it)');
            return;
        }

        // Start heartbeat to prevent lock expiration
        stopHeartbeat = startCacheWarmingHeartbeat(
            lockKey,
            WARMING_LOCK_TTL.regular,
            30 * 60 * 1000, // 30 minutes max
        );
    }

    try {
        logger.info('🔄 Running regular warming (hero + browse + ForYou)...');
        const service = getCacheWarmingService();

        // Create a temporary service with hero, browse, and ForYou enabled
        const tempService = new CacheWarmingService({
            enabled: true,
            trendingEnabled: false,
            metadataEnabled: false,
            heroNextUpEnabled: true,
            browseEnabled: true,
            forYouEnabled: true,
            activeUsersLimit: service['config'].activeUsersLimit,
            metadataLimit: 0,
            activeUsersDays: service['config'].activeUsersDays,
        });

        tempService['progress'] = {
            status: 'warming',
            startTime: new Date(),
            endTime: null,
            tasksTotal: tempService['countEnabledTasks'](),
            tasksCompleted: 0,
            errors: [],
        };
        await tempService['runWarmingTasks']();
        // Track successful run
        lastRegularRun = { timestamp: new Date(), success: true };
        logger.info('✓ Regular warming completed (hero + browse + ForYou)');
    } catch (error) {
        lastRegularRun = { timestamp: new Date(), success: false };
        logger.warn('Regular warming failed', {
            error: (error as Error).message,
        });
    } finally {
        // Stop heartbeat
        stopHeartbeat?.();

        // Release the lock
        if (lockValue) {
            const released = await releaseLock(lockKey, lockValue);
            if (!released) {
                logger.warn('Failed to release regular cache warming lock', {
                    lockKey,
                });
            }
        }
    }
}

/**
 * Calculate milliseconds until next occurrence of a specific hour (in local time)
 */
function msUntilHour(targetHour: number): number {
    const now = new Date();
    const target = new Date();
    target.setHours(targetHour, 0, 0, 0);

    // If target hour already passed today, schedule for tomorrow
    if (target <= now) {
        target.setDate(target.getDate() + 1);
    }

    return target.getTime() - now.getTime();
}

/**
 * Start tiered cache warming scheduler
 * - Frequent: Every 3 hours (trending)
 * - Regular: Every 12 hours (hero + browse + ForYou)
 * - Nightly: At specified hour (full warming)
 */
export function startNightlyScheduler(nightlyHour: number = 3): void {
    if (dev) {
        logger.info('Cache warming scheduler disabled in development mode');
        return;
    }

    // Store the configured hour for status reporting
    nightlyScheduledHour = nightlyHour;

    // Start frequent warming (every 3 hours)
    if (!frequentWarmingInterval) {
        logger.info('Starting frequent cache warming', { intervalHours: 3 });
        frequentWarmingInterval = setInterval(() => {
            void warmTrendingOnly();
        }, WARMING_INTERVALS.frequent);
    }

    // Start regular warming (every 12 hours)
    if (!regularWarmingInterval) {
        logger.info('Starting regular cache warming', { intervalHours: 12 });
        regularWarmingInterval = setInterval(() => {
            void warmUserCachesOnly();
        }, WARMING_INTERVALS.regular);
    }

    // Schedule nightly full warming
    if (!nightlyWarmingTimeout) {
        const msUntilNightly = msUntilHour(nightlyHour);
        const nextRun = new Date(Date.now() + msUntilNightly);

        logger.info('Nightly full cache warming scheduled', {
            hour: nightlyHour,
            nextRun: nextRun.toISOString(),
            inHours: Math.round((msUntilNightly / 1000 / 60 / 60) * 10) / 10,
        });

        const runNightlyWarming = async () => {
            // Try to acquire distributed lock to prevent multiple replicas from warming
            const { acquireLock, releaseLock, isValkeyReady } = await import('../cache/valkey');
            const lockKey = 'lock:cache-warming:nightly';
            let lockValue: string | null = null;
            let stopHeartbeat: (() => void) | null = null;

            if (isValkeyReady()) {
                lockValue = await acquireLock(lockKey, WARMING_LOCK_TTL.nightly);
                if (!lockValue) {
                    logger.info('⏭️ Skipping nightly warming (another replica is handling it)');
                    // Still schedule next run
                    nightlyWarmingTimeout = setTimeout(() => {
                        void runNightlyWarming();
                    }, WARMING_INTERVALS.nightly);
                    return;
                }

                // Start heartbeat to prevent lock expiration
                stopHeartbeat = startCacheWarmingHeartbeat(
                    lockKey,
                    WARMING_LOCK_TTL.nightly,
                    60 * 60 * 1000, // 1 hour max
                );
            }

            try {
                logger.info('🌙 Running nightly full cache warming...');
                const service = getCacheWarmingService();
                service.reset();
                await service.warmCaches();
                lastNightlyRun = { timestamp: new Date(), success: true };
            } catch (error) {
                lastNightlyRun = { timestamp: new Date(), success: false };
                logger.error('Nightly warming failed', error as Error);
            } finally {
                // Stop heartbeat
                stopHeartbeat?.();

                // Release the lock
                if (lockValue) {
                    const released = await releaseLock(lockKey, lockValue);
                    if (!released) {
                        logger.warn('Failed to release nightly cache warming lock', {
                            lockKey,
                        });
                    }
                }
            }

            // Schedule next nightly run
            nightlyWarmingTimeout = setTimeout(() => {
                void runNightlyWarming();
            }, WARMING_INTERVALS.nightly);
        };

        nightlyWarmingTimeout = setTimeout(() => {
            void runNightlyWarming();
        }, msUntilNightly);
    }
}

/**
 * Stop all cache warming schedulers
 */
export function stopNightlyScheduler(): void {
    if (frequentWarmingInterval) {
        clearInterval(frequentWarmingInterval);
        frequentWarmingInterval = null;
    }
    if (regularWarmingInterval) {
        clearInterval(regularWarmingInterval);
        regularWarmingInterval = null;
    }
    if (nightlyWarmingTimeout) {
        clearTimeout(nightlyWarmingTimeout);
        nightlyWarmingTimeout = null;
    }
    logger.info('Cache warming schedulers stopped');
}

// ============================================================================
// Cache Warming Status API
// ============================================================================

/** Last run result for a warming tier */
export interface WarmingRunResult {
    timestamp: Date | null;
    success: boolean;
}

/** Result row from popular media query */
interface PopularMediaRow {
    media_id: string;
}

export interface CacheWarmingStatus {
    /** Current warming progress */
    progress: CacheWarmingProgress;
    /** Whether the scheduler is active */
    schedulerActive: boolean;
    /** Scheduled warming intervals */
    schedule: {
        frequent: { intervalHours: number; description: string };
        regular: { intervalHours: number; description: string };
        nightly: { hour: number; description: string };
    };
    /** Next scheduled runs (approximate) */
    nextRuns: {
        frequent: string | null;
        regular: string | null;
        nightly: string | null;
    };
    /** Last warming results by type (timestamps are serialized to ISO strings in API response) */
    lastRuns: {
        frequent: WarmingRunResult;
        regular: WarmingRunResult;
        nightly: WarmingRunResult;
    };
    /** Active users statistics for user-specific warming */
    activeUsers: {
        /** Number of active users warming will process */
        count: number;
        /** Maximum number of users to warm (config limit) */
        limit: number;
        /** How far back to look for activity (days) */
        lookbackDays: number;
    };
}

// Track last run times and results
let lastFrequentRun: WarmingRunResult = { timestamp: null, success: true };
let lastRegularRun: WarmingRunResult = { timestamp: null, success: true };
let lastNightlyRun: WarmingRunResult = { timestamp: null, success: true };
let nightlyScheduledHour = 3;

/** Result row from active users query */
interface ActiveUserRow {
    user_id: string;
    last_active: Date;
}

/** Database interface for active users query */
interface DbWithSqlClient {
    sqlClient: Sql;
}

/**
 * Get active users from watch_history table
 * Shared helper to avoid query duplication
 */
async function getActiveUsers(
    db: DbWithSqlClient,
    config: { activeUsersDays: number; activeUsersLimit: number },
): Promise<ActiveUserRow[]> {
    return db.sqlClient`
        SELECT user_id, MAX(session_start_time) as last_active
        FROM watch_history
        WHERE session_start_time > NOW() - INTERVAL '${db.sqlClient.unsafe(String(config.activeUsersDays))} days'
        GROUP BY user_id
        ORDER BY last_active DESC
        LIMIT ${config.activeUsersLimit}
    ` as unknown as ActiveUserRow[];
}

/**
 * Get comprehensive cache warming status
 */
export async function getCacheWarmingStatus(): Promise<CacheWarmingStatus> {
    const service = getCacheWarmingService();
    const schedulerActive = !!(
        frequentWarmingInterval ||
        regularWarmingInterval ||
        nightlyWarmingTimeout
    );
    const config = service.getConfig();

    // Get active users count for statistics
    let activeUsersCount = 0;
    try {
        const { Database, testDbConnection } = await import('../database');
        const aiHealthy = await testDbConnection();
        if (aiHealthy) {
            const db = new Database();
            const activeUsers = await getActiveUsers(db, config);
            activeUsersCount = activeUsers.length;
        }
    } catch (e) {
        logger.debug('AI database not available for active user count', {
            error: e,
        });
    }

    // Calculate next run times based on intervals
    const now = new Date();
    let nextFrequent: string | null = null;
    let nextRegular: string | null = null;
    let nextNightly: string | null = null;

    if (schedulerActive) {
        // Frequent: every 3 hours from last run
        if (lastFrequentRun.timestamp) {
            const next = new Date(lastFrequentRun.timestamp.getTime() + WARMING_INTERVALS.frequent);
            nextFrequent = next > now ? next.toISOString() : 'Due now';
        } else {
            nextFrequent = new Date(now.getTime() + WARMING_INTERVALS.frequent).toISOString();
        }

        // Regular: every 12 hours from last run
        if (lastRegularRun.timestamp) {
            const next = new Date(lastRegularRun.timestamp.getTime() + WARMING_INTERVALS.regular);
            nextRegular = next > now ? next.toISOString() : 'Due now';
        } else {
            nextRegular = new Date(now.getTime() + WARMING_INTERVALS.regular).toISOString();
        }

        // Nightly: at scheduled hour
        const nightlyTarget = new Date();
        nightlyTarget.setHours(nightlyScheduledHour, 0, 0, 0);
        if (nightlyTarget <= now) {
            nightlyTarget.setDate(nightlyTarget.getDate() + 1);
        }
        nextNightly = nightlyTarget.toISOString();
    }

    return {
        progress: service.getProgress(),
        schedulerActive,
        schedule: {
            frequent: { intervalHours: 3, description: 'Trending content' },
            regular: {
                intervalHours: 12,
                description: 'Hero sections + browse + ForYou',
            },
            nightly: {
                hour: nightlyScheduledHour,
                description: 'Full warming (all caches)',
            },
        },
        nextRuns: {
            frequent: nextFrequent,
            regular: nextRegular,
            nightly: nextNightly,
        },
        lastRuns: {
            frequent: lastFrequentRun,
            regular: lastRegularRun,
            nightly: lastNightlyRun,
        },
        activeUsers: {
            count: activeUsersCount,
            limit: config.activeUsersLimit,
            lookbackDays: config.activeUsersDays,
        },
    };
}

/**
 * Manually trigger cache warming
 * @param type Which warming to run: 'full' | 'frequent' | 'regular'
 */
export async function triggerCacheWarming(
    type: 'full' | 'frequent' | 'regular' = 'full',
): Promise<{ success: boolean; message: string }> {
    const service = getCacheWarmingService();

    if (service.getProgress().status === 'warming') {
        return { success: false, message: 'Cache warming already in progress' };
    }

    try {
        switch (type) {
            case 'frequent':
                // warmTrendingOnly() sets lastFrequentRun internally
                await warmTrendingOnly();
                return { success: true, message: 'Trending cache warmed' };

            case 'regular':
                // warmUserCachesOnly() sets lastRegularRun internally
                await warmUserCachesOnly();
                return {
                    success: true,
                    message: 'User caches warmed (hero + browse + ForYou)',
                };

            case 'full':
            default: {
                service.reset();
                // Use blocking mode for manual triggers to get accurate success status
                await service.warmCaches(true);
                const progress = service.getProgress();
                const success = progress.status === 'completed' && progress.errors.length === 0;
                lastNightlyRun = { timestamp: new Date(), success };
                return {
                    success,
                    message: success
                        ? 'Full cache warming completed'
                        : `Full cache warming completed with ${progress.errors.length} errors`,
                };
            }
        }
    } catch (error) {
        const errorMsg = (error as Error).message;
        logger.error('Manual cache warming failed', error as Error, {
            warmingType: type,
        });

        // Mark the run as failed with current timestamp
        // (handles edge case where warming function didn't get to set timestamp, e.g., import failure)
        const failedResult: WarmingRunResult = {
            timestamp: new Date(),
            success: false,
        };
        if (type === 'frequent') lastFrequentRun = failedResult;
        if (type === 'regular') lastRegularRun = failedResult;
        if (type === 'full') lastNightlyRun = failedResult;

        return { success: false, message: `Cache warming failed: ${errorMsg}` };
    }
}
