// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

// Jellyfin Token Service for Device Authorization
// Manages per-device Jellyfin access tokens for proper session identification

import { Database } from '../database/connection.js';
import type { UserId } from '$lib/shared/user-id';
import { jellyfinAuthService } from '../jellyfin';
import { config } from '../config';
import { Logger } from '../utils/logger';
import { LRUCache } from '../cache/lru-cache';
import { standaloneCacheRegistry } from '../cache/standalone-registry';
import type postgres from 'postgres';
import {
    getJellyfinTokenBySession,
    getActiveJellyfinTokens,
    upsertJellyfinToken,
    updateJellyfinTokenLastUsed,
    deleteJellyfinToken,
    revokeJellyfinToken,
    revokeAllUserJellyfinTokens,
    cleanupOrphanedJellyfinTokens,
    cleanupRevokedJellyfinTokens,
} from '../database/queries/provider-device-tokens.queries.js';
import { getDeviceNameBySession } from '../database/queries/oauth-refresh-tokens.queries.js';

const logger = Logger.for('OAuth:JellyfinToken');

// How often to validate tokens against Jellyfin (30 minutes)
// This catches tokens that were deleted/revoked from Jellyfin's dashboard
// Shorter interval = faster detection of revoked tokens, but more API calls
const TOKEN_VALIDATION_INTERVAL_MS = 30 * 60 * 1000;

// In-memory cache TTL (30 minutes)
// Aligns with TOKEN_VALIDATION_INTERVAL_MS; explicit invalidateToken() handles revocations.
// During HLS streaming, segment requests come every few seconds — caching
// avoids hitting the database on each request.
const TOKEN_CACHE_TTL_MS = 30 * 60 * 1000;

export interface JellyfinDeviceToken {
    id: number;
    user_id: string;
    provider_user_id: string;
    device_session_id: string;
    /**
     * The exact `Device="..."` string this token is bound to in Jellyfin. A
     * credential component, NOT a display label — never surface it in a device
     * list. Immutable after creation; see migration 16.174.0.
     */
    provider_device_binding: string | null;
    provider_access_token: string;
    created_at: Date;
    last_used_at: Date | null;
    revoked_at: Date | null;
}

export interface CreateJellyfinTokenParams {
    userId: UserId;
    jellyfinUserId: string;
    deviceSessionId: string;
    deviceName?: string;
    /** Client-provided persistent device identifier - stored for future session reuse */
    deviceId?: string;
    /**
     * Force token validation against Jellyfin API, bypassing the 30-minute interval check.
     * Use this in PlaybackInfo to ensure Quick Connect happens before playback starts,
     * rather than during HLS streaming when it would cause buffering.
     */
    forceValidate?: boolean;
}

export interface JellyfinTokenResult {
    token: string;
    deviceName: string; // The device name used when creating the token - MUST be used in auth headers
}

export class JellyfinTokenService {
    private readonly db: Database;
    private readonly sql: postgres.Sql;

    // LRU cache to avoid DB lookups on every request (e.g., progress reports every 10s)
    // Stores JSON string of JellyfinTokenResult for simplicity
    private readonly tokenCache: LRUCache<string>;

    constructor() {
        this.db = new Database();
        this.sql = this.db.getSql();
        this.tokenCache = new LRUCache<string>({
            maxSize: 100, // Max 100 device sessions cached
            defaultTTL: TOKEN_CACHE_TTL_MS,
            namespace: 'jellyfin-tokens',
        });

        // Register cache for admin monitoring
        standaloneCacheRegistry.register({
            name: 'jellyfin-tokens',
            description: 'api/v1: Jellyfin device session access tokens',
            category: 'auth',
            cache: this.tokenCache,
        });
    }

    private cacheResult(
        deviceSessionId: string,
        result: JellyfinTokenResult,
        username: string,
    ): void {
        this.tokenCache.set(deviceSessionId, JSON.stringify(result), undefined, username);
    }

    private getCachedResult(deviceSessionId: string, username: string): JellyfinTokenResult | null {
        const cached = this.tokenCache.get(deviceSessionId, username);
        if (cached) {
            try {
                return JSON.parse(cached) as JellyfinTokenResult;
            } catch {
                return null;
            }
        }
        return null;
    }

