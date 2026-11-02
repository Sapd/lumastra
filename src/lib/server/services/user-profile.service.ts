// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * UserProfileService
 *
 * Handles user profile operations including:
 * - Creating profiles from watch history
 * - Creating profiles from ratings
 * - Creating enhanced hybrid profiles
 * - Profile CRUD operations
 *
 * Extracted from connection.ts for maintainability.
 */

import type postgres from 'postgres';
import type { UserId } from '$lib/shared/user-id';
import { PROFILE_RATING_WINDOW } from '$lib/shared/rating-thresholds.js';
import { Logger } from '../utils/logger';
import { parseEmbedding as parseEmbeddingVector } from '../utils/embedding-utils.js';
import { createExternalIdKey } from '../utils/tmdb-composite-key.js';
import type { UserProfile, UserRatingWithUuid, MediaEmbedding } from '../database/connection';
import { isMovie, isSeries } from '../utils/media-types.js';
import { getWatchStateForProfile } from '../database/queries/watch-state.queries.js';
import { setIfNotExists, cacheDel } from '../cache/valkey.js';
import { getBehaviorallyDemotedMediaIds } from '../database/queries/for-you-helpers.queries.js';
import { config, features } from '../config.js';

const logger = Logger.for('UserProfileService');

/**
 * Interface for database methods that UserProfileService depends on.
 * This allows for dependency injection and testability.
 */
export interface UserProfileDatabaseDeps {
    /**
     * Get media embedding by TMDB ID and media type
     */
    getMediaEmbedding(tmdbId: number, mediaType: 'movie' | 'tv'): Promise<MediaEmbedding | null>;

    /**
     * Get media embedding by internal UUID
     */
    getMediaEmbeddingByUuid(mediaId: string): Promise<MediaEmbedding | null>;

    /**
     * Get user ratings with internal UUIDs
     */
    getUserRatingsWithUuid(
        userId: UserId,
        limit?: number,
        includeSkipped?: boolean,
    ): Promise<UserRatingWithUuid[]>;

    /**
     * Batch resolve TMDB IDs to internal UUIDs
     */
    batchResolveMediaIds(
        items: Array<{ tmdbId: number; mediaType: 'movie' | 'tv' }>,
    ): Promise<Map<string, string>>;

    /**
     * Batch build MediaEmbedding objects from UUIDs
     */
    batchBuildMediaEmbeddingsFromUuids(mediaIds: string[]): Promise<Map<string, MediaEmbedding>>;

    /**
     * Whether the user's taste profile should fold watch-history signals into
     * its positive centroid (watch-history toggle). Defaults to true —
     * `createEnhancedUserProfile` reads this at the START of every rebuild
     * (see there) and re-persists the value it read into the `preferences`
     * blob it writes, so the toggle survives repeated rebuilds even though
     * that blob is otherwise rewritten wholesale each time.
     */
    getIncludeWatchHistoryPreference(userId: UserId): Promise<boolean>;
}

/**
 * Service class for user profile operations.
 */
export class UserProfileService {
    private sql: postgres.Sql;
    private deps: UserProfileDatabaseDeps;

    constructor(sql: postgres.Sql, deps: UserProfileDatabaseDeps) {
        this.sql = sql;
        this.deps = deps;
    }

    /**
     * Get user profile by user ID
     */
    async getUserProfile(userId: UserId): Promise<UserProfile | null> {
        type UserProfileRow = UserProfile & {
            jellyfin_embedding_text?: string | null;
            jellyseerr_embedding_text?: string | null;
        };

        const [result] = await this.sql<UserProfileRow[]>`
            SELECT
                user_id,
                catalog_embedding::text as jellyfin_embedding_text,
                catalog_embedding,
                request_embedding::text as jellyseerr_embedding_text,
                request_embedding,
                availability_preference,
                quality_weight,
                popularity_weight,
                recency_weight,
                preferences,
                total_ratings,
                last_activity,
                created_at,
                updated_at
            FROM user_profiles
            WHERE user_id = ${userId}
        `;

        if (!result) return null;

        // Convert vectors to arrays if needed
        let jellyfinEmbedding = result.catalog_embedding ?? null;
        if (result.jellyfin_embedding_text) {
            try {
                const match = result.jellyfin_embedding_text.match(/\[([\d.,\s-]+)\]/);
                if (match) {
                    jellyfinEmbedding = match[1].split(',').map((x) => Number.parseFloat(x.trim()));
                }
            } catch (error) {
                logger.error('Error parsing jellyfin preference embedding', error as Error, {
                    userId,
                });
            }
        }

        let jellyseerrEmbedding = result.request_embedding ?? null;
        if (result.jellyseerr_embedding_text) {
            try {
                const match = result.jellyseerr_embedding_text.match(/\[([\d.,\s-]+)\]/);
                if (match) {
                    jellyseerrEmbedding = match[1]
                        .split(',')
                        .map((x) => Number.parseFloat(x.trim()));
                }
            } catch (error) {
                logger.error('Error parsing jellyseerr preference embedding', error as Error, {
                    userId,
                });
            }
        }

        return {
            ...result,
            catalog_embedding: jellyfinEmbedding,
            request_embedding: jellyseerrEmbedding,
        };
    }

