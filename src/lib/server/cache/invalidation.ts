// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Cache Invalidation System
 *
 * Provides event-based cache invalidation with hooks for data mutations.
 * Ensures cache coherence across multiple layers when data changes.
 *
 * IMPORTANT: All methods accept provider-agnostic externalIds.
 * mediaType is REQUIRED to avoid provider ID collisions across different media types.
 *
 * Usage:
 *   import { cacheInvalidation } from './invalidation';
 *
 *   // After rating a movie (externalIds and mediaType are REQUIRED)
 *   await cacheInvalidation.onUserRating(userId, externalIds, mediaType, rating, ratingCount);
 *
 *   // After skipping a suggestion (externalIds and mediaType are REQUIRED)
 *   await cacheInvalidation.onSuggestionSkipped(userId, externalIds, mediaType);
 *
 *   // Invalidate media cache (externalIds and mediaType are REQUIRED)
 *   await cacheInvalidation.invalidateMedia(externalIds, mediaType);
 */

import { CacheManager } from './unified-cache';
import type { UserId } from '$lib/shared/user-id';
import { CACHE_NAMESPACES } from './namespaces';
import { publishNamespaceClear, startNamespaceClearSubscriber } from './namespace-clear-bus';
import { Logger } from '../utils/logger';
import type { ExternalIds } from '$lib/types/api-common';
import { buildMediaKey } from '$lib/utils/media-id-helpers';
import { shouldRemoveSuggestionOnRating } from '$lib/shared/rating-thresholds';

const logger = Logger.for('CacheInvalidation');

export type InvalidationReason =
    'user_rating' | 'suggestion_skipped' | 'content_added' | 'manual' | 'milestone_reached';

export interface InvalidationEvent {
    reason: InvalidationReason;
    userId?: string;
    externalIds?: ExternalIds;
    timestamp: Date;
    metadata?: Record<string, unknown>;
}

export class CacheInvalidationService {
    private cacheManager: CacheManager;
    private invalidationLog: InvalidationEvent[] = [];
    private readonly maxLogSize = 1000;

    // Coalescing state for onContentAdded(): metadata-sync, file-scanner, livetv-refresh
    // and series-rematch loops can fan out to ~1 invalidation per few seconds during
    // bulk operations; each clears 5 namespaces. Coalescing into a single trailing
    // cascade caps invalidation work at one cycle per CONTENT_INVALIDATION_DELAY_MS.
    private static readonly CONTENT_INVALIDATION_DELAY_MS = 10_000;
    private contentInvalidationTimer?: ReturnType<typeof setTimeout>;
    private contentInvalidationPendingCount = 0;

    // Lazy-initialized cache instances to avoid repeated lookups
    private _suggestionsCache?: ReturnType<CacheManager['for']>;
    private _watchedCache?: ReturnType<CacheManager['for']>;
    private _trendingCache?: ReturnType<CacheManager['for']>;
    private _metadataCache?: ReturnType<CacheManager['for']>;
    private _userRatingsCache?: ReturnType<CacheManager['for']>;
    // Browse-related caches
    private _browseRecentlyAddedCache?: ReturnType<CacheManager['for']>;
    private _browseGenresCache?: ReturnType<CacheManager['for']>;
    private _browseKeywordsCache?: ReturnType<CacheManager['for']>;
    private _browseAZCache?: ReturnType<CacheManager['for']>;
    private _browseLibrariesCache?: ReturnType<CacheManager['for']>;
    private _newEpisodesCache?: ReturnType<CacheManager['for']>;
    private _personalStatsCache?: ReturnType<CacheManager['for']>;
    private _nextEpisodeCache?: ReturnType<CacheManager['for']>;
    private _moodRecommendationsCache?: ReturnType<CacheManager['for']>;

    constructor() {
        this.cacheManager = CacheManager.getInstance();
    }