    /**
     * Get or create a Jellyfin access token for a device
     * If a token exists for this device session AND user, validate and return it
     * Otherwise, create a new one via Quick Connect
     *
     * IMPORTANT: The returned deviceName MUST be used in MediaBrowser Authorization headers
     * when making requests with this token. Jellyfin binds tokens to (token, deviceId, deviceName).
     */
    async getOrCreateToken(params: CreateJellyfinTokenParams): Promise<JellyfinTokenResult | null> {
        // Check in-memory cache first to avoid DB hits on repeated calls
        // Use username as userId for proper multi-user cache isolation
        // Skip cache when forceValidate is true (PlaybackInfo wants early validation)
        if (!params.forceValidate) {
            const cachedResult = this.getCachedResult(params.deviceSessionId, params.userId);
            if (cachedResult) {
                return cachedResult;
            }
        }

        // Check if we already have a token for this device session
        const existing = await this.getByDeviceSession(params.deviceSessionId);
        if (existing) {
            // IMPORTANT: Check if the token belongs to the current user
            // Browser localStorage is shared, so different users on the same browser
            // will have the same deviceId. We must ensure each user gets their own token.
            if (existing.user_id !== params.userId) {
                logger.info('Device session belongs to different user, creating new token', {
                    deviceSessionId: params.deviceSessionId.substring(0, 8) + '...',
                    existingUser: existing.user_id,
                    requestingUser: params.userId,
                });
                // Delete the old token - this device is now being used by a different user
                await this.deleteByDeviceSession(params.deviceSessionId, existing.user_id);
                // Fall through to create new token for current user
            } else {
                // Token belongs to current user - validate if needed
                // forceValidate bypasses the 30-minute interval check (used in PlaybackInfo
                // to ensure Quick Connect happens before playback starts, not during HLS)
                const needsValidation = params.forceValidate || this.shouldValidateToken(existing);

                if (needsValidation) {
                    logger.debug('Validating Jellyfin token', {
                        deviceSessionId: params.deviceSessionId.substring(0, 8) + '...',
                        userId: params.userId,
                        forced: params.forceValidate || false,
                    });

                    const isValid = await jellyfinAuthService.validateAccessToken(
                        existing.provider_access_token,
                        {
                            deviceName:
                                existing.provider_device_binding || `${config.APP_NAME} TV App`,
                            deviceId: existing.device_session_id,
                        },
                    );

                    if (!isValid) {
                        // Token was rejected by Jellyfin - this is unexpected since Jellyfin tokens
                        // don't expire. Possible causes: token revoked in Jellyfin dashboard,
                        // Jellyfin server restarted, or database was restored from backup.
                        const tokenAge = existing.created_at
                            ? Math.round(
                                  (Date.now() - new Date(existing.created_at).getTime()) /
                                      1000 /
                                      60,
                              )
                            : 'unknown';
                        logger.warn('Jellyfin token validation failed - token will be recreated', {
                            deviceSessionId: params.deviceSessionId.substring(0, 8) + '...',
                            userId: params.userId,
                            deviceName: existing.provider_device_binding,
                            tokenAgeMinutes: tokenAge,
                            hint: 'Jellyfin tokens do not expire - check if token was revoked or Jellyfin was restarted',
                        });
                        await this.deleteByDeviceSession(params.deviceSessionId, params.userId);
                        // Fall through to create new token
                    } else {
                        // Token is valid - update last_used_at, cache, and return
                        logger.debug('Jellyfin token validated successfully', {
                            deviceSessionId: params.deviceSessionId.substring(0, 8) + '...',
                        });
                        await this.updateLastUsed(params.deviceSessionId);
                        const result: JellyfinTokenResult = {
                            token: existing.provider_access_token,
                            deviceName:
                                existing.provider_device_binding || `${config.APP_NAME} TV App`,
                        };
                        this.cacheResult(params.deviceSessionId, result, params.userId);
                        return result;
                    }
                } else {
                    // Token was validated recently, just update last_used_at and cache
                    logger.debug('Found existing Jellyfin token for device session', {
                        deviceSessionId: params.deviceSessionId.substring(0, 8) + '...',
                        userId: params.userId,
                    });
                    await this.updateLastUsed(params.deviceSessionId);
                    const result: JellyfinTokenResult = {
                        token: existing.provider_access_token,
                        deviceName: existing.provider_device_binding || `${config.APP_NAME} TV App`,
                    };
                    this.cacheResult(params.deviceSessionId, result, params.userId);
                    return result;
                }
            }
        }

        // No existing token - create one via Quick Connect
        // If deviceName not provided, try to look it up from refresh tokens
        let deviceName = params.deviceName;
        if (!deviceName) {
            try {
                deviceName =
                    (await getDeviceNameBySession(this.sql, params.deviceSessionId)) || undefined;
            } catch {
                // Ignore lookup errors - we'll use the fallback name
            }
        }

        logger.info('Creating new Jellyfin token via Quick Connect', {
            userId: params.userId,
            deviceName: deviceName || '(fallback)',
            deviceSessionId: params.deviceSessionId.substring(0, 8) + '...',
        });

        const result = await this.createViaQuickConnect({
            ...params,
            deviceName,
        });

        // Cache the newly created token with username for proper isolation
        if (result) {
            this.cacheResult(params.deviceSessionId, result, params.userId);
        }

        return result;
    }