    /**
     * Create or update user profile
     *
     * `preferences` MUST go through `sql.json()`, not `JSON.stringify()` +
     * plain interpolation: postgres.js binds a JS string parameter as `text`,
     * and there is no assignment cast from `text` to `jsonb` — Postgres
     * accepts the INSERT (via `jsonb`'s scalar-string form) but stores the
     * whole blob as a jsonb STRING SCALAR (double-encoded) rather than an
     * object. Every plain `SELECT preferences` still round-trips a
     * JSON-shaped string, so this was invisible until the
     * `includeWatchHistory` toggle needed `preferences ->> 'key'` extraction
     * — the `->>` operator on a scalar (non-object) jsonb value always
     * returns SQL NULL, silently losing the key. `sql.json()` sends the value
     * with the correct jsonb OID so Postgres parses it as an object.
     */
    async upsertUserProfile(
        profile: Omit<UserProfile, 'created_at' | 'updated_at'>,
    ): Promise<UserProfile> {
        const [result] = await this.sql`
            INSERT INTO user_profiles (
                user_id,
                catalog_embedding,
                request_embedding,
                availability_preference,
                quality_weight,
                popularity_weight,
                recency_weight,
                preferences,
                total_ratings,
                last_activity
            )
            VALUES (
                ${profile.user_id},
                ${profile.catalog_embedding && profile.catalog_embedding.length > 0 ? `[${profile.catalog_embedding.join(',')}]` : null},
                ${profile.request_embedding && profile.request_embedding.length > 0 ? `[${profile.request_embedding.join(',')}]` : null},
                ${profile.availability_preference || 0.7},
                ${profile.quality_weight || 0.2},
                ${profile.popularity_weight || 0.1},
                ${profile.recency_weight || 0.1},
                ${this.sql.json(profile.preferences as postgres.JSONValue)},
                ${profile.total_ratings},
                ${profile.last_activity.toISOString()}
            )
            ON CONFLICT (user_id) DO UPDATE SET
                -- Preserve an existing embedding when a rebuild produces NULL. A
                -- rebuild yields NULL when the user's rated items have no usable
                -- embedding, which is frequently TRANSIENT (embeddings are
                -- mid-regeneration after an embedding reset/re-embed). Clobbering a
                -- good profile with NULL silently empties the user's recs (every
                -- recs query gates on a non-null catalog_embedding) until their
                -- next rebuild. COALESCE keeps the prior vector until a real one is
                -- recomputed; a genuine new embedding (non-NULL) still overwrites.
                catalog_embedding = COALESCE(EXCLUDED.catalog_embedding, user_profiles.catalog_embedding),
                request_embedding = COALESCE(EXCLUDED.request_embedding, user_profiles.request_embedding),
                availability_preference = EXCLUDED.availability_preference,
                quality_weight = EXCLUDED.quality_weight,
                popularity_weight = EXCLUDED.popularity_weight,
                recency_weight = EXCLUDED.recency_weight,
                preferences = EXCLUDED.preferences,
                total_ratings = EXCLUDED.total_ratings,
                last_activity = EXCLUDED.last_activity,
                updated_at = NOW()
            RETURNING *
        `;
        return result as UserProfile;
    }

