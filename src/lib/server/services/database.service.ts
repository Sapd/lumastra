// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import type {
    Database,
    MediaEmbedding,
    UserProfile,
    UserRating,
    UserSuggestion,
} from '$lib/server/database/connection.js';
import type postgres from 'postgres';
import type { UserId } from '$lib/shared/user-id';
import { Logger } from '../utils/logger.js';
import { daysAgo } from '$lib/utils/time-period.js';
import {
    getSystemStats as getSystemStatsQuery,
    deleteExpiredSuggestions,
    type SystemStats,
} from '../database/queries/ai-admin.queries.js';
import { getSuggestionEngine, type SuggestionEngineService } from './suggestion-engine.service.js';
import { CatalogService } from './catalog.service.js';
import { UserProfileService } from './user-profile.service.js';
import { UserRatingsService } from './user-ratings.service.js';
import { countWatchedEmbeddableItems } from '../database/queries/watch-state.queries.js';
import { config } from '$lib/server/config.js';

const logger = Logger.for('DatabaseService');

/**
 * AI Database Service - Singleton for centralized database operations
 *
 * Eliminates duplicate database connection patterns across 25+ API endpoints
 * Provides:
 * - Singleton pattern to avoid repeated connections
 * - Common database operations with consistent error handling
 * - Centralized transaction management
 * - Type-safe database interactions
 */
export class DatabaseService {
    private static instance: DatabaseService | null = null;
    private db: Database | null = null;
    private sql: postgres.Sql | null = null;
    private initialized = false;
    private initializationPromise: Promise<boolean> | null = null;

    private constructor() {
        // Private constructor to enforce singleton pattern
    }

    /**
     * Get singleton instance of DatabaseService
     */
    public static getInstance(): DatabaseService {
        if (!DatabaseService.instance) {
            DatabaseService.instance = new DatabaseService();
        }
        return DatabaseService.instance;
    }

    /**
     * Initialize database connection (with caching to avoid duplicate imports)
     */
    private async initialize(): Promise<boolean> {
        if (this.initialized) {
            return true;
        }

        if (this.initializationPromise) {
            return this.initializationPromise;
        }

        this.initializationPromise = this._performInitialization();
        const result = await this.initializationPromise;
        this.initializationPromise = null;
        return result;
    }

    private async _performInitialization(): Promise<boolean> {
        try {
            // Dynamic import to avoid build issues
            const { Database, getDb, testDbConnection } =
                await import('$lib/server/database/connection.js');

            // Test connection first
            const isHealthy = await testDbConnection();
            if (!isHealthy) {
                logger.warn('AI database connection test failed');
                return false;
            }

            this.db = new Database();
            this.sql = getDb();

            if (!this.sql) {
                logger.warn('Failed to get AI database connection');
                return false;
            }

            this.initialized = true;
            logger.info('Successfully initialized');
            return true;
        } catch (error) {
            logger.error('Initialization failed', error as Error);
            return false;
        }
    }

    /**
     * Check if service is available and database is connected
     */
    public async isAvailable(): Promise<boolean> {
        return await this.initialize();
    }

    /**
     * Get the database instance (ensures initialization)
     */
    public async getDatabase(): Promise<Database | null> {
        const isReady = await this.initialize();
        return isReady ? this.db : null;
    }

    /**
     * Get the SQL connection (ensures initialization)
     */
    public async getSql(): Promise<postgres.Sql | null> {
        const isReady = await this.initialize();
        return isReady ? this.sql : null;
    }

    /**
     * Test database connection
     */
    public async testConnection(): Promise<boolean> {
        try {
            const { testDbConnection } = await import('$lib/server/database/connection.js');
            return await testDbConnection();
        } catch (error) {
            logger.error('Connection test failed', error as Error);
            return false;
        }
    }

    // Service Factory Methods
    // Provide convenient access to service instances

    /**
     * Get the SuggestionEngineService instance
     */
    public async getSuggestionEngine(): Promise<SuggestionEngineService | null> {
        const sql = await this.getSql();
        const db = await this.getDatabase();
        if (!sql || !db) return null;
        return getSuggestionEngine(sql, db);
    }

    /**
     * Get the CatalogService instance
     */
    public async getCatalogService(): Promise<CatalogService | null> {
        const sql = await this.getSql();
        if (!sql) return null;
        return new CatalogService(sql);
    }

    /**
     * Get the UserProfileService instance
     */
    public async getUserProfileService(): Promise<UserProfileService | null> {
        const sql = await this.getSql();
        const db = await this.getDatabase();
        if (!sql || !db) return null;
        return new UserProfileService(sql, db);
    }

    /**
     * Get the UserRatingsService instance
     */
    public async getUserRatingsService(): Promise<UserRatingsService | null> {
        const sql = await this.getSql();
        if (!sql) return null;
        return new UserRatingsService(sql);
    }