    /**
     * Create a new Jellyfin token via Quick Connect
     * Returns both the token AND the deviceName used - this deviceName MUST be used
     * in subsequent auth headers when using this token
     */
    private async createViaQuickConnect(
        params: CreateJellyfinTokenParams,
    ): Promise<JellyfinTokenResult | null> {
        try {
            // Step 1: Initiate Quick Connect
            const initResult = await jellyfinAuthService.initiateQuickConnect();
            if (!initResult) {
                logger.error('Failed to initiate Quick Connect');
                return null;
            }

            logger.debug('Quick Connect initiated', { code: initResult.Code });

            // Step 2: Authorize the code for this user (using admin API key)
            const authorized = await jellyfinAuthService.authorizeQuickConnect(
                initResult.Code,
                params.jellyfinUserId,
            );

            if (!authorized) {
                logger.error('Failed to authorize Quick Connect code');
                return null;
            }

            logger.debug('Quick Connect code authorized');

            // Step 3: Exchange for access token with device info
            // Build device name for Jellyfin: "AppName - Device Name" or "AppName TV App"
            // CRITICAL: This exact deviceName must be used in auth headers when using this token
            const deviceDisplayName = params.deviceName
                ? `${config.APP_NAME} - ${params.deviceName}`
                : `${config.APP_NAME} TV App`;

            const authResult = await jellyfinAuthService.connectQuickConnectWithDevice(
                initResult.Secret,
                deviceDisplayName,
                params.deviceSessionId,
            );

            if (!authResult?.AccessToken) {
                logger.error('Failed to get access token from Quick Connect');
                return null;
            }

            logger.info('Jellyfin token created successfully', {
                userId: params.userId,
                deviceName: deviceDisplayName,
            });

            // Step 4: Store the token in our database
            // IMPORTANT: Store deviceDisplayName (the full name used with Jellyfin), NOT params.deviceName
            // Also store device_id for future session reuse lookups
            // Use ON CONFLICT to handle race condition where another request
            // might have created the token between our check and insert.
            await upsertJellyfinToken(this.sql, {
                userId: params.userId,
                jellyfinUserId: params.jellyfinUserId,
                deviceSessionId: params.deviceSessionId,
                deviceName: deviceDisplayName,
                accessToken: authResult.AccessToken,
                deviceId: params.deviceId || null,
            });

            // Return both token and the deviceName that must be used in auth headers
            return {
                token: authResult.AccessToken,
                deviceName: deviceDisplayName,
            };
        } catch (error) {
            logger.error('Failed to create Jellyfin token via Quick Connect', error as Error);
            return null;
        }
    }

    /**
     * Get token by device session ID
     */
    async getByDeviceSession(deviceSessionId: string): Promise<JellyfinDeviceToken | null> {
        return (await getJellyfinTokenBySession(
            this.sql,
            deviceSessionId,
        )) as JellyfinDeviceToken | null;
    }

    /**
     * Update last_used_at timestamp
     */
    private async updateLastUsed(deviceSessionId: string): Promise<void> {
        await updateJellyfinTokenLastUsed(this.sql, deviceSessionId);
    }

    /**
     * Check if a token needs validation against Jellyfin
     * We validate periodically to catch tokens deleted from Jellyfin's dashboard
     */
    private shouldValidateToken(token: JellyfinDeviceToken): boolean {
        // Always validate if never used (just created)
        if (!token.last_used_at) {
            return true;
        }

        // Validate if last_used_at is older than the validation interval
        const lastUsed = new Date(token.last_used_at).getTime();
        const now = Date.now();
        return now - lastUsed > TOKEN_VALIDATION_INTERVAL_MS;
    }

    /**
     * Delete a token by device session ID (used when token is invalid)
     */
    private async deleteByDeviceSession(deviceSessionId: string, username?: string): Promise<void> {
        // Get username for cache invalidation if not provided
        let effectiveUserId = username;
        if (!effectiveUserId) {
            const existing = await this.getByDeviceSession(deviceSessionId);
            effectiveUserId = existing?.user_id;
        }

        // Invalidate cache with proper user isolation
        if (effectiveUserId) {
            this.tokenCache.delete(deviceSessionId, effectiveUserId);
        }

        await deleteJellyfinToken(this.sql, deviceSessionId);
        logger.debug('Deleted invalid Jellyfin device token', {
            deviceSessionId: deviceSessionId.substring(0, 8) + '...',
            userId: effectiveUserId,
        });
    }