    /**
     * Create user profile from Jellyfin watch history
     */
    async createUserProfileFromWatchHistory(
        userId: UserId,
        watchHistory: Array<{
            tmdb_id?: number;
            media_type?: 'movie' | 'tv';
            title: string;
            genres?: number[];
            overview?: string;
            playCount?: number;
            playbackPositionTicks?: number;
            runtimeTicks?: number;
        }>,
    ): Promise<UserProfile | null> {
        try {
            if (watchHistory.length === 0) {
                return null;
            }

            // Get embeddings for watched content that we have in our database
            const watchedEmbeddings: Array<{
                embedding: number[];
                weight: number;
            }> = [];
            const genrePreferences: Record<number, number> = {};

            // Collect weights and TMDB lookup pairs upfront
            type WatchItemWeight = {
                weight: number;
                externalIdKey: string;
            };
            const itemsWithWeights: WatchItemWeight[] = [];
            const tmdbLookups: Array<{
                tmdbId: number;
                mediaType: 'movie' | 'tv';
            }> = [];

            for (const item of watchHistory) {
                // Calculate watch weight (completed shows get higher weight)
                let weight = 1.0;
                if (item.playbackPositionTicks && item.runtimeTicks) {
                    const completionPercentage = item.playbackPositionTicks / item.runtimeTicks;
                    weight = Math.max(0.3, Math.min(1.0, completionPercentage));
                }
                if (item.playCount && item.playCount > 1) {
                    weight *= 1.2; // Boost for rewatched content
                }

                if (item.tmdb_id && item.media_type) {
                    const externalIdKey = createExternalIdKey(item.tmdb_id, item.media_type);
                    itemsWithWeights.push({ weight, externalIdKey });
                    tmdbLookups.push({
                        tmdbId: item.tmdb_id,
                        mediaType: item.media_type,
                    });
                }

                // Track genre preferences
                if (item.genres) {
                    for (const genreId of item.genres) {
                        genrePreferences[genreId] = (genrePreferences[genreId] || 0) + weight;
                    }
                }
            }

            // Batch resolve TMDB IDs to UUIDs, then batch fetch all embeddings
            const uuidMap =
                tmdbLookups.length > 0
                    ? await this.deps.batchResolveMediaIds(tmdbLookups)
                    : new Map<string, string>();

            const allUuids = [...new Set(uuidMap.values())];
            const embeddingsMap =
                allUuids.length > 0
                    ? await this.deps.batchBuildMediaEmbeddingsFromUuids(allUuids)
                    : new Map<string, MediaEmbedding>();

            for (const { weight, externalIdKey } of itemsWithWeights) {
                const uuid = uuidMap.get(externalIdKey);
                if (!uuid) continue;
                const media = embeddingsMap.get(uuid);
                const embedding =
                    parseEmbeddingVector(media?.library_embedding) ??
                    parseEmbeddingVector(media?.discovery_embedding);

                if (embedding) {
                    watchedEmbeddings.push({ embedding, weight });
                }
            }

            if (watchedEmbeddings.length === 0) {
                // No embeddings available, create basic profile with genre preferences
                return await this.upsertUserProfile({
                    user_id: userId,
                    catalog_embedding: null,
                    request_embedding: null,
                    preferences: {
                        genres: genrePreferences,
                        created_from: 'watch_history',
                        watched_items: watchHistory.length,
                        last_updated: new Date().toISOString(),
                    },
                    total_ratings: 0,
                    last_activity: new Date(),
                });
            }

            // Calculate weighted average embedding from watch history
            const embeddingSize = watchedEmbeddings[0].embedding.length;
            const profileEmbedding = new Array(embeddingSize).fill(0);
            let totalWeight = 0;

            for (const item of watchedEmbeddings) {
                totalWeight += item.weight;
                for (let i = 0; i < embeddingSize; i++) {
                    profileEmbedding[i] += item.embedding[i] * item.weight;
                }
            }

            // Normalize by total weight
            for (let i = 0; i < embeddingSize; i++) {
                profileEmbedding[i] /= totalWeight;
            }

            return await this.upsertUserProfile({
                user_id: userId,
                catalog_embedding: profileEmbedding,
                request_embedding: profileEmbedding,
                preferences: {
                    genres: genrePreferences,
                    created_from: 'watch_history',
                    watched_items: watchHistory.length,
                    embeddings_used: watchedEmbeddings.length,
                    last_updated: new Date().toISOString(),
                },
                total_ratings: 0,
                last_activity: new Date(),
            });
        } catch (error) {
            logger.error('Failed to create user profile from watch history', error as Error, {
                userId,
            });
            return null;
        }
    }

    /**
     * Create initial user profile purely from ratings history (the manual
     * "regenerate from ratings" refresh path).
     *
     * Thin delegate to the unified `createEnhancedUserProfile` builder with
     * an empty watch history — this and the canonical %5-cadence rebuild
     * (`rebuildUserProfile`) now share the exact same weighting math
     * (positive centroid from ratings >=6 + watch signals, Rocchio negative
     * centroid from ratings <=4, recency decay, 500-rating window) so the
     * two paths cannot diverge again. Kept as a separate export because
     * `suggestions-refresh.ts` and `generate-profile/[userId]` intentionally
     * rebuild from ratings alone, without folding in watch history.
     */
    async createUserProfileFromRatings(userId: UserId): Promise<UserProfile | null> {
        return this.createEnhancedUserProfile(userId, []);
    }