    // Lazy getters for cache instances
    private get suggestionsCache() {
        return (this._suggestionsCache ??= this.cacheManager.for(CACHE_NAMESPACES.aiSuggestions));
    }
    private get watchedCache() {
        return (this._watchedCache ??= this.cacheManager.for(CACHE_NAMESPACES.watchedContent));
    }
    private get trendingCache() {
        return (this._trendingCache ??= this.cacheManager.for(CACHE_NAMESPACES.trending));
    }
    private get metadataCache() {
        // Use mediaEmbeddings namespace - that's where media:${tmdbId}:${mediaType} keys are stored
        return (this._metadataCache ??= this.cacheManager.for(CACHE_NAMESPACES.mediaEmbeddings));
    }
    private get userRatingsCache() {
        return (this._userRatingsCache ??= this.cacheManager.for(CACHE_NAMESPACES.userRatings));
    }
    private get moodRecommendationsCache() {
        return (this._moodRecommendationsCache ??= this.cacheManager.for(
            CACHE_NAMESPACES.moodRecommendations,
        ));
    }
    // Browse cache getters
    private get browseRecentlyAddedCache() {
        return (this._browseRecentlyAddedCache ??= this.cacheManager.for(
            CACHE_NAMESPACES.browseRecentlyAdded,
        ));
    }
    private get browseGenresCache() {
        return (this._browseGenresCache ??= this.cacheManager.for(CACHE_NAMESPACES.browseGenres));
    }
    private get browseKeywordsCache() {
        return (this._browseKeywordsCache ??= this.cacheManager.for(
            CACHE_NAMESPACES.browseKeywords,
        ));
    }
    private get browseAZCache() {
        return (this._browseAZCache ??= this.cacheManager.for(CACHE_NAMESPACES.browseAZ));
    }
    private get browseLibrariesCache() {
        return (this._browseLibrariesCache ??= this.cacheManager.for(
            CACHE_NAMESPACES.browseLibraries,
        ));
    }
    private get newEpisodesCache() {
        return (this._newEpisodesCache ??= this.cacheManager.for(CACHE_NAMESPACES.newEpisodes));
    }
    private get personalStatsCache() {
        return (this._personalStatsCache ??= this.cacheManager.for(CACHE_NAMESPACES.personalStats));
    }
    private get nextEpisodeCache() {
        return (this._nextEpisodeCache ??= this.cacheManager.for(CACHE_NAMESPACES.nextEpisode));
    }

    /**
     * Get Valkey client with error handling
     * Returns null if client doesn't exist or isn't connected
     */
    private async getValkeyClientSafe() {
        try {
            const { getValkeyClient, connectValkey, isValkeyReady } =
                await import('../cache/valkey');

            // Ensure client is connected before returning
            if (!isValkeyReady()) {
                const connected = await connectValkey();
                if (!connected) return null;
            }

            return getValkeyClient();
        } catch (e) {
            logger.debug('Failed to import or connect Valkey client', {
                error: e,
            });
            return null;
        }
    }