    /**
     * Invalidate a token (delete from DB so it will be recreated on next use)
     * Called when we detect a 401 from Jellyfin
     */
    async invalidateToken(deviceSessionId: string): Promise<void> {
        await this.deleteByDeviceSession(deviceSessionId);
        logger.info('Jellyfin token invalidated (will be recreated)', {
            deviceSessionId: deviceSessionId.substring(0, 8) + '...',
        });
    }

    /**
     * Revoke a device token
     * @param deviceSessionId - The device session ID to revoke
     * @param userId - Optional users.id UUID to ensure token belongs to this user
     *   (security check). user_provider_device_tokens.user_id is a uuid (mig 16.46.0).
     */
    async revoke(deviceSessionId: string, userId?: UserId): Promise<boolean> {
        // Get existing token for cache invalidation and ownership verification
        const existing = await this.getByDeviceSession(deviceSessionId);

        // If userId provided, verify ownership (both sides are users.id UUIDs)
        if (userId && existing && existing.user_id !== userId) {
            logger.warn('Attempted to revoke token belonging to different user', {
                deviceSessionId: deviceSessionId.substring(0, 8) + '...',
                requestedBy: userId,
                actualOwner: existing.user_id,
            });
            return false;
        }

        if (existing) {
            this.tokenCache.delete(deviceSessionId, existing.user_id);
        }

        const count = await revokeJellyfinToken(this.sql, deviceSessionId, userId);

        if (count > 0) {
            logger.info('Jellyfin device token revoked', {
                deviceSessionId: deviceSessionId.substring(0, 8) + '...',
                userId: existing?.user_id,
            });
            return true;
        }

        return false;
    }

    /**
     * Revoke all tokens for a user
     */
    async revokeAllForUser(userId: UserId, sql: postgres.Sql = this.sql): Promise<number> {
        // Invalidate all cached tokens for this user
        const cacheDeleted = this.tokenCache.deleteUserCache(userId);
        if (cacheDeleted > 0) {
            logger.debug('Invalidated cached tokens for user', {
                userId,
                count: cacheDeleted,
            });
        }

        const count = await revokeAllUserJellyfinTokens(sql, userId);

        if (count > 0) {
            logger.info('All Jellyfin device tokens revoked for user', {
                userId,
                count,
            });
        }

        return count;
    }

    /**
     * Get all active tokens for a user (for management UI)
     */
    async getActiveTokensForUser(userId: UserId): Promise<JellyfinDeviceToken[]> {
        return (await getActiveJellyfinTokens(this.sql, userId)) as JellyfinDeviceToken[];
    }

    /**
     * Get cache statistics for observability
     */
    getCacheStats() {
        return this.tokenCache.getStats();
    }

    /**
     * Cleanup orphaned tokens (not used in a long time)
     * This handles tokens from cleared localStorage, reinstalled apps, etc.
     *
     * @param thresholdDays - Delete tokens not used in this many days (default: 30)
     * @returns Object with counts of deleted tokens
     */
    async cleanupOrphanedTokens(thresholdDays: number = 30): Promise<{ orphaned: number }> {
        // Calculate threshold date
        const thresholdDate = new Date();
        thresholdDate.setDate(thresholdDate.getDate() - thresholdDays);

        // Delete tokens that:
        // 1. Are NOT revoked (revoked tokens are cleaned separately)
        // 2. AND either:
        //    a. Have never been used (last_used_at IS NULL) and were created > threshold days ago
        //    b. OR were last used > threshold days ago
        const result = await cleanupOrphanedJellyfinTokens(this.sql, thresholdDate);

        if (result.length > 0) {
            // Invalidate cache for deleted tokens
            for (const token of result) {
                this.tokenCache.delete(token.device_session_id, token.user_id);
            }

            logger.info('Cleaned up orphaned Jellyfin device tokens', {
                count: result.length,
                thresholdDays,
            });
        }

        return { orphaned: result.length };
    }

    /**
     * Cleanup old revoked tokens AND orphaned tokens
     * Called periodically by the sync scheduler
     */
    async cleanup(): Promise<number> {
        // Clean up revoked tokens older than 7 days
        const revokedCount = await cleanupRevokedJellyfinTokens(this.sql);

        // Clean up orphaned tokens (not used in 30 days)
        const orphanedResult = await this.cleanupOrphanedTokens(30);

        const totalDeleted = revokedCount + orphanedResult.orphaned;

        if (totalDeleted > 0) {
            logger.info('Cleaned up Jellyfin device tokens', {
                revoked: revokedCount,
                orphaned: orphanedResult.orphaned,
                total: totalDeleted,
            });
        }

        return totalDeleted;
    }
}

// Singleton instance
let instance: JellyfinTokenService | null = null;

export function getJellyfinTokenService(): JellyfinTokenService {
    if (!instance) {
        instance = new JellyfinTokenService();
    }
    return instance;
}