    /**
     * Enhanced weight calculation that considers both watch history and ratings.
     * Movies/TV that were both watched AND rated get higher influence.
     *
     * Ratings <=5 (neutral=5, disliked<=4) never produce a weight here — they
     * return 0. `createEnhancedUserProfile` routes disliked (<=4) items to a
     * separate Rocchio negative centroid instead (see there), and neutral (5)
     * items are excluded from both centroids entirely. This function only
     * ever emits POSITIVE contributions to the liked/watched centroid.
     */
    calculateEnhancedWeight(item: {
        watched?: boolean;
        rating?: number; // 1-10 scale
        watchTime?: number; // completion percentage (0-1)
        playCount?: number;
        mediaType?: 'movie' | 'tv';
        episodesWatched?: number; // for TV series
        totalEpisodes?: number; // for TV series
    }): number {
        let weight = 0;
        const isTV = isSeries(item.mediaType);

        // TV series completion calculation
        let completionRate = item.watchTime || 0;
        if (isTV && item.episodesWatched && item.totalEpisodes) {
            completionRate = item.episodesWatched / item.totalEpisodes;
        }

        if (item.watched && item.rating) {
            if (item.rating <= 5) {
                // Neutral or disliked rating: no positive weight from this
                // branch (see routing note above).
                return 0;
            }

            // WATCHED + RATED (>=6) = strongest signal (experienced + explicit
            // positive feedback)
            const normalizedRating = item.rating / 10.0;

            // Apply exponential weighting for high ratings (9-10 stars)
            const ratingWeight =
                normalizedRating >= 0.9 ? Math.pow(normalizedRating, 1.5) * 1.2 : normalizedRating;

            // Experience bonus for positive ratings; TV series that are
            // highly watched get a bigger experience bonus.
            let experienceBonus = 0.5;
            if (isTV && completionRate > 0.5) {
                experienceBonus = 0.7;
            }

            weight = ratingWeight + experienceBonus;

            // Super liked (9-10 stars) gets additional boost
            if (item.rating >= 9) {
                weight += isTV ? 0.6 : 0.5;
            }

            // Completion bonus
            if (completionRate > 0.8) {
                weight += 0.2;
            }

            // Rewatch bonus
            if (item.playCount && item.playCount > 1) {
                weight *= 1.2;
            }
        } else if (item.watched) {
            // WATCHED ONLY = medium signal (implicit positive, but less confident)
            if (isTV) {
                if (completionRate > 0.7) {
                    weight = 0.8;
                } else if (completionRate > 0.3) {
                    weight = 0.5;
                } else {
                    weight = 0.2;
                }
            } else {
                weight = completionRate > 0.8 ? 0.8 : 0.6;
            }

            // Rewatch bonus
            if (item.playCount && item.playCount > 1) {
                weight *= 1.3;
            }
        } else if (item.rating) {
            if (item.rating <= 5) {
                // Neutral or disliked rating: no positive weight from this
                // branch (see routing note above).
                return 0;
            }

            // RATED ONLY (>=6) = weaker signal (no confirmed experience)
            const normalizedRating = item.rating / 10.0;
            let ratingWeight =
                normalizedRating >= 0.9 ? Math.pow(normalizedRating, 1.3) : normalizedRating;

            if (isTV) {
                ratingWeight *= 0.5;
            } else {
                ratingWeight *= 0.6;
            }

            weight = ratingWeight;

            // Exception: Super liked (9-10 stars) gets full weight even without watching
            if (item.rating >= 9) {
                weight = isTV ? 1.0 : 1.2;
            }
        }

        // Cap maximum weight
        return Math.min(weight, isTV ? 1.8 : 1.5);
    }

    /**
     * Recency decay half-life for rating-derived weights, in days (~9
     * months): a rating that old counts half as much as a fresh one. Shared
     * by both the positive (liked) centroid and the Rocchio negative
     * centroid in `createEnhancedUserProfile` so recent taste drift is
     * reflected symmetrically on both sides.
     */
    private static readonly RECENCY_HALFLIFE_DAYS = 270;

    /**
     * Exponential recency decay multiplier for a rating-derived weight.
     * `createdAt: null` (e.g. legacy rows without a timestamp) is treated as
     * "no decay" (factor 1) rather than penalized.
     */
    private recencyFactor(createdAt: Date | null): number {
        if (!createdAt) return 1;
        const ageDays = Math.max(0, (Date.now() - createdAt.getTime()) / 86_400_000);
        return Math.pow(0.5, ageDays / UserProfileService.RECENCY_HALFLIFE_DAYS);
    }