    /**
     * Handle user rating event
     * Invalidates: user recommendations, user stats, similar content cache (on downvote)
     *
     * @param userId - User identifier
     * @param externalIds - External IDs for the media (provider-agnostic)
     * @param mediaType - Media type (movie or tv)
     * @param rating - User rating (1-10 scale)
     * @param ratingCount - Total number of ratings for this user
     */
    async onUserRating(
        userId: UserId,
        externalIds: ExternalIds,
        mediaType: 'movie' | 'tv',
        rating: number,
        ratingCount: number,
    ): Promise<void> {
        const mediaKey = buildMediaKey(externalIds, mediaType);

        this.logInvalidation({
            reason: 'user_rating',
            userId,
            externalIds,
            timestamp: new Date(),
            metadata: { rating, ratingCount, mediaType, mediaKey },
        });

        // Invalidate all user ratings cache keys (stats + ratings-map-v2)
        // so recommendations filtering uses fresh data immediately
        await this.userRatingsCache.deleteUserCache(userId);

        // Invalidate personal stats (rating count/distribution changed)
        await this.personalStatsCache.deleteUserCache(userId);

        // Every-5th-rating profile-rebuild cadence — independent from
        // `shouldRemoveSuggestionOnRating`, which gates the extreme-rating
        // (8-10 love / 1-4 dislike) path below. Single source of truth for
        // that threshold: `rating-manager.service.ts` and this file previously
        // used different bands for the same concept — both now import the
        // same function so the two gates cannot drift apart again.
        const isMilestone = ratingCount % 5 === 0;

        // The mood queries exclude titles the user rated <= 4 directly in SQL
        // (`AND NOT EXISTS (... ur.rating <= 4)`), so a fresh dislike must drop
        // the cached mood rails or the just-hidden title keeps showing up for
        // the rest of the TTL. Runs for every rating, not just the <= 4 band:
        // raising a title back above 4 has to bring it back just as promptly.
        await this.moodRecommendationsCache.deleteUserCache(userId);

        // For negative ratings (1-4 on 1-10 scale), always invalidate similar cache
        // so the disliked content doesn't show in "Because you watched" sections
        if (rating <= 4) {
            try {
                const { invalidateSimilarCacheForUser } =
                    await import('../services/for-you.service');
                await invalidateSimilarCacheForUser(userId);
                logger.debug('Invalidated similar cache after downvote', {
                    userId,
                    mediaKey,
                    rating,
                });
            } catch (error) {
                logger.warn('Failed to invalidate similar cache', {
                    userId,
                    error,
                });
            }
        }

        if (isMilestone) {
            logger.info('Rating milestone reached, invalidating caches', {
                userId,
                ratingCount,
                rating,
            });

            // Full invalidation on milestone
            await this.invalidateUserRecommendations(userId, 'milestone_reached');
        } else if (shouldRemoveSuggestionOnRating(rating)) {
            // A strong love/dislike between milestones must also be visible
            // on the next For-You load, not just filtered out of "Because
            // you watched" (above). Wipe the composed `sections:v2` cache
            // the routes actually read — the old per-item `suggestion:${mediaKey}`
            // key was never read by any live route, so deleting it only LOOKED
            // like invalidation. Shares its `<= 4` dislike band with the
            // `user_suggestions` DB-row removal in rating-manager.service.ts
            // so a 4/10 rating clears the cached feed, not just the DB row.
            await this.suggestionsCache.deleteUserCache(userId);

            logger.debug('Significant rating, invalidated suggestions cache', {
                userId,
                mediaKey,
                mediaType,
                rating,
            });
        }
    }

    /**
     * Lightweight rating cache invalidation (no external IDs required).
     * Use for music interactions or any path that writes to user_ratings
     * without going through the full AI rating pipeline. Also used by
     * `clearRating` (the rating-undo path) — the composed suggestions cache
     * is included so undo takes visible effect on the next For-You load
     * instead of "nothing until next milestone".
     *
     * Invalidates: userRatings cache, personalStats cache, suggestions cache.
     */
    async onRatingCacheChanged(userId: UserId): Promise<void> {
        this.logInvalidation({
            reason: 'user_rating',
            userId,
            timestamp: new Date(),
            metadata: { source: 'lightweight' },
        });

        await Promise.all([
            this.userRatingsCache.deleteUserCache(userId),
            this.personalStatsCache.deleteUserCache(userId),
            this.suggestionsCache.deleteUserCache(userId),
            // Undoing a <= 4 rating has to re-admit the title to the mood rails
            // (they exclude it in SQL), exactly as applying it removed it.
            this.moodRecommendationsCache.deleteUserCache(userId),
        ]);

        logger.debug('Invalidated rating caches (lightweight)', { userId });
    }

    /**
     * Handle suggestion skipped event
     * Invalidates: that specific suggestion from all caches
     *
     * @param userId - User identifier
     * @param externalIds - External IDs for the media (provider-agnostic)
     * @param mediaType - Media type (movie or tv)
     */
    async onSuggestionSkipped(
        userId: string,
        externalIds: ExternalIds,
        mediaType: 'movie' | 'tv',
    ): Promise<void> {
        const mediaKey = buildMediaKey(externalIds, mediaType);

        this.logInvalidation({
            reason: 'suggestion_skipped',
            userId,
            externalIds,
            timestamp: new Date(),
            metadata: { mediaType, mediaKey },
        });

        logger.debug('Suggestion skipped, invalidating cache', {
            userId,
            mediaKey,
            mediaType,
        });

        // Remove from suggestion caches in parallel
        // Use composite media key to avoid provider ID collisions. The
        // 'suggestions:list' key removed here previously was never read by
        // any live route (routes read the composed `sections:v2` key) — only
        // `cache/warming.ts` still writes it; see that file's warming
        // function docblock.
        const deletePromises: Promise<void>[] = [];

        if (mediaKey) {
            deletePromises.push(this.suggestionsCache.delete(`suggestion:${mediaKey}`, userId));
        }

        await Promise.all(deletePromises);
    }