    // Common Database Operations
    // These methods encapsulate frequently used patterns across API endpoints

    /**
     * Get user ratings with optional details
     */
    public async getUserRatings(userId: UserId, limit = 100): Promise<UserRating[]> {
        const ratingsService = await this.getUserRatingsService();
        if (!ratingsService) return [];

        try {
            return await ratingsService.getUserRatings(userId, limit);
        } catch (error) {
            logger.error('Failed to get user ratings', error as Error, {
                userId,
                limit,
            });
            return [];
        }
    }

    /**
     * Get user profile or create if it doesn't exist.
     *
     * Creates via rebuildUserProfile (combined ratings + watch history) when
     * the user meets EITHER the minimum ratings threshold OR the minimum
     * watched-items threshold.
     */
    public async getUserProfileOrCreate(userId: UserId): Promise<UserProfile | null> {
        const profileService = await this.getUserProfileService();
        const ratingsService = await this.getUserRatingsService();
        const sql = await this.getSql();
        if (!profileService || !ratingsService || !sql) return null;

        try {
            let profile = await profileService.getUserProfile(userId);
            if (!profile) {
                const minRatings = config.FORYOU_MIN_RATINGS;
                const minWatched = config.FORYOU_MIN_WATCHED;

                const ratings = await ratingsService.getUserRatings(userId, 100);
                const hasEnoughRatings = ratings.length >= minRatings;

                let hasEnoughWatched = false;
                if (!hasEnoughRatings) {
                    const watchedCount = await countWatchedEmbeddableItems(sql, userId);
                    hasEnoughWatched = watchedCount >= minWatched;
                }

                if (hasEnoughRatings || hasEnoughWatched) {
                    profile = await profileService.rebuildUserProfile(userId);
                }
            }
            return profile;
        } catch (error) {
            logger.error('Failed to get/create user profile', error as Error, {
                userId,
            });
            return null;
        }
    }

    /**
     * Get user suggestions with metadata
     */
    public async getUserSuggestionsWithMetadata(
        userId: UserId,
        limit = 10,
    ): Promise<
        Array<
            UserSuggestion & {
                title: string;
                overview?: string | null;
                release_date?: string | null;
                poster_path?: string | null;
                backdrop_path?: string | null;
                vote_average?: number | null;
                genres?: number[] | null;
            }
        >
    > {
        const db = await this.getDatabase();
        if (!db) return [];

        try {
            const suggestions = await db.getUserSuggestions(userId, limit);

            // Enhance suggestions with media metadata. Batch-fetch all embeddings
            // in one pass (5 bulk queries) instead of N*5 per-item round-trips,
            // then map synchronously. Provider-agnostic: keyed by UUID, no
            // external-ID coercion.
            const embeddingsMap = await db.getMediaEmbeddingsByUuids(
                suggestions.map((s) => s.media_id),
            );

            const detailedSuggestions = suggestions.map((suggestion) => {
                const media = embeddingsMap.get(suggestion.media_id);
                return {
                    ...suggestion,
                    title: media?.title || 'Unknown',
                    overview: media?.overview,
                    release_date: media?.release_date,
                    poster_path: media?.poster_path ?? null,
                    backdrop_path: media?.backdrop_path ?? null,
                    vote_average: media?.vote_average,
                    genres: media?.genres,
                };
            });

            return detailedSuggestions;
        } catch (error) {
            logger.error('Failed to get user suggestions', error as Error, {
                userId,
                limit,
            });
            return [];
        }
    }

    /**
     * Get media embedding with caching.
     *
     * IMPORTANT: mediaType is REQUIRED because TMDB IDs are NOT unique across types!
     * Example: TMDB ID 1429 = "25th Hour" (movie) AND "Attack on Titan" (tv)
     */
    public async getMediaEmbedding(
        tmdbId: number,
        mediaType: 'movie' | 'tv',
    ): Promise<MediaEmbedding | null> {
        const db = await this.getDatabase();
        if (!db) return null;

        try {
            return await db.getMediaEmbedding(tmdbId, mediaType);
        } catch (error) {
            logger.error('Failed to get media embedding', error as Error, {
                tmdbId,
                mediaType,
            });
            return null;
        }
    }

    /**
     * Get media embedding by internal UUID.
     *
     * UUID-first pattern: use when media_id (UUID) is already available
     * (e.g. from user_suggestions.media_id), avoiding external ID joins.
     */
    public async getMediaEmbeddingByUuid(mediaId: string): Promise<MediaEmbedding | null> {
        const db = await this.getDatabase();
        if (!db) return null;

        try {
            return await db.getMediaEmbeddingByUuid(mediaId);
        } catch (error) {
            logger.error('Failed to get media embedding by UUID', error as Error, {
                mediaId,
            });
            return null;
        }
    }