    /**
     * Create hybrid user profile combining watch history and ratings with enhanced weighting.
     *
     * `softDemote` (optional) shifts the profile centroid away from items the
     * user abandoned mid-watch (calibrated negative signal — see
     * getBehaviorallyDemotedMediaIds). Multiplier is applied to the post-
     * `calculateEnhancedWeight` value before the weighted average. Items not
     * in the set are unaffected.
     */
    async createEnhancedUserProfile(
        userId: UserId,
        watchHistory: Array<{
            primary_id?: string;
            title: string;
            genres?: string[];
            overview?: string;
            playCount?: number;
            playbackPositionTicks?: number;
            runtimeTicks?: number;
            mediaType?: 'movie' | 'tv';
            episodesWatched?: number;
            totalEpisodes?: number;
        }> = [],
        existingRatings?: UserRatingWithUuid[],
        softDemote?: {
            mediaIds: Set<string>;
            multiplier: number;
        },
    ): Promise<UserProfile | null> {
        try {
            // Get user ratings WITH UUIDs if not provided
            const ratings =
                existingRatings ||
                (await this.deps.getUserRatingsWithUuid(userId, PROFILE_RATING_WINDOW));

            // Per-user "include my watch history" toggle. When
            // disabled, watch-signal items (watch-only AND the watched-boost
            // portion of watched+rated weight) are excluded from the positive
            // centroid entirely — rating-derived weight is unaffected because
            // it comes from `ratingMap`, built from `ratings` below,
            // independent of `effectiveWatchHistory`. Re-read on every rebuild
            // (not cached on the instance) so a toggle flip takes effect on
            // the very next rebuild, whichever call site triggers it.
            const includeWatchHistory = await this.deps.getIncludeWatchHistoryPreference(userId);
            const effectiveWatchHistory = includeWatchHistory ? watchHistory : [];

            // Create lookup maps using composite keys (tmdb_id:media_type)
            type WatchedEntry = {
                watchTime: number;
                playCount?: number;
                episodesWatched?: number;
                totalEpisodes?: number;
                mediaType: 'movie' | 'tv';
            };
            const watchedMap = new Map<string, WatchedEntry>();
            const ratingMap = new Map<string, UserRatingWithUuid>();
            const keyToUuidMap = new Map<string, string>();

            // Map watched content using composite key
            for (const item of effectiveWatchHistory) {
                if (item.primary_id && item.mediaType) {
                    const key = `${item.primary_id}:${item.mediaType}`;
                    const completionRate =
                        item.playbackPositionTicks && item.runtimeTicks
                            ? item.playbackPositionTicks / item.runtimeTicks
                            : 1.0;

                    watchedMap.set(key, {
                        watchTime: Math.max(0.3, Math.min(1.0, completionRate)),
                        playCount: item.playCount,
                        episodesWatched: item.episodesWatched,
                        totalEpisodes: item.totalEpisodes,
                        mediaType: item.mediaType,
                    });
                }
            }

            // Map ratings using composite key, and build UUID lookup
            for (const rating of ratings) {
                const key = `${rating.primary_ext_id ?? rating.media_id}:${rating.media_type}`;
                ratingMap.set(key, rating);
                keyToUuidMap.set(key, rating.media_id);
            }

            // Get all unique composite keys
            const allKeys = new Set([
                ...Array.from(watchedMap.keys()),
                ...Array.from(ratingMap.keys()),
            ]);

            // BATCH OPTIMIZATION: Resolve all UUIDs upfront, then batch fetch embeddings

            // Step 1: Collect items that need TMDB -> UUID resolution
            const keysNeedingResolution: Array<{
                tmdbId: number;
                mediaType: 'movie' | 'tv';
            }> = [];
            for (const key of allKeys) {
                if (!keyToUuidMap.has(key)) {
                    const [tmdbIdStr, mediaType] = key.split(':');
                    keysNeedingResolution.push({
                        tmdbId: Number.parseInt(tmdbIdStr, 10),
                        // Composite-key segment: normalise rather than assert,
                        // since the key may carry either naming convention.
                        mediaType: isMovie(mediaType) ? 'movie' : 'tv',
                    });
                }
            }

            // Step 2: Batch resolve TMDB IDs to UUIDs
            if (keysNeedingResolution.length > 0) {
                const resolved = await this.deps.batchResolveMediaIds(keysNeedingResolution);
                for (const [lookupKey, uuid] of resolved) {
                    keyToUuidMap.set(lookupKey, uuid);
                }
            }

            // Step 3: Collect all UUIDs for batch embedding fetch
            const allUuids: string[] = [];
            for (const key of allKeys) {
                const uuid = keyToUuidMap.get(key);
                if (uuid) allUuids.push(uuid);
            }

            // Step 4: Batch fetch all embeddings
            const embeddingsMap = await this.deps.batchBuildMediaEmbeddingsFromUuids(allUuids);

            // Step 5: Build weighted embeddings with enhanced algorithm
            const weightedEmbeddings: Array<{
                embedding: number[];
                weight: number;
                tmdb_id: number;
            }> = [];
            const genrePreferences: Record<number, number> = {};

            // Rocchio negative centroid inputs: embeddings of items rated <=4
            // (disliked band — matches getDislikedMediaIds), collected
            // separately so they never enter the positive weighted average.
            // Recency-decayed and subtracted from the positive centroid below.
            const negativeItems: Array<{ embedding: number[]; createdAt: Date | null }> = [];

            for (const key of allKeys) {
                const watchedItem = watchedMap.get(key);
                const ratedItem = ratingMap.get(key);
                const [tmdbIdStr] = key.split(':');
                const tmdbId = Number.parseInt(tmdbIdStr, 10);

                // Get media from batch-fetched map
                const mediaUuid = keyToUuidMap.get(key);
                if (!mediaUuid) continue;
                const media = embeddingsMap.get(mediaUuid);
                if (!media) continue;

                // Get best available embedding
                const embedding =
                    parseEmbeddingVector(media.library_embedding) ??
                    parseEmbeddingVector(media.discovery_embedding);

                if (!embedding || embedding.length === 0) continue;

                // Route disliked ratings (<=4) to the negative centroid instead
                // of the positive weighted average — even if the item was also
                // watched. Neutral ratings (===5) are dropped entirely: they
                // contribute to neither centroid (still counted in
                // `ratings.length` / `rated_items` totals below).
                if (ratedItem) {
                    if (ratedItem.rating <= 4) {
                        negativeItems.push({ embedding, createdAt: ratedItem.created_at ?? null });
                        continue;
                    }
                    if (ratedItem.rating === 5) {
                        continue;
                    }
                }

                // Calculate enhanced weight (only watched-only or rating>=6
                // items reach this point — calculateEnhancedWeight would
                // return 0 for rating<=5 anyway, but the routing above keeps
                // those items out of weightedEmbeddings/genrePreferences too).
                let weight = this.calculateEnhancedWeight({
                    watched: !!watchedItem,
                    rating: ratedItem?.rating,
                    watchTime: watchedItem?.watchTime,
                    playCount: watchedItem?.playCount,
                    mediaType: media.media_type,
                    episodesWatched: watchedItem?.episodesWatched,
                    totalEpisodes: watchedItem?.totalEpisodes,
                });

                // Recency decay on rating-derived weight only — watch-only
                // signals keep their existing (undecayed) weighting so we
                // don't double-decay or penalize implicit watch signal.
                if (ratedItem) {
                    weight *= this.recencyFactor(ratedItem.created_at ?? null);
                }

                // Apply behavioral abandonment demote when the user has shown
                // a calibrated negative signal toward this item. Only attenuate
                // positive weights — every weight reaching this point is now
                // guaranteed non-negative (disliked ratings are routed away
                // above), but the sign guard is kept for defense-in-depth.
                if (softDemote && weight > 0 && softDemote.mediaIds.has(mediaUuid)) {
                    weight *= softDemote.multiplier;
                }

                weightedEmbeddings.push({ embedding, weight, tmdb_id: tmdbId });

                // Track genre preferences with enhanced weighting
                if (media.genres) {
                    for (const genreId of media.genres) {
                        genrePreferences[genreId] = (genrePreferences[genreId] || 0) + weight;
                    }
                }
            }

            // Calculate weighted average embedding
            const embeddingSize = weightedEmbeddings[0]?.embedding.length ?? 0;
            const profileEmbedding = new Array(embeddingSize).fill(0);
            let totalWeight = 0;

            for (const item of weightedEmbeddings) {
                totalWeight += item.weight;
                for (let i = 0; i < embeddingSize; i++) {
                    profileEmbedding[i] += item.embedding[i] * item.weight;
                }
            }

            // Cold-start guard: `weightedEmbeddings` only ever contains
            // watch-only signals and ratings >=6 (disliked ratings are routed
            // to `negativeItems` above, never here) — so an empty list means
            // zero liked items AND no watch signal. Falling back to null
            // rather than building a centroid purely out of `negativeItems`
            // mirrors the old ratings-only cold-start guard: averaging
            // disliked embeddings would point the engine AT rejected content.
            // Also covers demote multiplier 0 applied to every item, or the
            // NaN-guard case where `totalWeight` sums to exactly 0.
            if (
                weightedEmbeddings.length === 0 ||
                totalWeight === 0 ||
                !Number.isFinite(totalWeight)
            ) {
                return await this.upsertUserProfile({
                    user_id: userId,
                    catalog_embedding: null,
                    request_embedding: null,
                    preferences: {
                        genres: genrePreferences,
                        created_from: 'enhanced_hybrid',
                        total_items: allKeys.size,
                        watched_items: watchedMap.size,
                        rated_items: ratingMap.size,
                        // Re-persist the flag this rebuild READ (see the
                        // includeWatchHistory lookup above) — preferences is
                        // rewritten wholesale on every rebuild, so omitting
                        // this would silently reset the user's toggle back to
                        // the true default on their very next rebuild.
                        includeWatchHistory,
                        last_updated: new Date().toISOString(),
                    },
                    total_ratings: ratings.length,
                    last_activity: new Date(),
                });
            }

            // Normalize by total weight
            for (let i = 0; i < embeddingSize; i++) {
                profileEmbedding[i] /= totalWeight;
            }

            // Rocchio negative steering: subtract a fraction of the (recency-
            // decayed) disliked centroid so recommendations move AWAY from
            // content similar to disliked titles. Mirrors the shape previously
            // only present in createUserProfileFromRatings — now the single
            // shared implementation for both profile-rebuild paths.
            if (negativeItems.length > 0) {
                const NEGATIVE_WEIGHT = 0.4;
                const negCentroid = new Array(embeddingSize).fill(0);
                let negTotalWeight = 0;
                for (const item of negativeItems) {
                    const decay = this.recencyFactor(item.createdAt);
                    negTotalWeight += decay;
                    for (let i = 0; i < embeddingSize; i++) {
                        negCentroid[i] += item.embedding[i] * decay;
                    }
                }
                if (negTotalWeight > 0) {
                    for (let i = 0; i < embeddingSize; i++) {
                        profileEmbedding[i] -= NEGATIVE_WEIGHT * (negCentroid[i] / negTotalWeight);
                    }
                }
            }

            // L2-normalize so pgvector cosine/HNSW similarity is dimensionally
            // consistent with unit-length item embeddings.
            let norm = 0;
            for (let i = 0; i < embeddingSize; i++) {
                norm += profileEmbedding[i] * profileEmbedding[i];
            }
            norm = Math.sqrt(norm);
            const hasUsableEmbedding = norm > 0;
            if (hasUsableEmbedding) {
                for (let i = 0; i < embeddingSize; i++) {
                    profileEmbedding[i] /= norm;
                }
            } else {
                // Degenerate centroid (e.g. mixed-sign weights cancelled out).
                // Persist a NULL embedding rather than an all-zero vector, which
                // would be a meaningless cosine neighbour for every item.
                logger.warn('Enhanced profile centroid has zero norm; storing null embedding', {
                    userId,
                });
            }

            const avgWeight = totalWeight / weightedEmbeddings.length;
            const weights = weightedEmbeddings.map((e) => e.weight).sort((a, b) => b - a);

            return await this.upsertUserProfile({
                user_id: userId,
                catalog_embedding: hasUsableEmbedding ? profileEmbedding : null,
                request_embedding: hasUsableEmbedding ? profileEmbedding : null,
                availability_preference: 0.7,
                quality_weight: 0.2,
                popularity_weight: 0.1,
                recency_weight: 0.1,
                preferences: {
                    genres: genrePreferences,
                    created_from: 'enhanced_hybrid',
                    total_items: allKeys.size,
                    watched_items: watchedMap.size,
                    rated_items: ratingMap.size,
                    overlap_items: Array.from(allKeys).filter(
                        (key) => watchedMap.has(key) && ratingMap.has(key),
                    ).length,
                    average_weight: avgWeight,
                    weight_distribution: {
                        min: weights[weights.length - 1],
                        max: weights[0],
                        median: weights[Math.floor(weights.length / 2)],
                    },
                    // See the cold-start branch above for why this must be
                    // re-persisted on every write.
                    includeWatchHistory,
                    last_updated: new Date().toISOString(),
                },
                total_ratings: ratings.length,
                last_activity: new Date(),
            });
        } catch (error) {
            logger.error('Failed to create enhanced user profile', error as Error, { userId });
            return null;
        }
    }