    /**
     * Handle watchlist change event (add or remove).
     * Invalidates suggestion caches so saved items don't keep appearing as suggestions.
     */
    async onWatchlistChange(userId: UserId, mediaId?: string): Promise<void> {
        this.logInvalidation({
            reason: 'manual',
            userId,
            timestamp: new Date(),
            metadata: { action: 'watchlist_change', mediaId },
        });

        logger.debug('Watchlist changed, invalidating suggestion caches', {
            userId,
            mediaId,
        });

        const promises: Promise<void>[] = [
            this.suggestionsCache.deleteUserCache(userId),
            this.personalStatsCache.deleteUserCache(userId),
        ];

        // Invalidate similar content cache so watchlisted items stop appearing
        // in "Because you watched X" rows
        try {
            const { invalidateSimilarCacheForUser } = await import('../services/for-you.service');
            promises.push(invalidateSimilarCacheForUser(userId));
        } catch {
            // for-you.service unavailable — skip
        }

        // Remove from user_suggestions DB table so the item doesn't reappear
        // after the next suggestion generation cycle
        if (mediaId) {
            try {
                const { deleteUserSuggestionByMediaId } =
                    await import('$lib/server/database/queries/user-ratings.queries');
                const { getDb } = await import('$lib/server/database/connection');
                const sql = getDb();
                if (sql) {
                    promises.push(
                        deleteUserSuggestionByMediaId(sql, userId, mediaId).then(() => undefined),
                    );
                }
            } catch {
                // query module unavailable — skip
            }
        }

        await Promise.all(promises);
    }

    /**
     * Handle watch state change event (mark watched/unwatched, season/series bulk, session completion).
     * Invalidates next-episode cache and personal stats so users see fresh data immediately.
     */
    async onWatchStateChanged(username: string): Promise<void> {
        logger.debug('Watch state changed, invalidating next-episode and personal stats', {
            username,
        });

        await Promise.all([
            this.nextEpisodeCache.deleteUserCache(username),
            this.personalStatsCache.deleteUserCache(username),
        ]);
    }

    /**
     * Invalidate all user recommendations
     */
    async invalidateUserRecommendations(
        userId: string,
        reason: InvalidationReason = 'manual',
    ): Promise<void> {
        this.logInvalidation({
            reason,
            userId,
            timestamp: new Date(),
        });

        logger.debug('Invalidating user recommendations', { userId, reason });

        // Clear all user-related caches in parallel
        await Promise.all([
            this.suggestionsCache.deleteUserCache(userId),
            this.watchedCache.deleteUserCache(userId),
            // Mood rails are per-user (taste vector, damper, dislike exclusion),
            // so a blanket "this user's recommendations are stale" must reach
            // them too — not just the AI suggestion feed.
            this.moodRecommendationsCache.deleteUserCache(userId),
        ]);

        logger.debug('User caches invalidated', { userId });
    }

    /**
     * Handle new content added.
     *
     * Schedules a coalesced invalidation of trending/browse/new-episode caches.
     * Multiple calls within CONTENT_INVALIDATION_DELAY_MS are absorbed into a single
     * trailing cascade — necessary because bulk metadata sync and file-scan paths can
     * call this once per item at >1 Hz, and each cascade clears 5 namespaces.
     *
     * Callers treat invalidation as fire-and-forget (every call site is wrapped in
     * try/catch with a "non-fatal" comment), so returning before the cascade actually
     * runs is safe. Worst-case latency between an add and its cache eviction is
     * CONTENT_INVALIDATION_DELAY_MS.
     */
    onContentAdded(contentIds: string[]): Promise<void> {
        // Empty calls are no-ops; skip the log entry and avoid scheduling an
        // unnecessary cascade for a 0-item batch.
        if (contentIds.length === 0) {
            return Promise.resolve();
        }

        this.contentInvalidationPendingCount += contentIds.length;

        this.logInvalidation({
            reason: 'content_added',
            timestamp: new Date(),
            metadata: { contentIds },
        });

        if (this.contentInvalidationTimer) {
            // A cascade is already scheduled; new IDs are absorbed into the pending count.
            return Promise.resolve();
        }

        const timer = setTimeout(() => {
            void this.runContentInvalidationCascade();
        }, CacheInvalidationService.CONTENT_INVALIDATION_DELAY_MS);
        // Don't keep the event loop alive solely for cache invalidation timers.
        timer.unref?.();
        this.contentInvalidationTimer = timer;

        return Promise.resolve();
    }