    /**
     * Batch-fetch media embeddings by internal UUID.
     *
     * Collapses N per-item `getMediaEmbeddingByUuid` calls (5 queries each) into
     * 5 bulk queries. The returned `MediaEmbedding` objects are field-identical
     * to the single-item builder (same access-agnostic provider-chain row
     * selection, same `status='active'` filter, same availability semantics).
     * Missing/inactive UUIDs are simply absent from the map (mirrors the
     * single-item builder returning `null`).
     */
    public async getMediaEmbeddingsByUuids(
        mediaIds: string[],
    ): Promise<Map<string, MediaEmbedding>> {
        if (mediaIds.length === 0) return new Map();
        const db = await this.getDatabase();
        if (!db) return new Map();

        try {
            // Falsy-id filtering lives at the batch choke point
            // (batchBuildMediaEmbeddingsFromUuids), which every caller funnels
            // through — so this wrapper forwards ids as-is.
            return await db.getMediaEmbeddingsByUuids(mediaIds);
        } catch (error) {
            logger.error('Failed to batch get media embeddings by UUID', error as Error, {
                count: mediaIds.length,
            });
            return new Map();
        }
    }

    /**
     * Check user onboarding status
     */
    public async getUserOnboardingStatus(userId: UserId): Promise<{
        hasRatings: boolean;
        ratingsCount: number;
        hasProfile: boolean;
        needsOnboarding: boolean;
    }> {
        const profileService = await this.getUserProfileService();
        const ratingsService = await this.getUserRatingsService();
        if (!profileService || !ratingsService) {
            return {
                hasRatings: false,
                ratingsCount: 0,
                hasProfile: false,
                needsOnboarding: true,
            };
        }

        try {
            const ratings = await ratingsService.getUserRatings(userId, 100);
            const profile = await profileService.getUserProfile(userId);

            return {
                hasRatings: ratings.length > 0,
                ratingsCount: ratings.length,
                hasProfile: !!profile,
                needsOnboarding: ratings.length < 5 || !profile,
            };
        } catch (error) {
            logger.error('Failed to check onboarding status', error as Error, {
                userId,
            });
            return {
                hasRatings: false,
                ratingsCount: 0,
                hasProfile: false,
                needsOnboarding: true,
            };
        }
    }

    /**
     * Get system statistics
     */
    public async getSystemStats(): Promise<SystemStats> {
        const sql = await this.getSql();
        if (!sql) {
            return {
                totalUsers: 0,
                totalRatings: 0,
                totalMediaItems: 0,
                totalSuggestions: 0,
            };
        }

        try {
            return await getSystemStatsQuery(sql);
        } catch (error) {
            logger.error('Failed to get system stats', error as Error);
            return {
                totalUsers: 0,
                totalRatings: 0,
                totalMediaItems: 0,
                totalSuggestions: 0,
            };
        }
    }

    /**
     * Clean up expired suggestions and data
     */
    public async cleanupExpiredData(): Promise<void> {
        const sql = await this.getSql();
        if (!sql) return;

        try {
            // Remove suggestions older than 7 days
            await deleteExpiredSuggestions(sql, daysAgo(7));
            logger.info('Cleaned up expired suggestions');
        } catch (error) {
            logger.error('Failed to cleanup expired data', error as Error);
        }
    }

    /**
     * Validate user permissions for AI operations
     */
    public async validateUserAccess(userId: UserId): Promise<{
        canUseAI: boolean;
        reason?: string;
    }> {
        if (!userId || userId.trim() === '') {
            return { canUseAI: false, reason: 'Invalid user ID' };
        }

        const status = await this.getUserOnboardingStatus(userId);
        const minRatings = config.FORYOU_MIN_RATINGS;

        if (status.ratingsCount >= minRatings) {
            return { canUseAI: true };
        }

        // Watch-history path: a user with enough watched, embeddable items can use
        // AI even without ratings (mirrors getUserProfileOrCreate / suggestions).
        const sql = await this.getSql();
        if (sql) {
            const watchedCount = await countWatchedEmbeddableItems(sql, userId);
            if (watchedCount >= config.FORYOU_MIN_WATCHED) {
                return { canUseAI: true };
            }
        }

        return {
            canUseAI: false,
            reason: `Insufficient ratings (${status.ratingsCount}/${minRatings} required) and not enough watch history`,
        };
    }

    /**
     * Reset instance (useful for testing)
     */
    public static resetInstance(): void {
        DatabaseService.instance = null;
    }
}

// Export singleton instance
export const aiDbService = DatabaseService.getInstance();

// Export factory function for testing
export function createDatabaseService(): DatabaseService {
    return DatabaseService.getInstance();
}