    /**
     * Canonical profile rebuild entry point: combines ratings AND watch
     * history into one enhanced profile via createEnhancedUserProfile.
     *
     * Replaces the ratings-only createUserProfileFromRatings as the default
     * rebuild path so watch-heavy users (few/no ratings) also get a profile.
     */
    async rebuildUserProfile(userId: UserId): Promise<UserProfile | null> {
        try {
            const ratings = await this.deps.getUserRatingsWithUuid(userId, PROFILE_RATING_WINDOW);

            const watchRows = await getWatchStateForProfile.all(this.sql, { userId });

            const watchHistory = watchRows.map((row) => ({
                primary_id: row.primary_id,
                title: row.title,
                // constrained: getWatchStateForProfile filters
                // `AND mi.media_type IN ('movie', 'tv')` (watch-state.queries.ts:230)
                // eslint-disable-next-line callback-safety/no-narrowing-media-type-cast
                mediaType: row.media_type as 'movie' | 'tv',
                playCount: row.play_count,
                playbackPositionTicks: row.resume_position_ms,
                runtimeTicks: row.runtime_ms ?? undefined,
            }));

            logger.info('Rebuilding user profile (enhanced hybrid)', {
                userId,
                ratingsCount: ratings.length,
                watchCount: watchHistory.length,
            });

            // Optionally fetch behavioral negatives (abandoned items with
            // ≥5min real watch, <60% completion) so the profile centroid
            // is shifted away from items the user sampled and bailed on.
            // Best-effort: a DB error here must NOT fail profile rebuild.
            // Mirrors the wiring in the admin generate-enhanced-profile route
            // so the canonical rebuild path applies the same demotion.
            let softDemote: { mediaIds: Set<string>; multiplier: number } | undefined;
            if (features.forYouAbandonmentDemote) {
                try {
                    const demoted = await getBehaviorallyDemotedMediaIds(this.sql, userId);
                    if (demoted.length > 0) {
                        // Clamp multiplier into [0, 1]. Schema validation
                        // is UI-only — env-set values bypass it, and NaN
                        // would propagate into the centroid math.
                        const raw = config.FORYOU_ABANDONMENT_DEMOTE_MULTIPLIER;
                        const multiplier = Number.isFinite(raw)
                            ? Math.min(1, Math.max(0, raw))
                            : 0.3;
                        softDemote = {
                            mediaIds: new Set(demoted),
                            multiplier,
                        };
                        logger.info('Applying abandonment soft-demote', {
                            userId,
                            demotedCount: demoted.length,
                            multiplier,
                        });
                    }
                } catch (e) {
                    logger.warn(
                        'Failed to fetch abandonment demote set; continuing without demote',
                        { userId },
                        e as Error,
                    );
                }
            }

            return await this.createEnhancedUserProfile(userId, watchHistory, ratings, softDemote);
        } catch (error) {
            logger.error('Failed to rebuild user profile', error as Error, { userId });
            return null;
        }
    }