    private async runContentInvalidationCascade(): Promise<void> {
        // Clear timer + count BEFORE awaiting so that any caller arriving during the
        // clear() round trip schedules a fresh trailing cascade instead of being lost.
        this.contentInvalidationTimer = undefined;
        const accumulatedCount = this.contentInvalidationPendingCount;
        this.contentInvalidationPendingCount = 0;

        logger.info('Content invalidation cascade firing (coalesced)', {
            accumulatedCount,
        });

        try {
            await Promise.all([
                this.trendingCache.clear(),
                // Browse caches (new content affects all browse views)
                this.browseRecentlyAddedCache.clear(),
                this.browseGenresCache.clear(),
                // Keyword sections share the ingest lifecycle with genres: the
                // static keyword list is fixed, but which entries have enough
                // matching items changes when content is added.
                this.browseKeywordsCache.clear(),
                this.browseAZCache.clear(),
                // New episodes (new series content means new episodes)
                this.newEpisodesCache.clear(),
                // Note: browseLibrariesCache NOT cleared - library structure rarely changes
                // Note: browseChannelsCache NOT cleared - channels unaffected by content
            ]);
            // The clears above emptied this process's L1 and the shared L2. Other
            // processes (the web server, when this runs in the worker) still hold
            // their own L1 copies; tell them to drop those.
            publishNamespaceClear([
                CACHE_NAMESPACES.trending.name,
                CACHE_NAMESPACES.browseRecentlyAdded.name,
                CACHE_NAMESPACES.browseGenres.name,
                CACHE_NAMESPACES.browseKeywords.name,
                CACHE_NAMESPACES.browseAZ.name,
                CACHE_NAMESPACES.newEpisodes.name,
            ]);
            logger.info('Content caches cleared', { accumulatedCount });
        } catch (error) {
            // Mirror the pre-existing fire-and-forget contract — invalidation failure
            // is non-fatal; caches refresh on next TTL expiry.
            logger.warn('Content invalidation cascade failed', {
                accumulatedCount,
                error: error instanceof Error ? error.message : String(error),
            });
        }
    }