    /**
     * Fire-and-forget profile rebuild debounced by a Valkey TTL key.
     *
     * A binge session (many watch completions in quick succession) triggers at
     * most one rebuild per debounce window. The rebuild itself runs detached
     * from the calling request so it never blocks playback.
     *
     * @param userId - The user whose profile to rebuild.
     * @param debounceSeconds - TTL of the debounce key (default 6 hours).
     */
    rebuildUserProfileDebounced(userId: UserId, debounceSeconds = 6 * 60 * 60): void {
        const debounceKey = `v1:profile-rebuild-pending:${userId}`;

        void (async () => {
            // Atomic claim: SET NX with TTL so only the first of N concurrent
            // completions runs the rebuild. setIfNotExists returns false when the
            // key already exists OR when Valkey is unavailable — both mean "skip"
            // (fail-safe: a cache outage suppresses rebuilds rather than flooding).
            const claimed = await setIfNotExists(debounceKey, '1', debounceSeconds);
            if (!claimed) {
                logger.debug('Profile rebuild already pending or cache unavailable, skipping', {
                    userId,
                });
                return;
            }

            try {
                const profile = await this.rebuildUserProfile(userId);
                if (profile) {
                    logger.info('Debounced profile rebuild completed', { userId });
                } else {
                    logger.debug('Debounced profile rebuild returned null (below threshold)', {
                        userId,
                    });
                }
            } catch (error) {
                // Release the claim so a later completion can retry instead of
                // being blocked for the entire debounce window.
                await cacheDel(debounceKey).catch(() => {});
                logger.error('Debounced profile rebuild failed', error as Error, { userId });
            }
        })();
    }
}