    /**
     * Invalidate media cache
     *
     * @param externalIds - External IDs for the media (provider-agnostic)
     * @param mediaType - Media type (movie or tv, required to avoid ID collisions)
     */
    async invalidateMedia(externalIds: ExternalIds, mediaType: 'movie' | 'tv'): Promise<void> {
        const mediaKey = buildMediaKey(externalIds, mediaType);

        this.logInvalidation({
            reason: 'manual',
            externalIds,
            timestamp: new Date(),
            metadata: { mediaType, mediaKey },
        });

        logger.info('Invalidating media across all caches', {
            mediaKey,
            mediaType,
        });

        if (!mediaKey) {
            logger.warn('Cannot invalidate media without valid media key', {
                externalIds,
                mediaType,
            });
            return;
        }

        // Clear from metadata cache using composite media key
        await this.metadataCache.delete(`media:${mediaKey}`);

        // Clear the per-user/per-locale similar-content entries. They are stored
        // in the unified cache under `<ns>:*:similar:<mediaKey>*` (see the for-you
        // similar cache + media-lifecycle.service). The old `similar:js:<mediaKey>`
        // del was dead — nothing writes that key — so stale "Because you watched"
        // rows survived to TTL after a media/metadata change. SCAN-evict the real
        // keys instead (same pattern as media-lifecycle.service.invalidateMedia).
        try {
            const { deleteKeysByPattern, isValkeyReady } = await import('./valkey');
            if (isValkeyReady()) {
                // For-You "Because you watched" rail: `<ns>:*:similar:<mediaKey>*`.
                const forYouNs = CACHE_NAMESPACES.similarContent.name;
                await deleteKeysByPattern(`${forYouNs}:*:similar:${mediaKey}*`, 50);
                // The modal's /api/media/{id}/similar endpoint lives in its OWN
                // namespace under a DIFFERENT shape:
                // `<ns>:<locale>:<internalId>:<limit>:<minSim>[|access]`
                // (scopedCacheKey). mediaKey is the bare internal UUID whenever
                // externalIds carries one (buildMediaKey prefers it) — composite
                // fallback keys can't be matched here and rely on TTL. (This
                // also catches the endpoint's `:sf:` single-flight bridge keys,
                // which embed the same `<uuid>:` segment.)
                const modalNs = CACHE_NAMESPACES.similarModalContent.name;
                await deleteKeysByPattern(`${modalNs}:*:${mediaKey}:*`, 50);
            }
            // In-process source-media cache (identity + parsed embedding) that
            // feeds the similar RECOMPUTE — purging only the response cache
            // would let the next miss rebuild it from the stale embedding.
            // Process-local by nature; other replicas converge via its 5-min
            // TTL, the same bound as every L1 tier.
            if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(mediaKey)) {
                const { invalidateSimilarSourceMedia } =
                    await import('../caches/similar-source-media.js');
                invalidateSimilarSourceMedia(mediaKey);
            }
        } catch (error) {
            logger.warn('Failed to clear similar-content cache from Valkey', {
                mediaKey,
                mediaType,
                error,
            });
        }
    }

    /**
     * Invalidate trending cache
     */
    async invalidateTrending(): Promise<void> {
        this.logInvalidation({
            reason: 'manual',
            timestamp: new Date(),
        });

        logger.info('Invalidating trending cache');

        // Clear unified cache and Valkey trending keys in parallel
        // Note: deleteKeysByPattern catches old version keys (trending-v16:*, etc.)
        await Promise.all([
            this.trendingCache.clear(),
            // Clear Valkey trending cache using SCAN (non-blocking)
            (async () => {
                try {
                    const { deleteKeysByPattern } = await import('../cache/valkey');
                    await deleteKeysByPattern('trending*');
                } catch (error) {
                    logger.warn('Failed to clear trending from Valkey', {
                        error,
                    });
                }
            })(),
        ]);
    }

    /**
     * Clear all caches (nuclear option)
     */
    async clearAllCaches(): Promise<void> {
        this.logInvalidation({
            reason: 'manual',
            timestamp: new Date(),
            metadata: { action: 'clear_all' },
        });

        logger.warn('Clearing ALL caches');

        await this.cacheManager.clearAll();

        // Also clear Valkey entirely
        const client = await this.getValkeyClientSafe();
        if (client) {
            try {
                await client.flushdb();
                logger.info('Valkey flushed');
            } catch (error) {
                logger.warn('Failed to flush Valkey', { error });
            }
        }
    }

    /**
     * Log invalidation event
     */
    private logInvalidation(event: InvalidationEvent): void {
        this.invalidationLog.push(event);

        // Trim log if too large
        if (this.invalidationLog.length > this.maxLogSize) {
            this.invalidationLog = this.invalidationLog.slice(-this.maxLogSize);
        }
    }

    /**
     * Get recent invalidation events
     */
    getInvalidationLog(limit = 50): InvalidationEvent[] {
        return this.invalidationLog.slice(-limit);
    }

    /**
     * Get invalidation statistics
     */
    getInvalidationStats(): Record<InvalidationReason, number> {
        const stats: Record<string, number> = {};

        for (const event of this.invalidationLog) {
            stats[event.reason] = (stats[event.reason] || 0) + 1;
        }

        return stats as Record<InvalidationReason, number>;
    }
}

// Singleton instance
export const cacheInvalidation = new CacheInvalidationService();

// Receive other processes' content-cache clears (best-effort, retries until Valkey is up).
void startNamespaceClearSubscriber();
